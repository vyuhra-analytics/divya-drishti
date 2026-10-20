import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connectStream } from "./store";
import { applyToDocument, useSettings } from "./settings";
import "./styles.css";

applyToDocument(useSettings.getState());
useSettings.subscribe(applyToDocument);
connectStream();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
