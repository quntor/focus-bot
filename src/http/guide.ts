import { readFile } from 'node:fs/promises'
import { GUIDE_URL } from '../lib/links.js'

type GuideResource = {
  cacheControl: string
  contentType: string
  load: () => Promise<Buffer>
}

const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const

const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Практическое руководство по работе с Telegram-ботом Фокус: как начать, не бросить и сохранить следующий шаг.">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${GUIDE_URL}">
  <meta property="og:title" content="Как работать с Фокусом">
  <meta property="og:description" content="Как начать, не бросить и сохранить следующий шаг с напарником по фокус-сессиям.">
  <meta property="og:image" content="${GUIDE_URL}/session-cycle-v1.webp">
  <meta name="twitter:card" content="summary_large_image">
  <title>Как работать с Фокусом</title>
  <style>
    :root { color-scheme: light; --ink:#123557; --muted:#536879; --teal:#14877f; --teal-dark:#09665f; --sun:#ffbe32; --paper:#fffdf7; --mist:#edf7f5; --line:#dbe8e5; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:#f6f3eb; color:var(--ink); font:18px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--teal-dark); text-underline-offset:3px; }
    main { width:min(920px,calc(100% - 32px)); margin:24px auto 64px; background:var(--paper); border:1px solid #ebe5d8; border-radius:28px; box-shadow:0 20px 60px rgba(18,53,87,.08); overflow:hidden; }
    header { padding:clamp(32px,7vw,72px); background:linear-gradient(145deg,#e6f5f2 0%,#fff9e9 100%); }
    .eyebrow { margin:0 0 12px; color:var(--teal-dark); font-size:14px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    h1,h2,h3 { line-height:1.16; letter-spacing:-.025em; }
    h1 { max-width:760px; margin:0; font-size:clamp(38px,8vw,70px); }
    h2 { margin:0 0 20px; font-size:clamp(30px,5vw,44px); }
    h3 { margin:0 0 8px; font-size:21px; }
    .lead { max-width:720px; margin:24px 0 0; color:#294d69; font-size:clamp(20px,3vw,25px); }
    .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:28px; }
    .button { display:inline-block; padding:13px 19px; border-radius:13px; background:var(--teal); color:#fff; font-weight:750; text-decoration:none; box-shadow:0 8px 18px rgba(20,135,127,.18); }
    .button.secondary { border:1px solid #b8d8d4; background:rgba(255,255,255,.7); color:var(--teal-dark); box-shadow:none; }
    section { padding:clamp(34px,7vw,66px); border-top:1px solid #eee8dc; }
    .summary { padding:24px; border:1px solid var(--line); border-radius:18px; background:var(--mist); }
    .summary strong { display:block; margin-bottom:6px; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .card { padding:22px; border:1px solid var(--line); border-radius:18px; background:#fff; }
    .card p { margin:0; color:var(--muted); }
    figure { margin:30px 0; }
    figure img { display:block; width:100%; height:auto; border-radius:22px; border:1px solid #e7e2d7; background:#faf7ef; }
    figcaption { margin-top:10px; color:var(--muted); font-size:15px; }
    ol.steps { display:grid; gap:18px; padding:0; list-style:none; counter-reset:step; }
    ol.steps > li { position:relative; padding-left:58px; counter-increment:step; }
    ol.steps > li::before { content:counter(step); position:absolute; left:0; top:0; width:38px; height:38px; display:grid; place-items:center; border-radius:50%; background:var(--ink); color:#fff; font-weight:800; }
    .formula { display:grid; grid-template-columns:1fr auto 1fr auto 1fr; align-items:center; gap:10px; margin:26px 0; }
    .formula span { padding:16px 10px; border-radius:14px; background:var(--mist); text-align:center; font-weight:750; }
    .formula b { color:var(--teal); font-size:24px; }
    .examples { display:grid; gap:14px; }
    .example { padding:18px 20px; border-left:5px solid var(--sun); border-radius:0 14px 14px 0; background:#fff9e9; }
    .example p { margin:4px 0; }
    .bad { color:#765f4a; text-decoration:line-through; }
    .good { color:var(--ink); font-weight:680; }
    .checklist { padding:0; list-style:none; }
    .checklist li { margin:12px 0; padding-left:32px; position:relative; }
    .checklist li::before { content:"✓"; position:absolute; left:0; color:var(--teal); font-weight:900; }
    .note { margin-top:24px; padding:18px 20px; border-radius:14px; background:#f4f5f6; color:#425a6b; font-size:16px; }
    footer { padding:34px clamp(32px,7vw,66px); border-top:1px solid #eee8dc; color:var(--muted); font-size:15px; }
    @media (max-width:680px) { body{font-size:17px} main{width:min(100% - 16px,920px);margin:8px auto 36px;border-radius:20px}.grid{grid-template-columns:1fr}.formula{grid-template-columns:1fr}.formula b{transform:rotate(90deg);justify-self:center} }
    @media (prefers-reduced-motion:reduce) { html{scroll-behavior:auto} }
  </style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">Практическое руководство · 7 минут</p>
    <h1>Как Фокус помогает доводить дела до результата</h1>
    <p class="lead">Это не ещё один список задач. Фокус создаёт короткую договорённость: что именно ты делаешь сейчас, когда вернёшься с результатом и что будет следующим шагом.</p>
    <div class="actions">
      <a class="button" href="https://t.me/my_focuse_bot">Открыть Фокус в Telegram</a>
      <a class="button secondary" href="#first-session">Попробовать первую сессию</a>
    </div>
  </header>

  <section>
    <div class="summary"><strong>Если совсем коротко</strong>Ты выбираешь одно видимое действие. Бот держит рамку времени, возвращает после отвлечения, спрашивает о результате и сохраняет точку продолжения.</div>
  </section>

  <section>
    <h2>Что даёт такой напарник</h2>
    <div class="grid">
      <div class="card"><h3>Легче начать</h3><p>Большая задача превращается в один шаг, который можно сделать за ближайший заход.</p></div>
      <div class="card"><h3>Меньше незаметных срывов</h3><p>Пинг в середине помогает заметить отвлечение и спокойно вернуться, пока день не потерян.</p></div>
      <div class="card"><h3>Понятный финиш</h3><p>После работы фиксируется не ощущение занятости, а результат и следующий конкретный шаг.</p></div>
      <div class="card"><h3>Ритм под тебя</h3><p>Длительность можно менять, а следующие предложения учитывают историю твоих заходов.</p></div>
    </div>
  </section>

  <section>
    <h2>Один цикл работы</h2>
    <figure>
      <img src="/guide/session-cycle-v1.webp" width="1200" height="800" alt="Четыре этапа: выбрать конкретную работу, включить фокус, ответить на проверку и зафиксировать результат">
      <figcaption>Одна сессия — маленькая законченная договорённость, а не обещание «быть продуктивным весь день».</figcaption>
    </figure>
    <ol class="steps">
      <li><h3>Назови, с чего начнёшь</h3>Можно нажать «Начать сессию» сразу и выбрать работу позже. Но чем конкретнее первый шаг, тем легче включиться.</li>
      <li><h3>Согласуй длину</h3>Для новичка бот предложит 40 минут. Если не подходит, выбери короче или длиннее; уже идущий период тоже можно изменить.</li>
      <li><h3>Говори, что происходит</h3>«Отвлекаюсь», «застрял», «эта готова, перехожу к другой» — нормальные рабочие сообщения. Бот предложит безопасное действие и попросит подтверждение.</li>
      <li><h3>Закрой петлю</h3>В конце коротко напиши, что получилось и что делать дальше. Так следующая сессия начинается не с повторного погружения.</li>
    </ol>
  </section>

  <section>
    <h2>Формула хорошего старта</h2>
    <p>Тема вроде «заняться презентацией» заставляет снова принимать решения уже после запуска таймера. Лучше сразу дать себе наблюдаемое действие.</p>
    <figure>
      <img src="/guide/better-intent-v1.webp" width="1200" height="800" loading="lazy" alt="Три шага формулировки: определить результат, выбрать видимое действие и выделить на него период фокуса">
      <figcaption>Результат → ближайшее видимое действие → один защищённый период работы.</figcaption>
    </figure>
    <div class="formula"><span>Что должно измениться?</span><b>→</b><span>Какое действие видно?</span><b>→</b><span>Что сделаю за этот заход?</span></div>
    <div class="examples">
      <div class="example"><p class="bad">«Позанимаюсь презентацией»</p><p class="good">«Соберу структуру из пяти слайдов и напишу заголовок каждого»</p></div>
      <div class="example"><p class="bad">«Надо разобрать почту»</p><p class="good">«Отвечу на три письма, от которых зависят другие люди»</p></div>
      <div class="example"><p class="bad">«Пора делать исследование»</p><p class="good">«Выпишу пять вопросов для первого интервью»</p></div>
    </div>
  </section>

  <section>
    <h2>Best practices: как получать больше пользы</h2>
    <ol class="steps">
      <li><h3>Одна точка входа за раз</h3>Хранить можно много задач, но начинать лучше с одной. Если работа большая, попроси «разобрать» её на шаги.</li>
      <li><h3>Не изображай идеальный день</h3>Сообщай о срыве сразу. Боту полезнее честное «ушёл в мессенджеры», чем молчание до вечера.</li>
      <li><h3>Меняй размер блока, а не ругай себя</h3>Если не начинаешь — сократи период. Если постоянно не хватает времени — увеличь его. Это настройка системы, а не оценка силы воли.</li>
      <li><h3>Оставляй следующий шаг</h3>Фраза «готов черновик; дальше проверить цифры в таблице» экономит разгон в следующем заходе.</li>
      <li><h3>Настрой только полезное</h3>В <code>/settings</code> можно изменить технику, пинги и утреннее сообщение. В <code>/profile</code> — явно записать особенности работы, которые стоит помнить.</li>
    </ol>
    <div class="note">Фокус не меняет задачи и профиль тайком: важные действия подтверждаются, а профиль обновляется только по твоей команде.</div>
  </section>

  <section>
    <h2>Чтобы бот не потерялся в ленте</h2>
    <p>Фокус работает лучше, когда его легко заметить в нужный момент. Потрать минуту на настройку самого чата — это снижает шанс пропустить проверку и забыть о следующей сессии.</p>
    <ol class="steps">
      <li><h3>Закрепи чат наверху</h3>Удерживай чат в списке Telegram и выбери «Закрепить». Тогда Фокус останется рядом, даже когда приходят новые сообщения.</li>
      <li><h3>Поставь отдельный звук</h3>Открой профиль бота → «Уведомления» → «Звук» и выбери узнаваемый сигнал. Так проверку Фокуса можно отличить от обычной ленты, не глядя на экран.</li>
      <li><h3>Добавь в рабочую папку</h3>Если используешь папки Telegram, помести чат в «Работа» или отдельную папку «Фокус». Это создаёт короткий путь к сессии и убирает лишний визуальный шум.</li>
      <li><h3>Не отключай полезные пинги</h3>Если Telegram или папка заглушены, добавь для этого чата исключение. Частоту самих проверок лучше настроить через <code>/settings</code>, а не глушить весь чат.</li>
    </ol>
    <div class="note">Названия пунктов меню могут немного отличаться на iPhone, Android и компьютере; все настройки находятся в профиле или меню чата с ботом.</div>
  </section>

  <section id="first-session">
    <h2>Первая сессия за две минуты</h2>
    <ul class="checklist">
      <li>Открой бота и нажми «Начать сессию».</li>
      <li>Напиши одно действие: например, «набросаю первые три пункта отчёта».</li>
      <li>Если предложенная длина не подходит — выбери «Короче» или «Длиннее».</li>
      <li>В конце оставь результат и следующий шаг одной фразой.</li>
    </ul>
    <div class="actions"><a class="button" href="https://t.me/my_focuse_bot">Начать с Фокусом</a></div>
  </section>

  <footer>Команды и краткую памятку всегда можно снова открыть через <code>/help</code> в боте.</footer>
</main>
</body>
</html>`

const htmlBody = Buffer.from(html)
const assets: Record<string, URL> = {
  '/guide/session-cycle-v1.webp': new URL('../../public/guide/session-cycle-v1.webp', import.meta.url),
  '/guide/better-intent-v1.webp': new URL('../../public/guide/better-intent-v1.webp', import.meta.url),
}

export function guideResource(pathname: string): GuideResource | null {
  if (pathname === '/guide' || pathname === '/guide/') {
    return {
      cacheControl: 'public, max-age=300',
      contentType: 'text/html; charset=utf-8',
      load: async () => htmlBody,
    }
  }
  const asset = assets[pathname]
  if (!asset) return null
  return {
    cacheControl: 'public, max-age=31536000, immutable',
    contentType: 'image/webp',
    load: () => readFile(asset),
  }
}

export { securityHeaders }
