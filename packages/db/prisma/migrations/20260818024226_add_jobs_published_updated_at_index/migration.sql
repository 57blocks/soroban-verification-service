-- CreateIndex
CREATE INDEX "jobs_published_updated_at_wasm_hash_idx" ON "jobs"("published_updated_at", "wasm_hash");
