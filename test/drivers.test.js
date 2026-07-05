import { test } from "node:test";
import assert from "node:assert/strict";
import { chatgptDriver } from "../src/drivers/chatgpt.js";
import { geminiDriver, scrapeTokens, buildGeminiDeleteRequest } from "../src/drivers/gemini.js";
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
