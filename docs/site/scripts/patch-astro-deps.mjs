import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve("astro/package.json"));
const cssTreePackageJson = astroRequire.resolve("css-tree/package.json");
const cssTreeSourceMap = join(dirname(cssTreePackageJson), "lib/generator/sourceMap.js");

const originalImport =
  "import { SourceMapGenerator } from 'source-map-js/lib/source-map-generator.js';\n";
const patchedImport =
  "import { createRequire } from 'node:module';\n\nconst require = createRequire(import.meta.url);\n";
const originalMapCreation = `export function generateSourceMap(handlers) {
    const map = new SourceMapGenerator();`;
const patchedMapCreation = `export function generateSourceMap(handlers) {
    const { SourceMapGenerator } = require('source-map-js/lib/source-map-generator.js');
    const map = new SourceMapGenerator();`;

const content = readFileSync(cssTreeSourceMap, "utf8");

if (content.includes("createRequire(import.meta.url)")) {
  process.exit(0);
}

if (!content.includes(originalImport) || !content.includes(originalMapCreation)) {
  throw new Error(
    `Unexpected css-tree sourceMap.js shape; cannot apply Astro dependency patch at ${cssTreeSourceMap}`,
  );
}

writeFileSync(
  cssTreeSourceMap,
  content
    .replace(originalImport, patchedImport)
    .replace(originalMapCreation, patchedMapCreation),
);
