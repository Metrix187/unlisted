import { Button, Screen } from "@unlisted/ui";
import { useState } from "preact/hooks";
import type { Kinds } from "../App";
import { type LookupResult, type Photo, type SiteResult, thumbSrc } from "../api";
import { type Kind, classifyImg } from "../lib/classify";

type Props = {
  result: LookupResult;
  kinds: Kinds;
  onKind: (url: string, k: Kind) => void;
  onNext: () => void;
  onBack: () => void;
};

const fmt = (d?: string) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";

function Thumb({ photo, kind, onKind }: { photo: Photo; kind?: Kind; onKind: (k: Kind) => void }) {
  const { src, proxied } = thumbSrc(photo.thumb);
  // try with cors first so we can read pixels; if the cdn says no, load it plain and give up on sorting it.
  // no lazy loading: the headline counts interior photos, so the ones below the fold have to load too
  const [cors, setCors] = useState(true);
  const full = thumbSrc(photo.url).src;
  return (
    <a
      class="tile"
      href={full}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="tile"
      data-kind={kind ?? "pending"}
    >
      <img
        key={cors ? "cors" : "plain"}
        src={src}
        alt=""
        referrerpolicy="no-referrer"
        crossOrigin={cors ? "anonymous" : undefined}
        onLoad={(e) => onKind(cors ? classifyImg(e.currentTarget as HTMLImageElement) : "unknown")}
        onError={() => {
          if (cors && !proxied) setCors(false);
          else onKind("unknown");
        }}
      />
      {kind && kind !== "unknown" && (
        <span class={`badge badge--${kind}`}>{kind === "interior" ? "inside" : "outside"}</span>
      )}
    </a>
  );
}

function blockedLine(s: SiteResult) {
  if (s.reason === "robots") return "doesn't allow automated lookups, so we didn't look.";
  if (s.reason === "bot-wall") return "showed us a robot check instead of the page.";
  if (s.reason === "not-found") return "didn't have photos we could read.";
  return "didn't answer properly.";
}

export function Grid({ result, kinds, onKind, onNext, onBack }: Props) {
  const withPhotos = result.sites.filter((s) => s.photoCount > 0);
  const blocked = result.sites.filter((s) => s.site !== "streetview" && s.photoCount === 0);
  const total = withPhotos.reduce((n, s) => n + s.photoCount, 0);
  const all = withPhotos.flatMap((s) => s.photos);
  const interior = all.filter((p) => kinds[p.thumb] === "interior").length;
  const unknown = all.filter((p) => kinds[p.thumb] === "unknown").length;
  const pending = all.length - Object.keys(kinds).filter((k) => all.some((p) => p.thumb === k)).length;

  return (
    <Screen title="Footprint" step="2 of 3">
      <p class="u-muted small">{result.address}</p>

      {total > 0 ? (
        <h2 class="headline" data-testid="headline">
          We found {total} photo{total === 1 ? "" : "s"} of your home on {withPhotos.length} site
          {withPhotos.length === 1 ? "" : "s"}.{" "}
          {pending > 0 ? (
            <span class="u-muted">Checking which are inside…</span>
          ) : (
            <span class="hot">
              {interior} {interior === 1 ? "is" : "are"} interior.
            </span>
          )}
          {pending === 0 && unknown > 0 && <span class="u-muted small"> (We couldn't check {unknown}.)</span>}
        </h2>
      ) : (
        <h2 class="headline" data-testid="headline">
          We couldn't read any listing photos for this address ourselves.
        </h2>
      )}

      {blocked.length > 0 && (
        <div class="u-card blocked" data-testid="blocked">
          {blocked.map((s) => (
            <p key={s.site}>
              <strong>{s.name} blocked us — open it yourself:</strong>{" "}
              <a href={s.listingUrl} target="_blank" rel="noopener noreferrer">
                {s.listingUrl === s.searchUrl ? "search for your home" : "open the listing"}
              </a>
              <br />
              <span class="small u-muted">
                {s.name} {blockedLine(s)}
              </span>
            </p>
          ))}
        </div>
      )}

      {withPhotos.map((s) => (
        <section class="site" key={s.site} data-testid={`site-${s.site}`}>
          <header>
            <h3>{s.name}</h3>
            <span class="small u-muted">
              {[
                s.dates.listed && `listed ${fmt(s.dates.listed)}`,
                s.dates.sold && `sold ${fmt(s.dates.sold)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
              {" · "}
              <a href={s.listingUrl} target="_blank" rel="noopener noreferrer">
                listing
              </a>
            </span>
          </header>
          <div class="grid">
            {s.photos.map((p) => (
              <Thumb key={p.url} photo={p} kind={kinds[p.thumb]} onKind={(k) => onKind(p.thumb, k)} />
            ))}
          </div>
        </section>
      ))}

      <Button variant="primary" big onClick={onNext} data-testid="takedown">
        Get these taken down
      </Button>
      <p class="small u-muted">
        Some photos load straight from the listing site, so that site sees a visit. It doesn't see your
        address.
      </p>
      <Button variant="link" onClick={onBack}>
        Look up a different address
      </Button>
    </Screen>
  );
}
