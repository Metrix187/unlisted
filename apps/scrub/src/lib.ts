import { VisionClient } from "@unlisted/vision/client";

let client: VisionClient | undefined;

export function vision() {
  client ??= new VisionClient(new URL(import.meta.env.BASE_URL, location.href).href);
  return client;
}

export function outName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `scrubbed-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.jpg`;
}

export function download(blob: Blob, name = outName()) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// web share with the actual file if the browser can, otherwise just save it.
// sharing hands the file to the app *you* pick, it doesn't touch any server of ours
export async function share(blob: Blob): Promise<"shared" | "saved" | "cancelled"> {
  const file = new File([blob], outName(), { type: "image/jpeg" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return "shared";
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return "cancelled";
    }
  }
  download(blob, file.name);
  return "saved";
}

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferredInstall: InstallEvent | undefined;
const installListeners = new Set<() => void>();

// grab the install prompt early but sit on it. we only offer install after a scrub actually worked
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e as InstallEvent;
  for (const fn of installListeners) fn();
});

export function canInstall() {
  return !!deferredInstall;
}

export function onInstallable(fn: () => void) {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

export async function install() {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = undefined;
}

// a photo that came in through the os share sheet, parked in a local cache by the service worker
export async function takeSharedPhoto(): Promise<Blob | undefined> {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("unlisted-share");
    const res = await cache.match("/shared-photo");
    if (!res) return;
    await cache.delete("/shared-photo");
    return await res.blob();
  } catch {
    return;
  }
}
