/**
 * РАСКЛАДКА ПО ГРУППАМ: из сырых проб — строки, группы, общий свод, события и тексты.
 *
 * 🔴 ЗАЧЕМ (25.10.2026, владелец: «дубли и не видно устройства»). Было пять строк подряд — «Сайт»,
 * два кабинета и ДВЕ строки «API», дублировавшие друг друга, — и ни одна не показывала, как
 * устроен вход: два балансировщика у двух провайдеров, DNS у двух провайдеров, сертификат. Именно
 * поэтому самый вероятный теперь отказ — «один из двух лёг, второй держит» — снаружи был
 * неотличим от полного здоровья, а запаса в этот момент уже нет.
 *
 * ⚠️ ВСЁ ЗДЕСЬ — ЧИСТЫЕ ФУНКЦИИ, И ЭТО ГЛАВНОЕ В ФАЙЛЕ. Пути отказа (одна дверь, оба DNS, сертификат
 * на исходе) исполняются только при настоящей аварии; проверить их можно лишь подменой входа —
 * `layout.test.mjs` и подменный круг (`STATUS_TARGETS` в `check.mjs`, README). Внутри `check.mjs`, который с
 * первой строки ходит наружу, они были бы непроверяемы.
 *
 * ⚠️ ПУБЛИЧНОЕ И ЧАСТНОЕ РАЗВЕДЕНЫ ЗДЕСЬ, А НЕ У ПОТРЕБИТЕЛЯ (решение владельца 25.10.2026). На
 * странице и в `data/history.json` — только имена строк и «работает / не работает»; провайдеры,
 * города, адреса и какой сервер имён не ответил — только в канале. Поле `detail` у строки —
 * частное, и в публикуемое (`publicView`) оно НЕ копируется вовсе: забыть убрать нельзя, можно
 * только забыть добавить.
 */
import { SLOW_MS, SLOW_TARGETS_MIN } from "./avatar.mjs";

/** Версия раскладки в `history.json`. По ней круг понимает, с чем сравнивать прошлое. */
export const LAYOUT = 2;

/** «1 день», «3 дня», «11 дней». */
export function days(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const w = a > 10 && a < 20 ? "дней" : b === 1 ? "день" : b >= 2 && b <= 4 ? "дня" : "дней";
  return `${n} ${w}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Адреса из текста ошибки — наружу не выходят (страница и её JSON публичны). */
export function redact(text) {
  if (text == null) return null;
  return (
    String(text)
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "…")
      // IPv6: группы шестнадцатеричных цифр через двоеточие. Чтобы не съесть время вида «10:30:00»,
      // вырезается только то, где есть буква a–f или «::».
      .replace(/\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d+)?/gi, (m) => (/[a-f]|::/i.test(m) ? "…" : m))
  );
}

/** Отказ HTTP-пробы человеческим словом для канала: код или причина. */
function httpWhy(r) {
  if (r.status) return `код ${r.status}`;
  return r.error ?? "нет ответа";
}

/** Разбор тела готовности: `{ db, redis }` — задержки и признаки. Мусор — `null`, не ноль. */
export function readiness(body) {
  try {
    const j = JSON.parse(body ?? "");
    // Без `checks` это не тело готовности (заглушка, чужой JSON) — `null`, а не «всё лежит».
    if (!j || typeof j !== "object" || !j.checks || typeof j.checks !== "object") return null;
    const pg = j?.checks?.postgres;
    const rd = j?.checks?.redis;
    return {
      status: typeof j?.status === "string" ? j.status : null,
      dbUp: pg?.up === true,
      dbMs: typeof pg?.latency_ms === "number" ? pg.latency_ms : null,
      redisUp: rd?.up === true,
    };
  } catch {
    return null;
  }
}

/**
 * Ответил ли балансировщик САМ: довёл запрос до сервера. 200 — да; 503 с телом готовности — тоже да
 * (сервер не готов, но это дело строки «Сервер и база»); 503 без тела, 502, 504 — нет.
 */
export function balancerAccepts(status, body) {
  return status === 200 || (status === 503 && readiness(body) !== null);
}

/** Одна строка из сырой пробы. Возвращает `{ id, name, kind, state, word, value, ms, slow, detail }`. */
export function evalRow(group, row, r, { slowMs = SLOW_MS, balancers = [] } = {}) {
  const base = { id: row.id, name: row.name, kind: group.kind, label: row.label ?? null, ip: row.ip ?? null };
  if (!r) return { ...base, state: "unknown", word: "не проверен", value: null, ms: null, slow: false, detail: "проба не выполнялась" };
  // NL отрезан от России (mesh.mjs): это не наблюдение — `hold` покажет прежнее состояние.
  if (r.cutoff) {
    const why = r.nlError ? ` (${r.nlError})` : "";
    return { ...base, state: "unknown", word: "не проверен", value: null, ms: null, slow: false, detail: `из Европы нет связи с Россией${why}`, cutoff: true };
  }
  // Из Европы не видно, из России видно (mesh.mjs): строка работает — людям она открывается.
  if (r.viaRU && (group.kind === "http" || group.kind === "balancer" || group.kind === "ready")) {
    return {
      ...base,
      state: "up",
      word: group.kind === "ready" ? "работают" : "работает",
      value: null,
      ms: null,
      slow: false,
      detail: `из Европы не видно (${r.nlError ?? "нет ответа"}); из России видно: ${r.ruText}`,
      viaRU: true,
      status: r.status ?? 0,
    };
  }
  // Отказ, подтверждённый Россией, — с её словами в подробностях (канал).
  const ruNote = r.ruText ? `; Россия: ${r.ruText}` : "";

  if (group.kind === "http" || group.kind === "balancer") {
    if (r.ok) {
      const slow = typeof r.ms === "number" && r.ms > slowMs;
      // Балансировщик, доведший запрос до неготового сервера (503 с телом готовности), жив —
      // неготовность называет строка «Сервер и база».
      const note = r.status && r.status !== 200 ? ` (сервер ответил ${r.status})` : "";
      // `shownDetail` — то же, что видит табло, без провайдеров и адресов: удержанная строка (`hold`)
      // повторит его дословно, а не заменит на «работает».
      const shown = `${r.ms} мс${note}`;
      return { ...base, state: "up", word: "работает", value: `${r.ms} мс`, ms: r.ms, slow, detail: shown, shownDetail: shown, status: r.status };
    }
    /**
     * `misleads` — отказ, на котором люди НЕ уходят на запасной вход: браузер переспрашивает другой
     * адрес только при отказе соединения, а ответ кодом (502, 504, 503 без тела) он показывает
     * человеку. Такой отказ в паре — уже не «резерв», а беда для части людей (ревью 25.10.2026).
     */
    const misleads = group.kind === "balancer" && Boolean(r.status);
    return { ...base, state: "down", word: r.status ? "не работает" : "не отвечает", value: null, ms: null, slow: false, detail: httpWhy(r) + ruNote, status: r.status ?? 0, error: r.error ?? null, misleads };
  }

  if (group.kind === "ready") {
    const rd = readiness(r.body);
    const db = rd?.dbMs != null ? `база ${rd.dbMs} мс` : null;
    if (r.ok && rd?.status === "ok") {
      const slow = typeof r.ms === "number" && r.ms > slowMs;
      return { ...base, state: "up", word: "работают", value: db, ms: r.ms, dbMs: rd.dbMs, slow, detail: [`${r.ms} мс`, db].filter(Boolean).join(", "), status: r.status };
    }
    const why = [httpWhy(r)];
    if (rd && !rd.dbUp) why.push("база не отвечает");
    if (rd && !rd.redisUp) why.push("Redis не отвечает");
    return { ...base, state: "down", word: "не отвечают", value: null, ms: null, slow: false, detail: why.join(", ") + ruNote, status: r.status ?? 0, error: r.error ?? null };
  }

  if (group.kind === "dns") {
    const bad = (r.answers ?? []).filter((a) => !a.ok).map((a) => `${a.server}: ${a.error}`);
    const tally = `ответили ${r.answered} из ${r.total}`;
    const detail = [tally, ...bad].join("; ");
    // У исправного провайдера в `detail` могут стоять имена молчащих серверов — частное; удержанной
    // строке (`shownDetail`) хватит счёта.
    if (r.ok) return { ...base, state: "up", word: "работает", value: null, ms: null, slow: false, detail, shownDetail: tally };
    // Неверный ответ резолвер кэширует и отдаёт людям — запасной провайдер их не спасает.
    return { ...base, state: "down", word: r.wrong ? "отвечает неверно" : "не отвечает", value: null, ms: null, slow: false, detail, misleads: Boolean(r.wrong) };
  }

  if (group.kind === "cert") {
    const label = (id) => {
      const b = balancers.find((x) => x.id === id);
      return b ? privateName(b) : id;
    };
    const date = (iso) => iso.slice(0, 10).split("-").reverse().join(".");
    const seen = (r.perDoor ?? []).filter((d) => d.ok);
    const dates = [...new Set(seen.map((d) => d.validTo))];
    // Одна дата у всех — одной строкой; разные — по балансировщику: протухнуть может одна копия.
    // Недоступный балансировщик назван коротко — причину его отказа уже называет его собственная строка.
    const per = [
      ...(dates.length === 1 && seen.every((d) => d.authorized)
        ? [`до ${date(dates[0])}`]
        : seen.map((d) => `${label(d.door)}: до ${date(d.validTo)}${d.authorized ? "" : `, ${d.authorizationError}`}`)),
      ...(r.perDoor ?? []).filter((d) => !d.ok).map((d) => `${label(d.door)}: не проверен`),
    ];
    const dateNote = per.join("; ") || "не с кем было проверить";
    // Ни один балансировщик не отдал сертификата — это «не знаем», а не «сертификат плох»:
    // отказ балансировщиков уже назван своими строками, и второй раз красить его чужой строкой
    // значило бы удвоить одну аварию.
    if (seen.length === 0) return { ...base, state: "unknown", word: "не проверен", value: null, ms: null, slow: false, detail: dateNote };
    const min = Math.min(...seen.map((d) => d.days));
    // Истёкший сертификат Node называет `CERT_HAS_EXPIRED` — это срок, а не «чужой сертификат».
    const foreign = seen.some((d) => !d.authorized && d.authorizationError !== "CERT_HAS_EXPIRED");
    const value = min >= 0 ? `осталось ${days(min)}` : null;
    const detail = value ? `${value}, ${dateNote}` : dateNote;
    if (foreign) return { ...base, state: "down", word: "не подходит", value, ms: null, slow: false, detail, days: min };
    if (min < 0) return { ...base, state: "down", word: "истёк", value: null, ms: null, slow: false, detail, days: min };
    if (min < (group.downDays ?? 3)) return { ...base, state: "down", word: "истекает", value, ms: null, slow: false, detail, days: min };
    if (min < (group.warnDays ?? 14)) return { ...base, state: "warn", word: "скоро истекает", value, ms: null, slow: false, detail, days: min };
    return { ...base, state: "up", word: "действует", value, ms: null, slow: false, detail, days: min };
  }

  return { ...base, state: "unknown", word: "не проверен", value: null, ms: null, slow: false, detail: `неизвестный вид «${group.kind}»` };
}

/**
 * Состояние группы по её строкам.
 *
 * Правило одно на все группы: всё работает — зелёная; не работает ничего — красная; иначе жёлтая.
 * Для двух балансировщиков и двух DNS это ровно «один лёг — второй держит» (жёлтая) и «оба
 * легли» (красная). Строки «не проверен» в счёт не идут: «не знаем» не равно ни «работает», ни
 * «не работает».
 */
export function groupState(rows) {
  const known = rows.filter((r) => r.state !== "unknown");
  if (known.length === 0) return "unknown";
  const down = known.filter((r) => r.state === "down").length;
  if (down === known.length) return "down";
  if (down > 0 || known.some((r) => r.state === "warn")) return "warn";
  return "up";
}

/**
 * ОБЩИЙ СВОД — то, что красит аву канала и точку в шапке кабинетов.
 *
 * 🔴 КРАСНЫЙ — ТОЛЬКО КОГДА ПРОДУКТ НЕДОСТУПЕН ЛЮДЯМ, то есть не работает ни одна строка группы
 * «Для пользователей» (решение владельца 28.08.2026: красная на каждую частную неисправность
 * обесценила бы красную вообще).
 *
 * 🟡 ЖЁЛТЫЙ — ТОЛЬКО КОГДА ПЛОХО ЛЮДЯМ (решение владельца 25.10.2026): не работает страница для
 * пользователей или «Сервер и база»; не работают ОБА балансировщика или ОБА DNS (запаса нет —
 * это уже не резерв); сертификат вот-вот истечёт или чужой (браузер предупредит об опасности);
 * две строки медленнее порога.
 *
 * 🟢 А ЛЁГ ОДИН ИЗ ДВУХ ИЛИ СЕРТИФИКАТУ МЕНЬШЕ 14 ДНЕЙ — ЗЕЛЁНЫЙ С ОГОВОРКОЙ (`noticeOf`). Людям
 * в этот момент всё работает; «Есть проблемы — мы занимаемся» на странице и жёлтая точка в
 * кабинетах читались бы клиентом как авария, которой нет. Владелец узнаёт о таком из канала
 * («🟡 Внимание»), и строка на странице жёлтая — оговорка видна тому, кто смотрит подробно.
 *
 * Медленно — как и раньше, ДВЕ медленные строки, а не одна: одиночный выброс говорит о своей
 * цели, а не о системе. Считаются страницы и сервер; балансировщики — НЕТ: они ходят в тот же
 * `/health/ready`, что и «Сервер и база», и одна медленная готовность засчитывалась бы трижды
 * (ревью 25.10.2026). Медленный балансировщик виден своим жёлтым числом на странице и в табло.
 */
export function overallOf(groups) {
  const rows = groups.flatMap((g) => g.rows);
  if (rows.length === 0 || rows.every((r) => r.state === "unknown")) return "unknown";
  const users = groups.find((g) => g.id === "users");
  if (users && users.state === "down") return "down";
  if (groups.some((g) => hurtsPeople(g))) return "slow";
  if (rows.filter((r) => r.slow && r.kind !== "balancer").length >= SLOW_TARGETS_MIN) return "slow";
  return "up";
}

/** Плохо ли людям от состояния группы — см. `overallOf`. */
export function hurtsPeople(g) {
  if (g.state === "down") return true;
  if (g.state !== "warn") return false;
  // Отказ, на котором люди НЕ уходят на запасной (DNS с неверным адресом, балансировщик с кодом
  // ошибки), — беда для части людей, даже если второй исправен.
  if (g.rows.some((r) => r.misleads)) return true;
  // Жёлтая группа взаимозаменяемых частей — это резерв, а жёлтый сертификат — срок, не отказ.
  return !(g.redundant || g.kind === "cert");
}

/**
 * ОГОВОРКА К ЗЕЛЁНОМУ СВОДУ: людям всё работает, но запас не полон. `null` — оговорки нет.
 * Публична, поэтому без провайдеров: только смысл для человека.
 */
export function noticeOf(groups, overall) {
  if (overall !== "up") return null;
  // Только группы, которые ВИДНЫ на странице: оговорка про сертификат, которого на странице нет
  // (`onPage: false`, решение владельца 25.10.2026), была бы фразой ни о чём. О сертификате на
  // исходе владелец узнаёт из канала.
  const soft = groups.filter((g) => g.state === "warn" && g.onPage !== false);
  if (soft.length === 0) return null;
  return "Резерв частично недоступен — на работу это не влияет.";
}

const RANK = { up: 0, warn: 1, down: 2 };

/**
 * ДВА КРУГА ПОДРЯД ДЛЯ ПРОБ ЧЕРЕЗ ДОРОГУ NL → РФ (`confirm` у группы; 25.10.2026).
 *
 * 🔴 ПОВОД. 22:41 МСК пришло «🟡 Внимание: DNS 2 — ns1/ns2.yandexcloud.net не ответили за 3000 мс»,
 * в 22:42 — «✅ Работает». С прода в ту же минуту оба сервера имён Яндекса отвечали верно: терялись
 * пакеты UDP на пути от наблюдателя, а не DNS. Балансировщики опрашиваются по той же дороге.
 * Сообщение о сбое, которого не было, учит канал не читать сообщения о сбоях.
 *
 * ⚠️ ПОЭТОМУ УХУДШЕНИЕ строки в такой группе принимается, только если его видно `confirm` кругов
 * подряд. До того строка показывает ПРЕЖНЕЕ состояние — на странице, в табло, в своде и в канале, —
 * а сам первый сбой запоминается в истории (`suspect`, `suspectRounds`) и виден только в журнале
 * машины. Улучшение принимается сразу: задерживать хорошую новость незачем.
 *
 * ⚠️ СТРАНИЦЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ НЕ ЗАДЕРЖИВАЮТСЯ: у их группы `confirm` нет, красное по ним — сразу.
 * Цена задержки для DNS и балансировщиков — одна минута, и это «один из двух», который людям не
 * мешает; когда лежат оба, люди это видят по страницам — те красятся без задержки.
 */
export function hold(group, r, prev) {
  // NL отрезан от России (mesh.mjs) — у ЛЮБОЙ строки, не только с `confirm`: показываем прежнее, а
  // правду пишем в журнал. Прошлого нет — «не проверен», как и было.
  if (r.cutoff) {
    if (!prev) return r;
    const was = prev.state === "unknown" ? prev.known : prev.state;
    if (!(was in RANK)) return r;
    return {
      ...r,
      state: was,
      word: prev.word ?? r.word,
      value: prev.value ?? null,
      ms: prev.ms ?? null,
      slow: prev.slow === true,
      detail: prev.shownDetail ?? prev.value ?? prev.word ?? r.word,
      shownDetail: prev.shownDetail,
      // Серия «первого сбоя» отрезанностью не прерывается и не продолжается: переносим как была.
      suspect: prev.suspect,
      suspectRounds: prev.suspectRounds,
      heldNote: `${r.detail} — показано прежнее`,
    };
  }
  const need = Number(group.confirm ?? 1);
  if (!(need >= 2) || !prev || !(r.state in RANK)) return r;
  // Неверный ответ (DNS отдал чужой адрес, балансировщик ответил кодом ошибки) потерей пакетов не
  // объясняется — это ОТВЕТ, и он бьёт по людям. Не задерживаем (ревью 25.10.2026).
  if (r.misleads) return r;
  const was = prev.state === "unknown" ? prev.known : prev.state;
  if (!(was in RANK)) return r;
  if (RANK[r.state] <= RANK[was]) return r;
  const seen = Number(prev.suspectRounds ?? 0) + 1;
  if (seen >= need) return r;
  return {
    ...r,
    state: was,
    word: prev.word ?? r.word,
    value: prev.value ?? null,
    ms: prev.ms ?? null,
    slow: prev.slow === true,
    misleads: false,
    suspect: r.state,
    suspectRounds: seen,
    // Табло видит прежнее (`detail`), журнал машины — правду о первом сбое (`heldNote`).
    detail: prev.shownDetail ?? prev.value ?? prev.word ?? r.word,
    shownDetail: prev.shownDetail,
    heldNote: `первый сбой, ждём подтверждения следующим кругом (${r.word} — ${r.detail})`,
  };
}

/**
 * Строки прошлого `history.json` (только текущей раскладки) по `id` — вход для `hold`.
 *
 * ⚠️ ТОЛЬКО ЕСЛИ ПРОШЛЫЙ КРУГ БЫЛ НЕДАВНО (ревью 25.10.2026). «Два круга подряд» — это две минуты,
 * а не «две записи когда-нибудь»: после часа простоя наблюдателя первый сбой засчитался бы вторым.
 * Старее `maxAgeMs` — прошлого для удержания нет, и сбой снова начинается с первого.
 */
export function previousRows(previous, { now = Date.now(), maxAgeMs = 3 * 60_000 } = {}) {
  const out = {};
  if (previous?.layout !== LAYOUT || !Array.isArray(previous.groups)) return out;
  const at = Date.parse(previous.updatedAt ?? "");
  if (!Number.isFinite(at) || now - at > maxAgeMs || at - now > maxAgeMs) return out;
  for (const g of previous.groups) for (const r of g.rows ?? []) if (r?.id) out[r.id] = r;
  return out;
}

/**
 * Всё вместе: конфиг + сырые пробы (по `row.id`) → `{ groups, overall, notice }`.
 * `opts.prevRows` — строки прошлого `history.json` по `id` (для `hold`).
 */
export function evaluate(config, raw, opts = {}) {
  const balancers = config.groups.find((g) => g.kind === "balancer")?.rows ?? [];
  const prevRows = opts.prevRows ?? {};
  // Балансировщики, чей первый сбой удержан (`hold`). Сертификат читается с тех же адресов по той же
  // дороге: его отказ с такого адреса — тот же первый сбой, и называть его в табло («Балансировщик 2:
  // не проверен») значило бы показать удержанное (ревью 25.10.2026).
  const heldDoors = new Set();
  const rawFor = (g, row) => {
    const r = raw[row.id];
    if (g.kind !== "cert" || heldDoors.size === 0 || !r?.perDoor) return r;
    return { ...r, perDoor: r.perDoor.filter((d) => d.ok || !heldDoors.has(d.door)) };
  };
  const groups = config.groups.map((g) => {
    const rows = g.rows.map((row) => {
      const input = rawFor(g, row);
      const r = hold(g, evalRow(g, row, input, { ...opts, balancers }), prevRows[row.id]);
      // Сертификат остался только с удержанных адресов (их отказы отброшены) — он тоже удержан:
      // показываем прошлое, а не «не проверен — не с кем было проверить».
      const prev = prevRows[row.id];
      if (g.kind === "cert" && input?.perDoor?.length === 0 && raw[row.id]?.perDoor?.length > 0 && prev) {
        return { ...r, state: prev.state, known: prev.known, word: prev.word ?? r.word, value: prev.value ?? null, suspect: "unknown", suspectRounds: 0, detail: prev.shownDetail ?? prev.value ?? prev.word ?? r.word, heldNote: "сертификат не прочитан: балансировщики в первом сбое" };
      }
      return r;
    });
    // Тот же довод для «из Европы не видно, из России видно» (mesh.mjs): сертификат с такого адреса
    // из Европы не читается по той же дороге, и «не проверен» про него — пометка о дороге, а не о нём.
    if (g.kind === "balancer") for (const r of rows) if (r.suspect || r.viaRU || r.cutoff) heldDoors.add(r.id);
    const state = groupState(rows);
    // У «одного из двух», на котором люди НЕ уходят на запасной, своя фраза (`say.misleads`):
    // «вход работает через второй» там была бы неправдой.
    const key = state === "warn" && rows.some((r) => r.misleads) && g.say?.misleads ? "misleads" : state;
    const summary = state === "warn" || state === "down" ? (g.say?.[key] ?? g.say?.down ?? null) : null;
    return { id: g.id, title: g.title, kind: g.kind, redundant: g.redundant === true, onPage: g.onPage !== false, state, summary, rows };
  });
  const overall = overallOf(groups);
  return { groups, overall, notice: noticeOf(groups, overall) };
}

/**
 * ПУБЛИКУЕМЫЙ ВИД — копируются ТОЛЬКО перечисленные поля. `detail`, `label`, `error` — частные и
 * сюда не попадают по построению (см. шапку файла).
 */
export function publicView(view, latencyOf = () => undefined, prevStates = {}) {
  return view.groups.map((g) => ({
    id: g.id,
    title: g.title,
    // Рисовать ли группу на странице. В JSON она остаётся: по ней круг помнит прошлое состояние.
    onPage: g.onPage !== false,
    state: g.state,
    summary: g.summary,
    rows: g.rows.map((r) => {
      const out = { id: r.id, name: r.name, state: r.state, word: r.word, value: r.value, ms: r.ms, slow: r.slow };
      /**
       * `known` — последнее ИЗВЕСТНОЕ состояние строки, пока она «не проверена» (ревью 25.10.2026).
       * Без него «не проверен» стирал прошлое: оба балансировщика легли → сертификат «не проверен»
       * → балансировщик поднялся с истёкшим сертификатом, а смены «из ничего» событием не считаются,
       * и «Сбой: Сертификат» не уходил бы никогда.
       */
      if (r.state === "unknown" && prevStates[r.id] && prevStates[r.id] !== "unknown") out.known = prevStates[r.id];
      // Первый сбой, ещё не подтверждённый вторым кругом (`hold`). Страница и канал его не видят —
      // хранится, чтобы следующий круг знал, что это уже второй.
      if (r.suspect) {
        out.suspect = r.suspect;
        out.suspectRounds = r.suspectRounds;
      }
      // Для удержания: что табло показывало по строке (без провайдеров и адресов). Страница не рисует.
      if (r.shownDetail) out.shownDetail = r.shownDetail;
      const lat = latencyOf(r);
      if (lat) out.latency = lat;
      return out;
    }),
  }));
}

/**
 * СОВМЕСТИМОЕ `current` — то, что читает точка состояния в кабинетах ztl-lab
 * (`packages/ui/src/lib/status-snapshot.ts`: `current[имя].ok` и `.ms`, плюс `overall`, `updatedAt`).
 *
 * ⚠️ ТОЛЬКО СТРОКИ «РАБОТАЕТ / НЕ ОТВЕЧАЕТ» — страницы и сервер. Окно в кабинете показывает
 * `current` списком со словами «работает / не отвечает» и временем ответа; «Сертификат · работает»
 * или «DNS 1 · 0 мс» там читались бы бессмыслицей, а жёлтое состояние строки в `ok` не выражается.
 * Устройство целиком — в `groups`, свод — в `overall`, и он учитывает всё.
 */
export function compatCurrent(view, { now, urls = {}, latencyOf = () => undefined }) {
  const out = {};
  for (const g of view.groups) {
    if (g.kind !== "http" && g.kind !== "ready") continue;
    for (const r of g.rows) {
      if (r.state === "unknown") continue;
      out[r.name] = { ok: r.state === "up", status: r.status ?? 0, ms: r.ms, checkedAt: now, url: urls[r.id] ?? null, latency: latencyOf(r) ?? null };
    }
  }
  return out;
}

/**
 * Прошлые состояния строк — по `id`, из прошлого `history.json`.
 *
 * 🔴 ПЕРЕХОД НА НОВУЮ РАСКЛАДКУ НЕ ШЛЁТ «УПАЛО / ПОДНЯЛОСЬ» ПО НОВЫМ СТРОКАМ. У строки, которой в
 * прошлом не было, состояние `undefined`, а смена с `undefined` событием не считается — ровно как
 * первый в жизни круг. Иначе выкат в спокойный день разослал бы в канал «работает: Балансировщик
 * 1, Балансировщик 2, DNS 1, …» — пост ни о чём, который учит канал не читать.
 *
 * Строки, жившие и в прежней раскладке (страницы — под тем же именем, «Сервер и база» — под
 * именем из `was`: «API и его зависимости», тот же `/health/ready`), берут прошлое из прежнего
 * `current`: сбой, пришедшийся ровно на выкат, иначе прошёл бы молча.
 */
export function previousStates(previous, config) {
  const out = {};
  if (previous?.layout === LAYOUT && Array.isArray(previous.groups)) {
    for (const g of previous.groups) {
      for (const r of g.rows ?? []) if (r?.id) out[r.id] = r.state === "unknown" && r.known ? r.known : r.state;
    }
    return out;
  }
  for (const g of config.groups) {
    if (g.kind !== "http" && g.kind !== "ready") continue;
    for (const row of g.rows) {
      const was = previous?.current?.[row.was ?? row.name];
      if (was && typeof was.ok === "boolean") out[row.id] = was.ok ? "up" : "down";
    }
  }
  return out;
}

/** Фраза события без имени: «не отвечает», «снова работает», «скоро истекает». */
function phraseOf(row) {
  if (row.state === "up") return row.kind === "ready" ? "снова работают" : row.kind === "cert" ? "снова в порядке" : "снова работает";
  return row.word;
}

/**
 * Смены состояния строк. Возвращает `{ events, down, warn, up }` — события для истории и три
 * корзины по НОВОМУ состоянию, для сообщений в канал.
 *
 * Смена из «не проверен» и в «не проверен» событием не считается: «мы не смогли посмотреть» — не
 * «упало» и не «поднялось».
 */
export function transitions(view, prevStates, now) {
  const events = [];
  const down = [];
  const warn = [];
  const up = [];
  for (const g of view.groups) {
    for (const r of g.rows) {
      const was = prevStates[r.id];
      if (was === undefined || was === "unknown" || r.state === "unknown" || was === r.state) continue;
      const item = { group: g, row: r, from: was };
      /**
       * Корзина — по тому, что это значит для ЛЮДЕЙ, а не по цвету строки. Лёг один балансировщик
       * или один DNS при живом втором (`redundant`, группа жёлтая) — это «внимание», а не «сбой»:
       * вход работает, а красное сообщение на каждый такой случай обесценило бы красное вообще.
       * Лёг второй — группа красная, и та же строка уходит уже «сбоем».
       */
      if (r.state === "up") up.push(item);
      // Отказ, на котором люди не уходят на запасной (`misleads`), — «сбой» и при живом втором.
      else if (r.state === "down" && (r.misleads || !(g.redundant && g.state !== "down"))) down.push(item);
      else warn.push(item);
      events.push({
        at: now,
        target: r.name,
        group: g.title,
        // Прежнее поле `state` сохранено: «упал» / «поднялся» читают старые разборы истории.
        state: r.state === "down" ? "упал" : r.state === "up" ? "поднялся" : "внимание",
        from: was,
        to: r.state,
        phrase: phraseOf(r),
        status: r.status ?? null,
        // Причина — только у страниц и сервера, и без адресов: у балансировщиков и DNS она
        // называет провайдера и адрес, а это место публичное.
        error: g.kind === "http" || g.kind === "ready" ? redact(r.error ?? null) : null,
      });
    }
  }
  return { events, down, warn, up };
}

/** Имя строки для канала: с провайдером, если он есть. */
export function privateName(r) {
  const who = [r.label, r.ip].filter(Boolean).join(", ");
  return who ? `${r.name} (${who})` : r.name;
}

/**
 * СООБЩЕНИЯ В КАНАЛ О СМЕНЕ СОСТОЯНИЯ — по одному на корзину, коротко.
 *
 * ТЕКСТЫ КОРОТКИЕ — ТРЕБОВАНИЕ, А НЕ СТИЛЬ (решение владельца 28.08.2026): что не работает, что
 * этим занимаются, куда смотреть. Подробность — одна строка на строку таблицы, с провайдером и
 * причиной: канал читает владелец, ему надо понимать, кто есть кто. Сводка группы («вход работает
 * через второй») — затем, чтобы по одному сообщению было ясно, страшно это или нет.
 */
export function alertTexts({ down, warn, up }, view, stamp, statusPage, matrix = []) {
  const out = [];
  // Матрица «кто кого видит» (mesh.mjs) — курсивом под причиной: сколько мест не видит цель.
  const seen = matrix.length ? [`<i>${matrix.map(esc).join("\n")}</i>`] : [];
  const lines = (items) =>
    items.map(({ row }) => `${esc(privateName(row))}: ${esc(row.state === "up" ? row.word : `${row.word} — ${row.detail}`)}`);
  const summaries = (items) => [...new Set(items.map(({ group }) => view.groups.find((g) => g.id === group.id)?.summary).filter(Boolean))];
  if (down.length) {
    out.push(
      [
        `🔴 <b>Сбой: ${esc(down.map(({ row }) => row.name).join(", "))}</b>`,
        ...lines(down),
        ...summaries(down).map(esc),
        ...seen,
        `${stamp} МСК · работаем над восстановлением.`,
        `<a href="${statusPage}">Подробности</a>`,
      ].join("\n"),
    );
  }
  if (warn.length) {
    out.push(
      [
        `🟡 <b>Внимание: ${esc(warn.map(({ row }) => row.name).join(", "))}</b>`,
        ...lines(warn),
        ...summaries(warn).map(esc),
        ...seen,
        `${stamp} МСК`,
        `<a href="${statusPage}">Подробности</a>`,
      ].join("\n"),
    );
  }
  if (up.length) {
    // Если в группе ещё не всё в порядке («из двух поднялся один») — это говорится тут же: иначе
    // «Работает: Балансировщик 1» читалось бы как «всё починили».
    out.push(
      [`✅ <b>Работает: ${esc(up.map(({ row }) => row.name).join(", "))}</b>`, ...summaries(up).map(esc), `${stamp} МСК`].join("\n"),
    );
  }
  return out;
}

/** Значок строки для канала. 🟡 — ответила, но медленно, или «внимание». */
export function icon(r) {
  if (r.state === "down") return "🔴";
  if (r.state === "warn" || r.slow) return "🟡";
  if (r.state === "unknown") return "⚪";
  return "✅";
}
