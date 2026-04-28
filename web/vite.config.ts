import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));

/** GitHub Pages project sites live under /<repo>/; set VITE_BASE_PATH in CI (e.g. /tunnet/). */
function normalizeBasePath(raw: string | undefined): string {
  let b = (raw ?? "/").trim() || "/";
  if (!b.startsWith("/")) b = `/${b}`;
  return b.endsWith("/") ? b : `${b}/`;
}
const base = normalizeBasePath(process.env.VITE_BASE_PATH);

export default defineConfig({
  root: webRoot,
  base,
  publicDir: resolve(webRoot, "public"),
  build: {
    outDir: resolve(webRoot, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(webRoot, "index.html"),
        saveViewer: resolve(webRoot, "save-viewer/index.html"),
      },
    },
  },
});
