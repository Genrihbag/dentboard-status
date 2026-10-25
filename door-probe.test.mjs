#!/usr/bin/env node
/**
 * БАЛАНСИРОВЩИК ПО АДРЕСУ — пути отказа и расчёт срока, без сети.
 *
 * ⚠️ ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ: успешного чтения сертификата. Для него нужен свой TLS-сервер с
 * сертификатом, то есть закрытый ключ в публичном репозитории или `openssl` в наборе. Этот путь
 * проверен живьём 25.10.2026 — на обоих боевых балансировщиках (89 дней, до 23.01.2027) и в
 * подменном круге с сертификатами на 90, 10 и 2 дня от своего удостоверяющего центра
 * (README, «Проверка путей отказа»).
 *
 * Запуск: `node --test door-probe.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { daysLeft, getVia, readCert } from "./door-probe.mjs";

const DAY = 86_400_000;

test("срок: полные сутки, вниз", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(daysLeft(new Date(now + 10 * DAY - 1).toISOString(), now), 9);
  assert.equal(daysLeft(new Date(now + 10 * DAY).toISOString(), now), 10);
  assert.equal(daysLeft(new Date(now - 1).toISOString(), now), -1, "истёкший — отрицательный, а не ноль");
});

test("срок: неразобранная дата — null, а не «сегодня»", () => {
  assert.equal(daysLeft("не дата"), null);
});

/** Свободный порт, на котором никто не слушает: занять и отпустить. */
async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test("закрытый порт: запрос — отказ с кодом сети, а не зависание", async () => {
  const port = await closedPort();
  await assert.rejects(getVia("127.0.0.1", "app.dentboard.ru", "/api/v1/health/ready", { port, signal: AbortSignal.timeout(3000) }), /ECONNREFUSED/);
});

test("закрытый порт: сертификат — ok:false с причиной", async () => {
  const port = await closedPort();
  const r = await readCert("127.0.0.1", "app.dentboard.ru", { port, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test("молчащий сервер (принял соединение, TLS не начал) — отказ по таймауту, а не вечное ожидание", async () => {
  // Авария 23.10.2026: TCP принимается, ответа нет. Ровно этот случай раньше вешал круг.
  const s = createServer(() => {});
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  try {
    const r = await readCert("127.0.0.1", "app.dentboard.ru", { port, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.match(r.error, /не ответил за 300 мс/);
  } finally {
    s.close();
  }
});
