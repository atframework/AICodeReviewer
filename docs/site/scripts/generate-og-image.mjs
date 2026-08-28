// Generate the committed social preview image `public/og-image.png` (1200x630,
// the Open Graph standard size). Manual maintenance script — NOT wired into the
// build chain on purpose: sharp renders SVG <text> through the system font
// stack, so CI output would depend on runner fonts. Regenerate with
//   pnpm --filter @aicr/docs-site generate:og-image
// after changing the brand mark or the tagline, then commit the PNG.
// `validate-seo.mjs` guards the committed asset (presence, dimensions, wiring),
// so a stale or missing image fails `pnpm docs:build`.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 630;

// Brand mark reused from public/favicon.svg (rounded tile + </> strokes +
// green review check), scaled up to 180px and centered.
const logo = `
  <g transform="translate(510, 74) scale(1.40625)">
    <defs>
      <linearGradient id="aicrBg" x1="16" y1="12" x2="112" y2="116" gradientUnits="userSpaceOnUse">
        <stop stop-color="#2f6bff" />
        <stop offset="1" stop-color="#12b3e8" />
      </linearGradient>
    </defs>
    <rect x="12" y="12" width="104" height="104" rx="24" fill="url(#aicrBg)" />
    <path d="M52 46 L36 64 L52 82" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M76 46 L92 64 L76 82" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M68 40 L60 88" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" opacity="0.55" />
    <circle cx="100" cy="100" r="20" fill="#16a34a" stroke="#ffffff" stroke-width="5" />
    <path d="M91 100 L98 107 L110 93" fill="none" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${WIDTH}" y2="${HEIGHT}" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0d1526" />
      <stop offset="1" stop-color="#101b33" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.32" r="0.55">
      <stop stop-color="#2f6bff" stop-opacity="0.16" />
      <stop offset="1" stop-color="#2f6bff" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)" />
  <rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="18" fill="none" stroke="#2f6bff" stroke-opacity="0.35" stroke-width="2" />
  ${logo}
  <text x="600" y="372" text-anchor="middle" font-family="Arial, 'Segoe UI', 'Noto Sans', sans-serif" font-size="82" font-weight="700" fill="#ffffff">AICodeReviewer</text>
  <text x="600" y="436" text-anchor="middle" font-family="Arial, 'Segoe UI', 'Noto Sans', sans-serif" font-size="33" font-weight="400" fill="#9fb4d8">Self-hosted AI code review orchestration</text>
  <text x="600" y="540" text-anchor="middle" font-family="Arial, 'Segoe UI', 'Noto Sans', sans-serif" font-size="30" font-weight="600" fill="#6db3ff">aicr.atframe.work</text>
</svg>`;

const outPath = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "public",
  "og-image.png",
);
const png = await sharp(Buffer.from(svg)).png().toFile(outPath);
console.log(`Wrote ${outPath} (${png.width}x${png.height}, ${png.size} bytes)`);
