#!/usr/bin/env node
/**
 * ПРЯМОЙ ВОПРОС DNS — образцами и живым сервером имён на 127.0.0.1.
 *
 * ⚠️ ЖИВОЙ СЕРВЕР, А НЕ ПОДСТАВЛЕННЫЙ ОТВЕТ: путь «не те адреса» и «молчит» проходит тот же сокет,
 * тот же разбор и те же повторы, что на боевой машине. Положительный контроль на НАСТОЯЩИХ
 * серверах Selectel и Яндекса сделан 25.10.2026 руками (пакет этого модуля, отправленный с
 * сервера в РФ, разобран этим же модулем: оба адреса, флаг AA) — в набор он не входит, потому что
 * набор не должен зависеть от сети.
 *
 * Запуск: `node --test dns-probe.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { buildQuery, parseResponse, askServer, probeDnsProvider } from "./dns-probe.mjs";

const NAME = "app.dentboard.ru";
const IPS = ["136.234.13.100", "153.51.113.60"];

test("запрос: ровно тот пакет, что получил ответ AA от a.ns.selectel.ru и ns1.yandexcloud.net (25.10.2026)", () => {
  assert.equal(
    buildQuery(NAME, 4242).toString("hex"),
    "109200000001000000000000036170700964656e74626f6172640272750000010001",
  );
});

test("запрос без бита рекурсии (`+norec`)", () => {
  const flags = buildQuery(NAME, 1).readUInt16BE(2);
  assert.equal(flags & 0x0100, 0);
});

/** Ответ сервера имён: заголовок, вопрос, A-записи со сжатой ссылкой на имя. */
function answer(query, ips, { rcode = 0, id } = {}) {
  let off = 12;
  while (query[off] !== 0) off += 1 + query[off];
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id ?? query.readUInt16BE(0), 0);
  head.writeUInt16BE(0x8400 | rcode, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(ips.length, 6);
  const rrs = ips.map((ip) => {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(1, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(300, 6);
    rr.writeUInt16BE(4, 10);
    ip.split(".").forEach((o, i) => (rr[12 + i] = Number(o)));
    return rr;
  });
  return Buffer.concat([head, query.subarray(12, off + 5), ...rrs]);
}

test("разбор ответа: адреса, AA, код", () => {
  const q = buildQuery(NAME, 7);
  const r = parseResponse(answer(q, IPS), 7);
  assert.deepEqual(r.addresses, IPS);
  assert.equal(r.aa, true);
  assert.equal(r.rcode, "NOERROR");
});

test("чужой id — отказ разбора, а не «ответ»", () => {
  const q = buildQuery(NAME, 7);
  assert.throws(() => parseResponse(answer(q, IPS, { id: 8 }), 7), /чужой id/);
});

test("обрезанный пакет — отказ, а не пустой список адресов", () => {
  const q = buildQuery(NAME, 7);
  const full = answer(q, IPS);
  assert.throws(() => parseResponse(full.subarray(0, full.length - 3), 7));
});

/* ── ЖИВОЙ СЕРВЕР ИМЁН НА 127.0.0.1 ─────────────────────────────────────────────────────── */

const servers = [];
async function serve(handler) {
  const s = createSocket("udp4");
  s.on("message", (msg, rinfo) => {
    const out = handler(msg);
    if (out) s.send(out, rinfo.port, rinfo.address);
  });
  await new Promise((r) => s.bind(0, "127.0.0.1", r));
  servers.push(s);
  return `127.0.0.1:${s.address().port}`;
}
after(() => servers.forEach((s) => s.close()));

const right = () => serve((q) => answer(q, IPS));
const lying = () => serve((q) => answer(q, ["109.196.100.86"]));
const half = () => serve((q) => answer(q, [IPS[0]]));
const silent = () => serve(() => null);
const refused = () => serve((q) => answer(q, [], { rcode: 5 }));
const opts = { timeoutMs: 300, attempts: 2 };

test("правильный ответ — ok", async () => {
  const r = await askServer(await right(), NAME, IPS, opts);
  assert.equal(r.ok, true);
});

test("ЗДЕСЬ OK БЫТЬ НЕ ДОЛЖНО: только один из двух адресов", async () => {
  const r = await askServer(await half(), NAME, IPS, opts);
  assert.equal(r.ok, false);
  assert.equal(r.wrong, true);
  assert.match(r.error, /нет 153\.51\.113\.60/);
});

test("чужой адрес — «отдаёт …» с перечнем", async () => {
  const r = await askServer(await lying(), NAME, IPS, opts);
  assert.equal(r.wrong, true);
  assert.match(r.error, /лишний 109\.196\.100\.86/);
});

test("молчание — «не ответил», и это НЕ «неверно»", async () => {
  const r = await askServer(await silent(), NAME, IPS, opts);
  assert.equal(r.ok, false);
  assert.notEqual(r.wrong, true);
  assert.match(r.error, /не ответил/);
});

test("REFUSED — назван кодом", async () => {
  const r = await askServer(await refused(), NAME, IPS, opts);
  assert.match(r.error, /REFUSED/);
});

test("провайдер: молчит один из двух серверов — исправен, но это видно в счёте", async () => {
  const r = await probeDnsProvider([await right(), await silent()], NAME, IPS, opts);
  assert.equal(r.ok, true);
  assert.equal(r.answered, 1);
  assert.equal(r.total, 2);
});

test("ЗДЕСЬ ИСПРАВНОГО БЫТЬ НЕ ДОЛЖНО: один из серверов провайдера врёт, хотя второй прав", async () => {
  const r = await probeDnsProvider([await right(), await lying()], NAME, IPS, opts);
  assert.equal(r.ok, false);
  assert.equal(r.wrong, true);
});

test("провайдер: молчат все — неисправен", async () => {
  const r = await probeDnsProvider([await silent(), await silent()], NAME, IPS, opts);
  assert.equal(r.ok, false);
  assert.equal(r.answered, 0);
});
