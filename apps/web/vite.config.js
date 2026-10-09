import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages replaces the complete deployment on every publish. An installed
// iOS PWA can briefly retain the previous index.html, so hashed entry filenames
// may disappear before Safari refreshes that document. Stable entry filenames
// prevent that version skew. These two legacy releases bridge PWAs that were
// already open when stable filenames were introduced.
const LEGACY_PWA_ASSETS = {
  scripts: ["assets/index-BF9iKYqr.js", "assets/index-DwA_AQTp.js"],
  styles: ["assets/index-jG0wUjoT.css", "assets/index-D8kQVxWR.css"]
};

function retainLegacyPwaAssets() {
  return {
    name: "retain-legacy-pwa-assets",
    generateBundle(_outputOptions, bundle) {
      const entry = Object.values(bundle).find((item) => item.type === "chunk" && item.isEntry);
      const stylesheet = Object.values(bundle).find((item) => item.type === "asset" && item.fileName.endsWith(".css"));

      if (!entry || !stylesheet) this.error("The PWA build must emit one entry script and stylesheet.");

      for (const fileName of LEGACY_PWA_ASSETS.scripts) {
        this.emitFile({ type: "asset", fileName, source: entry.code });
      }
      for (const fileName of LEGACY_PWA_ASSETS.styles) {
        this.emitFile({ type: "asset", fileName, source: stylesheet.source });
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), retainLegacyPwaAssets()],
  base: process.env.VITE_BASE_PATH || "/",
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const sourceName = assetInfo.names?.[0] || assetInfo.name || "asset";
          return sourceName.endsWith(".css") ? "assets/app.css" : "assets/[name][extname]";
        }
      }
    }
  },
  server: {
    port: 5173
  }
});
