const { chromium } = require("playwright-core");
const exec = process.env.CHROME_PATH;
(async () => {
  const browser = await chromium.launch({ executablePath: exec, headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto("http://[::1]:5199/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const box = await page.locator("#grid-scroll").boundingBox();
  if (!box) return;
  // ruler close-up, hi-dpi
  await page.screenshot({ path: "/tmp/biff-ruler-hi.png", clip: { x: box.x, y: box.y, width: Math.min(280, box.width), height: 32 } });
  // 最右边缘(滚到最右) — 看 23:00
  await page.evaluate(() => { const s = document.getElementById("grid-scroll"); s.scrollLeft = s.scrollWidth; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: "/tmp/biff-ruler-right-hi.png", clip: { x: box.x + box.width - 280, y: box.y, width: 280, height: 32 } });
  // 整体网格初始视图(高 dpi)
  await page.evaluate(() => { const s = document.getElementById("grid-scroll"); s.scrollLeft = 0; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: "/tmp/biff-grid-hi.png", fullPage: true });
  await browser.close();
})();