#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readPsd, initializeCanvas } from "ag-psd";
import { createCanvas, ImageData } from "@napi-rs/canvas";

initializeCanvas(
  (width, height) => createCanvas(width, height),
  (width, height) => new ImageData(width, height),
);

const DEFAULT_PUBLIC_BASE_URL =
  "https://raw.githubusercontent.com/kirandp/ShubhFrameAssets/master/psd/festivals/independence-day/happy-independence-day-india-celebration-poster/extracted";

const DEFAULT_MAPPING = {
  id: "happy-independence-day-india-celebration-poster",
  title: "Layered PSD Independence Day poster",
  encryptedPsdPath:
    "psd/festivals/independence-day/happy-independence-day-india-celebration-poster/c277ee94-99c9-4340-98e8-443b4c11ca8a.psd.enc.json",
  excludedLayers: [
    "BACKGROUND",
    "Text/Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do",
    "Read More",
  ],
  animationPrompt:
    "Animate the exact pre-extracted transparent layers from the configured Independence Day PSD asset. Preserve the original pixels, proportions, spelling and colors. Keep the PSD background, Lorem Ipsum paragraph, Read More button and button border excluded. Combine the original left and right ribbon groups into one transparent full-width ribbon-combined image so both halves retain their exact Photoshop alignment. Place and animate this combined ribbon in the lower third below the face with a slow seamless floating sway. Place the Ashoka Chakra over the combined ribbon below the face and rotate it clockwise through one slow turn over 20 seconds. Keep the lower tricolor stripe edge-to-edge and move it farther toward the bottom. Animate both top hanging-flag decorations with clearly visible independent sway, bob and subtle scale breathing. Fade the original HAPPY INDEPENDENCE DAY title in gently and reveal the original 15TH AUGUST date near the bottom. Never regenerate, redraw, upscale, background-remove, warp or distort a PSD layer. Keep unused pixels transparent so the selected user image remains visible.",
  layers: [
    {
      id: "psd_independence_lower_tricolor",
      label: "Lower tricolor design",
      outputFile: "lower-tricolor.png",
      selectors: [{ path: "Design/Design" }],
      motionPreset: "psd_lower_tricolor_hold",
      zIndex: 450,
    },
    {
      id: "psd_independence_ribbon_combined",
      label: "Combined tricolor ribbon",
      outputFile: "ribbon-combined.png",
      selectors: [
        { path: "Ribbon/Ribbon", occurrence: 1 },
        { path: "Ribbon/Ribbon", occurrence: 0 },
      ],
      motionPreset: "psd_ribbon_combined_flow",
      zIndex: 521,
    },
    {
      id: "psd_independence_bunting_left",
      label: "Left hanging flags",
      outputFile: "bunting-left.png",
      selectors: [{ path: "Flag/Flag 1" }],
      motionPreset: "psd_bunting_sway_left",
      zIndex: 600,
    },
    {
      id: "psd_independence_bunting_right",
      label: "Right hanging flags",
      outputFile: "bunting-right.png",
      selectors: [{ path: "Flag/Flag 2" }],
      motionPreset: "psd_bunting_sway_right",
      zIndex: 601,
    },
    {
      id: "psd_independence_title",
      label: "Happy Independence Day title",
      outputFile: "title.png",
      selectors: [
        { path: "Text/Independence" },
        { path: "Text/happy" },
        { path: "Text/Day" },
      ],
      motionPreset: "psd_title_reveal",
      zIndex: 700,
    },
    {
      id: "psd_independence_date",
      label: "15th August date",
      outputFile: "date.png",
      selectors: [{ path: "Text/15th August" }],
      motionPreset: "psd_date_reveal",
      zIndex: 710,
    },
    {
      id: "psd_independence_chakra",
      label: "Ashoka Chakra",
      outputFile: "ashoka-chakra.png",
      selectors: [
        { path: "Design/Ellipse 1" },
        { path: "Design/Shape 7" },
      ],
      motionPreset: "psd_chakra_rotate",
      zIndex: 760,
    },
  ],
};

function printHelp() {
  console.log(`
Extract transparent animation layers from a decrypted PSD.

Install dependencies:
  npm install --save-dev ag-psd @napi-rs/canvas

Usage:
  node scripts/extract-psd-animation-layers.mjs \\
    --input ./work/decrypted/psd/festivals/independence-day/poster.psd \\
    --output ./work/psd-extracted

Options:
  --input <file>             Decrypted PSD file. Required.
  --output <dir>             Output directory. Required.
  --mapping <json>           Optional mapping for a different PSD.
  --public-base-url <url>    Base URL written into animation-manifest.json.
  --inspect-only             Write psd-layer-tree.json without PNG extraction.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help.

The script never modifies the PSD. Background and excluded layers are not
written to the output. A custom mapping allows the same extractor to be used
with any layered PSD.
`);
}

function parseArgs(argv) {
  const args = {
    input: "",
    output: "",
    mapping: "",
    publicBaseUrl: DEFAULT_PUBLIC_BASE_URL,
    inspectOnly: false,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input") {
      args.input = next || "";
      index += 1;
    } else if (arg === "--output") {
      args.output = next || "";
      index += 1;
    } else if (arg === "--mapping") {
      args.mapping = next || "";
      index += 1;
    } else if (arg === "--public-base-url") {
      args.publicBaseUrl = next || "";
      index += 1;
    } else if (arg === "--inspect-only") {
      args.inspectOnly = true;
    } else if (arg === "--pretty") {
      args.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error("Missing --input PSD file.");
  if (!args.output) throw new Error("Missing --output directory.");
  if (!args.publicBaseUrl) throw new Error("--public-base-url cannot be empty.");

  args.publicBaseUrl = args.publicBaseUrl.replace(/\/+$/, "");
  return args;
}

const sha256 = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

const jsonText = (value, pretty) => JSON.stringify(value, null, pretty ? 2 : 0);

const safeOutputFileName = (value) => {
  const fileName = path.basename(String(value || ""));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/i.test(fileName)) {
    throw new Error(`Unsafe or invalid PNG output filename: ${value}`);
  }
  return fileName;
};

function buildLayerIndex(psd) {
  const all = [];
  const byPath = new Map();
  let traversalIndex = 0;

  function walk(children, parentPath = []) {
    for (const layer of children || []) {
      const name = String(layer.name || `layer-${traversalIndex}`);
      const layerPath = [...parentPath, name].join("/");
      const record = {
        traversalIndex,
        path: layerPath,
        name,
        layer,
      };
      traversalIndex += 1;
      all.push(record);

      if (!byPath.has(layerPath)) byPath.set(layerPath, []);
      byPath.get(layerPath).push(record);
      walk(layer.children, [...parentPath, name]);
    }
  }

  walk(psd.children);
  return { all, byPath };
}

function serializeLayerTree(index) {
  return index.all.map(({ traversalIndex, path: layerPath, name, layer }) => ({
    traversalIndex,
    path: layerPath,
    name,
    isGroup: Array.isArray(layer.children),
    childCount: layer.children?.length || 0,
    left: Number(layer.left || 0),
    top: Number(layer.top || 0),
    right: Number(layer.right || 0),
    bottom: Number(layer.bottom || 0),
    opacity: Number(layer.opacity ?? 1),
    hidden: Boolean(layer.hidden),
    hasPixels: Boolean(layer.canvas),
    hasText: Boolean(layer.text),
  }));
}

function getSelectedRecords(index, selectors) {
  const selected = [];

  for (const selector of selectors || []) {
    const layerPath = String(selector?.path || "").trim();
    const matches = index.byPath.get(layerPath) || [];
    const occurrence = Number.isInteger(selector?.occurrence)
      ? Number(selector.occurrence)
      : 0;
    const record = matches[occurrence];

    if (!record) {
      throw new Error(
        `PSD layer not found: ${layerPath} occurrence ${occurrence}. Run with --inspect-only to review available paths.`,
      );
    }

    selected.push(record);
  }

  return selected;
}

function collectPixelLayers(records) {
  const output = [];
  const seen = new Set();

  function visit(record) {
    const { layer } = record;

    if (Array.isArray(layer.children)) {
      const children = [...layer.children].reverse();
      for (const child of children) {
        visit({ layer: child, path: `${record.path}/${child.name || "layer"}` });
      }
      return;
    }

    if (!layer.canvas || layer.hidden || seen.has(layer)) return;
    seen.add(layer);
    output.push(layer);
  }

  // Selector order is explicit bottom-to-top. Within a Photoshop group the
  // children array is top-to-bottom, so visit() reverses only group children.
  for (const record of records) visit(record);
  return output;
}

function alphaBounds(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function renderSelectedLayer(psd, records) {
  const fullCanvas = createCanvas(psd.width, psd.height);
  const context = fullCanvas.getContext("2d");
  context.clearRect(0, 0, psd.width, psd.height);

  for (const layer of collectPixelLayers(records)) {
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
    context.drawImage(
      layer.canvas,
      Number(layer.left || 0),
      Number(layer.top || 0),
    );
    context.restore();
  }

  const bounds = alphaBounds(fullCanvas);
  if (!bounds) throw new Error("Selected PSD layer group rendered no visible pixels.");

  const cropped = createCanvas(bounds.width, bounds.height);
  cropped
    .getContext("2d")
    .drawImage(
      fullCanvas,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height,
    );

  return { canvas: cropped, bounds };
}

async function readMapping(mappingPath) {
  if (!mappingPath) {
    const bytes = Buffer.from(JSON.stringify(DEFAULT_MAPPING), "utf8");
    return {
      mapping: DEFAULT_MAPPING,
      mappingFile: "[built-in]",
      mappingSha256: sha256(bytes),
    };
  }

  const resolvedPath = path.resolve(mappingPath);
  const bytes = await fs.readFile(resolvedPath);
  const mapping = JSON.parse(bytes.toString("utf8"));
  if (!mapping?.id || !Array.isArray(mapping?.layers) || mapping.layers.length === 0) {
    throw new Error("Custom mapping must contain id and a non-empty layers array.");
  }
  return {
    mapping,
    mappingFile: path.basename(resolvedPath),
    mappingSha256: sha256(bytes),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const inputBytes = await fs.readFile(inputPath);
  const mappingResult = await readMapping(args.mapping);
  const mapping = mappingResult.mapping;
  const psd = readPsd(inputBytes, {
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const index = buildLayerIndex(psd);

  await fs.mkdir(outputPath, { recursive: true });
  await fs.writeFile(
    path.join(outputPath, "psd-layer-tree.json"),
    jsonText(
      {
        schema: "shubhframe.psd-layer-tree.v1",
        sourceFile: path.basename(inputPath),
        sourceSha256: sha256(inputBytes),
        width: psd.width,
        height: psd.height,
        layers: serializeLayerTree(index),
      },
      args.pretty,
    ),
  );

  if (args.inspectOnly) {
    console.log(`Layer tree written to ${outputPath}`);
    return;
  }

  const extractedLayers = [];

  for (const definition of mapping.layers) {
    const outputFile = safeOutputFileName(definition.outputFile);
    const selectedRecords = getSelectedRecords(index, definition.selectors);
    const rendered = renderSelectedLayer(psd, selectedRecords);
    const png = rendered.canvas.toBuffer("image/png");

    await fs.writeFile(path.join(outputPath, outputFile), png);
    extractedLayers.push({
      id: String(definition.id),
      label: String(definition.label || definition.id),
      file: outputFile,
      url: `${args.publicBaseUrl}/${outputFile}`,
      mimeType: "image/png",
      bytes: png.length,
      sha256: sha256(png),
      width: rendered.bounds.width,
      height: rendered.bounds.height,
      sourceBounds: rendered.bounds,
      normalizedCenter: {
        x: (rendered.bounds.x + rendered.bounds.width / 2) / psd.width,
        y: (rendered.bounds.y + rendered.bounds.height / 2) / psd.height,
      },
      motionPreset: String(definition.motionPreset || "stationary"),
      zIndex: Number(definition.zIndex || 500),
      selectors: definition.selectors,
    });
    console.log(`Extracted ${definition.id} -> ${outputFile}`);
  }

  const manifest = {
    schema: "shubhframe.psd-animation-assets.v1",
    version: 2,
    assetId: mapping.id,
    title: mapping.title || mapping.id,
    createdAt: new Date().toISOString(),
    source: {
      originalFile: path.basename(inputPath),
      sha256: sha256(inputBytes),
      width: psd.width,
      height: psd.height,
      encryptedPsdPath: String(mapping.encryptedPsdPath || ""),
    },
    mapping: {
      file: mappingResult.mappingFile,
      sha256: mappingResult.mappingSha256,
    },
    transparentBackground: true,
    excludedLayers: mapping.excludedLayers || [],
    animationPrompt: mapping.animationPrompt || "",
    layers: extractedLayers.sort((a, b) => a.zIndex - b.zIndex),
  };

  await fs.writeFile(
    path.join(outputPath, "animation-manifest.json"),
    jsonText(manifest, args.pretty),
  );
  console.log(`Animation manifest written to ${outputPath}`);
}

main().catch((error) => {
  console.error(`PSD extraction failed: ${error?.stack || error}`);
  process.exit(1);
});
