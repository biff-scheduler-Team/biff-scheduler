# 项目能力（Skills）

本目录把 biff-scheduler 的**数据管线、部署、验收、协作**能力固化进仓库，随代码一起版本化。
每份 skill = 一个目录 + `SKILL.md`（可选 `scripts/`），内容回答三件事：**什么时候用、怎么做、踩过哪些坑**。

## 能力清单

| Skill | 用途 | 何时触发 |
|---|---|---|
| [`biff-catalogue-pdf-to-schedule`](./biff-catalogue-pdf-to-schedule/SKILL.md) | BIFF 官方 Ticket Catalogue PDF → `schedule.json` / `venues.json` / `films.json` | 换届、更新排期、导入影片目录、片单与排期对不上 |
| [`cloudflare-pages-d1-deploy`](./cloudflare-pages-d1-deploy/SKILL.md) | Cloudflare Pages + D1 + Pages Functions 全栈部署（非交互 / agent 模式） | 首次建站、`npm run deploy` 异常、D1 迁移 |
| [`parallel-agent-safe-commit`](./parallel-agent-safe-commit/SKILL.md) | 多会话并行编辑同一工作区时，**只提交自己的改动** | 提交前发现工作区有他人在途改动、构建被他人 WIP 弄坏 |
| [`web-ui-headless-interaction-qa`](./web-ui-headless-interaction-qa/SKILL.md) | playwright-core 无头交互验收（DOM 断言，非 canvas） | 改完交互要证据、部署后验证线上行为 |
| [`tailwind-v4-built-css-verify`](./tailwind-v4-built-css-verify/SKILL.md) | 核对 Tailwind v4 类是否真的进了构建产物 | 改完样式确认类名是否生效 |

## 怎么用

- **人**：直接打开对应 `SKILL.md` —— 里面有完整步骤、可复制的 CLI 命令与陷阱清单。
- **AI 助手**：把 `skills/<name>/SKILL.md` 作为上下文交给它，或依据 frontmatter 的 `description` 触发。
- **本机自动加载**：IDE 的 skill 自动加载只认用户级目录（本机为 `~/.workbuddy/skills/`）。
  本目录是**权威副本**；若要 IDE 自动触发，把改动同步到用户级目录即可（内容一致，仅路径表述可能不同）。

## 约定

- 一份 skill 一个目录，入口固定为 `SKILL.md`（YAML frontmatter 至少含 `name` + `description`）。
- 可执行脚本放 `scripts/`，参考资料放 `references/`，模板 / 素材放 `assets/`。
- **不写机器专属绝对路径** —— 用 `$HOME` / 环境变量 / 仓库相对路径，保证 clone 即用。
- 新增能力时，同步更新本索引与根 `README.md` 的「项目能力（Skills）」章节。
