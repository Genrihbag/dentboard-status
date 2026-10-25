/**
 * ВЗАИМНАЯ ПРОВЕРКА С НЕСКОЛЬКИХ ТОЧЕК (25.10.2026): «не работает» — только если цель не видят точки
 * из РАЗНЫХ мест.
 *
 * 🔴 ЗАЧЕМ. Наблюдатель стои́т в NL, всё наблюдаемое — в РФ, и дорога между ними рвётся сама по себе
 * (22:41 МСК: «DNS 2 не отвечает», а с прода в ту же минуту всё отвечало). Одна точка с порванной
 * дорогой поднимала тревогу о сбое, которого у людей не было, — а тревога, регулярно ложная, учит
 * канал не читать тревоги.
 *
 * ТОЧКИ:
 *   · Европа · NL — сам наблюдатель (страницы, балансировщики по адресам, готовность сервера);
 *   · Россия · балансировщик 1 и 2 — ГОЛОСА наблюдателя автомата на дверях (ztl-lab
 *     infra/failover/observer.sh, раз в 10 с): прод по пути двери, соседняя дверь (`peer`), дом.
 *     NL забирает голос по ssh с вынужденной командой `cat vote.json` (учётка dentboard-status на
 *     двери, ставится `arm.sh --observers`). Второго опросчика на дверях нет.
 *
 * ПРАВИЛО (`decideRow`) — только для отказа, в котором NL НЕ ПОЛУЧИЛ ОТВЕТА (сеть):
 *   · ответ кодом (502, 503) — дорога работает, NL видит сам отказ: верим NL, как и раньше;
 *   · Россия видит цель → «из Европы не видно, из России видно»: строка работает, тревоги нет;
 *   · Россия тоже не видит → две точки из разных мест: отказ;
 *   · Россия молчит (голоса недоступны или старые), но дорога в Россию из NL жива (контрольные сайты
 *     в РФ, двери по ssh, любая наша цель ответила) → верим NL, как раньше;
 *   · NL не видит из России НИЧЕГО → NL отрезан: прежнее состояние держится, тревоги нет, в табло —
 *     пометка. Строка «не работает» из точки, у которой нет связи ни с чем, — не наблюдение.
 *
 * ⚠️ СТРАНИЦЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ ПОД ЭТО ПРАВИЛО ТОЖЕ ПОПАДАЮТ — но только когда NL не получил
 * ответа. Красное по коду ответа и по согласию двух мест не задерживается ни на круг.
 *
 * ⚠️ ЧИСТЫЕ ФУНКЦИИ — ОТДЕЛЬНО ОТ ssh И fetch: матрица решений проверяется образцами (`mesh.test.mjs`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { CUTOFF_HOLD_ROUNDS } from "./layout.mjs";

/** Голос старше — не точка наблюдения. Тот же порог, что у дома (failover_logic VOTE_MAX_AGE_S). */
export const VOTE_MAX_AGE_S = 45;

/**
 * Забрать голос одной двери по ssh. Возвращает `{ id, reach, vote?, ms, error? }`:
 * `reach` — ok | auth | hostkey | refused | net | bad | off.
 *
 * ⚠️ `auth` / `hostkey` / `refused` — дверь ОТВЕТИЛА (sshd или ядро), то есть дорога до неё есть; это
 * доказательство связи NL с Россией, хотя голоса и нет. `net` — не ответило ничего. `off` — ключа на
 * машине нет (доступ не настроен): отличимо и от отказа, и от «нет связи».
 */
export function fetchVote(v, { key, knownHosts, user = "dentboard-status", ssh = ["ssh"], timeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    if (!key || !existsSync(key)) return resolve({ id: v.id, reach: "off", ms: null, error: "ключ доступа не настроен" });
    const [cmd, ...pre] = ssh;
    const args = [
      ...pre,
      "-i", key,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "LogLevel=ERROR",
      `${user}@${v.host}`,
    ];
    const t0 = Date.now();
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      const why = String(stderr || err?.message || "").trim().split("\n").pop() ?? "";
      if (!err) {
        try {
          return resolve({ id: v.id, reach: "ok", vote: JSON.parse(stdout), ms });
        } catch {
          return resolve({ id: v.id, reach: "bad", ms, error: "голос не разобрался" });
        }
      }
      if (err.killed) return resolve({ id: v.id, reach: "net", ms, error: `не ответила за ${timeoutMs} мс` });
      // Код выхода ssh — 255 только у ошибок САМОГО ssh (связь, ключ). Любой другой ненулевой код —
      // это команда на двери (`cat`) отработала и упала: дверь ответила, а голоса нет (ревью 25.10.2026).
      // Переполнение буфера — тоже ответ, а не «нет связи».
      if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ id: v.id, reach: "bad", ms, error: "голос слишком велик" });
      if (typeof err.code === "number" && err.code !== 255) return resolve({ id: v.id, reach: "bad", ms, error: why || `команда на двери: код ${err.code}` });
      if (/Permission denied \(/i.test(why)) return resolve({ id: v.id, reach: "auth", ms, error: "ключ не принят" });
      if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(why)) return resolve({ id: v.id, reach: "hostkey", ms, error: "ключ хоста не совпал" });
      if (/Connection refused/i.test(why)) return resolve({ id: v.id, reach: "refused", ms, error: "ssh закрыт" });
      return resolve({ id: v.id, reach: "net", ms, error: why || "нет связи" });
    });
  });
}

/**
 * ОТСТУП ПОСЛЕ ОТКАЗА КЛЮЧА (ревью 25.10.2026). Ключ NL появляется раньше, чем учётка на дверях
 * (`arm.sh --observers`), и после смены ключа — тоже: тогда каждый круг давал бы двери «Invalid user»
 * / «Permission denied», и fail2ban с jail sshd забанил бы адрес NL примерно за пять минут — а вместе
 * с ним и установку на двери (она отказывает, если NL в бане). Поэтому после `auth`/`hostkey` дверь
 * не спрашивается AUTH_BACKOFF_S: два входа в час fail2ban не накопит.
 */
export const AUTH_BACKOFF_S = Number(process.env.STATUS_AUTH_BACKOFF_MIN ?? 30) * 60;

/** Спрашивать ли дверь сейчас; `prev` — запись из data/mesh.json `{ reach, at, error }`. */
export function shouldAsk(prev, nowSec, backoffS = AUTH_BACKOFF_S) {
  if (!prev || !["auth", "hostkey"].includes(prev.reach)) return true;
  return !(nowSec - prev.at < backoffS && nowSec >= prev.at);
}

/** Запомнить отказ ключа (или забыть, если его нет) — следующее состояние data/mesh.json. */
export function nextAskState(state, results, nowSec) {
  const out = { ...state };
  for (const f of results) {
    if (f.skipped) continue;
    if (["auth", "hostkey"].includes(f.reach)) out[f.id] = { reach: f.reach, at: nowSec, error: f.error };
    else delete out[f.id];
  }
  return out;
}

/**
 * NL ОТРЕЗАН ОТ РОССИИ — одно сообщение на начало и одно на конец (ревью 25.10.2026), а не тишина:
 * удержание прежнего ограничено (`CUTOFF_HOLD_ROUNDS`), и владелец обязан знать, что монитор слеп.
 * Объявляется со ВТОРОГО круга подряд — одиночная минута без связи не повод писать в канал.
 * Возвращает `{ state, say }`: `state` — в историю (`observerCut`), `say` — текст или null.
 */
export function cutoffNotice(prev, cutoff, nowIso, stamp) {
  if (!cutoff) {
    const say = prev?.announced ? `📡 <b>Монитор снова видит Россию</b>\n${stamp} МСК` : null;
    return { state: null, say };
  }
  const since = prev?.since ?? nowIso;
  const rounds = Number(prev?.rounds ?? 0) + 1;
  const announce = rounds >= 2 && !prev?.announced;
  const at = new Date(since).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
  return {
    state: { since, rounds, announced: Boolean(prev?.announced) || announce },
    say: announce
      ? `📡 <b>Монитор не видит Россию</b> с ${at} МСК: из NL нет связи ни с балансировщиками, ни с сайтами в РФ. ` +
        `Это дорога, а не авария; прежнее состояние держится ${CUTOFF_HOLD_ROUNDS} мин, дальше — «не проверен».`
      : null,
  };
}

/** Дорога в Россию из NL: ответил ли хоть один контрольный сайт в РФ (любым кодом). */
export async function controlsReachable(urls, { timeoutMs = 4_000 } = {}) {
  const tries = urls.map((u) =>
    fetch(u, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
      .then(async (r) => {
        await r.body?.cancel().catch(() => {});
        return true;
      })
      .catch(() => false),
  );
  return (await Promise.all(tries)).some(Boolean);
}

/** Голос как точка наблюдения: свежий ли и что видит. */
export function voteView(v, fetched, nowSec) {
  const vote = fetched?.vote;
  const at = typeof vote?.at === "number" ? vote.at : null;
  const age = at === null ? null : Math.round(nowSec - at);
  const fresh = fetched?.reach === "ok" && age !== null && Math.abs(age) <= VOTE_MAX_AGE_S;
  return {
    id: v.id,
    name: v.name,
    region: v.region,
    balancer: v.balancer ?? null,
    reach: fetched?.reach ?? "off",
    error: fetched?.error ?? null,
    age,
    fresh,
    prod: fresh ? { state: vote.prod?.state ?? null, code: String(vote.prod?.code ?? ""), ms: numOrNull(vote.prod?.ms) } : null,
    peer: fresh && vote.peer && vote.peer.addr ? { addr: vote.peer.addr, state: vote.peer.state, code: String(vote.peer.code ?? ""), ms: numOrNull(vote.peer.ms) } : null,
    home: fresh && vote.home ? { state: vote.home.state } : null,
  };
}
const numOrNull = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Что видит Россия про строку: `{ up: [...], down: [...] }` — имена точек. */
export function ruEvidence(row, kind, votes, balancerIp) {
  const up = [];
  const down = [];
  const codes = [];
  for (const v of votes) {
    if (!v.fresh) continue;
    if (kind === "balancer") {
      // Балансировщик — глазами СОСЕДНЕЙ двери (поле `peer`). Свой голос двери про её :443 не говорит.
      if (!v.peer || v.peer.addr !== balancerIp) continue;
      if (v.peer.state === "up") up.push(withMs(v.name, v.peer.ms));
      // У двери, чья СВОЯ сеть лежит (прод `unknown` — контроль не ответил), «сосед не отвечает» —
      // про её сеть, а не про соседа (ревью 25.10.2026).
      else if (v.peer.state === "unreachable" && v.prod?.state !== "unknown") down.push(`${v.name}: не отвечает`);
      else if (v.peer.state === "down") {
        down.push(`${v.name}: код ${v.peer.code}`);
        // Сосед ОТВЕТИЛ кодом ошибки — людям на этом входе показывается ошибка, на запасной они не
        // уходят: это `misleads`, и строке нужен код, а не «не отвечает».
        if (/^\d+$/.test(v.peer.code) && v.peer.code !== "000") codes.push(Number(v.peer.code));
      }
    } else {
      // Страницы и сервер — прод глазами двери. «Видно» — последняя проба 200; «не видно» — голос
      // «down» (три неудачи подряд у самой двери), а одиночная неудача ещё ни то, ни другое.
      if (v.prod?.code === "200") up.push(withMs(v.name, v.prod.ms));
      else if (v.prod?.state === "down") down.push(`${v.name}: прод не отвечает`);
    }
  }
  /**
   * ⚠️ СТРАНИЦЫ ЛЮДИ ПОЛУЧАЮТ ЧЕРЕЗ :443 ДВЕРЕЙ, а проба прода двери идёт мимо него — прямо на прод
   * (:8443). Если :443 лёг у ОБЕИХ дверей, двери по-прежнему видят прод живым, а людям не открывается
   * ничего. Поэтому «Россия видит страницу» — это прод 200 И хотя бы одна дверь, чей :443 из России
   * виден соседом (`peer` up). Голоса без поля `peer` (наблюдатель до 25.10.2026) это не проверяют —
   * тогда достаточно прода, и это граница, названная честно.
   */
  if (kind !== "balancer" && up.length > 0) {
    const fresh = votes.filter((v) => v.fresh);
    const peers = fresh.filter((v) => v.peer);
    if (peers.length > 0 && !peers.some((v) => v.peer.state === "up")) {
      return { up: [], down: [...down, "вход в России не виден ни одной дверью"], codes };
    }
  }
  return { up, down, codes };
}
const withMs = (name, ms) => (ms === null ? name : `${name} · ${ms} мс`);

/**
 * Сетевые отказы, при которых до цели НЕ ДОШЛИ — только они бывают дорогой NL → РФ.
 *
 * 🔴 ВСЁ ПРОЧЕЕ — ОТВЕТ (ревью 25.10.2026). `ENOTFOUND` (имени нет — делегирование потеряно),
 * `CERT_HAS_EXPIRED`, `ERR_TLS_CERT_ALTNAME_INVALID` и родня — это то, что увидит и человек; Россия
 * же ходит мимо DNS (`--resolve`) и только на `app.`, поэтому на такой отказ ответила бы «видно» и
 * спрятала бы настоящую аварию. Неизвестный код — тоже ответ: прятать то, чего не понимаем, нельзя.
 */
const NET_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN",
  "ENETDOWN", "EPIPE", "EAI_AGAIN", "TimeoutError", "AbortError", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

/** Как NL увидел строку: ok | http (ответ — кодом или отказом DNS/TLS) | net (до цели не дошли). */
export function nlSaw(r) {
  if (!r) return "none";
  if (r.ok) return "ok";
  // Хоть одна попытка получила код — цель отвечает ошибкой (`probe.mjs`, «502, 502, тайм-аут»).
  if (r.status || r.answered) return "http";
  // Не опрошена (предел круга вышел) или причины нет — дорогу исключить нельзя.
  if (!r.code) return "net";
  return NET_CODES.has(r.code) ? "net" : "http";
}

/**
 * РЕШЕНИЕ ПО ОДНОЙ СТРОКЕ — см. шапку. Возвращает `{ verdict, ru }`:
 * keep (как увидел NL) | ru-up (из Европы не видно, из России видно) | ru-down (не видят обе) | cutoff.
 */
export function decideRow(saw, ru, roadOk) {
  if (saw !== "net") return { verdict: "keep", ru };
  if (ru.up.length > 0) return { verdict: "ru-up", ru };
  if (ru.down.length > 0) return { verdict: "ru-down", ru };
  return { verdict: roadOk ? "keep" : "cutoff", ru };
}

/**
 * Применить решения к сырым пробам перед раскладкой. Возвращает НОВЫЙ `raw` и сводку `mesh` для
 * табло и сообщений. Чистая функция.
 *
 * `fetched` — результаты `fetchVote` по id точки; `controlsOk` — `controlsReachable`.
 */
export function applyMesh(config, raw, { fetched = {}, controlsOk = false, nowSec = Date.now() / 1000 } = {}) {
  const m = config.mesh;
  if (!m) return { raw, mesh: null };
  const votes = (m.vantages ?? []).map((v) => voteView(v, fetched[v.id], nowSec));
  const balancers = config.groups.find((g) => g.kind === "balancer")?.rows ?? [];
  const ipOf = (id) => balancers.find((b) => b.id === id)?.ip ?? null;

  // Дорога в Россию из NL — любое свидетельство: контрольный сайт, дверь ответила по ssh (даже
  // отказом ключа), любая наша цель ответила хоть чем-то.
  const timedKinds = new Set(["http", "ready", "balancer"]);
  const ourAnswered = config.groups
    .some((g) => g.rows.some((row) => timedKinds.has(row.kind ?? g.kind) && ["ok", "http"].includes(nlSaw(raw[row.id]))));
  const doorAnswered = votes.some((v) => ["ok", "auth", "hostkey", "refused", "bad"].includes(v.reach));
  const roadOk = controlsOk || doorAnswered || ourAnswered;

  const out = { ...raw };
  const notes = { ruUp: [], ruDown: [], cutoff: !roadOk };
  for (const g of config.groups) {
    for (const row of g.rows) {
      const r = raw[row.id];
      const kind = row.kind ?? g.kind;
      if (timedKinds.has(kind)) {
        const saw = nlSaw(r);
        const ru = ruEvidence(row, kind, votes, kind === "balancer" ? ipOf(row.id) : null);
        const d = decideRow(saw, ru, roadOk);
        if (d.verdict === "ru-up") {
          out[row.id] = { ...r, viaRU: true, ruText: ru.up.join(", "), nlError: r?.error ?? null };
          notes.ruUp.push(row.name);
        } else if (d.verdict === "ru-down") {
          // Балансировщик, который Россия видит ОТВЕЧАЮЩИМ ошибкой, — с её кодом: строка «не работает»
          // и `misleads` (людям на этом входе показывается ошибка), а не «не отвечает».
          const status = g.kind === "balancer" && ru.codes?.length ? ru.codes[0] : r?.status ?? 0;
          out[row.id] = { ...r, status, ruText: ru.down.join(", ") };
          notes.ruDown.push(row.name);
        } else if (d.verdict === "cutoff") {
          out[row.id] = { cutoff: true, nlError: r?.error ?? null };
        }
      } else if (g.kind === "dns" && !roadOk && r && !r.ok && !r.wrong) {
        // NL отрезан от России — серверы имён в РФ молчат по той же причине.
        out[row.id] = { cutoff: true };
      }
    }
  }
  return { raw: out, mesh: { votes, roadOk, controlsOk, notes } };
}

/**
 * МАТРИЦА «КТО КОГО ВИДИТ» — строки для табло и сообщений (канал частный: с мс и причинами).
 *   Европа · NL: сервер 238 мс · балансировщик 1 153 мс · балансировщик 2 не отвечает
 *   Россия · балансировщик 1: прод 45 мс · балансировщик 2 12 мс · дом готов
 *   Россия · балансировщик 2: голос недоступен (нет связи)
 */
export function matrixLines(config, rawBeforeMesh, mesh) {
  if (!mesh) return [];
  const self = config.mesh?.self ?? { name: "NL", region: "Европа" };
  const balancers = config.groups.find((g) => g.kind === "balancer")?.rows ?? [];
  // Сервер — его строки живости и готовности («API», «База данных и кэш»), по виду строки.
  const serverRows = config.groups.flatMap((g) => g.rows.map((row) => ({ row, kind: row.kind ?? g.kind }))).filter((x) => x.kind === "ready" || (x.kind === "http" && x.row.id === "api"));
  const seen = (r) => (!r ? "не проверен" : r.ok ? (typeof r.ms === "number" ? `${r.ms} мс` : "отвечает") : r.status ? `код ${r.status}` : "не отвечает");
  const nlParts = [];
  for (const { row } of serverRows) nlParts.push(`${row.id === "api" ? "API" : "готовность"} ${seen(rawBeforeMesh[row.id])}`);
  for (const b of balancers) nlParts.push(`${b.name.toLowerCase()} ${seen(rawBeforeMesh[b.id])}`);
  const lines = [`${self.region} · ${self.name}: ${nlParts.join(" · ")}`];
  const nameOfIp = (ip) => balancers.find((b) => b.ip === ip)?.name.toLowerCase() ?? ip;
  const HOME = { ready: "готов", standby: "в резерве", unreachable: "не отвечает" };
  for (const v of mesh.votes) {
    if (!v.fresh) {
      const why =
        v.reach === "off" ? "доступ не настроен" : v.reach === "ok" ? `голос устарел (${v.age} с)` : `голос недоступен (${v.error ?? v.reach})`;
      lines.push(`${v.region} · ${v.name}: ${why}`);
      continue;
    }
    const parts = [];
    parts.push(`прод ${v.prod.code === "200" ? (v.prod.ms === null ? "отвечает" : `${v.prod.ms} мс`) : v.prod.code === "000" ? "не отвечает" : `код ${v.prod.code}`}`);
    if (v.peer) parts.push(`${nameOfIp(v.peer.addr)} ${v.peer.state === "up" ? (v.peer.ms === null ? "отвечает" : `${v.peer.ms} мс`) : v.peer.state === "unreachable" ? "не отвечает" : `код ${v.peer.code}`}`);
    if (v.home && HOME[v.home.state]) parts.push(`дом ${HOME[v.home.state]}`);
    lines.push(`${v.region} · ${v.name}: ${parts.join(" · ")}`);
  }
  if (mesh.notes.ruUp.length) lines.push(`⚠️ Из Европы не видно, из России видно: ${mesh.notes.ruUp.join(", ")}`);
  if (mesh.notes.cutoff) lines.push("⚠️ Из Европы нет связи с Россией — показано прежнее состояние");
  return lines;
}
