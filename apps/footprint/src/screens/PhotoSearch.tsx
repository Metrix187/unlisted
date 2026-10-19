import { Button, Note, Screen } from "@unlisted/ui";
import { useRef, useState } from "preact/hooks";

// reverse image search, but we never touch the photo. these engines need the actual file, and there's no
// way to hand it to them by url without hosting it somewhere, which we won't. so: put it on the clipboard,
// open their upload page, the person pastes. the upload is between them and the search engine

const ENGINES = [
  { id: "lens", name: "Google Lens", url: "https://lens.google.com/" },
  { id: "bing", name: "Bing Visual Search", url: "https://www.bing.com/visualsearch" },
  { id: "tineye", name: "TinEye", url: "https://tineye.com/" },
  { id: "yandex", name: "Yandex Images", url: "https://yandex.com/images/" },
];

async function toPng(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png"),
  );
}

export function PhotoSearch({ onBack }: { onBack: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [clip, setClip] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    if (!photo) return false;
    try {
      const png = await toPng(photo.file);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setClip("copied");
      return true;
    } catch {
      setClip("failed");
      return false;
    }
  }

  return (
    <Screen title="Footprint" step="photo search">
      <p class="lead">Pick a photo of a room to see where it, or photos like it, show up online.</p>
      <p class="u-privacy" data-testid="photo-privacy">
        The photo never goes through us. When you open a search engine below, you paste it in yourself, and
        only that search engine sees it.
      </p>

      {photo ? (
        <img class="preview" src={photo.url} alt="What you picked" />
      ) : (
        <Button big onClick={() => input.current?.click()} data-testid="pick-photo">
          Pick a photo
        </Button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        class="u-sr"
        data-testid="photo-file"
        onChange={(e) => {
          const f = (e.currentTarget as HTMLInputElement).files?.[0];
          if (!f) return;
          if (photo) URL.revokeObjectURL(photo.url);
          setPhoto({ file: f, url: URL.createObjectURL(f) });
          setClip("idle");
        }}
      />

      {photo && (
        <>
          <p class="small">
            Each button copies your photo and opens the search engine in a new tab. Paste it there with{" "}
            <kbd>Ctrl</kbd>+<kbd>V</kbd> (or <kbd>⌘</kbd>+<kbd>V</kbd>), or drag the photo in.
          </p>
          <div class="engines">
            {ENGINES.map((e) => (
              <Button
                key={e.id}
                data-testid={`engine-${e.id}`}
                onClick={async () => {
                  // open first, synchronously, or popup blockers eat it
                  window.open(e.url, "_blank", "noopener,noreferrer");
                  await copy();
                }}
              >
                {e.name}
              </Button>
            ))}
          </div>
          {clip === "copied" && <p class="small u-muted">Copied. Paste it in the tab that just opened.</p>}
          {clip === "failed" && (
            <Note>
              Your browser wouldn't let us copy the image. Drag the photo into the search page instead.
            </Note>
          )}
          <Button variant="link" onClick={() => input.current?.click()}>
            Pick a different photo
          </Button>
        </>
      )}

      <div class="u-card">
        <strong>Is it in an AI training set?</strong>
        <p class="small">
          <a href="https://haveibeentrained.com/" target="_blank" rel="noopener noreferrer">
            Have I Been Trained
          </a>{" "}
          searches the big public image datasets that AI models get trained on. Search there with your photo
          (or the listing photos from the last screen). If it's in there, you can add it to their Do Not Train
          list, which some model makers honor.
        </p>
      </div>

      <Button variant="link" onClick={onBack}>
        Back
      </Button>
    </Screen>
  );
}
