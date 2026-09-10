---
name: tailwind-v4-built-css-verify
description: >
  Verify that Tailwind v4 utility classes you just wrote actually landed in the BUILT CSS, without opening a
  browser. Use after editing UI code in any project using @tailwindcss/postcss or @tailwindcss/vite, whenever
  you must prove a class exists: arbitrary values (w-[10px], grid-cols-[repeat(3,1fr)]), custom `@utility`
  definitions, opacity modifiers on `@theme` colors (text-brand/55), or classes added from JS at runtime.
  Also covers why a class silently produces nothing (dynamic string concatenation, unescaped calc()).
  Typical trigger: "改完样式了,怎么确认真的生效" / "构建产物里有没有这个类" / "类名看起来没生成".
description_zh: 核对 Tailwind v4 类是否真的进了构建产物
description_en: Verify Tailwind v4 classes in built CSS
disable: false
agent_created: true
---

# tailwind-v4-built-css-verify

## When to use

You just changed Tailwind classes (or added an `@utility`) and need **evidence** the class is in the built CSS —
typically because you cannot take a screenshot (headless/no browser) or the user asked you not to spin up a dev
server. Works for both `@tailwindcss/postcss` (Vite `css.postcss.plugins`) and `@tailwindcss/vite`.

Do NOT rely on "the build succeeded" — a build succeeds even when the class was never generated.

## Steps

1. Build so the CSS is emitted:
   ```bash
   npm run build      # or: npx vite build / npx tailwindcss -i src/style.css -o dist/out.css
   ```
   Find the artifact (hash changes only when the class *set* changes — useful signal):
   ```bash
   ls -la dist/assets/*.css
   ```
2. Count occurrences with a script, **not** a naive `grep` (see Pitfalls #1):
   ```bash
   python3 - <<'PY'
   import glob, re
   css = open(sorted(glob.glob('dist/assets/*.css'))[-1], encoding='utf-8').read()
   # NOTE: the pattern needs a literal backslash before [ and / because the class name in CSS is escaped
   for pat in ['rounded-\\[9px\\]', 'text-on-brand\\/55', 'border-white\\/20', 'tip-card', 'shrink-0']:
       print(f'{pat:24} {css.count(pat)}')
   # print the whole rule, not just the count, for the ones that matter
   for pat in [r'\.tip-card\{[^}]*\}', r'\.text-on-brand\\/55\{[^}]*\}']:
       for m in re.finditer(pat, css):
           print(m.group(0))
   PY
   ```
3. For an `@utility` you defined yourself, assert the **rule body** is what you intended, e.g.
   `.tip-card{max-width:min(320px,100vw - 24px)}` — not just that the name appears.
4. For a class applied from JS at runtime, also confirm the literal exists in the **JS bundle** (Tailwind scans
   source text; the class must appear verbatim somewhere in the scanned files):
   ```bash
   grep -c 'tip-card' dist/assets/*.js
   ```
5. If serving remotely (Cloudflare Pages etc.), re-check against the live asset URL to prove the deploy carries it:
   ```bash
   curl -sL https://<site>/ -o /tmp/live.html && grep -o 'assets/index-[A-Za-z0-9_-]*\.css' /tmp/live.html
   curl -sL https://<site>/assets/index-XXXX.css | grep -c 'tip-card'
   ```

## Pitfalls

1. **`grep` gives false negatives on arbitrary values.** In CSS the class is written escaped — `.rounded-\[9px\]`,
   `.gap-\[4px\]`. A BRE pattern `rounded-\[9px\]` matches a bare `[`, so it returns **0** and looks like "the class
   was never generated". Always include the literal backslash in the pattern (`rounded-\\[9px\\]` in shell/python
   string terms) or search only the unescaped stem (`rounded-` + eyeball).
2. **Opacity modifier on an `@theme` color emits TWO rules — the first one looks wrong.**
   `text-on-brand/55` produces a plain fallback `.text-on-brand\/55{color:var(--color-on-brand)}` AND, inside an
   `@supports (color:color-mix(in lab, red, red))` block, the real
   `{color:color-mix(in oklab,var(--color-on-brand) 55%,transparent)}`. Seeing only the fallback is not a failure.
3. **Tailwind v4 only generates classes that appear as complete literals in scanned source.** `bg-${p}` /
   `"text-" + size` produce nothing. Write a lookup map of full class strings, or add a safelist comment.
4. **Arbitrary values cannot contain raw spaces.** `calc(100vw - 24px)` must be written `calc(100vw_-_24px)`.
   When the value is a `min()`/`calc()` combination, prefer defining it in CSS:
   ```css
   @utility tip-card { max-width: min(320px, calc(100vw - 24px)); }
   ```
   Then use the bare class name — readable, no escaping, one source of truth.
5. **`@utility` is a single-class selector (0,1,0).** Tailwind's own `hover:` variants compile to `.hover\:x:hover`
   (0,2,0), so a state class applied by JS will LOSE to an element's own `hover:` utility on the same property.
   Declare `!important` on the affected property in the `@utility` body (this project did exactly that for
   `hl-card` / `hl-row` / `slot-hit`).
6. **CSS hash unchanged ≠ build didn't run.** A pure copy/text change does not alter the Tailwind class set, so the
   CSS hash stays and only the JS hash moves. Conversely a changed CSS hash proves the class set did change.

## Verification

- Every class you added reports ≥1 occurrence **and** the printed rule body matches intent.
- The JS bundle contains the literal class string for anything applied at runtime.
- After deploy, the live HTML references the new asset hash and the live CSS contains the rule.
