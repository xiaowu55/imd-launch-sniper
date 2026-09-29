import assert from "node:assert/strict";
import test from "node:test";
import { BoundedJsonError, readBoundedJson } from "../src/bounded-json.js";

const code = (value: string) => (error: unknown) => error instanceof BoundedJsonError && error.code === value;

test("bounded JSON streams UTF-8 split across chunks and counts bytes, not characters", async () => {
  const bytes = new TextEncoder().encode('{"text":"币"}');
  const response = () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
  assert.deepEqual(await readBoundedJson(response(), bytes.length), { text: "币" });
  await assert.rejects(readBoundedJson(response(), bytes.length - 1), code("too_large"));
});

test("oversized chunked or dishonest Content-Length responses cancel before collecting the body", async () => {
  for (const headers of [{}, { "content-length": "1" }] as Record<string, string>[]) {
    let cancelled = false;
    let reads = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(16)); },
      cancel() { cancelled = true; },
    }), { headers });
    await assert.rejects(readBoundedJson(response, 20), code("too_large"));
    assert.equal(cancelled, true);
    assert.ok(reads <= 3, "unbounded stream is stopped after the first excess chunk");
  }
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "1000000000000000000000000" } });
  await assert.rejects(readBoundedJson(response, 20), code("too_large"));
  assert.equal(cancelled, true);
});

test("aborting a stalled response body finishes promptly and cancels its stream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const result = readBoundedJson(response, 100, controller.signal);
  controller.abort();
  await assert.rejects(result, code("aborted"));
  assert.equal(cancelled, true);
});

test("malformed JSON and transport errors never echo response contents", async () => {
  for (const response of [new Response("SECRET"), new Response(Uint8Array.of(0xff)), new Response(new ReadableStream({ start(controller) { controller.error(Error("SECRET")); } }))]) {
    await assert.rejects(readBoundedJson(response, 100), (error: unknown) => {
      assert.ok(error instanceof BoundedJsonError);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
});
