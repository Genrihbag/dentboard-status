#!/usr/bin/env node
/**
 * СТРАНИЦА — НАСТОЯЩИМ `render.mjs` на подменной истории, без браузера.
 *
 * 🔴 ЧТО ПРОВЕРЯЕТСЯ (решение владельца 25.10.2026): на странице только «работает / не работает» —
 * ни одного числа у строк (миллисекунды, «база N мс», «ответили N из N», дни сертификата), группы
 * «Сертификат» нет вовсе, и её события не попадают в «Последние события». Числа при этом остаются
 * в `history.json` — их читает точка состояния в кабинетах.
 *
 * ⚠️ У КАЖДОГО «НЕТ» — ПОЛОЖИТЕЛЬНЫЙ КОНТРОЛЬ: числа и сертификат ЕСТЬ во входе, иначе проверка
 * «на странице их нет» была бы пуста по построению.
 *
 * Запуск: `node --test render.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, publicView } from "./layout.mjs";

const RENDER = fileURLToPath(new URL("./render.mjs", import.meta.url));

const HISTORY = {
  layout: 2,
  overall: "up",
  notice: "Резерв частично недоступен — на работу это не влияет.",
  groups: [
    {
      id: "users",
      title: "Для пользователей",
      onPage: true,
      state: "up",
      summary: null,
      rows: [{ id: "app", name: "Кабинет лаборатории", state: "up", word: "работает", value: "236 мс", ms: 236, slow: false }],
    },
    {
      id: "balancers",
      title: "Балансировщики",
      onPage: true,
      state: "warn",
      summary: "Один балансировщик недоступен — вход работает через второй.",
      rows: [
        { id: "lb1", name: "Балансировщик 1", state: "up", word: "работает", value: "1777 мс", ms: 1777, slow: true },
        { id: "lb2", name: "Балансировщик 2", state: "down", word: "не отвечает", value: null, ms: null, slow: false },
      ],
    },
    {
      id: "server",
      title: "Сервер",
      onPage: true,
      state: "up",
      summary: null,
      rows: [
        { id: "api", name: "API", state: "up", word: "работает", value: "180 мс", ms: 180, slow: false },
        { id: "server", name: "База данных и кэш", state: "up", word: "работают", value: "база 3 мс", ms: 240, slow: false },
      ],
    },
    {
      id: "cert",
      title: "Сертификат",
      onPage: false,
      state: "warn",
      summary: "Сертификат скоро истекает — продлеваем.",
      rows: [{ id: "cert", name: "Сертификат", state: "warn", word: "скоро истекает", value: "осталось 10 дней", ms: null, slow: false }],
    },
  ],
  current: { "Кабинет лаборатории": { ok: true, ms: 236 } },
  events: [
    { at: "2026-10-25T18:00:00.000Z", target: "Сертификат", group: "Сертификат", state: "внимание", phrase: "скоро истекает" },
    { at: "2026-10-25T17:00:00.000Z", target: "Балансировщик 2", group: "Балансировщики", state: "упал", phrase: "не отвечает" },
  ],
  updatedAt: "2026-10-25T18:01:00.000Z",
};

function render(history) {
  const dir = mkdtempSync(join(tmpdir(), "status-render-"));
  try {
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "history.json"), JSON.stringify(history));
    // Боевой список целей — как на машине наблюдателя, где `render.mjs` идёт в каталоге репозитория.
    execFileSync(process.execPath, [RENDER], { cwd: dir, stdio: "pipe", env: { ...process.env, STATUS_TARGETS: TARGETS } });
    return readFileSync(join(dir, "index.html"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const TARGETS = fileURLToPath(new URL("./targets.json", import.meta.url));

/**
 * История, записанная ПРЕЖНИМ кодом (до `onPage`): группа сертификата без признака и оговорка про
 * сертификат. Такой файл лежит на машине до первого успешного круга после выката (ревью 25.10.2026).
 */
const OLD = {
  ...HISTORY,
  notice: "Сертификат скоро истекает, продлеваем — на работу это не влияет.",
  groups: HISTORY.groups.map(({ onPage, ...g }) => g),
};

/** Видимая разметка без скрипта и стилей — числа в коде скрипта страницей не являются. */
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

test("положительный контроль: во входе числа и сертификат ЕСТЬ", () => {
  const raw = JSON.stringify(HISTORY);
  assert.match(raw, /236 мс/);
  assert.match(raw, /база 3 мс/);
  assert.match(raw, /осталось 10 дней/);
});

test("на странице нет ни одного числа у строк", () => {
  const page = visible(render(HISTORY));
  assert.doesNotMatch(page, /\d\s*мс/);
  assert.doesNotMatch(page, /осталось|ответили/);
});

test("группы «Сертификат» на странице нет, и её событий в истории тоже нет", () => {
  const page = visible(render(HISTORY));
  assert.doesNotMatch(page, /Сертификат|сертификат/);
  assert.doesNotMatch(page, /data-group="cert"/);
});

test("а слова, группы, фраза под группой и событие балансировщика — на месте", () => {
  const page = visible(render(HISTORY));
  assert.match(page, /вход работает через второй/);
  // Событие свёрнутой группы — от имени группы: «Балансировщик 2» на странице нет (26.10.2026).
  assert.match(page, /<b>Балансировщики<\/b> — один не отвечает/);
  assert.doesNotMatch(page, /Балансировщик 2/);
  assert.match(page, /Резерв частично недоступен/);
});

/* ── свёрнутые группы (26.10.2026): «Балансировщики — 1 из 2 работает» ── */

const rowsOf = (pageHtml, id) => (pageHtml.match(new RegExp(`data-group="${id}"[\\s\\S]*?</section>`)) ?? [""])[0];
const withBalancers = (states) => ({
  ...HISTORY,
  groups: HISTORY.groups.map((g) =>
    g.id !== "balancers"
      ? g
      : { ...g, state: states.every((s) => s === "up") ? "up" : states.every((s) => s === "down") ? "down" : "warn", rows: g.rows.map((r, i) => ({ ...r, state: states[i] })) },
  ),
});

test("балансировщики — ОДНОЙ строкой со счётом: 1 из 2 работает, жёлтым; отдельных строк нет", () => {
  const card = rowsOf(visible(render(withBalancers(["up", "down"]))), "balancers");
  assert.match(card, /Балансировщики/);
  assert.match(card, /1 из 2 работает/);
  assert.match(card, /row-state is-warn/);
  assert.doesNotMatch(card, /Балансировщик 1|Балансировщик 2|data-row=/);
});

test("2 из 2 работают — зелёным; 0 из 2 — «не работают», красным", () => {
  const green = rowsOf(visible(render(withBalancers(["up", "up"]))), "balancers");
  assert.match(green, /2 из 2 работают/);
  assert.match(green, /row-state is-up/);
  const red = rowsOf(visible(render(withBalancers(["down", "down"]))), "balancers");
  assert.match(red, /не работают/);
  assert.match(red, /row-state is-down/);
});

test("ЗДЕСЬ СВОРАЧИВАТЬ НЕ ДОЛЖНО: строки «Для пользователей» и «Сервер» — по одной", () => {
  const page = visible(render(HISTORY));
  assert.match(rowsOf(page, "users"), /data-row="app"/);
  assert.match(rowsOf(page, "server"), /data-row="api"[\s\S]*data-row="server"/);
  assert.match(rowsOf(page, "server"), /API[\s\S]*База данных и кэш/);
});

test("порядок групп на странице — из боевого списка: пользователи, сервер, балансировщики, DNS", () => {
  const config = JSON.parse(readFileSync(TARGETS, "utf8"));
  const ok = { ok: true, status: 200, ms: 100 };
  const ready = { ...ok, body: JSON.stringify({ status: "ok", checks: { postgres: { up: true, latency_ms: 1 }, redis: { up: true, latency_ms: 0 } } }) };
  const dns = { ok: true, wrong: false, answered: 2, total: 2, answers: [] };
  const raw = { app: ok, portal: ok, site: ok, api: ok, server: ready, lb1: ok, lb2: ok, dns1: dns, dns2: dns };
  const view = evaluate(config, raw);
  const page = visible(render({ layout: 2, overall: view.overall, notice: view.notice, groups: publicView(view), current: {}, events: [], updatedAt: "2026-10-26T10:00:00.000Z" }));
  const order = [...page.matchAll(/data-group="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["users", "server", "balancers", "dns"]);
  assert.match(rowsOf(page, "dns"), /2 из 2 работают/);
  assert.match(rowsOf(page, "balancers"), /2 из 2 работают/);
});

test("история ПРЕЖНЕГО кода (без onPage): сертификата на странице всё равно нет — ни карточки, ни события, ни оговорки", () => {
  assert.ok(OLD.groups.every((g) => !("onPage" in g)), "положительный контроль: признака во входе нет");
  const page = visible(render(OLD));
  assert.doesNotMatch(page, /ертификат/);
  assert.doesNotMatch(page, /\d\s*мс/);
  assert.match(page, /Балансировщики/);
});

test("одна строка свёрнутой группы не проверена — счёт «… из 2», а не «1 из 1»", () => {
  const h = withBalancers(["up", "unknown"]);
  assert.match(rowsOf(visible(render(h)), "balancers"), /1 из 2 работает/);
});
