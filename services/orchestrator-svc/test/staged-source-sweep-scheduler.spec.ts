import { jest } from "@jest/globals";
import { RETRY_ELIGIBILITY_WINDOW_MS } from "@scvs/core";
import type { RebuildRecord, RebuildsRepository } from "@scvs/db";
import type { StagedSourceReleaseService, StagedSourceReleaseOutcome } from "../src/modules/source-resolution/staged-source-release.service.js";
import { StagedSourceSweepScheduler } from "../src/modules/scheduler/staged-source-sweep.scheduler.js";

const NOW = Date.UTC(2026, 10, 4, 0, 0, 0);
const CONFIG: Record<string, unknown> = { stagedSourceSweepBatchSize: 200 };

const rebuild = (rebuildId: string) => ({ rebuildId }) as RebuildRecord;

function schedulerOver(candidates: RebuildRecord[], outcomes: Record<string, StagedSourceReleaseOutcome | Error>) {
  const listStagedSourceReleaseCandidates = jest.fn<(opts: { doneBefore: Date; limit: number }) => Promise<RebuildRecord[]>>();
  listStagedSourceReleaseCandidates.mockResolvedValue(candidates);
  const releaseRebuildSources = jest.fn<(rebuildId: string, trigger: string) => Promise<StagedSourceReleaseOutcome>>();
  releaseRebuildSources.mockImplementation(async (rebuildId) => {
    const outcome = outcomes[rebuildId];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const scheduler = new StagedSourceSweepScheduler(
    { listStagedSourceReleaseCandidates } as unknown as RebuildsRepository,
    { releaseRebuildSources } as unknown as StagedSourceReleaseService,
    { get: (key: string) => CONFIG[key] } as never,
    {} as never,
  );
  return { scheduler, listStagedSourceReleaseCandidates, releaseRebuildSources };
}

describe("StagedSourceSweepScheduler", () => {
  it("asks for finished rebuilds older than the retry window, in one bounded batch", async () => {
    const { scheduler, listStagedSourceReleaseCandidates } = schedulerOver([], {});

    await scheduler.sweep(NOW);

    expect(listStagedSourceReleaseCandidates).toHaveBeenCalledWith({
      doneBefore: new Date(NOW - RETRY_ELIGIBILITY_WINDOW_MS),
      limit: 200,
    });
  });

  it("offers every candidate to the release and counts only what was actually released", async () => {
    const { scheduler, releaseRebuildSources } = schedulerOver(
      [rebuild("a"), rebuild("b"), rebuild("c")],
      { a: "released", b: "kept", c: "already_released" },
    );

    expect(await scheduler.sweep(NOW)).toBe(1);
    expect(releaseRebuildSources).toHaveBeenCalledTimes(3);
    expect(releaseRebuildSources).toHaveBeenCalledWith("b", "sweep");
  });

  it("a failing release leaves that rebuild for the next tick and continues with the rest", async () => {
    const { scheduler } = schedulerOver(
      [rebuild("broken"), rebuild("fine")],
      { broken: new Error("AccessDenied"), fine: "released" },
    );

    expect(await scheduler.sweep(NOW)).toBe(1);
  });

  it("survives a failing scan rather than taking the scheduler down with it", async () => {
    const { scheduler, listStagedSourceReleaseCandidates } = schedulerOver([], {});
    listStagedSourceReleaseCandidates.mockRejectedValueOnce(new Error("connection reset"));

    expect(await scheduler.sweep(NOW)).toBe(0);
  });
});
