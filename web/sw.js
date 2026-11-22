// Bump the cache name on every front-end release so old PWA caches cannot
// shadow new files. Buckets use the "task-" prefix only: CacheStorage is
// shared per origin, so a blanket "delete every bucket" would wipe caches
// belonging to any other app on the same origin. Keep this prefix as-is.
const CACHE = "task-v57";
const PREFIX = "task-";
// Resolved from the script URL, so this is "/task/" in production and "/" in dev.
const BASE = new URL("./", self.location.href).pathname;
const PRECACHE = [
  "./", "./index.html", "./manifest.json",
  "./css/opengym.css", "./css/dock.css", "./css/task-hub.css", "./css/subpages.css", "./css/monochrome.css", "./css/workspace.css", "./css/theme-v5.css", "./css/assistant.css", "./css/draw.css", "./css/home.css", "./css/theme-uploop.css",
  "./js/features.js", "./js/date-picker.js", "./js/date-views.js", "./js/task-properties.js", "./js/decomposition.js", "./js/task-card.js", "./js/onboarding.js", "./js/chat.js", "./js/wellness.js", "./js/records.js",
  "./js/task-hub.js", "./js/workspace.js", "./js/dock.js", "./js/voice.js", "./js/guide.js", "./js/assistant.js", "./js/draw.js", "./js/home.js", "./js/praise-corpus.js", "./js/praise.js", "./css/praise.css",
  "./favicon-32.png", "./apple-touch-icon.png",
  "./icon-192.png", "./icon-512.png", "./icon-1024.png", "./icon-maskable-512.png"
];
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // API responses are never cached; the prefix keeps this correct under /task/.
  if (url.origin === self.location.origin && (url.pathname.startsWith(BASE + "api/") || url.pathname.startsWith(BASE + "v1/") || url.pathname.startsWith(BASE + "voice/"))) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))));
});
