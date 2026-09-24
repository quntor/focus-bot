-- Учёт по Положению конкурса Sber500xDisrupt (24.09.2026).
--
-- Зачётное «обращение к Решению» — вызов решением своих компонентов: модели,
-- skill (системный промт над моделью), инструментов, фоновых систем
-- (Прил. 2, п. 2.2). Действия пользователя обращениями не являются: журнал
-- events по-прежнему нужен для DAU и продуктовых метрик, а вызовы пишутся сюда.

CREATE TABLE "component_calls" (
    "id" BIGSERIAL NOT NULL,
    "subject_id" TEXT NOT NULL,
    "session_id" TEXT,
    "component" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "skill" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "component_calls_created_at_idx" ON "component_calls"("created_at");
CREATE INDEX "component_calls_subject_id_created_at_idx" ON "component_calls"("subject_id", "created_at");

CREATE TABLE "team_subjects" (
    "subject_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_subjects_pkey" PRIMARY KEY ("subject_id")
);

-- Журнал вызовов — только дозапись, как events: его проверяет антифрод.
CREATE TRIGGER component_calls_append_only BEFORE UPDATE OR DELETE ON "component_calls"
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_change();

-- Сутки зачёта — московские (Положение, п. 1.11: все сроки по московскому
-- времени). created_at хранится как UTC без пояса. Ключ дня в поясе
-- пользователя (events.day_key) остаётся для серий и цели дня.
CREATE FUNCTION msk_day(ts TIMESTAMP) RETURNS TEXT AS $$
  SELECT to_char((ts AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')
$$ LANGUAGE sql IMMUTABLE;

-- Зачётные цифры по дням. Трактовки, которые сделаны здесь, а не в записи:
--
-- - DAU: уникальные subject_id с хотя бы одним действием пользователя
--   (is_user_action) за московские сутки. Команда и тестовые аккаунты
--   (team_subjects) исключены — п. 5.1.3.
-- - Обращения — только успешные вызовы (status = 'ok') и только тех, кто в эти
--   сутки входит в DAU: вызов для молчащего человека не делится на его день.
-- - calls_strict — модель + skill: без спорных компонентов.
--   calls_all — плюс инструменты и фоновые системы. Какую засчитают, уточняем
--   у ментора; обе считаются из одного журнала.
CREATE VIEW zachet_daily AS
WITH dau AS (
  SELECT DISTINCT msk_day(e.created_at) AS day_msk, e.subject_id
  FROM events e
  WHERE e.is_user_action
    AND NOT EXISTS (SELECT 1 FROM team_subjects t WHERE t.subject_id = e.subject_id)
),
calls AS (
  SELECT
    msk_day(c.created_at) AS day_msk,
    COUNT(*) FILTER (WHERE c.component = 'llm') AS llm_calls,
    COUNT(*) FILTER (WHERE c.component = 'llm' AND c.skill IS NOT NULL) AS skill_calls,
    COUNT(*) FILTER (WHERE c.component = 'tool') AS tool_calls,
    COUNT(*) FILTER (WHERE c.component = 'background') AS background_calls
  FROM component_calls c
  JOIN dau d ON d.subject_id = c.subject_id AND d.day_msk = msk_day(c.created_at)
  WHERE c.status = 'ok'
  GROUP BY 1
),
days AS (
  SELECT day_msk, COUNT(*) AS dau FROM dau GROUP BY 1
)
SELECT
  d.day_msk,
  d.dau,
  COALESCE(c.llm_calls, 0) AS llm_calls,
  COALESCE(c.skill_calls, 0) AS skill_calls,
  COALESCE(c.tool_calls, 0) AS tool_calls,
  COALESCE(c.background_calls, 0) AS background_calls,
  COALESCE(c.llm_calls + c.skill_calls, 0) AS calls_strict,
  COALESCE(c.llm_calls + c.skill_calls + c.tool_calls + c.background_calls, 0) AS calls_all,
  ROUND(COALESCE(c.llm_calls + c.skill_calls, 0)::numeric / d.dau, 2) AS calls_strict_per_dau,
  ROUND(COALESCE(c.llm_calls + c.skill_calls + c.tool_calls + c.background_calls, 0)::numeric / d.dau, 2) AS calls_all_per_dau
FROM days d
LEFT JOIN calls c ON c.day_msk = d.day_msk;

-- Ошибки вызовов по дням и кодам — Положение требует коды ошибок в выгрузке,
-- а нам они нужны раньше: отказ модели — это ноль обращений в этом касании.
CREATE VIEW component_call_errors AS
SELECT msk_day(created_at) AS day_msk, component, name, status, error_code, COUNT(*) AS calls
FROM component_calls
WHERE status <> 'ok'
GROUP BY 1, 2, 3, 4, 5;
