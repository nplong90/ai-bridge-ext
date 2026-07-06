import { test } from "node:test";
import assert from "node:assert/strict";
import { chatgptDriver } from "../src/drivers/chatgpt.js";
import { geminiDriver, scrapeTokens, buildGeminiDeleteRequest, buildGeminiGenerateRequest, checkMime, uploadStartHeaders, isUploadTokenValid, classifyPathAResult } from "../src/drivers/gemini.js";
import { DRIVERS, pickDriver, driverById, DRIVER_META } from "../src/drivers/index.js";

test("chatgpt driver identity + host match", () => {
  assert.equal(chatgptDriver.id, "chatgpt");
  assert.equal(chatgptDriver.hostMatch("chatgpt.com"), true);
  assert.equal(chatgptDriver.hostMatch("gemini.google.com"), false);
  assert.equal(chatgptDriver.newChatUrl, "https://chatgpt.com/");
});

test("chatgpt uses DOM read mode", () => {
  assert.equal(chatgptDriver.readMode, "dom");
  assert.equal(typeof chatgptDriver.readAnswer, "function");
});

test("gemini driver identity + host match", () => {
  assert.equal(geminiDriver.id, "gemini");
  assert.equal(geminiDriver.hostMatch("gemini.google.com"), true);
  assert.equal(geminiDriver.hostMatch("chatgpt.com"), false);
  assert.equal(geminiDriver.newChatUrl, "https://gemini.google.com/app");
});

test("gemini uses network read mode", () => {
  assert.equal(geminiDriver.readMode, "net");
  assert.equal(typeof geminiDriver.readAnswer, "function");
});

test("scrapeTokens pulls WIZ tokens from HTML", () => {
  const html = 'x"SNlM0e":"AT_TOK",y"cfb2h":"BL_TOK",z"FdrFJe":"SID_TOK"w';
  assert.deepEqual(scrapeTokens(html), { at: "AT_TOK", bl: "BL_TOK", fsid: "SID_TOK" });
});

test("buildGeminiDeleteRequest forms GzXR5e batchexecute call (no double c_ prefix)", () => {
  const a = buildGeminiDeleteRequest({ convId: "ID1", at: "AT", bl: "BL", fsid: "SID", reqid: 12345 });
  assert.ok(a.url.includes("/_/BardChatUi/data/batchexecute"));
  assert.ok(a.url.includes("rpcids=GzXR5e"));
  assert.ok(a.body.includes("c_ID1"));
  assert.ok(a.body.includes("at=AT"));
  // already-prefixed id must not become c_c_...
  const b = buildGeminiDeleteRequest({ convId: "c_ID2", at: "AT", bl: "BL", fsid: "SID", reqid: 1 });
  assert.ok(b.body.includes("c_ID2"));
  assert.ok(!b.body.includes("c_c_ID2"));
});

test("registry picks driver by host", () => {
  assert.equal(pickDriver("chatgpt.com").id, "chatgpt");
  assert.equal(pickDriver("gemini.google.com").id, "gemini");
  assert.equal(pickDriver("example.com"), null);
});

test("driverById + meta", () => {
  assert.equal(driverById("gemini").id, "gemini");
  assert.equal(driverById("nope"), null);
  assert.equal(DRIVERS.length, 2);
  assert.deepEqual(DRIVER_META.map((d) => d.id).sort(), ["chatgpt", "gemini"]);
});

test("buildGeminiGenerateRequest embeds prompt, token, mime, filename in f.req", () => {
  const cfg = {
    generate: { url: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", hl: "en" },
    freq: { fileMagic: 4 },
  };
  const { url, body } = buildGeminiGenerateRequest({
    prompt: "đọc nội dung", fileToken: "/contrib_service/ttl_1d/TOK", mime: "audio/ogg",
    filename: "chunk1.ogg", at: "AT_TOK", bl: "BL", fsid: "SID", reqid: 12345, cfg,
  });
  assert.ok(url.startsWith(cfg.generate.url));
  assert.ok(url.includes("f.sid=SID"));
  assert.ok(url.includes("_reqid=12345"));
  assert.ok(url.includes("rt=c"));
  const params = new URLSearchParams(body);
  const decoded = params.get("f.req");
  assert.ok(decoded.includes("đọc nội dung"));
  assert.ok(decoded.includes("/contrib_service/ttl_1d/TOK"));
  assert.ok(decoded.includes("audio/ogg"));
  assert.ok(decoded.includes("chunk1.ogg"));
  assert.equal(params.get("at"), "AT_TOK");
});

test("checkMime flags unsupported without blocking", () => {
  assert.deepEqual(checkMime("audio/ogg", ["audio/ogg"]), { mime: "audio/ogg", supported: true });
  assert.deepEqual(checkMime("application/x-weird", ["audio/ogg"]), { mime: "application/x-weird", supported: false });
});

test("uploadStartHeaders sets resumable start headers + filename body", () => {
  const { headers, body } = uploadStartHeaders({ byteLength: 1234, filename: "a.ogg", tenantId: "bard-storage" });
  assert.equal(headers["X-Goog-Upload-Protocol"], "resumable");
  assert.equal(headers["X-Goog-Upload-Command"], "start");
  assert.equal(headers["X-Goog-Upload-Header-Content-Length"], "1234");
  assert.equal(headers["X-Tenant-Id"], "bard-storage");
  assert.equal(body, "File name: a.ogg");
});

test("isUploadTokenValid accepts contrib_service token only", () => {
  assert.equal(isUploadTokenValid("/contrib_service/ttl_1d/abc_XYZ"), true);
  assert.equal(isUploadTokenValid("<html>error</html>"), false);
  assert.equal(isUploadTokenValid(""), false);
});

test("classifyPathAResult falls back on each failure signal", () => {
  const ok = { tokensOk: true, uploadOk: true, generateStatus: 200, answer: "hi" };
  assert.equal(classifyPathAResult(ok), "ok");
  assert.equal(classifyPathAResult({ ...ok, tokensOk: false }), "fallback");
  assert.equal(classifyPathAResult({ ...ok, uploadOk: false }), "fallback");
  assert.equal(classifyPathAResult({ ...ok, generateStatus: 400 }), "fallback");
  assert.equal(classifyPathAResult({ ...ok, answer: "" }), "fallback");
});
