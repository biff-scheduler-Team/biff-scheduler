// 部署核对:一条命令替代 §6 里那套「人工三步」(2026-10-16)。
//
// 为什么要有它:§6 的交付判据是「asset hash 相同(不是内容 grep)+ 自己新增的字符串 + 一组阴性对照」,
// 但此前这三步全靠人记、人敲 curl —— 每次发布重复三遍,还留不下证据(报告里只能写「我看过了」)。
// 本脚本把它变成**一条命令 + 一行可粘贴的结论**。
//
// 判据强度(从强到弱,顺序就是脚本的执行顺序):
//   1. **构建 SHA 相同**(`--sha`)**—— 最强,而且唯一能回答「这次提交上线了吗」。**
//      产物由 build 期写入的 `version.json` 提供(见 scripts/prepare-cloudflare.mjs)。
//      为什么需要它:asset hash 只在应用产物变化时才变,纯文档 / 工具链提交的 hash 与上一版逐字相同,
//      而线上**区分不了**「构建成功但产物相同」与「构建失败、压根没发布」。
//   2. **asset hash 相同**。hash 变了说明线上跑的不是你这份产物,后面几条都不用看。
//   3. **本轮新增的字符串命中** —— 证明「确实是新版」,不是恰好 hash 撞上。
//   4. **阴性对照未命中** —— 证明上面那次「命中」不是因为检索本身失灵(总是返回「有」)。
//      默认自动加一条随机串;本轮**删掉**的字符串用 `--negative` 显式传进来更有意义。
//
// ⚠ 缓存:全部请求带 cache-buster(`?cb=<时间戳>`),否则拿到的可能是 CDN 上的旧响应。
// ⚠ 本脚本只读线上,不部署、不写文件。
// ⚠ **本地 dist 的 hash 只在它属于你要核对的那笔提交时才算判据**:多会话共用工作区里
//    `apps/web/dist` 常常是**别人**的构建(实测:自己的提交明明已上线,却因本地 dist 是对方那一版
//    而判「未核实」)。归属靠 dist 里的 `version.json` 判定,不符就跳过 hash 比对并打一行说明。
//
// 用法(三条判据至少要给一条;给多条就都判):
//   npm run verify:deploy -- --sha HEAD --new "<本轮新增的字符串>"   # 改了应用产物:推荐
//   npm run verify:deploy -- --sha HEAD                              # 纯文档 / 工具链:没有新字符串
//   node scripts/verify-deploy.mjs --new "<新字符串>" --negative "<本轮删掉的字符串>" --hash <入口 hash>
//   node scripts/verify-deploy.mjs --self-test                       # 自检:纯函数,不联网
//
// 退出码:0 = 全部判据通过;1 = 有判据失败;2 = 参数/网络问题(拿不到页面)。

import { spawnSync } from "node:child_process";

const DEFAULT_URL = "https://biff.lcandy.co";

/** 从 HTML 里取入口 bundle 的 hash(`/assets/main-<hash>.js`)。取不到返回 null。
 *  ⚠ 只认 `main-*`:`modulepreload` 里的 `react-*` / `spectrum-*` 是分包,拿它们比 hash 会永远不等。 */
export function mainAssetOf(html) {
  const match = html.match(/\/assets\/main-([A-Za-z0-9_-]+)\.js/);
  return match ? { hash: match[1], path: `/assets/main-${match[1]}.js` } : null;
}

/** 从 `version.json` 里取构建 SHA。不是 JSON / 没有 sha 字段 → null
 *  (SPA 的 `not_found_handling` 会把不存在的路径回落到 index.html,那时这里必须返回 null 而不是抛错)。 */
export function versionShaOf(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.sha === "string" ? parsed.sha : null;
  } catch {
    return null;
  }
}

/** 解析命令行。把 collect / option 收进闭包,**调用方拿不到 argv** ——
 *  上一版它们是 `(argv, name)` 的公开函数,调用处漏传 argv 变成 `option("--hash")`,
 *  于是 `--hash` 静默失效(静默退化成本次核对只看本地 dist)。收进闭包后这类错误写不出来。 */
export function parseArgs(argv) {
  /** `--flag` 后面的值;下一个 token 若还是开关(`--xxx`)就不吞它,避免「缺值」被当成值。 */
  const collect = (name) => {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
      const value = argv[index + 1];
      if (argv[index] !== name || value === undefined || value.startsWith("--")) continue;
      values.push(value);
    }
    return values;
  };
  const option = (name) => collect(name).at(-1) ?? null;
  return {
    url: (option("--url") ?? DEFAULT_URL).replace(/\/+$/, ""),
    wanted: collect("--new"),
    expectedHash: option("--hash"),
    expectedSha: option("--sha"),
    negatives: collect("--negative"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

/** 带 cache-buster 拉文本;非 2xx 一律抛错(静默拿空串会让所有断言「通过」,最危险)。 */
async function fetchText(url) {
  const withBuster = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;
  const response = await fetch(withBuster, { redirect: "follow" });
  if (!response.ok) throw new Error(`${withBuster} → HTTP ${response.status}`);
  return response.text();
}

/** 本地 dist 的构建身份(**构建产物**,可能不存在 → 返回 null,不算失败)。
 *  ⚠ 同时返回 `sha`:dist 里的 `version.json` 说明这份产物**属于哪一笔提交** ——
 *  在多会话共用工作区里,本地 dist 常常是**别人的**构建,拿它比 hash 会得出误导性结论
 *  (实测踩到:自己的提交明明已上线,却因本地 dist 是对方那一版而判「未核实」)。 */
async function localBuild() {
  try {
    const { readFile } = await import("node:fs/promises");
    const [html, version] = await Promise.all([
      readFile(new URL("../apps/web/dist/index.html", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/dist/version.json", import.meta.url), "utf8").catch(() => ""),
    ]);
    return { hash: mainAssetOf(html)?.hash ?? null, sha: versionShaOf(version) };
  } catch {
    return null;
  }
}

/** 本地 dist 的 hash 能否当判据 —— 前提是它**属于**期望的这笔提交。
 *  没有期望 sha(没传 --sha)→ 无从谈起,采用;dist 没带 sha(引入 version.json 之前构建的)
 *  → 无从判断归属,采用;两者都有且不等 → 是**别人的**产物,不采用。 */
export function localBelongsTo(local, wantSha) {
  if (local === null) return false;
  if (!wantSha || local.sha === null) return true;
  return local.sha === wantSha;
}

/** 跑一次核对。返回退出码(0 通过 / 1 判据失败 / 2 参数或网络问题)。 */
async function main(argv) {
  const { url, wanted, expectedHash, expectedSha, negatives, help } = parseArgs(argv);
  if (help) {
    console.log("用法:node scripts/verify-deploy.mjs --sha <sha|HEAD> [--new <字符串> …] [--hash <入口 hash>]");
    console.log("                                  [--negative <字符串> …] [--url <站点>] [--self-test]");
    return 0;
  }
  // 三条判据至少要给一条 —— 一条都不给就是「什么都没核对」,不能算通过。
  if (!wanted.length && !expectedHash && !expectedSha) {
    console.error("verify-deploy:至少要给一条判据 ——");
    console.error("  改了应用产物:--sha HEAD --new <本轮新增的字符串>");
    console.error("  纯文档 / 工具链:--sha HEAD");
    return 2;
  }
  // `--sha HEAD` 由脚本自己解析,免得每次调用都写 $(git rev-parse HEAD)。
  let wantSha = expectedSha;
  if (wantSha === "HEAD") {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    if (result.status !== 0) {
      console.error("verify-deploy:--sha HEAD 需要 git;也可以直接传具体 sha");
      return 2;
    }
    wantSha = result.stdout.trim();
  }

  const failures = [];
  const notes = [];
  let liveHash = "?";
  let liveSha = null;
  let newHits = 0;
  let negMisses = 0;
  // 随机阴性对照:证明「检索本身能区分有 / 无」,而不是永远回「有」。
  const controls = [...negatives, `__biff_absent_${Math.random().toString(36).slice(2)}__`];

  // 本地 dist 是**构建产物**,可能不存在(localBuild 自己吞掉异常)。它同时带构建身份 ——
  // ⚠ 多会话共用工作区里本地 dist 常常是**别人的**构建:拿它的 hash 当判据,会把
  // 「自己的提交明明已上线」判成「未核实」(实测踩到)。只有它确实属于期望的这笔提交才采用。
  // local.sha 为 null 说明那份 dist 是引入 version.json 之前构建的 —— 无从判断归属,仍采用。
  const local = await localBuild();
  const useLocal = localBelongsTo(local, wantSha);
  if (local !== null && !useLocal) {
    notes.push(`本地 dist 属于 ${local.sha}(≠ 期望 ${wantSha}),不参与 hash 比对(可能是并行会话的产物)`);
  }
  const expected = expectedHash ?? (useLocal ? local.hash : null);
  const hashSource = expectedHash ? "--hash" : expected ? "本地 dist" : null;

  try {
    const asset = mainAssetOf(await fetchText(`${url}/`));
    if (!asset) {
      console.error(`verify-deploy:拿到的 HTML 里没有 /assets/main-<hash>.js —— 响应可能不是站点首页(${url})`);
      return 2;
    }
    liveHash = asset.hash;

    if (expected && expected !== liveHash) {
      failures.push(`asset hash 不一致:线上 main-${liveHash} ≠ 期望 main-${expected}(线上跑的不是这份产物)`);
    }

    // 判据 1:构建 SHA。**显式要了就得有** —— 拿不到 version.json 一律算失败,
    // 不允许退回「跳过」:那正是「构建失败没发布」与「构建成功产物相同」不可区分的原点。
    if (wantSha) {
      liveSha = versionShaOf(await fetchText(`${url}/version.json`).catch(() => ""));
      if (!liveSha) {
        failures.push(`拿不到线上 /version.json 的 sha(该版本可能是引入构建 SHA 之前部署的)`);
      } else if (liveSha !== wantSha) {
        failures.push(`构建 SHA 不一致:线上 ${liveSha} ≠ 期望 ${wantSha}(线上跑的不是这次提交)`);
        // 实测踩过:多会话共用工作区时 `--sha HEAD` 会被**别人的提交**带走,于是「明明上线了」却一直判失败。
        if (expectedSha === "HEAD") {
          failures.push("⚠ --sha HEAD 用的是**当前**工作区的 HEAD —— 多会话共用时请钉死你 push 的那笔 sha(见 §2.5)");
        }
      }
    }

    const bundle = await fetchText(`${url}${asset.path}`);
    if (!bundle) failures.push("入口 bundle 为空(检索无法成立,后面的断言全部无效)");
    for (const needle of wanted) {
      if (bundle.includes(needle)) newHits += 1;
      else failures.push(`新字符串未命中:「${needle}」`);
    }
    for (const needle of controls) {
      if (bundle.includes(needle)) failures.push(`阴性对照意外命中:「${needle}」`);
      else negMisses += 1;
    }
  } catch (error) {
    console.error(`verify-deploy:拿不到线上内容 —— ${error.message}`);
    return 2;
  }

  // 显式给了 --hash 就用它;否则退回本地 dist(它不在版本库里,没有 / 不归属本人就跳过比对)。
  const hashNote = expected
    ? `线上 asset main-${liveHash} / 期望 main-${expected}（${hashSource}）`
    : `线上 asset main-${liveHash}（未给 --hash 且没有可用的本地 dist,跳过 hash 比对）`;
  // 没有正向内容对照时**显式**标注,不静默降级 —— 静默降级正是本文件要防的东西。
  const shaNote = wantSha ? `构建 SHA ${liveSha ?? "未取到"} / 期望 ${wantSha}` : null;
  const newNote = wanted.length ? `新字符串 ${newHits}/${wanted.length} 命中` : "未给 --new(本轮无应用产物改动)";
  const negNote = `阴性对照 ${negMisses}/${controls.length} 未命中`;
  const summary = [hashNote, shaNote, newNote, negNote].filter(Boolean).join(" · ");

  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure}`);
  }
  // 注释(非失败)一律打出来:它们解释「为什么某条判据缺席」,静默省略就等于没说。
  for (const note of notes) console.error(`  · ${note}`);
  if (failures.length) {
    console.error(`verify-deploy:✗ 上线未核实 —— ${summary}`);
    return 1;
  }
  console.log(`verify-deploy:✓ 上线已核实 —— ${summary}`);
  return 0;
}

/** 自检:对纯函数各断言一次 —— 不联网,证明「解析与提取」这一层没坏。
 *  为什么需要:上一版正是在这一层栽的(`--hash` 因调用处漏参而静默失效),
 *  而它失败起来**看起来像通过**(退回本地 dist 比对),只有自检能拦住。 */
function selfTest() {
  const cases = [
    {
      name: "取到入口 bundle 的 hash",
      actual: mainAssetOf('<script type="module" src="/assets/main-Dd6_tss4.js"></script>')?.hash,
      expect: "Dd6_tss4",
    },
    { name: "modulepreload 的分包不误判为入口", actual: mainAssetOf('<link href="/assets/react-BR_sSfFm.js">'), expect: null },
    { name: "没有 assets 时返回 null", actual: mainAssetOf("<html></html>"), expect: null },
    { name: "--new 可重复", actual: parseArgs(["--new", "a", "--new", "b"]).wanted.join(","), expect: "a,b" },
    { name: "--hash 取最后一次出现", actual: parseArgs(["--hash", "x", "--hash", "y"]).expectedHash, expect: "y" },
    { name: "--url 去掉尾斜杠", actual: parseArgs(["--url", "https://e.co/"]).url, expect: "https://e.co" },
    { name: "缺 --url 时用默认站点", actual: parseArgs(["--new", "a"]).url, expect: DEFAULT_URL },
    { name: "--new 后面紧跟开关时不吞它", actual: parseArgs(["--new", "--hash", "z"]).wanted.length, expect: 0 },
    { name: "上一条同时保住 --hash 的取值", actual: parseArgs(["--new", "--hash", "z"]).expectedHash, expect: "z" },
    { name: "hash-only 模式下 wanted 为空", actual: parseArgs(["--hash", "abc"]).wanted.length, expect: 0 },
    { name: "--sha 取值", actual: parseArgs(["--sha", "HEAD"]).expectedSha, expect: "HEAD" },
    { name: "从 version.json 取 sha", actual: versionShaOf('{"sha":"abc123"}'), expect: "abc123" },
    { name: "拿不到 version.json(回落成 index.html)时返回 null", actual: versionShaOf("<!doctype html>"), expect: null },
    { name: "version.json 没有 sha 字段时返回 null", actual: versionShaOf('{"branch":"main"}'), expect: null },
    // 本地 dist 归属(回归:共用工作区里 dist 常是**别人**的构建,拿它比 hash 会误判「未核实」)。
    { name: "没有本地 dist 时不采用", actual: localBelongsTo(null, "aaa"), expect: false },
    { name: "没给 --sha 时采用本地 dist", actual: localBelongsTo({ hash: "h", sha: "aaa" }, null), expect: true },
    { name: "dist 没带 sha(旧产物)时采用", actual: localBelongsTo({ hash: "h", sha: null }, "aaa"), expect: true },
    { name: "dist 属于期望的这笔提交时采用", actual: localBelongsTo({ hash: "h", sha: "aaa" }, "aaa"), expect: true },
    { name: "dist 属于别人的提交时不采用", actual: localBelongsTo({ hash: "h", sha: "bbb" }, "aaa"), expect: false },
  ];
  let failed = 0;
  for (const { name, actual, expect } of cases) {
    const ok = actual === expect;
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${name}（期望 ${expect},实际 ${actual}）`);
  }
  console.log(failed === 0 ? `verify-deploy --self-test:${cases.length}/${cases.length} 通过` : `verify-deploy --self-test:${failed} 项失败`);
  return failed === 0 ? 0 : 1;
}

process.exit(process.argv.includes("--self-test") ? selfTest() : await main(process.argv.slice(2)));
