import { env } from "../env.js";

// WP1.1: behaviour unchanged from qingzhou/src/public-origin.js, typed.
export function resolvePublicOrigin(configured: unknown) {
  const raw = String(configured || "").trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.username || url.password) return "";
  return url.origin;
}

/** Email links must land on the app's mount prefix, not the shared host root. */
export function appHomeUrl(origin: unknown) {
  return `${String(origin || "").replace(/\/+$/, "")}${env.baseUrlPath}`;
}
