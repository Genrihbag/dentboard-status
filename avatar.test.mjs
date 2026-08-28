#!/usr/bin/env node
/**
 * СВОД СОСТОЯНИЯ И ГИСТЕРЕЗИС — образцами, без сети и без Telegram.
 *
 * 🔴 ЗАЧЕМ ЭТО ВООБЩЕ ПРОВЕРЯТЬ. Гистерезис — механизм, который ПО ЗАМЫСЛУ ничего не делает в
 * большинстве прогонов. Ошибка в нём не видна: авы просто не меняются, и это выглядит как «всё
 * стабильно». Проверить его наблюдением за живым каналом можно, но ждать пришлось бы недели и
 * настоящего отказа — то есть ровно того случая, когда механизм и должен сработать впервые.
 *
 * Запуск: `node --test avatar.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stateOf } from "./avatar.mjs";

const ok = (ms = 200) => ({ ok: true, ms });
const down = () => ({ ok: false, ms: 15000 });

test("все ответили быстро — зелёная", () => {
  assert.equal(stateOf({ a: ok(), b: ok(300) }), "up");
});

test("ОДИН упал из четырёх — ЖЁЛТАЯ, а не красная", () => {
  // Решение владельца: продукт при этом работает, и красная на частную неисправность обесценила
  // бы красную вообще — подписчик перестанет отличать «не работает ничего» от «одно из четырёх».
  assert.equal(stateOf({ a: ok(), b: ok(), c: ok(), d: down() }), "slow");
});

test("упали ВСЕ — красная", () => {
  assert.equal(stateOf({ a: down(), b: down() }), "down");
});

test("ЗДЕСЬ КРАСНОЙ БЫТЬ НЕ ДОЛЖНО: упали все, кроме одной", () => {
  // Парный случай к предыдущему. Без него правило «все упали» прошло бы и у реализации
  // «хотя бы одна упала», то есть у прежнего, отменённого поведения.
  assert.equal(stateOf({ a: down(), b: down(), c: ok() }), "slow");
});

test("медленно отвечают ДВЕ цели — жёлтая", () => {
  assert.equal(stateOf({ a: ok(200), b: ok(9000), c: ok(9000) }, 1500), "slow");
});

test("медленно отвечает ОДНА цель — жёлтой быть НЕ должно", () => {
  /**
   * 🔴 ПАРНЫЙ СЛУЧАЙ, И ОН ЗДЕСЬ ЦЕННЕЕ ПОЛОЖИТЕЛЬНОГО — заведён 29.08.2026 по живой находке
   * владельца: ава стала жёлтой при полностью зелёных сервисах.
   *
   * Замер по журналам прогонов (28 замеров) объяснил почему: медиана 822 мс, а 14 % значений
   * выше прежнего порога 1500. Хвост давал холодный старт ОДНОЙ SSR-страницы — 5783 мс при
   * 700 мс у соседей. Это особенность страницы, а не проблема системы.
   *
   * Прежняя проба утверждала обратное («хотя бы одна медленная — жёлтая») и потому ЗАЩИЩАЛА это
   * поведение: починка правила красила её. Разбор показал, что неправа была проба.
   */
  assert.equal(stateOf({ a: ok(200), b: ok(200), c: ok(9000) }, 1500), "up");
});

test("пустой вход — `unknown`, а не «всё хорошо»", () => {
  // Ноль осмотренных целей и ноль упавших выглядят одинаково только там, где их не различают.
  assert.equal(stateOf({}), "unknown");
});

test("ОДИН прогон аву НЕ меняет — нужно подтверждение", () => {
  const first = decide({ applied: "up", pending: null, streak: 0 }, "down");
  assert.equal(first.change, false);
  assert.equal(first.streak, 1);
});

test("ДВА подряд одинаковых — меняем", () => {
  const first = decide({ applied: "up", pending: null, streak: 0 }, "down");
  const second = decide({ applied: "up", pending: first.pending, streak: first.streak }, "down");
  assert.equal(second.change, true);
  assert.equal(second.next, "down");
});

test("МИГАНИЕ не меняет аву: down → up → down", () => {
  // Ровно то, ради чего гистерезис заведён: смена фото оставляет пост в канале, и мигание одной
  // цели засоряло бы ленту.
  let s = { applied: "up", pending: null, streak: 0 };
  const a = decide(s, "down");
  s = { applied: "up", pending: a.pending, streak: a.streak };
  const b = decide(s, "up"); // вернулось к тому, что на аве
  assert.equal(b.change, false);
  assert.equal(b.streak, 0, "счётчик обязан обнуляться, иначе редкие отклонения накопятся за сутки");
  s = { applied: "up", pending: b.pending, streak: b.streak };
  const c = decide(s, "down"); // снова упало — это ПЕРВОЕ наблюдение, а не второе
  assert.equal(c.change, false);
  assert.equal(c.streak, 1);
});

test("СМЕНА ЦЕЛИ подтверждения сбрасывает счётчик: down → slow", () => {
  let s = { applied: "up", pending: null, streak: 0 };
  const a = decide(s, "down");
  s = { applied: "up", pending: a.pending, streak: a.streak };
  const b = decide(s, "slow");
  assert.equal(b.change, false);
  assert.equal(b.streak, 1, "новое значение считается с единицы, а не наследует чужой счёт");
  assert.equal(b.pending, "slow");
});

test("ПЕРВЫЙ В ЖИЗНИ ПРОГОН ставит аву сразу", () => {
  // Иначе на канале останется кадр, не отвечающий ни одному состоянию, и молчание будет выглядеть
  // как «всё хорошо».
  const d = decide({ applied: null, pending: null, streak: 0 }, "up");
  assert.equal(d.change, true);
  assert.equal(d.next, "up");
});

test("`unknown` аву НЕ трогает", () => {
  // «Мы не смогли посмотреть» — не то же самое, что «стало плохо».
  const d = decide({ applied: "up", pending: null, streak: 0 }, "unknown");
  assert.equal(d.change, false);
  assert.equal(d.next, "up");
});

test("состояние не изменилось — ничего не делаем", () => {
  const d = decide({ applied: "down", pending: null, streak: 0 }, "down");
  assert.equal(d.change, false);
  assert.equal(d.streak, 0);
});
