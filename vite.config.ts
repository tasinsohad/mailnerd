import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import sseHandler from "./src/server/sse-node";

// These are native/optional packages that should NOT be bundled.
// CRITICAL: postgres and drizzle-orm MUST be bundled (NOT in this list)
// otherwise Vercel functions crash with ERR_MODULE_NOT_FOUND.
const nativeExternals = ["node-ssh", "cloudflare", "ssh2", "bullmq", "ioredis", "cpu-features"];

export default defineConfig({
  plugins: [
    {
      name: "sse-dev-plugin",
      configureServer(server) {
        server.middlewares.use("/api/sse", sseHandler);
      },
    },
    tsConfigPaths(),
    // Note: tanstackRouter plugin completely removed due to Windows + Vite HMR conflicts
    // causing EPERM and "hot" duplicate declaration errors.
    // Route tree is manually maintained in src/routeTree.gen.ts
    tanstackStart(),
    nitro({
      // A long-running Node server (VPS / Docker). Server setup runs for 20–40 minutes and streams its
      // logs, which serverless platforms cut off. NITRO_PRESET overrides it.
      preset: process.env.NITRO_PRESET || "node-server",
      // Live logs. In dev, sse-dev-plugin above serves /api/sse inside Vite's own process, where server
      // functions publish; the production server mounts the same Node handler here.
      handlers: [{ route: "/api/sse", handler: "./src/server/sse-node.ts", format: "node", env: "prod" }],
      // Start the server-setup queue worker at boot, not on the first provisioning click.
      plugins: ["./src/server/start-queue-worker.ts"],
      minify: false, // Drizzle ORM crashes if the server build is minified
      externals: {
        external: nativeExternals,
      },
    } as any),
    react(),
    tailwindcss(),
  ],
  optimizeDeps: {
    exclude: nativeExternals,
  },
  ssr: {
    external: nativeExternals,
  },
  server: {
    hmr: {
      overlay: false,
    },
  },
  build: {
    target: "esnext",
    minify: false, // Drizzle ORM crashes if the build is minified
    rollupOptions: {
      external: nativeExternals,
    },
  },
});
