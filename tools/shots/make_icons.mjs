// Renders the app icons (home screen, manifest) from the Piste mark. Usage: node C:\bikeapp\tools\shots\make_icons.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";

const OUT = "C:\\bikeapp\\prototypes\\icons";
fs.mkdirSync(OUT, { recursive: true });
// full-bleed square (iOS rounds the corners itself); the mark stays inside the maskable safe zone
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${s}" height="${s}">
  <rect width="32" height="32" fill="#0095E6"/>
  <path d="M9 21.5 13.2 11h5.6L23 21.5M13.2 11l3 10.5" transform="translate(16 16) scale(1.08) translate(-16 -16.2)"
    fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
for (const [name, s] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  const page = await browser.newPage({ viewport: { width: s, height: s } });
  await page.setContent(`<html><body style="margin:0;background:#0095E6">${svg(s)}</body></html>`);
  await page.screenshot({ path: `${OUT}\\${name}`, clip: { x: 0, y: 0, width: s, height: s } });
  await page.close();
  console.log(name, s);
}
await browser.close();
