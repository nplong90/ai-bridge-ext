import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskFileRequest } from "../host/aibridge-host.mjs";

test("parseAskFileRequest reads meta from query + bytes from body", () => {
  const r = parseAskFileRequest({
    query: new URLSearchParams("prompt=hi&mime=audio/ogg&filename=a.ogg&path=A"),
    bodyBuffer: Buffer.from([1, 2, 3]),
  });
  assert.equal(r.prompt, "hi");
  assert.equal(r.mime, "audio/ogg");
  assert.equal(r.filename, "a.ogg");
  assert.equal(r.path, "A");
  assert.deepEqual([...r.bytes], [1, 2, 3]);
});

test("parseAskFileRequest rejects empty body", () => {
  assert.throws(() => parseAskFileRequest({ query: new URLSearchParams("mime=audio/ogg"), bodyBuffer: Buffer.alloc(0) }), /BAD_REQUEST/);
});

test("parseAskFileRequest rejects a mime with CRLF (header injection)", () => {
  const query = new URLSearchParams();
  query.set("mime", "audio/ogg\r\nX: y"); // raw CRLF kept in the value
  assert.throws(() => parseAskFileRequest({ query, bodyBuffer: Buffer.from([1]) }), /BAD_REQUEST/);
});

test("parseAskFileRequest accepts a normal structured mime", () => {
  const r = parseAskFileRequest({
    query: new URLSearchParams("mime=application/vnd.ms-excel"),
    bodyBuffer: Buffer.from([1]),
  });
  assert.equal(r.mime, "application/vnd.ms-excel");
});
