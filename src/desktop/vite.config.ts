import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { buildDesktopDevServerConfig } from "./dev-server-config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "")

  return {
    root: rootDir,
    base: "./",
    plugins: [react(), tailwindcss()],
    server: buildDesktopDevServerConfig({
      appServerOrigin: env.DESKTOP_APP_SERVER_URL,
      host: env.DESKTOP_UI_HOST,
    }),
    build: {
      outDir: resolve(rootDir, "dist"),
      emptyOutDir: true,
    },
  }
})
