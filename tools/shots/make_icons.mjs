// Renders the app icons from the Piste logo (prototypes/icons/logo.svg: a white P with the bike chain on a blue square, full bleed).
// Usage, from anywhere: node tools/shots/make_icons.mjs
//   prototypes/icons/apple-touch-icon.png (180), icon-192.png, icon-512.png   the logo as it is: the P stays inside the maskable safe zone
//                                                                          (the central circle of 80 % of the side), so the 512 serves "any" and "maskable"
//   prototypes/favicon.ico (16, 32, 48)                                    the P drawn larger (FAVICON_SCALE): at 16 px the logo's own padding costs too much
// iOS rounds the home-screen icon's corners itself, so every file is a plain square. Uses the Edge installed on this PC.
import { chromium } from "playwright-core";
import fs from "node:fs";

const PROTO = new URL("../../prototypes/", import.meta.url);
const LOGO = fs.readFileSync(new URL("icons/logo.svg", PROTO), "utf8");
const LOGO_SCALE = ".9", FAVICON_SCALE = "1";   // the P's size relative to the 512 square, as written in logo.svg and as used for the favicon
if (!LOGO.includes(`scale(${LOGO_SCALE})`)) throw new Error("logo.svg no longer scales the P by " + LOGO_SCALE + ": update LOGO_SCALE");

const svgAt = (px, scale) => LOGO.replace('width="512" height="512"', `width="${px}" height="${px}"`).replace(`scale(${LOGO_SCALE})`, `scale(${scale})`);

const browser = await chromium.launch({ channel: "msedge", headless: true });
async function render(px, scale) {
  const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:#0095E6">${svgAt(px, scale)}</body></html>`);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: px, height: px } });
  await page.close();
  return png;
}

for (const [name, px] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  fs.writeFileSync(new URL(`icons/${name}`, PROTO), await render(px, LOGO_SCALE));
  console.log(name, px);
}

// favicon.ico: PNG pictures in an ICO container (every browser since 2009 reads them)
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map((px) => render(px, FAVICON_SCALE)));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);   // type 1 = icon, then the picture count
let offset = head.length;
sizes.forEach((px, i) => {
  const e = 6 + 16 * i;
  head[e] = px; head[e + 1] = px;                                  // width, height (0 would mean 256)
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);     // colour planes, bits per pixel
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(new URL("favicon.ico", PROTO), Buffer.concat([head, ...pngs]));
console.log("favicon.ico", sizes.join("/"));
await browser.close();
