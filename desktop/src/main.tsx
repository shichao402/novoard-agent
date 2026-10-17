import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { edition } from "@/lib/edition";
import { App } from "./App";
import "./index.css";

document.title = edition.productName;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
