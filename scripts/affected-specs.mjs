// 按改动路径挑出「必跑」的 E2E spec(2026-09-13,PLAN-20260913201727)。
//
// 为什么要有它:§2 要求「改了 UI → 跑受影响 spec」,但仓库里有 31 个 spec,
// 「受影响」以前只存在于人脑里 —— 于是要么漏跑,要么每次全量(5–9 min)。
//
// 映射的**唯一来源**是 scripts/test-map.json;docs/TEST-MAP.md 的人读表格由本脚本生成。
// 不要在 md 里手改表格 —— `--check` 会断言两者同步(串进 verify:quick)。
//
// 用法:
//   node scripts/affected-specs.mjs --base origin/main       # 相对某 ref 的改动 → spec 路径(供 CI)
//   node scripts/affected-specs.mjs --files a.ts b.tsx       # 直接给改动列表
//   node scripts/affected-specs.mjs --write-doc              # 重新生成 docs/TEST-MAP.md 的表格
//   node scripts/affected-specs.mjs --check                  # 断言 md 与 json 同步(不同步则退出 1)
//
// ⚠ 输出是**最少必跑集**,不是「跑了这些就一定够」。命中 allOn 或无法归类时返回全量。
// ⚠ `test-map.json` 的 rules 全是 `apps/` 源码路径 —— 于是「只改测试」的提交以前谁也命中不了,
// 只落到 always(smoke),等于**改了的 spec 根本没跑**。selfSpecPrefixes 补上这一半(2026-10-16):
// 该目录里 `<名>.spec.ts` 改自己 → 至少跑 `<名>`;其余(共享件 / 子目录)影响面未知 → 退全量。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const map = JSON.parse(readFileSync(resolve(root, "scripts/test-map.json"), "utf8"));
const docPath = resolve(root, "docs/TEST-MAP.md");
const BEGIN = "<!-- BEGIN GENERATED:test-map -->";
const END = "<!-- END GENERATED:test-map -->";

/** paths 以 / 结尾 = 目录前缀;否则 = 精确文件。 */
const hit = (path, pattern) => (pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern);

/** 所有 E2E spec 的短名(不含目录与扩展名),按 test-map.json 里出现过的顺序 + 磁盘顺序兜底。 */
export function allSpecs() {
  const fromDisk = execFileSync("git", ["ls-files", "e2e/react/*.spec.ts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/^e2e\/react\//, "").replace(/\.spec\.ts$/, ""));
  return fromDisk.sort();
}

/** 给定改动文件列表,返回必跑的 spec 短名(已排序、已去重)。 */
export function affectedSpecs(changed, specs = allSpecs()) {
  const known = new Set(specs);
  const picked = new Set();
  let why = [];
  if (changed.some((path) => map.allOn.some((pattern) => hit(path, pattern)))) {
    return { specs, all: true, reasons: ["命中 allOn(全局样式 / 配置),按全量跑"] };
  }
  // 「改测试也得验测试」:在 spec 目录(selfSpecPrefixes)里 ——
  //   · 改 `<名>.spec.ts` → 至少把那个 spec 跑一遍;
  //   · 改共享件(helpers / fixtures / 子目录)→ 影响面不止一个 spec,退全量。
  // 之前没有这一条,于是**只改 e2e 的提交在 PR 上只跑 always(smoke)** —— 绿灯是空的:
  // 2026-10-16 实测 run 38884776014 只跑了 smoke,而它本该验证的是 parity-library 的改法。
  const selfPrefixes = map.selfSpecPrefixes ?? [];
  /**
   * spec 目录里的路径 → 对应的 spec 短名。
   * `null` = 不是 spec(共享件 / 子目录);`undefined` = 压根不在 spec 目录里,这一条不管它。
   */
  const asSpecName = (path) => {
    const prefix = selfPrefixes.find((item) => path.startsWith(item));
    if (!prefix) return undefined;
    const matched = /^([^/]+)\.spec\.ts$/.exec(path.slice(prefix.length));
    return matched ? matched[1] : null;
  };
  // 只解析一次:`name === null` 与 `name === undefined` 是两种不同的处置(全量 / 不管),
  // 分开重算容易在后续改动里让两条分支读到不同的判定。
  const inSpecDir = changed.map((path) => ({ path, name: asSpecName(path) })).filter((item) => item.name !== undefined);
  // ⚠ 共享件刻意**不写死名单**:新增一个 fixture / helper 时没人会记得回来补 allOn,
  // 而漏跑的代价是「绿灯是空的」(见上),多跑一次全量只是几分钟 —— 一边倒的取舍。
  if (inSpecDir.some((item) => item.name === null)) {
    return { specs, all: true, reasons: ["命中 e2e 的共享件(helpers / fixtures / 子目录),按全量跑"] };
  }
  for (const { path, name } of inSpecDir) {
    if (!known.has(name)) {
      why.push(`⚠ ${path}:没有同名的 ${name}.spec.ts`);
      continue;
    }
    picked.add(name);
    why.push(`spec 自身:${name}`);
  }
  for (const rule of map.rules) {
    if (!changed.some((path) => rule.paths.some((pattern) => hit(path, pattern)))) continue;
    const knownSpecs = rule.specs.filter((spec) => known.has(spec));
    const missing = rule.specs.filter((spec) => !known.has(spec));
    if (missing.length) why.push(`⚠ ${rule.id}:映射里有磁盘上不存在的 spec → ${missing.join(", ")}`);
    for (const spec of knownSpecs) picked.add(spec);
    why.push(`${rule.id}:${knownSpecs.join(", ")}`);
  }
  for (const spec of map.always) if (known.has(spec)) picked.add(spec);
  return { specs: [...picked].sort(), all: false, reasons: why };
}

function changedSince(base) {
  return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** 生成 docs/TEST-MAP.md 里的表格(唯一来源 = test-map.json)。 */
function renderTable() {
  const specs = allSpecs();
  const rows = [
    "| 改动路径(前缀) | 必跑 spec |",
    "|---|---|",
    ...map.rules.map(
      (rule) =>
        `| ${rule.paths.map((path) => `\`${path}\``).join("<br>")} | ${rule.specs
          .map((spec) => (specs.includes(spec) ? `\`${spec}\`` : `⚠ \`${spec}\`(不存在)`))
          .join(" · ")} |`,
    ),
    `| **任何改动都跑** | ${map.always.map((spec) => `\`${spec}\``).join(" · ")} |`,
    `| **命中即全量** | ${map.allOn.map((path) => `\`${path}\``).join(" · ")} |`,
  ];
  return rows.join("\n");
}

function writeDoc() {
  const current = readFileSync(docPath, "utf8");
  const block = `${BEGIN}\n${renderTable()}\n${END}`;
  const next = current.includes(BEGIN)
    ? current.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block)
    : `${current}\n${block}\n`;
  writeFileSync(docPath, next);
  console.log(`affected-specs:已重写 ${docPath} 的生成区块`);
}

function checkDoc() {
  const current = readFileSync(docPath, "utf8");
  const match = current.match(new RegExp(`${BEGIN}[\\s\\S]*?${END}`));
  if (!match) {
    console.error(`affected-specs --check:${docPath} 缺少生成区块标记`);
    return 1;
  }
  if (match[0] !== `${BEGIN}\n${renderTable()}\n${END}`) {
    console.error("affected-specs --check:docs/TEST-MAP.md 的表格与 scripts/test-map.json 不同步");
    console.error("  修法:node scripts/affected-specs.mjs --write-doc");
    return 1;
  }
  console.log("affected-specs --check:docs/TEST-MAP.md 与 scripts/test-map.json 同步");
  return 0;
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? "";
};

if (argv.includes("--write-doc")) {
  writeDoc();
} else if (argv.includes("--check")) {
  process.exit(checkDoc());
} else if (argv.includes("--table")) {
  console.log(renderTable());
} else {
  const files = flag("--files") ? argv.slice(argv.indexOf("--files") + 1) : changedSince(flag("--base") ?? "origin/main");
  const result = affectedSpecs(files);
  for (const reason of result.reasons) console.log(`# ${reason}`);
  if (!files.length) console.log("# 无改动");
  if (!result.all && !result.specs.length) console.log("# ⚠ 未命中任何规则,也没进 always —— 请补 test-map.json");
  console.log(result.specs.map((spec) => `e2e/react/${spec}.spec.ts`).join("\n"));
}
