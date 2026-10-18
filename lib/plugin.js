// src/plugin.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
var name = "dsh-chatgpt-web";
var inject = [];
var ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function resolveLauncher(customBunPath) {
  const libCliPath = resolve(ROOT_DIR, "lib", "cli.js");
  if (existsSync(libCliPath)) {
    return {
      cmd: process.execPath,
      args: [libCliPath, "serve"]
    };
  }
  if (customBunPath && existsSync(customBunPath)) {
    return { cmd: customBunPath, args: ["run", "src/cli.ts", "serve"] };
  }
  const winBun = join(homedir(), ".bun", "bin", "bun.exe");
  if (existsSync(winBun)) {
    return { cmd: winBun, args: ["run", "src/cli.ts", "serve"] };
  }
  try {
    const tsxUrl = import.meta.resolve("tsx");
    return {
      cmd: process.execPath,
      args: ["--import", tsxUrl, "src/cli.ts", "serve"]
    };
  } catch {}
  const localTsx = resolve(ROOT_DIR, "node_modules/tsx/dist/esm/index.mjs");
  if (existsSync(localTsx)) {
    return {
      cmd: process.execPath,
      args: ["--import", pathToFileURL(localTsx).href, "src/cli.ts", "serve"]
    };
  }
  const siblingTsx = resolve(ROOT_DIR, "../deepseek-harness/node_modules/tsx/dist/esm/index.mjs");
  if (existsSync(siblingTsx)) {
    return {
      cmd: process.execPath,
      args: ["--import", pathToFileURL(siblingTsx).href, "src/cli.ts", "serve"]
    };
  }
  return { cmd: process.execPath, args: ["src/cli.ts", "serve"] };
}
async function isSidecarHealthy(host, port) {
  try {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok)
      return false;
    const body = await res.json();
    return body.status === "ok";
  } catch {
    return false;
  }
}
function apply(ctx, config = {}) {
  const host = config.host || "127.0.0.1";
  const port = config.port || 17841;
  const autoStart = config.autoStart !== false;
  const readyTimeoutMs = config.readyTimeoutMs || 30000;
  const logger = typeof ctx.logger === "function" ? ctx.logger("chatgpt-web") : console;
  let spawnedProcess;
  const startDaemon = async () => {
    const alreadyHealthy = await isSidecarHealthy(host, port);
    if (alreadyHealthy) {
      logger.info(`[dsh-chatgpt-web] Sidecar already running and healthy at http://${host}:${port}/v1`);
      return;
    }
    if (!autoStart) {
      logger.warn(`[dsh-chatgpt-web] Sidecar is offline and autoStart is false. Start it manually with 'bun run src/cli.ts serve'`);
      return;
    }
    const launcher = resolveLauncher(config.bunPath);
    logger.info(`[dsh-chatgpt-web] Starting dsh-chatgpt-web daemon via ${launcher.cmd} at http://${host}:${port}/v1...`);
    const child = spawn(launcher.cmd, launcher.args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env
      }
    });
    spawnedProcess = child;
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function")
        logger.debug(`[sidecar] ${text}`);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function")
        logger.debug(`[sidecar:err] ${text}`);
    });
    child.on("error", (err) => {
      logger.error(`[dsh-chatgpt-web] Failed to launch sidecar process: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn(`[dsh-chatgpt-web] Sidecar process exited with code ${code} (signal: ${signal})`);
      }
      spawnedProcess = undefined;
    });
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await isSidecarHealthy(host, port)) {
        logger.info(`[dsh-chatgpt-web] Sidecar ready and accepting turns at http://${host}:${port}/v1`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    logger.error(`[dsh-chatgpt-web] Sidecar did not become healthy within ${readyTimeoutMs}ms`);
  };
  const stopDaemon = async () => {
    if (!spawnedProcess)
      return;
    logger.info("[dsh-chatgpt-web] Stopping sidecar daemon...");
    try {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(`http://${host}:${port}/admin/shutdown`, {
        method: "POST",
        signal: controller.signal
      }).catch(() => {});
      clearTimeout(timer);
    } catch {}
    if (spawnedProcess && !spawnedProcess.killed) {
      spawnedProcess.kill("SIGTERM");
    }
    spawnedProcess = undefined;
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      startDaemon();
      return () => {
        stopDaemon();
      };
    });
  } else {
    startDaemon();
    process.once("beforeExit", () => void stopDaemon());
  }
}
var plugin_default = {
  name,
  inject,
  apply
};
export {
  name,
  inject,
  plugin_default as default,
  apply
};
