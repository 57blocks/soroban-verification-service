import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Uploader } from "@irys/upload";
import { Ethereum } from "@irys/upload-ethereum";
import {
  JobsRepository,
  ReportArchiveUploadsRepository,
  SourceArchiveUploadsRepository,
  type JobRecord,
  type StatusLinkOutcome,
} from "@scvs/db";
import {
  appendArchiveReference,
  appendVerifiedSourceCodeUri,
  createResultStorage,
  readLegacyCustody,
  reportKey,
  sourceFileExtension,
  sourceKeyFromFileName,
  sourceSha256FromFileName,
  type WasmStatusWriteResult,
} from "@scvs/storage-layout";
import type { ResultStorage } from "@scvs/storage-layout";
import { DetachedWork, IMAGE_TRUST_LEVELS, reportSha256FromUrl, ScvsLogger, ScvsMetrics, type LegacyCustody } from "@scvs/core";
import { combineStatusLinkOutcomes, toStatusLinkOutcome } from "./status-link-outcome.util.js";
import type { AppConfigService } from "../../config/configuration.js";

type IrysUploader = Awaited<ReturnType<typeof Uploader>>;

// Must agree with storage-layout's readLegacyCustody: both read the same document.
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

type ArchivePayloadKind = "report" | "source";

type ArchiveTags = {
  wasmHash: string;
  contentSha256: string;
  verifierId: string;
  sourceExtension?: string;
};

const SOURCE_CONTENT_TYPES: Record<string, string> = {
  ".tar.gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar.bz2": "application/x-bzip2",
  ".tbz2": "application/x-bzip2",
  ".tar": "application/x-tar",
  ".zip": "application/zip",
};

@Injectable()
export class ArweaveArchiveService implements OnModuleDestroy {
  private readonly logger = new ScvsLogger("arweave-archive");
  private readonly metrics = new ScvsMetrics("arweave-archive", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);
  private uploaderPromise: Promise<IrysUploader> | undefined;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(SourceArchiveUploadsRepository)
    private readonly sourceArchiveUploads: SourceArchiveUploadsRepository,
    @Inject(ReportArchiveUploadsRepository)
    private readonly reportArchiveUploads: ReportArchiveUploadsRepository,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

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
      ...(kind === "source" && tags.sourceExtension ? [{ name: "Source-Extension", value: tags.sourceExtension }] : []),
    ];
  }

  private async uploadToIrys(
    kind: ArchivePayloadKind,
    input: {
      wasmHash: string;
      contentSha256: string;
      bytes: string | Uint8Array;
      verifierId: string;
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

    try {
      const uploader = await this.getUploader();
      const tags = this.buildTags(kind, input);

      const byteLength = typeof input.bytes === "string" ? Buffer.byteLength(input.bytes) : input.bytes.byteLength;
      const [price, balance] = await Promise.all([uploader.getPrice(byteLength, { tags }), uploader.getBalance()]);
      if (balance.lt(price)) {
        return {
          ok: false,
          reason: "insufficient_balance",
          detail: `Wallet balance is below the price of this upload (need ${price.toString()}, have ${balance.toString()}). Fund the wallet manually — this service never auto-funds.`,
        };
      }

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

  scheduleArweaveBackfill(params: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    reportSha256: string;
    reportBytes: string;
    verifierId: string;
  }): void {
    this.detached.start(() =>
      this.backfill(params).catch((error) => {
        this.logger.error("arweave backfill failed", {
          report_sha256: params.reportSha256,
          error: error instanceof Error ? error : String(error),
        });
      }),
    );
  }

  async retryPendingArchive(job: JobRecord): Promise<void> {
    const wasmHash = job.target.wasm_hash;
    const reportSha256 = job.result?.artifact_sha256;
    if (!wasmHash || !reportSha256) {
      this.logger.error(`job ${job.jobId}: pending archive but missing wasm_hash/artifact_sha256 on the row — skipping`);
      return;
    }
    const storage = createResultStorage(this.configService.get("resultStorage", { infer: true }));
    const reportUrl = `${storage.publicRoot}/${reportKey(reportSha256)}`;
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

  // The claim row, not findExistingUpload, is the dedup: the lookup alone races concurrent attempts.
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

    const legacyCustody = legacyCustodyFromReport(reportBytes);

    const { record: claim, won } = await this.reportArchiveUploads.findOrCreate(reportSha256);

    if (claim.status === "done") {
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
      const timeoutMs = this.configService.get("reportArchiveClaimTimeoutMs", { infer: true });
      const staleSince = Date.now() - Date.parse(claim.updatedAt);
      if (staleSince > timeoutMs) {
        await this.reportArchiveUploads.releaseClaim(reportSha256);
        this.logger.warn(`job ${jobId}: reclaimed a stale report-archive upload for ${reportSha256} — the previous claimant never finished`, {
          stale_since_ms: staleSince,
        });
        // Terminates: any claim held after the release is fresh, so the next pass fails the staleness test.
        return this.backfill(params);
      }
      await this.jobs.recordArchiveOutcome(jobId, { archived: false });
      return;
    }

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

  private async markReportClaimDone(jobId: string, reportSha256: string, txId: string): Promise<void> {
    if (await this.reportArchiveUploads.markDone(reportSha256, txId)) return;
    this.logger.warn(
      `job ${jobId}: report-archive claim for ${reportSha256} was reaped while this upload was still running — recording ${txId} anyway`,
    );
  }

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
      statusLink: toStatusLinkOutcome(wrote, { jobId: input.jobId, wasmHash: input.wasmHash, link: "report archive", logger: this.logger, metrics: this.metrics }),
    });
  }

  scheduleSourceArchive(params: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    sourceSha256: string;
    sourceBytes: Uint8Array;
    sourceExtension: string;
    verifierId: string;
  }): void {
    this.detached.start(() =>
      this.sourceBackfill(params).catch((error) => {
        this.logger.error("arweave source backfill failed", {
          source_sha256: params.sourceSha256,
          error: error instanceof Error ? error : String(error),
        });
      }),
    );
  }

  async retryPendingSourceArchive(job: JobRecord): Promise<void> {
    const wasmHash = job.target.wasm_hash;
    const reportUrl = job.result?.artifact_url;
    const sourceSha256 = job.sourceRef.source_sha256;
    const sourceFileName = job.sourceFileName;
    if (!wasmHash || !reportUrl || !sourceSha256 || !sourceFileName) {
      this.logger.error(
        `job ${job.jobId}: pending source archive but missing wasm_hash/artifact_url/source_sha256/source_file_name on the row — skipping`,
      );
      return;
    }
    const storage = createResultStorage(this.configService.get("resultStorage", { infer: true }));
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

  private gatewayUrlFor(txId: string): string {
    return `${this.configService.get("arweave", { infer: true }).gatewayUrl}/${txId}`;
  }

  private async recordArchived(input: {
    jobId: string;
    storage: ResultStorage;
    wasmHash: string;
    reportUrl: string;
    archiveUrl: string;
    txId: string;
  }): Promise<void> {
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
      statusLink: toStatusLinkOutcome(wrote, { jobId: input.jobId, wasmHash: input.wasmHash, link: "source archive", logger: this.logger, metrics: this.metrics }),
    });
  }

  async retryPendingStatusLinks(job: JobRecord): Promise<void> {
    const wasmHash = job.result?.wasm_hash;
    const reportUrl = job.result?.artifact_url;
    if (!wasmHash || !reportUrl) {
      this.logger.error(`job ${job.jobId}: owes a status-document link but carries no published report — holding it`);
      await this.jobs.recordStatusLinkOutcome(job.jobId, { state: "blocked", reason: "manual_hold" });
      return;
    }
    const storage = createResultStorage(this.configService.get("resultStorage", { infer: true }));
    const reportSha256 = reportSha256FromUrl(reportUrl);
    const legacyCustody = reportSha256 ? await readLegacyCustody(storage, reportSha256) : undefined;
    const context = (link: string) => ({ jobId: job.jobId, wasmHash, link, logger: this.logger, metrics: this.metrics });

    const outcomes: StatusLinkOutcome[] = [];
    if (job.archivedTxId && reportSha256) {
      const wrote = await appendArchiveReference(storage, wasmHash, {
        reportUrl,
        reportSha256,
        archiveUrl: this.gatewayUrlFor(job.archivedTxId),
        legacyCustody,
      });
      outcomes.push(toStatusLinkOutcome(wrote, context("report archive")));
    }
    if (job.sourceArchivedTxId) {
      const wrote = await appendVerifiedSourceCodeUri(storage, wasmHash, {
        reportUrl,
        sourceCodeUri: { location: "arweave", url: this.gatewayUrlFor(job.sourceArchivedTxId) },
        legacyCustody,
      });
      outcomes.push(toStatusLinkOutcome(wrote, context("source archive")));
    }
    if (job.sourceFileName) {
      const wrote = await appendVerifiedSourceCodeUri(storage, wasmHash, {
        reportUrl,
        sourceCodeUri: {
          location: "verifier_self_storage",
          url: `${storage.publicRoot}/${sourceKeyFromFileName(job.sourceFileName)}`,
        },
        legacyCustody,
      });
      outcomes.push(toStatusLinkOutcome(wrote, context("source uri")));
    }

    await this.jobs.recordStatusLinkOutcome(job.jobId, combineStatusLinkOutcomes(outcomes));
  }

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
        return this.sourceBackfill(params);
      }
      await this.jobs.recordSourceArchiveOutcome(jobId, { archived: false });
      return;
    }

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

  private async markSourceClaimDone(jobId: string, sourceSha256: string, txId: string): Promise<void> {
    if (await this.sourceArchiveUploads.markDone(sourceSha256, txId)) return;
    this.logger.warn(
      `job ${jobId}: source-archive claim for ${sourceSha256} was reaped while this upload was still running — recording ${txId} anyway`,
    );
  }
}
