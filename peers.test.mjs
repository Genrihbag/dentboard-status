#!/usr/bin/env node
/**
 * СВЕДЕНИЕ ДВУХ ДВЕРЕЙ — правила без сети. У каждого «засчитать» есть парное «здесь НЕ должно»:
 * без него правило «всё работает всегда» прошло бы набор так же, как верное.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayTalk, mergePeer, okOf, peerFresh, pointOf } from "./peers.mjs";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();
const opts = { selfId: "lb1", balancerIds: ["lb1", "lb2"], nowMs: NOW };

test("продукт: не вижу я, видит соседка — работает, решено соседкой", () => {
  const mine = { app: { ok: false, error: "таймаут" } };
  const peer = pointOf("lb2", { app: { ok: true, status: 200, ms: 120 } }, at(30));
  const m = mergePeer(mine, peer, opts);
  assert.equal(m.fresh, true);
  assert.equal(m.raw.app.ok, true);
  assert.equal(m.raw.app.viaPeer, true);
  assert.deepEqual(m.viaPeer, ["app"]);
});

test("ЗДЕСЬ НЕ ДОЛЖНО: не видят обе двери — не работает", () => {
  const m = mergePeer({ app: { ok: false } }, pointOf("lb2", { app: { ok: false } }, at(30)), opts);
  assert.equal(m.raw.app.ok, false);
  assert.deepEqual(m.viaPeer, []);
});

test("ЗДЕСЬ НЕ ДОЛЖНО: вижу я — своё наблюдение не подменяется соседкиным", () => {
  const m = mergePeer({ app: { ok: true, ms: 50 } }, pointOf("lb2", { app: { ok: true, ms: 900 } }, at(30)), opts);
  assert.equal(m.raw.app.ms, 50);
  assert.equal(m.raw.app.viaPeer, undefined);
});

test("о себе судит соседка: я «жива», а соседка меня не видит — не работает", () => {
  const mine = { lb1: { ok: true }, lb2: { ok: true } };
  const peer = pointOf("lb2", { lb1: { ok: false, error: "таймаут" }, lb2: { ok: true } }, at(30));
  const m = mergePeer(mine, peer, opts);
  assert.equal(m.raw.lb1.ok, false);
  assert.equal(m.raw.lb1.viaPeer, true);
});

test("ЗДЕСЬ НЕ ДОЛЖНО: «я жива» соседки не спасает её от моего наблюдения", () => {
  const mine = { lb1: { ok: true }, lb2: { ok: false, error: "таймаут" } };
  const peer = pointOf("lb2", { lb1: { ok: true }, lb2: { ok: true } }, at(30));
  const m = mergePeer(mine, peer, opts);
  assert.equal(m.raw.lb2.ok, false);
});

test("соседка молчит (старые данные, испорченные, нет вовсе) — остаётся своё наблюдение", () => {
  const mine = { app: { ok: false }, lb1: { ok: true } };
  for (const peer of [pointOf("lb2", { app: { ok: true } }, at(600)), null, { at: "мусор", raw: {} }, "строка"]) {
    const m = mergePeer(mine, peer, opts);
    assert.equal(m.fresh, false);
    assert.equal(m.raw.app.ok, false);
    assert.equal(m.raw.lb1.ok, true);
  }
});

test("свежесть: из будущего больше минуты — не свежее", () => {
  assert.equal(peerFresh(pointOf("lb2", {}, at(-120)), NOW), false);
  assert.equal(peerFresh(pointOf("lb2", {}, at(-30)), NOW), true);
});

test("сертификат: удачен, только если удачен по всем дверям", () => {
  assert.equal(okOf({ perDoor: [{ ok: true }, { ok: true }] }), true);
  assert.equal(okOf({ perDoor: [{ ok: true }, { ok: false }] }), false);
  assert.equal(okOf({ perDoor: [] }), false);
});

test("кто шлёт: основная всегда, запасная — только пока основная молчит", () => {
  assert.equal(mayTalk("primary", true), true);
  assert.equal(mayTalk("primary", false), true);
  assert.equal(mayTalk("backup", false), true);
  assert.equal(mayTalk("backup", true), false);
});
