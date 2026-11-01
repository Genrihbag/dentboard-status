/**
 * ОТПРАВКА В TELEGRAM ЧЕРЕЗ GITHUB (01.11.2026).
 *
 * 🔴 ЗАЧЕМ. Из сетей дверей api.telegram.org недоступен, а GitHub — доступен: дверь запускает
 * задание `telegram-relay.yml` (workflow_dispatch) с текстом, а оно шлёт в канал токеном из
 * секретов репозитория. Включается `STATUS_TG_VIA=github`, доступ — `GITHUB_RELAY_TOKEN`
 * (только Actions: write этого репозитория).
 *
 * ⚠️ ОТВЕТ 204 ЗНАЧИТ «ЗАДАНИЕ ПОСТАВЛЕНО», А НЕ «СООБЩЕНИЕ ДОСТАВЛЕНО». Отказ Telegram виден в
 * журнале задания — оно падает с причиной словами, а GitHub пишет владельцу о красном запуске.
 */
import { signalWithin } from "./budget.mjs";
import { describeError } from "./error-detail.mjs";

export const VIA_GITHUB = process.env.STATUS_TG_VIA === "github";
const RELAY_URL = "https://api.github.com/repos/Genrihbag/dentboard-status/actions/workflows/telegram-relay.yml/dispatches";

/**
 * Поставить задание. `mode` — `message` (новое сообщение) или `board` (поправить закреплённое табло).
 * Возвращает `{ ok, why }`: «не настроено», «сеть», «отказ GitHub» — разные значения, а не один `false`.
 */
export async function dispatchRelay(mode, text, capMs) {
  const token = process.env.GITHUB_RELAY_TOKEN;
  if (!token) return { ok: false, why: "GITHUB_RELAY_TOKEN не задан" };
  let res;
  try {
    res = await fetch(RELAY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "dentboard-status-door",
      },
      body: JSON.stringify({ ref: "main", inputs: { mode, text } }),
      signal: signalWithin(capMs),
    });
  } catch (e) {
    return { ok: false, why: `GitHub не ответил: ${describeError(e)}` };
  }
  if (res.status === 204) return { ok: true, why: "задание поставлено" };
  const body = await res.json().catch(() => ({}));
  return { ok: false, why: `GitHub отказал ${res.status}: ${body.message ?? "ответ не разобран"}` };
}
