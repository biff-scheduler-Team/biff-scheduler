// 仓库卫生检查(2026-09-13,PLAN-20260913201727)。
//
// 为什么要有它:2026-09-12 / 13 有三个 AI 会话草稿(findings.md / progress.md / task_plan.md)
// 被提交进仓库根目录,违反 §8 红线 11「提交临时文件」,而**没有人发现** —— 因为它们长得
// 不像临时文件。这类问题规范条款拦不住,只有机械检查能。
//
// 用法:
//   node scripts/check-repo.mjs               # 检查当前 git 索引里的被跟踪文件
//   node scripts/check-repo.mjs --self-test   # 自检:证明检查器既放行干净输入,也能抓到植入的违规
//
// ⚠ 边界:本脚本只做「文件级」卫生。它**不能**替代 §2 的测试门禁,也不看未跟踪文件
//   (未跟踪的东西本来就进不了提交)。

import { execFileSync } from "node:child_process";

/** 仓库根允许出现的条目。新增顶层条目必须同时改这里 —— 这点摩擦是刻意的。 */
const ROOT_ALLOWED = new Set([
  ".github",
  "apps",
  "data",
  "docs",
  "e2e",
  "packages",
  "scripts",
  "skills",
  "tests",
  "tools",
  ".editorconfig",
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "PLAN.md",
  "README.md",
  "eslint.config.js",
  "package-lock.json",
  "package.json",
  "playwright.config.ts",
  "playwright.react.config.ts",
  "tsconfig.e2e.json",
  "tsconfig.tests.json",
  "vitest.config.ts",
]);

/** 任何位置都不允许被跟踪的路径。 */
const FORBIDDEN = [
  {
    rule: "build-artifact",
    re: /(^|\/)(dist|dev-dist)\//,
    hint: "构建产物不进版本库(Cloudflare 云端会重建,dist/ 在 .gitignore 里)",
  },
  {
    rule: "secret",
    re: /(^|\/)\.env(\.|$)/,
    allow: /\.env\.example$/,
    hint: "密钥只读环境变量;要留模板就用 .env.example",
  },
  {
    rule: "cache",
    re: /(^|\/)(__pycache__|\.wrangler|node_modules)\//,
    hint: "缓存 / 依赖不进版本库",
  },
  {
    rule: "scratch-data",
    re: /(^|\/)data\/_/,
    hint: "一次性长跑产物走 data/_*(.gitignore 已忽略)",
  },
  { rule: "log", re: /\.log$/, hint: "日志不进版本库" },
  { rule: "tmp", re: /\.tmp\./, hint: "一次性脚本 / 中间产物不进版本库" },
];

/**
 * 找出被跟踪路径里的违规项。
 *
 * 每个路径**只报一条**(FORBIDDEN 优先于 root-whitelist):否则 `.env` 这类会同时命中
 * 「密钥」与「根目录白名单」两条,输出里出现重复行,反而看不出真正的原因。
 *
 * @param {string[]} paths 相对仓库根的路径(git ls-files 的输出)
 * @returns {{path: string, rule: string, hint: string}[]} 违规列表,空数组 = 干净
 */
export function findViolations(paths) {
  const violations = [];
  for (const path of paths) {
    const hit = FORBIDDEN.find(({ re, allow }) => !allow?.test(path) && re.test(path));
    if (hit) {
      violations.push({ path, rule: hit.rule, hint: hit.hint });
      continue;
    }
    if (!path.includes("/") && !ROOT_ALLOWED.has(path))
      violations.push({
        path,
        rule: "root-whitelist",
        hint: "仓库根只允许白名单条目;会话草稿落 .scratch/(已 gitignore),需求文档落 docs/",
      });
  }
  return violations;
}

/** 自检:对「干净输入」与「植入的违规」各断言一次 —— 避免检查器自己静默失效。 */
function selfTest() {
  const cases = [
    {
      name: "干净输入放行",
      paths: ["apps/web/src/main.ts", "docs/plans/PLAN-1.md", ".github/workflows/ci.yml", "package.json"],
      expect: 0,
    },
    { name: "抓到根目录会话草稿", paths: ["findings.md", "progress.md", "task_plan.md"], expect: 3 },
    { name: "抓到构建产物", paths: ["apps/api/dist/index.js"], expect: 1 },
    { name: "抓到密钥但放行示例", paths: [".env", ".env.local", ".env.example"], expect: 2 },
    { name: "抓到日志 / 缓存 / 一次性数据", paths: ["data/run.log", "tools/__pycache__/x.pyc", "data/_cache/a.json"], expect: 3 },
    { name: "抓到一次性脚本", paths: ["tools/foo.tmp.mjs"], expect: 1 },
  ];
  let failed = 0;
  for (const { name, paths, expect } of cases) {
    const actual = findViolations(paths).length;
    const ok = actual === expect;
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${name}(期望 ${expect} 条违规,实际 ${actual} 条)`);
  }
  console.log(failed === 0 ? `check-repo --self-test:${cases.length}/${cases.length} 通过` : `check-repo --self-test:${failed} 项失败`);
  return failed === 0 ? 0 : 1;
}

if (process.argv.includes("--self-test")) {
  process.exit(selfTest());
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);
const violations = findViolations(tracked);
if (violations.length) {
  console.error(`check-repo:${violations.length} 条违规 ——`);
  for (const { path, rule, hint } of violations) console.error(`  ✗ [${rule}] ${path}\n      ${hint}`);
  process.exit(1);
}
console.log(`check-repo:${tracked.length} 个被跟踪文件,0 违规`);
