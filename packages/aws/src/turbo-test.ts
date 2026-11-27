import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { SigningKey } from "@ethersproject/signing-key";
import { PrivateKeyEthereumSigner } from "./kms-ethereum.js";
import { TurboClient, TurboHttpError } from "./turbo.js";

const ENDPOINTS = { uploadUrl: "https://upload.test", paymentUrl: "https://payment.test" };
const signer = new PrivateKeyEthereumSigner(new SigningKey(`0x${"22".repeat(32)}`).privateKey);
const realFetch = globalThis.fetch;
const PAYER = "0x5CcBd64d5dC1Bb16259C8f332Df22D9999073c3A";
const UPLOADER = "0x85f0Cf63199c798F163Bb81A32Ed6a426c5919A6";

type Seen = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };

function answer(respond: (seen: Seen) => { status: number; body: unknown }): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const request: Seen = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(init.body ? { body: init.body as Uint8Array } : {}),
    };
    seen.push(request);
    const { status, body } = respond(request);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return seen;
}

const idOf = (raw: Uint8Array): string => createHash("sha256").update(Buffer.from(raw).subarray(2, 67)).digest("base64url");

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an upload posts the signed item under the token, bills paidBy, and returns the item's own id", async () => {
  const seen = answer(({ body }) => ({ status: 200, body: { id: idOf(body!), deadlineHeight: 2_050_400 } }));
  const result = await new TurboClient(ENDPOINTS, "base-eth").upload(Buffer.from("{}"), [{ name: "A", value: "b" }], signer, PAYER.toLowerCase());
  assert.equal(seen[0]!.url, "https://upload.test/v1/tx/base-eth");
  assert.equal(seen[0]!.headers["x-paid-by"], PAYER);
  assert.deepEqual(result, { ok: true, id: idOf(seen[0]!.body!), deadlineHeight: 2_050_400 });
});

test("an upload answered 402 reports insufficient credits instead of throwing", async () => {
  answer(() => ({ status: 402, body: { x402Version: 1, accepts: [] } }));
  assert.deepEqual(await new TurboClient(ENDPOINTS, "base-eth").upload(Buffer.from("{}"), [], signer), { ok: false, reason: "insufficient_credits" });
});

test("an upload Turbo acknowledges under another id is refused", async () => {
  answer(() => ({ status: 200, body: { id: "someone-elses" } }));
  await assert.rejects(new TurboClient(ENDPOINTS, "base-eth").upload(Buffer.from("{}"), [], signer), /acknowledged someone-elses/);
});

test("any other status is an error that carries it", async () => {
  answer(() => ({ status: 503, body: "busy" }));
  await assert.rejects(new TurboClient(ENDPOINTS, "base-eth").upload(Buffer.from("{}"), [], signer), (error: unknown) => error instanceof TurboHttpError && error.status === 503);
});

test("an unknown wallet has no balance and no shares", async () => {
  answer(() => ({ status: 404, body: "" }));
  const turbo = new TurboClient(ENDPOINTS, "base-eth");
  assert.equal(await turbo.balance(PAYER), 0n);
  assert.deepEqual(await turbo.sharesGivenBy(PAYER), []);
});

test("the balance is the spendable winc", async () => {
  const seen = answer(() => ({ status: 200, body: { winc: "7", controlledWinc: "9" } }));
  assert.equal(await new TurboClient(ENDPOINTS, "base-eth").balance(PAYER.toLowerCase()), 7n);
  assert.equal(seen[0]!.url, `https://payment.test/v1/account/balance/base-eth?address=${PAYER}`);
});

test("the deposit address is the one Turbo lists for the token", async () => {
  answer(() => ({ status: 200, body: { addresses: { ethereum: "0xeth", "base-eth": "0xbase" } } }));
  assert.equal(await new TurboClient(ENDPOINTS, "base-eth").depositAddress(), "0xbase");
});

test("a submitted deposit is credited, pending or rejected as Turbo reports it", async () => {
  const turbo = new TurboClient(ENDPOINTS, "base-eth");
  for (const [key, expected] of [
    ["creditedTransaction", "credited"],
    ["pendingTransaction", "pending"],
    ["failedTransaction", "rejected"],
  ] as const) {
    const seen = answer(() => ({ status: 200, body: { [key]: {} } }));
    assert.equal(await turbo.submitFundTransaction("0xhash"), expected);
    assert.equal(String(seen[0]!.body), JSON.stringify({ tx_id: "0xhash" }));
  }
});

test("a share is a signed data item carrying the approval tags, answered with the approval it created", async () => {
  const seen = answer(() => ({ status: 200, body: { id: "x", createdApproval: { approvalDataItemId: "approval-1" } } }));
  const id = await new TurboClient(ENDPOINTS, "base-eth").shareCredits(signer, UPLOADER.toLowerCase(), 5n, 60);
  assert.equal(id, "approval-1");
  const raw = Buffer.from(seen[0]!.body!);
  for (const text of ["x-approve-payment", UPLOADER, "x-amount", "x-expires-seconds"]) assert.ok(raw.includes(Buffer.from(text)), text);
});
