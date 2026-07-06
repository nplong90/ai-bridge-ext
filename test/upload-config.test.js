import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateUploadConfig, SUPPORTED_MIME_DEFAULT } from "../src/config/upload-config.js";

const cfg = JSON.parse(readFileSync(new URL("../src/config/gemini-upload.json", import.meta.url)));

test("shipped config passes validation", () => {
  assert.equal(validateUploadConfig(cfg), cfg);
});

test("validator rejects missing upload.url", () => {
  const bad = { ...cfg, upload: { tenantId: "x" } };
  assert.throws(() => validateUploadConfig(bad), /BAD_CONFIG:upload.url/);
});

test("default mime list is non-empty and includes audio/ogg", () => {
  assert.ok(SUPPORTED_MIME_DEFAULT.includes("audio/ogg"));
});
