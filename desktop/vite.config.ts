import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { resolveEdition } from "../scripts/edition.mjs";

const edition = resolveEdition();

function editionTitle(): Plugin {
  return {
    name: "novoard-edition-title",
    transformIndexHtml(html) {
      return html.replace(/<title>.*?<\/title>/, `<title>${edition.productName}</title>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), editionTitle()],
  define: {
    __NOVOARD_EDITION__: JSON.stringify(edition),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 59125,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
