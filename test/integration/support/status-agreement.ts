import { env } from "./env.js";
import { http, sleep, type HttpResult } from "./http.js";
import { staticWasmStatusUrl, verifyWasmStatusUrl } from "./routes.js";

/** 2.5x the 60s cache TTL on mutable `wasms/*.json` status objects. */
export const STATUS_AGREEMENT_TIMEOUT_MS = 150_000;

/** Reads the static status object and both dynamic hash spellings until all three agree. */
export async function readStatusFormsUntilAgreed(wasmHash: string): Promise<{
  staticRead: HttpResult;
  dynamicRead: HttpResult;
  uppercaseRead: HttpResult;
}> {
  const deadline = Date.now() + STATUS_AGREEMENT_TIMEOUT_MS;

  for (;;) {
    const staticRead = await http(staticWasmStatusUrl(wasmHash));
    const dynamicRead = await http(verifyWasmStatusUrl(wasmHash));
    const uppercaseRead = await http(verifyWasmStatusUrl(wasmHash.toUpperCase()));

    const agreed =
      staticRead.status === 200 &&
      dynamicRead.text === staticRead.text &&
      uppercaseRead.text === staticRead.text;
    if (agreed || Date.now() >= deadline) return { staticRead, dynamicRead, uppercaseRead };

    await sleep(env.pollIntervalMs);
  }
}
