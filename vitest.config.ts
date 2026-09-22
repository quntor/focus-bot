import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    // Тесты с базой чистят общие таблицы. Параллельные файлы стирали бы данные
    // друг у друга, а набор маленький — последовательный прогон дешевле
    // изоляции по схемам.
    fileParallelism: false,
  },
})
