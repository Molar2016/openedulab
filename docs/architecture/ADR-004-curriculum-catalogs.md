# ADR-004 — 教材目录（catalog）与目录内顺序（R8）

状态：已实施（2026-10-27，R8）。依据：`docs/requirements-v2.1.md` §3A、§4 第 8 条、§6 决策 8/9。关系：**扩展 ADR-003**；只取代 ADR-003 §D2 的**数据布局**（placement 内嵌 `edition/book/chapter` 加一个平面 `order`），保留其标识模型、快照作用域、保存/重置语义与“不得声称教材映射”的约束。

> **数据布局已被 ADR-005 取代（R9 G2）**：教材树不再声明在工具自己的 `curriculum.json` 里，而是学科级文件 `curricula/<subject>/<file>.json`；工具文件的 `schemaVersion` 升为 3 且只放 placement。本文的 D2、D3 中「目录必须声明在同一文件」一条、D8 第一条「一个 collection 文件只服务一个工具文件夹」**已失效**；D4（身份/不改旧 placement）、D5（示例不得写出版社/版次）、D6（API 字段）、D7（界面约束）继续有效。实现现状见 ADR-005。

## 1. 问题

R7 的 `curriculum.json` 把教材位置写在每条 placement 里：

```json
{ "placementId": "...", "order": 1,
  "edition": { "id": "...", "labels": { ... } },
  "book":    { "id": "...", "labels": { ... } },
  "chapter": { "id": "...", "labels": { ... } } }
```

这能证明“一个工具多个入口”，但不能表达真实的目录事实：

- `order` 是**工具条目自己的序号**，不是“这本教材里第几册第几章”；用它排序等于把两个不同的概念混成一个数字。
- 册与章没有独立身份，同一册在不同 placement 里重复书写，谁先谁后没有事实源。
- 两本教材若以不同顺序编排同一批概念章节，旧结构无法表达（同一工具的第二本教材会与第一本共用标签、顺序全凭书写位置）。
- 真实教材需要出版社/版次等出处字段，而旧结构没有任何位置能放；也就无从区分“示例”和“已核实书目”。

## 2. 决策

### D1 “课程”只是学科导航

层级固定为：**学科（`subject` 标签，仅导航分组）→ 教材版本（catalog）→ 册（book）→ 章/节（chapter）→ 工具入口（placement）**。

不引入班级、学期、选课、教学进度、教师角色、学生名册，也不采集学生数据。`subject` 取自工具 manifest 的 `subjects` 标签（如 `math`），校验时必须是其中之一——数学工具不能被放进物理教材。

### D2 目录是内容，升级为 schemaVersion 2

`experiments/<folder>/curriculum.json` 现在有两段：

```json
{
  "schemaVersion": 2,
  "catalogs": [
    {
      "catalogId": "pilot-edition", "subject": "math", "version": 1,
      "status": "illustrative", "order": 1,
      "label": { "zh-CN": "…", "en": "…" },
      "books": [
        { "bookId": "pilot-book-a", "order": 1, "label": { … },
          "chapters": [
            { "chapterId": "pilot-chapter-a", "order": 1, "label": { … } }
          ] }
      ]
    }
  ],
  "placements": [
    { "placementId": "math.functions.pilot-linear-slope", "slug": "pilot-linear-slope",
      "version": 1, "status": "illustrative",
      "catalogId": "pilot-edition", "bookId": "pilot-book-a", "chapterId": "pilot-chapter-a",
      "order": 1, "title": { … }, "summary": { … }, "preset": { … } }
  ]
}
```

- placement 用 **(catalogId, bookId, chapterId)** 三元组定位章节，不再复制标签；`order` 重新定义为**章内工具序**。
- 同一工具可被多条 placement 引用；实验代码只有一份，不复制模块。
- 目录的册/章顺序只来自 `order`，不从工具 ID、学段、数组位置或字母序推导。

### D3 顺序规则（启动时强制）

| 约束 | 违反后果 |
|---|---|
| `catalog.order` 在**同一文件**内唯一 | 拒绝启动（`catalog order N is already used`） |
| `book.order` 在**同一教材**内唯一 | 拒绝启动 |
| `chapter.order` 在**同一册**内唯一 | 拒绝启动 |
| `chapterId` 在**同一教材**内唯一（跨册也不得重名） | 拒绝启动；防止“同名章”把入口指向另一册 |
| placement 的 `order` 在**同一章**内唯一 | 拒绝启动（`tool order N is already used`） |
| placement 的三元组必须精确命中一本册下的一章 | 拒绝启动；若该章存在于**另一册**，报错写明所属册，**绝不按名字回退** |
| `catalogId` 不得在同一文件重复，也不得被另一个工具目录重复声明 | 拒绝启动（目录顺序会歧义） |
| placement 引用的 catalog 必须在**同一个** `curriculum.json` 中声明 | 拒绝启动（不跨文件、不跨工具解析） |
| placement 的 `status` 必须等于所属教材的 `status` | 拒绝启动 |

全局排序（服务端索引与 `/api/curriculum`）为：`subject` → `catalog.order` → `catalogId` → `book.order` → `bookId` → `chapter.order` → `chapterId` → 章内 `order` → `placementId`。

### D4 身份与版本：不改旧 placement，不迁移数据库

- R7 的 placement ID（`math.functions.pilot-linear-slope`、`math.functions.pilot-quadratic-vertex`）、slug（`pilot-linear-slope`、`pilot-quadratic-vertex`）与 `version: 1` 原样保留，因此 `/curriculum/<slug>` 旧链接与 `placement_saved_state` 里的个人快照继续有效。
- `catalogId` 采用 R7 的 `pilot-edition`，不改名。
- **没有新迁移**：`0001_init.sql` 与 `0002_placement_state.sql` 均未改动，快照作用域仍是 `(账号, placement)` 与 `(账号, 工具)` 两张表。
- 新增两条 placement（`pilot-vertex-first`、`pilot-slope-after`）使用新的稳定 ID 与 slug。

### D5 出处：示例必须是示例，核实前不得写出版社/版次

- `status: "illustrative"`：**不得**出现 `publisher` / `revision`（填写即拒绝启动）；界面与章节页都标注“示例 / 非已核实教材章节”。
- `status: "verified"`：`publisher` 与 `revision`（版次/出版年）为**必填**且双语非空。
- 本仓库当前**没有** `verified` 教材：没有可核验书目，就不编造。章名的真实性只能由内容评审确认，校验器无法验证——因此 `verified` 是人在文件里作出的声明，而不是代码的结论。
- 示例用两本明确标注为非教材的目录：教材甲（一册，章 A 斜率 → 章 B 顶点）与教材乙（两册：册 B1 顶点 → 册 B2 斜率），证明同一工具可以被不同顺序编排。

### D6 API 契约

`GET /api/curriculum?locale=` 仍返回 `items`，字段**向后兼容**并新增：

- 每条 item 新增 `subject`、`catalogId`、`bookId`、`chapterId`；`order` 现在是章内工具序；`edition/book/chapter` 仍保留（值为所属教材/册/章的本地化标签），旧消费方不会缺字段。
- 新增 `catalogs`：教材数组，含 `catalogId/subject/version/status/order/label`、仅核实教材才有的 `publisher/revision`，以及嵌套的 `books[].chapters[].placementIds`。章只携带 placement ID，条目定义仍只有 `items` 一处，避免同一入口两种描述。
- 没有新增路由，没有改动 `/api/me/placement-state/:id` 与 `/api/me/saved-state/:id`（身份、版本、409 语义、限速、CSRF 全部不变）。
- 启动校验与 `scripts/validate-content.mjs` 规则等价，坏目录在 CI 与启动时都会失败。

### D7 界面

- `/curriculum` 按“学科 → 教材 → 册 → 章 → 工具入口”分组渲染：章节与入口都用有序列表，顺序即目录顺序；教材与条目都有“示例（非教材章节）”徽标；核实教材显示出版社/版次。
- 标题按学科给出（当前为“数学课程 / Mathematics course”）；页面明确写出“学科只是导航分组，不包含班级/学期/名册/学生记录”。
- 章节页沿用 R7 的面包屑（教材 · 册 · 章），并新增来源提示（示例条目 / 非已核实教材章节）。
- 章节 URL 仍是 `/curriculum/<slug>`；语言仍走 `?lang=`。

### D8 已知边界（本轮刻意不做）

- **一个 collection 文件只服务一个工具文件夹**：教材目录声明在工具自己的 `curriculum.json` 里，因此一本要同时编排多个工具的教材需要“学科级目录文件”，那是独立设计（涉及跨工具校验与排序），本轮不做。当前每个工具都能拥有任意多本教材，同一本教材可容纳该工具的多条 placement。
- 不做教材导入、章节编辑器、页码、节（section）层级、教师自定义目录。
- 不做章级收藏/最近使用/事件归属（仍按工具）。

## 3. 被否的替代方案

- **给 `saved_state` 加列 / 合并两张快照表**：R7 已论证会破坏“两个作用域互不复制”的结构性保证，且 SQLite 改主键需重建表。
- **用 placement 的 `order` 当全局目录顺序**：会强迫同一工具的所有教材共用一个序号，无法表达相反章序。
- **把教材目录做成数据库表**：目录是随源码评审的内容，放数据库会让“版本化 + 启动校验 + CI 检查”三件事同时失去；且本轮无写入需求。
- **在示例里填入真实教材的出版社/版次**：会被误读为已核实映射，直接违反需求 §6 决策 8/9。

## 4. 风险

- 两本示例教材若被教师误当成真实书目：界面徽标、章节页提示、ADR 与需求均写明“非教材”，且 `publisher/revision` 在 `illustrative` 下被校验器拒绝。
- 章 ID 是长期标识：改名会同时影响 URL（slug 另算）与目录引用；改章结构必须连同 placement 的引用一起评审。
- 顺序全部显式，写错顺序不会被“自动纠正”，只会在启动时因重复序号被拒绝；缺号（1,3）允许，因为编号可能是课程预留。
- 同一章内多个工具（未来）会用到 `order`；当前只有一条 placement/章，规则已就位但未被多工具实际检验。
