// MAIN-world interceptor. Declared in the manifest with "world":"MAIN" + "run_at":
// "document_start" so it patches XHR/fetch BEFORE the site's app captures references.
// It is a dumb capturer: on a completed generation response it forwards the RAW body to
// the isolated content script via postMessage. All parsing lives in the isolated world
// (parsers.js) where it is unit-testable and has module support. No chrome.* here.
(() => {
  // Endpoint that carries the assistant answer for net-mode drivers. Only Gemini uses network
  // interception, and its StreamGenerate goes over XHR — so we patch XHR only. ChatGPT is
  // DOM-read (its f/conversation bypasses page-world fetch via a service worker), so there is
  // nothing to intercept there. We intentionally do NOT wrap window.fetch: it caught nothing
  // useful and put this file in the stack trace of every page fetch (e.g. Gemini's own
  // ad/analytics beacons that its CSP blocks), which looked like our errors.
  const MATCH = /\/StreamGenerate/;

  function forward(url, body) {
    try {
      window.postMessage({ source: "cgw-net", url: String(url), body: String(body) }, location.origin);
    } catch (_) { /* ignore */ }
  }

  // XHR (Gemini StreamGenerate).
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cgwUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__cgwUrl || "";
    if (MATCH.test(url)) {
      this.addEventListener("load", () => forward(url, this.responseText || ""));
    }
    return send.apply(this, arguments);
  };
})();
