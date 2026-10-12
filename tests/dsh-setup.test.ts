import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { atomicWriteFile, defaultConfig, getConfigPath, loadConfig, runtimeCommandForProcess, saveConfig } from "../src/config";
import { loginVerificationMarkerPath } from "../src/browser-login";
import { preflightSetup, setup } from "../src/setup";
import { runDoctor } from "../src/doctor";
import { modelsRequest } from "../src/server";

const root = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "dsh-setup-test-"));
const previousHome = process.env.DSH_CHATGPT_FREE_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const options = {
  dsh: true,
  mode: "browser-only" as const,
  acknowledgedUnofficial: true,
  chromeExecutablePath: process.execPath,
};

beforeAll(() => {
  process.env.DSH_CHATGPT_FREE_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
  else process.env.DSH_CHATGPT_FREE_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  const target = realpathSync(home);
  if (dirname(target) !== realpathSync(tmpdir()) || !target.includes("dsh-setup-test-")) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  rmSync(target, { recursive: true });
});

test("DSH preflight needs no Codex route and writes no configuration", () => {
  preflightSetup(options);
  expect(existsSync(getConfigPath())).toBe(false);
  expect(existsSync(process.env.CODEX_HOME!)).toBe(false);
});

test("DSH setup rejects incompatible modes and missing acknowledgement", () => {
  expect(() => preflightSetup({ ...options, mode: "full" })).toThrow("browser-only");
  expect(() => preflightSetup({ ...options, browserInteractionMode: "manual" })).toThrow("browser-only");
  expect(() => preflightSetup({ ...options, browserHostDescriptorPath: "/unused" })).toThrow("browser-only");
  expect(() => preflightSetup({ ...options, replaceCodexRoute: true })).toThrow("browser-only");
  expect(() => preflightSetup({ ...options, acknowledgedUnofficial: false })).toThrow("acknowledgement");
});

test("Node runtime retains the built CLI entry", () => {
  const node = Bun.which("node")!;
  const entry = join(root, "lib", "cli.js");
  expect(runtimeCommandForProcess({ executable: node, entry })).toEqual([node, entry]);
  expect(() => runtimeCommandForProcess({ executable: node })).toThrow("CLI entry");
});

test("DSH setup refuses an occupied port before opening a login window", async () => {
  const server = createServer();
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  try {
    await expect(setup({ ...options, port: address.port })).rejects.toThrow("Cannot bind");
    expect(existsSync(getConfigPath())).toBe(false);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});

test("DSH setup reuses saved login without installing Codex or a service", async () => {
  const server = createServer();
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  process.env.DSH_CHATGPT_FREE_HOME = join(home, "saved-login");
  try {
    const config = defaultConfig();
    atomicWriteFile(config.storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    atomicWriteFile(loginVerificationMarkerPath(config.storageStatePath), JSON.stringify({
      version: 1,
      authenticated: true,
      verifiedAt: new Date().toISOString(),
      solAvailable: true,
      proAvailable: false,
    }));
    const result = await setup({ ...options, port: address.port });
    expect(result.loginCreated).toBe(false);
    expect(result.serviceLoaded).toBe(false);
    expect(result.codexRestartRequired).toBe(false);
    expect(result.connectorSetupRequired).toBe(false);
    expect(loadConfig().purpose).toBe("dsh");
    expect(loadConfig().solAvailable).toBe(true);
    expect(existsSync(process.env.CODEX_HOME!)).toBe(false);
  } finally {
    process.env.DSH_CHATGPT_FREE_HOME = home;
  }
});

test("DSH config round-trips and doctor skips Codex and launchd requirements", async () => {
  const config = defaultConfig();
  config.purpose = "dsh";
  config.chromeExecutablePath = process.execPath;
  config.port = 1;
  saveConfig(config);
  expect(loadConfig().purpose).toBe("dsh");
  const report = await runDoctor();
  expect(report.checks.some(check => check.id === "codex")).toBe(false);
  expect(report.checks.find(check => check.id === "service")?.status).toBe("ok");
  expect(report.checks.find(check => check.id === "login")?.status).toBe("error");
  expect(report.checks.find(check => check.id === "proxy")?.status).toBe("error");
  expect(existsSync(process.env.CODEX_HOME!)).toBe(false);
  expect(() => preflightSetup({ ...options, dsh: false })).toThrow("setup --dsh");
});

test("built CLI refuses legacy uninstall for a DSH-owned configuration", () => {
  const before = readFileSync(getConfigPath(), "utf8");
  const result = spawnSync(Bun.which("node")!, [join(root, "lib", "cli.js"), "uninstall", "--yes"], {
    encoding: "utf8",
    env: process.env,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("owned by DSH");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
});

test("DSH model discovery is local and needs no Codex credentials", async () => {
  const config = defaultConfig();
  config.purpose = "dsh";
  config.solAvailable = false;
  const response = await modelsRequest(new Request("http://127.0.0.1/v1/models"), config,
    async () => { throw new Error("Unexpected upstream request"); },
    () => { throw new Error("Unexpected Codex settings access"); });
  expect(response.status).toBe(200);
  const catalog = await response.json() as { object: string; data: { id: string }[] };
  expect(catalog.object).toBe("list");
  expect(catalog.data.map(model => model.id)).toContain("chatgpt-web/luna");
});

test("DSH setup will not repurpose a legacy configuration", () => {
  const config = loadConfig();
  delete config.purpose;
  saveConfig(config);
  expect(() => preflightSetup(options)).toThrow("refusing to replace");
});

test("configuration rejects unrecognized owners", () => {
  const config = { ...loadConfig(), purpose: "unknown" };
  writeFileSync(getConfigPath(), JSON.stringify(config));
  expect(() => loadConfig()).toThrow("Invalid configuration purpose");
});
