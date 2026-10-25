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
import { icon } from "./layout.mjs";
import { signalWithin, TELEGRAM_TIMEOUT_MS } from "./budget.mjs";
import { describeError } from "./error-detail.mjs";

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
export function boardText(view, stamp, statusPage, mesh = null) {
  /**
   * ТАБЛИЦЕЙ (решение владельца 26.10.2026: «простыня с провайдерами» не читалась). Строки — цели,
   * колонки — значок, имя, время ответа из Европы (NL) и из России (голоса балансировщиков:
   * прод — для «API» и «Базы данных и кэша», соседняя дверь — для балансировщика). Где из России
   * замера нет — «—». Ровные колонки — в <pre>: Telegram рисует его моноширинным.
   *
   * ⚠️ ПРОВАЙДЕРОВ И АДРЕСОВ ЗДЕСЬ НЕТ — они в событийных сообщениях «Сбой / Внимание». Причины
   * отказов — тоже там; здесь слово («нет», «код 502») и фраза группы под таблицей.
   * ⚠️ Раздел «Кто кого видит» снят — его заменяет колонка RU.
   */
  const rows = view.groups.flatMap((g) => g.rows);
  const ru = ruTable(mesh);
  const cells = rows.map((r) => [icon(r), r.name, nlCell(r), ruCell(r, ru, view)]);
  const nameW = Math.max(4, ...cells.map((c) => c[1].length));
  const nlW = Math.max(2, ...cells.map((c) => c[2].length));
  const ruW = Math.max(2, ...cells.map((c) => c[3].length));
  // Значок — эмодзи, его ширина в моноширинном шрифте одинакова у всех строк; в шапке — два пробела.
  const line = (ic, name, nl, ruv) => `${ic} ${name.padEnd(nameW)}  ${nl.padStart(nlW)}  ${ruv.padStart(ruW)}`;
  const table = [line("  ", "Цель", "NL", "RU"), ...cells.map((c) => line(...c))].join("\n");

  // Под таблицей — то, что требует слов: фразы групп («вход работает через второй») и пометки точек.
  const notes = view.groups.filter((g) => g.summary).map((g) => `<i>${esc(g.summary)}</i>`);
  if (mesh?.notes?.ruUp?.length) notes.push(`<i>Из Европы не видно, из России видно: ${esc(mesh.notes.ruUp.join(", "))}</i>`);
  if (mesh?.notes?.cutoff) notes.push("<i>Из Европы нет связи с Россией — показано прежнее состояние</i>");

  const text = [
    "<b>DentBoard — состояние</b>",
    `Проверено ${esc(stamp)} МСК`,
    "",
    `<pre>${esc(table)}</pre>`,
    ...(notes.length ? ["", ...notes] : []),
    "",
    `<a href="${statusPage}">Подробности и история</a>`,
  ].join("\n");
  // Предел Telegram — 4096 символов. Таблица из десяти строк до него далеко; если однажды дорастёт —
  // режем пометки, а не таблицу, и говорим об этом словами, а не обрывом разметки.
  if (text.length <= TELEGRAM_LIMIT) return text;
  return [
    "<b>DentBoard — состояние</b>",
    `Проверено ${esc(stamp)} МСК`,
    "",
    `<pre>${esc(table)}</pre>`,
    "<i>пометки не поместились — см. страницу</i>",
    `<a href="${statusPage}">Подробности и история</a>`,
  ].join("\n");
}

/** Предел длины сообщения Telegram (после разбора разметки; считаем с запасом — по исходнику). */
export const TELEGRAM_LIMIT = 4096;

/** NL — время ответа строки или слово: «нет» (не ответила), «код 502», DNS — «4/4», сертификат — «89 дн». */
function nlCell(r) {
  if (r.state === "unknown") return "—";
  if (r.kind === "cert") {
    // Удержанный сертификат (layout.mjs, первый сбой балансировщиков) несёт дни только в value —
    // берём оттуда, чтобы ячейка не менялась с «89 дн» на «действует» (ревью 26.10.2026).
    const d = typeof r.days === "number" ? r.days : Number((/осталось (\d+)/.exec(r.value ?? "") ?? [])[1]);
    if (Number.isFinite(d)) return d < 0 ? "истёк" : `${d} дн`;
    return r.word;
  }
  if (r.kind === "dns") {
    const m = /ответили (\d+) из (\d+)/.exec(r.shownDetail ?? r.detail ?? "");
    return m ? `${m[1]}/${m[2]}` : r.state === "up" ? "да" : "нет";
  }
  if (r.state === "down") return r.status ? `код ${r.status}` : "нет";
  return typeof r.ms === "number" ? `${r.ms} мс` : "нет";
}

/**
 * Замеры из России по свежим голосам: прод (меньший из ответивших 200; ни один не 200 — «нет» или
 * код) и каждая дверь глазами соседа. Голос двери с лежащей своей сетью (прод `unknown`) про соседа
 * не говорит — его «сосед не отвечает» про её сеть (то же правило, что в mesh.mjs ruEvidence).
 */
export function ruTable(mesh) {
  const out = { prod: null, peers: {} };
  let prodSeen = null;
  for (const v of mesh?.votes ?? []) {
    if (!v.fresh) continue;
    if (v.prod?.code === "200") {
      if (typeof v.prod.ms === "number") out.prod = typeof out.prod === "number" ? Math.min(out.prod, v.prod.ms) : v.prod.ms;
      else if (out.prod === null) out.prod = "да";
    } else if (v.prod && v.prod.state !== "unknown") {
      prodSeen = /^\d+$/.test(v.prod.code) && v.prod.code !== "000" ? `код ${v.prod.code}` : "нет";
    }
    if (!v.peer?.addr) continue;
    if (v.peer.state === "up") out.peers[v.peer.addr] = typeof v.peer.ms === "number" ? `${v.peer.ms} мс` : "да";
    else if (v.peer.state === "down") out.peers[v.peer.addr] ??= /^\d+$/.test(v.peer.code) && v.peer.code !== "000" ? `код ${v.peer.code}` : "нет";
    else if (v.peer.state === "unreachable" && v.prod?.state !== "unknown") out.peers[v.peer.addr] ??= "нет";
  }
  if (out.prod === null && prodSeen) out.prod = prodSeen;
  return out;
}

/** Строки сервера — по виду пробы (готовность и живость в группе с готовностью), а не по id. */
function isServerRow(r, view) {
  if (r.kind === "ready") return true;
  if (r.kind !== "http") return false;
  return view.groups.some((g) => g.rows.includes(r) && g.rows.some((x) => x.kind === "ready"));
}

function ruCell(r, ru, view) {
  // Удержанная строка (первый сбой, отрезанность) показывает прежнее — свежий русский замер выдал бы
  // то, что удержание прячет (ревью 26.10.2026).
  if (r.suspect || r.cutoff || r.heldNote) return "—";
  if (r.kind === "balancer") return (r.ip && ru.peers[r.ip]) || "—";
  if (isServerRow(r, view)) return ru.prod === null ? "—" : typeof ru.prod === "number" ? `${ru.prod} мс` : ru.prod;
  return "—";
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // Общий предел круга — см. `budget.mjs`: зависший Telegram не имеет права унести с собой
      // выкладку страницы, которая идёт после выхода `check.mjs`.
      signal: signalWithin(TELEGRAM_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, body: { description: describeError(e) }, status: 0 };
  }
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
export async function syncBoard(view, stamp, statusPage, { changed = false, mesh = null } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const nextText = boardText(view, stamp, statusPage, mesh);
  if (!token || !chat) {
    // Текст печатается: журнал частный, а подменный круг без него не показал бы, что встало бы в канал.
    console.log("[табло] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — табло не трогаем. Текст:");
    console.log(nextText.replace(/^/gm, "    │ "));
    return { acted: false, mode: "off", messageId: null, why: "не настроено" };
  }

  const prev = loadBoard();
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
    // ⚠️ ОТВЕТА НЕ БЫЛО — ЭТО НЕ ОТКАЗ. Таймаут, обрыв сети или вышедший предел круга не говорят,
    // что табло нет: правка могла и пройти. Завести новое здесь значило бы плодить закреплённые
    // табло на каждый медленный круг, оставляя старые застывшими. Следующий круг попробует снова.
    if (edited.status === 0) {
      console.log(`[табло] Telegram не ответил на правку №${prev.messageId} (${edited.body.description}) — попробуем на следующем круге`);
      return { acted: false, mode: "skipped", messageId: prev.messageId, why: "Telegram не ответил" };
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
