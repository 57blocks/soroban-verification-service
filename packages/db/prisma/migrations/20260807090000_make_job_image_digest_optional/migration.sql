-- A submitted manifest no longer selects a build environment. cli-58 uses the chain-recorded bldimg;
-- cli-legacy uses recipe_sha256 on Rebuild and resolves it through Environment.
ALTER TABLE "jobs" ALTER COLUMN "image_digest" DROP NOT NULL;
