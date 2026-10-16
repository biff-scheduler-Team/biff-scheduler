// 回归：只改 e2e spec 自身的提交，CI 必须把那个 spec 跑一遍（2026-10-16）。
// 修复前 `affected-specs.mjs` 只认 `test-map.json` 里的 `apps/` 路径规则，
// 「改 spec」的提交在 PR 上只跑 `always`（smoke）—— 于是 **绿灯是空的**：
// 实测 run 38884776014 只跑了 smoke，而它本该验证的是 parity-library 的改动（§3 先红后绿）。
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

/** 跑一次 CLI 取必跑集 —— 与 CI 同一入口（不走内部函数，免得测成了另一种实现）。 */
function specsFor(...files: string[]) {
  const result = spawnSync(process.execPath, ["scripts/affected-specs.mjs", "--files", ...files], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("e2e/"))
    .map((line) => line.replace(/^e2e\/react\//, "").replace(/\.spec\.ts$/, ""));
}

it("改 e2e spec 自身时，把它自己算进必跑集", () => {
  expect(specsFor("e2e/react/parity-library.spec.ts")).toEqual(["parity-library", "smoke"]);
});

it("改 e2e 的共享件时退化成全量（helpers / fixtures 影响的不止一个 spec）", () => {
  for (const shared of ["e2e/react/helpers.ts", "e2e/react/fixtures/legacy-state.ts.txt"]) {
    const specs = specsFor(shared);
    expect(specs).toContain("legacy");
    expect(specs).toContain("admin");
    expect(specs.length).toBeGreaterThan(20);
  }
});

it("改了没有同名 spec 的 e2e 文件时报警，而不是静默通过", () => {
  const result = spawnSync(process.execPath, ["scripts/affected-specs.mjs", "--files", "e2e/react/nope.spec.ts"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("⚠");
  expect(result.stdout.split("\n").filter((line) => line.startsWith("e2e/"))).toEqual(["e2e/react/smoke.spec.ts"]);
});

it("应用源码的既有映射不受影响", () => {
  expect(specsFor("apps/web/src/pages/LibraryPage.tsx")).toEqual([
    "parity-library",
    "review-library",
    "screening-popover",
    "smoke",
    "want-counts",
  ]);
});
