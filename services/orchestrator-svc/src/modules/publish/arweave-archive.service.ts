import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Uploader } from "@irys/upload";
import { Ethereum } from "@irys/upload-ethereum";
import {
  JobsRepository,
  ReportArchiveUploadsRepository,
  SourceArchiveUploadsRepository,
  type JobRecord,
} from "@scvs/db";
import {
  appendArchiveReference,
  appendVerifiedSourceCodeUri,
  readLegacyCustody,
  reportKey,
  sourceFileExtension,
  sourceKeyFromFileName,
  sourceSha256FromFileName,
} from "@scvs/storage-layout";
import type { ResultStorage } from "@scvs/storage-layout";
import { IMAGE_TRUST_LEVELS, reportSha256FromUrl, ScvsLogger, type LegacyCustody } from "@scvs/core";
import { buildResultStorage } from "./result-storage.util.js";
import type { AppConfigService } from "../../config/configuration.js";

type IrysUploader = Awaited<ReturnType<typeof Uploader>>;

/** Exported for its own unit test — the two "read the trust level back out of a report" implementations
 * (this one, and storage-layout's `readLegacyCustody`) read the same document and must agree. */
export function legacyCustodyFromReport(reportBytes: string): LegacyCustody | undefined {
  try {
    const report = JSON.parse(reportBytes) as {
      image_trust_level?: unknown;
      build_recipe?: { build_environment?: { trust_level?: unknown } };
    };
    const level = report.image_trust_level ?? report.build_recipe?.build_environment?.trust_level;
    return (IMAGE_TRUST_LEVELS as readonly string[]).includes(level as string)
      ? { imageTrustLevel: level as LegacyCustody["imageTrustLevel"] }
      : undefined;
  } catch {
    return undefined;
  }
}

type UploadOutcome =
  | { ok: true; tx_id: string; archive_url: string }
  | {
      ok: false;
      reason: "arweave_disabled" | "insufficient_balance" | "irys_upload_failed";
      detail: string;
    };

/** The two things this service archives. */
type ArchivePayloadKind = "report" | "source";

type ArchiveTags = {
  wasmHash: string;
  contentSha256: string;
  verifierId: string;
  /** Only meaningful for `kind: "source"` — the `{sha256}{extension}` suffix, e.g. */
  sourceExtension?: string;
};

/** Best-effort map from a known source extension to its real Content-Type. */
const SOURCE_CONTENT_TYPES: Record<string, string> = {
  ".tar.gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar.bz2": "application/x-bzip2",
  ".tbz2": "application/x-bzip2",
  ".tar": "application/x-tar",
  ".zip": "application/zip",
};

@Injectable()
export class ArweaveArchiveService {
  private readonly logger = new ScvsLogger("arweave-archive");
  private uploaderPromise: Promise<IrysUploader> | undefined;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(SourceArchiveUploadsRepository)
    private readonly sourceArchiveUploads: SourceArchiveUploadsRepository,
    @Inject(ReportArchiveUploadsRepository)
    private readonly reportArchiveUploads: ReportArchiveUploadsRepository,
  ) {}

  /**
   * Lazily builds and caches the Irys uploader for this process's lifetime — constructing one calls out to
   * resolve the wallet's address, so it must not happen on every archive attempt.
   */
  private async getUploader(): Promise<IrysUploader> {
    if (!this.uploaderPromise) {
      const config = this.configService.get("arweave", { infer: true });
      let builder = Uploader(Ethereum).withWallet(config.privateKey);
      if (config.rpcUrl) builder = builder.withRpc(config.rpcUrl);
      builder = config.network === "mainnet" ? builder.mainnet() : builder.devnet();
      this.uploaderPromise = Promise.resolve(builder);
    }
    return this.uploaderPromise;
  }

  private buildTags(kind: ArchivePayloadKind, tags: ArchiveTags): { name: string; value: string }[] {
    const contentType =
      kind === "report"
        ? "application/json"
        : (tags.sourceExtension && SOURCE_CONTENT_TYPES[tags.sourceExtension.toLowerCase()]) || "application/octet-stream";
    return [
      { name: "Content-Type", value: contentType },
      { name: "App-Name", value: "Stellar-Verifier" },
      { name: "Wasm_Hash", value: tags.wasmHash },
      { name: kind === "report" ? "Report_Hash" : "Source_Hash", value: tags.contentSha256 },
      { name: "Verifier", value: tags.verifierId },
      // Lossless record of the real extension, independent of the Content-Type best-effort mapping above.
      ...(kind === "source" && tags.sourceExtension ? [{ name: "Source-Extension", value: tags.sourceExtension }] : []),
    ];
  }

  /** Uploads `bytes`. */
  private async uploadToIrys(
    kind: ArchivePayloadKind,
    input: {
      wasmHash: string;
      contentSha256: string;
      bytes: string | Uint8Array;
      verifierId: string;
      /** `kind: "source"` only — see `ArchiveTags.sourceExtension`. */
      sourceExtension?: string;
    },
  ): Promise<UploadOutcome> {
    const config = this.configService.get("arweave", { infer: true });

    if (config.mode === "disabled") {
      return {
        ok: false,
        reason: "arweave_disabled",
        detail: "Arweave archiving is disabled.",
      };
    }

    if (config.mode === "dry-run") {
      const txId = `dryrun-${input.contentSha256.slice(0, 43)}`;
      return { ok: true, tx_id: txId, archive_url: this.gatewayUrlFor(txId) };
    }

    // mode === "irys" from here.
    try {
      const uploader = await this.getUploader();
      const tags = this.buildTags(kind, input);

      const byteLength = typeof input.bytes === "string" ? Buffer.byteLength(input.bytes) : input.bytes.byteLength;
      // Independent requests — parallelized rather than two sequential round-trips.
      const [price, balance] = await Promise.all([uploader.getPrice(byteLength, { tags }), uploader.getBalance()]);
      if (balance.lt(price)) {
        return {
          ok: false,
          reason: "insufficient_balance",
          detail: `Wallet balance is below the price of this upload (need ${price.toString()}, have ${balance.toString()}). Fund the wallet manually — this service never auto-funds.`,
        };
      }

      // `Uploader.upload` accepts `string | Buffer | Readable`.
      const body = typeof input.bytes === "string" ? input.bytes : Buffer.from(input.bytes);
      const receipt = await uploader.upload(body, { tags });
      return { ok: true, tx_id: receipt.id, archive_url: this.gatewayUrlFor(receipt.id) };
    } catch (error) {
      return {
        ok: false,
        reason: "irys_upload_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The duplicate-content guard: called from every archive attempt, live or retry (`backfill`/
   * `sourceBackfill`), before paying to upload.
   */
  private async findExistingUpload(
    kind: ArchivePayloadKind,
    contentSha256: string,
  ): Promise<{ tx_id: string; archive_url: string } | undefined> {
    const config = this.configService.get("arweave", { infer: true });
    if (config.mode !== "irys") return undefined;

    const uploader = await this.getUploader();
    const graphqlUrl = `https://${config.network === "mainnet" ? "arweave" : "devnet"}.irys.xyz/graphql`;
    const tagName = kind === "report" ? "Report_Hash" : "Source_Hash";
    const query = `{
      transactions(owners: ["${uploader.address}"], tags: [
        {name: "App-Name", values: ["Stellar-Verifier"]},
        {name: "${tagName}", values: ["${contentSha256}"]}
      ]) {
        edges { node { id } }
      }
    }`;

    try {
      const response = await fetch(graphqlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) {
        this.logger.error("findExistingUpload query returned a non-OK status — treating as indeterminate, not as no existing upload", {
          status: response.status,
        });
        return undefined;
      }
      const body = (await response.json()) as {
        data?: { transactions?: { edges?: { node: { id: string } }[] } };
        errors?: { message: string }[];
      };
      // Logged here so a dead guard is at least visible, even though the caller's fallback (re-upload) is
      // unchanged for now.
      if (body.errors?.length) {
        this.logger.error("findExistingUpload query returned GraphQL errors — treating as indeterminate, not as no existing upload", {
          errors: body.errors.map((e) => e.message).join("; "),
        });
        return undefined;
      }
      const txId = body.data?.transactions?.edges?.[0]?.node.id;
      return txId ? { tx_id: txId, archive_url: this.gatewayUrlFor(txId) } : undefined;
    } catch (error) {
      this.logger.error("findExistingUpload query failed — treating as no existing upload", {
        error: error instanceof Error ? error : String(error),
      });
      return undefined;
    }
  }

  /** `publish.service.ts` publishes the report + `wasms/<hash>.json` WITHOUT an archive reference first. */
  scheduleArweaveBackfill(params: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    reportSha256: string;
    reportBytes: string;
    verifierId: string;
  }): void {
    void this.backfill(params).catch((error) => {
      // Not the only trace this attempt failed: `archive_pending_since` (set durably by `publish.service.ts`
      // before this was ever scheduled) already survives past this log line, and `ArchiveRecoveryScheduler`
      // retries from it.
      this.logger.error("arweave backfill failed", {
        report_sha256: params.reportSha256,
        error: error instanceof Error ? error : String(error),
      });
    });
  }

  /** The reconciliation scan's entry point (`ArchiveRecoveryScheduler`). */
  async retryPendingArchive(job: JobRecord): Promise<void> {
    const wasmHash = job.target.wasm_hash;
    const reportSha256 = job.result?.artifact_sha256;
    if (!wasmHash || !reportSha256) {
      // Nothing to archive without both — a bug elsewhere (a job never reaches `archivePendingSince` without a
      // published report carrying both), not a case to paper over here.
      this.logger.error(`job ${job.jobId}: pending archive but missing wasm_hash/artifact_sha256 on the row — skipping`);
      return;
    }
    const storage = buildResultStorage(this.configService.get("resultStorage", { infer: true }));
    const reportUrl = `${storage.publicRoot}/${reportKey(reportSha256)}`;
    // reportBytes is not persisted on the job row (only S3 holds the published bytes) — re-read the
    // already-published, immutable report rather than reconstructing it.
    const reportText = await storage.readText(reportKey(reportSha256));
    if (!reportText) {
      this.logger.error(`job ${job.jobId}: pending archive but ${reportKey(reportSha256)} is unreadable — skipping`);
      return;
    }
    await this.backfill({
      jobId: job.jobId,
      storage,
      wasmHash,
      reportUrl,
      reportSha256,
      reportBytes: reportText,
      verifierId: this.configService.get("verifierIdentity", { infer: true }).id,
    });
  }

  /**
   * `findOrCreate` on `reportSha256` — not `findExistingUpload` — is the first check: `findExistingUpload`
   * alone is a check-then-act race across the live publish path and `ArchiveRecoveryScheduler`'s
   * reconciliation tick (or two overlapping ticks) both attempting the same job's report (see
   * archive-and-recovery/decisions/report-archive-dedup-needs-a-claim-row-too.md). Only this call's own
   * claim winner ever reaches `uploadToIrys` — mirrors `sourceBackfill`'s own structure.
   */
  private async backfill(params: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    reportSha256: string;
    reportBytes: string;
    verifierId: string;
  }): Promise<void> {
    const { jobId, storage, wasmHash, reportUrl, reportSha256, reportBytes, verifierId } = params;

    // See findExistingUpload's own doc comment for why this runs unconditionally.
    const legacyCustody = legacyCustodyFromReport(reportBytes);

    const { record: claim, won } = await this.reportArchiveUploads.findOrCreate(reportSha256);

    if (claim.status === "done") {
      // A "done" row without a txId is corrupt — `markDone` never writes one. Publishing
      // `${gateway}/undefined` into wasms/<hash>.json would be worse than not publishing at all, and the
      // document is immutable once written, so drop the row and let the retry rebuild it properly.
      if (!claim.txId) {
        this.logger.error(`job ${jobId}: report-archive claim for ${reportSha256} is "done" with no tx_id — discarding the row so the next attempt can re-archive`);
        await this.reportArchiveUploads.discardCorruptDoneClaim(reportSha256);
        await this.jobs.recordArchiveOutcome(jobId, { archived: false });
        return;
      }
      await this.recordArchivedReport({
        jobId, storage, wasmHash, reportUrl, reportSha256, legacyCustody,
        archiveUrl: this.gatewayUrlFor(claim.txId), txId: claim.txId,
      });
      return;
    }

    if (!won) {
      // No dedicated reaper for a claimant that crashed mid-upload: `archivePendingSince` never gives up, so
      // this branch runs again for the same job on every ArchiveRecoveryScheduler tick — checking staleness
      // here is sufficient.
      const timeoutMs = this.configService.get("reportArchiveClaimTimeoutMs", { infer: true });
      const staleSince = Date.now() - Date.parse(claim.updatedAt);
      if (staleSince > timeoutMs) {
        await this.reportArchiveUploads.releaseClaim(reportSha256);
        this.logger.warn(`job ${jobId}: reclaimed a stale report-archive upload for ${reportSha256} — the previous claimant never finished`, {
          stale_since_ms: staleSince,
        });
        // Terminates: whoever holds the claim after this point holds a FRESH one (this call's own re-INSERT,
        // or a concurrent caller's), so the next pass fails the staleness test above instead of recursing.
        return this.backfill(params);
      }
      await this.jobs.recordArchiveOutcome(jobId, { archived: false });
      return;
    }

    // won === true: this call's INSERT succeeded, so only this call pays.
    const existingUpload = await this.findExistingUpload("report", reportSha256);
    if (existingUpload) {
      await this.markReportClaimDone(jobId, reportSha256, existingUpload.tx_id);
      await this.recordArchivedReport({
        jobId, storage, wasmHash, reportUrl, reportSha256, legacyCustody,
        archiveUrl: existingUpload.archive_url, txId: existingUpload.tx_id,
      });
      return;
    }

    const upload = await this.uploadToIrys("report", { wasmHash, contentSha256: reportSha256, bytes: reportBytes, verifierId });
    if (!upload.ok) {
      await this.reportArchiveUploads.releaseClaim(reportSha256);
      await this.jobs.recordArchiveOutcome(jobId, { archived: false });
      this.logger.warn(`job ${jobId}: archive attempt failed (${upload.reason}) — ${upload.detail}`);
      return;
    }

    await this.markReportClaimDone(jobId, reportSha256, upload.tx_id);
    await this.recordArchivedReport({
      jobId, storage, wasmHash, reportUrl, reportSha256, legacyCustody,
      archiveUrl: upload.archive_url, txId: upload.tx_id,
    });
  }

  /**
   * The upload behind `txId` really happened and was really paid for, so the job records it either way — losing
   * the claim row only means a slow upload outlived `SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS` and someone reaped
   * it. Worth a warning (it means real duplicate spend is in flight), never worth discarding a valid `txId`.
   */
  private async markReportClaimDone(jobId: string, reportSha256: string, txId: string): Promise<void> {
    if (await this.reportArchiveUploads.markDone(reportSha256, txId)) return;
    this.logger.warn(
      `job ${jobId}: report-archive claim for ${reportSha256} was reaped while this upload was still running — recording ${txId} anyway`,
    );
  }

  /**
   * Factors out the "appendArchiveReference + recordArchiveOutcome" pair every `backfill` success branch
   * above shares — same rationale as this file's existing `recordArchived` (the source-archive path).
   */
  private async recordArchivedReport(input: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    reportSha256: string;
    archiveUrl: string;
    txId: string;
    legacyCustody?: LegacyCustody;
  }): Promise<void> {
    const wrote = await appendArchiveReference(input.storage, input.wasmHash, {
      reportUrl: input.reportUrl,
      reportSha256: input.reportSha256,
      archiveUrl: input.archiveUrl,
      legacyCustody: input.legacyCustody,
    });
    await this.jobs.recordArchiveOutcome(input.jobId, {
      archived: true,
      txId: input.txId,
      ...(wrote ? { publishedUpdatedAt: new Date() } : {}),
    });
  }

  /**
   * Schedules archiving a job's source bytes to Arweave (mainnet-source-archive design.md MSA-1) —
   * fire-and-forget, same shape as `scheduleArweaveBackfill`.
   */
  scheduleSourceArchive(params: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    sourceSha256: string;
    sourceBytes: Uint8Array;
    /**
     * The `sourceFileName` suffix after `sourceSha256` — e.g. `.tar.gz` — see `SOURCE_CONTENT_TYPES` and the
     * `Source-Extension` tag this feeds.
     */
    sourceExtension: string;
    verifierId: string;
  }): void {
    void this.sourceBackfill(params).catch((error) => {
      this.logger.error("arweave source backfill failed", {
        source_sha256: params.sourceSha256,
        error: error instanceof Error ? error : String(error),
      });
    });
  }

  /** The source-archive reconciliation scan's entry point (`SourceArchiveRecoveryScheduler`). */
  async retryPendingSourceArchive(job: JobRecord): Promise<void> {
    const wasmHash = job.target.wasm_hash;
    const reportUrl = job.result?.artifact_url;
    const sourceSha256 = job.sourceRef.source_sha256;
    const sourceFileName = job.sourceFileName;
    if (!wasmHash || !reportUrl || !sourceSha256 || !sourceFileName) {
      // Nothing to archive without all four — a bug elsewhere (a job never reaches `sourceArchivePendingSince`
      // without a published report and a durable source), not a case to paper over here.
      this.logger.error(
        `job ${job.jobId}: pending source archive but missing wasm_hash/artifact_url/source_sha256/source_file_name on the row — skipping`,
      );
      return;
    }
    const storage = buildResultStorage(this.configService.get("resultStorage", { infer: true }));
    // sourceBytes is not persisted on the job row (only S3 holds the published bytes) — re-read the
    // already-published, durable source rather than re-fetching from the submitter.
    const sourceBytes = await storage.readBytes(sourceKeyFromFileName(sourceFileName));
    if (!sourceBytes) {
      this.logger.error(`job ${job.jobId}: pending source archive but ${sourceKeyFromFileName(sourceFileName)} is unreadable — skipping`);
      return;
    }
    await this.sourceBackfill({
      jobId: job.jobId,
      storage,
      wasmHash,
      reportUrl,
      sourceSha256: sourceSha256FromFileName(sourceFileName),
      sourceBytes,
      sourceExtension: sourceFileExtension(sourceFileName, sourceSha256FromFileName(sourceFileName)),
      verifierId: this.configService.get("verifierIdentity", { infer: true }).id,
    });
  }

  /**
   * `gatewayUrlFor` mirrors `uploadToIrys`/`findExistingUpload`'s own `${gatewayUrl}/${txId}` construction —
   * the one other place this table's `txId` needs to become a fetchable URL.
   */
  private gatewayUrlFor(txId: string): string {
    return `${this.configService.get("arweave", { infer: true }).gatewayUrl}/${txId}`;
  }

  /** Records this job's outcome against an already-known `txId`. */
  private async recordArchived(input: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    archiveUrl: string;
    txId: string;
  }): Promise<void> {
    // The trust level a pre-SEP entry cannot carry itself, read from our own report artifact.
    const reportSha256 = reportSha256FromUrl(input.reportUrl);
    const legacyCustody = reportSha256 ? await readLegacyCustody(input.storage, reportSha256) : undefined;

    const wrote = await appendVerifiedSourceCodeUri(input.storage, input.wasmHash, {
      reportUrl: input.reportUrl,
      sourceCodeUri: { location: "arweave", url: input.archiveUrl },
      legacyCustody,
    });
    await this.jobs.recordSourceArchiveOutcome(input.jobId, {
      archived: true,
      txId: input.txId,
      ...(wrote ? { publishedUpdatedAt: new Date() } : {}),
    });
  }

  /** `findOrCreate` on `sourceSha256` — not `findExistingUpload`. */
  private async sourceBackfill(params: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    sourceSha256: string;
    sourceBytes: Uint8Array;
    sourceExtension: string;
    verifierId: string;
  }): Promise<void> {
    const { jobId, storage, wasmHash, reportUrl, sourceSha256, sourceBytes, sourceExtension, verifierId } = params;

    const { record: claim, won } = await this.sourceArchiveUploads.findOrCreate(sourceSha256);

    if (claim.status === "done") {
      // Same corrupt-row guard as `backfill`'s — see its comment.
      if (!claim.txId) {
        this.logger.error(`job ${jobId}: source-archive claim for ${sourceSha256} is "done" with no tx_id — discarding the row so the next attempt can re-archive`);
        await this.sourceArchiveUploads.discardCorruptDoneClaim(sourceSha256);
        await this.jobs.recordSourceArchiveOutcome(jobId, { archived: false });
        return;
      }
      await this.recordArchived({
        jobId, storage, wasmHash, reportUrl, archiveUrl: this.gatewayUrlFor(claim.txId), txId: claim.txId,
      });
      return;
    }

    if (!won) {
      const timeoutMs = this.configService.get("sourceArchiveClaimTimeoutMs", { infer: true });
      const staleSince = Date.now() - Date.parse(claim.updatedAt);
      if (staleSince > timeoutMs) {
        await this.sourceArchiveUploads.releaseClaim(sourceSha256);
        this.logger.warn(`job ${jobId}: reclaimed a stale source-archive upload for ${sourceSha256} — the previous claimant never finished`, {
          stale_since_ms: staleSince,
        });
        // Terminates for the same reason `backfill`'s equivalent does — see its comment: any claim held after
        // this point is fresh, so the next pass fails the staleness test instead of recursing again.
        return this.sourceBackfill(params);
      }
      await this.jobs.recordSourceArchiveOutcome(jobId, { archived: false });
      return;
    }

    // won === true: this call's INSERT succeeded, so only this call pays.
    const existingUpload = await this.findExistingUpload("source", sourceSha256);
    if (existingUpload) {
      await this.markSourceClaimDone(jobId, sourceSha256, existingUpload.tx_id);
      await this.recordArchived({
        jobId, storage, wasmHash, reportUrl, archiveUrl: existingUpload.archive_url, txId: existingUpload.tx_id,
      });
      return;
    }

    const upload = await this.uploadToIrys("source", {
      wasmHash,
      contentSha256: sourceSha256,
      bytes: sourceBytes,
      sourceExtension,
      verifierId,
    });
    if (!upload.ok) {
      await this.sourceArchiveUploads.releaseClaim(sourceSha256);
      await this.jobs.recordSourceArchiveOutcome(jobId, { archived: false });
      this.logger.warn(`job ${jobId}: source archive attempt failed (${upload.reason}) — ${upload.detail}`);
      return;
    }

    await this.markSourceClaimDone(jobId, sourceSha256, upload.tx_id);
    await this.recordArchived({
      jobId, storage, wasmHash, reportUrl, archiveUrl: upload.archive_url, txId: upload.tx_id,
    });
  }

  /** `markReportClaimDone`'s source-path twin — same reasoning, see its comment. */
  private async markSourceClaimDone(jobId: string, sourceSha256: string, txId: string): Promise<void> {
    if (await this.sourceArchiveUploads.markDone(sourceSha256, txId)) return;
    this.logger.warn(
      `job ${jobId}: source-archive claim for ${sourceSha256} was reaped while this upload was still running — recording ${txId} anyway`,
    );
  }
}
