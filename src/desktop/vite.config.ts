import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: rootDir,
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(rootDir, "dist"),
    emptyOutDir: true,
  },
})
