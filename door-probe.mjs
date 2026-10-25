/**
 * БАЛАНСИРОВЩИК ПО АДРЕСУ, МИМО DNS, — и сертификат, который он отдаёт.
 *
 * 🔴 ЗАЧЕМ МИМО DNS (25.10.2026). У `app.dentboard.ru` две A-записи — два балансировщика у разных
 * провайдеров. Запрос «по имени» уходит на тот, что выпал резолверу, и при одном лежащем
 * балансировщике браузер просто повторит на втором: снаружи всё зелёное, а запаса уже нет. Это
 * ровно то состояние, которое надо видеть ЗАРАНЕЕ, пока второй держит. Поэтому каждый спрашивается
 * отдельно, по своему адресу, с тем же именем в TLS и в `Host` (`curl --resolve` в одну строку).
 *
 * ⚠️ БЕЗ `curl`: подмена адреса делается параметром `lookup` у `https.request` — тот же запрос,
 * что видит человек (SNI, проверка сертификата, `Host`), только адрес задан нами. Внешней
 * программы и разбора её вывода нет — значит нет и тихого расхождения при смене её формата.
 *
 * ⚠️ СЕРТИФИКАТ ЧИТАЕТСЯ ОТДЕЛЬНЫМ СОЕДИНЕНИЕМ БЕЗ ПРОВЕРКИ. Истёкший сертификат валит обычный
 * запрос (`CERT_HAS_EXPIRED`) — и вместе с ним пропало бы «сколько дней осталось», то есть ровно
 * то число, ради которого строка заведена. Здесь проверка отключена, а её итог
 * (`authorized`/`authorizationError`) возвращается отдельным полем: «не тот сертификат» и
 * «истекает» — разные звонки.
 */
import { request } from "node:https";
import { connect } from "node:tls";
import { describeError } from "./error-detail.mjs";

/** `lookup`, который на любое имя отвечает заданным адресом. */
function pinned(ip) {
  const family = ip.includes(":") ? 6 : 4;
  return (_host, opts, cb) => {
    if (opts && opts.all) cb(null, [{ address: ip, family }]);
    else cb(null, ip, family);
  };
}

/**
 * Одна попытка: GET `https://<host><path>` на адрес `ip`. Форма ответа — как у `fetch`-пробы в
 * `probe.mjs`: `{ status, body }` или исключение; тело читается (до 64 КБ) — у готовности в нём
 * задержки базы и Redis.
 */
export function getVia(ip, host, path, { signal, headers = {}, port = 443, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, servername: host, port, path, method: "GET", lookup: pinned(ip), headers: { host, ...headers }, signal, ca, agent: false },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size <= 65_536) chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Сколько ПОЛНЫХ суток осталось до момента. Отрицательное — уже истёк. */
export function daysLeft(validTo, now = Date.now()) {
  const t = new Date(validTo).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now) / 86_400_000);
}

/**
 * Сертификат, который отдаёт балансировщик по адресу `ip` для имени `host`.
 * Возвращает `{ ok: true, validTo, days, authorized, authorizationError }` или `{ ok: false, error }`.
 */
export function readCert(ip, host, { timeoutMs = 10_000, port = 443, now = Date.now() } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const sock = connect({ host: ip, port, servername: host, rejectUnauthorized: false });
    const timer = setTimeout(() => done({ ok: false, error: `не ответил за ${timeoutMs} мс` }), timeoutMs);
    sock.once("secureConnect", () => {
      const cert = sock.getPeerCertificate();
      if (!cert || !cert.valid_to) return done({ ok: false, error: "сертификата в ответе нет" });
      // `authorized` Node считает и при отключённом отказе — цепочку И имя (`checkServerIdentity`;
      // проверено живым запросом с чужим именем: ERR_TLS_CERT_ALTNAME_INVALID), так что «отдаёт
      // чужой сертификат» отличимо от «отдаёт наш» без своей проверки имени.
      const authorizationError = sock.authorized ? null : String(sock.authorizationError ?? "не проверен");
      done({
        ok: true,
        validTo: new Date(cert.valid_to).toISOString(),
        days: daysLeft(cert.valid_to, now),
        authorized: authorizationError === null,
        authorizationError,
      });
    });
    sock.once("error", (e) => done({ ok: false, error: describeError(e) }));
  });
}
