import { Button, Note, Screen } from "@unlisted/ui";
import { useState } from "preact/hooks";

type Props = { busy: boolean; error: string | null; onFind: (a: string) => void; onPhoto: () => void };

export function Address({ busy, error, onFind, onPhoto }: Props) {
  const [value, setValue] = useState("");
  return (
    <Screen title="Footprint" step="1 of 3">
      <p class="lead">
        Find links to check listing sites and guidance for requesting photo removal. Automated lookups are
        largely blocked; we cannot find every photo or guarantee removal.
      </p>

      <form
        class="addr"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onFind(value);
        }}
      >
        <label for="addr" class="u-sr">
          Your address or a listing link
        </label>
        <input
          id="addr"
          data-testid="address"
          type="text"
          inputMode="text"
          autoComplete="street-address"
          placeholder="123 Main St, Springfield, IL 62701"
          value={value}
          onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
          disabled={busy}
        />
        <Button variant="primary" big type="submit" disabled={busy || !value.trim()} data-testid="find">
          {busy ? "Looking…" : "Check listing sites"}
        </Button>
      </form>

      <p class="u-privacy" data-testid="privacy">
        Your address is sent to a Cloudflare Worker for lookup. Our code does not store or log the address;
        Cloudflare still handles the request. We cache a SHA-256 address hash and result data for 24 hours.
        The hash is not anonymous: addresses can be guessed.
      </p>
      <p class="small u-muted">
        You can also paste a Zillow, Redfin, Realtor.com, or Trulia link. Want to try it first? Use{" "}
        <button
          type="button"
          class="u-btn u-btn--link inline"
          onClick={() => setValue("123 Example St, Springfield, IL 62701")}
        >
          the made-up demo address
        </button>
        .
      </p>

      {error && <Note>{error}</Note>}

      <div class="u-card">
        <strong>Have a photo instead?</strong>
        <p class="small u-muted">
          Check where a photo of a room shows up online. The photo never goes through us.
        </p>
        <Button onClick={onPhoto} data-testid="photo-mode">
          Search with a photo
        </Button>
      </div>
    </Screen>
  );
}
