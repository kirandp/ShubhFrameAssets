import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function getArg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function stripQueryHash(value) {
  return String(value || '').split('#')[0].split('?')[0];
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripUrlPrefix(value) {
  let clean = stripQueryHash(normalizeSlashes(value));

  clean = clean.replace(
    /^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//,
    '',
  );

  clean = clean.replace(
    /^https?:\/\/github\.com\/[^/]+\/[^/]+\/raw\/[^/]+\//,
    '',
  );

  clean = clean.replace(
    /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\//,
    '',
  );

  clean = clean.replace(/^https?:\/\/[^/]+\//, '');

  return safeDecodeURIComponent(clean);
}

function stripKnownRootPrefixes(value) {
  let clean = stripUrlPrefix(value);

  clean = clean.replace(/^\.?\//, '');

  // The encrypted assets are checked out into the repo root.
  // Remove older/local root prefixes if project.json or manifest contains them.
  clean = clean.replace(/^server-assets\//, '');
  clean = clean.replace(/^server_assets\//, '');
  clean = clean.replace(/^serverAssets\//, '');
  clean = clean.replace(/^encrypted-assets\//, '');
  clean = clean.replace(/^encrypted_assets\//, '');
  clean = clean.replace(/^encryptedAssets\//, '');
  clean = clean.replace(/^shubhframe-assets\//, '');
  clean = clean.replace(/^assets\//, '');
  clean = clean.replace(/^public\//, '');
  clean = clean.replace(/^work\/assets\//, '');

  return clean;
}

function removeEncJsonExtension(value) {
  if (value.endsWith('.enc.json')) {
    return value.slice(0, -'.enc.json'.length);
  }

  if (value.endsWith('.enc')) {
    return value.slice(0, -'.enc'.length);
  }

  return value;
}

function normalizeAssetReference(value) {
  return stripKnownRootPrefixes(value)
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function isLikelyAssetPath(value) {
  const clean = normalizeAssetReference(value);
  if (!clean || clean.length < 3) return false;
  if (clean.startsWith('data:')) return false;
  if (clean.startsWith('file:')) return false;
  if (/^https?:\/\//i.test(clean)) return false;

  const ext = path.posix.extname(clean).toLowerCase();
  if (
    [
      '.json',
      '.jso',
      '.lottie',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.avif',
      '.svg',
      '.gif',
      '.mp3',
      '.m4a',
      '.aac',
      '.wav',
      '.ogg',
      '.opus',
      '.flac',
      '.mp4',
      '.mov',
      '.webm',
      '.psd',
      '.psb',
      '.eps',
    ].includes(ext)
  ) {
    return true;
  }

  return /(^|\/)(frames|templates|lottie|masks|stickers|music|audio|video|effects|images|backgrounds|message|messages|psd|designs)\//i.test(clean);
}

function hasKnownAssetDirectory(value) {
  const clean = normalizeAssetReference(value);
  return /(^|\/)(frames|templates|lottie|masks|stickers|music|audio|video|effects|images|backgrounds|message|messages|psd|designs)\//i.test(clean);
}

function base64ToBuffer(value) {
  if (!value) {
    return Buffer.alloc(0);
  }

  let normalized = String(value).trim();

  // Support normal base64 and base64url.
  normalized = normalized.replace(/-/g, '+').replace(/_/g, '/');

  while (normalized.length % 4 !== 0) {
    normalized += '=';
  }

  return Buffer.from(normalized, 'base64');
}

function getPayloadIterations(payload) {
  if (payload.iterations) {
    return Number(payload.iterations);
  }

  if (payload.kdf && typeof payload.kdf === 'object' && payload.kdf.iterations) {
    return Number(payload.kdf.iterations);
  }

  return 150000;
}

function getPayloadSalt(payload) {
  if (payload.salt) {
    return payload.salt;
  }

  if (payload.kdf && typeof payload.kdf === 'object' && payload.kdf.salt) {
    return payload.kdf.salt;
  }

  throw new Error('Encrypted payload is missing salt.');
}

function getPayloadEncryptedBytes(payload) {
  if (payload.data) {
    return base64ToBuffer(payload.data);
  }

  if (payload.ciphertext) {
    return base64ToBuffer(payload.ciphertext);
  }

  throw new Error('Encrypted payload is missing data/ciphertext.');
}

function decryptJsonPayload(payload, secret) {
  if (payload.algorithm && payload.algorithm !== 'AES-256-GCM') {
    throw new Error(`Unsupported encryption algorithm: ${payload.algorithm}`);
  }

  if (payload.alg && payload.alg !== 'AES-GCM') {
    throw new Error(`Unsupported encryption algorithm: ${payload.alg}`);
  }

  const salt = base64ToBuffer(getPayloadSalt(payload));
  const iv = base64ToBuffer(payload.iv);
  const encrypted = getPayloadEncryptedBytes(payload);
  const iterations = getPayloadIterations(payload);

  if (!iv.length) {
    throw new Error('Encrypted payload is missing iv.');
  }

  const key = crypto.pbkdf2Sync(
    String(secret).trim(),
    salt,
    iterations,
    32,
    'sha256',
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

  // Newer payloads may use authTag, older ones may use tag.
  const tagValue = payload.authTag || payload.tag;

  if (tagValue) {
    decipher.setAuthTag(base64ToBuffer(tagValue));
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  // Some payloads store ciphertext + 16-byte auth tag together.
  if (encrypted.length <= 16) {
    throw new Error('Encrypted payload is too small.');
  }

  const data = encrypted.subarray(0, encrypted.length - 16);
  const authTag = encrypted.subarray(encrypted.length - 16);

  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function decryptBinaryPayload(buffer, secret) {
  // Fallback for simple binary format:
  // first 12 bytes = iv
  // next 16 bytes = auth tag
  // remaining bytes = encrypted data
  if (buffer.length <= 28) {
    throw new Error('Unsupported encrypted binary payload.');
  }

  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function decryptBuffer(buffer, secret) {
  try {
    const text = buffer.toString('utf8');
    const payload = JSON.parse(text);

    if (payload && typeof payload === 'object' && payload.iv) {
      return decryptJsonPayload(payload, secret);
    }
  } catch {
    // Not JSON payload. Try binary fallback.
  }

  return decryptBinaryPayload(buffer, secret);
}

function looksLikeAssetObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Boolean(
    value.encryptedFile ||
      value.encryptedPath ||
      value.encryptedUri ||
      value.encryptedUrl ||
      value.file ||
      value.path ||
      value.uri ||
      value.url,
  );
}

function collectManifestItems(value, output = []) {
  if (!value) {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectManifestItems(item, output);
    }

    return output;
  }

  if (typeof value === 'object') {
    if (looksLikeAssetObject(value)) {
      output.push(value);
      return output;
    }

    for (const child of Object.values(value)) {
      collectManifestItems(child, output);
    }
  }

  return output;
}

function getEncryptedPathFromAsset(asset) {
  return (
    asset.encryptedFile ||
    asset.encryptedPath ||
    asset.encryptedUri ||
    asset.encryptedUrl ||
    asset.file ||
    asset.path ||
    asset.uri ||
    asset.url
  );
}

function getOutputPathFromAsset(asset, encryptedPathFromManifest) {
  const originalPath =
    asset.originalPath ||
    asset.originalFile ||
    asset.originalRelativePath ||
    asset.outputFile ||
    asset.outputPath ||
    asset.sourceFile ||
    asset.sourcePath;

  if (originalPath && path.extname(originalPath)) {
    return stripKnownRootPrefixes(originalPath);
  }

  return removeEncJsonExtension(stripKnownRootPrefixes(encryptedPathFromManifest));
}

function getCandidateEncryptedPaths(assetsRoot, encryptedPathFromManifest) {
  const normalized = normalizeSlashes(encryptedPathFromManifest).replace(/^\.?\//, '');
  const stripped = stripKnownRootPrefixes(encryptedPathFromManifest);

  const candidates = [
    path.join(assetsRoot, stripped),
    path.join(assetsRoot, normalized),
  ];

  if (!stripped.endsWith('.enc.json')) {
    candidates.push(path.join(assetsRoot, `${stripped}.enc.json`));
  }

  if (!stripped.endsWith('.enc')) {
    candidates.push(path.join(assetsRoot, `${stripped}.enc`));
  }

  if (!normalized.endsWith('.enc.json')) {
    candidates.push(path.join(assetsRoot, `${normalized}.enc.json`));
  }

  if (!normalized.endsWith('.enc')) {
    candidates.push(path.join(assetsRoot, `${normalized}.enc`));
  }

  return [...new Set(candidates)];
}

function findExistingEncryptedFile(assetsRoot, encryptedPathFromManifest) {
  const candidates = getCandidateEncryptedPaths(assetsRoot, encryptedPathFromManifest);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function verifySha256(buffer, expectedSha256, outputPath) {
  if (!expectedSha256) {
    return;
  }

  const actualSha256 = crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');

  if (actualSha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    throw new Error(
      `SHA256 mismatch for ${outputPath}. Expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
}

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    throw new Error(`Project file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function addReference(output, value, reason = '') {
  if (typeof value !== 'string') return;

  const clean = normalizeAssetReference(value);
  if (!isLikelyAssetPath(clean)) return;

  output.add(clean);

  if (reason) {
    // Kept short because GitHub logs can get long.
    console.log(`Needed asset reference: ${clean} (${reason})`);
  }
}

function collectProjectAssetReferences(value, output = new Set(), parentSource = '') {
  if (!value) return output;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectProjectAssetReferences(item, output, parentSource);
    }
    return output;
  }

  if (typeof value !== 'object') {
    if (typeof value === 'string' && parentSource === 'gitAsset') {
      addReference(output, value, 'gitAsset string');
    } else if (typeof value === 'string' && hasKnownAssetDirectory(value)) {
      addReference(output, value, 'asset path string');
    }
    return output;
  }

  const source = String(
    value.source ||
      value.sourceType ||
      value.assetSource ||
      parentSource ||
      '',
  ).toLowerCase();

  const type = String(value.type || value.kind || '').toLowerCase();

  const isGitAsset =
    source === 'gitasset' ||
    source === 'git' ||
    source === 'asset' ||
    source === 'remote' ||
    source === 'remoteencrypted';

  const isLikelyGitLayer =
    [
      'frame',
      'pngframe',
      'template',
      'image',
      'mask',
      'sticker',
      'lottie',
      'animatedsticker',
      'background',
      'video',
      'effect',
      'design',
      'psd',
    ].includes(type) &&
    source !== 'userupload' &&
    source !== 'user' &&
    source !== 'upload';

  if (isGitAsset || isLikelyGitLayer) {
    for (const key of [
      'assetId',
      'originalPath',
      'originalFile',
      'originalRelativePath',
      'src',
      'assetPath',
      'remotePath',
      'relativePath',
      'sourcePath',
      'path',
      'uri',
      'url',
      'fileName',
      'file',
    ]) {
      addReference(output, value[key], `${type || 'object'}:${key}`);
    }
  }

  // Project/audio objects sometimes store only a path-like string without source metadata.
  for (const key of [
    'assetId',
    'originalPath',
    'originalFile',
    'originalRelativePath',
    'assetPath',
    'remotePath',
    'relativePath',
    'sourcePath',
    'musicAssetId',
    'frameAssetId',
    'templateAssetId',
  ]) {
    addReference(output, value[key], key);
  }

  for (const child of Object.values(value)) {
    collectProjectAssetReferences(child, output, isGitAsset ? 'gitAsset' : source);
  }

  return output;
}

function collectLottieExternalAssetReferences(lottieJson, lottieOutputRelativePath) {
  const refs = new Set();
  const lottieDir = path.posix.dirname(normalizeAssetReference(lottieOutputRelativePath));

  if (!lottieJson || typeof lottieJson !== 'object' || !Array.isArray(lottieJson.assets)) {
    return refs;
  }

  for (const asset of lottieJson.assets) {
    if (!asset || typeof asset !== 'object') continue;

    // Embedded base64 image. No extra decrypted file is needed.
    if (asset.e === 1) continue;

    const p = String(asset.p || '').trim();
    const u = String(asset.u || '').trim();

    if (!p || p.startsWith('data:')) continue;

    const candidates = [];

    if (/^https?:\/\//i.test(p)) {
      candidates.push(p);
    } else {
      candidates.push(p);
      candidates.push(path.posix.join(u, p));
      candidates.push(path.posix.join(lottieDir, p));
      candidates.push(path.posix.join(lottieDir, u, p));
    }

    for (const candidate of candidates) {
      addReference(refs, candidate, `lottie dependency:${asset.id || p}`);
    }
  }

  return refs;
}

function buildManifestIndex(items, assetsRoot) {
  const records = [];
  const exact = new Map();
  const basename = new Map();

  for (const asset of items) {
    const encryptedPathFromManifest = getEncryptedPathFromAsset(asset);
    if (!encryptedPathFromManifest) continue;

    const outputRelativePath = normalizeAssetReference(
      getOutputPathFromAsset(asset, encryptedPathFromManifest),
    );

    const encryptedReference = normalizeAssetReference(encryptedPathFromManifest);
    const encryptedWithoutEnc = normalizeAssetReference(removeEncJsonExtension(encryptedReference));

    const record = {
      asset,
      encryptedPathFromManifest,
      outputRelativePath,
      encryptedReference,
      encryptedWithoutEnc,
      encryptedPath: null,
    };

    records.push(record);

    for (const key of [
      outputRelativePath,
      encryptedReference,
      encryptedWithoutEnc,
    ]) {
      if (key && !exact.has(key.toLowerCase())) {
        exact.set(key.toLowerCase(), record);
      }
    }

    const base = path.posix.basename(outputRelativePath).toLowerCase();
    if (base) {
      if (!basename.has(base)) basename.set(base, []);
      basename.get(base).push(record);
    }
  }

  return { records, exact, basename, assetsRoot };
}

function findManifestRecordForReference(index, reference) {
  const clean = normalizeAssetReference(reference);
  if (!clean) return null;

  const variants = [
    clean,
    removeEncJsonExtension(clean),
    clean.replace(/^assets\//, ''),
    clean.replace(/^public\//, ''),
  ]
    .map((item) => normalizeAssetReference(item))
    .filter(Boolean);

  for (const variant of variants) {
    const hit = index.exact.get(variant.toLowerCase());
    if (hit) return hit;
  }

  for (const variant of variants) {
    const lower = variant.toLowerCase();

    const suffix = index.records.find((record) => {
      const out = record.outputRelativePath.toLowerCase();
      const enc = record.encryptedWithoutEnc.toLowerCase();

      return (
        out.endsWith(`/${lower}`) ||
        enc.endsWith(`/${lower}`) ||
        lower.endsWith(`/${out}`) ||
        lower.endsWith(`/${enc}`)
      );
    });

    if (suffix) return suffix;
  }

  const base = path.posix.basename(clean).toLowerCase();
  const baseMatches = index.basename.get(base) || [];

  if (baseMatches.length === 1) {
    return baseMatches[0];
  }

  return null;
}

function decryptManifestRecord(record, assetsRoot, outputRoot, secret) {
  if (!record.encryptedPath) {
    record.encryptedPath = findExistingEncryptedFile(
      assetsRoot,
      record.encryptedPathFromManifest,
    );
  }

  if (!record.encryptedPath) {
    throw new Error(`Encrypted file not found: ${record.encryptedPathFromManifest}`);
  }

  const outputPath = path.join(outputRoot, record.outputRelativePath);

  ensureDir(path.dirname(outputPath));

  const encryptedBuffer = fs.readFileSync(record.encryptedPath);
  const decryptedBuffer = decryptBuffer(encryptedBuffer, secret);

  verifySha256(
    decryptedBuffer,
    record.asset.sha256 || record.asset.originalSha256 || record.asset.checksum,
    outputPath,
  );

  fs.writeFileSync(outputPath, decryptedBuffer);

  return outputPath;
}

const manifestArg = getArg('--manifest');
const assetsRootArg = getArg('--assets-root');
const outputArg = getArg('--output');
const projectArg = getArg('--project', null);
const failMissing = hasFlag('--fail-missing');

if (!manifestArg) {
  throw new Error('Missing --manifest argument');
}

if (!assetsRootArg) {
  throw new Error('Missing --assets-root argument');
}

if (!outputArg) {
  throw new Error('Missing --output argument');
}

const manifestPath = path.resolve(manifestArg);
const assetsRoot = path.resolve(assetsRootArg);
const outputRoot = path.resolve(outputArg);
const projectPath = projectArg ? path.resolve(projectArg) : null;

const secret =
  process.env.ASSET_DECRYPTION_KEY ||
  process.env.EXPO_PUBLIC_ASSET_DECRYPTION_KEY ||
  process.env.ASSET_ENCRYPTION_KEY;

if (!secret) {
  throw new Error(
    'Missing ASSET_DECRYPTION_KEY, EXPO_PUBLIC_ASSET_DECRYPTION_KEY, or ASSET_ENCRYPTION_KEY environment variable',
  );
}

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Manifest not found: ${manifestPath}`);
}

if (!fs.existsSync(assetsRoot)) {
  throw new Error(`Assets root folder not found: ${assetsRoot}`);
}

ensureDir(outputRoot);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const items = collectManifestItems(manifest);

if (!items.length) {
  throw new Error('No encrypted assets found in manifest');
}

const index = buildManifestIndex(items, assetsRoot);
const project = readJsonIfExists(projectPath);

let decryptAll = false;
const neededReferences = new Set();

if (project) {
  collectProjectAssetReferences(project, neededReferences);
} else {
  decryptAll = true;
}

let decryptedCount = 0;
let skippedCount = 0;
let failedCount = 0;
let missingCount = 0;
const decryptedOutputPaths = new Set();
const queuedRecords = [];
const queuedKeys = new Set();

function queueRecord(record, fromReference) {
  if (!record) return false;

  const key = record.outputRelativePath.toLowerCase();
  if (queuedKeys.has(key) || decryptedOutputPaths.has(key)) return false;

  queuedKeys.add(key);
  queuedRecords.push({ record, fromReference });
  return true;
}

console.log('==============================');
console.log('Decrypt ShubhFrame assets');
console.log('==============================');
console.log('Manifest:', manifestPath);
console.log('Assets root:', assetsRoot);
console.log('Output root:', outputRoot);
console.log('Project filter:', projectPath || '[none: decrypt all]');
console.log('Manifest assets found:', items.length);
console.log('Mode:', decryptAll ? 'decrypt all manifest assets' : 'decrypt project.json referenced assets only');
console.log('==============================');

if (decryptAll) {
  for (const record of index.records) {
    queueRecord(record, '[all]');
  }
} else {
  console.log('Project asset references found:', neededReferences.size);

  for (const reference of neededReferences) {
    const record = findManifestRecordForReference(index, reference);
    if (record) {
      queueRecord(record, reference);
    } else {
      const looksLikeUploadedFile = /^(photo|music|audio|image|lottie_photo)[._-]?\d*\.(jpg|jpeg|png|webp|mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(
        path.posix.basename(reference),
      );

      if (!looksLikeUploadedFile) {
        missingCount += 1;
        console.warn(`No manifest match for project asset reference: ${reference}`);
      }
    }
  }
}

while (queuedRecords.length > 0) {
  const { record, fromReference } = queuedRecords.shift();

  try {
    const outputPath = decryptManifestRecord(record, assetsRoot, outputRoot, secret);
    decryptedCount += 1;
    decryptedOutputPaths.add(record.outputRelativePath.toLowerCase());

    console.log(
      `Decrypted: ${record.encryptedPathFromManifest} -> ${record.outputRelativePath} (from ${fromReference})`,
    );

    // If this decrypted asset is a Lottie JSON file, scan it for external image
    // dependencies and decrypt those too. This still avoids decrypting unrelated assets.
    if (path.extname(record.outputRelativePath).toLowerCase() === '.json') {
      try {
        const text = fs.readFileSync(outputPath, 'utf8');
        const json = JSON.parse(text);
        const lottieRefs = collectLottieExternalAssetReferences(
          json,
          record.outputRelativePath,
        );

        for (const lottieRef of lottieRefs) {
          const depRecord = findManifestRecordForReference(index, lottieRef);
          if (depRecord) {
            queueRecord(depRecord, `lottie:${record.outputRelativePath}`);
          } else {
            missingCount += 1;
            console.warn(
              `No manifest match for Lottie dependency ${lottieRef} from ${record.outputRelativePath}`,
            );
          }
        }
      } catch {
        // Not a JSON/Lottie file we need to scan.
      }
    }
  } catch (error) {
    failedCount += 1;
    console.error(`Failed: ${record.encryptedPathFromManifest}`);
    console.error(error.message);
  }
}

if (!decryptAll) {
  const selectedCount = queuedKeys.size + decryptedOutputPaths.size;
  skippedCount = Math.max(0, items.length - decryptedOutputPaths.size);
} else {
  skippedCount = Math.max(0, items.length - decryptedCount - failedCount);
}

console.log('==============================');
console.log(`Assets decrypted:         ${decryptedCount}`);
console.log(`Assets skipped/unneeded:  ${skippedCount}`);
console.log(`Asset refs missing match: ${missingCount}`);
console.log(`Assets failed:            ${failedCount}`);
console.log(`Output folder:            ${outputRoot}`);
console.log('==============================');

if (failMissing && missingCount > 0) {
  console.error('Failing because --fail-missing is enabled and some project asset references were not found in manifest.');
  process.exit(1);
}

if (failedCount > 0) {
  process.exit(1);
}
