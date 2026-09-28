import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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

window.scrollTo = () => {};

// All suites share one jsdom document; without cleanup a mounted component leaks into the next test.
afterEach(cleanup);
