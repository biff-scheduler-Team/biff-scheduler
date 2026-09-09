const { chromium } = require("playwright-core");
const exec = process.env.CHROME_PATH;
(async () => {
  const browser = await chromium.launch({ executablePath: exec, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERR2:", e.message));
  await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const dump = await page.evaluate(() => {
    const out = {};
    out.ruler = [...document.querySelectorAll("#grid-scroll")].map((g) =>
      [...g.querySelectorAll("span")].slice(0, 40).map((e) => e.textContent).join(" | ")
    )[0];
    out.chips = [...document.querySelectorAll("#date-chips button")].map((e) => e.textContent).join(" | ");
    out.count = document.getElementById("grid-count")?.textContent;
    out.title = document.getElementById("grid-date-title")?.textContent;
    const found = [];
    document.querySelectorAll("#grid-scroll [data-code]").forEach((c) => {
      found.push(c.textContent.replace(/\s+/g, " ").trim().slice(0, 70));
    });
    out.cards = found.slice(0, 10);
    return out;
  });
  console.log(JSON.stringify(dump, null, 1));
  await browser.close();
})();
