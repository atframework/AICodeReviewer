// Manual brand export. Keep the editable SVG in public/favicon.svg; raster
// assets are committed because release builds must not depend on host fonts.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const iconPath = join(siteRoot, "public", "favicon.svg");
const iconSvg = await readFile(iconPath);

// Starlight imports navigation logos from src/, while browsers use public/.
await mkdir(join(siteRoot, "src", "assets"), { recursive: true });
await copyFile(iconPath, join(siteRoot, "src", "assets", "brand-mark.svg"));

// The runtime dashboard has its own static copy, since the container excludes
// docs/site. The brand export keeps both copies byte-for-byte identical.
await copyFile(
  iconPath,
  join(siteRoot, "..", "..", "packages", "server", "src", "dashboard", "favicon.svg"),
);

for (const [name, size] of [
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
  ["app-icon-512.png", 512],
]) {
  await sharp(iconSvg)
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(siteRoot, "public", name));
}

const width = 1200;
const height = 630;
const socialCard = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#081426"/>
      <stop offset=".58" stop-color="#142B4B"/>
      <stop offset="1" stop-color="#0A1C32"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(230 270) rotate(18) scale(470 370)" gradientUnits="userSpaceOnUse">
      <stop stop-color="#3A9DFF" stop-opacity=".22"/>
      <stop offset="1" stop-color="#3A9DFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#background)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <path d="M0 520h1200M974 0v630" stroke="#8BCBFF" stroke-opacity=".09" stroke-width="2"/>
  <path d="M32 32h1136v566H32z" fill="none" stroke="#9BC9F5" stroke-opacity=".17" stroke-width="2"/>
  <rect x="366" y="115" width="310" height="38" rx="19" fill="#43BDF0" fill-opacity=".13" stroke="#65D3EE" stroke-opacity=".4"/>
  <text x="387" y="140" font-family="Arial, 'Segoe UI', sans-serif" font-size="17" font-weight="700" letter-spacing="2.5" fill="#9BE8F7">SELF-HOSTED · MULTI-VCS</text>
  <text x="366" y="248" font-family="Arial, 'Segoe UI', sans-serif" font-size="72" font-weight="700" letter-spacing="-3" fill="#F4FAFF">AICodeReviewer</text>
  <text x="370" y="315" font-family="Arial, 'Segoe UI', sans-serif" font-size="32" fill="#BDD5EB">AI code review for every change.</text>
  <text x="370" y="362" font-family="Arial, 'Segoe UI', sans-serif" font-size="28" fill="#A0BFD9">Your agents. Your infrastructure. Clear findings.</text>
  <path d="M370 432h744" stroke="#91C6EF" stroke-opacity=".27" stroke-width="2"/>
  <circle cx="379" cy="487" r="6" fill="#42D5AA"/>
  <text x="400" y="495" font-family="Arial, 'Segoe UI', sans-serif" font-size="24" font-weight="600" fill="#D9EDFF">aicr.atframe.work</text>
</svg>`;

const icon = await sharp(iconSvg).resize(220, 220).png().toBuffer();
await sharp(Buffer.from(socialCard))
  .composite([{ input: icon, left: 82, top: 164 }])
  .png({ compressionLevel: 9 })
  .toFile(join(siteRoot, "public", "og-image.png"));

console.log("Generated site and dashboard icon copies and 32px, 180px, 512px, 1200x630 brand images.");
