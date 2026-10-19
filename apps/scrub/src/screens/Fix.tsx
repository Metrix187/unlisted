import { Button, Note, Progress, Screen, Toggle } from "@unlisted/ui";
import type { Backdrop, ScrubMode } from "@unlisted/vision";
import { useState } from "preact/hooks";
import type { Busy, Photo as PhotoT } from "../App";
import { Photo } from "../components/Photo";

type Props = {
  photo: PhotoT;
  busy: Busy;
  error: string | null;
  onScrub: (o: { mode: ScrubMode; backdrop: Backdrop; noise: boolean }) => void;
  onBack: () => void;
};

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;

export function Fix({ photo, busy, error, onScrub, onBack }: Props) {
  const [hotspots, setHotspots] = useState(false);
  const [metaOnly, setMetaOnly] = useState(false);
  const [noise, setNoise] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>("blur");

  const mode: ScrubMode = metaOnly ? "metadata" : hotspots ? "hotspots" : "background";
  const label =
    mode === "metadata" ? "Strip metadata" : mode === "hotspots" ? "Blur the hot spots" : "Scrub background";
  const noSubject = mode === "background" && !photo.analysis.hasPerson;

  return (
    <Screen title="Scrub" step="2 of 3">
      <Photo src={photo.url} heat={photo.analysis.heat} alt="Your photo" />

      <Button
        variant="primary"
        big
        disabled={!!busy}
        onClick={() => onScrub({ mode, backdrop, noise })}
        data-testid="scrub"
      >
        {label}
      </Button>

      {mode === "background" && (
        <div class="seg" role="radiogroup" aria-label="Background">
          {(["blur", "plain"] as const).map((b) => (
            <button
              type="button"
              role="radio"
              aria-checked={backdrop === b}
              class={backdrop === b ? "on" : ""}
              onClick={() => setBackdrop(b)}
              key={b}
              data-testid={`backdrop-${b}`}
            >
              {b === "blur" ? "Blurred background" : "Plain background"}
            </button>
          ))}
        </div>
      )}

      {noSubject && (
        <Note>
          We didn't spot a person or pet, so the whole photo will get blurred. "Blur only the hot spots" keeps
          more of it.
        </Note>
      )}

      {busy && <Progress value={busy.value} label={busy.label} />}
      {error && <Note>{error}</Note>}

      <div class="u-card toggles">
        <Toggle
          label="Blur only the hot spots"
          hint="Keeps the room, blurs the red parts."
          checked={hotspots}
          disabled={metaOnly || !!busy}
          onChange={(v) => setHotspots(v)}
          testId="t-hotspots"
        />
        <Toggle
          label="Strip metadata only"
          hint={
            metaOnly ? (
              <span class="warn">This alone won't stop photo-matching tools. They don't use metadata.</span>
            ) : (
              "Removes location and camera info, leaves the picture alone."
            )
          }
          checked={metaOnly}
          disabled={!!busy}
          onChange={(v) => setMetaOnly(v)}
          testId="t-meta"
        />
        <Toggle
          label={
            <>
              Add matching noise<span class="u-tag">experimental</span>
            </>
          }
          title="Makes retrieval models less likely to match this. Decays as they retrain."
          hint={
            <>
              Makes retrieval models less likely to match this. Decays as they retrain.
              {!hasWebGPU &&
                " This needs WebGPU, which this browser doesn't seem to have, so it'll probably get skipped."}{" "}
              First use downloads an 88 MB model.
            </>
          }
          checked={noise}
          disabled={!!busy}
          onChange={(v) => setNoise(v)}
          testId="t-noise"
        />
      </div>

      <Button variant="link" onClick={onBack} disabled={!!busy}>
        Back
      </Button>
    </Screen>
  );
}
