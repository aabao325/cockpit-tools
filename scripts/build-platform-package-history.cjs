#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INDEX = path.join(ROOT, 'platform-packages', 'index.json');
const DEFAULT_HISTORY_DIR = path.join(ROOT, 'platform-packages', 'history');
const DEFAULT_OUTPUT_DIR = DEFAULT_HISTORY_DIR;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/build-platform-package-history.cjs [options]

Options:
  --index <path>          Platform package index to append into history.
  --history-dir <path>    Existing history directory. Defaults to platform-packages/history.
  --output-dir <path>     Output history directory. Defaults to --history-dir.
  --reset                 Ignore existing history and write only versions from --index.
`);
}

function parseArgs(argv) {
  const args = {
    index: DEFAULT_INDEX,
    historyDir: DEFAULT_HISTORY_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    const next = argv[index + 1];
    if (arg === '--reset') {
      args.reset = true;
      continue;
    }
    if (!next || next.startsWith('--')) fail(`Missing value for ${arg}`);
    index += 1;
    if (arg === '--index') args.index = path.resolve(ROOT, next);
    else if (arg === '--history-dir') args.historyDir = path.resolve(ROOT, next);
    else if (arg === '--output-dir') args.outputDir = path.resolve(ROOT, next);
    else fail(`Unknown argument: ${arg}`);
  }

  return args;
}

function readJson(filePath, label, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label}: failed to read JSON: ${error.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseVersion(value) {
  return String(value || '')
    .trim()
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  while (leftParts.length < 3) leftParts.push(0);
  while (rightParts.length < 3) rightParts.push(0);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
  }
  return String(right || '').localeCompare(String(left || ''));
}

function assertArtifactMetadata(packageId, version, artifact, index) {
  if (!artifact || typeof artifact !== 'object') {
    fail(`${packageId}@${version}: artifact[${index}] must be an object`);
  }
  if (typeof artifact.os !== 'string' || !artifact.os.trim()) {
    fail(`${packageId}@${version}: artifact[${index}].os is required`);
  }
  if (typeof artifact.arch !== 'string' || !artifact.arch.trim()) {
    fail(`${packageId}@${version}: artifact[${index}].arch is required`);
  }
  if (typeof artifact.downloadUrl !== 'string' || !artifact.downloadUrl.trim()) {
    fail(`${packageId}@${version}: artifact[${index}].downloadUrl is required`);
  }
  if (!Number.isInteger(artifact.downloadSizeBytes) || artifact.downloadSizeBytes <= 0) {
    fail(`${packageId}@${version}: artifact[${index}].downloadSizeBytes must be a positive integer`);
  }
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(artifact.sha256)) {
    fail(`${packageId}@${version}: artifact[${index}].sha256 must be a 64-char hex string`);
  }
}

function normalizePackageForHistory(pkg) {
  const next = JSON.parse(JSON.stringify(pkg));
  if (!Array.isArray(next.artifacts) || next.artifacts.length === 0) {
    fail(`${pkg.id}: history package requires non-empty artifacts[]`);
  }
  next.artifacts.forEach((artifact, index) => assertArtifactMetadata(pkg.id, pkg.version, artifact, index));
  return next;
}

function assertSameVersionImmutable(packageId, version, existing, next) {
  if (stableJson(existing) !== stableJson(next)) {
    fail(`${packageId}@${version}: existing history entry differs from newly built package. Bump the platform package version instead of replacing an existing zip/index entry.`);
  }
}

function mergeHistory(packageId, existingHistory, latestPackage) {
  const versions = new Map();
  const existingVersions = Array.isArray(existingHistory?.versions) ? existingHistory.versions : [];
  for (const item of existingVersions) {
    if (!item || typeof item.version !== 'string' || !item.version.trim()) {
      fail(`${packageId}: history contains an invalid version entry`);
    }
    const normalized = normalizePackageForHistory(item);
    if (versions.has(normalized.version)) {
      fail(`${packageId}: duplicate history version ${normalized.version}`);
    }
    versions.set(normalized.version, normalized);
  }

  const normalizedLatest = normalizePackageForHistory(latestPackage);
  const existingSameVersion = versions.get(normalizedLatest.version);
  if (existingSameVersion) {
    assertSameVersionImmutable(packageId, normalizedLatest.version, existingSameVersion, normalizedLatest);
  }
  versions.set(normalizedLatest.version, normalizedLatest);

  return {
    version: '1',
    platformId: packageId,
    latestVersion: normalizedLatest.version,
    versions: [...versions.values()].sort((left, right) => compareVersions(left.version, right.version)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = readJson(args.index, 'platform package index');
  if (!index || !Array.isArray(index.packages)) {
    fail('platform package index must contain packages[]');
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const rows = [];
  for (const pkg of index.packages) {
    if (!pkg?.id || !pkg?.version) {
      fail('platform package index contains package without id/version');
    }
    const historyPath = path.join(args.historyDir, `${pkg.id}.json`);
    const outputPath = path.join(args.outputDir, `${pkg.id}.json`);
    const existingHistory = args.reset ? null : readJson(historyPath, `${pkg.id} history`, null);
    const history = mergeHistory(pkg.id, existingHistory, pkg);
    fs.writeFileSync(outputPath, `${JSON.stringify(history, null, 2)}\n`);
    rows.push({
      id: pkg.id,
      latest: history.latestVersion,
      versions: history.versions.length,
    });
  }
  console.table(rows);
}

main();
