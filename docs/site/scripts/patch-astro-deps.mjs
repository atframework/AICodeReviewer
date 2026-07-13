import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve("astro/package.json"));
const cssTreePackageJson = astroRequire.resolve("css-tree/package.json");
const cssTreeSourceMap = join(dirname(cssTreePackageJson), "lib/generator/sourceMap.js");
const starlightRequire = createRequire(require.resolve("@astrojs/starlight"));
const fontkittenEntry = starlightRequire.resolve("fontkitten");

const originalImport =
  "import { SourceMapGenerator } from 'source-map-js/lib/source-map-generator.js';\n";
const patchedImport =
  "import { createRequire } from 'node:module';\n\nconst require = createRequire(import.meta.url);\n";
const originalMapCreation = `export function generateSourceMap(handlers) {
    const map = new SourceMapGenerator();`;
const patchedMapCreation = `export function generateSourceMap(handlers) {
    const { SourceMapGenerator } = require('source-map-js/lib/source-map-generator.js');
    const map = new SourceMapGenerator();`;

function patchCssTreeSourceMap() {
  const content = readFileSync(cssTreeSourceMap, "utf8");

  if (content.includes("createRequire(import.meta.url)")) {
    return;
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
}

const originalInflateImport = 'import inflate from "tiny-inflate";';
const patchedInflateImport = `import { createRequire as createInflateRequire } from "node:module";

const inflateRequire = createInflateRequire(import.meta.url);
const inflate = inflateRequire("tiny-inflate");`;

function patchFontkittenTinyInflate() {
  const content = readFileSync(fontkittenEntry, "utf8");

  if (content.includes("createInflateRequire(import.meta.url)")) {
    return;
  }

  if (!content.includes(originalInflateImport)) {
    throw new Error(
      `Unexpected fontkitten entry shape; cannot apply tiny-inflate compatibility patch at ${fontkittenEntry}`,
    );
  }

  writeFileSync(
    fontkittenEntry,
    content.replace(originalInflateImport, patchedInflateImport),
  );
}

patchCssTreeSourceMap();
patchFontkittenTinyInflate();
