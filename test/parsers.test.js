import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeminiStream, parseChatgptSse, extractGeminiImages, parseGeminiTts } from "../src/parsers.js";

test("parseGeminiStream pulls answer + c_id from a wrb.fr StreamGenerate body", () => {
  // Shape verified live: [["wrb.fr", null, "<innerJSON>"]]; inner[1][0]=c_id, inner[4][0][1][0]=answer.
  const inner = JSON.stringify([null, ["c_abc123"], null, null, [["rc_x", ["PARSE-ME"]]]]);
  const raw = ")]}'\n\n131\n" + JSON.stringify([["wrb.fr", null, inner, null, null, null, "generic"]]) + "\n";
  const out = parseGeminiStream(raw);
  assert.equal(out.answer, "PARSE-ME");
  assert.equal(out.conversationId, "c_abc123");
});

test("parseGeminiStream returns nulls on junk", () => {
  const out = parseGeminiStream(")]}'\n\n4\n[[\"e\",4]]\n");
  assert.equal(out.answer, null);
});

test("extractGeminiImages pulls + dedupes escaped gg-dl urls", () => {
  const raw = 'x https:\\/\\/lh3.googleusercontent.com\\/gg-dl\\/ABC123 y https:\\/\\/lh3.googleusercontent.com\\/gg-dl\\/ABC123 z https:\\/\\/lh3.googleusercontent.com\\/gg-dl\\/XYZ789"';
  const imgs = extractGeminiImages(raw);
  assert.deepEqual(imgs, ["https://lh3.googleusercontent.com/gg-dl/ABC123", "https://lh3.googleusercontent.com/gg-dl/XYZ789"]);
});

test("extractGeminiImages matches the image-mode /gg/ path form", () => {
  const raw = 'x https:\\/\\/lh3.googleusercontent.com\\/gg\\/AFfU-fJfgUMstaJ y';
  assert.deepEqual(extractGeminiImages(raw), ["https://lh3.googleusercontent.com/gg/AFfU-fJfgUMstaJ"]);
});

test("extractGeminiImages also matches image_generation_content form", () => {
  const raw = 'a http:\\/\\/googleusercontent.com\\/image_generation_content\\/306 b';
  assert.deepEqual(extractGeminiImages(raw), ["http://googleusercontent.com/image_generation_content/306"]);
});

test("parseGeminiStream includes images array", () => {
  const inner = JSON.stringify([null, ["c_x"], null, null, [["rc", ["hi"]]]]);
  const raw = ")]}'\n" + JSON.stringify([["wrb.fr", null, inner]]) + '\nhttps:\\/\\/lh3.googleusercontent.com\\/gg-dl\\/IMG1"';
  const out = parseGeminiStream(raw);
  assert.deepEqual(out.images, ["https://lh3.googleusercontent.com/gg-dl/IMG1"]);
});

test("parseGeminiTts extracts ogg opus audio from a wrb.fr XqA3Ic body", () => {
  const bytes = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2000)]); // >1000 base64 chars
  const b64 = bytes.toString("base64");
  const raw = ")]}'\n\n999\n" + JSON.stringify([["wrb.fr", "XqA3Ic", JSON.stringify([b64])]]) + "\n";
  const out = parseGeminiTts(raw);
  assert.equal(out.mimeType, "audio/ogg");
  assert.ok(out.dataUrl.startsWith("data:audio/ogg;base64,"));
});

test("parseGeminiTts re-pads base64 written without padding (Gemini's \\u003d form)", () => {
  const bytes = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2001)]); // forces '==' padding
  const unpadded = bytes.toString("base64").replace(/=+$/, "");
  const out = parseGeminiTts('junk "' + unpadded + '" more');
  assert.equal(out.mimeType, "audio/ogg");
});

test("parseGeminiTts detects mp3 (ID3) and returns null on none", () => {
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2000)]).toString("base64");
  assert.equal(parseGeminiTts("[[\"wrb.fr\",\"XqA3Ic\",\"[\\\"" + mp3 + "\\\"]\"]]").mimeType, "audio/mpeg");
  assert.equal(parseGeminiTts(")]}'\n[[\"e\",4]]"), null);
});

test("parseChatgptSse accumulates append deltas + conversation id", () => {
  const raw = [
    'data: {"type":"resume_conversation_token","conversation_id":"conv-9"}',
    'data: {"p":"/message/content/parts/0","o":"append","v":"Hel"}',
    'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"lo"}]}',
    "data: [DONE]",
  ].join("\n\n");
  const out = parseChatgptSse(raw);
  assert.equal(out.answer, "Hello");
  assert.equal(out.conversationId, "conv-9");
});

test("parseChatgptSse seeds from an assistant add op", () => {
  const raw = 'data: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"content":{"parts":["seed"]}}},"conversation_id":"c1"}\n\ndata: {"p":"/message/content/parts/0","o":"append","v":"-x"}';
  const out = parseChatgptSse(raw);
  assert.equal(out.answer, "seed-x");
  assert.equal(out.conversationId, "c1");
});
