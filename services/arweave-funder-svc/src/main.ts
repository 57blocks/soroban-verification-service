import "@scvs/config/load-env";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { formatConfigContractLogLine } from "@scvs/config";
import { createKmsClient, createS3Client, kmsKeyRegion, KmsEthereumSigner, TurboClient } from "@scvs/aws";
import { ScvsLogger, ScvsMetrics, type LogFields, type MetricName } from "@scvs/core";
import { JsonRpcChain, S3StateStore, TurboFunderClient } from "./adapters.js";
import { loadFunderConfig, type FunderConfig } from "./config.js";
import { FunderRound, type Telemetry } from "./funder.js";

const HEALTH_HOST = "127.0.0.1";
const logger = new ScvsLogger("arweave-funder");
const metrics = new ScvsMetrics("arweave-funder", { logger });

const telemetry: Telemetry = {
  gauge: (name, value) => metrics.gauge(name as MetricName, value),
  event: (level, msg, raw) => {
    const fields = raw as LogFields | undefined;
    if (level === "error") logger.error(msg, fields);
    else if (level === "warn") logger.warn(msg, fields);
    else logger.log(msg, fields);
  },
};

type Running = { stop(): Promise<void>; server: Server };

export async function start(config: FunderConfig = loadFunderConfig()): Promise<Running> {
  const region = kmsKeyRegion(config.kmsKeyId) ?? config.awsRegion;
  const signer = await KmsEthereumSigner.create(createKmsClient(region), config.kmsKeyId);
  const bundler = new TurboFunderClient(new TurboClient(config.turbo, config.token), signer);
  const store = new S3StateStore(createS3Client({ region: config.awsRegion }), config.stateBucket, config.stateKey);
  const chain = new JsonRpcChain(config.rpcUrl);
  const holder = `${hostname()}/${process.pid}/${randomUUID()}`;
  logger.log("arweave funder ready", {
    funding_address: signer.address,
    approved_address: config.settings.approvedAddress,
    network: config.network,
    token: config.token,
    chain_id: config.settings.chainId,
  });

  let lastSuccess = Date.now();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const round = async (): Promise<void> => {
    try {
      const outcome = await new FunderRound({ ...config.settings, holder }, { chain, bundler, store, signer, telemetry, now: Date.now }).run();
      metrics.counter("arweave_funder_round_total", 1, { outcome });
      if (outcome !== "conflict") lastSuccess = Date.now();
    } catch (error) {
      metrics.counter("arweave_funder_round_total", 1, { outcome: "error" });
      logger.error("arweave funder round failed", { error: error instanceof Error ? error : String(error) });
    }
  };
  const schedule = (): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      current = round().finally(schedule);
    }, config.intervalMs);
  };
  current = round().finally(schedule);

  // Healthy while rounds keep completing; a funder that has stopped working should be replaced, not left to look alive.
  const server = createServer((req, res) => {
    const fresh = Date.now() - lastSuccess < config.intervalMs * 3;
    res.writeHead(req.url === "/health" && fresh ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: fresh }));
  });
  await new Promise<void>((resolve) => server.listen(config.port, HEALTH_HOST, resolve));

  return {
    server,
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await current;
      await releaseLease(store, holder);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Lets the next task start at once instead of waiting out the lease; a failed release only costs that wait. */
async function releaseLease(store: S3StateStore, holder: string): Promise<void> {
  try {
    const { state, version } = await store.load();
    if (state?.lease?.holder !== holder) return;
    delete state.lease;
    await store.save(state, version);
  } catch (error) {
    logger.warn("could not release the funder lease; the next task waits for it to expire", { error: error instanceof Error ? error : String(error) });
  }
}

if (process.env.NODE_ENV !== "test") {
  start()
    .then((running) => {
      // CI asserts this line.
      console.log(formatConfigContractLogLine("arweave-funder-svc"));
      logger.log("health check listening", { host: HEALTH_HOST, path: "/health" });
      const shutdown = (): void => {
        running.stop().finally(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    })
    .catch((error) => {
      logger.error("fatal startup error", { error });
      process.exit(1);
    });
}
