/** F-DARK's source origin: a public archive URL that can be **switched off**. */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const archive = resolve(
  process.env.SCVS_FIXTURE_DARK_ARCHIVE ??
    "artifacts/e2e-fixtures/archives/canonical-source.tar.gz",
);
const host = process.env.SCVS_FIXTURE_DARK_HOST ?? "127.0.0.1";
const port = Number(process.env.SCVS_FIXTURE_DARK_PORT ?? "8787");
const size = statSync(archive).size;

let available = true;

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/source.tar.gz") {
    if (!available) {
      // 404, not 503: the case is about a source that is *gone*, and a retryable status would let a fetcher
      // legitimately keep trying rather than record it as unreachable.
      response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("gone\n");
      return;
    }
    response.writeHead(200, {
      "Content-Length": size,
      "Content-Type": "application/gzip",
      "Cache-Control": "no-store",
    });
    createReadStream(archive).pipe(response);
    return;
  }

  if (request.url === "/control") {
    if (request.method === "GET") {
      json(response, 200, { available });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (typeof body?.available !== "boolean") {
        // Refused rather than defaulted. A control call whose body did not parse must not be read as "leave it
        // as it is" and answered 200 — the caller would proceed believing it had switched.
        json(response, 400, {
          error: "invalid_control_body",
          message: 'expected {"available": boolean}',
        });
        return;
      }
      available = body.available;
      json(response, 200, { available });
      return;
    }
    json(response, 405, { error: "method_not_allowed", message: "GET or POST /control" });
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    // Deliberately unaffected by `available`: it answers "is the fixture server up", which the runner still
    // needs to know while the archive is switched off.
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok\n");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("not found\n");
});

server.listen(port, host, () => {
  process.stdout.write(
    `serving ${archive} at http://${host}:${port}/source.tar.gz (control: /control)\n`,
  );
});
