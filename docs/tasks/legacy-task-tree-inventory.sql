-- Read-only. Run only against an explicitly selected database; returns owner/task IDs, depth and current-session flag.
-- No automatic repair: legacy deletions have no operation marker.
BEGIN READ ONLY;
WITH RECURSIVE trees AS (
  SELECT id AS root_id, user_id, id, parent_id, status, 0 AS depth, ARRAY[id] AS path
  FROM tasks WHERE status = 'dropped'
  UNION ALL
  SELECT t.root_id, c.user_id, c.id, c.parent_id, c.status, t.depth + 1, t.path || c.id
  FROM trees t JOIN tasks c ON c.parent_id = t.id AND c.user_id = t.user_id
  WHERE NOT c.id = ANY(t.path)
)
SELECT t.root_id, t.user_id, t.id AS active_descendant_id, t.depth,
       EXISTS (SELECT 1 FROM focus_sessions s
               WHERE s.user_id = t.user_id AND s.task_id = t.id
                 AND s.state IN ('collecting_intent','running','paused')) AS current_session
FROM trees t WHERE t.depth > 0 AND t.status = 'active'
ORDER BY t.root_id, t.depth, t.id;
ROLLBACK;
