#!/usr/bin/env node
// Smoke test for the published npm artifact (issue #4).
//
// Flow: pack (or accept a tarball) -> clean install in a temp dir -> run the
// installed CLI (--help, doctor) -> check the tarball for build-environment
// path contamination -> check runtime dependency resolution from the clean
// install. Exits non-zero on any failure so the publish workflow is blocked.
//
// Usage: node scripts/smoke-tarball.mjs [tarball.tgz]
// Without an argument the script runs `npm pack` in the repo root first.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const repoPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packageName = repoPackage.name;

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};

function run(cmd, args, options = {}) {
  const needsShell = process.platform === "win32" && (cmd === "npm" || cmd === "bun");
  return spawnSync(cmd, args, { encoding: "utf8", shell: needsShell, ...options });
}

// 1. Obtain the tarball.
let tarball = process.argv[2];
if (!tarball) {
  console.log("Packing artifact...");
  const packed = run("npm", ["pack", "--silent", "--pack-destination", repoRoot]);
  if (packed.status !== 0) {
    console.error(packed.stderr || packed.stdout);
    process.exit(1);
  }
  tarball = join(repoRoot, `${packageName.replace("@", "").replace("/", "-")}-${repoPackage.version}.tgz`);
  if (!existsSync(tarball)) {
    console.error(`Expected tarball not found: ${tarball}`);
    process.exit(1);
  }
}
console.log(`Tarball: ${basename(tarball)}`);

// 2. Clean install directory (no repo files).
const work = mkdtempSync(join(tmpdir(), `dsh-smoke-${process.pid}-`));
const cleanDir = join(work, "install");
const extractDir = join(work, "extract");
mkdirSync(cleanDir, { recursive: true });
mkdirSync(extractDir, { recursive: true });
try {
  writeFileSync(
    join(cleanDir, "package.json"),
    JSON.stringify({ name: "dsh-smoke-clean", version: "0.0.0", private: true }, null, 2),
  );

  // 3. Install the tarball in the clean directory. Bun is the repository's
  //    package manager and is available in CI; fall back to npm.
  console.log("Installing tarball into a clean directory...");
  const bunProbe = run("bun", ["--version"]);
  const installer =
    bunProbe.status === 0
      ? ["bun", "install", tarball]
      : ["npm", "install", tarball, "--no-audit", "--no-fund", "--loglevel", "error"];
  const install = run(installer[0], installer.slice(1), { cwd: cleanDir });
  if (install.status !== 0) {
    fail(`npm install failed: ${(install.stderr || install.stdout).trim().slice(-800)}`);
  } else {
    ok("tarball installed into a clean directory");
  }

  const pkgDir = join(cleanDir, "node_modules", ...packageName.split("/"));
  const binPath = join(cleanDir, "node_modules", ".bin", "dsh-chatgpt-web");

  // 4. Locate the installed binary and run --help from it.
  if (!existsSync(binPath)) {
    fail(`installed binary not found at ${binPath}`);
  } else {
    const binTarget = process.platform === "win32" ? join(pkgDir, "lib", "cli.js") : binPath;
    const help = run(process.execPath, [binTarget, "--help"], { cwd: cleanDir });
    if (help.status !== 0) {
      fail(`--help failed (exit ${help.status}): ${(help.stderr || help.stdout).trim().slice(-400)}`);
    } else if (!/Usage:/.test(help.stdout)) {
      fail(`--help output missing usage section: ${help.stdout.trim().slice(0, 200)}`);
    } else {
      ok("--help runs from the clean install");
    }
  }

  // 5. doctor must start without module-resolution errors (it exits 1 when no
  //    config exists, which is the expected clean-machine result).
  const doctor = run(process.execPath, [join(pkgDir, "lib", "cli.js"), "doctor"], { cwd: cleanDir });
  const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|playwright-core\/package\.json/.test(doctorText)) {
    fail(`doctor hit a module-resolution error: ${doctorText.trim().slice(-400)}`);
  } else if (doctor.status === 0 || /Doctor result:/.test(doctorText)) {
    ok("doctor starts from the clean install (no module-resolution error)");
  } else {
    fail(`doctor crashed (exit ${doctor.status}): ${doctorText.trim().slice(-400)}`);
  }

  // 6. Build-environment contamination check on the packed artifact.
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir]);
  const contaminationPatterns = [
    /\/home\/runner\/work\//,
    /\/Users\/runner\/work\//,
    /D:\\a\//i,
    /\/home\/runner\//,
  ];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(extractDir);
  let contaminated = 0;
  for (const file of files) {
    if (!/\.(js|cjs|mjs|json|yml|yaml|wasm|node|ts)$/.test(file)) continue;
    let content;
    try {
      content = readFileSync(file);
    } catch {
      continue;
    }
    for (const pattern of contaminationPatterns) {
      if (pattern.test(content)) {
        contaminated += 1;
        fail(`build-environment path matching ${pattern} found in ${basename(file)}`);
      }
    }
  }
  if (contaminated === 0) ok("no build-environment paths found in the tarball");

  // 7. Runtime dependency resolution from the clean install.
  const depCheck = run(
    process.execPath,
    [
      "-e",
      [
        "const { createRequire } = require('node:module');",
        `const req = createRequire(process.cwd() + '/node_modules/${packageName}/lib/cli.js');`,
        "console.log(req.resolve('playwright-core/package.json'));",
        "console.log(req.resolve('tiktoken'));",
      ].join("\n"),
    ],
    { cwd: cleanDir },
  );
  const depLines = (depCheck.stdout || "").trim().split("\n").filter(Boolean);
  if (depCheck.status !== 0 || depLines.length !== 2) {
    fail(`dependency resolution check failed: ${(depCheck.stderr || depCheck.stdout).trim().slice(-400)}`);
  } else {
    const [pwPath, twPath] = depLines;
    if (!pwPath.startsWith(cleanDir) || !twPath.startsWith(cleanDir)) {
      fail(`dependencies resolve outside the clean install: ${pwPath} | ${twPath}`);
    } else {
      ok("playwright-core and tiktoken resolve from the clean install");
    }
  }

  // 8. tiktoken actually loads (wasm) from the clean install.
  const twLoad = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { get_encoding } from 'tiktoken'; get_encoding('cl100k_base').encode('smoke'); console.log('tiktoken-ok');",
    ],
    { cwd: cleanDir },
  );
  if (twLoad.status === 0 && /tiktoken-ok/.test(twLoad.stdout)) {
    ok("tiktoken loads from the clean install");
  } else {
    fail(`tiktoken failed to load from the clean install: ${(twLoad.stderr || twLoad.stdout).trim().slice(-400)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`Smoke test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("Smoke test passed.");
