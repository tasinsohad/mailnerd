import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [
    tsConfigPaths(),
    // Note: tanstackRouter plugin completely removed due to Windows + Vite HMR conflicts
    // causing EPERM and "hot" duplicate declaration errors.
    // Route tree is manually maintained in src/routeTree.gen.ts
    tanstackStart(),
    nitro({
      preset: "vercel",
    }),
    react(),
    tailwindcss(),
  ],
  ssr: {
    external: ["node-ssh", "cloudflare", "ssh2", "bullmq", "ioredis"],
  },
  server: {
    hmr: {
      overlay: false,
    },
  },
  build: {
    target: "esnext",
    minify: "esbuild",
  },
});
