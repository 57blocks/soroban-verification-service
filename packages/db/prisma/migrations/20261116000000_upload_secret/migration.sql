-- SHA-256 of the secret the upload response returned; a submission naming the upload must present it.
ALTER TABLE "uploads" ADD COLUMN "secret_sha256" TEXT;

-- Set by the first submission that names the upload; a later submission cannot change its visibility.
ALTER TABLE "uploads" ADD COLUMN "visibility_locked" BOOLEAN NOT NULL DEFAULT false;
