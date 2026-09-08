#!/usr/bin/env node
/**
 * РАЗБОР ПРИЧИНЫ ОТКАЗА — образцами и ОДНИМ НАСТОЯЩИМ СБОЕМ.
 *
 * 🔴 ЗАЧЕМ ЭТО ПРОВЕРЯТЬ. Механизм исполняется ТОЛЬКО при отказе, то есть в те минуты, ради
 * которых весь монитор и существует. Зелёный круг проверки о нём не говорит ничего — он его не
 * выполнял. Ошибка здесь нашлась бы в час настоящей аварии, когда читать вывод уже поздно.
 *
 * ⚠️ ПЕРВЫЙ ОБРАЗЕЦ — ЖИВОЙ, а не сочинённый. Тест, сам придумавший «ошибку, которую вернул бы
 * fetch», проверяет СВОЮ гипотезу о форме ошибки, а не форму ошибки; ровно из-за неверной гипотезы
 * («причина лежит в message») поле `error` и было бесполезным. Поэтому отказ вызывается
 * по-настоящему — соединением на закрытый порт локальной петли. Сети наружу для этого не нужно.
 *
 * Запуск: `node --test error-detail.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { describeError } from "./error-detail.mjs";

/**
 * Заведомо закрытый порт: поднимаем слушателя на случайном свободном, узнаём номер и гасим.
 *
 * ⚠️ ПЕРВАЯ РЕДАКЦИЯ БРАЛА ПОРТ 1 — и образец покраснел с «fetch failed ← bad port»: единица
 * входит в список запрещённых портов, и до соединения дело не доходит вовсе. То есть гипотеза
 * «порт 1 закрыт, значит получим ECONNREFUSED» была неверна, и поймал это ровно живой отказ,
 * ради которого он здесь и стои́т. Сочинённая ошибка прошла бы.
 */
function freeClosedPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("ЖИВОЙ ОТКАЗ: закрытый порт — причина названа, а не «fetch failed»", async () => {
  const port = await freeClosedPort();
  let caught;
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) });
    assert.fail("соединение на закрытый порт удалось — образец негоден");
  } catch (e) {
    caught = e;
  }

  // ПАРНЫЙ КОНТРОЛЬ, и он же — предъявление дефекта: прежний способ давал ровно эту строку и
  // ничего больше. Без него «стало лучше» осталось бы утверждением.
  assert.equal(caught.message, "fetch failed");

  const detail = describeError(caught);
  assert.match(detail, /ECONNREFUSED/);
  assert.notEqual(detail, "fetch failed");
});

test("цепочка cause разворачивается от внешнего к внутреннему", () => {
  const inner = new Error("connect ETIMEDOUT 1.2.3.4:443");
  inner.code = "UND_ERR_CONNECT_TIMEOUT";
  const outer = new TypeError("fetch failed", { cause: inner });

  assert.equal(
    describeError(outer),
    "fetch failed ← connect ETIMEDOUT 1.2.3.4:443 (UND_ERR_CONNECT_TIMEOUT)",
  );
});

test("AggregateError: у имени несколько адресов — берём первый отказ", () => {
  const first = new Error("connect ECONNREFUSED 127.0.0.1:443");
  first.code = "ECONNREFUSED";
  const second = new Error("connect ECONNREFUSED ::1:443");
  const aggregate = new AggregateError([first, second], "все попытки провалились");
  const outer = new TypeError("fetch failed", { cause: aggregate });

  const detail = describeError(outer);
  assert.match(detail, /ECONNREFUSED/);
  assert.match(detail, /все попытки провалились/);
});

test("таймаут ответа отличим от отказа соединения", () => {
  // Так `AbortSignal.timeout` сообщает о превышении: имя несёт смысл, сообщение — нет.
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const detail = describeError(timeout);

  assert.match(detail, /timeout/i);
  assert.doesNotMatch(detail, /ECONNREFUSED/);
});

test("ПЕТЛЯ В cause не вешает разбор", () => {
  const a = new Error("внешняя");
  const b = new Error("внутренняя", { cause: a });
  a.cause = b;

  const detail = describeError(a);
  assert.match(detail, /внешняя/);
  assert.match(detail, /внутренняя/);
});

test("не-Error значение не роняет разбор", () => {
  assert.equal(describeError("строка вместо ошибки"), "строка вместо ошибки");
  assert.equal(describeError(undefined), "undefined");
});

// ⚠️ ПАРНЫЙ СЛУЧАЙ «ЗДЕСЬ НЕ ДОЛЖНО СРАБОТАТЬ»: разбор не выдумывает подробностей там, где их нет.
// Без него правило «дописывать что-нибудь всегда» тоже прошло бы все образцы выше.
test("ошибка без cause и без кода печатается как есть", () => {
  assert.equal(describeError(new Error("просто ошибка")), "просто ошибка");
});
