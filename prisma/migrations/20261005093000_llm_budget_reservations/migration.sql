CREATE TABLE "llm_budget_reservations" (
 "id" TEXT NOT NULL,
 "subject_id" TEXT NOT NULL,
 "reserved_at" TIMESTAMP(3) NOT NULL,
 "component_call_id" BIGINT,
 CONSTRAINT "llm_budget_reservations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "llm_budget_reservations_component_call_id_key" ON "llm_budget_reservations"("component_call_id");
CREATE INDEX "llm_budget_reservations_subject_id_reserved_at_idx" ON "llm_budget_reservations"("subject_id", "reserved_at");
