import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom implements no `EventSource`, and the console opens one as soon as a job becomes active
 * (`hooks/use-job-event-stream.ts`).
 */
class InertEventSource {
  static readonly CLOSED = 2;
  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = InertEventSource.CLOSED;
  }
}

globalThis.EventSource ??= InertEventSource as unknown as typeof EventSource;

// jsdom has no `window.scrollTo`; the router calls it after every navigation and jsdom logs a "Not implemented"
// line per call.
window.scrollTo = () => {};

// Every suite here renders into one jsdom document. Without this, a component left mounted by one test is still
// in the tree for the next one's `getByText`, which fails in whichever order the files happen to run.
afterEach(cleanup);
