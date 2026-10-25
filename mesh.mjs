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
      if (/Permission denied/i.test(why)) return resolve({ id: v.id, reach: "auth", ms, error: "ключ не принят" });
      if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(why)) return resolve({ id: v.id, reach: "hostkey", ms, error: "ключ хоста не совпал" });
      if (/Connection refused/i.test(why)) return resolve({ id: v.id, reach: "refused", ms, error: "ssh закрыт" });
      return resolve({ id: v.id, reach: "net", ms, error: err.killed ? `не ответила за ${timeoutMs} мс` : why || "нет связи" });
    });
  });
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
  for (const v of votes) {
    if (!v.fresh) continue;
    if (kind === "balancer") {
      // Балансировщик — глазами СОСЕДНЕЙ двери (поле `peer`). Свой голос двери про её :443 не говорит.
      if (!v.peer || v.peer.addr !== balancerIp) continue;
      if (v.peer.state === "up") up.push(withMs(v.name, v.peer.ms));
      else if (v.peer.state === "down" || v.peer.state === "unreachable") down.push(`${v.name}: ${v.peer.state === "down" ? `код ${v.peer.code}` : "не отвечает"}`);
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
      return { up: [], down: [...down, "вход в России не виден ни одной дверью"] };
    }
  }
  return { up, down };
}
const withMs = (name, ms) => (ms === null ? name : `${name} · ${ms} мс`);

/** Как NL увидел строку: ok | http (ответ кодом) | net (ответа нет). */
export function nlSaw(r) {
  if (!r) return "none";
  if (r.ok) return "ok";
  return r.status ? "http" : "net";
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
    .filter((g) => timedKinds.has(g.kind))
    .some((g) => g.rows.some((row) => ["ok", "http"].includes(nlSaw(raw[row.id]))));
  const doorAnswered = votes.some((v) => ["ok", "auth", "hostkey", "refused", "bad"].includes(v.reach));
  const roadOk = controlsOk || doorAnswered || ourAnswered;

  const out = { ...raw };
  const notes = { ruUp: [], ruDown: [], cutoff: !roadOk };
  for (const g of config.groups) {
    for (const row of g.rows) {
      const r = raw[row.id];
      if (timedKinds.has(g.kind)) {
        const saw = nlSaw(r);
        const ru = ruEvidence(row, g.kind, votes, g.kind === "balancer" ? ipOf(row.id) : null);
        const d = decideRow(saw, ru, roadOk);
        if (d.verdict === "ru-up") {
          out[row.id] = { ...r, viaRU: true, ruText: ru.up.join(", "), nlError: r?.error ?? null };
          notes.ruUp.push(row.name);
        } else if (d.verdict === "ru-down") {
          out[row.id] = { ...r, ruText: ru.down.join(", ") };
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
  const server = config.groups.find((g) => g.kind === "ready")?.rows?.[0];
  const seen = (r) => (!r ? "не проверен" : r.ok ? (typeof r.ms === "number" ? `${r.ms} мс` : "отвечает") : r.status ? `код ${r.status}` : "не отвечает");
  const nlParts = [];
  if (server) nlParts.push(`сервер ${seen(rawBeforeMesh[server.id])}`);
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
