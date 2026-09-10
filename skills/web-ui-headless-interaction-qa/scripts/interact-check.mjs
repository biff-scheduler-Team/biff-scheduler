// 无头交互验收模板(复制到 /tmp 后按项目改断言)。
// 跑法见 SKILL.md Step 4:CHROME_PATH=... BASE=... NODE_PATH=... node this.mjs
import { createRequire } from "node:module";

// ESM 里 NODE_PATH 不生效 → 用 createRequire 从 node_modules 父目录加载
// 解析根:优先环境变量 PW_RESOLVE_ROOT,其次本机受管 node workspace(存在即用)
const RESOLVE_ROOT =
  process.env.PW_RESOLVE_ROOT || `${process.env.HOME}/.workbuddy/binaries/node/workspace/package.json`;
const require = createRequire(RESOLVE_ROOT);
const { chromium } = require("playwright-core");

const BASE = process.env.BASE; // http://127.0.0.1:8971 或 https://<site>
const EXE = process.env.CHROME_PATH;

const errors = [];
const httpErrors = [];
const out = {};

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("response", (r) => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`); });

// 常用探针
const overlays = () => page.locator("#modal-root > div").count(); // 弹层层数(按项目改根选择器)
const displayOf = (i) =>
  page.evaluate((idx) => {
    const o = document.querySelectorAll("#modal-root > div");
    return o.length > idx ? getComputedStyle(o[idx]).display : "n/a";
  }, i);

try {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // ---- 1) 打开入口 ----
  await page.click("#library-btn");
  await page.waitForSelector("#modal-root input[type=search]");
  out["1_弹层数"] = await overlays();

  // ---- 2) 设一个可观察的状态(搜索词)→ 后面用它证明"返回没丢状态" ----
  await page.fill("#modal-root input[type=search]", "001");
  await page.waitForTimeout(250);
  out["2_搜索词"] = await page.inputValue("#modal-root input[type=search]");

  // ---- 3) 压栈:开第二层,下层应 display:none,上层应有「返回」 ----
  await page.click("#modal-root [data-lib-detail]");
  await page.waitForTimeout(300);
  out["3_弹层数"] = await overlays();
  out["3_下层display"] = await displayOf(0);
  out["3_返回按钮数"] = await page.locator("#modal-root > div:last-child button", { hasText: "返回" }).count();

  // ---- 4) 返回:层数回落 + 状态保留 ----
  await page.locator("#modal-root > div:last-child button", { hasText: "返回" }).click();
  await page.waitForTimeout(300);
  out["4_弹层数"] = await overlays();
  out["4_搜索词(应与2一致)"] = await page.inputValue("#modal-root input[type=search]");

  // ---- 5) Esc 只关栈顶 ----
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  out["5_弹层数"] = await overlays();

  // ---- 6) 跳到页面主体的出口应整栈关闭 ----
  // await page.click("#modal-root [data-lib-row]");
  // await page.waitForTimeout(700);
  // out["6_弹层数"] = await overlays();
} catch (e) {
  out["EXCEPTION"] = String(e).split("\n")[0];
}

out["errors"] = errors;
out["http>=400"] = httpErrors; // 静态服务下预期只有 /api/* 404
console.log(JSON.stringify(out, null, 2));
await browser.close();
