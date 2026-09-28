"""PERF-02: fixed-interval burst arrivals for forced-rebuild verification flows.

The scheduler starts a configured burst of flows at every interval without waiting for earlier flows
to settle. An in-flight cap and the finite target pool prevent unbounded queued work. Every admitted
flow leases one address until its verification and report validation finish.
"""

import json
import os
import time
import uuid
from pathlib import Path

import gevent
import requests
from gevent.lock import Semaphore
from gevent.queue import Empty, Queue
from locust import User, between, events, task
from locust.exception import StopUser


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def positive_int(name: str) -> int:
    value = int(required(name))
    if value < 1:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


def positive_float(name: str) -> float:
    value = float(required(name))
    if value <= 0:
        raise RuntimeError(f"{name} must be positive")
    return value


VERIFY_URL = required("SCVS_E2E_VERIFY_URL").rstrip("/")
FIXTURES_PATH = Path(required("SCVS_E2E_FIXTURES"))
RESULT_DIR = Path(required("SCVS_E2E_PERF_RESULT_DIR"))
DURATION_SECONDS = positive_int("SCVS_E2E_PERF_OPEN_DURATION_SECONDS")
BURST_SIZE = positive_int("SCVS_E2E_PERF_OPEN_BURST_SIZE")
BURST_INTERVAL_SECONDS = positive_float("SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS")
MAX_IN_FLIGHT = positive_int("SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT")
MAX_REBUILDS = positive_int("SCVS_E2E_PERF_MAX_REBUILDS")
DRAIN_TIMEOUT_SECONDS = positive_int("SCVS_E2E_PERF_DRAIN_TIMEOUT_SECONDS")
POLL_INTERVAL_SECONDS = positive_float("SCVS_E2E_POLL_INTERVAL_SECONDS")
REQUEST_TIMEOUT_SECONDS = positive_int("SCVS_E2E_REQUEST_TIMEOUT_SECONDS")
RUN_ID = os.environ.get("SCVS_E2E_RUN_ID", "").strip() or str(uuid.uuid4())
MARKER_PREFIX = "--env=SCVS_E2E_PERF_BUILD="
TERMINAL = {"verified", "mismatch", "policy_rejected", "not_attempted", "source_unavailable", "build_failed"}


def load_fixture() -> tuple[dict, list[dict]]:
    inventory = json.loads(FIXTURES_PATH.read_text())
    fixture = inventory["contracts"]["F-LEG-1"]
    pool = inventory["performance_verified"]
    targets = pool["targets"]
    if pool["fixture_id"] != "F-LEG-1" or pool["wasm_hash"] != fixture["wasm_hash"]:
        raise RuntimeError("performance_verified must reference F-LEG-1 and its Wasm hash")
    if len(targets) < MAX_IN_FLIGHT:
        raise RuntimeError(
            f"SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT={MAX_IN_FLIGHT} exceeds the target pool of {len(targets)}"
        )
    if len({target["contract_id"] for target in targets}) != len(targets):
        raise RuntimeError("performance_verified contains duplicate contract IDs")
    if any(target["wasm_hash"] != fixture["wasm_hash"] for target in targets):
        raise RuntimeError("performance_verified target has a different Wasm hash")
    return fixture, targets[:MAX_IN_FLIGHT]


FIXTURE, TARGETS = load_fixture()
TARGET_POOL = Queue()
for slot, target in enumerate(TARGETS, start=1):
    TARGET_POOL.put({"slot": slot, **target})

LOCK = Semaphore()
STATE = {
    "started_at": None,
    "deadline": None,
    "scheduled_bursts": 0,
    "scheduled_arrivals": 0,
    "started_rebuilds": 0,
    "budget_clipped_arrivals": 0,
    "in_flight": 0,
    "peak_in_flight": 0,
    "capacity_drops": 0,
    "iterations": 0,
    "verified": 0,
    "failed": 0,
}


def elapsed_ms(started_at: float) -> int:
    return round((time.perf_counter() - started_at) * 1000)


def print_flow(event: str, **fields: object) -> None:
    print(
        "[E2E-PERF-02] "
        + json.dumps({"event": event, **fields}, separators=(",", ":"), sort_keys=True),
        flush=True,
    )


def write_record(record: dict) -> None:
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK:
        STATE["iterations"] += 1
        STATE["verified" if record["outcome"] == "verified" else "failed"] += 1
        with (RESULT_DIR / "perf-02-iterations.ndjson").open("a", encoding="utf-8") as output:
            output.write(json.dumps(record, separators=(",", ":")) + "\n")


def report_request(environment, request_type: str, name: str, started_at: float, response, error: Exception | None) -> None:
    environment.events.request.fire(
        request_type=request_type,
        name=name,
        response_time=elapsed_ms(started_at),
        response_length=len(response.content) if response is not None else 0,
        exception=error,
        context={},
    )


def request_json(environment, session, method: str, path_or_url: str, name: str, expected_status: int, payload=None):
    started_at = time.perf_counter()
    try:
        response = session.request(
            method,
            path_or_url if path_or_url.startswith("http") else f"{VERIFY_URL}{path_or_url}",
            json=payload,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if response.status_code != expected_status:
            error = RuntimeError(f"http_{response.status_code}")
            report_request(environment, method, name, started_at, response, error)
            return None, str(error)
        try:
            body = response.json()
        except ValueError:
            error = RuntimeError("invalid_json")
            report_request(environment, method, name, started_at, response, error)
            return None, str(error)
        report_request(environment, method, name, started_at, response, None)
        return body, None
    except requests.RequestException as error:
        report_request(environment, method, name, started_at, None, error)
        return None, f"request_{type(error).__name__}"


def run_flow(environment, target: dict, burst_number: int, request_number: int) -> None:
    started_at = time.perf_counter()
    marker = f"{RUN_ID}-b{burst_number}-r{request_number}-t{target['slot']}"
    job_id = None
    error = None
    session = requests.Session()
    try:
        body = {
            "target": {"network": FIXTURE["network"], "contract_id": target["contract_id"]},
            "manifest": {
                "schema": "stellar-submitted-source-verification-manifest-v1",
                "source_sha256": FIXTURE["source_sha256"],
                "source_uri": FIXTURE["source_uri"],
                "bldarg": FIXTURE["bldarg"],
                "bldopt": [*FIXTURE["bldopt"], f"{MARKER_PREFIX}{marker}"],
            },
        }
        submitted, error = request_json(
            environment, session, "POST", "/api/verification/v1/verifications", "POST /verifications", 202, body
        )
        if error is None:
            job_id = submitted.get("job_id")
            if not isinstance(job_id, str):
                error = "submit_missing_job_id"
            else:
                print_flow(
                    "submitted",
                    burst=burst_number,
                    request=request_number,
                    contract_id=target["contract_id"],
                    job_id=job_id,
                    recipe_marker=marker,
                )

        terminal = None
        reached_terminal = False
        deadline = time.monotonic() + DRAIN_TIMEOUT_SECONDS
        while error is None and time.monotonic() < deadline:
            terminal, error = request_json(
                environment, session, "GET", f"/api/verification/v1/verifications/{job_id}", "GET /verifications/:job_id", 200
            )
            if error is None and terminal.get("status") in TERMINAL:
                reached_terminal = True
                break
            if error is None:
                gevent.sleep(POLL_INTERVAL_SECONDS)
        if error is None and not reached_terminal:
            error = "terminal_timeout"
        if error is None and terminal.get("status") != "verified":
            error = "terminal_not_verified"
        result = (terminal or {}).get("result") or {}
        if error is None and result.get("matched") is not True:
            error = "terminal_not_matched"
        if error is None and result.get("wasm_hash") != target["wasm_hash"]:
            error = "job_wasm_hash_mismatch"
        job_target = (terminal or {}).get("target") or {}
        if error is None and (
            job_target.get("network") != FIXTURE["network"]
            or job_target.get("contract_id") != target["contract_id"]
        ):
            error = "job_target_mismatch"
        artifact_url = result.get("artifact_url")
        if error is None and not isinstance(artifact_url, str):
            error = "missing_report_url"
        if error is None:
            artifact, error = request_json(environment, session, "GET", artifact_url, "GET report artifact", 200)
            if error is None and (artifact or {}).get("schema") != "stellar-verification-artifact-v1":
                error = "report_schema_mismatch"
            report_result = (artifact or {}).get("result") or {}
            if error is None and (
                report_result.get("matched") is not True
                or report_result.get("wasm_hash") != target["wasm_hash"]
            ):
                error = "report_result_mismatch"
    except Exception as exception:
        error = f"unexpected_{type(exception).__name__}"
    finally:
        session.close()

    flow_error = None if error is None else RuntimeError(error)
    environment.events.request.fire(
        request_type="FLOW",
        name="fixed-burst submit -> terminal verified -> report valid",
        response_time=elapsed_ms(started_at),
        response_length=0,
        exception=flow_error,
        context={},
    )
    record = {
        "burst": burst_number,
        "request": request_number,
        "target_slot": target["slot"],
        "contract_id": target["contract_id"],
        "recipe_marker": marker,
        "job_id": job_id,
        "duration_ms": elapsed_ms(started_at),
        "outcome": "verified" if error is None else "failed",
        **({"error": error} if error else {}),
    }
    write_record(record)
    print_flow("completed", **record)
    TARGET_POOL.put(target)
    with LOCK:
        STATE["in_flight"] -= 1


class FixedRateArrivalScheduler(User):
    wait_time = between(0.2, 0.2)

    def on_start(self):
        self.finished = False
        self.scheduler = gevent.spawn(self.schedule_arrivals)

    @task
    def wait_for_scheduler(self):
        if self.finished:
            raise StopUser()

    def schedule_arrivals(self):
        started_at = time.monotonic()
        with LOCK:
            STATE["started_at"] = started_at
            STATE["deadline"] = started_at + DURATION_SECONDS
        next_burst = started_at
        burst_number = 0

        while next_burst < STATE["deadline"]:
            gevent.sleep(max(0, next_burst - time.monotonic()))
            if time.monotonic() >= STATE["deadline"]:
                break
            burst_number += 1
            with LOCK:
                STATE["scheduled_bursts"] += 1
                STATE["scheduled_arrivals"] += BURST_SIZE
                if STATE["started_rebuilds"] >= MAX_REBUILDS:
                    break
                remaining_budget = MAX_REBUILDS - STATE["started_rebuilds"]
                desired = min(BURST_SIZE, remaining_budget)
                STATE["budget_clipped_arrivals"] += BURST_SIZE - desired
                capacity = MAX_IN_FLIGHT - STATE["in_flight"]
                admitted = min(desired, capacity)
                targets = []
                for _ in range(admitted):
                    try:
                        targets.append(TARGET_POOL.get_nowait())
                    except Empty:
                        break
                STATE["capacity_drops"] += desired - len(targets)
                STATE["started_rebuilds"] += len(targets)
                STATE["in_flight"] += len(targets)
                STATE["peak_in_flight"] = max(STATE["peak_in_flight"], STATE["in_flight"])
            print_flow(
                "burst",
                burst=burst_number,
                requested=BURST_SIZE,
                started=len(targets),
                capacity_drops=desired - len(targets),
                budget_clipped=BURST_SIZE - desired,
            )
            for request_number, target in enumerate(targets, start=1):
                gevent.spawn(run_flow, self.environment, target, burst_number, request_number)
            next_burst += BURST_INTERVAL_SECONDS

        drain_deadline = time.monotonic() + DRAIN_TIMEOUT_SECONDS
        while time.monotonic() < drain_deadline:
            with LOCK:
                if STATE["in_flight"] == 0:
                    break
            gevent.sleep(0.2)
        self.finished = True
        self.environment.runner.quit()


@events.test_stop.add_listener
def write_summary(environment, **_kwargs):
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK:
        started_at = STATE["started_at"]
        summary = {
            "schema_version": 1,
            "case_id": "E2E-PERF-02",
            "run_id": RUN_ID,
            "SCVS_E2E_PERF_OPEN_DURATION_SECONDS": DURATION_SECONDS,
            "SCVS_E2E_PERF_OPEN_BURST_SIZE": BURST_SIZE,
            "SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS": BURST_INTERVAL_SECONDS,
            "configured_max_in_flight": MAX_IN_FLIGHT,
            "configured_max_rebuilds": MAX_REBUILDS,
            "configured_drain_timeout_seconds": DRAIN_TIMEOUT_SECONDS,
            "elapsed_ms": round((time.monotonic() - started_at) * 1000) if started_at else 0,
            "scheduled_bursts": STATE["scheduled_bursts"],
            "scheduled_arrivals": STATE["scheduled_arrivals"],
            "started_rebuilds": STATE["started_rebuilds"],
            "budget_clipped_arrivals": STATE["budget_clipped_arrivals"],
            "capacity_drops": STATE["capacity_drops"],
            "peak_in_flight": STATE["peak_in_flight"],
            "iterations": STATE["iterations"],
            "verified_count": STATE["verified"],
            "failed_count": STATE["failed"],
            "unfinished_at_shutdown": STATE["in_flight"],
        }
        (RESULT_DIR / "perf-02-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
