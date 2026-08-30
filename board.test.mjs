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

const STAMP = "30.08, 03:12";
const PAGE = "https://status.dentboard.ru";
const MIN = 5 * 60_000;
const NOW = Date.parse("2026-08-30T00:12:00Z");
const agoMin = (m) => new Date(NOW - m * 60_000).toISOString();

/* ── ТЕКСТ ───────────────────────────────────────────────────────────────────────────────── */

test("живая цель — галочка и её время ответа", () => {
  const text = boardText({ API: { ok: true, ms: 180 } }, STAMP, PAGE);
  assert.match(text, /✅ API · 180 мс/);
});

test("упавшая цель названа ПРИЧИНОЙ, а не только значком", () => {
  // «Не отвечает» и «отвечает пятисоткой» лечатся по-разному, и человек, открывший канал, решает
  // по этому различию, идти ли ему работать.
  const nothing = boardText({ API: { ok: false, ms: 15000, status: 0 } }, STAMP, PAGE);
  const five = boardText({ API: { ok: false, ms: 300, status: 502 } }, STAMP, PAGE);
  assert.match(nothing, /🔴 API · не отвечает/);
  assert.match(five, /🔴 API · код 502/);
});

test("медленная цель — 🟡; а быстрая НЕ 🟡", () => {
  // Парный отрицательный случай: без него правило «рисовать 🟡» прошло бы и в варианте «рисовать
  // 🟡 всегда», и табло стало бы жёлтым при полностью исправной системе.
  const slow = boardText({ API: { ok: true, ms: 9000 } }, STAMP, PAGE);
  const fast = boardText({ API: { ok: true, ms: 200 } }, STAMP, PAGE);
  assert.match(slow, /🟡 API/);
  assert.doesNotMatch(fast, /🟡/);
});

test("время проверки стои́т в тексте — иначе замёрзшее табло выглядит здоровым", () => {
  const text = boardText({ API: { ok: true, ms: 180 } }, STAMP, PAGE);
  assert.match(text, new RegExp(`Проверено ${STAMP.replace(/[.,]/g, "\\$&")} МСК`));
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
