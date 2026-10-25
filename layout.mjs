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
 * `layout.test.mjs` и подменный круг (`FAKE_PROBES` в `check.mjs`). Внутри `check.mjs`, который с
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
  return String(text).replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "…");
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

/** Одна строка из сырой пробы. Возвращает `{ id, name, kind, state, word, value, ms, slow, detail }`. */
export function evalRow(group, row, r, { slowMs = SLOW_MS, balancers = [] } = {}) {
  const base = { id: row.id, name: row.name, kind: group.kind, label: row.label ?? null, ip: row.ip ?? null };
  if (!r) return { ...base, state: "unknown", word: "не проверен", value: null, ms: null, slow: false, detail: "проба не выполнялась" };

  if (group.kind === "http" || group.kind === "balancer") {
    if (r.ok) {
      const slow = typeof r.ms === "number" && r.ms > slowMs;
      return { ...base, state: "up", word: "работает", value: `${r.ms} мс`, ms: r.ms, slow, detail: `${r.ms} мс`, status: r.status };
    }
    return { ...base, state: "down", word: r.status ? "не работает" : "не отвечает", value: null, ms: null, slow: false, detail: httpWhy(r), status: r.status ?? 0, error: r.error ?? null };
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
    return { ...base, state: "down", word: "не отвечают", value: null, ms: null, slow: false, detail: why.join(", "), status: r.status ?? 0, error: r.error ?? null };
  }

  if (group.kind === "dns") {
    const bad = (r.answers ?? []).filter((a) => !a.ok).map((a) => `${a.server}: ${a.error}`);
    const tally = `ответили ${r.answered} из ${r.total}`;
    const detail = [tally, ...bad].join("; ");
    if (r.ok) return { ...base, state: "up", word: "работает", value: null, ms: null, slow: false, detail };
    return { ...base, state: "down", word: r.wrong ? "отвечает неверно" : "не отвечает", value: null, ms: null, slow: false, detail };
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
 * цели, а не о системе. Считаются строки с временем ответа (страницы, балансировщики, сервер).
 */
export function overallOf(groups) {
  const rows = groups.flatMap((g) => g.rows);
  if (rows.length === 0 || rows.every((r) => r.state === "unknown")) return "unknown";
  const users = groups.find((g) => g.id === "users");
  if (users && users.state === "down") return "down";
  if (groups.some((g) => hurtsPeople(g))) return "slow";
  if (rows.filter((r) => r.slow).length >= SLOW_TARGETS_MIN) return "slow";
  return "up";
}

/** Плохо ли людям от состояния группы — см. `overallOf`. */
function hurtsPeople(g) {
  if (g.state === "down") return true;
  if (g.state !== "warn") return false;
  // Жёлтая группа взаимозаменяемых частей — это резерв, а жёлтый сертификат — срок, не отказ.
  return !(g.redundant || g.kind === "cert");
}

/**
 * ОГОВОРКА К ЗЕЛЁНОМУ СВОДУ: людям всё работает, но запас не полон. `null` — оговорки нет.
 * Публична, поэтому без провайдеров: только смысл для человека.
 */
export function noticeOf(groups, overall) {
  if (overall !== "up") return null;
  const soft = groups.filter((g) => g.state === "warn");
  if (soft.length === 0) return null;
  if (soft.every((g) => g.kind === "cert")) return "Сертификат скоро истекает, продлеваем — на работу это не влияет.";
  return "Резерв частично недоступен — на работу это не влияет.";
}

/** Всё вместе: конфиг + сырые пробы (по `row.id`) → `{ groups, overall }`. */
export function evaluate(config, raw, opts = {}) {
  const balancers = config.groups.find((g) => g.kind === "balancer")?.rows ?? [];
  const groups = config.groups.map((g) => {
    const rows = g.rows.map((row) => evalRow(g, row, raw[row.id], { ...opts, balancers }));
    const state = groupState(rows);
    const summary = state === "warn" || state === "down" ? (g.say?.[state] ?? g.say?.down ?? null) : null;
    return { id: g.id, title: g.title, kind: g.kind, redundant: g.redundant === true, state, summary, rows };
  });
  const overall = overallOf(groups);
  return { groups, overall, notice: noticeOf(groups, overall) };
}

/**
 * ПУБЛИКУЕМЫЙ ВИД — копируются ТОЛЬКО перечисленные поля. `detail`, `label`, `error` — частные и
 * сюда не попадают по построению (см. шапку файла).
 */
export function publicView(view, latencyOf = () => undefined) {
  return view.groups.map((g) => ({
    id: g.id,
    title: g.title,
    state: g.state,
    summary: g.summary,
    rows: g.rows.map((r) => {
      const out = { id: r.id, name: r.name, state: r.state, word: r.word, value: r.value, ms: r.ms, slow: r.slow };
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
 * Строки, жившие и в прежней раскладке под ТЕМ ЖЕ ИМЕНЕМ (страницы для пользователей), берут
 * прошлое из прежнего `current`: сбой, пришедшийся ровно на выкат, иначе прошёл бы молча.
 */
export function previousStates(previous, config) {
  const out = {};
  if (previous?.layout === LAYOUT && Array.isArray(previous.groups)) {
    for (const g of previous.groups) for (const r of g.rows ?? []) if (r?.id) out[r.id] = r.state;
    return out;
  }
  const users = config.groups.find((g) => g.id === "users");
  for (const row of users?.rows ?? []) {
    const was = previous?.current?.[row.name];
    if (was && typeof was.ok === "boolean") out[row.id] = was.ok ? "up" : "down";
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
      else if (r.state === "down" && !(g.redundant && g.state !== "down")) down.push(item);
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
export function alertTexts({ down, warn, up }, view, stamp, statusPage) {
  const out = [];
  const lines = (items) =>
    items.map(({ row }) => `${esc(privateName(row))}: ${esc(row.state === "up" ? row.word : `${row.word} — ${row.detail}`)}`);
  const summaries = (items) => [...new Set(items.map(({ group }) => view.groups.find((g) => g.id === group.id)?.summary).filter(Boolean))];
  if (down.length) {
    out.push(
      [
        `🔴 <b>Сбой: ${esc(down.map(({ row }) => row.name).join(", "))}</b>`,
        ...lines(down),
        ...summaries(down).map(esc),
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
