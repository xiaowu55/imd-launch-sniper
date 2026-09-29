import test from "node:test";
import assert from "node:assert/strict";
import { publicObservation } from "../src/observer.js";

test("public observation cannot reflect nested untrusted objects into the status API", () => {
  const deep = { malicious: { nested: true } };
  const row = { id: "launch", launchNumber: 1, chainId: 1, status: "live" };
  for (const key of ["id", "launchNumber", "chainId", "status", "kind"])
    assert.throws(() => publicObservation({ launches: [{ ...row, [key]: deep }] }, {}));
  const result = publicObservation({ launches: [row] }, {
    policies: [null, { version: deep, kind: deep, params: { chainId: deep } }, { version: "1", kind: "evm_project", params: { chainId: 1 } }],
  });
  assert.deepEqual(result.policies, [
    { version: null, kind: null, chainId: null },
    { version: "1", kind: "evm_project", chainId: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /malicious|nested/);
});
