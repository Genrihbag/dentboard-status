/**
 * ПРЯМОЙ ВОПРОС АВТОРИТЕТНОМУ DNS — без `dig`, своим пакетом по UDP.
 *
 * 🔴 ЗАЧЕМ СПРАШИВАТЬ КАЖДОГО ПРОВАЙДЕРА НАПРЯМУЮ (25.10.2026). У `dentboard.ru` шесть NS двух
 * провайдеров (Selectel: a/b/c/d.ns.selectel.ru; Яндекс: ns1/ns2.yandexcloud.net), и резолвер
 * спрашивает случайный. Если один провайдер отдаёт не те адреса или молчит, часть людей видит одно,
 * часть другое — и НИЧЕГО НЕ ПАДАЕТ: наблюдатель, спрашивающий свой резолвер, получит ответ из кэша
 * или от исправного провайдера и останется зелёным. Увидеть это можно только вопросом в обход
 * резолвера — каждому серверу имён отдельно.
 *
 * ⚠️ БИТ «РЕКУРСИЯ» СНЯТ (`+norec` у `dig`). Авторитетный сервер отвечает из своей зоны и
 * рекурсии не делает; с поднятым битом часть серверов отвечает `REFUSED`, и это читалось бы как
 * «провайдер лежит» при исправной зоне.
 *
 * ⚠️ СВОЙ ПАКЕТ, А НЕ `dig`, И ЭТО РЕШЕНИЕ, А НЕ ЭКОНОМИЯ. `dig` (пакет `dnsutils`) на машине
 * наблюдателя не гарантирован, а ставить пакеты на чужую машину ради одной проверки — лишняя
 * движущаяся часть. `dns.Resolver` из Node не годится: бит рекурсии он не снимает. Запрос A —
 * это 30 байт, разбор ответа — полсотни строк, и оба проверяются образцами без сети.
 */
import { createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { randomInt } from "node:crypto";

/** Один вопрос одному серверу. Авторитетный сервер отвечает за десятки мс; 3 с — уже молчание. */
export const DNS_TIMEOUT_MS = 3_000;
/** Сколько раз переспросить молчащий сервер. UDP теряется, и одна потеря — ещё не отказ. */
export const DNS_ATTEMPTS = 2;

const RCODE = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED" };

/** Пакет запроса A без бита рекурсии. */
export function buildQuery(name, id) {
  const labels = name.replace(/\.$/, "").split(".");
  const qname = Buffer.concat([
    ...labels.map((l) => {
      const b = Buffer.from(l, "ascii");
      return Buffer.concat([Buffer.from([b.length]), b]);
    }),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0000, 2); // QR=0, OPCODE=0, RD=0 — `+norec`
  header.writeUInt16BE(1, 4); // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // QTYPE A
  tail.writeUInt16BE(1, 2); // QCLASS IN
  return Buffer.concat([header, qname, tail]);
}

/** Пропустить имя (с учётом сжатия ссылками). Возвращает смещение за именем. */
function skipName(buf, off) {
  for (let guard = 0; guard < 128; guard += 1) {
    if (off >= buf.length) throw new Error("имя обрывается за концом пакета");
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += 1 + len;
  }
  throw new Error("имя без конца");
}

/**
 * Разобрать ответ. Возвращает `{ rcode, aa, tc, addresses }`.
 *
 * ⚠️ ЧУЖОЙ ID — ОТКАЗ, А НЕ «ОТВЕТ». Пакет с другим id — не ответ на наш вопрос (опоздавший ответ
 * прошлой попытки, чужой мусор), и принять его значило бы сверять адреса не с тем, о чём спросили.
 */
export function parseResponse(buf, id) {
  if (buf.length < 12) throw new Error("пакет короче заголовка");
  if (buf.readUInt16BE(0) !== id) throw new Error("ответ не на наш вопрос (чужой id)");
  const flags = buf.readUInt16BE(2);
  if ((flags & 0x8000) === 0) throw new Error("это запрос, а не ответ");
  const rcode = flags & 0x000f;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let off = 12;
  for (let i = 0; i < qd; i += 1) off = skipName(buf, off) + 4;
  const addresses = [];
  for (let i = 0; i < an; i += 1) {
    off = skipName(buf, off);
    if (off + 10 > buf.length) throw new Error("запись обрывается за концом пакета");
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    if (off + rdlen > buf.length) throw new Error("данные записи за концом пакета");
    if (type === 1 && rdlen === 4) addresses.push(`${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`);
    off += rdlen;
  }
  return {
    rcode: RCODE[rcode] ?? `RCODE${rcode}`,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    addresses,
  };
}

/** Один вопрос одному адресу сервера имён. Бросает при молчании и при негодном пакете. */
export function queryA(serverIp, name, { timeoutMs = DNS_TIMEOUT_MS, port = 53 } = {}) {
  return new Promise((resolve, reject) => {
    const id = randomInt(0, 0x10000);
    const sock = createSocket(serverIp.includes(":") ? "udp6" : "udp4");
    const startedAt = Date.now();
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error(`не ответил за ${timeoutMs} мс`)), timeoutMs);
    sock.on("error", (e) => finish(reject, e));
    sock.on("message", (msg) => {
      try {
        const r = parseResponse(msg, id);
        finish(resolve, { ...r, ms: Date.now() - startedAt });
      } catch (e) {
        // Чужой пакет не завершает ожидание: настоящий ответ может прийти следом.
        if (/чужой id/.test(e.message)) return;
        finish(reject, e);
      }
    });
    sock.send(buildQuery(name, id), port, serverIp, (e) => e && finish(reject, e));
  });
}

/**
 * Спросить ОДИН сервер имён (по имени) и сверить ответ с ожидаемыми адресами.
 *
 * Возвращает `{ server, ok, addresses, error?, ms }`. `ok` — ответ НАШЁЛСЯ и содержит КАЖДЫЙ
 * ожидаемый адрес. Лишний адрес в ответе тоже отказ: резолвер отдаст его людям наравне с нашими,
 * и часть людей уйдёт не туда.
 */
export async function askServer(server, name, expect, { resolveHost = defaultResolve, timeoutMs, attempts = DNS_ATTEMPTS } = {}) {
  // «имя:порт» — только для подменного круга (свой сервер имён на 127.0.0.1); боевой список
  // портов не пишет, и там всегда 53.
  const m = /^(.+):(\d+)$/.exec(server);
  const host = m ? m[1] : server;
  const port = m ? Number(m[2]) : 53;
  let ip;
  try {
    ip = await resolveHost(host);
  } catch (e) {
    return { server, ok: false, addresses: [], error: `адрес сервера не нашёлся: ${e.code ?? e.message}` };
  }
  let lastError = "не спрашивали";
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await queryA(ip, name, { timeoutMs, port });
      // NXDOMAIN от авторитетного сервера — НЕВЕРНЫЙ ответ, а не молчание: резолвер его кэширует и
      // соседа не переспрашивает (ревью 25.10.2026). REFUSED / SERVFAIL — молчание: резолвер
      // переспросит другой сервер.
      if (r.rcode === "NXDOMAIN") return { server, ok: false, wrong: true, addresses: [], error: "ответ NXDOMAIN (имени нет)", ms: r.ms };
      if (r.rcode !== "NOERROR") return { server, ok: false, addresses: [], error: `ответ ${r.rcode}`, ms: r.ms };
      const got = [...new Set(r.addresses)].sort();
      const missing = expect.filter((a) => !got.includes(a));
      const extra = got.filter((a) => !expect.includes(a));
      if (missing.length === 0 && extra.length === 0) return { server, ok: true, addresses: got, ms: r.ms };
      const parts = [];
      if (missing.length) parts.push(`нет ${missing.join(", ")}`);
      if (extra.length) parts.push(`лишний ${extra.join(", ")}`);
      return { server, ok: false, wrong: true, addresses: got, error: `отдаёт ${got.join(", ") || "пусто"} (${parts.join("; ")})`, ms: r.ms };
    } catch (e) {
      lastError = e.message;
    }
  }
  return { server, ok: false, addresses: [], error: lastError };
}

/**
 * Адрес сервера имён — через c-ares (`Resolver`) с коротким таймаутом, а не `lookup`.
 * ⚠️ `lookup` — системный getaddrinfo без таймаута на общем пуле потоков libuv (их 4): при
 * тормозящем резолвере наблюдателя он ждал бы сколько угодно и занимал потоки, нужные `fetch`
 * (ревью 25.10.2026).
 */
const resolver = new Resolver({ timeout: 2_000, tries: 1 });
async function defaultResolve(host) {
  if (isIP(host)) return host;
  const [address] = await resolver.resolve4(host);
  if (!address) throw new Error("нет A-записи");
  return address;
}

/**
 * Провайдер целиком: все его серверы имён — параллельно.
 *
 * ⚠️ ПРАВИЛО: ИСПРАВЕН, ЕСЛИ ОТВЕТИЛ ХОТЯ БЫ ОДИН И НИ ОДИН НЕ СОВРАЛ.
 *   · молчит часть серверов — резолвер переспросит соседний того же провайдера, люди этого не
 *     заметят; но в подробностях это НАЗЫВАЕТСЯ («ответили 3 из 4»), а не пропадает;
 *   · хоть один отдал не те адреса — отказ: резолвер, попавший на него, уведёт людей не туда, и
 *     число исправных соседей этого не отменяет;
 *   · молчат все — отказ.
 */
export async function probeDnsProvider(servers, name, expect, opts = {}) {
  const answers = await Promise.all(servers.map((s) => askServer(s, name, expect, opts)));
  const good = answers.filter((a) => a.ok);
  const lying = answers.filter((a) => a.wrong);
  const ok = good.length > 0 && lying.length === 0;
  const ms = good.length ? Math.min(...good.map((a) => a.ms)) : null;
  return { ok, wrong: lying.length > 0, answered: good.length, total: servers.length, answers, ms };
}
