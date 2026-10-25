/**
 * ОПРОС ЦЕЛЕЙ — ПАРАЛЛЕЛЬНО И В ОДНОМ ПРЕДЕЛЕ ВРЕМЕНИ.
 *
 * 🔴 ПОЧЕМУ НЕ ПО ОЧЕРЕДИ — АВАРИЯ 23.10.2026, разбор в `budget.mjs`. Коротко: при ЗАВИСШЕМ
 * сервере (соединение принимается, ответа нет) каждая цель съедала весь свой таймаут, время круга
 * складывалось по целям, и systemd убивал круг до записи результата. Параллельный опрос делает
 * время круга равным времени САМОЙ медленной цели, а не сумме, и не растёт с числом целей.
 *
 * ⚠️ ОДНА НЕУДАЧА — ЕЩЁ НЕ ОТКАЗ. Сеть между наблюдателем и РФ бывает капризной, и тревога на каждую
 * потерянную пачку пакетов обучила бы себя игнорировать. Поэтому цель, не ответившая с первого
 * раза, переспрашивается — но только пока не вышел общий предел: повтор, на который осталось
 * меньше `MIN_RETRY_MS`, не начинается, а уже идущая попытка обрывается на пределе.
 *
 * ⚠️ ОТДЕЛЬНЫМ ФАЙЛОМ ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО `error-detail.mjs`: путь отказа исполняется только при
 * отказе, и проверить его можно лишь настоящим сбоем (`probe.test.mjs`), а `check.mjs` с первой
 * строки читает цели и ходит наружу.
 */
import { describeError } from "./error-detail.mjs";
import { PROBE_BUDGET_MS } from "./budget.mjs";

/** Одна попытка. Не больше остатка общего предела — см. `probeOne`. */
export const ATTEMPT_TIMEOUT_MS = 15_000;
export const MAX_ATTEMPTS = 3;
/** Повтор не начинается, если до предела осталось меньше. */
export const MIN_RETRY_MS = 1_000;

/**
 * Опрашивает все цели разом. Ответ — в порядке `targets`, по одному на цель:
 * `{ ok, status, ms, error?, attempts }`.
 */
export async function probeAll(
  targets,
  { budgetMs = PROBE_BUDGET_MS, attemptTimeoutMs = ATTEMPT_TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS, headers = {} } = {},
) {
  const until = Date.now() + budgetMs;
  return Promise.all(targets.map((target) => probeOne(target, { until, attemptTimeoutMs, maxAttempts, headers })));
}

async function probeOne(target, { until, attemptTimeoutMs, maxAttempts, headers }) {
  const attempts = [];
  for (let i = 0; i < maxAttempts; i += 1) {
    const left = until - Date.now();
    if (left <= 0) break;
    // Повтор, на который осталась доля секунды, обречён: он только добавит «попытку» в отчёт.
    // Первая попытка идёт при любом остатке — иначе цель осталась бы вовсе не опрошенной.
    if (i > 0 && left < Math.min(MIN_RETRY_MS, attemptTimeoutMs)) break;
    const startedAt = Date.now();
    try {
      const signal = AbortSignal.timeout(Math.min(attemptTimeoutMs, left));
      let status;
      let body;
      if (typeof target.attempt === "function") {
        // Своя попытка (балансировщик по адресу — `door-probe.mjs`): те же повторы и тот же
        // предел круга, что у обычной цели, — второй экземпляр логики повторов разошёлся бы молча.
        ({ status, body } = await target.attempt({ signal, headers }));
      } else {
        const res = await fetch(target.url, { redirect: "manual", signal, headers });
        status = res.status;
        if (target.readBody) {
          // Тело нужно готовности: в нём задержки базы и Redis. Недочитанное тело — неудачная
          // попытка с названной причиной (и повтор), а не «200 без тела» с непонятной красной строкой.
          body = await res.text().catch((e) => {
            throw new Error(`тело ответа не дочитано (${describeError(e)})`);
          });
        } else {
          // Тело не нужно — нужен код. Без отмены незабранное тело держит соединение, а сервер,
          // приславший заголовки и зависший на теле, держал бы его до конца процесса.
          await res.body?.cancel().catch(() => {});
        }
      }
      const ms = Date.now() - startedAt;
      /* Перенаправление — законный ответ живого сервера: `dentboard.ru` уводит на www или https.
         Считать его отказом значило бы поднимать тревогу на исправной системе.
         ⚠️ НО НЕ У ГОТОВНОСТИ (`strict`): там 3xx — это не «работает», а чужой ответ вместо нашего. */
      // `accept` — своё правило «ответил сам» (балансировщик: 200 ИЛИ 503 с телом готовности).
      const ok =
        typeof target.accept === "function"
          ? target.accept(status, body)
          : status === target.expect || (!target.strict && status >= 300 && status < 400);
      attempts.push({ ok, status, ms, body });
      if (ok) return { ok: true, status, ms, body, attempts: i + 1 };
    } catch (e) {
      /* 🔴 ПРИЧИНА, А НЕ `e.message` — разбор в `error-detail.mjs`. Зависший сервер здесь даёт
         `TimeoutError`, отказавший — код сети; это два разных звонка хостеру. */
      attempts.push({ ok: false, error: describeError(e), ms: Date.now() - startedAt });
    }
  }
  // Ни одной попытки — предел вышел раньше, чем цель дошла до очереди. При параллельном опросе
  // этого не бывает, но «не опрошена» обязано быть отличимо от «не ответила», а не выглядеть
  // зелёным пустым местом.
  if (attempts.length === 0) {
    return { ok: false, status: 0, ms: 0, error: "не опрошена: предел времени круга вышел", attempts: 0 };
  }
  const last = attempts[attempts.length - 1];
  return { ok: false, status: last.status ?? 0, ms: last.ms, body: last.body, error: last.error, attempts: attempts.length };
}
