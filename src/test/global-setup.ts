import { execFileSync } from 'node:child_process'

// Тесты, которые доказывают инварианты (IDOR, гонка /focus, повтор update_id),
// без настоящей базы ничего не доказывают: мок Prisma не знает про уникальные
// индексы. Поэтому базу поднимаем по-настоящему и прогоняем на ней миграции.
//
// Без TEST_DATABASE_URL такие тесты пропускаются локально, но в CI стоит
// REQUIRE_DB=1, и там пропуск — ошибка: иначе зелёная сборка означала бы, что
// главные проверки просто не запускались.
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    if (process.env.REQUIRE_DB === '1') throw new Error('Не задана переменная окружения: TEST_DATABASE_URL')
    return
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
