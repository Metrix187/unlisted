import { Button, Note, Screen } from "@unlisted/ui";
import { useEffect, useState } from "preact/hooks";
import type { Outcome, Photo as PhotoT } from "../App";
import { BeforeAfter } from "../components/BeforeAfter";
import { Photo, Score } from "../components/Photo";
import { canInstall, download, install, onInstallable, share } from "../lib";

type Props = { photo: PhotoT; outcome: Outcome; onBack: () => void; onStartOver: () => void };

export function Done({ photo, outcome, onBack, onStartOver }: Props) {
  const [installable, setInstallable] = useState(canInstall());
  const [shareNote, setShareNote] = useState<string | null>(null);
  useEffect(() => onInstallable(() => setInstallable(true)), []);

  const before = photo.analysis.score;
  const after = outcome.analysis.score;
  const noise = outcome.result.noise;

  return (
    <Screen title="Scrub" step="3 of 3">
      <BeforeAfter before={photo.url} after={outcome.url} />

      <div class="u-card">
        <p class="small u-muted" style={{ margin: "0 0 8px" }}>
          Same check, run again on the result:
        </p>
        <Photo
          src={outcome.url}
          heat={outcome.analysis.heat}
          cool={0.32}
          alt="The scrubbed photo, re-checked"
          testId="after-photo"
        />
        <p class="caption" data-testid="after-caption">
          {outcome.analysis.caption}
        </p>
        <p class="delta">
          <Score value={before} label="before" /> <span aria-hidden="true">→</span>{" "}
          <Score value={after} label="now" />
        </p>
        <p class="small u-muted" data-testid="meta-line">
          {photo.hadMetadata
            ? "Location and camera info were in the original file. They're gone from this one."
            : "No location or camera info in the file."}
        </p>
        {noise &&
          (noise.applied ? (
            <p class="small u-muted" data-testid="noise-line">
              Matching noise: the model we tested against now rates this a{" "}
              {Math.max(0, Math.round(noise.similarityAfter * 100))}% match to your original (it was 100%).
              Heads up: in our own tests this alone rarely stopped a match, because matching tools resize
              photos in ways that wash it out. It helps a bit on top of the background scrub.
            </p>
          ) : (
            <Note>Matching noise skipped: {noise.reason}</Note>
          ))}
      </div>

      {outcome.result.mode === "metadata" && (
        <Note>Only the metadata changed. The picture itself can still be matched to listing photos.</Note>
      )}

      <div class="u-row">
        <Button
          variant="primary"
          data-testid="share"
          onClick={async () => {
            const r = await share(outcome.result.blob);
            setShareNote(
              r === "saved" ? "Your browser can't share files directly, so we saved it instead." : null,
            );
          }}
        >
          Share
        </Button>
        <Button data-testid="save" onClick={() => download(outcome.result.blob)}>
          Save
        </Button>
        <Button data-testid="again" onClick={onStartOver}>
          Start over
        </Button>
      </div>
      {shareNote && <p class="small u-muted">{shareNote}</p>}

      {installable && (
        <div class="u-card install">
          <span>Keep Scrub on your home screen. It works offline.</span>
          <Button onClick={() => install().then(() => setInstallable(false))}>Install</Button>
        </div>
      )}

      <Button variant="link" onClick={onBack}>
        Try different settings
      </Button>
    </Screen>
  );
}
