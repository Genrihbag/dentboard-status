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

const TIMEOUT_MS = 15_000;
const HISTORY = "data/history.json";
/** Сколько событий храним. Не «всю историю»: файл читается целиком при каждом запуске. */
const KEEP_EVENTS = 500;

const { targets } = JSON.parse(readFileSync("targets.json", "utf8"));

/**
 * ⚠️ ОДНА НЕУДАЧА — ЕЩЁ НЕ ОТКАЗ. Сеть между GitHub и РФ бывает капризной, и тревога на каждую
 * потерянную пачку пакетов обучила бы себя игнорировать. Поэтому цель, не ответившая с первого
 * раза, переспрашивается: настоящий отказ переживёт три попытки, случайная потеря — нет.
 */
async function probe(target) {
  const attempts = [];
  for (let i = 0; i < 3; i += 1) {
    const startedAt = Date.now();
    try {
      const res = await fetch(target.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "dentboard-status/1.0 (+https://github.com)" },
      });
      const ms = Date.now() - startedAt;
      /* Перенаправление — законный ответ живого сервера: `dentboard.ru` уводит на www или https.
         Считать его отказом значило бы поднимать тревогу на исправной системе. */
      const ok = res.status === target.expect || (res.status >= 300 && res.status < 400);
      attempts.push({ ok, status: res.status, ms });
      if (ok) return { ok: true, status: res.status, ms, attempts: i + 1 };
    } catch (e) {
      attempts.push({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - startedAt });
    }
  }
  const last = attempts[attempts.length - 1];
  return { ok: false, status: last.status ?? 0, ms: last.ms, error: last.error, attempts: attempts.length };
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    /* Отсутствие настройки — законное состояние (проверка работает, канал не подключён), но оно
       обязано быть ВИДНО: «не настроено» и «отправлено» не должны выглядеть одинаково. */
    console.log("телеграм не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — сообщение не отправлено");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  console.log(`телеграм: ${res.status}`);
}

const previous = existsSync(HISTORY)
  ? JSON.parse(readFileSync(HISTORY, "utf8"))
  : { current: {}, events: [] };

const now = new Date().toISOString();
const results = {};
let changed = false;
const fell = [];
const rose = [];

for (const target of targets) {
  const r = await probe(target);
  results[target.name] = { ok: r.ok, status: r.status, ms: r.ms, checkedAt: now, url: target.url };
  const was = previous.current?.[target.name]?.ok;
  console.log(`${r.ok ? "✅" : "🔴"} ${target.name}: ${r.status || r.error} (${r.ms} мс, попыток ${r.attempts})`);

  if (was !== undefined && was !== r.ok) {
    changed = true;
    (r.ok ? rose : fell).push(target.name);
    previous.events.unshift({
      at: now,
      target: target.name,
      state: r.ok ? "поднялся" : "упал",
      status: r.status,
      error: r.error ?? null,
    });
  }
  /* Первый в жизни запуск состоянием не считается: иначе он поднял бы тревогу «всё упало» на
     пустой истории, а тревога, начавшаяся с ложной, обесценивает все следующие. */
  if (was === undefined) changed = true;
}

const history = { current: results, events: previous.events.slice(0, KEEP_EVENTS), updatedAt: now };
mkdirSync("data", { recursive: true });
writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`);

if (fell.length > 0) {
  await telegram(`🔴 <b>DentBoard недоступен</b>\n\nНе отвечает: ${fell.join(", ")}\n\nПроверено снаружи, с машин GitHub.`);
}
if (rose.length > 0) {
  await telegram(`✅ <b>DentBoard снова доступен</b>\n\nВосстановлено: ${rose.join(", ")}`);
}

/* Признак «коммитить ли» отдаётся оболочке ЯВНО, а не выводится ею из текста вывода: разбор
   чужого текста — способ получить тихое расхождение при первой же правке формулировки. */
writeFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", `changed=${changed}\n`, { flag: "a" });
console.log(`итог: целей ${targets.length}, недоступно ${Object.values(results).filter((r) => !r.ok).length}, состояние менялось: ${changed}`);
