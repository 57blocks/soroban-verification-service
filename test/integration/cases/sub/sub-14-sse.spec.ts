/** E2E-SUB-14 — the progress stream */
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

        // Connect immediately, then poll in parallel — the case compares the two sequences, so they have to be
        // observed over the same interval.
        const streamPromise = readJobStreamToClose(jobId);
        // The server closes the stream at the first terminal status, so polling stops there too.
        const polled = await waitForTerminal(jobId, { settleMs: 0 });
        const frames = await streamPromise;

        expect(frames.length).toBeGreaterThan(0);

        // HA1 — the first frame is the job's state at connect time, and the last is terminal.
        const statuses = frames.map((frame) => (frame.data as JobStatusBody).status);
        expect(statuses[0]).toBeDefined();

        // HA2.
        expect(isTerminalFrame(frames[frames.length - 1])).toBe(true);

        // HA3.
        const lastFrame = frames[frames.length - 1].data as JobStatusBody;
        expect(lastFrame.status).toBe(polled.body.status);
        expect(lastFrame.job_id).toBe(jobId);

        // …and the sequence the stream saw must be a superset of what polling caught, in order.
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

        // Connect, take exactly one frame, hang up. `openJobStream`'s `until` is why this suite reads SSE by
        // hand: a real EventSource would reconnect on its own and there would be nothing left to assert about
        // reconnection.
        const first = openJobStream(jobId, { until: (_frame, all) => all.length >= 1 });
        expect(await first.closed).toBe("client_closed");
        expect(first.frames).toHaveLength(1);

        await sleep(4_000);

        // HA1/HA2 — reconnect, and the *first* frame must carry state, not silence.
        const second = openJobStream(jobId, { until: (_frame, all) => all.length >= 1 });
        expect(await second.closed).toBe("client_closed");
        expect(second.frames).toHaveLength(1);

        const resumed = second.frames[0].data as JobStatusBody;
        expect(resumed.job_id).toBe(jobId);
        expect(resumed.status).toBeDefined();

        // It must also be *current*, not a replay of the frame the first connection already saw.
        const current = await readJob(jobId);
        expect(resumed.status).toBe(current.status);

        // HA3 — connect for the first time after the job is already finished.
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
