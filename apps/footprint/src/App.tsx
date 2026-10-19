import { useState } from "preact/hooks";
import { type LookupResult, lookup } from "./api";
import type { Kind } from "./lib/classify";
import { Address } from "./screens/Address";
import { Grid } from "./screens/Grid";
import { PhotoSearch } from "./screens/PhotoSearch";
import { TakeDown } from "./screens/TakeDown";

export type Kinds = Record<string, Kind>;

export function App() {
  const [screen, setScreen] = useState<"address" | "grid" | "takedown" | "photo">("address");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [kinds, setKinds] = useState<Kinds>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find(address: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await lookup(address);
      setResult(r);
      setKinds({});
      setScreen("grid");
      window.scrollTo(0, 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (screen === "photo") return <PhotoSearch onBack={() => setScreen(result ? "grid" : "address")} />;
  if (screen === "grid" && result)
    return (
      <Grid
        result={result}
        kinds={kinds}
        onKind={(url, k) => setKinds((prev) => (prev[url] === k ? prev : { ...prev, [url]: k }))}
        onNext={() => {
          setScreen("takedown");
          window.scrollTo(0, 0);
        }}
        onBack={() => setScreen("address")}
      />
    );
  if (screen === "takedown" && result)
    return <TakeDown result={result} kinds={kinds} onBack={() => setScreen("grid")} />;
  return <Address busy={busy} error={error} onFind={find} onPhoto={() => setScreen("photo")} />;
}
