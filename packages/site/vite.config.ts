import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// The Pages workflow sets SITE_BASE to "/headroom". A local build uses the root.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const base = env["SITE_BASE"] ? `${env["SITE_BASE"].replace(/\/$/, "")}/` : "/";
const shim = fileURLToPath(new URL("./src/node-shim.ts", import.meta.url));

/**
 * The sampler of the core loads its Windows or Linux part only when the daemon starts it. The Windows part loads a native
 * library. This plugin gives the browser an empty module for each part, so the bundle has no native code.
 */
function noSampler(): Plugin {
  const id = "\0headroom-no-sampler";
  return {
    name: "headroom-no-sampler",
    enforce: "pre",
    resolveId(source, importer) {
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (from.endsWith("/core/src/sampler.ts") && /^\.\/(windows|linux)\.ts$/.test(source)) return id;
      return null;
    },
    load(name) {
      return name === id ? "export {};" : null;
    },
  };
}

// The site bundles the lease broker of `@headroom/core` from the workspace. Some modules of the core import Node built-ins
// for the daemon. The simulator does not call those functions, so each built-in goes to one small module for the browser.
export default defineConfig({
  base,
  plugins: [noSampler()],
  resolve: {
    alias: [{ find: /^node:(crypto|fs|os|path)$/, replacement: shim }],
  },
  build: {
    target: "es2022",
  },
  define: {
    __BUILD__: JSON.stringify({ sha: (env["GITHUB_SHA"] ?? "local").slice(0, 7), date: new Date().toISOString().slice(0, 10) }),
  },
});
