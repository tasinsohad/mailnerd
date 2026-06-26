import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

// These are native/optional packages that should NOT be bundled.
// CRITICAL: postgres and drizzle-orm MUST be bundled (NOT in this list)
// otherwise Vercel functions crash with ERR_MODULE_NOT_FOUND.
const nativeExternals = ["node-ssh", "cloudflare", "ssh2", "bullmq", "ioredis", "cpu-features"];

export default defineConfig({
  plugins: [
    tsConfigPaths(),
    // Note: tanstackRouter plugin completely removed due to Windows + Vite HMR conflicts
    // causing EPERM and "hot" duplicate declaration errors.
    // Route tree is manually maintained in src/routeTree.gen.ts
    tanstackStart(),
    nitro({
      preset: "vercel",
      minify: false, // Drizzle ORM crashes if the server build is minified
      externals: {
        external: nativeExternals,
      }
    }),
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
