-- Внутренний дашборд — представления поверх журнала событий. Только журнал: он
-- обезличен, только на дозапись и одинаково считается до и после /delete_me.
--
-- DAU и обращения на DAU — в двух разрезах: по всей базе и по роли на момент
-- события. Методика зачёта пока неизвестна, и две возможные метрики требуют
-- противоположных стратегий, поэтому задача — уметь посчитать любой разрез по
-- требованию, а не угадывать. Сумма DAU по ролям может быть больше DAU по всей
-- базе: человек, сменивший роль за день, попадает в обе.

CREATE VIEW metrics_daily_all AS
SELECT
  day_key,
  COUNT(DISTINCT subject_id) AS dau,
  COUNT(*) AS actions,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT subject_id), 0), 2) AS actions_per_dau
FROM events
WHERE is_user_action
GROUP BY day_key;

CREATE VIEW metrics_daily_by_role AS
SELECT
  day_key,
  user_role,
  COUNT(DISTINCT subject_id) AS dau,
  COUNT(*) AS actions,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT subject_id), 0), 2) AS actions_per_dau
FROM events
WHERE is_user_action
GROUP BY day_key, user_role;

-- Сессии по дням: начато, доведено, засчитано, брошено.
CREATE VIEW metrics_sessions_daily AS
SELECT
  day_key,
  COUNT(*) FILTER (WHERE type = 'session_started') AS started,
  COUNT(*) FILTER (WHERE type = 'session_completed') AS completed,
  COUNT(*) FILTER (WHERE type = 'session_completed' AND (payload->>'counted')::boolean) AS counted,
  COUNT(*) FILTER (WHERE type IN ('session_abandoned', 'session_stopped')) AS abandoned,
  COUNT(*) FILTER (WHERE type = 'ping_sent') AS pings_sent,
  COUNT(*) FILTER (WHERE type = 'ping_answered') AS pings_answered,
  COUNT(*) FILTER (WHERE type = 'daily_summary_sent') AS summaries_sent,
  COUNT(*) FILTER (WHERE type = 'daily_summary_confirmed') AS summaries_confirmed
FROM events
GROUP BY day_key;

-- Проверка решения от 22.09.2026: доля доведённых до конца у сессий, где время
-- назвал человек, против тех, где его предложил бот. Если у «своего» времени
-- доля заметно ниже — вернуться к разделению намерения и длительности.
CREATE VIEW metrics_by_minutes_source AS
SELECT
  s.payload->>'minutes_source' AS minutes_source,
  COUNT(*) AS started,
  COUNT(c.id) AS completed,
  COUNT(c.id) FILTER (WHERE (c.payload->>'counted')::boolean) AS counted,
  ROUND(COUNT(c.id)::numeric / NULLIF(COUNT(*), 0), 3) AS completion_rate
FROM events s
LEFT JOIN events c ON c.type = 'session_completed' AND c.session_id = s.session_id
WHERE s.type = 'session_started'
GROUP BY 1;

CREATE VIEW metrics_by_technique AS
SELECT
  s.payload->>'technique' AS technique,
  COUNT(*) AS started,
  COUNT(c.id) AS completed,
  ROUND(COUNT(c.id)::numeric / NULLIF(COUNT(*), 0), 3) AS completion_rate
FROM events s
LEFT JOIN events c ON c.type = 'session_completed' AND c.session_id = s.session_id
WHERE s.type = 'session_started'
GROUP BY 1;

-- Потери outbox: запрос ушёл, ответа нет, переотправки не было.
CREATE VIEW metrics_outbox_uncertain AS
SELECT day_key, payload->>'kind' AS kind, COUNT(*) AS lost
FROM events
WHERE type = 'outbox_uncertain'
GROUP BY day_key, payload->>'kind';
