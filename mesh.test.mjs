#!/usr/bin/env node
/**
 * ВЗАИМНАЯ ПРОВЕРКА С НЕСКОЛЬКИХ ТОЧЕК — матрица решений образцами и ssh подменной программой.
 *
 * ⚠️ У КАЖДОГО «ТРЕВОГА» — ПАРНЫЙ «ЗДЕСЬ ТРЕВОГИ БЫТЬ НЕ ДОЛЖНО» (и наоборот): правило «молчать
 * всегда» прошло бы одни отрицательные случаи, «кричать всегда» — одни положительные.
 *
 * Запуск: `node --test mesh.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRow, ruEvidence, voteView, applyMesh, matrixLines, fetchVote, nlSaw, shouldAsk, nextAskState, cutoffNotice } from "./mesh.mjs";
import { CUTOFF_HOLD_ROUNDS } from "./layout.mjs";
import { evaluate, transitions, previousStates, previousRows, publicView, alertTexts, LAYOUT } from "./layout.mjs";
import { boardText } from "./board.mjs";

const CONFIG = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8"));
const NOW = 1_800_000_000;
const NOW_ISO = new Date(NOW * 1000).toISOString();

const ok = (ms = 200) => ({ ok: true, status: 200, ms });
const net = (error = "connect ETIMEDOUT") => ({ ok: false, status: 0, ms: 15000, error });
const code = (status) => ({ ok: false, status, ms: 30 });
const ready = () => ({
  ok: true,
  status: 200,
  ms: 240,
  body: JSON.stringify({ status: "ok", checks: { postgres: { up: true, latency_ms: 1 }, redis: { up: true, latency_ms: 0 } } }),
});
const dnsOk = (t) => ({ ok: true, wrong: false, answered: t, total: t, answers: [], ms: 20 });
const dnsSilent = (t) => ({ ok: false, wrong: false, answered: 0, total: t, answers: [{ server: "x", ok: false, error: "не ответил за 3000 мс" }] });
const certOk = { perDoor: [
  { door: "lb1", ok: true, days: 89, validTo: "2027-01-23T10:19:52.000Z", authorized: true, authorizationError: null },
  { door: "lb2", ok: true, days: 89, validTo: "2027-01-23T10:19:52.000Z", authorized: true, authorizationError: null },
] };
const healthy = () => ({ app: ok(), portal: ok(), site: ok(), lb1: ok(120), lb2: ok(130), dns1: dnsOk(4), dns2: dnsOk(2), server: ready(), cert: certOk });
/** NL не получил ответа ни от чего в РФ. */
const isolated = () => ({
  app: net(), portal: net(), site: net(), lb1: net(), lb2: net(), dns1: dnsSilent(4), dns2: dnsSilent(2), server: net(),
  cert: { perDoor: [{ door: "lb1", ok: false, error: "x" }, { door: "lb2", ok: false, error: "y" }] },
});

/** Голос двери; `at` — свежий по умолчанию. */
const vote = (observer, { prod = "200", prodState = "up", peer = "up", peerAddr, at = NOW - 5, home } = {}) => ({
  reach: "ok",
  vote: {
    v: 1,
    observer,
    at,
    prod: { state: prodState, code: prod, ms: prod === "200" ? 45 : null },
    peer: { addr: peerAddr ?? (observer === "door-1" ? "153.51.113.60" : "136.234.13.100"), state: peer, code: peer === "up" ? "200" : peer === "unreachable" ? "000" : "502", ms: peer === "up" ? 12 : null },
    home: { state: home ?? (observer === "door-1" ? "standby" : "n/a") },
  },
});
const both = (o = {}) => ({ "door-1": vote("door-1", o["door-1"] ?? {}), "door-2": vote("door-2", o["door-2"] ?? {}) });
const unreachable = { reach: "net", error: "не ответила за 8000 мс" };

/** Один круг целиком: сеть NL → решение точек → раскладка → события (как в check.mjs). */
function round(patch, fetched, { controlsOk = true, prevPub = null } = {}) {
  const raw = { ...healthy(), ...patch };
  const meshed = applyMesh(CONFIG, raw, { fetched, controlsOk, nowSec: NOW });
  const states = previousStates(prevPub, CONFIG);
  const v = evaluate(CONFIG, meshed.raw, { slowMs: 1500, prevRows: previousRows(prevPub, { now: NOW * 1000 }) });
  const moved = transitions(v, states, NOW_ISO);
  const matrix = matrixLines(CONFIG, raw, meshed.mesh);
  return { v, moved, texts: alertTexts(moved, v, "25.10, 23:00", "x", matrix), matrix, pub: { layout: LAYOUT, groups: publicView(v, undefined, states), updatedAt: NOW_ISO }, mesh: meshed.mesh };
}
/** Два круга: здоровый, затем данный — события второго. */
function after(patch, fetched, opts = {}) {
  const first = round({}, both(), opts);
  return round(patch, fetched, { ...opts, prevPub: first.pub });
}
const row = (v, id) => v.groups.flatMap((g) => g.rows).find((r) => r.id === id);

/* ── чистое решение ──────────────────────────────────────────────────────────────────────── */

test("решение: NL видит — как увидел NL (из России не спрашиваем)", () => {
  assert.equal(decideRow("ok", { up: [], down: ["x"] }, true).verdict, "keep");
});
test("решение: NL получил ОТВЕТ кодом — верим NL, Россия не спасает", () => {
  assert.equal(decideRow("http", { up: ["balancer"], down: [] }, true).verdict, "keep");
});
test("решение: NL без ответа, Россия видит — «из Европы не видно, из России видно»", () => {
  assert.equal(decideRow("net", { up: ["b1"], down: [] }, true).verdict, "ru-up");
});
test("решение: NL без ответа, Россия не видит — отказ двумя местами", () => {
  assert.equal(decideRow("net", { up: [], down: ["b1"] }, true).verdict, "ru-down");
});
test("решение: NL без ответа, Россия молчит, дорога жива — верим NL", () => {
  assert.equal(decideRow("net", { up: [], down: [] }, true).verdict, "keep");
});
test("решение: NL без ответа, Россия молчит, дороги нет — NL отрезан", () => {
  assert.equal(decideRow("net", { up: [], down: [] }, false).verdict, "cutoff");
});
test("как NL увидел: ответ кодом ≠ нет ответа", () => {
  assert.equal(nlSaw(code(502)), "http");
  assert.equal(nlSaw(net()), "net");
  assert.equal(nlSaw(ok()), "ok");
});

/* ── МАТРИЦА: все видят / только NL не видит / никто не видит / точка недоступна сама ───────── */

test("ВСЕ ВИДЯТ — всё зелёное, тревоги нет", () => {
  const r = after({}, both());
  assert.equal(r.v.overall, "up");
  assert.equal(r.texts.length, 0);
});

test("ТОЛЬКО NL НЕ ВИДИТ (порвана дорога NL→РФ): страницы, сервер, балансировщики — тревоги НЕТ", () => {
  const r = after({ app: net(), portal: net(), site: net(), server: net(), lb1: net(), lb2: net() }, both());
  assert.equal(r.texts.length, 0, `сообщений быть не должно: ${r.texts.join(" | ")}`);
  assert.equal(r.v.overall, "up");
  for (const id of ["app", "portal", "site", "server", "lb1", "lb2"]) assert.equal(row(r.v, id).state, "up", id);
  assert.match(r.matrix.join("\n"), /Из Европы не видно, из России видно: Кабинет лаборатории/);
  assert.match(boardText(r.v, "t", "x", r.matrix), /Россия · балансировщик 1: прод 45 мс · балансировщик 2 12 мс · дом в резерве/);
});

test("ЗДЕСЬ ТРЕВОГА ОБЯЗАНА БЫТЬ: никто не видит (NL без ответа, обе двери — прод down) — «Сбой» сразу", () => {
  const r = after({ app: net(), portal: net(), site: net(), server: net() }, both({ "door-1": { prod: "000", prodState: "down" }, "door-2": { prod: "000", prodState: "down" } }));
  assert.equal(r.v.overall, "down");
  assert.match(r.texts[0], /^🔴 <b>Сбой: Кабинет лаборатории, Кабинет заказчика, Сайт, Сервер и база<\/b>/);
  assert.match(r.texts[0], /Россия: балансировщик 1: прод не отвечает/);
  assert.match(r.texts[0], /<i>Европа · NL: сервер не отвечает/);
});

test("ЗДЕСЬ ТРЕВОГА ОБЯЗАНА БЫТЬ: NL получил 502 от страницы — Россия с живым продом не спасает", () => {
  const r = after({ portal: code(502) }, both());
  assert.match(r.texts[0], /^🔴 <b>Сбой: Кабинет заказчика<\/b>/);
});

test("ТОЧКА НЕДОСТУПНА САМА (голос двери-2 не забрать), NL видит всё — ничего не меняется, в табло пометка", () => {
  const r = after({}, { "door-1": vote("door-1"), "door-2": unreachable });
  assert.equal(r.texts.length, 0);
  assert.equal(r.v.overall, "up");
  assert.match(r.matrix.join("\n"), /Россия · балансировщик 2: голос недоступен \(не ответила за 8000 мс\)/);
});

test("балансировщик 2 из Европы не виден, сосед из России видит — тишина; сосед тоже не видит — «Внимание» вторым кругом", () => {
  const quiet = after({ lb2: net() }, both());
  assert.equal(quiet.texts.length, 0);
  assert.equal(row(quiet.v, "lb2").viaRU, true);
  const seen1 = round({ lb2: net() }, both({ "door-1": { peer: "unreachable" } }), { prevPub: round({}, both()).pub });
  assert.equal(seen1.texts.length, 0, "первый круг — удержание (два круга подряд)");
  const seen2 = round({ lb2: net() }, both({ "door-1": { peer: "unreachable" } }), { prevPub: seen1.pub });
  assert.match(seen2.texts[0], /Внимание: Балансировщик 2/);
});

test("ЗДЕСЬ «ИЗ РОССИИ ВИДНО» НЕ ДОЛЖНО: прод у дверей жив, но :443 обеих дверей из России не виден", () => {
  // Двери видят прод мимо своего :443 — а люди ходят через него.
  const r = after({ app: net(), portal: net(), site: net() }, both({ "door-1": { peer: "unreachable" }, "door-2": { peer: "unreachable" } }));
  assert.equal(r.v.overall, "down");
  assert.equal(row(r.v, "app").viaRU, undefined);
});

test("голос старше 45 с — не точка наблюдения: NL без ответа при живой дороге = отказ, как раньше", () => {
  const stale = both({ "door-1": { at: NOW - 600 }, "door-2": { at: NOW - 600 } });
  const r = after({ portal: net() }, stale);
  assert.match(r.texts[0], /Сбой: Кабинет заказчика/);
  assert.match(r.matrix.join("\n"), /голос устарел \(600 с\)/);
});

test("ЗДЕСЬ ТРЕВОГИ БЫТЬ НЕ ДОЛЖНО: NL отрезан от России целиком — показано прежнее, табло помечено", () => {
  const off = { "door-1": unreachable, "door-2": unreachable };
  const r = after(isolated(), off, { controlsOk: false });
  assert.equal(r.texts.length, 0, `сообщений быть не должно: ${r.texts.join(" | ")}`);
  assert.equal(r.v.overall, "up");
  assert.equal(row(r.v, "app").state, "up");
  assert.equal(row(r.v, "app").cutoff, true);
  assert.match(r.matrix.join("\n"), /Из Европы нет связи с Россией — показано прежнее состояние/);
});

test("ЗДЕСЬ «ОТРЕЗАН» НЕ ДОЛЖНО: контрольные сайты в РФ отвечают — NL говорит правду о цели", () => {
  const off = { "door-1": unreachable, "door-2": unreachable };
  const r = after({ portal: net() }, off, { controlsOk: true });
  assert.match(r.texts[0], /Сбой: Кабинет заказчика/);
});

test("ЗДЕСЬ «ОТРЕЗАН» НЕ ДОЛЖНО: дверь ответила по ssh отказом ключа — дорога до России есть", () => {
  const r = after({ portal: net() }, { "door-1": { reach: "auth", error: "ключ не принят" }, "door-2": unreachable }, { controlsOk: false });
  assert.match(r.texts[0], /Сбой: Кабинет заказчика/);
});

test("доступ не настроен (ключа нет) — решения как раньше, в табло так и сказано", () => {
  const off = { "door-1": { reach: "off", error: "ключ доступа не настроен" }, "door-2": { reach: "off", error: "ключ доступа не настроен" } };
  const r = after({ portal: net() }, off);
  assert.match(r.texts[0], /Сбой: Кабинет заказчика/);
  assert.match(r.matrix.join("\n"), /Россия · балансировщик 1: доступ не настроен/);
});

test("страница — только «работает / не работает»: «из России видно» на ней просто «работает»", () => {
  const r = after({ app: net() }, both());
  const pubApp = r.pub.groups.flatMap((g) => g.rows).find((x) => x.id === "app");
  assert.equal(pubApp.state, "up");
  assert.equal(pubApp.word, "работает");
  assert.doesNotMatch(JSON.stringify(r.pub), /Европ|Росси|136\.234|153\.51/);
});

/* ── ssh: подменная программа вместо ssh ─────────────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), "mesh-ssh-"));
const fake = join(dir, "fake-ssh.mjs");
writeFileSync(
  fake,
  `const host = process.argv.at(-1);
if (host.endsWith("@good")) { process.stdout.write(JSON.stringify({ v: 1, observer: "door-1", at: 1 })); process.exit(0); }
if (host.endsWith("@auth")) { process.stderr.write("dentboard-status@x: Permission denied (publickey).\\n"); process.exit(255); }
if (host.endsWith("@hostkey")) { process.stderr.write("Host key verification failed.\\n"); process.exit(255); }
if (host.endsWith("@refused")) { process.stderr.write("ssh: connect to host x port 22: Connection refused\\n"); process.exit(255); }
if (host.endsWith("@hang")) { setTimeout(() => {}, 60000); }
if (host.endsWith("@catfail")) { process.stderr.write("cat: /var/lib/dentboard-observer/vote.json: No such file or directory\\n"); process.exit(1); }
if (host.endsWith("@garbage")) { process.stdout.write("не json"); process.exit(0); }
process.stderr.write("ssh: connect to host x port 22: Connection timed out\\n"); process.exit(255);
`,
);
const key = join(dir, "key");
writeFileSync(key, "x");
const ssh = [process.execPath, fake];
const get = (host, extra = {}) => fetchVote({ id: "d", host }, { key, knownHosts: join(dir, "kh"), ssh, ...extra });

test("ssh: голос получен и разобран", async () => {
  const f = await get("good");
  assert.equal(f.reach, "ok");
  assert.equal(f.vote.observer, "door-1");
});
test("ssh: отказ ключа, ключ хоста, закрытый порт — «дверь ответила», а не «нет связи»", async () => {
  assert.equal((await get("auth")).reach, "auth");
  assert.equal((await get("hostkey")).reach, "hostkey");
  assert.equal((await get("refused")).reach, "refused");
});
test("ssh: молчание и зависание — «нет связи», зависший обрывается по таймауту", async () => {
  assert.equal((await get("silent")).reach, "net");
  const t0 = Date.now();
  const h = await get("hang", { timeoutMs: 500 });
  assert.equal(h.reach, "net");
  assert.ok(Date.now() - t0 < 5000);
});
test("ssh: мусор вместо голоса — «bad», а не голос", async () => {
  assert.equal((await get("garbage")).reach, "bad");
});
test("ssh: ключа на машине нет — «off» (доступ не настроен), ssh не зовётся", async () => {
  const f = await fetchVote({ id: "d", host: "good" }, { key: join(dir, "нет"), knownHosts: "kh", ssh });
  assert.equal(f.reach, "off");
});
test("голос: свежесть по `at` — старый голос не точка наблюдения", () => {
  assert.equal(voteView({ id: "d" }, vote("door-1"), NOW).fresh, true);
  assert.equal(voteView({ id: "d" }, vote("door-1", { at: NOW - 46 }), NOW).fresh, false);
  assert.equal(voteView({ id: "d" }, { reach: "net" }, NOW).fresh, false);
});
test("Россия про балансировщик — только СОСЕД (свой голос двери про её :443 не говорит)", () => {
  const votes = [voteView({ id: "door-1", name: "б1" }, vote("door-1"), NOW), voteView({ id: "door-2", name: "б2" }, vote("door-2", { peer: "unreachable" }), NOW)];
  const lb2 = ruEvidence({ id: "lb2" }, "balancer", votes, "153.51.113.60");
  assert.deepEqual(lb2.up, ["б1 · 12 мс"]);
  const lb1 = ruEvidence({ id: "lb1" }, "balancer", votes, "136.234.13.100");
  assert.equal(lb1.up.length, 0);
  assert.equal(lb1.down.length, 1);
});

test.after?.(() => rmSync(dir, { recursive: true, force: true }));

/* ── правки по ревью mesh ────────────────────────────────────────────────────────────────── */

const fail = (code, error = code) => ({ ok: false, status: 0, ms: 50, error, code });

test("ЗДЕСЬ ТИШИНЫ БЫТЬ НЕ ДОЛЖНО: имя не находится (ENOTFOUND) — это ответ, Россия (мимо DNS) не спасает", () => {
  const r = after({ app: fail("ENOTFOUND"), portal: fail("ENOTFOUND"), site: fail("ENOTFOUND") }, both());
  assert.equal(r.v.overall, "down");
  assert.match(r.texts[0], /^🔴 <b>Сбой: Кабинет лаборатории, Кабинет заказчика, Сайт<\/b>/);
});

test("ЗДЕСЬ ТИШИНЫ БЫТЬ НЕ ДОЛЖНО: истёк сертификат у портала — ответ TLS, а не дорога", () => {
  const r = after({ portal: fail("CERT_HAS_EXPIRED") }, both());
  assert.match(r.texts[0], /Сбой: Кабинет заказчика/);
});

test("а тайм-аут соединения (ETIMEDOUT) — дорога: Россия видит — тишина", () => {
  const r = after({ portal: fail("ETIMEDOUT") }, both());
  assert.equal(r.texts.length, 0);
});

test("попытки «502, 502, тайм-аут» — цель отвечает ошибкой, Россия не перекрывает", () => {
  assert.equal(nlSaw({ ok: false, status: 0, answered: true, code: "TimeoutError" }), "http");
  const r = after({ portal: { ok: false, status: 0, ms: 15000, answered: true, code: "TimeoutError", error: "x" } }, both());
  assert.match(r.texts[0], /Сбой: Кабинет заказчика/);
});

test("NL отрезан: прежнее держится CUTOFF_HOLD_ROUNDS кругов, потом — «не проверен», а не вечное зелёное", () => {
  let prevPub = round({}, both()).pub;
  const off = { "door-1": unreachable, "door-2": unreachable };
  let r;
  for (let i = 1; i <= CUTOFF_HOLD_ROUNDS + 1; i += 1) {
    r = round(isolated(), off, { controlsOk: false, prevPub });
    prevPub = r.pub;
    if (i <= CUTOFF_HOLD_ROUNDS) assert.equal(row(r.v, "app").state, "up", `круг ${i}: ещё прежнее`);
    assert.equal(r.texts.length, 0, `круг ${i}: тревог нет`);
  }
  assert.equal(row(r.v, "app").state, "unknown", "после предела — «не проверен»");
  const pubApp = r.pub.groups.flatMap((g) => g.rows).find((x) => x.id === "app");
  assert.equal(pubApp.known, "up", "прошлое не потеряно");
  // и снова видит — строка возвращается, событий «поднялся» нет (не проверен → работает)
  const back = round({}, both(), { prevPub });
  assert.equal(row(back.v, "app").state, "up");
  assert.equal(back.texts.length, 0);
});

test("сообщение «монитор не видит Россию» — со второго круга, одно; «снова видит» — одно; одиночная минута — тишина", () => {
  const a = cutoffNotice(null, true, "2026-10-25T20:00:00.000Z", "25.10, 23:00");
  assert.equal(a.say, null);
  const b = cutoffNotice(a.state, true, "2026-10-25T20:01:00.000Z", "25.10, 23:01");
  assert.match(b.say, /Монитор не видит Россию<\/b> с 23:00 МСК/);
  const c = cutoffNotice(b.state, true, "2026-10-25T20:02:00.000Z", "25.10, 23:02");
  assert.equal(c.say, null, "повторно не пишем");
  const d = cutoffNotice(c.state, false, "2026-10-25T20:03:00.000Z", "25.10, 23:03");
  assert.match(d.say, /снова видит Россию/);
  assert.equal(d.state, null);
  const blip = cutoffNotice(cutoffNotice(null, true, "x", "s").state, false, "y", "s");
  assert.equal(blip.say, null, "одна минута без связи — ни начала, ни конца");
});

test("отступ после «ключ не принят»: 30 минут дверь не спрашиваем (fail2ban), потом снова", () => {
  const st = nextAskState({}, [{ id: "door-1", reach: "auth", error: "ключ не принят" }, { id: "door-2", reach: "ok" }], 1000);
  assert.equal(shouldAsk(st["door-1"], 1000 + 60), false);
  assert.equal(shouldAsk(st["door-1"], 1000 + 31 * 60), true);
  assert.equal(st["door-2"], undefined);
  assert.equal(shouldAsk(undefined, 1000), true);
  assert.equal(shouldAsk({ reach: "net", at: 1000 }, 1001), true, "ЗДЕСЬ отступа НЕ должно: нет связи — не повод молчать");
  const cleared = nextAskState(st, [{ id: "door-1", reach: "ok" }], 3000);
  assert.equal(cleared["door-1"], undefined);
  const kept = nextAskState(st, [{ id: "door-1", reach: "backoff", skipped: true }], 1100);
  assert.equal(kept["door-1"].at, 1000, "пропущенный круг отсчёт не сдвигает");
});

test("пропущенная дверь (отступ) — не доказательство связи с Россией и не точка", () => {
  const off = { "door-1": { reach: "backoff", error: "ключ не принят; повтор через 20 мин" }, "door-2": unreachable };
  const r = after(isolated(), off, { controlsOk: false });
  assert.equal(r.mesh.roadOk, false);
  assert.match(r.matrix.join("\n"), /балансировщик 1: голос недоступен \(ключ не принят; повтор через 20 мин\)/);
});

test("Россия видит, что балансировщик ОТВЕЧАЕТ ОШИБКОЙ — «не работает», misleads, «Сбой» сразу", () => {
  const r = after({ lb2: net() }, both({ "door-1": { peer: "down" } }));
  assert.equal(row(r.v, "lb2").word, "не работает");
  assert.equal(row(r.v, "lb2").misleads, true);
  assert.match(r.texts[0], /^🔴 <b>Сбой: Балансировщик 2<\/b>/);
});

test("ЗДЕСЬ «Россия не видит» НЕ должно: у двери своя сеть лежит (прод unknown) — её «сосед молчит» не довод", () => {
  const r = after({ lb2: net() }, both({ "door-1": { peer: "unreachable", prod: "000", prodState: "unknown" } }), { controlsOk: true });
  // доводов из России нет — дорога жива, верим NL как раньше (удержание: первый круг)
  assert.equal(r.mesh.notes.ruDown.length, 0);
});

test("ssh: команда на двери упала (нет vote.json) — дверь ответила («bad»), а не «нет связи»", async () => {
  const f = await get("catfail");
  assert.equal(f.reach, "bad");
  assert.match(f.error, /No such file/);
});
