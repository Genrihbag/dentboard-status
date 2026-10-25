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
      title: "Сервер и база",
      onPage: true,
      state: "up",
      summary: null,
      rows: [{ id: "server", name: "Сервер и база", state: "up", word: "работают", value: "база 3 мс", ms: 240, slow: false }],
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
  assert.match(page, /Балансировщик 2/);
  assert.match(page, /не отвечает/);
  assert.match(page, /Работает частично/);
  assert.match(page, /вход работает через второй/);
  assert.match(page, /<b>Балансировщик 2<\/b> не отвечает/);
  assert.match(page, /Резерв частично недоступен/);
});

test("история ПРЕЖНЕГО кода (без onPage): сертификата на странице всё равно нет — ни карточки, ни события, ни оговорки", () => {
  assert.ok(OLD.groups.every((g) => !("onPage" in g)), "положительный контроль: признака во входе нет");
  const page = visible(render(OLD));
  assert.doesNotMatch(page, /ертификат/);
  assert.doesNotMatch(page, /\d\s*мс/);
  assert.match(page, /Балансировщик 2/);
});
