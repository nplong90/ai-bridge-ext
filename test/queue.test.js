import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue } from "../src/queue.js";

test("runs tasks one at a time in FIFO order", async () => {
  const q = createSerialQueue();
  const order = [];
  const mk = (n, ms) => () => new Promise((r) => setTimeout(() => { order.push(n); r(n); }, ms));
  const results = await Promise.all([q.enqueue(mk(1, 30)), q.enqueue(mk(2, 5)), q.enqueue(mk(3, 1))]);
  assert.deepEqual(order, [1, 2, 3], "must not interleave despite differing delays");
  assert.deepEqual(results, [1, 2, 3]);
});

test("a rejected task does not block the next", async () => {
  const q = createSerialQueue();
  const bad = q.enqueue(() => Promise.reject(new Error("boom")));
  await assert.rejects(bad, /boom/);
  const good = await q.enqueue(() => Promise.resolve("ok"));
  assert.equal(good, "ok");
});
