---
name: web-ui-headless-interaction-qa
description: 用 playwright-core + 本机缓存 chromium 对**已构建的网页前端**(SPA / DOM 交互,非 canvas)做无头交互验收:起本地静态服务 → 脚本化点击/输入/按键 → 断言 DOM 状态(弹层层数、display、按钮文案、列表条数、状态是否保留)。适用于"改完交互但不想开浏览器手点""用户反馈点了没反应/只能关闭不能返回"这类需要**证据**而不是"应该没问题"的场景;也适用于部署后对线上 URL 跑同一份只读断言。触发词:交互验证、无头验收、playwright 点击断言、弹层/列表状态断言、点了没反应、部署后验证交互。
description_zh: 无头交互验收(DOM 断言)
description_en: Headless DOM interaction QA
disable: false
agent_created: true
---

# web-ui-headless-interaction-qa

## When to use
- 改了前端**交互逻辑**(弹层开合 / 返回 / 列表状态保留 / 计数刷新 / 键盘 Esc),想知道"到底对不对",但不想手动开浏览器点。
- 用户报告"点了没反应 / 只能关闭无法返回 / 状态丢了"这类**行为**问题,需要能复现 + 能证明修好了。
- 部署后要对**线上 URL** 跑同一份断言(同一脚本换 `BASE` 即可,注意只读!见 Pitfalls)。

不适用:canvas / 像素画面 → 用 `canvas-game-visual-qa`;纯 CSS 是否生成 → 用 `tailwind-v4-built-css-verify`。

## 环境(本机已验证)
- chromium(playwright 缓存,版本号目录会变,用 `ls` 现查):
  `~/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
- playwright-core:优先用项目自己的 `node_modules`(装过 `playwright-core` 即可);
  WorkBuddy 受管环境在 `~/.workbuddy/binaries/node/workspace/node_modules`(存在就直接用)。
- node:系统 `node` 即可;受管环境在 `~/.workbuddy/binaries/node/versions/*/bin/node`(版本号用 `ls` 现查)。
- 静态服务(对 `dist/` 起):`python3 -m http.server 8971 --bind 127.0.0.1`。

## Steps
1. **先构建**:`npx vite build`(或项目对应的 build)。验收对象是**产物**,不是源码。
2. **起静态服务**:`cd dist && python -m http.server 8971 --bind 127.0.0.1`,**必须 `run_in_background=true`**(普通 `&` 会在该 Bash 命令结束时被回收 → 连接拒绝)。用完 `pkill -f "http.server 8971"`。
   - 前端用**相对路径** fetch 数据(`schedule.json` 等)时,服务的根目录必须是产物根目录,否则数据加载失败 → 页面空 → 断言全挂。
   - `/api/*` 在静态服务下必然 404(没有 Pages Functions),**这不是 bug**;验收时把 404 列表打印出来并确认只有 `/api/*`。
3. **写脚本**(模板见 `scripts/interact-check.mjs`,复制到 /tmp 再改断言)。要点:
   - ESM 里 `NODE_PATH` 不生效 → **必须 `createRequire`** 加载 playwright-core:`createRequire("<node_modules 的父目录>/package.json")`。
     **更省事的等价写法**:脚本存成 `.cjs` 用 CommonJS `require("playwright-core")`,此时 `NODE_PATH=...` 直接生效(实测通过),不必写 `createRequire`。
   - 断言脚本自己也会写错:先分清「脚本 bug」还是「代码 bug」。实测踩坑 —— 先 `keyboard.press("Escape")` 关掉弹层,下一行又去 `click("#modal-root [data-toggle]")` → 30s 超时。**超时/找不到元素时先回看脚本的状态假设**(弹层还在吗?这个入口有 `data-*` 吗?),别急着改产品代码。
   - `page.on("pageerror")` + `page.on("console"|error)` 收集报错;`page.on("response")` 收集 `status >= 400`。
   - 断言尽量用**计数 / 计算样式 / 文案**,不要截图后"看图判断"(当前模型可能读不了图)。
   - 每个断言写进一个 `out{}` 对象最后 `JSON.stringify` 打印 → 一眼看全部结果。
   - 关键 DOM 探针:`page.locator("#modal-root > div").count()`(弹层层数)、`getComputedStyle(o[0]).display`(下层是否被隐藏)、`page.inputValue(...)`(状态是否保留)、`locator(':text-is("返回")')`(文案精确匹配)。
4. **跑**:
   ```bash
   CHROME_PATH="$(ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app/Contents/MacOS/* | head -1)" \
   BASE=http://127.0.0.1:8971 \
   NODE_PATH="${NODE_PATH:-$HOME/.workbuddy/binaries/node/workspace/node_modules}" \
   node /tmp/qa/check.mjs
   ```
5. **读结果**:每条断言是否符合预期 + `errors` 为空 + `http>=400` 只有预期的 `/api/*`。不符合就先定位再改代码,不要"重跑一次看运气"。

## 变体:隐私 / 安全断言(拦截全部请求,证明「密钥不离开浏览器」)

当产品做出**隐私承诺**(「Key 只存本地、不上服务器、不经手」),这类承诺必须是**技术事实**,
不能靠"我读了一遍代码"背书。做法:让无头脚本成为唯一裁判。

1. **拦截全部请求**:`await page.route("**/*", handler)`,handler 里把每条请求记进 `reqs[]`
   (`{url, method, host, hasAuth, bodySnippet}`),再决定放行 / mock / 拦截。
   - 静态资源(`dist/assets/*`)放行 `route.continue()`;本站 `/api/*` 放行(让它 404,属预期)。
2. **mock 第三方主机**(不能打真实服务商,也不要用真实 key):
   ```js
   const LLM_HOST = "llm.qa.test";              // 明确不是真实域名
   const FAKE_KEY = "sk-qaFAKE0000deadbeef0000zz9";
   if (new URL(req.url()).host === LLM_HOST) {
     if (req.method() === "OPTIONS") {          // ★ 跨域 + Authorization 会触发预检
       return route.fulfill({ status: 204, headers: {
         "Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Headers": "Authorization, Content-Type",
         "Access-Control-Allow-Methods": "POST, OPTIONS" } });
     }
     return route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" },
       contentType: "application/json", body: JSON.stringify(MOCK_COMPLETION) });
   }
   ```
   忘了处理 `OPTIONS` → 预检 4xx → 前端 fetch 直接抛网络错,你会误判成"前端代码有 bug"。
3. **断言五条**(缺一不可):
   - 密钥**只**出现在 mock 主机的 `Authorization` header;
   - 本站 / 任何其它主机 / `/api/*` 携带密钥的请求数 **= 0**;
   - 请求 host **等于**用户在 UI 里填的 baseURL(换 baseURL 就换 host → 证明没有硬编码代理兜底);
   - 请求 **body 不含**密钥(密钥只能进 header,不能进 prompt / query);
   - `document.documentElement.outerHTML` 与 `body.innerText` **不含完整密钥**(只出现掩码)。
4. **不要手写掩码期望值**:`maskKey` 是「前 3 位 + `…` + 后 4 位」,我手写成 `sk-…zz9`(漏了一位)导致断言假失败。
   **按实现算**或直接断言「`innerText` 不含完整 key 且含 `…`」。
5. 断言汇总里附上 `reqs` 的 host 计数,让用户能自己看到"只有 mock 主机被访问过"。

## Pitfalls
- **`page.evaluate` 包装函数忘了 `await` → 结果静默变 `{}`**(实测):把探针写成 `function probeDay(page){ return page.evaluate(...) }`(返回 Promise)后,若调用处写 `out.midnightDay = probeDay(page)`(少了 `await`),`JSON.stringify(out)` 会把它序列化成空对象 `{}` —— **不抛错、不超时、日志看着"跑了"**,最容易被读成"页面没渲染出元素"。判据:凡是断言对象里出现整块 `{}`,先回看 `await`。
- **`getComputedStyle` 读到的是「过渡中间值」→ 看着像「JS 打了新类但样式没生效」**(实测,2026-09-10):
  被断言元素带 `transition-[background-color,…] duration-[120ms]` 时,**点击后立刻**读 `backgroundColor`
  拿到的是**变化前**的旧色(过渡 t≈0)。实测症状:分段选择器点击后 `className` 已是 `bg-card`,而
  `getComputedStyle().backgroundColor` 仍是 `rgba(0,0,0,0)` —— 极易误判成产品 bug。
  判据:同一次探针里 **class 变了、计算样式没变** → 就是过渡没走完。
  修法:① 断言优先以 **class token** 为准(`b.classList.contains("bg-card")`);② 或点击后
  `waitForTimeout(250)`(≥ duration)再读计算样式。
- **排版 / 对齐类断言的可自动化探针**(实测好用):① 「标签与控件同排」→ 比 `getBoundingClientRect()`
  的**中心线差**(`items-center` 下应 ≤ 2px),并断言行高 `< 40px`(超过 = 换行);② 「分割线存在」→
  数 `[class~="border-line-soft"]` 且 `getComputedStyle(e).borderTopWidth !== "0px"`(**不能只看类名**:
  带类但被覆盖/宽度 0 的情况会漏判);③ 「A 在 B 下方」→ 比 `top > B.bottom`,比看 DOM 顺序可靠。
- **`CHROME_PATH` 必须 `export`,不能只当命令前缀**:`CHROME_PATH=x && echo $CHROME_PATH` 之后那个变量**只在 shell 里、没有导出**,node 里 `process.env.CHROME_PATH` 是 undefined → playwright 回落到默认 `chromium_headless_shell-*` 路径并报 `Executable doesn't exist at .../headless_shell`(看着像"浏览器没装",其实是环境变量没传)。要么 `export CHROME_PATH=...` 单独一行,要么和 node 写在同一条命令前缀里(`CHROME_PATH=... BASE=... node script`)。
- **条件渲染的控件:断言前先回源码确认渲染条件**(实测):某控件只在特定态下才被 push 进 DOM
  (例如「未配置」态只渲染表单、不渲染运行按钮)→ 断言「态 A 有它」会假失败。
  凡断言某个控件**存在/不存在**,先去源码 grep 它的 push 点看条件,再决定期望值 ——
  否则会把「设计如此」误报成 bug。**判据:同一锚点在别的态下能被找到 → 是条件渲染,不是丢失。**
- **弹层计数要按「层数」断言,不是「关干净」**:Escape 通常**只关栈顶**(本项目 `modal.ts` 的设计)。
  从列表再开出「详情 / 资料弹层」时栈深 2 → 按一次 Escape 后计数应为 **1**,再按一次才 0。
  断言写死 `=== 0` 会假失败。先在脚本里 `console.log(await page.locator("#modal-root > div").count())`
  确认当前栈深,再写期望。
- **首屏竞态**:`waitForSelector(按钮)` 只说明按钮存在,不代表**首屏数据已到**(列表可能还是空的)。
  补一句 `await page.waitForResponse(r => /\/films\.json/.test(r.url())).catch(()=>{})`,
  并给「点不开就重试一次」的循环(`for (let i=0;i<2;i++){ click(); if (await x.isVisible()) break; wait(800) }`)。
  实测线上偶发一次拿不到入口,重试即过 —— 别当成产品 bug。
- **别指望只按一次 `Escape` 就能关净**:无头下 `Escape` 可能被弹层内输入框的焦点吃掉,
  且多弹层叠加时按设计**只关栈顶**。写一个三级兜底 `closeTopModal()`:
  ① `Escape` → ② 点该层 ✕(`[data-close]` / 文案 `✕`) → ③ 点遮罩(层内 `position:{x:6,y:6}`),
  每级之间 `waitForTimeout(200)`,`catch(()=>{})` 吞掉选择器超时,**并循环直到计数为 0 或达上限**。
  再把「能关干净」单独写成一条断言 —— 弹层关不掉会让后面所有断言连带失败,单列一条能立刻定位。
- **别对线上跑会写数据的脚本**:线上是真实后端,点「必看/加入方案/保存」会写用户真实数据。对线上只跑**只读**断言(打开列表 / 开详情 / 返回 / 定位)。写完脚本先自查一遍所有 `click()` 的目标会不会触发写接口。
- **`page.click` 在元素被遮住时超时 30s**:弹层栈里下层是 `display:none`,别去点它;要点"最上面一层"用 `#modal-root > div:last-child ...` 限定。
- **文案选择器要用 `:text-is()`**:`has-text()` 是子串匹配,「返回」会误中「返回上一层」之类;按钮文案含 emoji/空格时优先 `data-*` 属性。
- **列表行可能没有 `data-*` 锚点**:同一项目里不同视图可能一处有 `data-lib-detail`、另一处没有(手工建的元素)。选择器超时先怀疑"这个入口压根没有该属性",用文案选择器兜底。
- **需要"有数据"的前置状态**:比如「我的选片」要先打标才有行。脚本里就把前置操作做全(打标 → 关 → 再进),不要假设本地 localStorage 有东西(每次都是新 context)。
- **状态保留类断言要有对照**:先设一个可观察的状态(搜索词 / 展开行),再进详情再返回,然后断言 `inputValue` 与行数 —— 只断言"弹层还在"证明不了"状态没丢"。
- **本地服务记得收**:`pkill -f "http.server <port>"`;`lsof -nP -iTCP:<port> -sTCP:LISTEN` 复查。

## Verification
- 全部断言与预期一致(把 `out{}` 贴给用户,不要只说"验证通过")。
- `errors` 为空;`http>=400` 只含 `/api/*`(静态服务无 Functions 所致)。
- 对线上跑同一脚本时,断言结果应与本地一致 → 说明线上产物确实是本次构建。
- **线上核对的最强判据 = asset hash 相同,不是内容 grep**(实测):先记下构建日志里的
  `dist/assets/index-<hash>.js`,再
  `curl -sL "https://<域>/?cb=$(date +%s)" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'` ——
  **hash 相同**才能证明线上就是本次构建(多会话并行时,别人的部署会带不同 hash);
  再 `grep -c` 几个**自己新增的字符串**做交叉确认,并**加一组阴性对照**(对方在途改动的标记应为 0,
  证明没搭车)。`curl` **必须带 cache-buster**,不带会拿到边缘缓存里的旧 asset(实测被坑:拿到上一次的 hash)。
- **产物里的字符串可能是模板字面量前缀**:`` `mode-${m}` `` 编译后 bundle 里只有 `mode-`,`grep -c 'mode-local'` 会是 0。
  先在源码里确认是拼接还是字面量,再去 grep 对应前缀,别把 0 读成"没上线"。
