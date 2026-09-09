const { chromium } = require("playwright-core");
const exec = process.env.CHROME_PATH;
(async () => {
  const browser = await chromium.launch({ executablePath: exec, headless: true, proxy: { server: "direct://" }, args: ["--no-proxy-server", "--proxy-bypass-list=*"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://[::1]:5199/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  // 截 ruler 区
  const ruler = await page.locator("#grid-scroll > div > div").first().boundingBox();
  const ticks = await page.locator("#grid-scroll span.absolute").first().boundingBox();
  console.log("ruler bbox", ruler, "first tick", ticks);
  // 截 grid-scroll 顶部 60px 宽 1440
  const box = await page.locator("#grid-scroll").boundingBox();
  if (box) {
    await page.screenshot({ path: "/tmp/biff-ruler.png", clip: { x: box.x, y: box.y, width: box.width, height: 30 } });
    // 滚到最右再截
    await page.evaluate(() => { const s = document.getElementById("grid-scroll"); s.scrollLeft = s.scrollWidth; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: "/tmp/biff-ruler-right.png", clip: { x: box.x, y: box.y, width: box.width, height: 30 } });
  }
  await browser.close();
})();