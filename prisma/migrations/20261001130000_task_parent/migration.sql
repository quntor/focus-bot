-- Шаги разбора ссылаются на исходную задачу: в списке видно «шаг 2 из 4»,
-- после последнего шага бот предлагает закрыть исходную, повторный разбор
-- заменяет незакрытые шаги. Удаление исходной строки (только через /delete_me,
-- каскадом по пользователю) отвязывает шаги.
ALTER TABLE "tasks" ADD COLUMN "parent_id" TEXT;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tasks_parent_id_idx" ON "tasks"("parent_id");
