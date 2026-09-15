// 把 scripts/git-hooks/* 装进 .git/hooks(2026-09-13,PLAN-20260913201727)。
//
// 为什么不引 husky / commitlint:本仓库的提交格式是**自定义**的
// (`<type>(<scope>): <中文描述>`,type 白名单固定),自写 30 行零依赖即可,
// 不值得为它引两个依赖 + 一层 `prepare` 生命周期。
//
// ⚠ 本脚本挂在 `package.json` 的 `prepare` 上,会随 `npm ci` 在 **Cloudflare Workers Builds**
//   里一起跑 —— 所以它**任何情况下都不许让构建失败**:没有 .git、写不进去、不是仓库,
//   一律打日志后 exit 0。它是便利设施,不是门禁。
//
// 幂等:每次覆盖写入(改了 scripts/git-hooks/ 里的内容后,重跑一次即可生效)。

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "git-hooks");

/** 本仓库**曾经**托管过的钩子名(加了新的要同步这里)。
 *  ⚠ 从 `scripts/git-hooks/` 删掉一个钩子时,得有人把它从 `.git/hooks/` 也删掉 ——
 *  `copyFileSync` 只覆盖、不清理。否则下线的钩子(如 2026-09-16 删掉的 `pre-push`)
 *  会在每个人的本机继续拦人,而远端看起来「已经删干净了」。 */
const MANAGED = ["commit-msg", "pre-push"];

/** 永不抛错 —— 见文件头的说明。 */
function main() {
  if (!existsSync(source)) {
    console.log("install-git-hooks:找不到 scripts/git-hooks,跳过");
    return 0;
  }
  // 用 git 自己算路径:linked worktree 下 hooks 在主仓库里,不能硬拼 ".git/hooks"
  let hooksDir;
  try {
    hooksDir = resolve(
      execFileSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim(),
    );
  } catch {
    console.log("install-git-hooks:不在 git 仓库里(或没有 git),跳过");
    return 0;
  }
  if (!existsSync(hooksDir)) {
    try {
      mkdirSync(hooksDir, { recursive: true });
    } catch (error) {
      console.log(`install-git-hooks:建不了 ${hooksDir},跳过(${error.message})`);
      return 0;
    }
  }
  const available = readdirSync(source);
  const installed = [];
  for (const name of available) {
    const target = join(hooksDir, name);
    try {
      copyFileSync(join(source, name), target);
      chmodSync(target, 0o755);
      installed.push(name);
    } catch (error) {
      console.log(`install-git-hooks:装 ${name} 失败,跳过(${error.message})`);
    }
  }
  if (installed.length) console.log(`install-git-hooks:已装 ${installed.join(" / ")} → ${hooksDir}`);

  // 下线同步:源目录里已经删掉的托管钩子,从 .git/hooks 一并移除(只碰 MANAGED 里的名字)
  const removed = [];
  for (const name of MANAGED) {
    if (available.includes(name)) continue;
    const target = join(hooksDir, name);
    if (!existsSync(target)) continue;
    try {
      rmSync(target);
      removed.push(name);
    } catch (error) {
      console.log(`install-git-hooks:清 ${name} 失败,跳过(${error.message})`);
    }
  }
  if (removed.length) console.log(`install-git-hooks:已下线 ${removed.join(" / ")}(从 .git/hooks 移除)`);
  return 0;
}

process.exit(main());
