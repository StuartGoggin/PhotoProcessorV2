import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const vitePackageJson = require.resolve("vite/package.json");
const viteCli = path.join(path.dirname(vitePackageJson), "bin", "vite.js");
const port = Number(process.env.PHOTOGOGO_DEV_PORT || 1430);

function getPortOwners(targetPort) {
  if (process.platform !== "win32") {
    return [];
  }

  const command = [
    `$connections = Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue`,
    "if (-not $connections) { exit 0 }",
    "$connections | Select-Object -ExpandProperty OwningProcess -Unique",
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `failed to inspect port ${targetPort}`);
  }

  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value !== process.pid);
}

function stopProcess(pid) {
  if (process.platform !== "win32") {
    return false;
  }

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ],
    { encoding: "utf8" },
  );

  return result.status === 0;
}

try {
  const owners = getPortOwners(port);
  if (owners.length > 0) {
    for (const pid of owners) {
      stopProcess(pid);
    }
    console.log(`Freed port ${port} by stopping PID(s): ${owners.join(", ")}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Port preflight failed for ${port}: ${message}`);
}

const child = spawn(process.execPath, [viteCli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}