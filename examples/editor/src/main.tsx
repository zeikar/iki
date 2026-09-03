import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// StrictMode is enabled intentionally: it double-invokes effects in dev to
// surface lifecycle bugs. The Preview component creates one fresh
// IkiPlayer per effect run and destroys it in that run's cleanup, so the
// double-mount is safe by design.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
