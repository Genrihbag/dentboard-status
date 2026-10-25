#!/usr/bin/env node
/**
 * РАСКЛАДКА ПО ГРУППАМ — образцами, без сети и без Telegram.
 *
 * 🔴 ЗАЧЕМ. Почти всё здесь исполняется ТОЛЬКО в аварию: лёг один балансировщик, DNS отдал чужой
 * адрес, сертификат на исходе. В спокойную неделю ни одна из этих веток не исполняется ни разу, и
 * ошибка в ней обнаружилась бы ровно тогда, когда механизм нужен впервые.
 *
 * ⚠️ У КАЖДОГО ПРАВИЛА — ПАРНЫЙ СЛУЧАЙ «ЗДЕСЬ НЕ ДОЛЖНО». Набор из одних «краснеет» прошёл бы и у
 * правила «краснеть всегда».
 *
 * Запуск: `node --test layout.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LAYOUT,
  evaluate,
  groupState,
  overallOf,
  publicView,
  compatCurrent,
  previousStates,
  transitions,
  alertTexts,
  redact,
  days,
  balancerAccepts,
} from "./layout.mjs";

/** Боевой список — чтобы образцы проверяли НАСТОЯЩИЕ тексты и id, а не свою копию. */
const CONFIG = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8"));
const IPS = ["136.234.13.100", "153.51.113.60"];
const NOW = "2026-10-25T18:00:00.000Z";

const up = (ms = 200) => ({ ok: true, status: 200, ms });
const dead = (error = "connect ETIMEDOUT 153.51.113.60:443 (ETIMEDOUT)") => ({ ok: false, status: 0, ms: 15000, error });
const ready = (ms = 200, db = 1) => ({
  ok: true,
  status: 200,
  ms,
  body: JSON.stringify({ status: "ok", checks: { postgres: { up: true, latency_ms: db }, redis: { up: true, latency_ms: 0 } } }),
});
const dnsOk = (total = 4) => ({ ok: true, wrong: false, answered: total, total, answers: [], ms: 20 });
const dnsWrong = () => ({
  ok: false,
  wrong: true,
  answered: 3,
  total: 4,
  answers: [{ server: "c.ns.selectel.ru", ok: false, wrong: true, error: "отдаёт 203.0.113.7 (нет 136.234.13.100, 153.51.113.60; лишний 203.0.113.7)" }],
});
const dnsSilent = () => ({ ok: false, wrong: false, answered: 0, total: 2, answers: [{ server: "ns1.yandexcloud.net", ok: false, error: "не ответил за 3000 мс" }] });
const cert = (d1 = 89, d2 = d1, extra = {}) => ({
  perDoor: [
    { door: "lb1", ok: true, days: d1, validTo: "2027-01-23T10:19:52.000Z", authorized: true, authorizationError: null, ...extra },
    { door: "lb2", ok: true, days: d2, validTo: "2027-01-23T10:19:52.000Z", authorized: true, authorizationError: null },
  ],
});

/** Всё здорово. Сценарии ниже правят по одной строке. */
const healthy = () => ({
  app: up(),
  portal: up(),
  site: up(),
  lb1: up(120),
  lb2: up(130),
  dns1: dnsOk(4),
  dns2: dnsOk(2),
  server: ready(),
  cert: cert(),
});
const view = (patch = {}) => evaluate(CONFIG, { ...healthy(), ...patch }, { slowMs: 1500 });
const group = (v, id) => v.groups.find((g) => g.id === id);
const row = (v, id) => v.groups.flatMap((g) => g.rows).find((r) => r.id === id);

/* ── ВСЁ ЗДОРОВО ─────────────────────────────────────────────────────────────────────────── */

test("всё здорово — все группы зелёные, свод «up», фраз под группами нет", () => {
  const v = view();
  for (const g of v.groups) assert.equal(g.state, "up", g.title);
  assert.equal(v.overall, "up");
  assert.ok(v.groups.every((g) => g.summary === null));
});

test("боевой список: пять групп в заданном порядке, имена строк без провайдеров", () => {
  const v = view();
  assert.deepEqual(v.groups.map((g) => g.title), ["Для пользователей", "Балансировщики", "DNS", "Сервер и база", "Сертификат"]);
  assert.deepEqual(group(v, "balancers").rows.map((r) => r.name), ["Балансировщик 1", "Балансировщик 2"]);
  assert.deepEqual(group(v, "dns").rows.map((r) => r.name), ["DNS 1", "DNS 2"]);
});

test("ожидаемый ответ DNS и адреса балансировщиков — один список (адреса дверей из ztl-lab)", () => {
  const ips = CONFIG.groups.find((g) => g.kind === "balancer").rows.map((r) => r.ip).sort();
  assert.deepEqual(ips, IPS);
});

/* ── БАЛАНСИРОВЩИКИ ──────────────────────────────────────────────────────────────────────── */

test("лёг ОДИН балансировщик — группа жёлтая, «вход работает через второй»; свод ЗЕЛЁНЫЙ с оговоркой", () => {
  // Решение владельца 25.10.2026: людям всё работает, и «Есть проблемы» на странице и жёлтая
  // точка в кабинетах читались бы клиентом как авария.
  const v = view({ lb2: dead() });
  assert.equal(row(v, "lb2").state, "down");
  assert.equal(row(v, "lb2").word, "не отвечает");
  assert.equal(group(v, "balancers").state, "warn");
  assert.match(group(v, "balancers").summary, /вход работает через второй/);
  assert.equal(v.overall, "up");
  assert.equal(v.notice, "Резерв частично недоступен — на работу это не влияет.");
});

test("один DNS молчит и сертификат < 14 дней — тоже зелёный свод с оговоркой", () => {
  assert.equal(view({ dns2: dnsSilent() }).overall, "up");
  const c = view({ cert: cert(10) });
  assert.equal(c.overall, "up");
  assert.match(c.notice, /Сертификат скоро истекает/);
});

test("ЗДЕСЬ ОГОВОРКИ БЫТЬ НЕ ДОЛЖНО: всё здорово, или людям уже плохо", () => {
  assert.equal(view().notice, null);
  assert.equal(view({ portal: dead() }).notice, null);
});

test("ЗДЕСЬ ЗЕЛЁНОГО БЫТЬ НЕ ДОЛЖНО: запаса нет (оба балансировщика, оба DNS), сертификат вот-вот истечёт", () => {
  assert.equal(view({ lb1: dead(), lb2: dead() }).overall, "slow");
  assert.equal(view({ dns1: dnsWrong(), dns2: dnsSilent() }).overall, "slow");
  assert.equal(view({ cert: cert(2) }).overall, "slow");
});

test("не работает одна страница для пользователей — свод жёлтый, а не зелёный", () => {
  assert.equal(view({ portal: dead() }).overall, "slow");
});

test("легли ОБА — группа красная", () => {
  const v = view({ lb1: dead(), lb2: dead() });
  assert.equal(group(v, "balancers").state, "down");
  assert.match(group(v, "balancers").summary, /Оба балансировщика недоступны/);
});

test("балансировщик ответил кодом — «не работает», а не «не отвечает»", () => {
  const v = view({ lb1: { ok: false, status: 502, ms: 40 } });
  assert.equal(row(v, "lb1").word, "не работает");
  assert.match(row(v, "lb1").detail, /код 502/);
});

/* ── DNS ─────────────────────────────────────────────────────────────────────────────────── */

test("один DNS отдаёт не те адреса — «отвечает неверно», группа жёлтая", () => {
  const v = view({ dns1: dnsWrong() });
  assert.equal(row(v, "dns1").word, "отвечает неверно");
  assert.equal(group(v, "dns").state, "warn");
  assert.match(row(v, "dns1").detail, /c\.ns\.selectel\.ru: отдаёт 203.0.113.7/);
});

test("молчащий DNS — «не отвечает», а не «отвечает неверно»", () => {
  assert.equal(row(view({ dns2: dnsSilent() }), "dns2").word, "не отвечает");
});

test("оба DNS не в порядке — группа красная", () => {
  assert.equal(group(view({ dns1: dnsWrong(), dns2: dnsSilent() }), "dns").state, "down");
});

/* ── СЕРВЕР И БАЗА ───────────────────────────────────────────────────────────────────────── */

test("сервер: задержка базы видна числом", () => {
  const v = view({ server: ready(240, 3) });
  assert.equal(row(v, "server").value, "база 3 мс");
  assert.equal(row(v, "server").ms, 240);
});

test("сервер ответил 503 с лежащей базой — красная строка, причина «база не отвечает»", () => {
  const body = JSON.stringify({ status: "error", checks: { postgres: { up: false }, redis: { up: true, latency_ms: 0 } } });
  const v = view({ server: { ok: false, status: 503, ms: 30, body } });
  assert.equal(row(v, "server").state, "down");
  assert.match(row(v, "server").detail, /код 503, база не отвечает/);
  // Страницы при этом живы — свод жёлтый, а не красный (решение владельца 28.08.2026).
  assert.equal(v.overall, "slow");
});

test("ЗДЕСЬ ЗЕЛЁНОГО БЫТЬ НЕ ДОЛЖНО: 200, но тело готовности не «ok»", () => {
  const v = view({ server: { ok: true, status: 200, ms: 30, body: "<html>заглушка</html>" } });
  assert.equal(row(v, "server").state, "down");
});

/* ── СЕРТИФИКАТ ──────────────────────────────────────────────────────────────────────────── */

test("сертификат: границы 14 и 3 дня — с парными случаями по обе стороны", () => {
  const at = (d) => row(view({ cert: cert(d) }), "cert").state;
  assert.equal(at(14), "up", "14 дней — ещё зелёное");
  assert.equal(at(13), "warn", "13 дней — жёлтое");
  assert.equal(at(3), "warn", "3 дня — ещё жёлтое");
  assert.equal(at(2), "down", "2 дня — красное");
  assert.equal(at(-1), "down", "истёк — красное");
  assert.equal(row(view({ cert: cert(-1) }), "cert").word, "истёк");
});

test("сертификат: берётся МЕНЬШИЙ срок из двух балансировщиков", () => {
  const v = view({ cert: cert(89, 10) });
  assert.equal(row(v, "cert").state, "warn");
  assert.equal(row(v, "cert").value, "осталось 10 дней");
});

test("сертификат чужой (не то имя) — «не подходит», даже при долгом сроке", () => {
  const v = view({ cert: cert(89, 89, { authorized: false, authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID" }) });
  assert.equal(row(v, "cert").word, "не подходит");
  assert.equal(row(v, "cert").state, "down");
});

test("истёкший сертификат — срок, а не «чужой»", () => {
  const v = view({ cert: cert(-2, 89, { authorized: false, authorizationError: "CERT_HAS_EXPIRED" }) });
  assert.equal(row(v, "cert").word, "истёк");
});

test("ни один балансировщик не отдал сертификата — «не проверен», и свод это НЕ красит", () => {
  // Отказ балансировщиков уже назван их строками; второй раз красить ту же аварию чужой строкой
  // значило бы удвоить её.
  const v = view({ cert: { perDoor: [{ door: "lb1", ok: false, error: "x" }, { door: "lb2", ok: false, error: "y" }] } });
  assert.equal(row(v, "cert").state, "unknown");
  assert.equal(group(v, "cert").state, "unknown");
  assert.equal(v.overall, "up");
});

test("склонение дней", () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22, 89, 112].map(days), ["1 день", "2 дня", "5 дней", "11 дней", "21 день", "22 дня", "89 дней", "112 дней"]);
});

/* ── СВОД (перенесено из avatar.test.mjs вместе с правилом) ──────────────────────────────── */

test("красный — только когда не работает НИ ОДНА страница для пользователей", () => {
  assert.equal(view({ app: dead(), portal: dead(), site: dead() }).overall, "down");
});

test("ЗДЕСЬ КРАСНОГО БЫТЬ НЕ ДОЛЖНО: легли все страницы, кроме одной", () => {
  // Парный случай: без него правило «все» прошло бы и у реализации «хотя бы одна».
  assert.equal(view({ app: dead(), portal: dead() }).overall, "slow");
});

test("медленно отвечают ДВЕ строки — жёлтый", () => {
  assert.equal(view({ app: up(9000), portal: up(9000) }).overall, "slow");
});

test("медленно отвечает ОДНА — жёлтого быть НЕ должно (одиночный выброс — свойство цели)", () => {
  assert.equal(view({ app: up(9000) }).overall, "up");
});

test("пустой вход — «unknown», а не «всё хорошо»", () => {
  assert.equal(overallOf([]), "unknown");
  assert.equal(groupState([]), "unknown");
});

/* ── ПУБЛИЧНОЕ И ЧАСТНОЕ ─────────────────────────────────────────────────────────────────── */

test("публичный вид НЕ несёт провайдеров, адресов и серверов имён — ни при каком состоянии", () => {
  const v = view({ lb2: dead(), dns1: dnsWrong(), cert: cert(10) });
  const text = JSON.stringify(publicView(v));
  for (const leak of ["Selectel", "Yandex", "Яндекс", "СПб", "selectel.ru", "yandexcloud", ...IPS, "203.0.113.7", "ETIMEDOUT"]) {
    assert.ok(!text.includes(leak), `в публичном виде нашлось «${leak}»`);
  }
});

test("положительный контроль: подробности ЕСТЬ во внутреннем виде — иначе проверка выше пуста", () => {
  const v = view({ lb2: dead(), dns1: dnsWrong() });
  const inner = JSON.stringify(v);
  assert.ok(inner.includes("Yandex Cloud") && inner.includes("c.ns.selectel.ru"));
});

test("адреса вырезаются из причины отказа", () => {
  assert.equal(redact("connect ECONNREFUSED 136.234.13.100:443 (ECONNREFUSED)"), "connect ECONNREFUSED … (ECONNREFUSED)");
  assert.equal(redact(null), null);
});

/* ── СОВМЕСТИМОСТЬ С КАБИНЕТАМИ ztl-lab ──────────────────────────────────────────────────── */

test("`current` — страницы и сервер с ok/ms; балансировщиков, DNS и сертификата там нет", () => {
  const cur = compatCurrent(view({ portal: dead() }), { now: NOW });
  assert.deepEqual(Object.keys(cur), ["Кабинет лаборатории", "Кабинет заказчика", "Сайт", "Сервер и база"]);
  assert.equal(cur["Кабинет лаборатории"].ok, true);
  assert.equal(typeof cur["Кабинет лаборатории"].ms, "number");
  assert.equal(cur["Кабинет заказчика"].ok, false);
});

/* ── СМЕНЫ СОСТОЯНИЯ И СООБЩЕНИЯ ─────────────────────────────────────────────────────────── */

/** Прошлый файл ПРЕЖНЕЙ раскладки — как на боевой машине до выката. */
const OLD = {
  current: {
    Сайт: { ok: true },
    "Кабинет лаборатории": { ok: true },
    "Кабинет заказчика": { ok: true },
    API: { ok: true },
    "API и его зависимости": { ok: true },
  },
  events: [],
};

test("ПЕРВЫЙ КРУГ ПОСЛЕ ВЫКАТА: по новым строкам событий нет, даже если строка уже красная", () => {
  // Иначе выкат разослал бы «работает: Балансировщик 1, DNS 1, …» — пост ни о чём.
  const moved = transitions(view({ lb2: dead(), cert: cert(10) }), previousStates(OLD, CONFIG), NOW);
  assert.equal(moved.events.length, 0);
});

test("ПЕРВЫЙ КРУГ ПОСЛЕ ВЫКАТА: страница с тем же именем помнит прошлое — её падение НЕ теряется", () => {
  const moved = transitions(view({ portal: dead() }), previousStates(OLD, CONFIG), NOW);
  assert.deepEqual(moved.events.map((e) => [e.target, e.state]), [["Кабинет заказчика", "упал"]]);
});

const asPrev = (v) => ({ layout: LAYOUT, groups: publicView(v) });

test("лёг один балансировщик — событие уходит «вниманием», а не «сбоем»", () => {
  const moved = transitions(view({ lb2: dead() }), previousStates(asPrev(view()), CONFIG), NOW);
  assert.equal(moved.down.length, 0);
  assert.deepEqual(moved.warn.map((x) => x.row.name), ["Балансировщик 2"]);
});

test("лёг второй балансировщик — уже «сбой»", () => {
  const moved = transitions(view({ lb1: dead(), lb2: dead() }), previousStates(asPrev(view({ lb2: dead() })), CONFIG), NOW);
  assert.deepEqual(moved.down.map((x) => x.row.name), ["Балансировщик 1"]);
});

test("упавшая СТРАНИЦА — «сбой» сразу: у неё запасной нет", () => {
  const moved = transitions(view({ portal: dead() }), previousStates(asPrev(view()), CONFIG), NOW);
  assert.deepEqual(moved.down.map((x) => x.row.name), ["Кабинет заказчика"]);
});

test("ничего не менялось — событий нет (второй круг того же состояния)", () => {
  const v = view({ lb2: dead() });
  assert.equal(transitions(v, previousStates(asPrev(v), CONFIG), NOW).events.length, 0);
});

test("текст в канал: провайдер и адрес — есть; фраза группы — есть", () => {
  const v = view({ lb2: dead() });
  const [msg] = alertTexts(transitions(v, previousStates(asPrev(view()), CONFIG), NOW), v, "25.10, 21:00", "https://status.dentboard.ru");
  assert.match(msg, /^🟡 <b>Внимание: Балансировщик 2<\/b>/);
  assert.match(msg, /Балансировщик 2 \(Yandex Cloud, 153\.51\.113\.60\): не отвечает — connect ETIMEDOUT/);
  assert.match(msg, /вход работает через второй/);
});

test("событие в ПУБЛИЧНОЙ истории — без провайдера и без причины у балансировщика", () => {
  const moved = transitions(view({ lb2: dead() }), previousStates(asPrev(view()), CONFIG), NOW);
  const e = moved.events[0];
  assert.equal(e.target, "Балансировщик 2");
  assert.equal(e.phrase, "не отвечает");
  assert.equal(e.error, null);
});

test("поднялся один из двух упавших — «работает», и сказано, что запаса ещё нет", () => {
  const before = view({ lb1: dead(), lb2: dead() });
  const after = view({ lb2: dead() });
  const msgs = alertTexts(transitions(after, previousStates(asPrev(before), CONFIG), NOW), after, "25.10, 21:00", "x");
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /^✅ <b>Работает: Балансировщик 1<\/b>/);
  assert.match(msgs[0], /вход работает через второй/);
});

/* ── ПРАВКИ ПО РЕВЬЮ 25.10.2026 ──────────────────────────────────────────────────────────── */

test("балансировщик, доведший запрос до НЕГОТОВОГО сервера (503 с телом готовности), жив", () => {
  // Иначе лежащая база красила бы оба балансировщика: «вход не работает» — неверный диагноз.
  const body = JSON.stringify({ status: "error", checks: { postgres: { up: false }, redis: { up: true } } });
  assert.equal(balancerAccepts(200, "{}"), true);
  assert.equal(balancerAccepts(503, body), true);
});

test("ЗДЕСЬ ЖИВЫМ БЫТЬ НЕ ДОЛЖЕН: 503 без тела готовности, 502, 504", () => {
  assert.equal(balancerAccepts(503, "<html>Service Unavailable</html>"), false);
  assert.equal(balancerAccepts(503, '{"message":"x"}'), false);
  assert.equal(balancerAccepts(502, ""), false);
  assert.equal(balancerAccepts(504, ""), false);
});

test("медленная готовность считается ОДИН раз, а не трижды (балансировщики в счёт медленных не идут)", () => {
  assert.equal(view({ server: ready(1600), lb1: up(1600), lb2: up(1600) }).overall, "up");
});

test("ЗДЕСЬ ЗЕЛЁНОГО БЫТЬ НЕ ДОЛЖНО: медленные страница и сервер", () => {
  assert.equal(view({ app: up(1600), server: ready(1600) }).overall, "slow");
});

test("один DNS отдаёт НЕВЕРНЫЙ адрес — это не резерв: свод жёлтый, своя фраза, корзина «сбой»", () => {
  const v = view({ dns1: dnsWrong() });
  assert.equal(v.overall, "slow");
  assert.equal(v.notice, null);
  assert.match(group(v, "dns").summary, /отдаёт неверный адрес/);
  const moved = transitions(v, previousStates(asPrev(view()), CONFIG), NOW);
  assert.deepEqual(moved.down.map((x) => x.row.name), ["DNS 1"]);
});

test("балансировщик отвечает кодом ошибки — люди на второй не уходят: свод жёлтый, «сбой»", () => {
  const v = view({ lb2: { ok: false, status: 502, ms: 40 } });
  assert.equal(v.overall, "slow");
  assert.match(group(v, "balancers").summary, /отвечает ошибкой/);
  const moved = transitions(v, previousStates(asPrev(view()), CONFIG), NOW);
  assert.deepEqual(moved.down.map((x) => x.row.name), ["Балансировщик 2"]);
});

test("«не проверен» не стирает прошлое: сертификат истёк, пока балансировщики лежали, — событие есть", () => {
  const healthyPrev = previousStates(asPrev(view()), CONFIG);
  const outage = view({ lb1: dead(), lb2: dead(), cert: { perDoor: [{ door: "lb1", ok: false, error: "x" }, { door: "lb2", ok: false, error: "y" }] } });
  const outagePublished = { layout: LAYOUT, groups: publicView(outage, undefined, healthyPrev) };
  const certRow = outagePublished.groups.find((g) => g.id === "cert").rows[0];
  assert.equal(certRow.state, "unknown");
  assert.equal(certRow.known, "up");
  const back = view({ cert: cert(-1, -1, { authorized: false, authorizationError: "CERT_HAS_EXPIRED" }) });
  const moved = transitions(back, previousStates(outagePublished, CONFIG), NOW);
  assert.ok(moved.down.some((x) => x.row.name === "Сертификат"), "«Сбой: Сертификат» обязан уйти");
});

test("первый круг после выката: «Сервер и база» помнит прошлое «API и его зависимости»", () => {
  const prev = previousStates({ current: { ...OLD.current, "API и его зависимости": { ok: false } }, events: [] }, CONFIG);
  assert.equal(prev.server, "down");
  const moved = transitions(view(), prev, NOW);
  assert.deepEqual(moved.up.map((x) => x.row.name), ["Сервер и база"]);
});

test("адреса IPv6 вырезаются; время вида 10:30:00 — нет", () => {
  assert.equal(redact("connect ECONNREFUSED 2a03:6f00:1::5:443 (x)"), "connect ECONNREFUSED … (x)");
  assert.equal(redact("в 10:30:00 ответа не было"), "в 10:30:00 ответа не было");
});

test("оговорка: резерв и сертификат вместе — названы оба", () => {
  assert.match(view({ lb2: dead(), cert: cert(10) }).notice, /Резерв частично недоступен, сертификат скоро истекает/);
});
