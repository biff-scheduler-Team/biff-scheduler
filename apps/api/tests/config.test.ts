import { describe, expect, it } from "vitest";
import { configuration } from "../src/config";

// `configuration()` 是 `apps/api` 的**入口闸门**:`/api/*` 上每个请求都先拿它校验 host 与 Origin,
// 不通过直接 403(见 `src/index.ts` 的 INVALID_HOST / FORBIDDEN_ORIGIN)。它此前没有任何单测。
//
// 2026-09-13 补,见 PLAN-20260913201727。

type ConfigInput = Parameters<typeof configuration>[0];

/** 造一份最小可用配置;`overrides` 用来把单个字段推到非法值。 */
function env(overrides: Record<string, unknown> = {}): ConfigInput {
  return {
    APP_ENV: "production",
    APP_ORIGIN: "https://biff.lcandy.co",
    IFFDAY_ORIGIN: "https://account.iff.day",
    OIDC_CLIENT_ID: "biff-scheduler",
    OIDC_CLIENT_SECRET: "s".repeat(32),
    SESSION_SECRET: "t".repeat(32),
    ...overrides,
  } as unknown as ConfigInput;
}

describe("configuration:APP_ORIGIN 解析", () => {
  it("单个域名 → origins 单元素,且保留原始字段", () => {
    const config = configuration(env());
    expect(config.origins).toEqual(["https://biff.lcandy.co"]);
    expect(config.OIDC_CLIENT_ID).toBe("biff-scheduler");
  });

  it("逗号分隔支持多域名,顺带 trim 并丢掉空项", () => {
    const config = configuration(env({ APP_ORIGIN: "https://a.example, https://b.example ," }));
    expect(config.origins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("★ 全空(只有逗号 / 空白)→ 抛 Missing configured origin", () => {
    // 否则 origins 会是空数组,后面每个请求都 403 而看不出原因
    expect(() => configuration(env({ APP_ORIGIN: " , " }))).toThrow("Missing configured origin");
  });
});

describe("configuration:origin 形态校验", () => {
  it("尾斜杠不是合法 origin → 抛 Invalid configured origin", () => {
    // `new URL("https://x/").origin` 会归一成 "https://x",与字面值不等 —— 配置必须写归一后的形态
    expect(() => configuration(env({ APP_ORIGIN: "https://biff.lcandy.co/" }))).toThrow(
      "Invalid configured origin",
    );
  });

  it("带 userinfo 的 origin 拒绝", () => {
    expect(() => configuration(env({ APP_ORIGIN: "https://user@biff.lcandy.co" }))).toThrow(
      "Invalid configured origin",
    );
  });

  it("非 URL 字符串被 zod 拦下", () => {
    expect(() => configuration(env({ IFFDAY_ORIGIN: "account.iff.day" }))).toThrow();
  });
});

describe("configuration:环境相关的协议 / 主机校验", () => {
  it("production 只接受 https", () => {
    expect(() => configuration(env({ APP_ORIGIN: "http://biff.lcandy.co" }))).toThrow(
      "Invalid origin environment",
    );
  });

  it("local 只接受 localhost / 127.0.0.1", () => {
    expect(() => configuration(env({ APP_ENV: "local", APP_ORIGIN: "https://biff.lcandy.co" }))).toThrow(
      "Invalid origin environment",
    );
  });

  it("local 全 localhost 时通过", () => {
    const config = configuration(
      env({
        APP_ENV: "local",
        APP_ORIGIN: "http://localhost:31028",
        IFFDAY_ORIGIN: "http://127.0.0.1:31028",
      }),
    );
    expect(config.origins).toEqual(["http://localhost:31028"]);
  });

  it("⚠ 当前实际行为:local 下 IFFDAY_ORIGIN 也必须是 localhost", () => {
    // 校验把 APP_ORIGIN 与 IFFDAY_ORIGIN 放进同一个循环 —— 所以本地跑不了远程账号中心。
    // 这正是 `scripts/dev-account.mjs` 存在的理由(本地起一个账号服务)。
    expect(() =>
      configuration(env({ APP_ENV: "local", APP_ORIGIN: "http://localhost:31028" })),
    ).toThrow("Invalid origin environment");
  });
});

describe("configuration:必填项", () => {
  it("OIDC_CLIENT_SECRET 少于 32 字符被 zod 拦下", () => {
    expect(() => configuration(env({ OIDC_CLIENT_SECRET: "short" }))).toThrow();
  });

  it("SESSION_SECRET 少于 32 字符被 zod 拦下", () => {
    expect(() => configuration(env({ SESSION_SECRET: "short" }))).toThrow();
  });

  it("APP_ENV 只认 local / production", () => {
    expect(() => configuration(env({ APP_ENV: "staging" }))).toThrow();
  });
});
