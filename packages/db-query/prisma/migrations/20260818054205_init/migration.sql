-- CreateTable
CREATE TABLE "trusted_verifiers" (
    "verifier_id" TEXT NOT NULL,
    "manifest_url" TEXT NOT NULL,
    "results_root" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bulk_load_url" TEXT,

    CONSTRAINT "trusted_verifiers_pkey" PRIMARY KEY ("verifier_id")
);

-- CreateTable
CREATE TABLE "verification_result" (
    "verifier_id" TEXT NOT NULL,
    "wasm_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "out_of_band" BOOLEAN,
    "recipe" JSONB,
    "verified_source_code_uri" TEXT,
    "results_urls" JSONB,
    "processed_at" TIMESTAMP(3),
    "retrieved_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_result_pkey" PRIMARY KEY ("verifier_id","wasm_hash")
);

-- CreateTable
CREATE TABLE "verifier_sync_cursor" (
    "verifier_id" TEXT NOT NULL,
    "cursor" TEXT,
    "updated_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "verifier_sync_cursor_pkey" PRIMARY KEY ("verifier_id")
);

-- CreateTable
CREATE TABLE "aggregated_wasm_index" (
    "wasm_hash" TEXT NOT NULL,
    "aggregation_updated_at" TIMESTAMP(3) NOT NULL,
    "entries_digest" TEXT NOT NULL,

    CONSTRAINT "aggregated_wasm_index_pkey" PRIMARY KEY ("wasm_hash")
);

-- CreateIndex
CREATE INDEX "verification_result_wasm_hash_idx" ON "verification_result"("wasm_hash");

-- CreateIndex
CREATE INDEX "aggregated_wasm_index_aggregation_updated_at_wasm_hash_idx" ON "aggregated_wasm_index"("aggregation_updated_at", "wasm_hash");
