#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function getArg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const hasFlag = (name) => process.argv.includes(name);
const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeRepoPath(repoRoot, relativePath) {
  const normalized = normalize(relativePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe repository-relative path: ${relativePath}`);
  }

  const resolved = path.resolve(repoRoot, ...normalized.split("/"));
  const prefix = `${path.resolve(repoRoot)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`Path escaped repository root: ${relativePath}`);
  return resolved;
}

function runNode(scriptPath, args, label) {
  console.log(`\n--- ${label} ---`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function isCurrentOutput(outputManifestPath, asset, mappingSha256) {
  if (!fs.existsSync(outputManifestPath)) return false;
  try {
    const outputManifest = readJson(outputManifestPath);
    return (
      String(outputManifest?.source?.sha256 || "").toLowerCase() ===
        String(asset.sha256 || asset.originalSha256 || "").toLowerCase() &&
      String(outputManifest?.mapping?.sha256 || "").toLowerCase() ===
        mappingSha256.toLowerCase()
    );
  } catch {
    return false;
  }
}

function publishExtractedDirectory(stagedDirectory, targetDirectory, repoRoot) {
  const resolvedTarget = path.resolve(targetDirectory);
  const repoPrefix = `${path.resolve(repoRoot)}${path.sep}`;
  if (!resolvedTarget.startsWith(repoPrefix) || path.basename(resolvedTarget) !== "extracted") {
    throw new Error(`Refusing to replace unsafe extraction target: ${resolvedTarget}`);
  }

  if (fs.existsSync(resolvedTarget)) {
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  fs.cpSync(stagedDirectory, resolvedTarget, { recursive: true });
}

function writeGithubOutput(processed, skipped, unconfigured) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    `processed=${processed}\nskipped=${skipped}\nunconfigured=${unconfigured}\n`,
  );
}

const repoRoot = path.resolve(getArg("--repo-root", "."));
const manifestPath = path.resolve(
  getArg("--manifest", path.join(repoRoot, "encrypted-assets.manifest.json")),
);
const decryptScript = path.resolve(
  getArg("--decrypt-script", path.join(repoRoot, "scripts/decrypt-assets-updated-v4.mjs")),
);
const extractScript = path.resolve(
  getArg("--extract-script", path.join(repoRoot, "scripts/extract-psd-animation-layers.mjs")),
);
const githubRepository = getArg(
  "--github-repository",
  process.env.GITHUB_REPOSITORY || "kirandp/ShubhFrameAssets",
);
const githubRef = getArg("--github-ref", process.env.GITHUB_REF_NAME || "master");
const force = hasFlag("--force");

for (const requiredPath of [manifestPath, decryptScript, extractScript]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Required file not found: ${requiredPath}`);
}
if (!process.env.ASSET_DECRYPTION_KEY && !process.env.ASSET_ENCRYPTION_KEY) {
  throw new Error("ASSET_DECRYPTION_KEY GitHub Actions secret is not configured.");
}

const manifest = readJson(manifestPath);
const psdAssets = (manifest.assets || []).filter((asset) => {
  const originalPath = normalize(asset?.originalPath);
  return originalPath.startsWith("psd/") && /\.psd$/i.test(originalPath);
});

let processed = 0;
let skipped = 0;
let unconfigured = 0;

console.log(`PSD assets in encrypted manifest: ${psdAssets.length}`);

for (const asset of psdAssets) {
  const originalRelativePath = normalize(asset.originalPath);
  const sourceDirectory = path.posix.dirname(originalRelativePath);
  const mappingRelativePath = `psd-animation-mappings/${sourceDirectory.replace(
    /^psd\//,
    "",
  )}/animation-mapping.json`;
  const mappingPath = safeRepoPath(repoRoot, mappingRelativePath);

  if (!fs.existsSync(mappingPath)) {
    unconfigured += 1;
    console.log(`Skipping ${originalRelativePath}: no ${mappingRelativePath}`);
    continue;
  }

  const encryptedRelativePath = normalize(
    asset.encryptedFile || `${originalRelativePath}.enc.json`,
  );
  const encryptedPath = safeRepoPath(repoRoot, encryptedRelativePath);
  if (!fs.existsSync(encryptedPath)) {
    throw new Error(`Encrypted PSD listed in the manifest is missing: ${encryptedRelativePath}`);
  }

  const mappingBytes = fs.readFileSync(mappingPath);
  const mappingSha256 = sha256(mappingBytes);
  const mapping = JSON.parse(mappingBytes.toString("utf8"));
  const outputDirectory = safeRepoPath(repoRoot, `${sourceDirectory}/extracted`);
  const outputManifestPath = path.join(outputDirectory, "animation-manifest.json");

  if (!force && isCurrentOutput(outputManifestPath, asset, mappingSha256)) {
    skipped += 1;
    console.log(`Current: ${originalRelativePath}`);
    continue;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shubhframe-psd-"));
  const decryptedRoot = path.join(temporaryRoot, "decrypted");
  const stagedOutput = path.join(temporaryRoot, "extracted");
  const filterPath = path.join(temporaryRoot, "psd-project-filter.json");

  try {
    fs.writeFileSync(
      filterPath,
      JSON.stringify({ psdAnimationSources: [originalRelativePath] }, null, 2),
    );

    runNode(
      decryptScript,
      [
        "--manifest",
        manifestPath,
        "--assets-root",
        repoRoot,
        "--output",
        decryptedRoot,
        "--project",
        filterPath,
        "--fail-missing",
      ],
      `Decrypt ${originalRelativePath}`,
    );

    const decryptedPath = safeRepoPath(decryptedRoot, originalRelativePath);
    if (!fs.existsSync(decryptedPath)) {
      throw new Error(`Decrypted PSD was not produced: ${decryptedPath}`);
    }

    const publicBaseUrl = String(
      mapping.publicBaseUrl ||
        `https://raw.githubusercontent.com/${githubRepository}/${githubRef}/${sourceDirectory}/extracted`,
    ).replace(/\/+$/, "");

    runNode(
      extractScript,
      [
        "--input",
        decryptedPath,
        "--output",
        stagedOutput,
        "--mapping",
        mappingPath,
        "--public-base-url",
        publicBaseUrl,
        "--pretty",
      ],
      `Extract ${originalRelativePath}`,
    );

    const generatedManifest = readJson(path.join(stagedOutput, "animation-manifest.json"));
    if (
      String(generatedManifest?.source?.sha256 || "").toLowerCase() !==
      String(asset.sha256 || "").toLowerCase()
    ) {
      throw new Error(`Extracted source hash does not match encrypted manifest for ${originalRelativePath}.`);
    }

    publishExtractedDirectory(stagedOutput, outputDirectory, repoRoot);
    processed += 1;
    console.log(`Published: ${sourceDirectory}/extracted`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

writeGithubOutput(processed, skipped, unconfigured);
console.log(`\nPSD extraction complete. Processed=${processed}, current=${skipped}, without mapping=${unconfigured}`);
