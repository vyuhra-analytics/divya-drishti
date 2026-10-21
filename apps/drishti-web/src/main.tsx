import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connectStream, useStore } from "./store";
import { syncInstruments } from "./instrumentsClient";
import { applyToDocument, useSettings } from "./settings";
import "./styles.css";

applyToDocument(useSettings.getState());
useSettings.subscribe(applyToDocument);
// instruments added in Settings must be in the catalogue before the saved layout renders; don't wait long if the stream is slow
await Promise.race([syncInstruments(), new Promise((r) => setTimeout(r, 1500))]);
setInterval(() => void syncInstruments(), 60_000); // another tab or window may add or remove one
connectStream();

/** Remounts the app when the tracked instruments change, so every picker and list reads the new SYMBOLS. */
function Root() {
  const rev = useStore((s) => s.instrumentsRev);
  return <App key={rev} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
