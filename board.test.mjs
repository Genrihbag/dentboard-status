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
import { boardText, decideBoard } from "./board.mjs";
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

test("живая цель — галочка и её время ответа", () => {
  assert.match(text({ app: up(180), lb1: up(), lb2: up() }), /✅ Кабинет лаборатории · 180 мс/);
});

test("упавшая цель названа ПРИЧИНОЙ, а не только значком", () => {
  // «Не отвечает» и «отвечает пятисоткой» лечатся по-разному, и человек, открывший канал, решает
  // по этому различию, идти ли ему работать.
  const nothing = text({ app: { ok: false, status: 0, ms: 15000, error: "This operation was aborted (TimeoutError)" }, lb1: up(), lb2: up() });
  const five = text({ app: { ok: false, status: 502, ms: 300 }, lb1: up(), lb2: up() });
  assert.match(nothing, /🔴 Кабинет лаборатории · не отвечает — This operation was aborted/);
  assert.match(five, /🔴 Кабинет лаборатории · не работает — код 502/);
});

test("медленная цель — 🟡; а быстрая НЕ 🟡", () => {
  // Парный отрицательный случай: без него правило «рисовать 🟡» прошло бы и в варианте «рисовать
  // 🟡 всегда», и табло стало бы жёлтым при полностью исправной системе.
  assert.match(text({ app: up(9000), lb1: up(), lb2: up() }), /🟡 Кабинет лаборатории/);
  assert.doesNotMatch(text({ app: up(200), lb1: up(), lb2: up() }), /🟡/);
});

test("время проверки стои́т в тексте — иначе замёрзшее табло выглядит здоровым", () => {
  assert.match(text({ app: up(), lb1: up(), lb2: up() }), new RegExp(`Проверено ${STAMP.replace(/[.,]/g, "\$&")} МСК`));
});

test("в табло — группы, провайдер и адрес балансировщика, и фраза «вход работает через второй»", () => {
  // Канал читает владелец: ему нужно «кто есть кто», которого на публичной странице нет намеренно.
  const t = text({ app: up(), lb1: up(120), lb2: { ok: false, status: 0, ms: 15000, error: "connect ETIMEDOUT" } });
  assert.match(t, /<b>Балансировщики<\/b>/);
  assert.match(t, /✅ Балансировщик 1 \(Selectel, СПб, 136\.234\.13\.100\) · 120 мс/);
  assert.match(t, /🔴 Балансировщик 2 \(Yandex Cloud, 153\.51\.113\.60\) · не отвечает — connect ETIMEDOUT/);
  assert.match(t, /Один балансировщик недоступен — вход работает через второй\./);
});

test("ЗДЕСЬ ФРАЗЫ О ЗАПАСЕ БЫТЬ НЕ ДОЛЖНО: оба балансировщика живы", () => {
  assert.doesNotMatch(text({ app: up(), lb1: up(), lb2: up() }), /через второй/);
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
