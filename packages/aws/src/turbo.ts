import { getAddress } from "@ethersproject/address";
import { createSignedDataItem, type DataItemSigner, type DataItemTag, type SignedDataItem } from "./ans104.js";

export type TurboEndpoints = { uploadUrl: string; paymentUrl: string };
export type TurboToken = "ethereum" | "base-eth";

/** `deadlineHeight`: the Arweave height by which Turbo promises the item is on chain. */
export type TurboUploadResult = { ok: true; id: string; deadlineHeight?: number } | { ok: false; reason: "insufficient_credits" };

export type TurboShare = {
  approvalDataItemId?: string;
  approvedAddress: string;
  approvedWincAmount: string;
  usedWincAmount: string;
  expirationDate?: string;
};

export type TurboFundStatus = "credited" | "pending" | "rejected";

const REQUEST_TIMEOUT_MS = 30_000;
const PAYMENT_REQUIRED = 402;

const SHARE_TAGS = { approve: "x-approve-payment", amount: "x-amount", expiresSeconds: "x-expires-seconds" } as const;

// Turbo derives an Ethereum signer's address in checksum case; every address it is sent is put in the same form.
const asTurboAddress = (address: string): string => getAddress(address);

export class TurboHttpError extends Error {
  constructor(
    readonly status: number,
    what: string,
    body: string,
  ) {
    super(`${what}: Turbo answered HTTP ${status}${body ? ` — ${body.slice(0, 300)}` : ""}`);
    this.name = "TurboHttpError";
  }
}

/** ArDrive Turbo over plain HTTP: data items are built and signed here, so no SDK holds a key or a socket. */
export class TurboClient {
  constructor(
    private readonly endpoints: TurboEndpoints,
    private readonly token: TurboToken,
  ) {}

  private async request(url: string, what: string, init: RequestInit = {}, allowed: number[] = [200, 202]): Promise<{ status: number; text: string }> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    if (!allowed.includes(response.status)) throw new TurboHttpError(response.status, what, text);
    return { status: response.status, text };
  }

  /** Signs `data` as a data item and stores it, billed to `paidBy` when given; a 402 means the credits fell short. */
  async upload(data: Uint8Array, tags: DataItemTag[], signer: DataItemSigner, paidBy?: string): Promise<TurboUploadResult> {
    const item = await createSignedDataItem(data, tags, signer);
    const { status, text } = await this.request(
      `${this.endpoints.uploadUrl}/v1/tx/${this.token}`,
      "upload",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...(paidBy ? { "x-paid-by": asTurboAddress(paidBy) } : {}) },
        body: new Uint8Array(item.raw),
      },
      [200, 202, PAYMENT_REQUIRED],
    );
    if (status === PAYMENT_REQUIRED) return { ok: false, reason: "insufficient_credits" };
    const receipt = JSON.parse(text) as { id?: string; deadlineHeight?: number };
    if (receipt.id !== item.id) throw new Error(`Turbo acknowledged ${receipt.id ?? "no id"} for data item ${item.id}`);
    return { ok: true, id: item.id, ...(typeof receipt.deadlineHeight === "number" ? { deadlineHeight: receipt.deadlineHeight } : {}) };
  }

  async depositAddress(): Promise<string> {
    const { text } = await this.request(`${this.endpoints.paymentUrl}/v1/info`, "payment info");
    const address = (JSON.parse(text) as { addresses?: Partial<Record<string, string>> }).addresses?.[this.token];
    if (!address) throw new Error(`Turbo lists no deposit address for ${this.token}`);
    return address;
  }

  /** Spendable winc: what the address holds, less what it has shared and not yet seen spent. */
  async balance(address: string): Promise<bigint> {
    const { status, text } = await this.request(
      `${this.endpoints.paymentUrl}/v1/account/balance/${this.token}?address=${encodeURIComponent(asTurboAddress(address))}`,
      "balance",
      {},
      [200, 404],
    );
    if (status === 404) return 0n;
    return BigInt((JSON.parse(text) as { winc?: string }).winc ?? "0");
  }

  async sharesGivenBy(address: string): Promise<TurboShare[]> {
    const { status, text } = await this.request(
      `${this.endpoints.paymentUrl}/v1/account/approvals/get?userAddress=${encodeURIComponent(asTurboAddress(address))}`,
      "credit shares",
      {},
      [200, 404],
    );
    if (status === 404) return [];
    return (JSON.parse(text) as { givenApprovals?: TurboShare[] }).givenApprovals ?? [];
  }

  /** A share is a data item the payer signs and uploads; Turbo answers with the approval it created. */
  async shareCredits(signer: DataItemSigner, approvedAddress: string, winc: bigint, expiresInSeconds: number): Promise<string> {
    return this.submitShare(await this.signShare(signer, approvedAddress, winc, expiresInSeconds));
  }

  /** The share's data item, whose id is known before Turbo sees it: a caller can record it first. */
  signShare(signer: DataItemSigner, approvedAddress: string, winc: bigint, expiresInSeconds: number): Promise<SignedDataItem> {
    const tags = [
      { name: SHARE_TAGS.approve, value: asTurboAddress(approvedAddress) },
      { name: SHARE_TAGS.amount, value: winc.toString() },
      { name: SHARE_TAGS.expiresSeconds, value: String(expiresInSeconds) },
    ];
    return createSignedDataItem(Buffer.from(`${asTurboAddress(approvedAddress)}${winc}${Date.now()}`), tags, signer);
  }

  async submitShare(item: SignedDataItem): Promise<string> {
    const { text } = await this.request(`${this.endpoints.uploadUrl}/v1/tx/${this.token}`, "share credits", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(item.raw),
    });
    const created = (JSON.parse(text) as { createdApproval?: { approvalDataItemId?: string } }).createdApproval;
    if (!created?.approvalDataItemId) throw new Error(`Turbo stored share ${item.id} but reported no approval created`);
    return created.approvalDataItemId;
  }

  async submitFundTransaction(txHash: string): Promise<TurboFundStatus> {
    const { text } = await this.request(`${this.endpoints.paymentUrl}/v1/account/balance/${this.token}`, "submit fund transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_id: txHash }),
    });
    const body = JSON.parse(text) as Record<string, unknown>;
    if ("creditedTransaction" in body) return "credited";
    if ("failedTransaction" in body) return "rejected";
    if ("pendingTransaction" in body) return "pending";
    throw new Error(`Turbo answered the fund transaction with neither credited, pending nor failed: ${text.slice(0, 300)}`);
  }
}
