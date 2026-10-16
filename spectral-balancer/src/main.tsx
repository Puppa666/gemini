import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import SpectralBalancer from "./SpectralBalancer";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SpectralBalancer />
  </StrictMode>
);
