// Checks a site built by tools/build_site.py, the way visitors reach it: the app at the root, old /a-positron/ and
// about.html links forwarding (with ?query and #hash), the about page's images, the home-screen manifest.
// Every same-origin file must load (no 404s) and the page must throw no errors.
// Usage: node site_check.mjs <base url> [<base url> ...]     e.g. http://127.0.0.1:8766/ http://127.0.0.1:8767/piste/
// Browser: same PISTE_BROWSER / PISTE_BROWSER_ARGS as test.mjs (default: the Edge installed on this PC).
import { chromium } from "playwright-core";

const bases = process.argv.slice(2).map((b) => (b.endsWith("/") ? b : b + "/"));
if (!bases.length) { console.log("usage: node site_check.mjs <base url> [...]"); process.exit(1); }
const BROWSER = (process.env.PISTE_BROWSER || "msedge").toLowerCase();
const launch = { headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", ...(process.env.PISTE_BROWSER_ARGS || "").split(/\s+/).filter(Boolean)] };
if (BROWSER !== "chromium") launch.channel = BROWSER;
const browser = await chromium.launch(launch);
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) fails.push(what); };

for (const base of bases) {
  const origin = new URL(base).origin;
  console.log(`\n${base}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("umami.disabled", "1"); } catch (e) { /* storage blocked */ } });   // checks never count as visits
  const page = await ctx.newPage();
  const bad = [], errors = [];
  page.on("response", (r) => { if (r.url().startsWith(origin) && r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(origin.length)}`); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  // The app at the root
  await page.goto(base, { waitUntil: "load", timeout: 90000 });
  const app = await page.waitForFunction(() => !!(window.__app && window.__app.router && window.__app.router.n), null, { timeout: 90000 }).then(() => true, () => false);
  check(app, "the app starts at the root");
  const cards = await page.evaluate(() => document.querySelectorAll("#classic-track > *").length).catch(() => 0);
  check(new URL(page.url()).pathname === new URL(base).pathname, `it stays at the root (${new URL(page.url()).pathname})`);

  // Old links forward, keeping ?query and #hash
  await page.goto(base + "a-positron/?lang=fr#here", { waitUntil: "load" });
  await page.waitForURL((u) => !u.pathname.includes("a-positron"), { timeout: 15000 }).catch(() => {});
  check(page.url() === base + "?lang=fr#here", `/a-positron/?lang=fr#here forwards to ${page.url().slice(origin.length)}`);
  await page.goto(base + "a-positron/index.html?x=1", { waitUntil: "load" });
  await page.waitForURL((u) => !u.pathname.includes("a-positron"), { timeout: 15000 }).catch(() => {});
  check(page.url() === base + "?x=1", `/a-positron/index.html?x=1 forwards to ${page.url().slice(origin.length)}`);

  // About page: one folder down, every image loads, the app link goes to the root
  await page.goto(base + "about.html", { waitUntil: "load" });
  await page.waitForURL((u) => u.pathname.endsWith("/about/"), { timeout: 15000 }).catch(() => {});
  check(page.url() === base + "about/", `about.html forwards to ${page.url().slice(origin.length)}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 30000 }).catch(() => {});
  const imgs = await page.evaluate(() => [...document.images].map((i) => ({ src: i.getAttribute("src"), ok: i.naturalWidth > 0 })));
  check(imgs.length > 0 && imgs.every((i) => i.ok), `about page: ${imgs.filter((i) => i.ok).length}/${imgs.length} images load`);
  const appLink = await page.evaluate(() => { const a = [...document.links].find((l) => /open the app/i.test(l.textContent)); return a ? a.href : null; });
  check(appLink === base, `about page's "Open the app" goes to ${appLink ? appLink.slice(origin.length) : "nothing"}`);

  // Home-screen manifest and the phone preview
  const man = await page.evaluate(async (b) => (await fetch(b + "manifest.webmanifest")).json(), base);
  check(man.start_url === "./" && man.scope === "./", `manifest start_url ${man.start_url}, scope ${man.scope}`);
  const phone = await page.evaluate(async (b) => (await fetch(b + "phone.html")).text(), base);
  check(!phone.includes("a-positron"), "phone.html frames the app at the root");

  check(bad.length === 0, `no missing files${bad.length ? ": " + [...new Set(bad)].slice(0, 5).join(", ") : ""}`);
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(`      (classic ride cards at the root: ${cards})`);
  await ctx.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} site check(s) failed` : "\nall site checks passed");
process.exit(fails.length ? 1 : 0);
