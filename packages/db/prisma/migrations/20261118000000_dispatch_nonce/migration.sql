-- A random name for one dispatch of a rebuild. The keys its job writes, and the parameters it reads, sit under it,
-- so a link minted for an earlier dispatch can neither read a later one's parameters nor overwrite its outputs.
ALTER TABLE "rebuilds" ADD COLUMN "dispatch_nonce" TEXT;
