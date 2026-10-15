// 部署核对:一条命令替代 §6 里那套「人工三步」(2026-10-16)。
//
// 为什么要有它:§6 的交付判据是「asset hash 相同(不是内容 grep)+ 自己新增的字符串 + 一组阴性对照」,
// 但此前这三步全靠人记、人敲 curl —— 每次发布重复三遍,还留不下证据(报告里只能写「我看过了」)。
// 本脚本把它变成**一条命令 + 一行可粘贴的结论**。
//
// 判据强度(从强到弱,顺序就是脚本的执行顺序):
//   1. **asset hash 相同** —— 最强。hash 变了说明线上跑的不是你这份产物,后面两条都不用看。
//   2. **本轮新增的字符串命中** —— 证明「确实是新版」,不是恰好 hash 撞上。
//   3. **阴性对照未命中** —— 证明上面那次「命中」不是因为检索本身失灵(总是返回「有」)。
//      默认自动加一条随机串;本轮**删掉**的字符串用 `--negative` 显式传进来更有意义。
//
// ⚠ 缓存:全部请求带 cache-buster(`?cb=<时间戳>`),否则拿到的可能是 CDN 上的旧响应。
// ⚠ 本脚本只读线上,不部署、不写文件。
//
// 用法:
//   node scripts/verify-deploy.mjs --new "<本轮新增的字符串>"
//   node scripts/verify-deploy.mjs --new "<新字符串>" --negative "<本轮删掉的字符串>" --hash <本地 hash>
//   npm run verify:deploy -- --new "<新字符串>"
//   node scripts/verify-deploy.mjs --hash <入口 hash>   # 纯文档 / 工具链改动:没有新字符串,只比 hash
//   node scripts/verify-deploy.mjs --self-test          # 自检:纯函数,不联网
//
// 退出码:0 = 全部判据通过;1 = 有判据失败;2 = 参数/网络问题(拿不到页面)。

const DEFAULT_URL = "https://biff.lcandy.co";

/** 从 HTML 里取入口 bundle 的 hash(`/assets/main-<hash>.js`)。取不到返回 null。
 *  ⚠ 只认 `main-*`:`modulepreload` 里的 `react-*` / `spectrum-*` 是分包,拿它们比 hash 会永远不等。 */
export function mainAssetOf(html) {
  const match = html.match(/\/assets\/main-([A-Za-z0-9_-]+)\.js/);
  return match ? { hash: match[1], path: `/assets/main-${match[1]}.js` } : null;
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

/** 本地 dist 里的入口 hash(**构建产物**,可能不存在 —— 不存在就跳过对比,不当失败)。 */
async function localHash() {
  try {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(new URL("../apps/web/dist/index.html", import.meta.url), "utf8");
    return mainAssetOf(html)?.hash ?? null;
  } catch {
    return null;
  }
}

/** 跑一次核对。返回退出码(0 通过 / 1 判据失败 / 2 参数或网络问题)。 */
async function main(argv) {
  const { url, wanted, expectedHash, negatives, help } = parseArgs(argv);
  if (help) {
    console.log("用法:node scripts/verify-deploy.mjs --new <字符串> [--new …] [--negative <字符串>]");
    console.log("                                  [--hash <入口 hash>] [--url <站点>] [--self-test]");
    return 0;
  }
  // 两条判据至少要有一条:有 --new 走完整档;本轮没碰应用产物(纯文档 / 工具链)时只剩 hash 判据。
  if (!wanted.length && !expectedHash) {
    console.error("verify-deploy:至少要给一条判据 ——");
    console.error("  改了应用产物:--new <本轮新增的字符串>;纯文档 / 工具链:--hash <入口 hash>");
    return 2;
  }

  const failures = [];
  let liveHash = "?";
  let local = null;
  let newHits = 0;
  let negMisses = 0;
  // 随机阴性对照:证明「检索本身能区分有 / 无」,而不是永远回「有」。
  const controls = [...negatives, `__biff_absent_${Math.random().toString(36).slice(2)}__`];

  try {
    const asset = mainAssetOf(await fetchText(`${url}/`));
    if (!asset) {
      console.error(`verify-deploy:拿到的 HTML 里没有 /assets/main-<hash>.js —— 响应可能不是站点首页(${url})`);
      return 2;
    }
    liveHash = asset.hash;
    local = await localHash();

    const expected = expectedHash ?? local;
    if (expected && expected !== liveHash) {
      failures.push(`asset hash 不一致:线上 main-${liveHash} ≠ 期望 main-${expected}(线上跑的不是这份产物)`);
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

  // 显式给了 --hash 就用它;否则退回本地 dist(它不在版本库里,没有就跳过比对)。
  const expected = expectedHash ?? local;
  const hashNote = expected
    ? `线上 asset main-${liveHash} / 期望 main-${expected}（${expectedHash ? "--hash" : "本地 dist"}）`
    : `线上 asset main-${liveHash}（未给 --hash 且没有本地 dist,跳过 hash 比对）`;
  // hash-only 模式下**显式**标注「没有正向内容对照」,不静默降级 —— 静默降级正是本文件要防的东西。
  const newNote = wanted.length
    ? `新字符串 ${newHits}/${wanted.length} 命中`
    : "未给 --new(本轮无应用产物改动,只有 hash 判据)";
  const summary = `${hashNote} · ${newNote} · 阴性对照 ${negMisses}/${controls.length} 未命中`;

  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure}`);
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
