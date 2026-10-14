# Progress events

`GET /api/verification/v1/verifications/{job_id}/events` streams a job's progress as
[server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html). Each event carries
the job's full state, not a change, so replace your copy on every event.

## What arrives

Each event is an `id` line and a `data` line, with no `event` name, so it is a plain `message` event.
`data` is JSON, and it is one of these:

| `data` | Meaning | What to do |
| --- | --- | --- |
| The job, the same body as `GET /verifications/{job_id}` | The job's current state | Replace your copy. Close the stream once `status` is final |
| The job, plus `"stream_timeout": true` | This connection's window ended while the job was still running | Reconnect |
| `{"status": "error", "reason": "job_timeout", …}` | The job was created more than an hour ago, by default, and is still not final | Close, and check the job's status later |
| An [error body](./errors.md#the-error-body): `not_found`, `stream_connection_limit_reached` or `internal_error` | The stream cannot follow this job | Close |

An event arrives when the stream opens, whenever the job changes, and every 10 seconds by default even
when nothing changed.

```text
id: 1
data: {"job_id":"…","status":"running","progress":{"step":"building"},…}

id: 2
data: {"job_id":"…","status":"verified","result":{…},…}
```

## When the stream ends

The server closes the stream:

- when the job reaches a final status;
- after 15 minutes by default, with a `stream_timeout` event, if the job is still running;
- after a `job_timeout` or an error event.

A final status is final for the job as it stands. A `build_failed` caused by a timeout or by a fault on
the verifier's side is retried automatically, so the job can go back to `queued`; check its status again
later if you need the last word. See [Job outcomes](./errors.md#job-outcomes).

## Reconnecting

A new connection starts with the job's full current state, so nothing is lost between connections.
`id` starts again at 1 on every connection, and `Last-Event-ID` is not used.

A browser `EventSource` reconnects on its own whenever a stream ends, including after a final status or
an error. Close it yourself in those cases, or it keeps reconnecting and uses up the limit on opening
streams.

```js
const events = new EventSource(`/api/verification/v1/verifications/${jobId}/events`);
const FINAL = ["verified", "mismatch", "build_failed", "source_unavailable", "policy_rejected", "not_attempted"];

events.onmessage = ({ data }) => {
  const job = JSON.parse(data);
  if (job.schema === "stellar-verification-error" || job.status === "error") {
    events.close();
    return;
  }
  render(job);
  if (FINAL.includes(job.status)) events.close();
};
```

Outside a browser, read the stream with any HTTP client that keeps the response open, and reconnect
yourself after a `stream_timeout`:

```sh
curl -N "$ORIGIN/api/verification/v1/verifications/$JOB_ID/events"
```

## Errors before the stream opens

These answer with an ordinary HTTP status and an error body, and an `EventSource` treats them as final:

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_job_id` | The job ID is not a UUID |
| 429 | `rate_limited` | Too many streams opened in the last minute, 12 by default |
| 503 | `abuse_check_unavailable` | The verifier could not check its rate limits. Retry |

## Limits

Opening a stream counts against a limit of 12 a minute per caller. On each server instance, at most 5
streams may follow one job, and at most 10 may be open from one caller. Each operator can change these
defaults.
