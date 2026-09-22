import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import appConfig from "./src-tauri/tauri.conf.json";
import packageInfo from "./package.json";

if (appConfig.version !== packageInfo.version) {
  throw new Error("App and package versions must match before building.");
}

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
let revision = "source";
try {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  revision = git("rev-parse", "--short=8", "HEAD");
  // Include uncommitted source changes instead of implying an exact commit build.
  if (git("diff", "HEAD", "--name-only") || git("ls-files", "--others", "--exclude-standard")) {
    revision += "+local";
  }
} catch {
  // Source archives may not include Git metadata; the UTC timestamp still identifies the build.
}
const builtAt = new Date().toISOString();
const buildId = `${builtAt.replace(/[-:.]/g, "")}-${revision}`;
console.info(`PhotoGoGo v${appConfig.version} | Build ${buildId}`);

export default defineConfig(async () => ({
  define: {
    __APP_BUILD__: JSON.stringify({ version: appConfig.version, buildId, builtAt }),
  },
  plugins: [react()],
  clearScreen: false,
  // Native diagnostic/build trees contain HTML that is not an app entry point.
  optimizeDeps: { entries: ["index.html", "studio-preview.html"] },
  server: {
    port: 1430,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/test-output/**"],
    },
  },
}));
