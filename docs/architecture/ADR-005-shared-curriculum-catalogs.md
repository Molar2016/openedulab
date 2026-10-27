# ADR-005 — 学科级教材目录（目录与工具解耦，R9 G2）

状态：已实施（2026-10-27，R9 G2）。依据：`docs/requirements-v2.1.md` §3A、§4 第 8 条、§6 决策 8/9；R9 计划 `.hermes/plans/2026-10-27_141234-r9-six-volume-curriculum.md` 工序 2。关系：**取代 ADR-004 的数据布局部分**（D2「目录声明在工具自己的 `curriculum.json`」、D3 中「placement 引用的目录必须声明在同一文件」、D8 第一条「一个 collection 文件只服务一个工具文件夹」），保留 ADR-004 的标识模型、快照作用域、出处规则（D5）、API 字段（D6）与界面约束（D7），也保留 ADR-003 的「不得声称教材映射」与保存/重置语义。

## 1. 问题

ADR-004 把教材树放进了工具自己的 `curriculum.json`。这在 R8 的两个示例目录上够用，但它让**目录成为某个工具私有的附加物**，与 R9 要做的事直接冲突：

- **没有工具的章不存在**：目录只能随某个工具的 placement 一起出现，于是「这本教材有第二十三章、但还没有对应工具」这种真实状态无法表达。结果是目录残缺，页面上看不到还没做工具的章节。
- **一章不能放两个工具**：同一章若想同时编排两个实验（例如一次函数与它的图象），第二个工具必须复制一份册/章，目录里就出现两条同名章节，教师看到的是重复行而不是同一章的多个入口。
- **每个工具都要重复整棵树**：同一本教材若被多个工具引用，书序/章序要在每个工具的 `curriculum.json` 里各写一遍，任何一处写错都会让同一本教材在不同工具下顺序不一致；R9 要接入六册、几十章、上百节，这种重复不可维护。
- **跨文件引用被当成错误**：ADR-004 明确拒绝「引用别处声明的教材」，而这恰好是学科级目录的正常需求。

## 2. 决策

### D1 目录是学科级内容：`curricula/<subject>/<file>.json`

```
curricula/
  math/
    pilot-illustrative.json      # 学科 = 目录所在目录名
```

```json
{
  "schemaVersion": 1,
  "subject": "math",
  "note": "…",
  "catalogs": [
    {
      "catalogId": "pilot-edition", "subject": "math", "version": 1,
      "status": "illustrative", "order": 1,
      "label": { "zh-CN": "…", "en": "…" },
      "books": [
        { "bookId": "pilot-book-a", "order": 1, "label": { … },
          "chapters": [ { "chapterId": "pilot-chapter-a", "order": 1, "label": { … } } ] }
      ]
    }
  ]
}
```

- 一个文件只描述**一个学科**：目录名即学科，文件里的 `subject` 必须与其一致，每个 catalog 的 `subject` 也必须与其一致。三处任一不一致即拒绝启动/拒绝通过离线校验。
- 目录树在**没有任何工具**时也成立：加载器先读 `curricula/`，再读工具。因此「章存在但暂无工具」是正常状态，`/api/curriculum` 的 `catalogs[].books[].chapters[]` 会给出该章（`placementIds: []`），界面显示章名与「暂无对应工具」。
- 目录文件不引用任何工具：谁被放进来由各工具的 placement 决定，目录本身不知道工具的存在。

### D2 工具的 `curriculum.json` 只放 placement（schemaVersion 3）

```json
{
  "schemaVersion": 3,
  "note": "…",
  "placements": [
    { "placementId": "math.functions.pilot-linear-slope", "slug": "pilot-linear-slope",
      "version": 1, "status": "illustrative",
      "catalogId": "pilot-edition", "bookId": "pilot-book-a", "chapterId": "pilot-chapter-a",
      "order": 1, "title": { … }, "summary": { … }, "preset": { … } }
  ]
}
```

- `schemaVersion: 2` 及更早（目录内嵌）一律拒绝，并在错误里指出目录已迁到 `curricula/<subject>/`。
- 一个工具文件里出现 `catalogs` 键不是「未知字段」而是**已退役布局**，给出指向本 ADR 的明确报错，而不是让人猜。
- R8 的四条 placement（ID、slug、`version`、`order`、`preset`、`status`）**逐字保留**，`/curriculum/<slug>` 旧链接与 `placement_saved_state` 里的个人快照继续有效；`/api/curriculum` 的 `items` 字段与 `catalogs` 结构不变。

### D3 顺序与唯一性（启动 + 离线校验同规则）

| 约束 | 作用域 | 违反后果 |
|---|---|---|
| `catalog.order` 唯一 | **学科内跨文件** | 拒绝：`catalog order N is already used by "id" (in <file>)` |
| `catalogId` 唯一 | **全仓库跨文件** | 拒绝：`duplicate catalogId "id" (also declared by <file>)` |
| `book.order` 唯一 | 同一 catalog | 拒绝 |
| `chapter.order` 唯一 | 同一 book | 拒绝 |
| `chapterId` 唯一 | 同一 catalog（跨册也不得重名） | 拒绝，防止同名章把入口指向另一册 |
| placement 的 `order` 唯一 | **同一章、跨工具** | 拒绝：`tool order N is already used by "<placementId>"` |
| placement 的三元组精确命中 | 所属 catalog | 拒绝；章在另一册时写明所属册，**绝不按名字回退** |
| placement 的 `catalogId` 必须被某个目录文件声明 | 全仓库 | 拒绝：`unknown catalog` |
| catalog 的 `subject` 必须是工具 manifest `subjects` 之一 | 每个 placement | 拒绝：数学工具不能被放进物理教材 |
| placement 的 `status` 等于所属 catalog 的 `status` | 每处 | 拒绝 |

排序（服务端索引与 `/api/curriculum`）：`subject` → `catalog.order` → `catalogId` → `book.order` → `bookId` → `chapter.order` → `chapterId` → 章内 `order` → `placementId`。

### D4 一类问题只有一处事实源

- 目录的册/章结构、章名、书序、章序、版别状态**只在 `curricula/` 里写一次**。工具文件里重复写一遍标签是 R7/R8 的遗留问题，本次不再允许。
- 章内的工具顺序写在 placement 上（同一章可被多个工具共享，但同一位置只能有一个工具）。
- 一个 catalog 的 `status` 仍然决定其内所有 placement 的 `status`；`illustrative` 下写 `publisher/revision` 依旧拒绝，`verified` 两者必填（ADR-004 D5 不变）。

### D5 API 与界面不变

- `GET /api/curriculum?locale=` 仍是 `{ items, catalogs }`：`items` 字段名与含义不变（新增字段照旧保留），`catalogs` 仍只带 `placementIds` 而非入口正文。**没有新路由**，`/api/me/placement-state/:id`、`/api/me/saved-state/:id`、收藏/最近使用/事件全部未改，**没有新迁移**。
- 前端类型与 `buildCurriculumTree()` 不需要改动：它本来就是按 `catalogs` 渲染、把空章保留为空章。G2 因此**没有改** `apps/web`。
- 页面文案仍不得暗示站内可读教材正文；本轮没有新增教材内容或新工具入口。

### D6 校验入口

- 启动：`loadContentIndex()` 先读 `<contentDir>/../curricula/`（可用 `curriculaDir` 覆盖），再逐工具解析 placement。
- 离线：`npm run validate:content` 用同一套规则读 `curricula/`，并可用 `OEL_VALIDATE_ROOT` 指向临时仓库夹具（测试用），默认仍是仓库根。
- 两处都必须拒绝同一批错误：重复的 catalog 顺序、重复的 catalogId、重复的章内位置、指向不存在目录/册/章的引用、学科不一致、退役的 schemaVersion。`apps/api/test/validate-content.test.ts` 对这四类错误逐条断言离线校验退出码 1。

## 3. 被否的替代方案

- **保留 `schemaVersion: 2`（目录内嵌）并额外支持共享目录**：两处能声明同一棵树，必然出现「同一章两个定义」与顺序双源；而且旧路径会一直有人用，校验无法说清以哪份为准。直接停用，报错指向迁移位置。
- **把目录做成数据库表**：目录是随源码评审的内容，放数据库会让版本化、启动校验与 CI 检查同时失效（ADR-004 已否决，本轮理由不变）。
- **让工具文件引用另一个工具文件的目录**：引用目标随工具增删而消失，也无法表达「目录里暂时没有工具」的章；学科级文件正是为此存在。
- **按目录文件顺序决定教材顺序**：文件顺序不是可评审的显式声明；顺序仍只来自 `order`，重复即拒绝。

## 4. 风险与边界

- **本 ADR 只做基础设施**：`curricula/math/pilot-illustrative.json` 里仍是 R8 的两本**示例**目录；六册人教版教材目录（34 章 / 98 节）尚未导入，也没有新增任何适配入口——那是 R9 G3，且导入前必须先完成目录核对与学科正确性评审。
- **九下旧版**（现行 2011 课标版本）与新版五册不同版别，G3 必须放在独立 catalog 并清楚标注版别，不得与新版连续显示为同一套教材；本 ADR 的 `catalogId`/`status`/`label` 结构足以表达，但需要 G3 的真实目录数据。
- **章 ID 是长期标识**：改名会同时影响引用与 URL（slug 另算）。跨册重名被拒绝；跨版本允许同名章号但 `catalogId` 不同，placement 的三元组保证不会串版本。
- **节（section）层级尚未支持**：G3 需要时按同一模式扩展（`sections[]` + placement 指向 section），不得用「章 = 节」的扁平化糊过去。
- 学科目录目前只有 `math`；加载器对任何合法学科标签都成立，但没有第二个学科的真实数据前不做跨学科声明。

## 5. 本轮实测（非推断）

- RED：新增 `apps/api/test/curriculum-catalogs.test.ts`（16 条）与 `apps/api/test/validate-content.test.ts`（5 条），实现前 19 失败 / 2 通过（证据 `docs/evidence/r9/g2/red-api.txt`）。
- GREEN：API **26 文件 / 396 测试**（R8 为 374）；web **12 文件 / 141 测试**；`npm run validate:content` OK（`curriculum catalogs: 2 (curricula/math/pilot-illustrative.json (2))`、`placements: math.functions: 4`）；`npm run check` 退出码 0（`docs/evidence/r9/g2/check.txt`）。
- `npm run smoke:api` **127/127**（`docs/evidence/r9/g2/smoke-api.txt`）：其中第 6b 节仍断言「四条目、两目录、相反章序、illustrative 无出版社」，说明 R8 的 ID 与 `items` 契约未被这次搬迁破坏。
