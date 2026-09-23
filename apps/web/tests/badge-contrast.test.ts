import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 徽标文字对比度(`PLAN-20260923122409`)。
//
// 为什么读 CSS 源码而不是在测试里抄一份色值表:抄一份的话,**改 CSS 不会触发红** ——
// 测试只锁住了它自己。这里从 `src/style.css` 解析出「某个 `data-badge` 实际生效的前景色 /
// 背景色(token 链也一起解析)」,再按 WCAG 2.x 相对亮度算对比度,与浏览器里生效的规则同源。
// (读源码做断言的先例:`tests/legacy-snapshot.test.ts`。)
//
// 已知边界:只做「同优先级声明合并」,不模拟层叠优先级 —— 徽标这组规则全是单类 + 属性选择器,
// 没有 `!important` / `@layer`,故够用。

const CSS = readFileSync("src/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// 12px 粗体**不属于** WCAG 大字号(需 ≥18.66px 粗体 / 24px 常规),阈值就是 4.5:1。
const MIN_TEXT_CONTRAST = 4.5;
// 非文本(这里是 CODE 描边徽章的边框)按 1.4.11 只需 3:1。
const MIN_BORDER_CONTRAST = 3;

type Tokens = Record<string, string>;
type Decls = Record<string, string>;
type Rule = { depth: number; prelude: string; body: string };

/** 找与 openIndex 处 `{` 配对的 `}`(注释已剥掉,不会把注释里的括号算进去)。 */
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error("style.css 里有不配对的 `{`");
}

/**
 * 扫出所有规则。`@media` 这类条件规则会被拆开继续往里走 —— 徽标调色若将来进了媒体查询,
 * 也必须被覆盖到(否则就是「测试看不见的改动」);递归时 `depth` 加一,好让 token 表
 * 只认顶层块(媒体查询里的 `:root` 是断点专属覆盖,不能当基准值)。
 */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (text: string, depth: number): void => {
    let prelude = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === "{") {
        const close = matchingBrace(text, index);
        const body = text.slice(index + 1, close);
        const selector = prelude.trim();
        if (selector.startsWith("@")) {
          walk(body, depth + 1);
        } else {
          rules.push({ depth, prelude: selector, body });
        }
        prelude = "";
        index = close + 1;
        continue;
      }
      if (char === "}" || char === ";") {
        prelude = "";
      } else {
        prelude += char;
      }
      index += 1;
    }
  };
  walk(css, 0);
  return rules;
}

const RULES = parseRules(CSS);

/** 解析声明体里的 `--x: value;`。 */
function tokensOf(body: string): Tokens {
  const out: Tokens = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

/** 解析声明体里的普通属性(`color` / `background` / `border-color` …)。 */
function declarationsOf(body: string): Decls {
  const out: Decls = {};
  for (const [, prop, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    out[prop] = value.trim();
  }
  return out;
}

function merge(...declsList: Decls[]): Decls {
  return Object.assign({}, ...declsList);
}

// 只取**顶层** token 块:媒体查询里的 `:root`(`@media (max-width: 1099px) { :root { --page-gutter } }`)
// 是断点专属覆盖,不能混进基准表。
const lightTokens = tokensOf(RULES.find((rule) => rule.depth === 0 && rule.prelude === ":root")!.body);
const darkTokens = {
  ...lightTokens,
  ...tokensOf(RULES.find((rule) => rule.depth === 0 && rule.prelude === ':root[data-theme="dark"]')!.body),
};

/** 解析 `var(--x)` 链,直到拿到字面量(hex)。 */
function resolve(value: string, tokens: Tokens): string {
  let current = value.trim();
  for (let step = 0; step < 10; step += 1) {
    const reference = /^var\(--([\w-]+)\)$/.exec(current);
    if (!reference) {
      return current;
    }
    const next = tokens[reference[1]];
    if (next === undefined) {
      throw new Error(`未定义的 token:--${reference[1]}`);
    }
    current = next;
  }
  throw new Error(`var() 链过深:${value}`);
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((char) => char + char)
          .join("")
      : raw;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const BASE_SELECTOR = ".film-badge";
const BADGE_SELECTOR = /^\.film-badge\[data-badge="([^"]+)"\]$/;

const baseDecls = merge(
  ...RULES.filter((rule) => rule.depth === 0 && rule.prelude === BASE_SELECTOR).map((rule) =>
    declarationsOf(rule.body),
  ),
);

// 按徽章合并所有命中规则:分组选择器(`A, B, C { … }`)会被拆开分别归属,
// 而「只写了 color 的规则」与「只写了 background 的规则」也会正确拼成一个组合
// —— 这正是 CSS 层叠对同优先级声明的行为。
const badgeDecls = new Map<string, Decls>();
for (const rule of RULES) {
  for (const selector of rule.prelude.split(",").map((part) => part.trim())) {
    const matched = BADGE_SELECTOR.exec(selector);
    if (!matched) {
      continue;
    }
    const [, badge] = matched;
    badgeDecls.set(badge, merge(badgeDecls.get(badge) ?? {}, declarationsOf(rule.body)));
  }
}

/** CODE 是描边款(`background: transparent`),文字落在这些底色上 —— 逐个都要达标。 */
const BACKDROP_TOKENS = ["--page", "--surface", "--raised", "--brand-soft", "--selected", "--conflict", "--tight"];

function casesOf(tokens: Tokens): { badge: string; foreground: string; background: string }[] {
  const cases: { badge: string; foreground: string; background: string }[] = [];
  for (const [badge, decls] of badgeDecls) {
    const foreground = resolve(decls.color ?? baseDecls.color, tokens);
    const background = decls.background ?? baseDecls.background;
    if (background === "transparent") {
      for (const backdrop of BACKDROP_TOKENS) {
        cases.push({ badge, foreground, background: resolve(`var(${backdrop})`, tokens) });
      }
    } else {
      cases.push({ badge, foreground, background: resolve(background, tokens) });
    }
  }
  // 无 `data-badge`(未知分类)走 `.film-badge` 基类的 fallback 底色。
  cases.push({
    badge: "(fallback)",
    foreground: resolve(baseDecls.color, tokens),
    background: resolve(baseDecls.background, tokens),
  });
  return cases;
}

const EXPECTED_BADGES = [
  "code",
  "gv",
  "rating-12",
  "rating-15",
  "rating-19",
  "rating-ALL",
  "subs-KE",
  "subs-KK",
  "subs-KN",
  "subs-NO",
];

describe("徽标规则解析(防空转)", () => {
  it("徽标清单与 CSS 一致", () => {
    expect([...badgeDecls.keys()].sort()).toEqual(EXPECTED_BADGES);
  });

  it("每个徽章都自带 background(否则会静默回落到 fallback 底色)", () => {
    for (const [badge, decls] of badgeDecls) {
      expect(decls.background, `${badge} 缺 background 声明`).toBeDefined();
    }
  });

  it("基类两个 token 都能解析成 hex", () => {
    for (const tokens of [lightTokens, darkTokens]) {
      expect(resolve(baseDecls.background, tokens)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(resolve(baseDecls.color, tokens)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("徽标文字对比度(WCAG 2.2 AA,12px 粗体 ⇒ 4.5:1)", () => {
  for (const [theme, tokens] of [
    ["light", lightTokens],
    ["dark", darkTokens],
  ] as const) {
    for (const { badge, foreground, background } of casesOf(tokens)) {
      it(`${theme} · ${badge} · ${foreground} on ${background}`, () => {
        // 断言用**未取整**的比值:取整后再比会把 4.496 判成达标。
        const ratio = contrast(foreground, background);
        expect(
          ratio,
          `${badge} 在 ${theme} 下 ${foreground} 压 ${background} 只有 ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      });
    }
  }
});

describe("CODE 徽章边框(非文本对比,1.4.11 ⇒ 3:1)", () => {
  const codeBorder = badgeDecls.get("code")!["border-color"];

  for (const [theme, tokens] of [
    ["light", lightTokens],
    ["dark", darkTokens],
  ] as const) {
    for (const backdrop of BACKDROP_TOKENS) {
      it(`${theme} · border on ${backdrop}`, () => {
        const ratio = contrast(resolve(codeBorder, tokens), resolve(`var(${backdrop})`, tokens));
        expect(
          ratio,
          `CODE 边框在 ${theme} 的 ${backdrop} 上只有 ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(MIN_BORDER_CONTRAST);
      });
    }
  }
});
