#!/usr/bin/env node
/**
 * ТАБЛО В КАНАЛЕ — ОДНО ЗАКРЕПЛЁННОЕ СООБЩЕНИЕ, КОТОРОЕ ПРАВИТСЯ, А НЕ ШЛЁТСЯ ЗАНОВО.
 *
 * 🔴 ЗАЧЕМ. Сообщения уходят только при СМЕНЕ состояния, поэтому в спокойную неделю канал молчит —
 * и «всё работает» неотличимо от «бота выгнали из канала». Табло отвечает на вопрос «как сейчас»
 * без единого нового поста: подписчик открывает канал, видит закреплённое и всё понимает.
 *
 * ⚠️ ПРАВКА НЕ УВЕДОМЛЯЕТ И НЕ СНИМАЕТ ЗАКРЕПЛЕНИЕ — на этом всё и держится. Слать состояние
 * новыми сообщениями раз в пять минут значило бы 288 постов в сутки, то есть превратить канал в
 * шум; а шум учит пролистывать, и первым пролистают настоящий сбой.
 *
 * ⚠️ СРОКА ГОДНОСТИ У ПРАВКИ СВОЕГО СООБЩЕНИЯ НЕТ (48 часов в Bot API — это про УДАЛЕНИЕ и про
 * правку ЧУЖИХ сообщений). Но на это утверждение здесь ничего не опирается, и это сознательно:
 * если правка однажды не пройдёт — по любой причине, включая неизвестную, — путь отказа отправит
 * новое табло, закрепит его и запомнит новый номер. То есть цена ошибки в моём знании про Telegram
 * равна одному лишнему посту, а не молчащему механизму.
 *
 * ⚠️ ПОВТОРНАЯ ПРАВКА ТЕМ ЖЕ ТЕКСТОМ — ОТКАЗ `message is not modified`, и он НЕ считается
 * неудачей: делать нечего, значит всё в порядке. Считай мы его отказом — на каждом круге
 * отправлялось бы новое табло, и лечение оказалось бы хуже болезни.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { SLOW_MS } from "./avatar.mjs";

/** Рядом с историей и решением по аве: одно место для состояния наблюдателя. */
const STATE = "data/board.json";

/**
 * Как часто править табло, когда НИЧЕГО не менялось.
 *
 * 🔴 ПЯТЬ МИНУТ, А НЕ КРУГ (круг — минута). Пинги на закреплённом сообщении поминутно никто не
 * читает: для этого есть страница, которая обновляет числа сама раз в 30 с. Разница 288 правок в
 * сутки против 1440 — это разница между «незаметно» и «заметно в любой статистике злоупотреблений»
 * на чужом сервисе, за пользу, которой нет.
 *
 * ⚠️ СМЕНА СОСТОЯНИЯ ЭТОТ ИНТЕРВАЛ НЕ ЖДЁТ. Падение и подъём правят табло немедленно, тем же
 * кругом: задержка нужна ради тишины, а не ради экономии, и на событии она была бы вредом.
 */
export const MIN_INTERVAL_MS = Number(process.env.STATUS_BOARD_MIN_MINUTES ?? 5) * 60_000;

/**
 * СОБРАТЬ ТЕКСТ ТАБЛО. Чистая функция — проверяется образцами, без сети.
 *
 * ⚠️ ВРЕМЯ ПРОВЕРКИ СТОИТ ВТОРОЙ СТРОКОЙ, И ЭТО НЕ УКРАШЕНИЕ. Замёрзшее табло выглядит как
 * здоровое: наблюдатель умер, последние значения остались зелёными, читатель видит «всё хорошо».
 * Единственное, что отличает живое от мёртвого, — отметка времени, и она обязана быть на виду, а
 * не подразумеваться. Сторож в GitHub эту дыру закрывает со своей стороны, но человек, глядящий на
 * закреплённое сообщение, о существовании сторожа не думает.
 *
 * 🟡 у цели, которая ОТВЕТИЛА, но медленно. Порог берётся из `avatar.mjs` — тот же, что решает
 * цвет авы: «что считать медленным» обязано жить в одном месте, иначе табло и ава однажды скажут
 * разное об одном и том же прогоне, и правым будет выглядеть тот, на кого смотрят.
 */
export function boardText(results, stamp, statusPage, slowMs = SLOW_MS) {
  const rows = Object.entries(results).map(([name, r]) => {
    if (!r.ok) {
      // Причина, а не только значок: «не отвечает» и «отвечает пятисоткой» лечатся по-разному, а
      // человек, открывший канал, решает, идти ли ему работать.
      const why = r.status ? `код ${r.status}` : "не отвечает";
      return `🔴 ${name} · ${why}`;
    }
    const slow = typeof r.ms === "number" && r.ms > slowMs;
    return `${slow ? "🟡" : "✅"} ${name} · ${r.ms} мс`;
  });

  return [
    "<b>DentBoard — состояние</b>",
    `Проверено ${stamp} МСК`,
    "",
    ...rows,
    "",
    `<a href="${statusPage}">Подробности и история</a>`,
  ].join("\n");
}

/**
 * ПРАВИТЬ ЛИ СЕЙЧАС. Тоже чистая функция, и это главное в файле: расписание правок проверяется
 * образцами, а не наблюдением за живым каналом полдня.
 *
 * Возвращает `{ act, why }` — «править» и «рано» обязаны быть разными ЗНАЧЕНИЯМИ, а не разной
 * интонацией лога.
 */
export function decideBoard({ changed, lastEditedAt, now, lastText, nextText, minIntervalMs = MIN_INTERVAL_MS }) {
  // Побайтно тот же текст Telegram отвергает (`message is not modified`). Спрашивать его об этом
  // незачем — ответ известен здесь, бесплатно и без сети.
  if (lastText !== undefined && lastText === nextText) return { act: "skip", why: "текст не изменился" };
  // Событие важнее расписания: падение и подъём правят табло тем же кругом.
  if (changed) return { act: "edit", why: "сменилось состояние" };
  // Первого табла ещё нет — ставим сразу, иначе канал молчит до первого события, то есть ровно до
  // того случая, ради которого табло и заводили.
  if (!lastEditedAt) return { act: "edit", why: "табло ещё не ставили" };

  const age = now - new Date(lastEditedAt).getTime();
  // Битая отметка (`NaN`) — не повод молчать вечно: правим и тем самым чиним состояние.
  if (!Number.isFinite(age)) return { act: "edit", why: "отметка времени не разобралась" };
  if (age >= minIntervalMs) return { act: "edit", why: `прошло ${Math.round(age / 60_000)} мин` };
  return { act: "skip", why: `с прошлой правки ${Math.round(age / 60_000)} мин из ${Math.round(minIntervalMs / 60_000)}` };
}

/** Прочитать номер закреплённого сообщения. Отсутствие файла — законное «ещё не ставили». */
export function loadBoard() {
  if (!existsSync(STATE)) return { messageId: null, text: undefined, editedAt: null };
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    // Битый файл — не повод падать и не повод молчать: потеряв номер, мы отправим новое табло, и
    // это надо ВИДЕТЬ, иначе в канале молча заведётся второе.
    console.warn(`[табло] ${STATE} не разобрался — считаю, что табла ещё нет`);
    return { messageId: null, text: undefined, editedAt: null };
  }
}

function saveBoard(state) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

async function api(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: Boolean(body.ok), body, status: res.status };
}

/**
 * Отправить новое табло и закрепить его.
 *
 * ⚠️ ЗАКРЕПЛЕНИЕ — ОТДЕЛЬНОЕ ПРАВО БОТА, и его отсутствие не должно ронять табло: сообщение уже в
 * канале и уже полезно. Но отказ обязан быть НАЗВАН словами Telegram — «нет права закреплять» и
 * «бот не админ» лечатся по-разному, а «не получилось» не лечится никак.
 *
 * `disable_notification` — чтобы закрепление не звенело у подписчиков.
 */
async function sendAndPin(token, chat, text) {
  const sent = await api(token, "sendMessage", {
    chat_id: chat,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    disable_notification: true,
  });
  if (!sent.ok) {
    console.error(`[табло] отправить не удалось: ${sent.body.description ?? sent.status}`);
    return null;
  }
  const id = sent.body.result?.message_id ?? null;
  if (!id) {
    console.error("[табло] Telegram принял сообщение, но не вернул message_id — закрепить нечего");
    return null;
  }
  const pinned = await api(token, "pinChatMessage", { chat_id: chat, message_id: id, disable_notification: true });
  console.log(
    pinned.ok
      ? `[табло] отправлено и закреплено (№${id})`
      : `[табло] отправлено (№${id}), НО не закреплено: ${pinned.body.description ?? pinned.status}`,
  );
  return id;
}

/**
 * Свести всё вместе: собрать текст, решить, править ли, и выполнить.
 *
 * НИКОГДА НЕ БРОСАЕТ: табло — витрина, а не измерение. Неудача Telegram не имеет права утащить с
 * собой запись истории, которая уже сделана к этому моменту.
 *
 * Возвращает `{ acted, mode, messageId, why }` — по `mode` видно, что именно произошло:
 * `edited` · `sent` · `skipped` · `off`. Один общий `false` слил бы «не настроено», «рано» и
 * «Telegram отказал» в одно значение, а они требуют разных действий.
 */
export async function syncBoard(results, stamp, statusPage, { changed = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log("[табло] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — табло не трогаем");
    return { acted: false, mode: "off", messageId: null, why: "не настроено" };
  }

  const prev = loadBoard();
  const nextText = boardText(results, stamp, statusPage);
  const d = decideBoard({
    changed,
    lastEditedAt: prev.editedAt,
    now: Date.now(),
    lastText: prev.text,
    nextText,
  });

  if (d.act === "skip") {
    console.log(`[табло] не правим: ${d.why}`);
    return { acted: false, mode: "skipped", messageId: prev.messageId ?? null, why: d.why };
  }

  if (prev.messageId) {
    const edited = await api(token, "editMessageText", {
      chat_id: chat,
      message_id: prev.messageId,
      text: nextText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    // «Текст не изменился» — не отказ, а «делать нечего». Отметку времени всё равно обновляем,
    // иначе следующий круг попробует снова и получит то же самое.
    const notModified = String(edited.body.description ?? "").includes("message is not modified");
    if (edited.ok || notModified) {
      saveBoard({ messageId: prev.messageId, text: nextText, editedAt: new Date().toISOString() });
      console.log(`[табло] поправлено (№${prev.messageId}, ${d.why})`);
      return { acted: true, mode: "edited", messageId: prev.messageId, why: d.why };
    }
    // 🔴 ВОТ ЭТОТ ПУТЬ И ЕСТЬ СТРАХОВКА ОТ ВСЕГО, ЧЕГО Я ПРО TELEGRAM НЕ ЗНАЮ. Сообщение удалили,
    // бота переподключили, вышел срок, о котором в документации не сказано, — исход один: заводим
    // табло заново, а не молчим.
    console.error(`[табло] правка №${prev.messageId} отклонена (${edited.body.description ?? edited.status}) — ставлю новое`);
  }

  const id = await sendAndPin(token, chat, nextText);
  if (!id) return { acted: false, mode: "skipped", messageId: null, why: "отправить не удалось" };
  saveBoard({ messageId: id, text: nextText, editedAt: new Date().toISOString() });
  return { acted: true, mode: "sent", messageId: id, why: d.why };
}
