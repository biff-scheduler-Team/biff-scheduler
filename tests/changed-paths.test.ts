// 回归：gate 判断「这次改动有没有可能影响 UI」时，必须看**整批 push**，而不是最后一笔。
// 修复前 workflow 里内联的是 `git diff --name-only HEAD^ HEAD` —— 多笔一起推时前面那些提交
// 全看不见。2026-10-16 实测：那批 push 里有 5 个 e2e spec 文件（含 helpers.ts），
// 而 main 上 E2E job 显示 `-`（未启动），**等于改了没验** —— 与本轮修的另两个变体是同一个病。
// 就为了能写这条测试，才把这段 shell 从 ci.yml 里抽成 scripts/changed-paths.mjs。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = resolve("scripts/changed-paths.mjs");
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一个自包含的小仓库：三笔提交分别只动 a.ts / b.ts / c.ts（不依赖宿主仓库的克隆深度）。 */
function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "biff-changed-"));
  directories.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const shas: string[] = [];
  for (const name of ["a.ts", "b.ts", "c.ts"]) {
    writeFileSync(join(cwd, name), name);
    git("add", "-A");
    git("commit", "-qm", name);
    shas.push(git("rev-parse", "HEAD").trim());
  }
  return { cwd, shas };
}

function pathsFor(cwd: string, before: string) {
  const result = spawnSync(process.execPath, [script, before], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

it("按整批 push 算改动面，而不是只看最后一笔", () => {
  const { cwd, shas } = makeRepo();
  // before = 第一笔 → 后两笔都算进来；只认 HEAD^ 的写法在这里只会剩 ["c.ts"]。
  expect(pathsFor(cwd, shas[0])).toEqual(["b.ts", "c.ts"]);
});

it("拿不到基线时退化成「全都改了」（宁多跑不漏跑）", () => {
  const { cwd } = makeRepo();
  for (const before of ["", "0".repeat(40), "deadbeef".repeat(5)]) {
    expect(pathsFor(cwd, before)).toEqual(["apps/", "packages/", "e2e/"]);
  }
});

it("before 就是 HEAD 时没有改动", () => {
  const { cwd, shas } = makeRepo();
  expect(pathsFor(cwd, shas[2])).toEqual([]);
});
