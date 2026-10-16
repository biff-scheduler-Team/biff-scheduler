// 算出「本次 push 改了哪些路径」,供 ci.yml 的 e2e job 判断要不要启动(2026-10-16)。
//
// 为什么不直接写在 workflow 里:内联 shell 没法写回归测试,而这段逻辑恰恰错过一次 ——
// 原来用的是 `git diff --name-only HEAD^ HEAD`,只看**最后一笔**提交。多笔一起推时,
// 前面那些提交的改动全看不见:实测 6 笔一起推,最后一笔是工具链改动(不含 e2e/),
// 于是那批里 5 个 e2e spec 文件在 main 上跑了 0 个 E2E —— 与「只改 spec 没人跑」
// 「改 spec 在 CI 上只跑 smoke」是同一个病:改了没验(§3)。
//
// 用法: node scripts/changed-paths.mjs <before-sha>
//       <before-sha> = GitHub push 事件里的 github.event.before
//                     (新分支首次 push 是全 0;force push 后旧 tip 可能已不在历史里)
// 输出: 改动路径,一行一个(直接拼进 $GITHUB_OUTPUT 的 heredoc);
//       拿不到基线时输出 `apps/` `packages/` `e2e/` —— 当成「全都改了」,宁多跑不漏跑。

import { execFileSync } from "node:child_process";

/** 该对象在本地历史里可见吗 —— 浅克隆 / force push 之后可能查不到。 */
function isKnownCommit(sha) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const before = process.argv[2] ?? "";
const hasBaseline = before !== "" && !/^0+$/.test(before) && isKnownCommit(before);

if (hasBaseline) {
  process.stdout.write(execFileSync("git", ["diff", "--name-only", before, "HEAD"], { encoding: "utf8" }));
} else {
  process.stdout.write("apps/\npackages/\ne2e/\n");
}
