#!/usr/bin/env node
/**
 * ТАБЛО — ОБРАЗЦАМИ, БЕЗ СЕТИ И БЕЗ TELEGRAM.
 *
 * 🔴 ЗАЧЕМ ЭТО ПРОВЕРЯТЬ. Расписание правок — механизм, который ПО ЗАМЫСЛУ в большинстве кругов
 * ничего не делает. Ошибка в нём не видна ни с какой стороны: табло просто не меняется, и это
 * выглядит как «состояние стабильное». Проверить наблюдением можно, но ждать пришлось бы часами и
 * настоящего отказа — то есть ровно того случая, когда механизм и должен сработать впервые.
 *
 * ⚠️ ПОЛОВИНА НАБОРА — СЛУЧАИ «ЗДЕСЬ ПРАВИТЬ НЕ ДОЛЖНЫ». Набор из одних «правим» доказал бы, что
 * табло обновляется, и промолчал бы о том, не обновляется ли оно КАЖДУЮ минуту — а это и есть та
 * ошибка, которой стоит бояться: она не ломает ничего видимого и тихо жжёт чужой сервис.
 *
 * Запуск: `node --test board.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardText, decideBoard, TELEGRAM_LIMIT } from "./board.mjs";
import { evaluate } from "./layout.mjs";

const STAMP = "30.08, 03:12";
const PAGE = "https://status.dentboard.ru";
const MIN = 5 * 60_000;
const NOW = Date.parse("2026-08-30T00:12:00Z");
const agoMin = (m) => new Date(NOW - m * 60_000).toISOString();

/* ── ТЕКСТ ───────────────────────────────────────────────────────────────────────────────── */

/** Две группы: страница и пара балансировщиков с провайдерами — как в боевом списке. */
const CONFIG = {
  groups: [
    { id: "users", title: "Для пользователей", kind: "http", rows: [{ id: "app", name: "Кабинет лаборатории" }] },
    {
      id: "balancers",
      title: "Балансировщики",
      kind: "balancer",
      redundant: true,
      say: { warn: "Один балансировщик недоступен — вход работает через второй." },
      rows: [
        { id: "lb1", name: "Балансировщик 1", label: "Selectel, СПб", ip: "136.234.13.100" },
        { id: "lb2", name: "Балансировщик 2", label: "Yandex Cloud", ip: "153.51.113.60" },
      ],
    },
  ],
};
const up = (ms = 180) => ({ ok: true, status: 200, ms });
const text = (raw, mesh = null) => boardText(evaluate(CONFIG, raw, { slowMs: 1500 }), STAMP, PAGE, mesh);
const pre = (t) => (t.match(/<pre>([\s\S]*?)<\/pre>/) ?? [null, ""])[1];
const lineOf = (t, name) => pre(t).split("\n").find((l) => l.includes(name)) ?? "";
const RU = (o = {}) => ({
  votes: [
    { fresh: true, prod: { code: "200", ms: o.p1 ?? 45 }, peer: { addr: "153.51.113.60", state: o.peer2 ?? "up", ms: 12 } },
    { fresh: true, prod: { code: "200", ms: o.p2 ?? 41 }, peer: { addr: "136.234.13.100", state: "up", ms: 9 } },
  ],
  notes: { ruUp: [], cutoff: false },
});

test("табло — таблица в <pre>: шапка, по строке на цель, колонки 🇳🇱 и 🇷🇺 (флаги, не буквы)", () => {
  const t = text({ app: up(180), lb1: up(120), lb2: up(130) }, RU());
  assert.match(t, /^<b>DentBoard — состояние<\/b>\nПроверено 30\.08, 03:12 МСК/);
  assert.match(pre(t), /Цель\s+🇳🇱\s+🇷🇺/);
  assert.ok(!pre(t).includes("NL") && !pre(t).includes("RU"), "шапка — флагами, а не буквами NL/RU");
  assert.match(lineOf(t, "Кабинет лаборатории"), /^✅ Кабинет лаборатории\s+180 мс\s+—$/);
  assert.match(lineOf(t, "Балансировщик 1"), /^✅ Балансировщик 1\s+120 мс\s+9 мс$/, "RU у балансировщика — глазами соседа");
  assert.match(lineOf(t, "Балансировщик 2"), /^✅ Балансировщик 2\s+130 мс\s+12 мс$/);
});

test("колонки ровные: длина строк таблицы одинакова (кроме шапки, где вместо значка два пробела)", () => {
  const lines = pre(text({ app: up(5), lb1: up(12345), lb2: { ok: false, status: 502, ms: 1 } }, RU())).split("\n").slice(1);
  const lens = new Set(lines.map((l) => [...l].length));
  assert.equal(lens.size, 1, `разная длина строк: ${lines.join(" | ")}`);
});

test("в табло НЕТ провайдеров и адресов — они в событийных сообщениях", () => {
  const t = text({ app: up(), lb1: up(), lb2: { ok: false, status: 0, ms: 15000, error: "connect ETIMEDOUT 153.51.113.60:443" } }, RU());
  for (const leak of ["Selectel", "Yandex", "СПб", "136.234", "153.51", "ETIMEDOUT"]) assert.ok(!t.includes(leak), `в табло «${leak}»`);
});

test("отказ — словом в колонке NL: «нет» без ответа, «код 502» с ответом; значок 🔴", () => {
  const nothing = text({ app: { ok: false, status: 0, ms: 15000, error: "x" }, lb1: up(), lb2: up() });
  const five = text({ app: { ok: false, status: 502, ms: 300 }, lb1: up(), lb2: up() });
  assert.match(lineOf(nothing, "Кабинет"), /^🔴 Кабинет лаборатории\s+нет\s+—$/);
  assert.match(lineOf(five, "Кабинет"), /^🔴 Кабинет лаборатории\s+код 502\s+—$/);
});

test("RU: голосов нет вовсе — «—» у всех строк", () => {
  const t = text({ app: up(), lb1: up(), lb2: up() });
  for (const l of pre(t).split("\n").slice(1)) assert.match(l, /—$/);
});

test("сосед не видит балансировщик — RU «нет»", () => {
  assert.match(lineOf(text({ app: up(), lb1: up(), lb2: up() }, RU({ peer2: "unreachable" })), "Балансировщик 2"), /нет$/);
});

test("медленная цель — 🟡; а быстрая НЕ 🟡", () => {
  // Парный отрицательный случай: без него правило «рисовать 🟡» прошло бы и в варианте «рисовать
  // 🟡 всегда», и табло стало бы жёлтым при полностью исправной системе.
  assert.match(text({ app: up(9000), lb1: up(), lb2: up() }), /🟡 Кабинет лаборатории/);
  assert.doesNotMatch(text({ app: up(200), lb1: up(), lb2: up() }), /🟡/);
});

test("время проверки стои́т в тексте — иначе замёрзшее табло выглядит здоровым", () => {
  assert.match(text({ app: up(), lb1: up(), lb2: up() }), /Проверено 30\.08, 03:12 МСК/);
});

test("фраза группы — под таблицей курсивом; раздела «Кто кого видит» нет", () => {
  const t = text({ app: up(), lb1: up(120), lb2: { ok: false, status: 0, ms: 15000, error: "x" } }, RU());
  assert.match(t, /<\/pre>\n\n<i>Один балансировщик недоступен — вход работает через второй\.<\/i>/);
  assert.doesNotMatch(t, /Кто кого видит/);
});

test("ЗДЕСЬ ФРАЗЫ О ЗАПАСЕ БЫТЬ НЕ ДОЛЖНО: оба балансировщика живы", () => {
  assert.doesNotMatch(text({ app: up(), lb1: up(), lb2: up() }), /через второй/);
});

test("экранирование: < > & в имени цели и во фразе не ломают разметку", () => {
  const cfg = { groups: [{ id: "u", title: "T", kind: "http", say: { down: "a < b & c > d" }, rows: [{ id: "x", name: "Сайт <&> тест" }] }] };
  const t = boardText(evaluate(cfg, { x: { ok: false, status: 0, ms: 1, error: "e" } }), "s", PAGE);
  assert.match(t, /Сайт &lt;&amp;&gt; тест/);
  assert.match(t, /<i>a &lt; b &amp; c &gt; d<\/i>/);
  assert.doesNotMatch(t.replace(/<\/?(b|i|pre)>|<a href="[^"]*">|<\/a>/g, ""), /[<>]/, "сырых < > вне наших тегов нет");
});

test("длина: боевое табло далеко от 4096; разросшееся — режет пометки, а не таблицу", () => {
  assert.ok(text({ app: up(), lb1: up(), lb2: up() }, RU()).length < 1500);
  const many = { groups: [{ id: "u", title: "T", kind: "http", say: { down: "ф".repeat(5000) }, rows: [{ id: "x", name: "Сайт" }] }] };
  const t = boardText(evaluate(many, { x: { ok: false, status: 0, ms: 1, error: "e" } }), "s", PAGE);
  assert.ok(t.length <= TELEGRAM_LIMIT);
  assert.match(t, /<pre>[\s\S]*Сайт[\s\S]*<\/pre>/);
  assert.match(t, /пометки не поместились/);
});

/* ── РАСПИСАНИЕ ПРАВОК ───────────────────────────────────────────────────────────────────── */

test("СМЕНА СОСТОЯНИЯ правит немедленно, не дожидаясь интервала", () => {
  const d = decideBoard({
    changed: true,
    lastEditedAt: agoMin(1),
    now: NOW,
    lastText: "старое",
    nextText: "новое",
    minIntervalMs: MIN,
  });
  assert.equal(d.act, "edit");
});

test("НЕ ПРАВИМ: ничего не менялось и прошла минута из пяти", () => {
  const d = decideBoard({
    changed: false,
    lastEditedAt: agoMin(1),
    now: NOW,
    lastText: "старое",
    nextText: "новое",
    minIntervalMs: MIN,
  });
  assert.equal(d.act, "skip");
});

test("правим, когда интервал вышел", () => {
  const d = decideBoard({
    changed: false,
    lastEditedAt: agoMin(6),
    now: NOW,
    lastText: "старое",
    nextText: "новое",
    minIntervalMs: MIN,
  });
  assert.equal(d.act, "edit");
});

test("НЕ ПРАВИМ: текст побайтно тот же — даже если интервал вышел и состояние сменилось", () => {
  // Telegram на такую правку отвечает `message is not modified`. Спрашивать его об этом незачем:
  // ответ известен здесь, бесплатно и без сети. А главное — обработчик отказа принял бы это за
  // неудачу правки и отправил бы НОВОЕ табло, то есть лечение оказалось бы хуже болезни.
  const d = decideBoard({
    changed: true,
    lastEditedAt: agoMin(60),
    now: NOW,
    lastText: "одно и то же",
    nextText: "одно и то же",
    minIntervalMs: MIN,
  });
  assert.equal(d.act, "skip");
});

test("первого табла ещё нет — ставим сразу, не дожидаясь события", () => {
  // Иначе канал молчал бы до первого падения, то есть ровно до того случая, ради которого табло и
  // заводили.
  const d = decideBoard({ changed: false, lastEditedAt: null, now: NOW, nextText: "первое", minIntervalMs: MIN });
  assert.equal(d.act, "edit");
});

test("битая отметка времени НЕ запирает табло навсегда", () => {
  const d = decideBoard({
    changed: false,
    lastEditedAt: "не дата",
    now: NOW,
    lastText: "старое",
    nextText: "новое",
    minIntervalMs: MIN,
  });
  assert.equal(d.act, "edit");
});

/* ── правки по ревью табло (26.10.2026) ── */

test("сосед с лежащей своей сетью (прод unknown) про балансировщик не говорит — RU «—», а не «нет»", () => {
  const mesh = { votes: [{ fresh: true, prod: { state: "unknown", code: "000", ms: null }, peer: { addr: "136.234.13.100", state: "unreachable", ms: null } }], notes: {} };
  assert.match(lineOf(text({ app: up(), lb1: up(120), lb2: up() }, mesh), "Балансировщик 1"), /120 мс\s+—$/);
});

test("удержанная строка (первый сбой) — RU «—»: свежий русский замер не выдаёт удержанное", () => {
  const v = evaluate(CONFIG, { app: up(), lb1: up(), lb2: up() }, { slowMs: 1500 });
  const lb2 = v.groups[1].rows[1];
  Object.assign(lb2, { suspect: "down", suspectRounds: 1 });
  assert.match(lineOf(boardText(v, STAMP, PAGE, RU({ peer2: "unreachable" })), "Балансировщик 2"), /—$/);
});

test("прод из России лежит у обеих дверей — RU «нет», а не «—» (замер есть)", () => {
  const cfg = { groups: [{ id: "server", title: "Сервер", kind: "ready", rows: [{ id: "api", name: "API", kind: "http" }, { id: "server", name: "База данных и кэш" }] }] };
  const mesh = { votes: [{ fresh: true, prod: { state: "down", code: "000", ms: null } }, { fresh: true, prod: { state: "down", code: "503", ms: 30 } }], notes: {} };
  const t = boardText(evaluate(cfg, { api: up(), server: { ok: false, status: 503, ms: 30 } }), STAMP, PAGE, mesh);
  assert.match(lineOf(t, "API"), /(нет|код 503)$/);
});

test("непроверенный DNS — «—», а не «нет» (не выглядит отказом)", () => {
  const cfg = { groups: [{ id: "dns", title: "DNS", kind: "dns", rows: [{ id: "d1", name: "DNS 1" }] }] };
  assert.match(lineOf(boardText(evaluate(cfg, {}), STAMP, PAGE), "DNS 1"), /^⚪ DNS 1\s+—\s+—$/);
});

/* ── RU трёх страниц пользователей — из pages.* в голосе (26.10.2026, ztl-lab observer.sh) ── */

const PAGE_CFG = {
  groups: [
    {
      id: "users",
      title: "Для пользователей",
      kind: "http",
      rows: [
        { id: "app", name: "Кабинет лаборатории" },
        { id: "portal", name: "Кабинет заказчика" },
        { id: "site", name: "Сайт" },
      ],
    },
  ],
};
const pageText = (mesh) => boardText(evaluate(PAGE_CFG, { app: up(), portal: up(), site: up() }), STAMP, PAGE, mesh);

test("RU страниц — СРЕДНЕЕ по двум балансировщикам, а не меньшее (в отличие от прода)", () => {
  const mesh = {
    votes: [
      { fresh: true, pages: { lab: { code: "200", ms: 40 }, portal: { code: "200", ms: 70 }, site: { code: "200", ms: 20 } } },
      { fresh: true, pages: { lab: { code: "200", ms: 60 }, portal: { code: "200", ms: 90 }, site: { code: "200", ms: 30 } } },
    ],
    notes: {},
  };
  const t = pageText(mesh);
  assert.match(lineOf(t, "Кабинет лаборатории"), /50 мс$/, "(40+60)/2=50, не меньшее 40");
  assert.match(lineOf(t, "Кабинет заказчика"), /80 мс$/);
  assert.match(lineOf(t, "Сайт"), /25 мс$/);
});

test("RU страниц — один голос с числом: он и есть «среднее» (среднее одного числа — оно само)", () => {
  const mesh = { votes: [{ fresh: true, pages: { lab: { code: "200", ms: 33 } } }], notes: {} };
  assert.match(lineOf(pageText(mesh), "Кабинет лаборатории"), /33 мс$/);
});

test("RU страниц — ни одного голоса с pages → «—», а не «нет»", () => {
  const mesh = { votes: [{ fresh: true, prod: { code: "200", ms: 10 } }, { fresh: true, prod: { code: "200", ms: 12 } }], notes: {} };
  const t = pageText(mesh);
  for (const name of ["Кабинет лаборатории", "Кабинет заказчика", "Сайт"]) assert.match(lineOf(t, name), /—$/);
});

test("RU страниц — обе двери код не 200 → «код …» (как у прода, не «—»)", () => {
  const mesh = {
    votes: [
      { fresh: true, pages: { lab: { code: "502", ms: null } } },
      { fresh: true, pages: { lab: { code: "502", ms: null } } },
    ],
    notes: {},
  };
  assert.match(lineOf(pageText(mesh), "Кабинет лаборатории"), /код 502$/);
});

test("RU страниц — голос с лежащей своей сетью про страницу не говорит (как и про соседа)", () => {
  const mesh = { votes: [{ fresh: true, prod: { state: "unknown", code: "000", ms: null }, pages: { lab: { code: "000", ms: null } } }], notes: {} };
  assert.match(lineOf(pageText(mesh), "Кабинет лаборатории"), /—$/);
});

/* ── шапка флагами не рвёт моноширинные колонки (26.10.2026) ── */

test("шапка-флаги переживают ШИРОКИЙ столбец 🇳🇱 (длинное время ответа) без перекоса", () => {
  // Данные-строки между собой равны (как в «колонки ровные» выше); у шапки — ПОСТОЯННОЕ отличие
  // в 1 кодовую точку от строк-данных (значок у строки — одна графема + пробел = 2, у шапки —
  // литеральные "  " + пробел шаблона = 3; то же отличие было и ДО замены NL/RU на флаги, см.
  // `cellWidth`). Проверяем это отличие ПРИ ШИРОКОМ столбце (12345 мс — несколько разных значений
  // nlW), а не только при коротком «—»: регрессия — подмени счёт ширины флага на `.length` (UTF-16:
  // у флага 4, не 2) — и `padStart` решит, что флаг уже длиннее нужной ширины, недодаст пробелов
  // ровно тогда, когда столбец шире двух знакомест, то есть разница перестанет быть постоянной «1».
  for (const nlMs of [1, 12345, 999999]) {
    const t = text({ app: up(nlMs), lb1: up(1), lb2: up(1) }, RU());
    const lines = pre(t).split("\n");
    const lens = lines.map((l) => [...l].length);
    const [header, ...data] = lens;
    const dataWidths = new Set(data);
    assert.equal(dataWidths.size, 1, `строки-данные разной длины при nlMs=${nlMs}: ${lines.join(" | ")}`);
    assert.equal(header, data[0] + 1, `шапка с флагами не на 1 длиннее строки-данных при nlMs=${nlMs}: ${lines.join(" | ")}`);
  }
});
