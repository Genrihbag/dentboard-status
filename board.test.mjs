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
const text = (raw) => boardText(evaluate(CONFIG, raw, { slowMs: 1500 }), STAMP, PAGE);
const pre = (t) => (t.match(/<pre>([\s\S]*?)<\/pre>/) ?? [null, ""])[1];
const lineOf = (t, name) => pre(t).split("\n").find((l) => l.includes(name)) ?? "";

test("табло — таблица в <pre> БЕЗ шапки: по строке на цель, одна колонка задержки (01.11.2026)", () => {
  const t = text({ app: up(180), lb1: up(120), lb2: up(130) });
  assert.match(t, /^<b>DentBoard — состояние<\/b>\nПроверено 30\.08, 03:12 МСК/);
  const lines = pre(t).split("\n");
  assert.equal(lines.length, 3, "строк ровно столько, сколько целей — шапки нет");
  assert.doesNotMatch(pre(t), /Цель|🇳🇱|🇷🇺|\bNL\b|\bRU\b/, "ни шапки, ни флагов, ни букв");
  assert.match(lineOf(t, "Кабинет лаборатории"), /^✅ Кабинет лаборатории\s+180 мс$/);
  assert.match(lineOf(t, "Балансировщик 1"), /^✅ Балансировщик 1\s+120 мс$/);
  assert.match(lineOf(t, "Балансировщик 2"), /^✅ Балансировщик 2\s+130 мс$/);
});

test("колонки ровные: длина строк таблицы одинакова при коротком и длинном значении", () => {
  for (const ms of [1, 12345, 999999]) {
    const lines = pre(text({ app: up(5), lb1: up(ms), lb2: { ok: false, status: 502, ms: 1 } })).split("\n");
    const lens = new Set(lines.map((l) => [...l].length));
    assert.equal(lens.size, 1, `разная длина строк при ${ms}: ${lines.join(" | ")}`);
  }
});

test("в табло НЕТ провайдеров и адресов — они в событийных сообщениях", () => {
  const t = text({ app: up(), lb1: up(), lb2: { ok: false, status: 0, ms: 15000, error: "connect ETIMEDOUT 153.51.113.60:443" } });
  for (const leak of ["Selectel", "Yandex", "СПб", "136.234", "153.51", "ETIMEDOUT"]) assert.ok(!t.includes(leak), `в табло «${leak}»`);
});

test("отказ — словом: «нет» без ответа, «код 502» с ответом; значок 🔴", () => {
  assert.match(lineOf(text({ app: { ok: false, status: 0, ms: 15000, error: "x" }, lb1: up(), lb2: up() }), "Кабинет лаборатории"), /^🔴 .*\sнет$/);
  assert.match(lineOf(text({ app: { ok: false, status: 502, ms: 30 }, lb1: up(), lb2: up() }), "Кабинет лаборатории"), /^🔴 .*\sкод 502$/);
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
  const t = text({ app: up(), lb1: up(120), lb2: { ok: false, status: 0, ms: 15000, error: "x" } });
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
  assert.ok(text({ app: up(), lb1: up(), lb2: up() }).length < 1500);
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


test("непроверенный DNS — «—», а не «нет» (не выглядит отказом)", () => {
  const cfg = { groups: [{ id: "dns", title: "DNS", kind: "dns", rows: [{ id: "d1", name: "DNS 1" }] }] };
  assert.match(lineOf(boardText(evaluate(cfg, {}), STAMP, PAGE), "DNS 1"), /^⚪ DNS 1\s+—$/);
});
