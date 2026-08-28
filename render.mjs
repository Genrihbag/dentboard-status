#!/usr/bin/env node
/**
 * Страница статуса. Собирается из `data/history.json` и публикуется на GitHub Pages — то есть
 * ЖИВЁТ ВНЕ НАШЕГО СЕРВЕРА и доступна ровно тогда, когда нужна: во время его недоступности.
 *
 * ⚠️ ПОЭТОМУ ЖЕ СТРАНИЦА СТАТИЧЕСКАЯ И БЕЗ ЗАПРОСОВ К НАМ. Стоило бы ей спрашивать наш API о
 * состоянии — она показывала бы пустоту в единственный момент, ради которого заведена.
 */
import { readFileSync, writeFileSync } from "node:fs";

const h = JSON.parse(readFileSync("data/history.json", "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const when = (iso) => new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });

const services = Object.entries(h.current);
const down = services.filter(([, r]) => !r.ok);
const headline = down.length === 0 ? "Все сервисы работают" : `Недоступно: ${down.map(([n]) => n).join(", ")}`;

const rows = services
  .map(
    ([name, r]) => `
      <tr>
        <td class="name">${esc(name)}</td>
        <td><span class="dot ${r.ok ? "up" : "down"}"></span>${r.ok ? "работает" : "не отвечает"}</td>
        <td class="dim">${r.ok ? `${r.ms} мс` : esc(r.status || "нет ответа")}</td>
      </tr>`,
  )
  .join("");

const events = h.events.length
  ? h.events
      .slice(0, 30)
      .map((e) => `<li><span class="dim">${when(e.at)}</span> — <b>${esc(e.target)}</b> ${e.state === "упал" ? "🔴 упал" : "✅ поднялся"}</li>`)
      .join("")
  : "<li class=\"dim\">Событий пока нет — с момента запуска наблюдения ничего не падало.</li>";

writeFileSync(
  "index.html",
  `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>Статус DentBoard</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#6b7280; --line:#e5e7eb; --up:#16a34a; --down:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f14; --fg:#e5e7eb; --dim:#9ca3af; --line:#1f2937; } }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:640px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .head { padding:1rem; border:1px solid var(--line); border-radius:.75rem; margin:1.5rem 0; }
  .head.ok { border-color:var(--up); } .head.bad { border-color:var(--down); }
  table { width:100%; border-collapse:collapse; }
  td { padding:.6rem 0; border-bottom:1px solid var(--line); }
  .name { font-weight:600; } .dim { color:var(--dim); font-size:.9rem; }
  .dot { display:inline-block; width:.6rem; height:.6rem; border-radius:50%; margin-right:.5rem; }
  .dot.up { background:var(--up); } .dot.down { background:var(--down); }
  ul { padding-left:1.1rem; } li { margin:.35rem 0; }
</style>
</head>
<body>
<main>
  <h1>Статус DentBoard</h1>
  <p class="dim">Проверка снаружи, каждые 5 минут. Обновлено ${when(h.updatedAt)} (МСК).</p>

  <div class="head ${down.length ? "bad" : "ok"}">
    <strong>${esc(headline)}</strong>
  </div>

  <table>${rows}</table>

  <h2 style="font-size:1.1rem; margin-top:2rem">История</h2>
  <ul>${events}</ul>

  <p class="dim" style="margin-top:2rem">
    Страница размещена вне серверов DentBoard, поэтому доступна и во время сбоя.
  </p>
</main>
</body>
</html>
`,
);

console.log(`страница собрана: сервисов ${services.length}, недоступно ${down.length}, событий в истории ${h.events.length}`);
