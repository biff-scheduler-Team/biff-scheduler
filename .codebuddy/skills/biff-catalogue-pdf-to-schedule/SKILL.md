---
name: biff-catalogue-pdf-to-schedule
description: 把釜山国际电影节(BIFF)官方 Ticket Catalogue PDF 解析成排期 JSON(schedule.json + venues.json),以及从**影片介绍页**抽出影片目录(films.json)。当用户给来一份 BIFF 排期册/售票册 PDF(如 `2025_BIFF_Ticket_Catalogue_web.pdf`),或要求「读取排片 / 解析排期 / 导入场次 / 把册子变成可排片的 JSON / 导入影片信息 / 片单和排期对不上」时使用。也适用于任何「文字旋转 90°、行=时间段、列=场馆、单元格=独立 span」的竖排表格 PDF。内含 18 条实测版面陷阱、自检指标基线、换年份适配清单(排期线 + 影片目录线),以及可直接运行的 CLI 命令。本 skill 随仓库版本化(`.codebuddy/skills/`),解析器在 `tools/extract_schedule.py`(BIFF 适配层)+ `tools/festival_common.py`(通用底座)。
description_zh: BIFF 排期 + 影片目录 PDF 解析成 JSON
description_en: BIFF catalogue PDF to schedule + film catalog JSON
disable: false
agent_created: true
---

# biff-catalogue-pdf-to-schedule

把 BIFF 官方 Ticket Catalogue PDF → `schedule.json` / `venues.json`,对齐
`biff-scheduler` 仓库 `src/types.ts` 的 `Screening` / `Venue` 契约。

## When to use

- 用户给来一份 BIFF 售票册/排期册 PDF(文件名形如 `20XX_BIFF_Ticket_Catalogue_web.pdf`),
  要求读取排片、解析排期、导入场次。
- 用户说「明天/今年排片出来了,帮我导进去」。
- 更泛化:任何**文字旋转 90° 的竖排表格 PDF**(行=时间段、列=场馆/资源、单元格=独立 span)。

**不适用**:扫描件/图片版 PDF(无文本层,需先 OCR);册子里没有排期网格的纯介绍页。

## 核心事实(先读这三条)

1. **不需要 OCR**。BIFF 册子是 InDesign 导出,字体内嵌带 unicode 映射,文本层完整。
2. **排期表在固定页段**:2025 版 = **p9–p16**(8 页,覆盖 9/17–9/26)。p8 是场馆/缩写图例,
   p1–p7 是前言, p17+ 是影片介绍。换年份先 `--dump-page` 探页段。
3. **单元格归属靠 line 的 `y1`,不靠 y 窗口**。这是唯一最容易写错的地方,见 Pitfalls #7。

## Steps

### 1. 找到脚本(单一来源)

本 skill 随仓库版本化(`<repo>/.codebuddy/skills/biff-catalogue-pdf-to-schedule/`),
解析器就在**同一仓库**里:

| 文件 | 职责 |
|---|---|
| `tools/extract_schedule.py` | **BIFF 适配层** —— 场馆表 / token 正则 / 版面几何 / 午夜联映块 |
| `tools/festival_common.py` | **通用底座** —— 页面拆 line / 几何选择器 / META 扫描 / 自检哨兵 / JSON 写出 |
| `tools/import_schedule_2025.py` | 收尾 —— 泳道重排 + `festival` 元信息 |

```bash
ls -d "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"/tools/extract_schedule.py
```

> **不要**另写一份解析器。2026 适配、新陷阱修复都提交回这个文件。
> 新增其他电影节(如 HKIFF / PYIFF)见本文末尾「新增电影节」一节。

### 2. 准备 Python 环境

依赖只有一个:**PyMuPDF**。优先用本机 `python3`;WorkBuddy 受管 venv 存在时可直接用
(`~/.workbuddy/binaries/python/envs/default/bin/python`,已装 pymupdf)。

```bash
PY="${PYTHON:-python3}"
$PY -c "import pymupdf, sys; print(pymupdf.__version__, sys.executable)"   # 自检:能 import 即可
```

若报 `ModuleNotFoundError`,按隔离规则装(不要污染全局):

```bash
python3 -m venv .venv && .venv/bin/pip install pymupdf
PY=.venv/bin/python
```

**为什么是 PyMuPDF 而不是 pdfplumber / Camelot**:必须拿到 **span 级 bbox**(一个单元格里
每个字段都是独立的一行);Camelot 依赖可见表格线,而本册子单元格靠灰底色块分隔、**没有线**。

### 3. 先探页(换年份必做)

```bash
$PY tools/extract_schedule.py --pdf <PDF> --year 2026 --dump-page 9
```

看输出是不是排期网格(`code` + `start_time` 有值)。若 p9 不是排期页,
用 `--schedule-pages` 指定正确页段。

### 4. 正式解析

```bash
$PY tools/extract_schedule.py \
  --pdf ~/Downloads/2026_BIFF_Ticket_Catalogue_web.pdf \
  --year 2026 --month 9 \
  --out /tmp/biff2026/schedule.json --venues-out /tmp/biff2026/venues.json
```

> **先落 `/tmp`,不要直接写 `public/`** —— 解析产物还要过一遍
> `import_schedule_2025.py`(泳道重排 + festival 元信息)才上线,见 **4b**。
> `data/` 目录放的是别的东西(`films-2026.json` / `enriched_douban.json`),别往那儿写排期。

完整 CLI:

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--pdf` | 必填 | 册子 PDF 路径 |
| `--year` / `--month` | 必填 / `9` | 用于拼 `YYYY-MM-DD` |
| `--schedule-pages` | `9-16` | 排期页段,支持 `9-16` 或 `9,11,13` |
| `--out` / `--venues-out` | `schedule.json` / `venues.json` | 输出路径 |
| `--gv-add-min` | `25` | GV 场次映后谈补时(官方印的 end 一般 = start + 片长) |
| `--dump-page` | — | 只解析单页并打印 JSON,排查用 |
| `--festival-name` | 自动 | 写进 `festival.name` |

### 4b. 两段式落盘:解析 → `import_schedule_2025.py`(**别跳过**)

`extract_schedule.py` 的产物**不是**站点读的那份。真正上线的是
`public/schedule.json` / `public/venues.json`,由 **`tools/import_schedule_2025.py`** 收尾:

```bash
$PY tools/extract_schedule.py --pdf <PDF> --year 2025 --month 9 \
    --out /tmp/biff/schedule.json --venues-out /tmp/biff/venues.json
$PY tools/import_schedule_2025.py \
    --schedule /tmp/biff/schedule.json --venues /tmp/biff/venues.json --dest public
```

它只做两件事,但两件都必要:

1. **泳道重排** —— 解析器按「影院全名字母序」出场馆,直接上线会让电影殿堂的 6 个厅被
   BCM / CGV / LOTTE 插花打散。重排成「分区(centum → nampo)→ 影院 → 厅号」。
   前端 `data.ts::screeningsByVenue()` 按 `venues.json` 的出现顺序分泳道,**顺序即泳道顺序**,
   所以这一步不需要改前端。
2. **`festival` 元信息换成用户可读口径** —— 届次名(`30th Busan International Film Festival`)、
   29 厅 / 7 影院 / 2 分区、X 合成 code 说明、GV +25min 说明、午夜联映块说明。

★ **验收「可复现性」的正确姿势**(换年份必做):解析到 `/tmp`,再用
`import_schedule_2025.py --dest <临时目录>` 收尾,然后和 `public/` 里已提交的那份**逐字段对比**。
2025 实测结论:

- `screenings` **699 条逐字段 100% 一致(0 处差异)** —— 解析器完全可复现。
- 唯一差异就是上面那两项:`festival.name` / `note` / `generated_at` + `venues` 数组顺序。
- ⇒ **差异全在 `import_schedule_2025.py` 的职责范围内 = 没有漏跑、没有手改。**
  若 `screenings` 反而出现差异,先怀疑**并行会话改了 `extract_schedule.py`**(`git status`
  看该文件是否 `M`),不要先怀疑册子变了。

### 5. 读自检输出(这是验收的关键)

脚本往 stderr 打 `[SANITY]` 行。**必须逐条核对**:

- `code 全局唯一 ✓` —— 出现「⚠ code 重复」= 解析坏了,别往下走。
- `每日场次` —— 开幕日应**极少**(2025 = 1 场,只有开幕场),闭幕日也少(2025 = 7 场)。
- `空 title_en` —— 允许有值(纯韩文片名),但 **「全空(中英韩皆空)」必须 = 0**。
- `rating` / `subs` 分布 —— `None` 占比不应异常高(2025: rating None=9/699)。
  `subs` 行还会额外报 **`未标注`** 与 **`多值场次`** 两个数:
  **`多值场次` 必须 > 0 且与册子对得上**(2025 = 4:`028` / `029` / `109` / `268`)。
  若为 0,说明又退化成「只接第一个值」了 —— 见 Pitfall #13。
- `GV 场次` / `tags 分布` —— 与 `--gv-add-min` 逻辑相关。2025 基线:**`GV 347 / 699`**、
  `{opening: 1, closing: 1, midnight: 4, talk: 6, commentary: 3, event: 1}`。
  `opening` / `closing` **必须恰好各 1 条**(全册只有开闭幕式);变多 = 标题/备注关键词误伤。
- `code_synthesized` —— 未印编号的场次数量(2025 = 37,BD/C7 两列 + `X1601`)。
- `dur_missing` —— 册子**没印片长**的特别场(2025 = **1**,只可能是 `002` 闭幕式)。
  **判据是 META 行里有没有 `NN’` token,不是「这场是不是特别场」** —— 同样「看起来特别」的
  `X1601` BAFA 毕展其实印了 `120’`,所以**不算** `dur_missing`。见 Pitfall #19。

### 6. 契约校验(建议每次跑)

```bash
$PY - <<'PY'
import json, re
rows = json.load(open('public/schedule.json'))['screenings']
vids = {v['id'] for v in json.load(open('public/venues.json'))['venues']}
bad = []
for r in rows:
    if r['venue_id'] not in vids: bad.append(('venue', r['code']))
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', r['date']): bad.append(('date', r['code']))
    if not isinstance(r['duration_min'], int) or r['duration_min'] <= 0: bad.append(('dur', r['code']))
    if r['rating'] not in (None,'ALL','12','15','19'): bad.append(('rating', r['code']))
    subs = r['subs']
    if subs is not None:
        if not isinstance(subs, list) or not subs:
            bad.append(('subs-empty', r['code']))       # [] 应写成 null
        elif any(v not in ('KE','KN','KK','NO') for v in subs):
            bad.append(('subs', r['code']))
        elif len(set(subs)) != len(subs):
            bad.append(('subs-dup', r['code']))
    if not r['title_en'] and not r['title_kr']: bad.append(('title', r['code']))
print('契约校验:', '全部通过 ✓' if not bad else bad[:10])
PY
```

### 7. 人工抽检 + 入库

- 抽 9/17(开幕日)、9/26(闭幕日)、任意中间日,和册子原页对一遍。
- `title_zh` 一律为空(册子无中文),由 `tools/build_films.py` + `tools/enrich_douban.py` 链路补。
- 入库走仓库既有链路(`npm run migrate:remote` + `/api/...`),**不要**让脚本直接写 D1。

## 影片目录(films.json)—— 从「影片介绍页」抽

排期落盘后,影片库还需要一份**与排期对得上**的 `public/films.json`(否则 `filmNodeKey`
全走 `sched:` 分支,影片库点开任何片看不到场次)。2026 版目录来自用户提供的 xlsx;
没有 xlsx 的年份只能从册子抽。

解析器唯一实现:**`<repo>/tools/extract_films_2025.py`**(换年份改 `--pdf` / `PAGE_RANGE` /
`SECTIONS` 即可,文件名别跟着改)。

```bash
$PY tools/extract_films_2025.py \
  --pdf ~/Downloads/20XX_BIFF_Ticket_Catalogue_web.pdf \
  --schedule public/schedule.json --out public/films.json [--dry-run]
```

### 核心事实

1. **影片介绍页 = 排期页之后的连续页段**。2025 版 = **PDF p22–p97**(印刷页 42–194)。
   印刷页 → PDF index 的换算是 **`idx = printed // 2`**(每张 PDF 页 = 一个跨页,
   页脚印着两个页码,如 PDF p60 → 印刷页 `118 | 119`)。换年份先用 `--dry-run` 看
   「抽出原始条目」数是否量级正常(2025 = 245),为 0 就是页段错了。
2. **每页 2 栏**:`x0 < 250` 为左栏。一栏内自上而下 = 韩文简介 / 英文简介 / 首映 note /
   **元数据行** / `Director …` / **场次行**。一栏内还并排着若干 **x 子栏**(正文 x≈473、
   小传 x≈754、韩文简介 x≈656)——**任何「看上一条/下一条」的逻辑都必须先按 x 邻近过滤**。
3. **★ 归属规则(全脚本的核心)**:一栏内按 `y` 排序,**每个元数据行开启一部片**,
   其后直到下一个元数据行之间的所有场次行都归这部片。
   **不能用「y 窗口」** —— 一页装 2–3 部片,窗口切不准。
4. **片名不要从影片页取,按 `code` 关联排期取**。影片页的片名行位置随版式漂移;
   排期的 `title_en` / `title_kr` 是逐场次解析出来的,权威且能直接命中 `filmNodeKey`。
5. **单元归属**:PDF p18「목차 Contents」给出每个单元的**起始印刷页**,
   `section_for(printed)` = 「最后一个 ≤ 本页印刷页」的单元(2025 版 19 个单元见脚本 `SECTIONS`)。

### 自检基线(2025)

```
抽出原始条目 245  判重丢弃 10  去重后 235
有场次的影片 224  无场次(未收) 10
排期 code 覆盖: 613/699  未覆盖 86
没抽到导演的影片 0   没抽到国别的影片 0
单元分布: Icons 33 / Special Program in Focus 29 / Wide Angle 27 / …
```

`未覆盖` 的 code **必须全是非影片条目**(闭幕式 002 / 颁奖重映 621–626 / 特别对谈 800 /
Community BIFF 村活动 901–944 / 结业式 X1601)——它们本来就没有影片介绍页。
若出现普通影片 code,说明某页的元数据行或场次行没认出来。

### 最终关联校验(必跑)

```bash
$PY - <<'PY'
import json
sched = json.load(open('public/schedule.json'))['screenings']
films = json.load(open('public/films.json'))['films']
by_zh   = {f['title_zh'] or f['title_orig']: f['id'] for f in films}
by_orig = {f['title_orig']: f['id'] for f in films}
def key(s):
    return ('cat:'  + (by_zh.get(s['title_zh']) or by_orig.get(s['title_en']))) \
        if (by_zh.get(s['title_zh']) or by_orig.get(s['title_en'])) else 'sched:' + s['code']
hit = sum(1 for s in sched if key(s).startswith('cat:'))
print(f'cat: {hit}/{len(sched)}  sched: {len(sched)-hit}')   # 2025 = 645/699 (92.3%)
PY
```

命中率 **> 90%** 才正常。剩下的 `sched:` 逐条看一遍,应该全是**非影片条目 + 午夜块**
(2025 = 54 条 = **50 个非影片条目 + 4 个午夜块** `008/081/164/244`)。
**别把 645 记成 646** —— `646` 是 `f178` 冒充 `Midnight Passion 4` 时代那个**假命中**的数字,
已于 Pitfall #16b 修掉;`# 2025 = 646/699` 的旧注释是残留,别再抄回去。

## Pitfalls

### 1. 坐标已是显示坐标系
排期页 `/Rotate` 有的是 90、有的 0,但 PyMuPDF `get_text("dict")` 返回的 bbox
**已经落在 `page.rect` 的坐标系里**。再乘 `page.rotation_matrix` → 整页转错、行列互换。

### 2. 单元格文字旋转 90°,阅读顺序 = y 递减
line 的 `dir == (0, -1)`。时间在**最大 y**,页码在**最小 y**。
同一 line 内不要按 x 排序。

### 3. line 会把整个单元格粘成一行
例:`'23:59~05:01 081 19 KE GV 302' 162, 164'` 是**一个** line 对象,bbox 高约 92pt。
→ 必须下沉到 **span** 级。

### 4. 网格模型:行 = 时间档,列 = 场馆
- 时间档 1..5(1 早 / 2 日 / 3 下午 / 4 晚 / 5 午夜),档位数字**竖排在最左缘 x≈30**。
- 场馆代码**竖排在页面底部表头 y≈556–580**。

### 5. 双日页:日标签的 x = 该日区域起点
p9 = `17 WED` + `18 THU`(只差 35pt,17 区只有 야외극장 一列 → 开幕日只有开幕场);
p16 = `25 THU` + `26 FRI`(差 683pt,根本是两张并排表)。
→ 判天规则:**`day = 最后一个 x <= 场次 x 的日标签`**。单日页只有一个日标签。

### 6. 场次编号按页连续递增 —— 用来交叉校验
2025:p9=001-076、p10=077-159、p11=160-238、p12=239-323、p13=324-402、p14=403-477、
p15=478-553、p16=554-628;另有 9xx 特别场、600/800 特别场。
**001 = 开幕场(9/17)、002 = 闭幕场(9/26)是预留号**,不在自己页段里。
「不连续」大多可解释(未排/取消的槽位 + 特别场号段跳变),但**重复**一定是 bug。

### 7. ★ 单元格归属靠共享 line `y1`,不靠 y 窗口
META line(含 `HH:MM~HH:MM` 的那行)与它的标题 line **共享同一个 line-bbox 下边缘 `y1`**
(实测完全相等)。标题 line 的 `x0` 比 META line 的 `x0` 大:
英文标题 **+6.2**、韩文标题 / 备注 **+11.4**;下一列的 META 在 **+21.5**、下一列标题在 **+27.9**。
→ x 间距窗口取 **`(2, 18]`**。

⚠ **旋转格子里这条判据会退化成恒真**(所有 line 共享同一 `y1`),必须再叠一道文字兜底
—— 见**陷阱 18**。注意「页码续行」的 x 偏移恰好也是 **+6.2pt**,与英文标题同值,
纯靠几何**无法区分**。

**为什么不能用 y 窗口**:标题在旋转文本流里排在时间**之前**,它的 y 比时间 span 的 y
**更大**(更靠页面下方)。早期版本用 `anchor.y0 - 78 .. anchor.y0 + 4` 切单元格,
**206 场 `title_en` 为空**。改「同 y1 + x 近邻」后归零(余下 41 场是纯韩文片名,正常)。

### 8. 同一个数字会被 PDF 拆成多个 span,但**只能对末尾页码回拼**
页码 191 在 p9 的 `017` 单元格里是 `'1'`(y=445.0) + `'91'`(y=439.8)。
正常 token 的 y 间距 ≥7.3pt,拆开的 ≤5.2pt → 阈值取 6.5pt。

**千万不要写通用的「纯数字 + 纯数字」合并器**:实测 code 与 rating 的间距在某些单元格
只有 6pt 上下,一合就把 `'101'`+`'32'` 粘成 `'10132'` → **code 重复 10 个、rating 掉到
68 个 None**。合并只发生在已识别出 `dur` 之后的**尾随页码字段**,用上一段的 `y0` 作判据。
(`'116’'` 与后面 `'1'` 间距只有 3.8pt,通用合并会成 `'116’1'`。)

### 9. BD / C7 两列**原 PDF 就不印编号**
不是解析丢了 —— 用 `page.get_text("text")` 原始文本核对过,2025 版 p9–p14 的 BD/C7 列
确实没有三位编号。→ 用 `X<页号2位><序号2位>`(如 `X0901`)兜底。

**为什么必须有兜底**:前端 `cat.byCode` / `ctx.slots` / `cardEls` / `talkEls`
(`grid.ts` / `agenda.ts` / `modal.ts` / `main.ts` / `ics.ts` / `data.ts`)
**全以 `code` 为键**。空 code 或重复 code 会**静默互相覆盖**。

### 10. 场次特性 token 不止 GV
实测 META 里出现:`GV`(347)、`Talk`(6)、`Commentary`(3)、`Event`(1)。
`GV` → `is_gv`;其余按原义小写进 `tags`(`talk` / `commentary` / `event`)。

`tags` 有**两个来源**,排查时别只看 META:

1. `META_FLAG_TAGS` —— META 行里的 `EVENT` / `TALK` / `COMMENTARY` / `BATCH` token。
2. `TITLE_TAGS` —— **标题 + 备注行**里的关键词(`tags_for()` 把 `title_en` / `title_kr` /
   `notes` 拼成一个 blob 再逐条 needle 匹配)。`opening` / `closing` / `midnight` /
   `masterclass` / `open_talk` / `premiere` 全走这条。

★ `001` 的 `opening` **不是从标题来的**:它的 `title_en = 'No Other Choice'`、
`title_kr = '어쩔수가없다'`,一个关键词都不含。真正命中 `개막` 的是**第三行备注**
`(개막식+개막작)` —— 这行 `x0` 比标题行再 +11.4pt,`split_title()` 见它以 `(` 开头就归进
`notes`,再由 `tags_for()` 从 notes 里匹配到。
→ **改 `TITLE_TAGS` 或 `split_title()` 时,`001` 的 `opening` 是最容易静默丢的标签**
(丢了不报任何 WARN,`tags 分布` 里 `opening` 直接消失)。
`002` 的 `closing` 相反,是直接从 `title_en`(`Closing Ceremony+…`)命中的。

`묶`(Batch Screening / 连场放映)在 **2025 正文里没有实际使用**(只在 p69/p70 说明文字里
出现),但 `badges.ts` 里保留作 2026 前向兼容。

**前端注册表是白名单**:`screeningBadgeKeys()` 对未注册键**静默忽略**
(`src/badges.ts`)。已注册:`gv` / `masterclass` / `premiere` / `open_talk` / `batch` /
`talk` / `commentary` / `event`(后三个 2026-09-10 补,走青绿族 token `--ev-teal`,
用「实心 → 实线描边 → 虚线描边」区分权重)。
想让新特性显示,只需在 `BADGE_DEFS` 加一条 + `ABBR_LINES` 补一行缩写说明,不用改解析器。
`opening` / `closing` **故意不注册**(各 1 场,标题行已标 개막식 / 폐막식,加章是重复信息)。

### 11. 少数特别场册子里不印片长
**2025 实测只有 1 场:`002` 闭幕式**(`stats['dur_missing'] = 1`)。

> ⚠ 旧版本这里写「已知:002(闭幕式+获奖作联映)、BAFA 毕展」——**是错的**,已核对原始 span:
> `X1601` 的 META 行是 `19:00~21:00 120’`,**片长印了**。别再照抄旧说法。

判据看 **META 行里有没有 `NN’` token**,不要凭「这场是不是特别场」猜:

| code | META 行原文(p16) | 算 `dur_missing`? |
|---|---|---|
| `002` | `18:00~22:00 002 GV ` ← **没有 `NN’`** | ✅ 是 |
| `X1601` | `19:00~21:00 120’` | ❌ 否(印了) |

**不能留 `duration_min: 0`** —— 前端 `gvTalkMin() = (end - start) - duration_min`
(`src/gv.ts`)会把整段时长算成「映后谈」,002 会凭空多出 240 分钟映后谈。
→ 缺片长时回退成「印出来的整段占用时长」(`dur = printed_span`),映后谈自然归 0。

**回退的副作用(要记住)**:回退后 `dur == printed_span`,于是
`meta["gv"] and printed_span == meta["dur"]` 这条 GV 补时分支**恰好为真** ——
但同一表达式里 `meta["dur"]` 是 `None`(假值),所以**补时被跳过**,`end_time` 保持官方印的
`22:00`,不会被 +25 推到 `22:25`。这是正确行为,别去「修」。

### 12. 页外杂物别卷进来
`P&I` / `Community BIFF` / `Talk` 等页眉页脚文字在 `x > 600`。
用 `BODY_Y_MAX = 535.0` 卡住 `y`,自然排除。

### 13. ★ 字幕标识可以同时印多个,`subs` 必须是**数组**
实测 4 场印 `KE KK`(028 / 029 / 109 / 268,全在 C3 列)。语义是**叠加**而非二选一:
`KE` = 有韩字 + 有英字,`KK` = 配韩语对白。
早期写法 `if out["subs"] is None: out["subs"] = t` 只接第一个,第二个掉进 `extra`,
而 `extra` 写盘前被剥掉 → **静默丢数据**。
→ 改为 `subs: list` 逐个 `append`(去重);空数组落 `null`;前端 `SubsKey[]`。

**哨兵**:自检里 `cells_with_extra` 的格数**恰好等于**这些场次(2025 版修复前 = 4)。
现已改成「非空时打 `WARN` + code + 未认领 token + 标题」—— 归零的计数器不再输出,
等于没有哨兵。**看到「未认领 token」的 WARN 就说明出现了新版式 / 新 token,不要放过。**

**前端必须做标量兼容**:`public/schedule.json`(2026 demo)的 `subs` 是**标量字符串**
(实测 18 场 `str` + 6 场 `null`)。渲染前走 `legend.ts` 的 `subsKeys()` 归一化,
否则 `SUBS_DEFS[array]` 取到 `undefined` → **18 场字幕章全丢**。

### 14. ★ 元数据行的国别会**换行到上一行**
国别一长(实测 PDF p43 右栏 Kyrgyzstan/Switzerland/… 7 国)就独占一行,下一行才是
`| 2025 | 89min | DCP | color`。→ 国别为空时回看上一条行。
**但同一栏里并排着别的 x 子栏**(韩文简介 x≈656),「上一条」很可能不是自己那列。
→ 必须按 **x 邻近(±20pt)** 回看,命中第一条同 x 的行就 `break`(不管像不像国别)。
漏了这条会静默丢 4 个 code 的归属(实测 296/383/427/582)。

### 15. 导演有**三种**版面情形,只认 `Director ` 前缀会漏
1. 有 `Director <EN> <KR>` 行 —— 但它**可能排在场次行之后**(实测 p23:
   MET `y=248.6` / CODE `y=258.6` / DIR `y=556.8`)→ **不能与场次行采集写成 if/else**。
2. 同一行后面并排着别的职务:`Director Isabelle KALANDAR    Executive Producer Isabelle KALANDAR
   Co-producers …    Script …` → 必须**遇职务词截断**
   (`Executive Producer|Co-?producers?|Producers?|Screenplay|Script|Cinematography|Editing|
   Editor|Music|Cast|Production Design|Art Director|Costume Design`),否则导演字段变成一整串。
3. **整页不印 `Director` 前缀**(实测 Opening Film `No Other Choice`、Competition
   `Without Permission`)—— 导演信息框就是「英文名一行 + 韩文名一行 + 小传」。
   判据三连:① 英文行 2–4 个词且**含一个全大写词**(姓,`NAZER` / `PARK`);
   ② 下一行**纯韩文**(`하산 나제르` / `박찬욱`);③ **同 x 子栏(±20pt)且 y 间距 ≤14pt**
   —— 第 ③ 条用来排掉**片名块**(如 `Frankenstein` / `프랑켄슈타인`,字号大、行距 ~20pt)。
   找「下一行」同样要按 x 子栏过滤,不能取 `seq[i+1]`。

### 16. ★ 午夜场**联映块名**会污染片名,把整块影片并成一条
排期里 code `008/081/164/244`(23:59 那 4 场)的 `title_en` 印的是**块名**,而且**前面被粘了一串数字**:

| code | 排期 `title_en` | 单元格里那串数字 |
|---|---|---|
| 008 | `163, 165 Midnight Passion 1` | `163, 165` |
| 081 | `Midnight Passion 2` | (邻格 `162, 164`) |
| 164 | `115, 160, 163, 164 Midnight Passion 3` | `115, 160, 163, 164` |
| 244 | `Midnight Passion 4` | (邻格 `161, 180`) |

**那串数字的语义 = 块内各片的「影片介绍页」印刷页码**(已确认,见陷阱 18 的根因)。
它被排版的换行拆成两段:`161,` 留在 META 行内(被 `RE_PAGES` 正确并入 `pages`),
`163, 165` **自成一行** → 几何上落进标题判据 → 变成 `title_en` 前缀。

**真正致命的是下一步**:这些块 code **又会出现在块内各部片的影片页 code 清单里**
(实测 `Exit 8` 的场次 = `008` + `097`;`The Furious` = `081` + `219`;`The Holy Boy` = `164` + `418` + `529`;
`Bride of the Covenant` = `164` + `111` + `553`)—— 因为买午夜场买的就是块。
于是「按 code 清单取第一个非空 title」会把整块片名写成块名,再按片名去重就**把整块并成一条**:
实测 8 部片并成 4 条(每条吃掉 2 部),目录 224 → **220**,`cat:` 命中 646 → 641。

→ 目录侧:用 `BLOCK_TITLE = ^(?:\d[\d,\s]*)?\s*Midnight\s+Passion\s+\d+\s*$` **跳过块名再取**;
  若整块只有 1 片(2025:`Exterior Night`,唯一 code = `244`)→ 从 `midnight_members` 取名,
  否则会退回块名当片名(`f178` 曾因此叫 `Midnight Passion 4`)。
**自检哨兵**:目录里出现 `^\d+,\s*\d+` 或含 `Midnight Passion` 的片名 = 这条回归了。

### 16b. 块 code 的归属:靠**单元扉页对照表**,不靠页码反查(2025 已修)

块 code 在 App 里曾是**孤儿场次**(`filmNodeKey()` 落到 `sched:163, 165 midnight passion 1`)
—— 选了 `Exit 8` 的常规场 `097` → `cat:f177`,而它的午夜场 `008` 却是另一个节点。

**为什么不能用「块格子的页码」反查成员**:一个印刷页放 2~3 部片,`163` 同时是
Honey Don't! 与 The Holy Boy 的介绍页 → **过收**。

**权威来源 = 单元扉页的对照表**(2025 = PDF p81),版式:

```
x92.1  y169.2  Midnight Passion 1
x92.1  y177.3  미드나잇 패션 1
x146.0 y168.5  Exit 8 8번 출구 | Weapons 웨폰 | Honey Don't! 허니 돈트!
x146.0 y178.6  008 Sep 18 / 23:59 / BH
```

即 `块名行 → 同一 x 子栏、块名正下方的 code 行 → 该行正上方的成员行`。
`extract_schedule.py::parse_midnight_blocks(doc)` 扫全册实现
(2025 实测 **4 块 / 10 部片**,零漏零误:MP1=3 / MP2=3 / MP3=3 / MP4=1)。

**三个已踩的坑**:
- **取行必须取「最近」,不能取「第一个同高」**:同一页右侧还有图注 / 正文,
  实测 MP3 的成员行被 `© 2025 ”Exit 8” Film Partners` 以 **2.4pt** 之差抢走。
- 再加一道 `|成员行.y − 块名.y| ≤ 6` 的贴合校验兜底。
- 成员行是「英文片名 + 韩文片名」并排,按 `|` 切段后在**首个韩文字符**处截断;
  韩文片名可能以数字开头(实测 `8번 출구`)→ 截断后会粘一个数字,须回剥
  (`'Exit 8 8'` → `'Exit 8'`)。只剥紧贴韩文的那串数字,`Blade Runner 2049` 不受影响。

修后:4 块各带 `midnight_members` 字段,`tags` 加 `midnight`(靠标题关键词判定,
**不硬编码块号** —— 换年份块号会变),`cat:` 命中 **645/699**
(比修前少 1 = `f178` 冒充 `Midnight Passion 4` 的那条**假命中**被诚实掉了)。

### 17. 排期的 `page` 字段**不是影片唯一键**,别用它反查影片
**一个印刷页装 3 部片**,所以 89 个 `page` 值各自对应多部不同影片
(如 `page=119` → The Blue Trail + The Chronology of Water);另有 10 个 code 的 `page` 为空
(`800 / 164 / X1601 / 621–626 / 002`)。
→ 正确的关联方向是**反的**:从影片介绍页读出该片自己的 code 清单,用 code 去排期取片名。

### 18. ★ 旋转格子里「共享 `y1`」会**退化成恒真**,标题判据必须再加文字兜底
陷阱 7 的「同 y1 + x 近邻」在**旋转 90° 的格子**里有个致命副作用:
整个格子的所有 line **共享同一个 `y1`**(= 旋转后的公共基线,实测 p9 全部 `y1 = 123.0`),
于是 `abs(l.y1 - meta.y1) <= 2.5` 对格子内**每一行都成立** —— 几何判据退化成恒真,
只剩 x 间距窗口 `(2, 18]` 在挡。

**症状**:块格子的「页码续行」被当成标题。块的页码是**成员片介绍页的页码列表**,
换行时会自成一行,`x0` 与 META 行相差 **6.2pt** —— 恰好落在 `(2, 18]` 内:

```
META line  x0=95.5 y1=123.0  spans: 23:59~05:10 | 008 | 19 | KE | GV | 311' | 161,
TITLE line x0=101.7 y0=104.9 y1=123.0  '163, 165'          ← 被当标题
TITLE line x0=106.9 y0=48.2  y1=123.0  'Midnight Passion 1 | 미드나잇 패션 1'
```

`161,` 因为和 META 同一段旋转文本流,被 `RE_PAGES` 正确并入 `pages`;
`163, 165` 自成一行 → 变成 `title_en` 前缀(实测 `008.title_en = "163, 165 Midnight Passion 1"`)。

→ 修法:在 `parse_page()` 组装标题 span **之前**加一道**文字**过滤 ——
`pages_only_line(text)` 判定「纯页码列表」,命中则并入 `meta["pages"]` 而不是标题:

```python
RE_PAGE_LINE = re.compile(r"^\d{1,3}(?:\s*,\s*\d{1,3})*,?$")
PAGE_NO_RANGE = (40, 230)      # 影片介绍页印刷页范围(2025 实测 42–206)

def pages_only_line(text):
    if not RE_PAGE_LINE.match(text): return None
    nums = [int(v) for v in re.findall(r"\d{1,3}", text)]
    if not nums or any(not (PAGE_NO_RANGE[0] <= n <= PAGE_NO_RANGE[1]) for n in nums):
        return None
    return nums
```

**范围守卫不能省**:`5 Centimeters Per Second`(code `073`/`324`)以数字开头,
裸 `^\d[\d,\s]*\s` 会误报。单个 `5` 不在 `(40, 230]` 内 → 不误伤。

**回归哨兵**(跑完必看):`title_en` 不得以「页码列表 + 空格」开头,且 `页码续行归并` 应 = 2 行。

### 19. ★ 仪式 / 奖项类特别场:全册 12 条,一条都不能漏

册子里除了影片,还有一整类**「仪式 / 奖项 / 纪念」场次**。它们**和普通放映印在同一张网格里**
(不另起页、不另给编号段),所以解析器**不需要也不应该给它们开特殊分支** —— 走同一条路径,
靠标题 / 备注关键词打 `tags`。但**下游(影片目录关联、徽章、片长)各有各的口径**,逐条记清楚。

**(a) 2025 全量清单(12 条)**

| code | 日期 | 内容 | `tags` | 影片目录 |
|---|---|---|---|---|
| `001` | 09-17 | 개막식 + 개막작 *No Other Choice* | `[opening]` | `cat:f001` ✅ |
| `002` | 09-26 | 폐막식 + 부산어워드 수상작 상영 | `[closing]` | `sched:` |
| `800` | 09-19 | 까멜리아상 수상자 特别对谈 | `[]` | `sched:` |
| `X1601` | 09-25 | BAFA 2025 수료식 + 短片放映 | `[]` | `sched:` |
| `621`–`626` | 09-26 | 六个奖项获奖作放映(各 1 场) | `[]` | `sched:` |
| `931` / `944` | 09-20 / 09-21 | 기념 영화 `<프로젝트 30>` 纪念放映(同片 2 场,`title_en` 为空) | `[]` | `sched:` |

**只有 `001` 能挂上影片** —— 因为「开幕式 + 开幕影片」这场,**开幕片本身就是一部正片**
(印了片名 `No Other Choice` / `어쩔수가없다`,`page=43`)。其余 11 条的 `title_en` / `title_kr`
印的是**事件名**,影片目录里没有对应条目 → 落 `sched:` 是**正确**的,不是漏解析。

**(b) `001` 的「120 分钟余量」—— 别当成 bug**

```
META 行(p9):  18:00~22:19 001 15 GV 139’ 43
               ↑ 槽位 259 min        ↑ 片长 139 min
标题行:        No Other Choice 어쩔수가없다
备注行:        (개막식+개막작)
```

槽位比片长多 **120 分钟** —— 那 2 小时是**开幕式本身**(红毯 / 致辞)的占用,
**册子自己就把它算进槽位了**,所以 `printed_span(259) != dur(139)` → GV 补时分支不触发,
`end_time` 老实保持 `22:19`。

全站 347 场 GV 里**只有 `001`(余量 120)和 `002`(余量 0)余量 ≠ 25**。
前端按可配置 `gvTalkMin`(默认 25)渲染 → 网格里 `001` 的 chip 画到 `20:44`,
但轴末取 `max(end_time, filmEnd + 时长)` = `22:19` ⇒ **开幕式那 2 小时在 UI 上表现为片后空白**。
属口径取舍,**已确认保持现状,不要「修」**。

**(c) `X1601` 的 META 行不印 code**

```
META 行(p16):  19:00~21:00 120’
```

没有 code、没有 rating、没有字幕 token → 走 `X<页号2位><序号2位>` 合成兜底(`X1601`)。
这是 Pitfall #9 的**另一种成因**:BD / C7 是「整列不印编号」,`X1601` 是「单场不印编号」。
判据一样 —— 只要 code 位不是 `^\d{3}$` 就合成,别让它空着
(空 code 会让前端 `byCode` / `slots` / `cardEls` 静默互相覆盖)。

**(d) `800` 的标题会被拼成「中括号反挂」**

册子把这条对谈的英文标题排成**两条 line**(`y1` 相同、`x0` 差 4.8pt):

```
x0=112.8 y0=126.0  'Special Talk [The Cinematic Life of Sylvia Chang, '
x0=117.6 y0=160.8  'Winner of the Camellia Award] '
```

`split_title()` 按 **`y0` 降序**拼接(`sorted(..., key=lambda s: -s["y0"])`),
于是 `y0=160.8` 那条**排在前面** → 产出:

```
title_en = 'Winner of the Camellia Award] Special Talk [The Cinematic Life of Sylvia Chang,'
                                 ↑ ] 在前      ↑ [ 在后
```

**语义上应该是** `Special Talk [The Cinematic Life of Sylvia Chang, Winner of the Camellia Award]`
—— 即两截的 `]` / `[` 互换。

**为什么不能简单改成按 `x0` 升序**:x0 小的是「英文标题位(+6.2)」、大的是「备注位(+11.4)」,
`001` 的备注 `(개막식+개막작)` 正是靠这个顺序才没被拼进片名。**按 x0 升序会把备注拼进片名。**
→ 目前**不改**(只影响 1 条的显示可读性);若 2026 再出现「标题跨两行且括号分列」的场次,
再加一条**形态判据**:拼完后若匹配 `\]\s*[^\[\]]*\s*\[`(即 `]` 出现在 `[` 之前)就交换这两截。
**别写通用括号平衡器。**

**(e) 下游契约(改前端时对照)**

- `badges.ts` 白名单**故意不注册** `opening` / `closing`(各 1 场,标题行已印 개막식 / 폐막식,
  加章是重复信息);但 `talk` / `commentary` / `event` / `midnight` **已注册**,要正常显示。
- `legend.ts` 的「特别提示」里有一条**开闭幕口径**说明(开幕式 + 开幕片在首日于
  BIFF Theatre 举行、闭幕场放「釜山奖」获奖作)—— 换年份要改文案里的届次 / 场馆。
- `filmNodeKey()` 只认 `title_zh` / `title_en`,**不认 `midnight_members`、也不认事件名** ——
  所以这 11 条必然落 `sched:`。想「单独选上某部获奖作」目前**做不到**(获奖作名册子里就没印),
  这是数据源限制,不是解析缺陷。

## 新增电影节(复制适配层)

**约定:一个电影节一份独立 SKILL + 一份独立适配层脚本**(彼此独立,允许重复)。
仓库内路径:`<repo>/.codebuddy/skills/<festival>-catalogue-pdf-to-schedule/SKILL.md`。

**通用底座 `tools/festival_common.py` 已抽出**以下能力,新电影节直接 import,不要重写:

| 能力 | 入口 |
|---|---|
| 规格注入 | `LayoutSpec`(版面几何) / `MetaSyntax`(token 正则与枚举) |
| 页面 → line/span | `build_lines(page, syntax)` |
| 版面几何选择器 | `find_day_labels` / `find_venue_codes` / `nearest_venue` / `day_for_x` / `closest` / `cell_title_lines` |
| 单元格解析 | `parse_meta(spans, syntax)` / `pages_only_line(text, syntax)` / `tags_for(...)` |
| 自检哨兵 | `check_code_unique` / `check_code_continuity` / `check_title_page_prefix` |
| 输出与日志 | `strip_internal(row)` / `write_json(path, payload)` / `log` / `parse_pages_arg` |

**步骤**:

1. `cp tools/extract_schedule.py tools/extract_schedule_<fest>.py`。
2. 替换该文件顶部的 **`VENUE_NAME`**(场馆表)、**`RE_*`**(token 正则与枚举)、
   **`LAYOUT`** / **`META_SYNTAX`**(版面几何与语法)、**`TITLE_TAGS`**,以及特殊板块解析
   (BIFF 的是 `parse_midnight_blocks` / `_split_members` / `_has_hangul` / `split_title` ——
   新电影节没有对应板块就整个删掉)。
3. `--dump-page <i>` 探页段,确认排期网格在哪些页;更新 `SCHEDULE_PAGES_DEFAULT`。
4. 跑自检基线逐条核对(尤其 `code 全局唯一`、`全空标题 = 0`、每日场次分布)。
5. **输出契约必须不变** —— `Screening` / `Venue` 字段对齐 `src/types.ts`,否则前端不认:
   `code / title_en / title_kr / title_zh / date / start_time / end_time / duration_min /
   venue_id / venue_display / is_gv / tags / rating / subs / page`。
   跨午夜场**必须**保留 24+ 时制(`"29:35"` = 次日 05:35),前端全部算术依赖 `end > start`。
6. 复制本 SKILL 为 `<festival>-catalogue-pdf-to-schedule`,把「版面陷阱」与「自检基线」
   两节**按新册子重写**(通用方法论可保留),并在 frontmatter 写清触发词。
7. 收尾脚本同样另建一份(BIFF 的是 `import_schedule_2025.py`:泳道重排 + `festival` 元信息)。

**能复用 / 不能复用的边界**:

| 层次 | 复用性 | 说明 |
|---|---|---|
| 通用底座 | ✅ 直接复用 | 拆 line、几何选择器、META 扫描骨架、自检、JSON 写出 |
| 网格模型 | ⚠️ 需适配 | 「行=时间档 / 列=场馆」不是所有册子都成立,`LayoutSpec` 要重测 |
| 册子专属 | ❌ 不可复用 | 页段、场馆表、token 词表、午夜联映块、双日页、仪式场清单 |

> 前提:新册子必须是**带文本层的 PDF**。扫描件 / 官网 HTML 另走 OCR 或爬取,SKILL 只能复用方法论。

---

## 换年份适配清单(2026 册子出来时)

### A. 排期表(schedule.json + venues.json)

1. `--dump-page` 探页段 → 更新 `--schedule-pages`。
2. 核对 `VENUE_NAME` 字典:**新增/改名/停用**的场馆。
   2025 口径 29 个:`BT BH B1 B2 B3 BD C1–C7 CX L2–L7 L9 L10 KT SH BCM M1–M4`。
3. 核对日标签页(是否出现新的双日页布局)。
4. 核对 META token 词表(`META_FLAG_TAGS`):是否出现新 flag。
4b. **核对仪式 / 奖项类场次**(见 Pitfall #19):跑完必须满足
   `tags 分布.opening == 1` 且 `.closing == 1`;再按 `title_en` / `title_kr` 关键词
   (`ceremony` / `award` / `graduation` / `수료식` / `기념` / `특별` / `토크`)扫一遍,
   把新出现的仪式场**逐条登记进 Pitfall #19 的清单**。
   **别只信 `tags`** —— 除开闭幕式外的 10 条仪式场 `tags` 全是空的,扫不出来就等于没记录。
5. 跑一遍,对照本文件「自检基线」看哪些数字**结构性**变了(而不是个别场次)。
6. 有结构变化 → 改 `tools/extract_schedule.py` 并把新陷阱补进本文件。

### B. 影片目录(films.json)—— 明天片单发布会后立刻要跑的那条线

**先做这一步(30 秒),它决定后面所有参数**:册子 p18「목차 Contents」列出各单元的**印刷起始页**。
`tools/extract_films_2025.py` 的 `SECTIONS` 就是照抄这张表;单元归属完全靠它,不靠猜。

7. **重探影片页段**:`PAGE_RANGE` 目前写死 `(21, 97)`(= PDF p22–p97 = 印刷页 42–194)。
   换年份后册子厚度会变 → 用 `--dump-page <i>` 找到**第一部片的元数据行**出现的最小 i,
   与**最后一部片**之后第一张纯广告/目录页的 i,更新 `PAGE_RANGE`。
8. **重抄 `SECTIONS`**:印刷起始页几乎每年都变(2025 是
   `43 Opening / 44 Competition / 59 Gala / 64 Icons / 82 Vision / 96 A Window on Asian /
   110 Korean Cinema Today / 118 World Cinema / 128 Flash Forward / 136 Wide Angle /
   154 Open Cinema / 160 Midnight Passion / 166 On Screen / 170 Special Program in Focus /
   190 Special Screenings / 193 Program Events / 198 FORUM / 202 Community / 206 Everywhere`)。
   映射规则恒为「**印刷页 ≤ 该片页 的最后一个单元**」。
9. **核对 `BLOCK_TITLE`**:联映块名的印法若从 `163, 165 Midnight Passion 1` 变成别的样式,
   正则要跟着改;判据是「跑完看 `WARN 无场次` / 目录里是否出现带逗号数字的片名」。
10. **核对 `COUNTRY_LIKE` / `MET`**:国别行是否仍能单独成行(2025 有换行到上一行的情况,
    靠 ±20pt x 邻近回看,见 Pitfall #14)。
11. **跑关联率校验**(本文件「自检基线」里的 Python 片段):
    `cat:` 命中率应 ≥ 90%;掉下来的应该是**非影片条目 + 午夜块**
    (2025 = 50 个非影片条目:`901–944` 村活动 / `800` 特别对谈 / `002` 闭幕式 / `621–626` 获奖重映 /
    `X1601` 毕业典礼;外加 **4 个午夜块** `008/081/164/244`)。
    午夜块落 `sched:` 是**正确**的(块不是影片,是售票结构),见 Pitfall #16b;
    它们靠 `midnight_members` 表达块内成员。
    如果掉下来的是**普通片名** → 说明 `BLOCK_TITLE` 或片名匹配又坏了。
12. **`--dry-run` 看 `WARN` 行**,目标:`缺导演 = 0`、`缺国别 = 0`。
13. 片名一律**以排期表为准**(从 intro 页只取 `code` 清单,再回排期表取 `title_en`/`title_kr`),
    绝不要用 `page` 字段反查影片 —— 见 Pitfall #17。

## Verification

- [ ] `code 全局唯一 ✓`(无「⚠ code 重复」)
- [ ] 「全空(中英韩皆空)」= 0
- [ ] 开幕日场次数符合常识(2025 = 1),闭幕日场次数符合常识(2025 = 7)
- [ ] 契约校验脚本「全部通过 ✓」
- [ ] 抽 3 天(含开幕/闭幕)与册子原页人工对照一致
- [ ] `rating` / `subs` 的 `None` 占比与往年同量级
- [ ] **`subs` 是数组**:`多值场次` > 0(2025 = 4)、无空数组 `[]`、无重复值、无 `未认领 token` 的 WARN
- [ ] `tags 分布` = `{opening: 1, closing: 1, midnight: 4, talk: 6, commentary: 3, event: 1}`
      (2025 口径);`opening` / `closing` **各恰好 1 条**
- [ ] `GV 347 / 699`、`dur_missing` = 1(且只可能是 `002`)、`code_synthesized` = 37
- [ ] `cat:` 命中 = **645/699**;剩下 54 条 = 50 个非影片条目 + 4 个午夜块
- [ ] Pitfall #19 的 12 条仪式 / 奖项场已逐条核对(清单是否要增删)
- [ ] 产物是 `{festival: {...}, screenings: [...]}` 与 `{venues: [...]}`,无 `_` 前缀内部字段

## 已知限制

- **模型看不了图**:`Read` 工具无法展示 PNG(无视觉)。所以本流程**全靠坐标探测**
  验证,不要试图「截图看看对不对」。需要视觉验收时用
  `canvas-game-visual-qa` 那套(playwright + 像素断言),或让用户目检。
- `title_zh` 恒为空 —— 需另配影片信息表 / 豆瓣关联。
- `venues.json` 的 `lat` / `lng` 为 `null`,需另行补全(2025 版未提供)。
