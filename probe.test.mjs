#!/usr/bin/env node
/**
 * ОПРОС ЦЕЛЕЙ — проверка НАСТОЯЩИМ ЗАВИСАНИЕМ, а не подставленной ошибкой.
 *
 * 🔴 ЗАЧЕМ. 23.10.2026 наблюдатель замолчал на три часа ровно в аварию: сервер принимал соединение
 * и не отвечал, круг складывал таймауты целей и погибал от systemd до записи результата (разбор —
 * `budget.mjs`). Быстрый отказ (закрытый порт) этот дефект не показывает — круг на нём укладывается
 * в любые пределы. Поэтому образец здесь — слушатель, который ПРИНИМАЕТ соединение и МОЛЧИТ: ровно
 * то, что делал боевой сервер с вставшим диском.
 *
 * ⚠️ ПРЕДЕЛЫ В ОБРАЗЦАХ УМЕНЬШЕНЫ (секунды вместо десятков) — ради скорости набора. Проверяется
 * свойство «круг не дольше предела при любом числе зависших целей», а оно от масштаба не зависит.
 *
 * Запуск: `node --test probe.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { probeAll } from "./probe.mjs";
import { remainingMs, signalWithin, ROUND_BUDGET_MS, MIN_START_MS, RoundBudgetExhausted } from "./budget.mjs";

const sockets = new Set();
const servers = [];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    servers.push(server);
  });
}

/** Принимает соединение и не отвечает НИЧЕГО — как nginx, ждущий мёртвый диск. */
async function hungServer() {
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  return listen(server);
}

async function liveServer() {
  return listen(createHttpServer((_, res) => res.writeHead(200).end("ok")));
}

after(() => {
  for (const s of sockets) s.destroy();
  for (const s of servers) s.close();
});

const BUDGET = 2_000;
const ATTEMPT = 800;
/** Запас на планировщик событий и создание соединений; заметно меньше одной лишней попытки. */
const SLACK = 600;

test("ЖИВОЕ ЗАВИСАНИЕ: пять молчащих целей укладываются в предел круга, а не в сумму таймаутов", async () => {
  const hung = await hungServer();
  const targets = Array.from({ length: 5 }, (_, i) => ({
    name: `молчит-${i}`,
    url: `http://127.0.0.1:${hung}/`,
    expect: 200,
  }));

  const startedAt = Date.now();
  const results = await probeAll(targets, { budgetMs: BUDGET, attemptTimeoutMs: ATTEMPT });
  const elapsed = Date.now() - startedAt;

  // По очереди это было бы 5 × 3 × 800 = 12 с — ровно дефект 23.10 в масштабе образца.
  assert.ok(elapsed < BUDGET + SLACK, `круг занял ${elapsed} мс при пределе ${BUDGET}`);
  assert.equal(results.length, targets.length);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    // Зависание обязано называться таймаутом: «сервер молчит» и «порт закрыт» лечатся по-разному.
    assert.match(r.error, /timeout/i);
    assert.ok(r.attempts >= 1 && r.attempts <= 3, `попыток ${r.attempts}`);
  }
});

// ⚠️ ПАРНЫЙ СЛУЧАЙ «ЗДЕСЬ НЕ ДОЛЖНО СРАБОТАТЬ»: живая цель среди зависших — зелёная и быстрая.
// Без него «всё красное за предел» тоже прошло бы образец выше.
test("живая цель среди зависших отвечает сразу и считается живой", async () => {
  const hung = await hungServer();
  const live = await liveServer();
  const targets = [
    { name: "молчит", url: `http://127.0.0.1:${hung}/`, expect: 200 },
    { name: "жива", url: `http://127.0.0.1:${live}/`, expect: 200 },
    { name: "молчит-2", url: `http://127.0.0.1:${hung}/`, expect: 200 },
  ];

  const [a, b, c] = await probeAll(targets, { budgetMs: BUDGET, attemptTimeoutMs: ATTEMPT });

  assert.equal(b.ok, true);
  assert.equal(b.status, 200);
  assert.equal(b.attempts, 1);
  assert.ok(b.ms < ATTEMPT, `живая цель ответила за ${b.ms} мс — её задержали соседи`);
  assert.equal(a.ok, false);
  assert.equal(c.ok, false);
});

test("попытка не переживает предел: последняя обрывается на нём, новая после него не начинается", async () => {
  const hung = await hungServer();
  // Попытка дольше предела: без обрезки по остатку единственная попытка длилась бы 5 с.
  const startedAt = Date.now();
  const [r] = await probeAll([{ name: "молчит", url: `http://127.0.0.1:${hung}/`, expect: 200 }], {
    budgetMs: 1_000,
    attemptTimeoutMs: 5_000,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.ok(elapsed < 1_000 + SLACK, `круг занял ${elapsed} мс при пределе 1000`);
});

test("исчерпанный предел: «не опрошена» отличимо от «не ответила»", async () => {
  const [r] = await probeAll([{ name: "любая", url: "http://127.0.0.1:9/", expect: 200 }], { budgetMs: 0 });

  assert.equal(r.ok, false);
  assert.equal(r.attempts, 0);
  assert.match(r.error, /не опрошена/);
});

test("исчерпанный круг: запрос в Telegram не начинается, отказ назван отдельным именем", () => {
  const late = Date.now() + ROUND_BUDGET_MS + 1_000;
  assert.ok(remainingMs(late) < 0);

  assert.throws(() => signalWithin(60_000, late), (e) => e instanceof RoundBudgetExhausted && /предел/.test(e.message));
  // Остаток меньше порога — тоже не начинаем: обрыв через миллисекунды не успел бы за отправкой.
  const almost = Date.now() + ROUND_BUDGET_MS - (MIN_START_MS - 100);
  assert.throws(() => signalWithin(60_000, almost), RoundBudgetExhausted);
});

// ⚠️ ПАРНЫЙ СЛУЧАЙ: в начале круга сигнал выдаётся и не срабатывает раньше своего предела.
test("в начале круга сигнал Telegram выдаётся и не обрывает запрос раньше времени", async () => {
  const signal = signalWithin(5_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signal.aborted, false);
});
