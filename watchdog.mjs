#!/usr/bin/env node
/**
 * СТОРОЖ НАБЛЮДАТЕЛЯ: жив ли тот, кто следит за сервисами.
 *
 * 🔴 ЗАЧЕМ ОН НУЖЕН, КОГДА ПРОВЕРКА ПЕРЕЕХАЛА НА СВОЮ МАШИНУ. Пока проверку гоняли машины GitHub,
 * за её живость отвечал GitHub — бесплатно и незаметно. Перенеся наблюдение к себе, мы получили
 * вопрос, которого раньше не было: **кто заметит, что замолчал наблюдатель**. А замолчит он тихо:
 * упавший таймер, кончившийся диск, снесённый по ошибке юнит — всё это выглядит одинаково,
 * то есть НИКАК. Страница просто перестаёт обновляться, и это замечает человек через день.
 *
 * Отсюда разделение обязанностей после переезда:
 *   · отдельная машина — ПРОВЕРЯЕТ сервисы (раз в минуту, честным таймером);
 *   · GitHub — проверяет, что ПЕРВЫЙ ЖИВ, и больше ничего.
 *
 * ⚠️ ПРИЗНАК ЖИВОСТИ — СВЕЖЕСТЬ ОТМЕТКИ, А НЕ ФАКТ СУЩЕСТВОВАНИЯ ФАЙЛА. Файл лежит в репозитории
 * всегда; вопрос не «есть ли он», а «двигалась ли в нём дата». Это то же требование, что к любому
 * флагу: нужна не выставленность, а свидетельство исполнения пути.
 *
 * ⚠️ И СТОРОЖ ВСЕГДА ЖАЛУЕТСЯ КОНКРЕТНО. «Монитор молчит» — половина ответа; вторая половина в том,
 * лежат ли при этом сами сервисы. Поэтому обнаружив молчание, он проверяет одну цель сам: тогда в
 * сообщении будет «молчит наблюдатель, сервисы отвечают» либо «молчит наблюдатель, и сайт тоже» —
 * а это два разных телефонных звонка среди ночи.
 */
import { readFileSync } from "node:fs";

/**
 * Сколько отметке позволено не двигаться. Наблюдатель пишет при смене состояния либо раз в
 * 15 минут, значит 40 — это два пропущенных срока подряд плюс запас на задержку самого сторожа.
 * Порог не «с потолка»: меньше — и сторож будет кричать на обычную задержку публикации, а тревога,
 * регулярно ложная, обучает себя игнорировать.
 */
const STALE_MINUTES = Number(process.env.STALE_MINUTES ?? 40);
const HISTORY = "data/history.json";
const PROBE_URL = process.env.PROBE_URL ?? "https://dentboard.ru";

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log("телеграм не настроен — сообщение не отправлено");
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.ok) return true;
  console.log(`телеграм: ОТКАЗ ${res.status} — ${body.description ?? "ответ не разобран"}`);
  return false;
}

/** Отвечает ли хоть что-то из наблюдаемого — чтобы отличить «молчит сторож» от «лежит всё». */
async function servicesAlive() {
  try {
    const res = await fetch(PROBE_URL, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return res.status < 400 || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

let updatedAt = null;
try {
  updatedAt = JSON.parse(readFileSync(HISTORY, "utf8")).updatedAt ?? null;
} catch {
  // Нечитаемый файл — это тоже молчание, и притом худшее: наблюдатель не просто отстал, а испортил
  // то, что писал. Молчаливый выход здесь выглядел бы как «всё в порядке».
  console.log(`${HISTORY} не читается или не разобрался`);
}

const ageMin = updatedAt ? Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000) : null;
console.log(`последняя отметка: ${updatedAt ?? "нет"} (возраст ${ageMin ?? "неизвестен"} мин, порог ${STALE_MINUTES})`);

// ⚠️ «ВОЗРАСТ НЕИЗВЕСТЕН» — ЭТО ТРЕВОГА, А НЕ ПРОПУСК. Ноль и «не знаем» читаются одинаково только
// там, где их не различают; здесь различаем, потому что тревога на них ведёт себя противоположно.
if (ageMin !== null && ageMin <= STALE_MINUTES) {
  console.log("наблюдатель жив — тревоги нет");
  process.exit(0);
}

const alive = await servicesAlive();
const stamp = new Date().toLocaleString("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

await telegram(
  `⚠️ <b>Монитор молчит</b>\n${stamp} МСК\n` +
    `Последняя проверка ${ageMin === null ? "не читается" : `${ageMin} мин назад`}.\n` +
    (alive ? "Сайт при этом отвечает — похоже, дело в самом мониторе." : "Сайт тоже не отвечает.") +
    "\n<a href=\"https://status.dentboard.ru\">Страница состояния</a>",
);

// Отказ задания, а не тихая запись в журнал: сторож, о срабатывании которого можно не узнать,
// заводится зря.
console.error(`::error::наблюдатель молчит ${ageMin ?? "?"} мин при пороге ${STALE_MINUTES}`);
process.exit(1);
