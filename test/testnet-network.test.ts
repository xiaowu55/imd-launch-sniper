import test from "node:test";
import assert from "node:assert/strict";
import { NetworkReadError, readPeerHead } from "../scripts/testnet-network.js";
const head = { number: 1n, hash: "same" };
test("only temporary missing peer blocks receive short bounded retries", async () => {
  let calls = 0; const pauses: number[] = [];
  const result = await readPeerHead(head, async () => {
    if (++calls < 3) throw Object.assign(Error("not logged"), { name: "BlockNotFoundError" }); return head;
  }, new AbortController().signal, async ms => { pauses.push(ms); });
  assert.equal(result, head); assert.deepEqual(pauses, [150, 300]);
});
test("hash disagreement and generic RPC failures cannot become accepted lag retries", async () => {
  for (const read of [async () => ({ ...head, hash: "fork" }), async () => { throw Error("secret URL must stay private"); }]) {
    let waits = 0;
    await assert.rejects(readPeerHead(head, read, new AbortController().signal, async () => { waits++; }),
      e => e instanceof NetworkReadError && !e.message.includes("secret"));
    assert.equal(waits, 0);
  }
});
test("a stop during peer lag prevents any subsequent request", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readPeerHead(head, async () => { calls++; throw Object.assign(Error(), { name: "BlockNotFoundError" }); },
    controller.signal, async () => { controller.abort(); }));
  assert.equal(calls, 1);
});
