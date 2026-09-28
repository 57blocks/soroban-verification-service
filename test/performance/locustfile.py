"""PERF-01: Locust users execute complete forced-rebuild verification flows.

Each user owns one testnet target for its entire lifetime. A new inert build option is added on
every iteration, so the service must create a new rebuild identity rather than reuse an earlier one.
The flow ends at the verification service's published report. It deliberately does not call
query-svc: aggregate results are Wasm-hash keyed and cannot attribute a shared-hash pool result to
one iteration.
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
from locust import HttpUser, between, events, task
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


def non_negative_float(name: str) -> float:
    value = float(required(name))
    if value < 0:
        raise RuntimeError(f"{name} must be non-negative")
    return value


VERIFY_URL = required("SCVS_E2E_VERIFY_URL").rstrip("/")
FIXTURES_PATH = Path(required("SCVS_E2E_FIXTURES"))
RESULT_DIR = Path(required("SCVS_E2E_PERF_RESULT_DIR"))
USERS = positive_int("SCVS_E2E_PERF_USERS")
DURATION_SECONDS = positive_int("SCVS_E2E_PERF_DURATION_SECONDS")
THINK_TIME_SECONDS = non_negative_float("SCVS_E2E_PERF_THINK_TIME_SECONDS")
MAX_REBUILDS = positive_int("SCVS_E2E_PERF_MAX_REBUILDS")
DRAIN_TIMEOUT_SECONDS = positive_int("SCVS_E2E_PERF_DRAIN_TIMEOUT_SECONDS")
POLL_INTERVAL_SECONDS = non_negative_float("SCVS_E2E_POLL_INTERVAL_SECONDS")
REQUEST_TIMEOUT_SECONDS = positive_int("SCVS_E2E_REQUEST_TIMEOUT_SECONDS")
RUN_ID = os.environ.get("SCVS_E2E_RUN_ID", "").strip() or str(uuid.uuid4())
MARKER_PREFIX = "--env=SCVS_E2E_PERF_BUILD="
TERMINAL = {"verified", "mismatch", "policy_rejected", "not_attempted", "source_unavailable", "build_failed"}


def load_fixture() -> tuple[dict, list[dict]]:
    inventory = json.loads(FIXTURES_PATH.read_text())
    fixture = inventory["contracts"]["F-LEG-1"]
    pool = inventory["performance_verified"]
    if pool["fixture_id"] != "F-LEG-1":
        raise RuntimeError("performance_verified must reference F-LEG-1")
    if pool["wasm_hash"] != fixture["wasm_hash"]:
        raise RuntimeError("performance_verified Wasm hash differs from F-LEG-1")
    targets = pool["targets"]
    if len(targets) < USERS:
        raise RuntimeError(
            f"SCVS_E2E_PERF_USERS={USERS} exceeds the available target pool of {len(targets)}"
        )
    if len({target["contract_id"] for target in targets}) != len(targets):
        raise RuntimeError("performance_verified contains duplicate contract IDs")
    if any(target["wasm_hash"] != fixture["wasm_hash"] for target in targets):
        raise RuntimeError("performance_verified target has a different Wasm hash")
    return fixture, targets[:USERS]


FIXTURE, TARGETS = load_fixture()
TARGET_POOL = Queue()
for index, target in enumerate(TARGETS, start=1):
    TARGET_POOL.put({"slot": index, **target})

STATE_LOCK = Semaphore()
STATE = {
    "started_at": None,
    "deadline": None,
    "started_rebuilds": 0,
    "iterations": 0,
    "succeeded": 0,
    "failed": 0,
}


def elapsed_ms(started_at: float) -> int:
    return round((time.perf_counter() - started_at) * 1000)


def record_iteration(record: dict) -> None:
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK:
        STATE["iterations"] += 1
        if record["outcome"] == "verified":
            STATE["succeeded"] += 1
        else:
            STATE["failed"] += 1
        with (RESULT_DIR / "perf-01-iterations.ndjson").open("a", encoding="utf-8") as output:
            output.write(json.dumps(record, separators=(",", ":")) + "\n")


def print_flow(event: str, **fields: object) -> None:
    print(
        "[E2E-PERF-01] "
        + json.dumps({"event": event, **fields}, separators=(",", ":"), sort_keys=True),
        flush=True,
    )


def fire_report_event(environment, started_at: float, exception: Exception | None) -> None:
    environment.events.request.fire(
        request_type="GET",
        name="GET report artifact",
        response_time=elapsed_ms(started_at),
        response_length=0,
        exception=exception,
        context={},
    )


@events.test_start.add_listener
def start_test(environment, **_kwargs):
    if USERS > len(TARGETS):
        environment.process_exit_code = 2
        environment.runner.quit()
        return
    with STATE_LOCK:
        STATE["started_at"] = time.monotonic()
        STATE["deadline"] = STATE["started_at"] + DURATION_SECONDS


@events.test_stop.add_listener
def finish_test(environment, **_kwargs):
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK:
        started_at = STATE["started_at"]
        summary = {
            "schema_version": 1,
            "case_id": "E2E-PERF-01",
            "run_id": RUN_ID,
            "configured_users": USERS,
            "configured_duration_seconds": DURATION_SECONDS,
            "configured_think_time_seconds": THINK_TIME_SECONDS,
            "configured_max_rebuilds": MAX_REBUILDS,
            "configured_drain_timeout_seconds": DRAIN_TIMEOUT_SECONDS,
            "elapsed_ms": round((time.monotonic() - started_at) * 1000) if started_at else 0,
            "iterations": STATE["iterations"],
            "started_rebuilds": STATE["started_rebuilds"],
            "verified_count": STATE["succeeded"],
            "failed_count": STATE["failed"],
        }
        (RESULT_DIR / "perf-01-summary.json").write_text(
            json.dumps(summary, indent=2) + "\n", encoding="utf-8"
        )


class VerificationFlowUser(HttpUser):
    host = VERIFY_URL
    wait_time = between(THINK_TIME_SECONDS, THINK_TIME_SECONDS)

    def on_start(self):
        try:
            self.target = TARGET_POOL.get_nowait()
        except Empty as error:
            raise StopUser() from error
        self.iteration = 0

    def on_stop(self):
        if hasattr(self, "target"):
            TARGET_POOL.put(self.target)

    @task
    def submit_verify_and_validate_report(self):
        deadline = STATE["deadline"]
        if deadline is None or time.monotonic() >= deadline:
            raise StopUser()

        with STATE_LOCK:
            if STATE["started_rebuilds"] >= MAX_REBUILDS:
                raise StopUser()
            STATE["started_rebuilds"] += 1

        self.iteration += 1
        started_at = time.perf_counter()
        marker = f"{RUN_ID}-u{self.target['slot']}-i{self.iteration}"
        body = {
            "target": {"network": FIXTURE["network"], "contract_id": self.target["contract_id"]},
            "manifest": {
                "schema": "stellar-submitted-source-verification-manifest-v1",
                "source_sha256": FIXTURE["source_sha256"],
                "source_uri": FIXTURE["source_uri"],
                "bldarg": FIXTURE["bldarg"],
                "bldopt": [*FIXTURE["bldopt"], f"{MARKER_PREFIX}{marker}"],
            },
        }

        job_id = None
        error = None
        try:
            with self.client.post("/api/verification/v1/verifications", json=body, name="POST /verifications", catch_response=True) as response:
                if response.status_code != 202:
                    error = f"submit_http_{response.status_code}"
                    response.failure(error)
                else:
                    job_id = response.json().get("job_id")
                    if not isinstance(job_id, str):
                        error = "submit_missing_job_id"
                        response.failure(error)
                    else:
                        print_flow(
                            "submitted",
                            user_slot=self.target["slot"],
                            iteration=self.iteration,
                            contract_id=self.target["contract_id"],
                            job_id=job_id,
                            recipe_marker=marker,
                        )

            if error is None:
                terminal, error = self.wait_for_terminal(job_id)
            else:
                terminal = None

            if error is None:
                error = self.validate_terminal(terminal)
            if error is None:
                error = self.validate_report(terminal["result"]["artifact_url"])
        except Exception as exception:
            error = f"unexpected_{type(exception).__name__}"

        transaction_exception = None if error is None else RuntimeError(error)
        self.environment.events.request.fire(
            request_type="FLOW",
            name="submit -> terminal verified -> report valid",
            response_time=elapsed_ms(started_at),
            response_length=0,
            exception=transaction_exception,
            context={},
        )
        record = {
            "user_slot": self.target["slot"],
            "iteration": self.iteration,
            "contract_id": self.target["contract_id"],
            "recipe_marker": marker,
            "job_id": job_id,
            "duration_ms": elapsed_ms(started_at),
            "outcome": "verified" if error is None else "failed",
            **({"error": error} if error else {}),
        }
        record_iteration(record)
        print_flow("completed", **record)

    def wait_for_terminal(self, job_id: str) -> tuple[dict | None, str | None]:
        deadline = time.monotonic() + DRAIN_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            with self.client.get(
                f"/api/verification/v1/verifications/{job_id}",
                name="GET /verifications/:job_id",
                catch_response=True,
            ) as response:
                if response.status_code != 200:
                    response.failure(f"job_http_{response.status_code}")
                    return None, f"job_http_{response.status_code}"
                body = response.json()
                if body.get("status") in TERMINAL:
                    return body, None
            gevent.sleep(POLL_INTERVAL_SECONDS)
        return None, "terminal_timeout"

    def validate_terminal(self, terminal: dict) -> str | None:
        result = terminal.get("result") or {}
        if terminal.get("status") != "verified" or result.get("matched") is not True:
            return "terminal_not_verified"
        if result.get("wasm_hash") != self.target["wasm_hash"]:
            return "job_wasm_hash_mismatch"
        job_target = terminal.get("target") or {}
        if (
            job_target.get("network") != FIXTURE["network"]
            or job_target.get("contract_id") != self.target["contract_id"]
        ):
            return "job_target_mismatch"
        if not isinstance(result.get("artifact_url"), str):
            return "missing_report_url"
        return None

    def validate_report(self, artifact_url: str) -> str | None:
        started_at = time.perf_counter()
        try:
            response = requests.get(artifact_url, timeout=REQUEST_TIMEOUT_SECONDS)
            if response.status_code != 200:
                raise RuntimeError(f"report_http_{response.status_code}")
            artifact = response.json()
            if not isinstance(artifact, dict):
                raise RuntimeError("report_missing_artifact")
            if artifact.get("schema") != "stellar-verification-artifact-v1":
                raise RuntimeError("report_schema_mismatch")
            result = artifact.get("result") or {}
            if (
                result.get("matched") is not True
                or result.get("wasm_hash") != self.target["wasm_hash"]
            ):
                raise RuntimeError("report_result_mismatch")
        except Exception as error:
            fire_report_event(self.environment, started_at, error)
            return str(error)
        fire_report_event(self.environment, started_at, None)
        return None
