import "@unlisted/ui/tokens.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./App";

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
