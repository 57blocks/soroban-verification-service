import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { missingFixture, submissionFor } from "../../support/fixtures.js";
import { sleep } from "../../support/http.js";
import { readJob, submitAccepted, waitForTerminal } from "../../support/job.js";
import { isTerminalFrame, openJobStream, readJobStreamToClose } from "../../support/sse.js";
import type { JobStatusBody } from "../../support/types.js";

caseBlock(
  {
    id: "E2E-SUB-14/stream_to_terminal",
    title: "the stream shows queued → terminal and closes, agreeing with polling",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "closes at the terminal state, and its last frame matches what polling reports",
      async () => {
        const { jobId } = await submitAccepted(await submissionFor("F-LEG-1"));

        // Not awaited: the stream and the poll must observe the same interval.
        const streamPromise = readJobStreamToClose(jobId);
        const polled = await waitForTerminal(jobId, { settleMs: 0 });
        const frames = await streamPromise;

        expect(frames.length).toBeGreaterThan(0);

        const statuses = frames.map((frame) => (frame.data as JobStatusBody).status);
        expect(statuses[0]).toBeDefined();

        expect(isTerminalFrame(frames[frames.length - 1])).toBe(true);

        const lastFrame = frames[frames.length - 1].data as JobStatusBody;
        expect(lastFrame.status).toBe(polled.body.status);
        expect(lastFrame.job_id).toBe(jobId);

        const streamOrder = statuses.filter((status, index) => status !== statuses[index - 1]);
        for (const polledStatus of polled.statusSequence) {
          expect(streamOrder).toContain(polledStatus);
        }
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SUB-14/reconnect",
    title: "a reconnecting client learns the current state without waiting for a transition",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "delivers current state on reconnect, and on a first connection made after completion",
      async () => {
        const { jobId } = await submitAccepted(await submissionFor("F-LEG-1"));

        const first = openJobStream(jobId, { until: (_frame, all) => all.length >= 1 });
        expect(await first.closed).toBe("client_closed");
        expect(first.frames).toHaveLength(1);

        await sleep(4_000);

        const second = openJobStream(jobId, { until: (_frame, all) => all.length >= 1 });
        expect(await second.closed).toBe("client_closed");
        expect(second.frames).toHaveLength(1);

        const resumed = second.frames[0].data as JobStatusBody;
        expect(resumed.job_id).toBe(jobId);
        expect(resumed.status).toBeDefined();

        const current = await readJob(jobId);
        expect(resumed.status).toBe(current.status);

        const terminal = await waitForTerminal(jobId);
        const late = await readJobStreamToClose(jobId);
        expect(late.length).toBeGreaterThan(0);
        expect((late[0].data as JobStatusBody).status).toBe(terminal.body.status);
        expect(isTerminalFrame(late[late.length - 1])).toBe(true);
      },
      env.jobTimeoutMs + 120_000
    );
  }
);
