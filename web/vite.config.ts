import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webRoot,
  publicDir: resolve(webRoot, "public"),
  build: {
    outDir: resolve(webRoot, "dist"),
    emptyOutDir: true,
  },
});
