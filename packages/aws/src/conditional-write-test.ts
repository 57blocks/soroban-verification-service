import assert from "node:assert/strict";
import {
  classifyConditionalWriteError,
  getObjectTextVersioned,
  putObjectTextConditional,
  type S3Client,
} from "./s3.js";

const named = (name: string, httpStatusCode?: number) => ({ name, $metadata: { httpStatusCode } });

function main(): void {
  assert.equal(classifyConditionalWriteError(named("PreconditionFailed", 412), "if-match"), "conflict");
  assert.equal(classifyConditionalWriteError(named("PreconditionFailed", 412), "if-none-match"), "conflict");
  assert.equal(classifyConditionalWriteError(named("ConditionalRequestConflict", 409), "if-match"), "conflict");

  assert.equal(classifyConditionalWriteError(named("NoSuchKey", 404), "if-match"), "vanished");
  assert.equal(classifyConditionalWriteError(named("NoSuchKey", 404), "if-none-match"), "fatal");
  assert.equal(classifyConditionalWriteError(named("NotFound", 404), "if-match"), "fatal");

  assert.equal(classifyConditionalWriteError(named("NoSuchBucket", 404), "if-match"), "fatal");
  assert.equal(classifyConditionalWriteError(named("AccessDenied", 404), "if-match"), "fatal");
  assert.equal(classifyConditionalWriteError(named("AccessDenied", 403), "if-match"), "fatal");

  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 412 } }, "if-match"), "conflict");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 409 } }, "if-match"), "conflict");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 404 } }, "if-match"), "vanished");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 404 } }, "if-none-match"), "fatal");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 500 } }, "if-match"), "fatal");

  assert.equal(classifyConditionalWriteError(undefined, "if-match"), "fatal");
  assert.equal(classifyConditionalWriteError("boom", "if-match"), "fatal");

  console.log("S3 conditional-write error classification passed");
}

type SentInput = Record<string, unknown>;

function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

function fakeClient(handler: (input: SentInput) => unknown): { client: S3Client; sent: SentInput[] } {
  const sent: SentInput[] = [];
  const client = {
    send: async (command: { input: SentInput }) => {
      sent.push(command.input);
      const outcome = handler(command.input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as S3Client;
  return { client, sent };
}

const body = (text: string) => ({ transformToString: async () => text });

async function reads(): Promise<void> {
  {
    const { client, sent } = fakeClient(() => ({ Body: body("{}\n"), ETag: '"abc123"' }));
    const result = await getObjectTextVersioned(client, "bucket", "wasms/x.json");
    assert.deepEqual(result, { text: "{}\n", version: '"abc123"' });
    assert.deepEqual(sent[0], { Bucket: "bucket", Key: "wasms/x.json" });
  }

  {
    const { client } = fakeClient(() => awsError("NoSuchKey", 404));
    assert.equal(await getObjectTextVersioned(client, "bucket", "wasms/x.json"), undefined);
  }

  {
    const { client } = fakeClient(() => awsError("NoSuchBucket", 404));
    await assert.rejects(getObjectTextVersioned(client, "bucket", "wasms/x.json"), /NoSuchBucket/);
  }
  {
    const { client } = fakeClient(() => awsError("AccessDenied", 403));
    await assert.rejects(getObjectTextVersioned(client, "bucket", "wasms/x.json"), /AccessDenied/);
  }

  {
    const { client } = fakeClient(() => awsError("NotFound", 404));
    await assert.rejects(getObjectTextVersioned(client, "bucket", "wasms/x.json"), /NotFound/);
  }

  {
    const nameless = { $metadata: { httpStatusCode: 404 } };
    const { client } = fakeClient(() => { throw nameless; });
    assert.equal(await getObjectTextVersioned(client, "bucket", "wasms/x.json"), undefined);
  }

  {
    const { client } = fakeClient(() => Object.assign(new Error("gone"), { $metadata: { httpStatusCode: 404 } }));
    await assert.rejects(getObjectTextVersioned(client, "bucket", "wasms/x.json"), /gone/);
  }

  {
    const { client } = fakeClient(() => ({ Body: body("{}\n") }));
    await assert.rejects(getObjectTextVersioned(client, "bucket", "wasms/x.json"), /no ETag/);
  }
}

async function writes(): Promise<void> {
  {
    const { client, sent } = fakeClient(() => ({}));
    assert.equal(
      await putObjectTextConditional(client, "bucket", "wasms/x.json", "{}\n", "application/json", null, "max-age=60"),
      "written",
    );
    assert.equal(sent[0].IfNoneMatch, "*");
    assert.equal("IfMatch" in sent[0], false);
    assert.equal(sent[0].ContentType, "application/json");
    assert.equal(sent[0].CacheControl, "max-age=60");
    assert.equal(sent[0].Body, "{}\n");
  }

  {
    const { client, sent } = fakeClient(() => ({}));
    assert.equal(
      await putObjectTextConditional(client, "bucket", "wasms/x.json", "{}\n", "application/json", '"abc123"'),
      "written",
    );
    assert.equal(sent[0].IfMatch, '"abc123"');
    assert.equal("IfNoneMatch" in sent[0], false);
    assert.equal("CacheControl" in sent[0], false);
  }

  {
    const { client } = fakeClient(() => awsError("PreconditionFailed", 412));
    assert.equal(
      await putObjectTextConditional(client, "bucket", "k", "x", "text/plain", '"e"'),
      "conflict",
    );
  }
  {
    const { client } = fakeClient(() => awsError("ConditionalRequestConflict", 409));
    assert.equal(await putObjectTextConditional(client, "bucket", "k", "x", "text/plain", null), "conflict");
  }
  {
    const { client } = fakeClient(() => awsError("NoSuchKey", 404));
    assert.equal(await putObjectTextConditional(client, "bucket", "k", "x", "text/plain", '"e"'), "vanished");
  }

  {
    const { client } = fakeClient(() => awsError("NoSuchKey", 404));
    await assert.rejects(putObjectTextConditional(client, "bucket", "k", "x", "text/plain", null), /NoSuchKey/);
  }
  {
    const { client } = fakeClient(() => awsError("NoSuchBucket", 404));
    await assert.rejects(putObjectTextConditional(client, "bucket", "k", "x", "text/plain", '"e"'), /NoSuchBucket/);
  }
}

async function run(): Promise<void> {
  main();
  await reads();
  await writes();
  console.log("S3 conditional requests: headers, ETag passthrough, and failure mapping passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
