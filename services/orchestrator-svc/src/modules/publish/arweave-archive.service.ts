import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
import { createKmsClient, kmsKeyRegion, type KmsSendClient } from "@scvs/aws";
import { combineStatusLinkOutcomes, toStatusLinkOutcome } from "./status-link-outcome.util.js";
import { KmsEthereumSigner } from "./kms-ethereum-signer.js";
import { buildTurboUploader, type ArchiveUploader } from "./turbo-uploader.js";
import { ArweaveConfirmations, type ConfirmationState } from "./arweave-confirmation.js";
import type { AppConfigService } from "../../config/configuration.js";

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
  | { ok: true; tx_id: string; archive_url: string; deadline_height?: number }
  | {
      ok: false;
      reason: "arweave_disabled" | "insufficient_balance" | "upload_failed";
      detail: string;
    };

type ArchivePayloadKind = "report" | "source";

const GATEWAY_TIMEOUT_MS = 15_000;
// 1000 items: far past any legitimate count of copies of one hash, short of a page loop an adversary could drag on.
const EXISTING_UPLOAD_MAX_PAGES = 10;

// An item with no deadline from the bundler (found already uploaded, or its receipt gave none) gets this many blocks
// from when it is first checked: about 7 hours.
const FOUND_UPLOAD_DEADLINE_BLOCKS = 200;

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
export class ArweaveArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("arweave-archive");
  private readonly metrics = new ScvsMetrics("arweave-archive", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);
  private uploaderPromise: Promise<ArchiveUploader> | undefined;
  private kmsSigner: KmsEthereumSigner | undefined;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(SourceArchiveUploadsRepository)
    private readonly sourceArchiveUploads: SourceArchiveUploadsRepository,
    @Inject(ReportArchiveUploadsRepository)
    private readonly reportArchiveUploads: ReportArchiveUploadsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const config = this.configService.get("arweave", { infer: true });
    if (config.mode !== "turbo" || config.signer !== "kms") return;
    const signer = await this.getKmsSigner();
    this.logger.log("arweave KMS signer ready", { address: signer.address, network: config.network });
  }

  protected kmsClient(keyId: string): KmsSendClient {
    const region = kmsKeyRegion(keyId) ?? this.configService.get("awsRegion", { infer: true });
    // An alias or bare key id resolves only in the client's region; a guessed region fails as "not found".
    if (!region) throw new Error("SCVS_ARWEAVE_KMS_KEY_ID is not a key ARN and AWS_REGION is unset — no region to find the key in");
    return createKmsClient(region);
  }

  private async getKmsSigner(): Promise<KmsEthereumSigner> {
    if (!this.kmsSigner) {
      const { kmsKeyId } = this.configService.get("arweave", { infer: true });
      if (!kmsKeyId) throw new Error("SCVS_ARWEAVE_KMS_KEY_ID is required when SCVS_ARWEAVE_SIGNER is kms");
      this.kmsSigner = await KmsEthereumSigner.create(this.kmsClient(kmsKeyId), kmsKeyId);
    }
    return this.kmsSigner;
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  private async getUploader(): Promise<ArchiveUploader> {
    if (!this.uploaderPromise) {
      const promise = this.buildUploader();
      // A failed build (KMS unreachable, permission missing) must not stick: the next attempt retries it.
      promise.catch(() => {
        if (this.uploaderPromise === promise) this.uploaderPromise = undefined;
      });
      this.uploaderPromise = promise;
    }
    return this.uploaderPromise;
  }

  private async buildUploader(): Promise<ArchiveUploader> {
    const config = this.configService.get("arweave", { infer: true });
    const uploader = buildTurboUploader({
      signer: config.signer === "kms" ? { kms: await this.getKmsSigner() } : { privateKey: config.privateKey },
      token: config.token,
      endpoints: config.turbo,
    });
    this.logger.log("arweave uploader ready", { signer: config.signer, address: uploader.address, network: config.network, token: config.token });
    return uploader;
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

  private async uploadToTurbo(
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
      const body = typeof input.bytes === "string" ? Buffer.from(input.bytes) : Buffer.from(input.bytes);
      const result = await uploader.upload(body, this.buildTags(kind, input), config.paidBy);
      if (result.ok) {
        return {
          ok: true,
          tx_id: result.id,
          archive_url: this.gatewayUrlFor(result.id),
          ...(result.deadlineHeight !== undefined ? { deadline_height: result.deadlineHeight } : {}),
        };
      }
      const payer = config.paidBy ?? uploader.address;
      return {
        ok: false,
        reason: "insufficient_balance",
        detail: `Turbo refused the upload for want of credits (HTTP 402): ${payer} holds or has shared too few with ${uploader.address}. The funder tops it up; this service never pays.`,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "upload_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async findExistingUpload(
    kind: ArchivePayloadKind,
    contentSha256: string,
  ): Promise<{ tx_id: string; archive_url: string } | undefined> {
    const config = this.configService.get("arweave", { infer: true });
    if (config.mode !== "turbo") return undefined;

    let uploader: ArchiveUploader;
    try {
      uploader = await this.getUploader();
    } catch (error) {
      this.logger.error("findExistingUpload could not build the uploader — treating as indeterminate; the upload attempt reports it", {
        error: error instanceof Error ? error : String(error),
      });
      return undefined;
    }
    const graphqlUrl = `${config.gatewayUrl}/graphql`;
    // Matched on the owner's key, not its address: gateways do not agree on how they index an Ethereum signer's address.
    // The tags are public, so anyone's items can carry them too; pages are read until ours turns up or they run out.
    const query = `query ($tags: [TagFilter!], $after: String) {
      transactions(first: 100, tags: $tags, after: $after) {
        pageInfo { hasNextPage }
        edges { cursor node { id owner { key } } }
      }
    }`;
    const tags = [
      { name: "App-Name", values: ["Stellar-Verifier"] },
      { name: kind === "report" ? "Report_Hash" : "Source_Hash", values: [contentSha256] },
    ];

    try {
      let after: string | undefined;
      for (let page = 0; page < EXISTING_UPLOAD_MAX_PAGES; page++) {
        const response = await fetch(graphqlUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, variables: { tags, after } }),
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        });
        if (!response.ok) {
          this.logger.error("findExistingUpload query returned a non-OK status — treating as indeterminate, not as no existing upload", {
            status: response.status,
          });
          return undefined;
        }
        const body = (await response.json()) as {
          data?: {
            transactions?: {
              pageInfo?: { hasNextPage?: boolean };
              edges?: { cursor?: string; node: { id: string; owner?: { key?: string } } }[];
            };
          };
          errors?: { message: string }[];
        };
        if (body.errors?.length) {
          this.logger.error("findExistingUpload query returned GraphQL errors — treating as indeterminate, not as no existing upload", {
            errors: body.errors.map((e) => e.message).join("; "),
          });
          return undefined;
        }
        const edges = body.data?.transactions?.edges ?? [];
        const txId = edges.find((edge) => edge.node.owner?.key === uploader.ownerKey)?.node.id;
        if (txId) return { tx_id: txId, archive_url: this.gatewayUrlFor(txId) };
        after = edges.at(-1)?.cursor;
        if (!body.data?.transactions?.pageInfo?.hasNextPage || !after) return undefined;
      }
      this.logger.warn("findExistingUpload read its page limit without finding this service's item — treating as no existing upload", {
        kind,
        content_sha256: contentSha256,
        pages: EXISTING_UPLOAD_MAX_PAGES,
      });
      return undefined;
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

    if (claim.status === "uploaded" && claim.txId) {
      const settled = await this.settleConfirmation("report", jobId, reportSha256, claim.txId, claim.deadlineHeight);
      if (settled === "confirmed") {
        await this.recordArchivedReport({
          jobId, storage, wasmHash, reportUrl, reportSha256, legacyCustody,
          archiveUrl: this.gatewayUrlFor(claim.txId), txId: claim.txId,
        });
      }
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
      if (await this.awaitsConfirmation("report", jobId, reportSha256, existingUpload.tx_id)) return;
      await this.markReportClaimDone(jobId, reportSha256, existingUpload.tx_id);
      await this.recordArchivedReport({
        jobId, storage, wasmHash, reportUrl, reportSha256, legacyCustody,
        archiveUrl: existingUpload.archive_url, txId: existingUpload.tx_id,
      });
      return;
    }

    const upload = await this.uploadToTurbo("report", { wasmHash, contentSha256: reportSha256, bytes: reportBytes, verifierId });
    if (!upload.ok) {
      await this.reportArchiveUploads.releaseClaim(reportSha256);
      await this.jobs.recordArchiveOutcome(jobId, { archived: false });
      this.logger.warn(`job ${jobId}: archive attempt failed (${upload.reason}) — ${upload.detail}`);
      return;
    }

    if (await this.awaitsConfirmation("report", jobId, reportSha256, upload.tx_id, upload.deadline_height)) return;
    await this.markReportClaimDone(jobId, reportSha256, upload.tx_id);
    await this.recordArchivedReport({
      jobId, storage, wasmHash, reportUrl, reportSha256, legacyCustody,
      archiveUrl: upload.archive_url, txId: upload.tx_id,
    });
  }

  private claims(kind: ArchivePayloadKind): ReportArchiveUploadsRepository | SourceArchiveUploadsRepository {
    return kind === "report" ? this.reportArchiveUploads : this.sourceArchiveUploads;
  }

  /**
   * On a network whose items reach Arweave, holds the claim at "uploaded" and leaves the job pending, so the recovery
   * scan links it only once it is confirmed. False where nothing is waited for, and the caller links it at once.
   */
  private async awaitsConfirmation(kind: ArchivePayloadKind, jobId: string, sha256: string, txId: string, deadlineHeight?: number): Promise<boolean> {
    const config = this.configService.get("arweave", { infer: true });
    if (config.confirmations === 0) return false;
    if (deadlineHeight === undefined) {
      try {
        deadlineHeight = (await new ArweaveConfirmations(config.gatewayUrl, config.confirmations).height()) + FOUND_UPLOAD_DEADLINE_BLOCKS;
      } catch (error) {
        this.logger.warn(`job ${jobId}: could not read Arweave's height for ${txId}; it waits for confirmation with no deadline`, {
          error: error instanceof Error ? error : String(error),
        });
      }
    }
    if (!(await this.claims(kind).markUploaded(sha256, txId, deadlineHeight))) {
      this.logger.warn(`job ${jobId}: ${kind}-archive claim for ${sha256} was reaped while this upload was still running — ${txId} is not tracked`);
      return true;
    }
    this.logger.log(`job ${jobId}: ${kind} ${sha256} stored as ${txId}; linking it once it is confirmed on Arweave`, {
      deadline_height: deadlineHeight,
    });
    return true;
  }

  /** Checks an uploaded item against a gateway; an item past its deadline is dropped so the next scan uploads it anew. */
  private async settleConfirmation(
    kind: ArchivePayloadKind,
    jobId: string,
    sha256: string,
    txId: string,
    deadlineHeight?: number,
  ): Promise<ConfirmationState> {
    const config = this.configService.get("arweave", { infer: true });
    const confirmations = new ArweaveConfirmations(config.gatewayUrl, config.confirmations);
    let state: ConfirmationState;
    try {
      if (deadlineHeight === undefined) {
        deadlineHeight = (await confirmations.height()) + FOUND_UPLOAD_DEADLINE_BLOCKS;
        await this.claims(kind).setDeadline(sha256, txId, deadlineHeight);
      }
      state = await confirmations.state(txId, deadlineHeight);
    } catch (error) {
      this.logger.warn(`job ${jobId}: could not check ${txId} on Arweave — trying again on the next scan`, {
        error: error instanceof Error ? error : String(error),
      });
      return "pending";
    }
    if (state === "confirmed") {
      await this.claims(kind).markConfirmed(sha256, txId);
    } else if (state === "overdue") {
      this.metrics.counter("arweave_upload_overdue_total", 1, { kind });
      this.logger.error(`job ${jobId}: ${kind} ${sha256} (${txId}) is not on Arweave past its deadline height ${deadlineHeight} — uploading it again`);
      await this.claims(kind).abandonUpload(sha256, txId);
    }
    return state;
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
    // A republish may have pointed the row at a newer report while this copy was uploading; the earlier report's
    // copy is permanent, but it must not be linked or recorded. The pending flag stays set for the newer report.
    const current = await this.jobs.getJobById(input.jobId);
    if (current?.result?.artifact_sha256 !== input.reportSha256) {
      this.logger.warn(`job ${input.jobId}: archived report ${input.reportSha256} is no longer the job's report — not recording it`);
      return;
    }
    const wrote = await appendArchiveReference(input.storage, input.wasmHash, {
      reportUrl: input.reportUrl,
      reportSha256: input.reportSha256,
      archiveUrl: input.archiveUrl,
      legacyCustody: input.legacyCustody,
    });
    const recorded = await this.jobs.recordArchiveOutcome(input.jobId, {
      archived: true,
      txId: input.txId,
      reportSha256: input.reportSha256,
      statusLink: toStatusLinkOutcome(wrote, { jobId: input.jobId, wasmHash: input.wasmHash, link: "report archive", logger: this.logger, metrics: this.metrics }),
    });
    if (!recorded) {
      this.logger.warn(`job ${input.jobId}: report ${input.reportSha256} was replaced while its copy was being linked — not recording it`);
    }
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

  private gatewayUrlFor(txId: string, gatewayUrl?: string): string {
    return `${gatewayUrl ?? this.configService.get("arweave", { infer: true }).gatewayUrl}/${txId}`;
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
        archiveUrl: this.gatewayUrlFor(job.archivedTxId, job.archivedGatewayUrl),
        legacyCustody,
      });
      outcomes.push(toStatusLinkOutcome(wrote, context("report archive")));
    }
    if (job.sourceArchivedTxId) {
      const wrote = await appendVerifiedSourceCodeUri(storage, wasmHash, {
        reportUrl,
        sourceCodeUri: { location: "arweave", url: this.gatewayUrlFor(job.sourceArchivedTxId, job.sourceArchivedGatewayUrl) },
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

    if (claim.status === "uploaded" && claim.txId) {
      if ((await this.settleConfirmation("source", jobId, sourceSha256, claim.txId, claim.deadlineHeight)) === "confirmed") {
        await this.recordArchived({
          jobId, storage, wasmHash, reportUrl, archiveUrl: this.gatewayUrlFor(claim.txId), txId: claim.txId,
        });
      }
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
      if (await this.awaitsConfirmation("source", jobId, sourceSha256, existingUpload.tx_id)) return;
      await this.markSourceClaimDone(jobId, sourceSha256, existingUpload.tx_id);
      await this.recordArchived({
        jobId, storage, wasmHash, reportUrl, archiveUrl: existingUpload.archive_url, txId: existingUpload.tx_id,
      });
      return;
    }

    const upload = await this.uploadToTurbo("source", {
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

    if (await this.awaitsConfirmation("source", jobId, sourceSha256, upload.tx_id, upload.deadline_height)) return;
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
