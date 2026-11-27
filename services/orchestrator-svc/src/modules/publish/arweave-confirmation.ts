export type ConfirmationState = "confirmed" | "pending" | "overdue";

const REQUEST_TIMEOUT_MS = 15_000;

/** Whether an archived item is on Arweave under enough blocks, read from a gateway rather than the bundler's own word. */
export class ArweaveConfirmations {
  constructor(
    private readonly gatewayUrl: string,
    private readonly required: number,
  ) {}

  async state(txId: string, deadlineHeight?: number): Promise<ConfirmationState> {
    const [height, block] = await Promise.all([this.height(), this.blockOf(txId)]);
    if (block !== undefined) return height - block + 1 >= this.required ? "confirmed" : "pending";
    return deadlineHeight !== undefined && height > deadlineHeight ? "overdue" : "pending";
  }

  async height(): Promise<number> {
    const response = await fetch(`${this.gatewayUrl}/info`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`gateway /info answered HTTP ${response.status}`);
    const { height } = (await response.json()) as { height?: unknown };
    if (typeof height !== "number") throw new Error("gateway /info reported no height");
    return height;
  }

  private async blockOf(txId: string): Promise<number | undefined> {
    const response = await fetch(`${this.gatewayUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query ($id: ID!) { transaction(id: $id) { block { height } } }", variables: { id: txId } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`gateway /graphql answered HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: { transaction?: { block?: { height?: number } | null } | null };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw new Error(`gateway /graphql: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data?.transaction?.block?.height ?? undefined;
  }
}
