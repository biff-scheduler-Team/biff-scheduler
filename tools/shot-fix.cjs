const { chromium } = require("playwright-core");
const exec = process.env.CHROME_PATH;
async function shoot(width, name) {
  const browser = await chromium.launch({ executablePath: exec, headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("PAGEERR:", e.message));
  await page.goto("http://[::1]:5199/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `/tmp/biff-fix-${name}.png`, fullPage: true });
  // ruler close-up
  const box = await page.locator("#grid-scroll").boundingBox();
  if (box) {
    await page.screenshot({
      path: `/tmp/biff-fix-${name}-ruler.png`,
      clip: { x: box.x, y: box.y, width: Math.min(280, box.width), height: 32 },
    });
    // data on the layout
    const data = await page.evaluate(() => {
      const s = document.getElementById("grid-scroll");
      const track = s.querySelector(".relative");
      const rulerTicks = s.querySelector(".relative");
      const ticks = Array.from(s.querySelectorAll("span.absolute")).map((e) => e.textContent);
      return {
        clientWidth: s.clientWidth, scrollWidth: s.scrollWidth,
        scrollLeft: s.scrollLeft, overflow: s.scrollWidth - s.clientWidth,
        trackW: track ? track.getBoundingClientRect().width : null,
        ticks,
        stickyLabelText: s.querySelector(".sticky.left-0 span")?.textContent,
      };
    });
    console.log(`[${name}]`, JSON.stringify(data));
  }
  await browser.close();
}
(async () => {
  await shoot(1440, "1440");
  await shoot(1280, "1280");
  await shoot(1100, "1100");
  await shoot(900, "900");
})();