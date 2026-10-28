import { chromium } from "playwright-core";
const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("http://localhost:8766/index.html", { waitUntil: "load" });
try { await page.waitForFunction(() => !!window.__app && document.querySelector("#loading").hidden, null, { timeout: 60000 }); } catch (e) { }
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({ app: !!window.__app, route: window.__app ? Math.round(window.__app.state.route.length) : null, tris: window.__app ? window.__app.renderer.info.render.triangles : null }));
await page.screenshot({ path: "C:\\bikeapp\\prototypes\\screens\\C6-artifact-phone.png" });
console.log(JSON.stringify({ ...info, errors: errors.filter((e) => !/404/.test(e)).slice(0, 6) }));
await b.close();
