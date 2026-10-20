import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connectStream } from "./store";
import "@fontsource-variable/plus-jakarta-sans";
import "./styles.css";

connectStream();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
