import { Button, Note, Progress, Screen } from "@unlisted/ui";
import { useRef, useState } from "preact/hooks";
import type { Busy, Photo as PhotoT } from "../App";
import { Photo, Score } from "../components/Photo";

type Props = {
  photo: PhotoT | null;
  busy: Busy;
  error: string | null;
  modelsReady: boolean;
  onPick: (b: Blob) => void;
  onNext: () => void;
};

export function Pick({ photo, busy, error, modelsReady, onPick, onNext }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (files: FileList | null | undefined) => {
    const f = files?.[0];
    if (f?.type.startsWith("image/")) onPick(f);
  };

  return (
    <Screen title="Scrub" step="1 of 3">
      <p class="u-privacy" data-testid="privacy">
        Your photo stays on this device. Nothing gets uploaded, not to us, not to anyone. All the work happens
        right here in your browser.
      </p>
      <p class="small u-muted">
        First use downloads about 26 MB of models, then caches them in this browser. Highlights and scores are
        rough heuristics; they cannot tell you whether a photo is safe to share.
      </p>

      {photo ? (
        <>
          <Photo
            src={photo.url}
            heat={photo.analysis.heat}
            alt="Your photo, with heuristic room-clue highlights"
            testId="photo"
          />
          <p class="caption" data-testid="caption">
            {photo.analysis.caption}
          </p>
          <Score value={photo.analysis.score} />
          <Button variant="primary" big onClick={onNext} disabled={!!busy} data-testid="next">
            Fix it
          </Button>
          <Button variant="link" onClick={() => input.current?.click()} disabled={!!busy}>
            Pick a different photo
          </Button>
        </>
      ) : (
        <button
          type="button"
          class={`drop${over ? " drop--over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer?.files);
          }}
          disabled={!!busy}
          data-testid="drop"
        >
          <strong>Pick a photo</strong>
          <span class="u-muted">
            or drop one here. We'll show you what in the room could give away where it is.
          </span>
        </button>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        class="u-sr"
        data-testid="file"
        onChange={(e) => {
          take((e.currentTarget as HTMLInputElement).files);
          (e.currentTarget as HTMLInputElement).value = "";
        }}
      />

      {busy && <Progress value={busy.value} label={busy.label} />}
      {!busy && !modelsReady && !error && <p class="u-muted small">Warming up…</p>}
      {error && <Note>{error}</Note>}
    </Screen>
  );
}
