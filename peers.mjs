/**
 * ДВЕ ДВЕРИ — ДВЕ ТОЧКИ НАБЛЮДЕНИЯ (решение владельца 01.11.2026).
 *
 * 🔴 ЗАЧЕМ. Наблюдатель в NL стал из России недоступен (адрес заблокирован), а дорога NL ↔ РФ
 * рвалась и раньше — тревоги «не работает» шли о сбоях, которых у людей не было. Клиенты в России,
 * и смотреть надо оттуда же: каждая дверь (балансировщик) опрашивает всё сама.
 *
 * ПРАВИЛО СВЕДЕНИЯ (`mergePeer`):
 *   · продукт (страницы, сервер, DNS, сертификат) РАБОТАЕТ, если его видит ХОТЯ БЫ ОДНА дверь:
 *     свой отказ заменяется удачей соседки (`viaPeer`) — значит, моросит дверь, а не продукт;
 *   · о самой ДВЕРИ судит СОСЕДКА. Своё «я жива» не считается: дверь, которую не видно снаружи,
 *     сама себе отвечает нормально. Своё наблюдение о себе — только пока соседки нет;
 *   · о соседке судит своё наблюдение (её «я жива» не считается по той же причине).
 *
 * КТО ШЛЁТ В TELEGRAM (`mayTalk`): основная дверь (Yandex) — всегда; запасная — только когда данных
 * основной нет или они старые, то есть основная не может сказать сама. Иначе каждое сообщение
 * приходило бы дважды.
 *
 * ⚠️ ЧИСТЫЕ ФУНКЦИИ — ОТДЕЛЬНО ОТ СЕТИ: правила проверяются образцами (`peers.test.mjs`).
 */

/** Данные соседки старше — не точка наблюдения: она молчит, и решать за неё нельзя. */
export const PEER_MAX_AGE_S = 180;

/** Своё наблюдение для соседки: публикуется на своей странице, соседка его забирает. */
export const POINT_FILE = "data/point.json";

/** Наблюдение одной двери: кто, когда и сырые результаты проб. */
export function pointOf(selfId, raw, at) {
  return { self: selfId, at, raw };
}

/** Свежее ли наблюдение соседки. Испорченное, чужое по форме или из будущего — не свежее. */
export function peerFresh(peer, nowMs, maxAgeS = PEER_MAX_AGE_S) {
  if (!peer || typeof peer !== "object" || typeof peer.at !== "string" || !peer.raw || typeof peer.raw !== "object") return false;
  const age = (nowMs - Date.parse(peer.at)) / 1000;
  return Number.isFinite(age) && age >= -60 && age <= maxAgeS;
}

/** Удачна ли проба: у сертификата — по всем дверям, у прочих — по признаку `ok`. */
export function okOf(r) {
  if (r == null || typeof r !== "object") return false;
  if (Array.isArray(r.perDoor)) return r.perDoor.length > 0 && r.perDoor.every((d) => d && d.ok === true);
  return r.ok === true;
}

/**
 * Свести своё наблюдение с наблюдением соседки. Возвращает `{ raw, fresh, viaPeer }`:
 * `fresh` — была ли соседка точкой наблюдения, `viaPeer` — строки, решённые её наблюдением.
 */
export function mergePeer(raw, peer, { selfId, balancerIds = [], nowMs = Date.now(), maxAgeS = PEER_MAX_AGE_S } = {}) {
  if (!peerFresh(peer, nowMs, maxAgeS)) return { raw, fresh: false, viaPeer: [] };
  const out = { ...raw };
  const viaPeer = [];
  for (const [id, mine] of Object.entries(raw)) {
    const theirs = peer.raw[id];
    if (theirs === undefined) continue;
    if (balancerIds.includes(id)) {
      // О себе — словами соседки; о соседке — своими (её «я жива» ничего не доказывает).
      if (id === selfId) {
        out[id] = { ...theirs, viaPeer: true };
        viaPeer.push(id);
      }
      continue;
    }
    if (!okOf(mine) && okOf(theirs)) {
      out[id] = { ...theirs, viaPeer: true };
      viaPeer.push(id);
    }
  }
  return { raw: out, fresh: true, viaPeer };
}

/** Можно ли этой двери писать в Telegram: основной — всегда, запасной — пока основная молчит. */
export function mayTalk(role, peerIsFresh) {
  return role !== "backup" || !peerIsFresh;
}
