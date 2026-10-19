import type { Analysis, Backdrop, ProgressEvent, ScrubMode, ScrubResult } from "@unlisted/vision";
import { useEffect, useState } from "preact/hooks";
import { takeSharedPhoto, vision } from "./lib";
import { Done } from "./screens/Done";
import { Fix } from "./screens/Fix";
import { Pick } from "./screens/Pick";

export type Photo = { blob: Blob; url: string; analysis: Analysis; hadMetadata: boolean };
export type Outcome = { result: ScrubResult; url: string; analysis: Analysis };
export type Busy = { label: string; value: number } | null;

export function App() {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [screen, setScreen] = useState<"pick" | "fix" | "done">("pick");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelsReady, setModelsReady] = useState(false);

  const progress = (p: ProgressEvent) => setBusy({ label: p.label, value: p.value });

  // start pulling the models right away so they're cached for offline use after the first visit
  useEffect(() => {
    vision()
      .init((p) => !photo && setBusy({ label: p.label, value: p.value }))
      .then(() => {
        setModelsReady(true);
        setBusy((b) => (b?.label.startsWith("Getting") ? null : b));
      })
      .catch((e: Error) => setError(`Couldn't get the on-device models ready: ${e.message}`));
    takeSharedPhoto().then((b) => b && pick(b));
  }, []);

  async function pick(blob: Blob) {
    setError(null);
    setOutcome(null);
    if (photo) URL.revokeObjectURL(photo.url);
    try {
      const { inspectMetadata } = await import("@unlisted/vision");
      const meta = inspectMetadata(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()));
      const analysis = await vision().analyze(blob, progress);
      setPhoto({
        blob,
        url: URL.createObjectURL(blob),
        analysis,
        hadMetadata: meta.exif || meta.xmp || meta.iptc,
      });
      // ?debug leaves the raw analysis on window for poking at in devtools. it never leaves the tab
      if (location.search.includes("debug"))
        (window as unknown as { __analysis: Analysis }).__analysis = analysis;
      setScreen("pick");
    } catch (e) {
      setError(`That photo didn't open: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function scrub(opts: { mode: ScrubMode; backdrop: Backdrop; noise: boolean }) {
    setError(null);
    try {
      // ?slow lets the matching noise fall back to wasm when there's no webgpu. minutes, not seconds
      const slow = new URLSearchParams(location.search).has("slow");
      const result = await vision().scrub({ ...opts, slow }, progress);
      setBusy({ label: "Checking the result", value: 0.99 });
      // re-run the same analysis on the output so the heat map is honest, not a victory lap
      const analysis = await vision().analyze(result.blob, undefined, false);
      if (outcome) URL.revokeObjectURL(outcome.url);
      setOutcome({ result, url: URL.createObjectURL(result.blob), analysis });
      setScreen("done");
    } catch (e) {
      setError(`Scrubbing failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  function startOver() {
    if (photo) URL.revokeObjectURL(photo.url);
    if (outcome) URL.revokeObjectURL(outcome.url);
    setPhoto(null);
    setOutcome(null);
    setScreen("pick");
  }

  if (screen === "done" && photo && outcome)
    return <Done photo={photo} outcome={outcome} onBack={() => setScreen("fix")} onStartOver={startOver} />;
  if (screen === "fix" && photo)
    return <Fix photo={photo} busy={busy} error={error} onScrub={scrub} onBack={() => setScreen("pick")} />;
  return (
    <Pick
      photo={photo}
      busy={busy}
      error={error}
      modelsReady={modelsReady}
      onPick={pick}
      onNext={() => setScreen("fix")}
    />
  );
}
