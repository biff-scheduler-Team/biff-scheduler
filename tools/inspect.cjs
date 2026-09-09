const { chromium } = require("playwright-core");
const exec = process.env.CHROME_PATH;
(async () => {
  const browser = await chromium.launch({ executablePath: exec, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  // 列出所有 ruler 标尺的文本 + 位置 + 父容器滚动信息
  const data = await page.evaluate(() => {
    const out = { scroll: null, ruler: null, ticks: [], labels: [] };
    const s = document.getElementById("grid-scroll");
    if (s) {
      out.scroll = {
        clientWidth: s.clientWidth, scrollWidth: s.scrollWidth, scrollLeft: s.scrollLeft,
        trackInline: getComputedStyle(s).overflowX, hasPanning: s.classList.contains("panning"),
      };
    }
    const ticks = document.querySelectorAll("#grid-scroll .relative > span.absolute, #grid-scroll .relative > .absolute");
    out.ticks = Array.from(document.querySelectorAll("#grid-scroll span.absolute")).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
    }).filter((x) => /^\d{1,2}(:00)?/.test(x.text));
    // 列出所有时间列内的卡片文本(前 8 张)
    out.cards = Array.from(document.querySelectorAll('#grid-scroll [data-code]')).slice(0, 8).map((c) => {
      const r = c.getBoundingClientRect();
      return { code: c.dataset.code, w: Math.round(r.width), text: c.innerText.replace(/\n/g, " | ") };
    });
    return out;
  });
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
