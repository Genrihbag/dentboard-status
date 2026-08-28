#!/usr/bin/env node
/**
 * Страница состояния. Собирается из `data/history.json` и публикуется на GitHub Pages — то есть
 * ЖИВЁТ ВНЕ НАШЕГО СЕРВЕРА и доступна ровно тогда, когда нужна: во время его недоступности.
 *
 * ⚠️ ПОЭТОМУ ЖЕ СТРАНИЦА СТАТИЧЕСКАЯ И БЕЗ ЗАПРОСОВ К НАМ. Стоило бы ей спрашивать наш API о
 * состоянии — она показывала бы пустоту в единственный момент, ради которого заведена.
 *
 * 🔴 ОФОРМЛЕНИЕ — ТОКЕНАМИ ПРОДУКТА, А НЕ ПОХОЖИМИ ЦВЕТАМИ НА ГЛАЗ. Значения скопированы из
 * `packages/ui/src/styles/globals.css` (обе темы) вместе с доводами, по которым они такие:
 * например `--primary` светлотой 29 %, а не 32 %, — это замер контраста, а не вкус. Подобрать
 * «примерно такой же teal» означало бы завести второй бренд, который разъедется с первым молча.
 *
 * ⚠️ ПОЧЕМУ КОПИЯ, А НЕ ИМПОРТ. Репозиторий отдельный намеренно (он обязан работать, когда наш
 * недоступен), сборки здесь нет и Tailwind нет. Значит копия неизбежна — но тогда она обязана
 * быть ЧЕСТНОЙ: значения перенесены дословно, источник назван, и при смене темы продукта эти
 * строки правятся следом. Молчаливого расхождения не будет — оно будет видно глазами на первой
 * же странице рядом с сайтом.
 */
import { readFileSync, writeFileSync } from "node:fs";

const h = JSON.parse(readFileSync("data/history.json", "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const when = (iso) =>
  new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });

const services = Object.entries(h.current);
const down = services.filter(([, r]) => !r.ok);
const allOk = down.length === 0;

/** Знак DentBoard — тот же путь, что в `apps/staff-app/src/components/brand.tsx`. */
const MARK = `
<svg viewBox="0 0 566.91 510.23" class="mark" role="img" aria-label="DentBoard" fill="none">
  <path d="M510.21,340.15A113.36,113.36,0,0,1,396.85,453.52H248.32a151,151,0,0,0,73.87-56.64h74.66a56.73,56.73,0,0,0,0-113.46H256.54A70.89,70.89,0,0,1,326,226.77H395.1l1,0h1.46a56.73,56.73,0,0,0-.73-113.45H322.18a151,151,0,0,0-73.92-56.65H396.85A113.37,113.37,0,0,1,471.8,255.11,113,113,0,0,1,510.21,340.15Z" fill="hsl(var(--primary))"/>
  <path d="M283.4,196a85,85,0,0,0-85-82.58h-85V311.83a85,85,0,0,0,170,0l0,0V292h56.69v19.85A141,141,0,0,1,317.28,389l-2.09,3a143.37,143.37,0,0,1-69.7,53.45v0A141.85,141.85,0,0,1,56.69,311.81V56.69H198.42a141.56,141.56,0,0,1,47,8v0a143.34,143.34,0,0,1,69.75,53.46l2.15,3.11A141,141,0,0,1,340.13,196c0,.82,0,1.64,0,2.46v19.85H326a79,79,0,0,0-42.58,12.46Z" fill="hsl(var(--foreground))"/>
  <path d="M315.18,118.17l2.15,3.11a142.09,142.09,0,0,0-71.89-56.61v0A143.34,143.34,0,0,1,315.18,118.17ZM245.49,445.5v0A142.16,142.16,0,0,0,317.28,389l-2.09,3A143.37,143.37,0,0,1,245.49,445.5Z" fill="hsl(var(--foreground))"/>
</svg>`;

const rows = services
  .map(
    ([name, r]) => `
        <li class="row">
          <span class="row-name">${esc(name)}</span>
          <span class="row-state ${r.ok ? "is-up" : "is-down"}">
            <span class="dot" aria-hidden="true"></span>${r.ok ? "работает" : "не отвечает"}
          </span>
          <span class="row-meta">${r.ok ? `${r.ms}&nbsp;мс` : esc(r.status ? `код ${r.status}` : "нет ответа")}</span>
        </li>`,
  )
  .join("");

const events = h.events.length
  ? h.events
      .slice(0, 30)
      .map(
        (e) => `
        <li class="event">
          <span class="event-time">${when(e.at)}</span>
          <span class="event-body"><b>${esc(e.target)}</b> ${e.state === "упал" ? "перестал отвечать" : "снова отвечает"}</span>
        </li>`,
      )
      .join("")
  : `<li class="event event-empty">С момента запуска наблюдения ничего не падало.</li>`;

writeFileSync(
  "index.html",
  `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<meta name="description" content="Состояние сервисов DentBoard: сайт, кабинет лаборатории, кабинет заказчика, API. Проверка снаружи каждые 5 минут.">
<meta name="theme-color" content="#0b1120" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fbfdfe" media="(prefers-color-scheme: light)">
<title>${allOk ? "Все сервисы работают" : "Есть недоступные сервисы"} — состояние DentBoard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Inter — тот же шрифт, что в кабинетах. \`display=swap\`, чтобы текст был виден сразу: страницу
     открывают, когда что-то сломалось, и ждать шрифт в этот момент неуместно. Системный стек в
     fallback обязателен — Google Fonts тоже бывают недоступны. -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap&subset=cyrillic,latin" rel="stylesheet">
<style>
  /* ТОКЕНЫ ПРОДУКТА — дословно из packages/ui/src/styles/globals.css, обе темы. */
  :root {
    --background: 210 40% 99%;
    --foreground: 222 47% 11%;
    --card: 0 0% 100%;
    --primary: 184 77% 29%;
    --muted-foreground: 215 16% 45%;
    --border: 214 32% 91%;
    --success: 142 66% 31%;
    --destructive: 0 72% 51%;
    --accent: 184 52% 94%;
    --radius: 0.625rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: 222 47% 8%;
      --foreground: 210 40% 98%;
      --card: 222 40% 11%;
      --primary: 184 62% 44%;
      --muted-foreground: 215 20% 65%;
      --border: 217 33% 20%;
      /* Светлее дневного (31 %): на тёмном фоне тот же зелёный ушёл бы в грязь. Отдельные
         значения для тёмной темы — правило продукта, а не инверсия дневных. */
      --success: 142 60% 45%;
      --destructive: 0 72% 60%;
      --accent: 185 45% 16%;
    }
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: clamp(1.5rem, 5vw, 3.5rem) 1rem 3rem;
    background: hsl(var(--background));
    color: hsl(var(--foreground));
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 42rem; margin: 0 auto; }

  .brand { display: flex; align-items: center; gap: .625rem; margin-bottom: 2rem; }
  .mark { width: 2rem; height: 2rem; flex: none; }
  .brand-name { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.01em; }
  .brand-name span { color: hsl(var(--primary)); }

  h1 { font-size: clamp(1.5rem, 4vw, 1.875rem); font-weight: 600; letter-spacing: -0.02em; margin: 0 0 .375rem; }
  .sub { color: hsl(var(--muted-foreground)); font-size: .9375rem; margin: 0; }

  /* ГЛАВНАЯ ПЛАШКА. Цвет — не единственный носитель смысла: рядом всегда стои́т слово
     («работают» / «не отвечают»), иначе состояние теряется при дальтонизме и в ч/б печати. */
  .verdict {
    display: flex; align-items: center; gap: .875rem;
    margin: 1.75rem 0;
    padding: 1.125rem 1.25rem;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    background: hsl(var(--card));
  }
  .verdict.ok { border-color: hsl(var(--success) / .45); background: hsl(var(--success) / .07); }
  .verdict.bad { border-color: hsl(var(--destructive) / .5); background: hsl(var(--destructive) / .07); }
  .verdict-icon { flex: none; width: 1.5rem; height: 1.5rem; }
  .verdict.ok .verdict-icon { color: hsl(var(--success)); }
  .verdict.bad .verdict-icon { color: hsl(var(--destructive)); }
  .verdict-text { font-weight: 600; font-size: 1.0625rem; }
  .verdict-note { display: block; font-weight: 400; font-size: .875rem; color: hsl(var(--muted-foreground)); margin-top: .125rem; }

  .card { border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: hsl(var(--card)); overflow: hidden; }
  .card + .card { margin-top: 1.25rem; }
  .card-title { font-size: .8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: .045em;
                color: hsl(var(--muted-foreground)); padding: .875rem 1.25rem; border-bottom: 1px solid hsl(var(--border)); margin: 0; }

  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: .75rem; padding: .875rem 1.25rem; }
  .row + .row { border-top: 1px solid hsl(var(--border)); }
  .row-name { font-weight: 500; flex: 1; min-width: 0; }
  .row-state { display: inline-flex; align-items: center; gap: .5rem; font-size: .875rem; white-space: nowrap; }
  .row-state.is-up { color: hsl(var(--success)); }
  .row-state.is-down { color: hsl(var(--destructive)); }
  .dot { width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; }
  /* Табличные цифры: без них колонка миллисекунд дёргается при каждом обновлении. */
  .row-meta { font-size: .8125rem; color: hsl(var(--muted-foreground)); font-variant-numeric: tabular-nums;
              min-width: 4.5rem; text-align: right; }

  .event { display: flex; gap: .875rem; padding: .75rem 1.25rem; font-size: .875rem; }
  .event + .event { border-top: 1px solid hsl(var(--border)); }
  .event-time { color: hsl(var(--muted-foreground)); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .event-empty { color: hsl(var(--muted-foreground)); }

  footer { margin-top: 2rem; font-size: .8125rem; color: hsl(var(--muted-foreground)); }
  footer a { color: hsl(var(--primary)); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  /* Видимая рамка фокуса — обязательна: страницей пользуются и с клавиатуры. */
  a:focus-visible { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; border-radius: .25rem; }

  @media (max-width: 30rem) {
    .row { flex-wrap: wrap; gap: .375rem .75rem; }
    .row-name { flex-basis: 100%; }
    .row-meta { margin-left: auto; }
    .event { flex-direction: column; gap: .125rem; }
  }
</style>
</head>
<body>
<main>
  <div class="brand">
    ${MARK}
    <span class="brand-name">Dent<span>Board</span></span>
  </div>

  <h1>Состояние сервисов</h1>
  <p class="sub">Проверка снаружи каждые 5 минут. Обновлено ${when(h.updatedAt)} (МСК).</p>

  <div class="verdict ${allOk ? "ok" : "bad"}">
    ${
      allOk
        ? `<svg class="verdict-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`
        : `<svg class="verdict-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`
    }
    <span class="verdict-text">
      ${allOk ? "Все сервисы работают" : `Не отвечают: ${esc(down.map(([n]) => n).join(", "))}`}
      <span class="verdict-note">
        ${allOk ? "Последняя проверка прошла без ошибок." : "Мы уже знаем о сбое — уведомление ушло автоматически."}
      </span>
    </span>
  </div>

  <section class="card">
    <h2 class="card-title">Сервисы</h2>
    <ul>${rows}</ul>
  </section>

  <section class="card">
    <h2 class="card-title">История</h2>
    <ul>${events}</ul>
  </section>

  <footer>
    <p>
      Время — это полный запрос из-за рубежа: дорога, шифрование и генерация страницы вместе.
      Из России отклик заметно меньше.
    </p>
    <p>
      Страница размещена вне серверов DentBoard, поэтому открывается и во время сбоя.
      <a href="https://dentboard.ru">На сайт</a>
    </p>
  </footer>
</main>
</body>
</html>
`,
);

console.log(
  `страница собрана: сервисов ${services.length}, недоступно ${down.length}, событий в истории ${h.events.length}`,
);
