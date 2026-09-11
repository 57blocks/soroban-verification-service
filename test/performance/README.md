# PERF-01 Locust Load Test

PERF-01 is a closed-loop Locust workload. Each user owns one persistent `F-PERF-VERIFIED` target
address and repeats this transaction until the duration or global rebuild cap is reached:

```text
submit unique rebuild marker -> wait for terminal verified -> validate report
```

The workload deliberately does not call `query-svc`. All pool targets share one Wasm hash, and the
public aggregate has no job ID, recipe marker, or contract ID that can attribute its `verified`
entry to one iteration.

Required inputs:

```bash
export SCVS_E2E_VERIFY_URL=https://dev.sv.example.com
export SCVS_E2E=1
export SCVS_E2E_ALLOW_PERF=1
export SCVS_E2E_PERF_USERS=10
export SCVS_E2E_PERF_DURATION_SECONDS=3600
export SCVS_E2E_PERF_THINK_TIME_SECONDS=60
export SCVS_E2E_PERF_MAX_REBUILDS=500
export SCVS_E2E_PERF_DRAIN_TIMEOUT_MS=14400000
```

`SCVS_E2E_PERF_USERS` must not exceed the persistent target-pool size, and `MAX_REBUILDS` must be
at least the user count. `MAX_REBUILDS` is a global
cost guardrail: a duration with a small think time otherwise creates an unbounded number of real builds.
The runner writes Locust CSV/HTML output plus `perf-01-summary.json` and
`perf-01-iterations.ndjson` under `artifacts/e2e-reports/perf-01/` by default.
It runs the Locust container as the invoking host user so these bind-mounted outputs remain writable
on both local machines and GitHub Actions runners.

Run it from the repository root:

```bash
pnpm run test:perf:locust
```

Do not overlap this run with CI or another local PERF-01/PERF-02 run using the same target pool.

## PERF-02 Fixed-Interval Bursts

PERF-02 is an open-loop burst alternative. The scheduler starts `BURST_SIZE` complete verification
flows concurrently at each fixed interval without waiting for previous flows. It leases one target
per active flow, so the in-flight cap must not exceed the persistent target pool. When that cap is
reached, the unstarted members of that burst are recorded as `capacity_drop` rather than queued.

```bash
export SCVS_E2E_PERF_OPEN_DURATION_SECONDS=600
export SCVS_E2E_PERF_OPEN_BURST_SIZE=20
export SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS=5
export SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT=100
export SCVS_E2E_PERF_MAX_REBUILDS=500
pnpm run test:perf:locust:open
```

Its output is written below `artifacts/e2e-reports/perf-02/`.
