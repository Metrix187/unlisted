import { Button, Screen } from "@unlisted/ui";
import { useEffect, useState } from "preact/hooks";
import type { Kinds } from "../App";
import type { LookupResult, SiteResult } from "../api";
import { addressKey, getRequested, renderGuide, setRequested } from "../lib/removal";
import { DemoNotice } from "./DemoNotice";

function Card({
  site,
  address,
  kinds,
  storeKey,
}: { site: SiteResult; address: string; kinds: Kinds; storeKey: string }) {
  const { html, emails } = renderGuide(site, address);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => setDone(getRequested(storeKey, site.site)), [storeKey, site.site]);

  const inside = site.photos.filter((p) => kinds[p.thumb] === "interior").length;
  const what =
    site.site === "streetview"
      ? "Street-level photos of the outside of your home."
      : site.photoCount
        ? `${site.photoCount} photo${site.photoCount === 1 ? "" : "s"}${inside ? `, ${inside} of the inside` : ""}.`
        : "We couldn't look, so check it yourself first.";

  return (
    <article class={`u-card takedown${done ? " takedown--done" : ""}`} data-testid={`card-${site.site}`}>
      <header>
        <h3>{site.name}</h3>
        <label class="req">
          <input
            type="checkbox"
            checked={done}
            data-testid={`req-${site.site}`}
            onChange={(e) => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              setDone(on);
              setRequested(storeKey, site.site, on);
            }}
          />
          Mark as requested
        </label>
      </header>
      <p class="what">
        <strong>What's there:</strong> {what}
      </p>
      {/* our own markdown from docs/REMOVAL, links already rewritten to open safely */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, build-time content */}
      <div class="guide" dangerouslySetInnerHTML={{ __html: html }} />
      {emails.map((text, i) => (
        <div class="email" key={text}>
          <pre>{text}</pre>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(i);
                setTimeout(() => setCopied(null), 2000);
              } catch {
                // no clipboard permission. the text is right there to select by hand
              }
            }}
          >
            {copied === i ? "Copied" : "Copy message"}
          </Button>
        </div>
      ))}
    </article>
  );
}

export function TakeDown({
  result,
  kinds,
  onBack,
}: { result: LookupResult; kinds: Kinds; onBack: () => void }) {
  const [key, setKey] = useState("");
  useEffect(() => {
    addressKey(result.address).then(setKey);
  }, [result.address]);
  // sites with photos first, then the ones that blocked us, then street view
  const order = [...result.sites].sort(
    (a, b) =>
      Number(b.photoCount > 0) - Number(a.photoCount > 0) ||
      Number(a.site === "streetview") - Number(b.site === "streetview"),
  );
  return (
    <Screen title="Footprint" step="3 of 3">
      <DemoNotice address={result.address} />
      <p class="lead">
        One card per site. Start at the top. The checkboxes stay on this device only, so you can come back and
        see what's left.
      </p>
      {key &&
        order.map((s) => (
          <Card key={s.site} site={s} address={result.address} kinds={kinds} storeKey={key} />
        ))}
      <Button variant="link" onClick={onBack}>
        Back to the photos
      </Button>
    </Screen>
  );
}
