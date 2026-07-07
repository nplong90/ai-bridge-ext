// Validate the shape of gemini-upload.json so a bad edit fails loudly, not silently at runtime.
export const SUPPORTED_MIME_DEFAULT = [
  "audio/ogg", "audio/mpeg", "audio/mp3", "audio/wav", "audio/aac", "audio/flac", "audio/aiff",
  "video/mp4", "video/mpeg", "video/quicktime", "video/webm", "video/x-msvideo", "video/3gpp",
  "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
  "application/pdf", "text/plain",
];

const REQUIRED = ["upload.url", "upload.tenantId", "generate.url", "generate.hl",
  "scrapeKeys.at", "scrapeKeys.bl", "scrapeKeys.fsid", "freq.fileMagic"];

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function validateUploadConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("BAD_CONFIG:root");
  for (const p of REQUIRED) {
    if (get(cfg, p) == null) throw new Error("BAD_CONFIG:" + p);
  }
  if (!Array.isArray(cfg.supportedMime) || cfg.supportedMime.length === 0) {
    throw new Error("BAD_CONFIG:supportedMime");
  }
  return cfg;
}
