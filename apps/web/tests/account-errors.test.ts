import { describe, expect, it } from "vitest";
import { loginFailureCodeSchema } from "@biff/contracts/account";
import {
  LOGIN_FAILURE_REASONS,
  loginFailureMessage,
  loginFailureReason,
} from "../src/account-errors";

// 「点登录 → 跳回首页提示登录未完成」这句提示以前**不含任何原因**:服务端把 7 条失败路径压成一个
// 桶、前端又把 `account_error` 的具体值丢掉(见 PLAN-20260916215100)。这里守两件事:
//   1. 契约里每一个失败码都必须有中文文案(漏写 = 用户又看到一句没有信息量的话);
//   2. 未知码必须把**原始码留在文案里**,用户才能把它发给我们。

describe("登录失败原因文案", () => {
  it("契约里每个码都有中文文案,且没有多余的键", () => {
    for (const code of loginFailureCodeSchema.options)
      expect(LOGIN_FAILURE_REASONS[code], code).toBeTruthy();
    expect(Object.keys(LOGIN_FAILURE_REASONS).sort()).toEqual(
      [...loginFailureCodeSchema.options].sort(),
    );
  });

  it("旧版服务端的 expired 仍有像样的中文(老书签 / 缓存页面还会带着它)", () => {
    expect(loginFailureReason("expired")).toBe(
      "登录临时凭证已失效（在账号页面停留过久，或重复发起了登录）。请重新登录。",
    );
  });

  it("未知码保留原始码 —— 回归「病因被整个丢掉」", () => {
    expect(loginFailureReason("some_brand_new_code")).toContain("some_brand_new_code");
    expect(loginFailureMessage("some_brand_new_code")).toContain("some_brand_new_code");
  });

  it("toast 整句既说清原因,也保留「本机排片没有改动」这句承诺", () => {
    const message = loginFailureMessage("token_rejected");
    expect(message).toContain("本机排片没有改动");
    expect(message).toContain("账号系统拒绝发放登录凭证");
  });

  it("连码都没有时也要给出一句完整的话,而不是空串", () => {
    expect(loginFailureReason(null)).toBe("登录没有完成。请重试。");
    expect(loginFailureReason(undefined)).toBe("登录没有完成。请重试。");
  });
});
