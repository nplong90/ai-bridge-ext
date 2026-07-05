import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAsk, waitFor, readStable, cdpImageDataUrl } from "../src/shared.js";

test("validateAsk accepts prompt", () => {
  assert.deepEqual(validateAsk({ prompt: "hi" }), { prompt: "hi", images: [], provider: null });
});

test("validateAsk passes provider + images through", () => {
  const r = validateAsk({ prompt: "", images: [{ data: "x" }], provider: "gemini" });
  assert.equal(r.provider, "gemini");
  assert.equal(r.images.length, 1);
});

test("validateAsk rejects empty prompt with no images", () => {
  assert.throws(() => validateAsk({ prompt: "   " }), /EMPTY_REQUEST/);
});

test("validateAsk rejects non-object", () => {
  assert.throws(() => validateAsk(null), /BAD_REQUEST/);
});

test("waitFor returns true when predicate satisfied", async () => {
  let n = 0;
  const ok = await waitFor(() => ++n >= 2, { tries: 5, interval: 1 });
  assert.equal(ok, true);
});

test("waitFor returns false on timeout", async () => {
  const ok = await waitFor(() => false, { tries: 3, interval: 1 });
  assert.equal(ok, false);
});

test("readStable returns value once stable", async () => {
  const val = await readStable(() => "done", { tries: 10, interval: 1, stable: 3 });
  assert.equal(val, "done");
});

test("readStable returns empty when readFn never yields", async () => {
  const val = await readStable(() => "", { tries: 3, interval: 1, stable: 3 });
  assert.equal(val, "");
});

test("cdpImageDataUrl builds data url from base64 body", () => {
  assert.equal(cdpImageDataUrl({ base64Encoded: true, body: "AAAA" }, "image/png"), "data:image/png;base64,AAAA");
  assert.equal(cdpImageDataUrl({ base64Encoded: false, body: "<svg>" }, "image/svg"), null);
  assert.equal(cdpImageDataUrl(null, "image/png"), null);
});
