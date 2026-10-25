#!/usr/bin/env node
/**
 * ВНЕШНЯЯ ПРОВЕРКА ДОСТУПНОСТИ DentBoard. Запускается на машинах GitHub — то есть СНАРУЖИ нашей
 * инфраструктуры, и в этом весь смысл.
 *
 * 🔴 ЗАЧЕМ СНАРУЖИ. 28.08.2026 боевой сервер был недоступен 2 часа 29 минут, а всё наше внутреннее
 * наблюдение рапортовало здоровье — и было право: изнутри всё работало. Prometheus опрашивает
 * экспортеры по внутренней docker-сети и наружу не выходит вовсе. Отказ такого рода внутренняя
 * проверка не видит ПО ПОСТРОЕНИЮ, сколько её ни улучшай.
 *
 * ⚠️ УВЕДОМЛЕНИЕ ИДЁТ МИМО НАШЕГО СЕРВЕРА — напрямую в api.telegram.org. Слать тревогу о
 * недоступности сервера через этот же сервер значит получить уведомитель, который молчит вместе с
 * тем, о чём должен уведомить.
 *
 * ⚠️ КОММИТИМ ТОЛЬКО ПРИ СМЕНЕ СОСТОЯНИЯ, а не на каждую проверку. Проверок 8600 в месяц; коммит
 * на каждую превратил бы репозиторий в сто тысяч записей за год и сделал бы историю нечитаемой.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
// Аватар канала — ОТДЕЛЬНЫМ файлом, и не ради порядка: гистерезис и свод состояния должны
// проверяться образцами, без сети и без Telegram. Внутри этого файла они были бы непроверяемы,
// потому что он с первой строки читает цели и ходит наружу.
import { syncAvatar } from "./avatar.mjs";
// Раскладка по группам (25.10.2026): строки, группы, свод, события, тексты — чистые функции,
// проверяются образцами (`layout.test.mjs`) и подменным кругом (README, «Проверка путей отказа»).
import {
  LAYOUT,
  evaluate,
  publicView,
  compatCurrent,
  previousStates,
  previousRows,
  transitions,
  alertTexts,
  balancerAccepts,
  redact,
} from "./layout.mjs";
// Балансировщик по адресу мимо DNS и сертификат, который он отдаёт; прямой вопрос провайдерам DNS.
import { getVia, readCert } from "./door-probe.mjs";
import { probeDnsProvider } from "./dns-probe.mjs";
// Взаимная проверка с нескольких точек: голоса дверей «из России» (25.10.2026).
import { fetchVote, controlsReachable, applyMesh, matrixLines, shouldAsk, nextAskState, cutoffNotice, AUTH_BACKOFF_S } from "./mesh.mjs";
import { resolve as resolvePath } from "node:path";
// Табло — тоже отдельным файлом и по той же причине: расписание правок и текст обязаны
// проверяться образцами, без сети и без Telegram.
import { syncBoard, loadBoard } from "./board.mjs";

// Накопление времён ответа — отдельным файлом по той же причине: разбор и перцентили обязаны
// проверяться образцами, а этот файл с первой строки ходит наружу.
import { appendSample, summarise } from "./latency.mjs";

// Разбор причины сетевого отказа — тоже отдельным файлом, и по той же причине. Механизм
// исполняется ТОЛЬКО при отказе, то есть проверить его можно исключительно образцами и
// намеренно вызванным сбоем; внутри этого файла он был бы непроверяем.
import { describeError } from "./error-detail.mjs";

// Опрос целей и общий предел времени круга — отдельными файлами. Зачем предел и почему опрос
// параллельный, разобрано в `budget.mjs` (авария 23.10.2026).
import { probeAll } from "./probe.mjs";
import { remainingMs, signalWithin, TELEGRAM_TIMEOUT_MS, PROBE_BUDGET_MS } from "./budget.mjs";

const HISTORY = "data/history.json";
/**
 * Сырые замеры — ОТДЕЛЬНЫМ файлом и НЕ публикуются.
 *
 * `history.json` браузеры тянут каждые 30 секунд (страница состояния и точка в шапке кабинетов);
 * 2880 чисел на цель означали бы платить этим трафиком за данные, которые нужны раз в месяц.
 * Наружу идёт только СВОД (`p50`/`p95`/`max`/`n` — четыре числа на цель).
 */
const LATENCY = "data/latency.json";
/** Сколько событий храним. Не «всю историю»: файл читается целиком при каждом запуске. */
const KEEP_EVENTS = 500;

/**
 * Список целей. `STATUS_TARGETS` — ТОЛЬКО для подменного круга (свои сервера на 127.0.0.1 вместо
 * балансировщиков и DNS): пути отказа проверяются настоящим отказом настоящей пробы, а не
 * подставленным результатом. На машине наблюдателя переменная не задаётся.
 */
const config = JSON.parse(readFileSync(process.env.STATUS_TARGETS ?? "targets.json", "utf8"));

async function telegram(text, capMs = TELEGRAM_TIMEOUT_MS) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    /* Отсутствие настройки — законное состояние (проверка работает, канал не подключён), но оно
       обязано быть ВИДНО: «не настроено» и «отправлено» не должны выглядеть одинаково. Текст
       печатается целиком: журнал частный, а без текста подменный круг не показал бы, ЧТО ушло бы. */
    console.log("телеграм не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — сообщение не отправлено:");
    console.log(text.replace(/^/gm, "    │ "));
    // `false`, а не пустой возврат: для пробы связи «не настроено» — такой же отрицательный
    // ответ, как отказ Telegram. Разница между ними названа строкой выше.
    return false;
  }
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: signalWithin(capMs),
    });
  } catch (e) {
    // Отказ сети или предела — ответ «не отправлено», а не падение круга: история уже записана,
    // но аватар и табло после этой строки иначе не выполнились бы вовсе.
    console.log(`телеграм: ОТКАЗ — ${describeError(e)}`);
    return false;
  }
  /* ⚠️ ПЕЧАТАЕТСЯ ПРИЧИНА, А НЕ КОД. `телеграм: 400` не отвечает ни на один вопрос, а причин у
     четырёхсотки ровно те, что случаются на практике и лечатся по-разному: бот не администратор
     канала, неверный chat_id, разметка HTML не разобралась. Код возврата одинаков у всех трёх. */
  const body = await res.json().catch(() => ({}));
  if (body.ok) {
    console.log("телеграм: отправлено");
    return true;
  }
  console.log(`телеграм: ОТКАЗ ${res.status} — ${body.description ?? "ответ не разобран"}`);
  return false;
}

const previous = existsSync(HISTORY)
  ? JSON.parse(readFileSync(HISTORY, "utf8"))
  : { current: {}, events: [] };

const now = new Date().toISOString();

let latency = existsSync(LATENCY) ? JSON.parse(readFileSync(LATENCY, "utf8")) : {};

const groupOf = (kind) => config.groups.find((g) => g.kind === kind);
const balancerGroup = groupOf("balancer");
const balancers = balancerGroup?.rows ?? [];
/** Чего ждём от DNS — адреса ОБОИХ балансировщиков. Второго списка нет: разъехался бы с первым. */
const expectIps = [...new Set(balancers.map((b) => b.ip))].sort();

/**
 * ВСЕ ПРОБЫ — РАЗОМ, в одном пределе круга (`budget.mjs`, авария 23.10.2026). HTTP-цели и
 * балансировщики идут через `probeAll` (повторы и предел общие), DNS и сертификат — со своими
 * короткими таймаутами (3 с на вопрос, 10 с на соединение), параллельно с ними.
 */
const httpTargets = [];
for (const g of config.groups) {
  for (const row of g.rows) {
    // Вид пробы — у строки, если задан (группа «Сервер»: API — живость, база и кэш — готовность).
    const kind = row.kind ?? g.kind;
    if (kind === "http") httpTargets.push({ id: row.id, url: row.url, expect: row.expect });
    if (kind === "ready") httpTargets.push({ id: row.id, url: row.url, expect: row.expect, readBody: true, strict: true });
    if (g.kind === "balancer") {
      httpTargets.push({
        id: row.id,
        expect: 200,
        strict: true,
        /**
         * 🔴 БАЛАНСИРОВЩИК ЖИВ, ЕСЛИ ДОВЁЛ ЗАПРОС ДО СЕРВЕРА — даже когда тот ответил 503 «не готов»
         * (ревью 25.10.2026). Иначе лежащая база красила бы ОБА балансировщика, страница писала бы
         * «оба балансировщика недоступны — вход не работает», а в канал уходил бы неверный диагноз.
         * Готовность сервера — дело строки «База данных и кэш». 503 БЕЗ тела готовности (заглушка самого
         * балансировщика), 502, 504, сетевая ошибка — отказ балансировщика.
         */
        accept: balancerAccepts,
        attempt: ({ signal, headers }) => getVia(row.ip, g.host, g.path, { signal, headers, port: row.port ?? 443 }),
      });
    }
  }
}
const dnsGroup = groupOf("dns");
const certGroup = groupOf("cert");

/**
 * DNS И СЕРТИФИКАТ — В ТОМ ЖЕ ПРЕДЕЛЕ, ЧТО И ОПРОС ЦЕЛЕЙ (ревью 25.10.2026). Их собственные
 * таймауты короткие, но разрешение имени сервера имён и соединение могут застрять на стороне
 * наблюдателя; без общего срока `Promise.all` ждал бы дольше отведённого и съедал время сообщений.
 * Не успели — отказ с названной причиной, а не ожидание.
 */
const until = Date.now() + PROBE_BUDGET_MS;
function within(promise, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, until - Date.now()));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
const LATE = "не успели: предел времени круга вышел";

/**
 * ТОЧКИ НАБЛЮДЕНИЯ «ИЗ РОССИИ» — голоса дверей по ssh (mesh.mjs, 25.10.2026), параллельно с пробами и
 * в том же пределе. Ключа на машине нет — точки «доступ не настроен», и решения идут как раньше.
 */
const meshCfg = config.mesh ?? null;
const sshCmd = process.env.STATUS_SSH ? JSON.parse(process.env.STATUS_SSH) : ["ssh"];
const meshKey = process.env.STATUS_DOOR_KEY ?? meshCfg?.key ?? null;
const meshKnown = resolvePath(meshCfg?.knownHosts ?? "vps/doors.known_hosts");
// Отступ после отказа ключа — состояние машины-наблюдателя (data/mesh.json, в git не хранится).
const MESH_STATE = "data/mesh.json";
let askState = {};
try {
  askState = existsSync(MESH_STATE) ? JSON.parse(readFileSync(MESH_STATE, "utf8")) : {};
} catch {
  askState = {};
}
const nowSec = Date.now() / 1000;
const meshFetch = meshCfg
  ? Promise.all(
      (meshCfg.vantages ?? []).map((v) => {
        const prev = askState[v.id];
        if (!shouldAsk(prev, nowSec)) {
          // Не спрашиваем: «ключ не принят» был недавно. Это не связь с дверью (дорогу не доказывает).
          const left = Math.ceil((prev.at + AUTH_BACKOFF_S - nowSec) / 60);
          return Promise.resolve({ id: v.id, reach: "backoff", ms: null, error: `${prev.error}; повтор через ${left} мин`, skipped: true });
        }
        return within(fetchVote(v, { key: meshKey, knownHosts: meshKnown, user: meshCfg.user, ssh: sshCmd }), { id: v.id, reach: "net", ms: null, error: LATE });
      }),
    )
  : Promise.resolve([]);
const meshControls = meshCfg?.controls?.length ? within(controlsReachable(meshCfg.controls), false) : Promise.resolve(false);

const [probed, dnsResults, certResults, fetchedVotes, controlsOk] = await Promise.all([
  probeAll(httpTargets, { headers: { "user-agent": "dentboard-status/1.0 (+https://github.com)" } }),
  Promise.all(
    (dnsGroup?.rows ?? []).map((row) =>
      within(probeDnsProvider(row.servers, dnsGroup.query, expectIps), {
        ok: false,
        wrong: false,
        answered: 0,
        total: row.servers.length,
        answers: [{ server: "все", ok: false, error: LATE }],
        ms: null,
      }),
    ),
  ),
  Promise.all(
    certGroup
      ? balancers.map(async (b) => ({
          door: b.id,
          ...(await within(readCert(b.ip, certGroup.host, { port: b.port ?? 443 }), { ok: false, error: LATE })),
        }))
      : [],
  ),
  meshFetch,
  meshControls,
]);

const raw = {};
httpTargets.forEach((t, i) => (raw[t.id] = probed[i]));
(dnsGroup?.rows ?? []).forEach((row, i) => (raw[row.id] = dnsResults[i]));
for (const row of certGroup?.rows ?? []) raw[row.id] = { perDoor: certResults };

// Решение «кто кого видит» — до раскладки: отказ, который видит одна Европа, раскладка уже не видит.
const meshed = applyMesh(config, raw, { fetched: Object.fromEntries(fetchedVotes.map((f) => [f.id, f])), controlsOk });
const matrix = matrixLines(config, raw, meshed.mesh);

// Прошлые строки — для «двух кругов подряд» у DNS и балансировщиков (`hold` в layout.mjs).
const view = evaluate(config, meshed.raw, { prevRows: previousRows(previous) });

// ⚠️ КОПИМ ТОЛЬКО УСПЕШНЫЕ. У неудачной пробы `ms` — время ДО ОТКАЗА, то есть чаще всего таймаут:
// подмешав его, мы получили бы «медиана выросла до 15 секунд» там, где цель просто лежала, и
// «медленно» перестало бы отличаться от «лежит». Ключ — имя строки: у страниц оно прежнее, и
// накопленное окно переживает смену раскладки.
const timed = view.groups.flatMap((g) => g.rows).filter((r) => ["http", "balancer", "ready"].includes(r.kind));
// Окно строки, сменившей имя («Сервер и база» → «База данных и кэш», 26.10.2026), переезжает под
// новое имя один раз — иначе накопленное за двое суток стёрлось бы ниже вместе со «снятыми целями».
for (const g of config.groups) {
  for (const row of g.rows) {
    if (latency[row.name]) continue;
    const old = [].concat(row.was ?? []).find((n) => Array.isArray(latency[n]));
    if (old) latency = { ...latency, [row.name]: latency[old] };
  }
}
// Удержанная строка (`suspect`) показывает ПРОШЛОЕ время — замером оно не является и в окно не идёт.
for (const r of timed) if (r.state === "up" && !r.suspect && !r.cutoff && typeof r.ms === "number") latency = appendSample(latency, r.name, r.ms);
// Окна снятых целей («API», «API и его зависимости») не копим вечно: их больше никто не пишет.
latency = Object.fromEntries(Object.entries(latency).filter(([k]) => timed.some((r) => r.name === k)));
// Свод по накопленному окну — ради него всё и заведено: порог «медленно» надо НАЗНАЧАТЬ ПО ЗАМЕРУ.
const latencyOf = (r) => (["http", "balancer", "ready"].includes(r.kind) ? summarise(latency[r.name]) : undefined);

// Журнал круга — ЧАСТНЫЙ (journalctl на машине наблюдателя), поэтому с провайдером и причиной.
for (const g of view.groups) {
  for (const r of g.rows) {
    // ⏳ — первый сбой, ещё не подтверждённый вторым кругом: видно только здесь, в журнале.
    // 📡 — NL отрезан от России, показано прежнее; 🌍 — из Европы не видно, из России видно.
    const mark = r.cutoff ? "📡" : r.suspect ? "⏳" : r.viaRU ? "🌍" : r.state === "down" ? "🔴" : r.state === "warn" ? "🟡" : r.state === "unknown" ? "⚪" : "✅";
    console.log(`${mark} ${g.title} · ${r.label ? `${r.name} (${r.label})` : r.name}: ${r.word} — ${r.heldNote ?? r.detail}`);
  }
}
for (const line of matrix) console.log(`   ${line}`);

/**
 * Смены состояния. Первый в жизни запуск и первый круг новой раскладки событиями не считаются
 * (`previousStates`): иначе на пустой истории поднялась бы тревога «всё упало», а при выкате —
 * поток «работает: …» по строкам, которых раньше не было. Тревога, начавшаяся с ложной,
 * обесценивает все следующие.
 */
const prevStates = previousStates(previous, config);
const moved = transitions(view, prevStates, now);
const firstOfLayout = previous.layout !== LAYOUT;
const changed = moved.events.length > 0 || firstOfLayout;

/**
 * 🔴 СВОД ПУБЛИКУЕТСЯ, А НЕ СЧИТАЕТСЯ ПОТРЕБИТЕЛЕМ. Точку состояния в шапке кабинетов рисует
 * фронт DentBoard, забирая этот файл. Посчитай он «зелёный/жёлтый/красный» сам — правило
 * существовало бы в двух экземплярах и разошлось бы молча.
 *
 * ⚠️ СОВМЕСТИМОСТЬ С КАБИНЕТАМИ (ztl-lab `packages/ui/src/lib/status-snapshot.ts`): тот читает
 * `overall`, `updatedAt` и `current[имя].ok/.ms`. Все три остались, смысл прежний; устройство
 * целиком — новым полем `groups`, которого прежний читатель не видит и видеть не обязан.
 *
 * ⚠️ БЕЗ ГИСТЕРЕЗИСА, в отличие от аватара. Там задержка в два прогона оправдана ценой: смена
 * фото оставляет запись в ленте канала. Здесь цены нет — точка меняет цвет молча.
 *
 * ⚠️ ФАЙЛ ПУБЛИЧНЫЙ: провайдеров, адресов и подробностей в нём нет (`publicView`, `redact`).
 */
const urls = Object.fromEntries(config.groups.flatMap((g) => g.rows).filter((r) => r.url).map((r) => [r.id, r.url]));
const history = {
  layout: LAYOUT,
  overall: view.overall,
  // Оговорка к зелёному своду («резерв частично недоступен — на работу не влияет»), иначе null.
  notice: view.notice,
  groups: publicView(view, latencyOf, prevStates),
  current: compatCurrent(view, { now, urls, latencyOf }),
  // `redact` и по ПРЕЖНИМ событиям: их писал старый код, который адреса из причины не вырезал.
  events: [...moved.events, ...(previous.events ?? [])].slice(0, KEEP_EVENTS).map((e) => ({ ...e, error: redact(e.error ?? null) })),
  // Наблюдатель отрезан от России: с какого момента и объявлено ли (mesh.mjs `cutoffNotice`). Без
  // адресов: только время и счёт кругов.
  observerCut: cutoffNotice(previous.observerCut ?? null, Boolean(meshed.mesh?.notes.cutoff), now, "").state,
  updatedAt: now,
};
mkdirSync("data", { recursive: true });
writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`);
writeFileSync(MESH_STATE, `${JSON.stringify(nextAskState(askState, fetchedVotes, nowSec))}\n`);
// Без отступов: файл машинный, его никто не читает глазами, а 2880 чисел на цель с
// форматированием весили бы втрое больше на диске машины наблюдателя.
writeFileSync(LATENCY, `${JSON.stringify(latency)}\n`);

/**
 * ТЕКСТЫ КОРОТКИЕ — ЭТО ТРЕБОВАНИЕ, А НЕ СТИЛЬ (решение владельца 28.08.2026).
 *
 * Уведомление о сбое читают в минуту, когда человек уже раздражён и ищет один ответ: работает или
 * нет и занимается ли кто-то этим. Всё остальное — «проверено снаружи», «с машин GitHub», рассказ
 * про нашу инфраструктуру — в эту минуту шум, а шум учит пролистывать. Пролистанное уведомление о
 * сбое ничем не лучше неотправленного.
 *
 * Остаётся ровно три вещи: ЧТО не работает, что этим уже занимаются, и куда смотреть за
 * подробностями. Список целей сохраняется — без него человек не поймёт, идти ли ему работать.
 */
const STATUS_PAGE = "https://status.dentboard.ru";

/**
 * ВРЕМЯ В СООБЩЕНИИ — МОСКОВСКОЕ И ЯВНОЕ (решение владельца 28.08.2026).
 *
 * ⚠️ ЗАЧЕМ, ЕСЛИ У СООБЩЕНИЯ И ТАК ЕСТЬ ВРЕМЯ ОТПРАВКИ. Затем, что читают его ПОЗЖЕ — утром,
 * после совещания, из уведомления на заблокированном экране. «Сбой» без даты отвечает на вопрос
 * «что случилось» и не отвечает на «когда и закончилось ли», а решение принимают по второму.
 * Отдельно: сообщения о падении и о восстановлении стоят в ленте рядом, и без времени между ними
 * не видно, сколько лежало.
 *
 * Пояс задан ЯВНО, а не берётся у машины: прогон идёт на серверах GitHub в UTC, и «14:33» без
 * пояса читалось бы как местное — то есть врало бы на три часа, выглядя правдоподобно.
 */
const stamp = new Date().toLocaleString("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * 🔴 ПРОВЕРОЧНОЕ СООБЩЕНИЕ — ПО ЯВНОЙ ПРОСЬБЕ, И ТЕМ ЖЕ КОДОМ, ЧТО ШЛЁТ НАСТОЯЩИЕ.
 *
 * Зачем понадобилось: сообщения уходят только при СМЕНЕ состояния, поэтому в спокойную неделю
 * канал молчит — и «всё работает» неотличимо от «токен просрочен, бота выгнали из канала, chat_id
 * не тот». Узнать об этом иначе можно было бы только в час настоящего отказа, то есть в худший
 * возможный момент.
 *
 * ⚠️ ЗОВЁТСЯ ТА ЖЕ `telegram()`, а не «похожая отправка для проверки». Отдельный код проверял бы
 * отдельный код: прошёл бы при неверном секрете, чужом chat_id и снятых правах бота — ровно там,
 * где проверка и нужна.
 *
 * ⚠️ И ПРОГОН ПРИ ЭТОМ ОБЫЧНЫЙ: цели опрашиваются, история пишется, аватар сводится. Проверочное
 * сообщение — ДОБАВКА к настоящему прогону, а не подмена его: режим, расходящийся с боевым,
 * доказывает только то, что работает сам режим.
 */
if (process.env.TEST_MESSAGE === "true") {
  const rows = view.groups.flatMap((g) => g.rows).filter((r) => r.state !== "unknown");
  const bad = rows.filter((r) => r.state !== "up").map((r) => r.name);
  const state =
    bad.length === 0
      ? `Всё работает (${rows.length} из ${rows.length}).`
      : `Есть проблемы: ${bad.join(", ")}.`;
  const sent = await telegram(
    `🔔 <b>Проверка</b>\n${stamp} МСК\n${state}\n<a href="${STATUS_PAGE}">Страница состояния</a>`,
  );
  // Отказ проверки — ОТКАЗ ЗАДАНИЯ. Напечатать «не отправилось» и выйти нулём значило бы завести
  // проверку, которую можно не заметить, — а её ради заметности и заводили.
  if (!sent) {
    console.error("проверочное сообщение НЕ доставлено — см. причину выше");
    process.exitCode = 1;
  }
}

/**
 * ⚠️ СООБЩЕНИЯМ О СМЕНЕ СОСТОЯНИЯ — ВСЁ ОСТАВШЕЕСЯ ВРЕМЯ, А НЕ ОБЩИЕ 5 С. Повтора у них нет:
 * история уже записана, и на следующем круге «упал» не возникнет снова. Медленный Telegram с
 * общим пределом терял бы ровно то сообщение, ради которого канал существует; аватару и табло
 * хватит остатка — они сойдутся на следующих кругах сами.
 */
const ALERT_RESERVE_MS = 2_000;
const alertCap = () => Math.max(TELEGRAM_TIMEOUT_MS, remainingMs() - ALERT_RESERVE_MS);

// Тексты — в `layout.mjs` (проверяются образцами): по сообщению на «сбой», «внимание», «работает».
// Матрица «кто кого видит» — к «Сбою» и «Вниманию»: по ней видно, сколько мест не видит цель.
for (const text of alertTexts(moved, view, stamp, STATUS_PAGE, matrix)) await telegram(text, alertCap());
// Монитор слеп к России (или снова видит) — одно сообщение на начало и одно на конец.
{
  const cut = cutoffNotice(previous.observerCut ?? null, Boolean(meshed.mesh?.notes.cutoff), now, stamp);
  if (cut.say) await telegram(cut.say, alertCap());
}

/**
 * АВАТАР КАНАЛА — ПОСЛЕ записи истории и ПОСЛЕ сообщений.
 *
 * Порядок содержательный: история и сообщение о падении не должны зависеть от того, удалось ли
 * поменять картинку. Отказ Telegram на фото (снятое право, лимит) не имеет права утащить с собой
 * запись о проверке — иначе одна косметическая неудача стирала бы сам факт наблюдения.
 *
 * Смена аватара НЕ влияет на признак `changed`: он про историю проверок, а ава — про картинку.
 * Слив их в одно значение означал бы коммит «сменилось состояние» там, где сменилась только
 * подтверждённость гистерезиса.
 */
const avatar = await syncAvatar(view.overall, { protectedIds: [loadBoard().messageId] });
console.log(`аватар: наблюдаем «${avatar.observed}», на канале «${avatar.state ?? "—"}»${avatar.changed ? " (сменили)" : ""}`);

/**
 * ТАБЛО — ПОСЛЕДНИМ, и порядок здесь такой же содержательный, как у аватара.
 *
 * История уже записана, сообщения о сбое уже ушли: витрина не имеет права утащить за собой ни то,
 * ни другое. Отсюда же и то, что `syncBoard` никогда не бросает — отказ Telegram на правке
 * закреплённого сообщения обязан остаться косметикой.
 *
 * ⚠️ НОМЕР ТАБЛА ПЕРЕДАЁТСЯ АВАТАРУ ВЫШЕ (`protectedIds`). Уборка служебного поста удаляет
 * сообщение с номером `id - 1` вслепую, и с появлением табла этим соседом может оказаться оно
 * само. Довод целиком — в `avatar.mjs`.
 */
const board = await syncBoard(view, stamp, STATUS_PAGE, { changed, mesh: meshed.mesh });
console.log(`табло: ${board.mode}${board.messageId ? ` (№${board.messageId})` : ""} — ${board.why}`);

/* Признак «коммитить ли» отдаётся оболочке ЯВНО, а не выводится ею из текста вывода: разбор
   чужого текста — способ получить тихое расхождение при первой же правке формулировки. */
/**
 * 🔴 ПРИЗНАКОВ ДВА, А НЕ ОДИН — починка 29.08.2026 по вопросу владельца «почему фото канала не
 * меняется». `changed` говорит о смене состояния ИСТОРИИ (цель упала или поднялась), `avatar` — о
 * смене решения по аве. Это РАЗНЫЕ события: ава меняется и по медленным ответам, когда все цели
 * по-прежнему отвечают и история стои́т на месте.
 *
 * Пока признак был один, `data/avatar.json` не коммитился вовсе. Задание GitHub умирает вместе со
 * своей файловой системой, следующий прогон брал из репозитория старую копию с `applied: null` и
 * попадал в ветку «первый прогон — ставим сразу»: фото переставлялось КАЖДЫЙ раз, подтверждения не
 * копились никогда, а по виду механизм работал. В репозитории при этом лежало `applied: null` при
 * `streak: 2` — состояние, которого исправная работа не создаёт.
 */
writeFileSync(
  process.env.GITHUB_OUTPUT ?? "/dev/null",
  `changed=${changed}\navatar=${avatar.persisted === true}\n`,
  { flag: "a" },
);
{
  const rows = view.groups.flatMap((g) => g.rows);
  const count = (s) => rows.filter((r) => r.state === s).length;
  console.log(
    `итог: строк ${rows.length} (работает ${count("up")}, внимание ${count("warn")}, не работает ${count("down")}, не проверено ${count("unknown")}, первый сбой ждёт подтверждения ${rows.filter((r) => r.suspect).length}), ` +
      `свод «${view.overall}», событий ${moved.events.length}${firstOfLayout ? " (первый круг раскладки — по новым строкам сообщений нет)" : ""}`,
  );
}
