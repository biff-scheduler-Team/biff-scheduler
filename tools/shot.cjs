const { chromium } = require("playwright-core");
const exec = process.env.CHROME_PATH;
(async () => {
  const browser = await chromium.launch({ executablePath: exec, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("PAGEERR:", m.text()); });
  page.on("pageerror", (e) => console.log("PAGEERR2:", e.message));
  await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/biff-main-1440.png", fullPage: true });
  await page.evaluate(() => { const s = document.getElementById("grid-scroll"); if (s) s.scrollLeft = s.scrollWidth; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/biff-scrolled-right.png" });
  await page.evaluate(() => { const s = document.getElementById("grid-scroll"); if (s) s.scrollLeft = 0; });
  await page.waitForTimeout(400);
  const grid = await page.locator("#grid-scroll").boundingBox();
  if (grid) {
    await page.screenshot({ path: "/tmp/biff-grid-left.png", clip: { x: grid.x, y: grid.y, width: Math.min(grid.width, 960), height: Math.min(grid.height, 300) } });
  }
  await browser.close();
  console.log("done");
})();
