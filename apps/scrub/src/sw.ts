import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// app shell + wasm, so scrub keeps working with no signal. model weights are cached separately by the
// vision worker (Cache API), not here
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

export const SHARE_CACHE = "unlisted-share";

// os share sheet -> POST /share-target. we catch it right here, stash the file in a local cache, and
// bounce to the app. the request never reaches a server
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share-target") return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const file = form.get("photo");
        if (file && typeof file !== "string") {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put("/shared-photo", new Response(file, { headers: { "content-type": file.type } }));
        }
      } catch {
        // weird share payload. just open the app and let them pick a photo by hand
      }
      return Response.redirect("/?shared=1", 303);
    })(),
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
