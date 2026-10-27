# ADR-006 — 章节（节）层级与六册人教版数学目录导入（R9 G3）

状态：已实施（2026-10-27，R9 G3）。依据：`docs/requirements-v2.1.md` §3A、§6 决策 7/8/9；R9 计划 `.hermes/plans/2026-10-27_141234-r9-six-volume-curriculum.md` 工序 2/3/4；核验记录 `docs/research/pep-math-six-volumes.md`（G1）。关系：**扩展 ADR-005**（D1 目录文件、D3 唯一性与排序、D4 单一事实源、D5 API 兼容、D6 双校验入口全部保留），不取代它；ADR-003 的保存/重置语义与「不得声称教材映射」不变。

## 1. 问题

ADR-005 的树只有 `catalog → book → chapter`，理由是「G3 需要时按同一模式扩展，不得用『章 = 节』的扁平化糊过去」。G3 拿到了六册真实目录后，扁平化会立刻说谎：

- 人教版新书一章有 2—5 节，**适配现有函数工具的只有 23.2（一次函数的图象和性质）与 26.2（二次函数的图象和性质）**。若把工具挂到「第二十三章 一次函数」这一层，页面会暗示整章（含 23.3 一次函数与方程、不等式）都由这个工具覆盖。
- 教师需要看到章下的节，才能判断「这一节有没有可用工具」，也才能对着课本第 117 页找到它。
- 目录里有 98 个编号节 + 10 个「综合与实践」。只有 2 个能放工具，其余必须照样显示为「暂无工具」，而不是从目录里消失。

另外，九下 2011 课标版与 2022 修订版**同号不同内容**（旧 26 反比例函数 / 新 26 二次函数），旧版首页也没有印页码、版次。ADR-005 已要求它单独成 catalog；目录里两个版次是**同层并列的教材条目**，各自写着出版社与版次（`revision`），不设「旧版专区」、旧版徽标或专属路由——版别是教材属性，不是界面分区。

## 2. 决策

### D1 新增 section 层级，节点仍只写一次

```json
{ "chapterId": "pep-math-8b-2026-ch23", "order": 23,
  "label": { "zh-CN": "第二十三章 一次函数", "en": "Chapter 23 Linear functions" },
  "printedPage": 113,
  "sections": [
    { "sectionId": "pep-math-8b-2026-ch23-s2", "order": 2,
      "label": { "zh-CN": "23.2 一次函数的图象和性质", "en": "23.2 Graphs and properties of linear functions" },
      "printedPage": 117 }
  ] }
```

- `sections` 可缺省（R7/R8 的示例目录就是只有章的树）；**出现时必须是完整可用的数组**，`sectionId` 在同一章内唯一、`order` 在同一章内唯一，任一违规拒绝启动、离线校验同判。
- `sectionId` 只在章内唯一即可：placement 必须同时给出 `bookId`/`chapterId`/`sectionId` 三元组 + 节，解析是精确匹配，**不按编号或标题回退**（与 ADR-005 D3 的章的规则一致）。
- 节的顺序由 `order` 决定，排序链变为 `subject → catalog.order → catalogId → book.order → bookId → chapter.order → chapterId → section.order → sectionId → 章内/节内 tool order → placementId`。章自身的入口（无 section）排在它的节之前。
- `printedPage` 可选，是**书上印的页码**（不是 PDF 页），只用于让教师翻到正确位置；研究文档记录两套页码的换算关系。

### D2 placement 可以指向节

`curriculum.json` 的 placement 增加**可选** `sectionId`。省略即「这一章本身」（R8 布局原样有效）；给出必须是该章已声明的节。位置唯一性键随之变为 `catalog/book/chapter/[sectionId|-]/order`：同一章的章级位置与节级位置是**不同的位置**，同一节内两个工具仍不能同槽（错误信息会指出是 chapter 还是 section）。

### D3 章仍列出章内全部工具（向后兼容）

`/api/curriculum` 的 `catalogs[].books[].chapters[].placementIds` 保留并**包含该章内所有入口**（含节内的），新增的 `sections[].placementIds` 只列本节自己的入口。理由：只认识「章」的客户端（G2 的打包产物、离线缓存）不会因为入口下沉到节而丢条目；新客户端用 `item.sectionId` 分流，`buildCurriculumTree()` 因此保证**每个入口恰好渲染一次**（有专门用例断言）。

### D4 `editionStatus`：版别是教材属性，不是界面分区

catalog 新增可选 `editionStatus`，取值只有 `current-2022` / `legacy-2011`，只作**数据层**的版别标识：API 原样输出，目录页在教材标题下的普通详情里显示出版社与 `revision`。**不设旧版/新版徽标、警示色、分组或专属路由**：两个版次在「数学 → 教材」下按 `order` 同层并列，各自册序章序独立；某个章节没有工具时只写「本节暂无对应工具」。`illustrative` catalog 声明 `editionStatus` 同样拒绝（示例不是印刷版次），与 publisher/revision 的规则一致。缺省表示「不是教材」。

### D5 六个真实册 = 两个 catalog

- `curricula/math/pep-math-2022.json` — catalog `pep-math-2022`，`current-2022`，`verified`：七上（2024）、七下（2025春）、八上（2025秋）、八下（2026春）、九上（2026秋）五册，章号 1—30 连续。
- `curricula/math/pep-math-9b-legacy.json` — catalog `pep-math-9b-legacy`，`legacy-2011`，`verified`：九下 2011 课标版，章号 26—29。它与 `pep-math-2022` 在目录里是**同层的两个教材版次**（`order` 1、2），不是「新版专区 + 旧版专区」，也不并成一册连续目录。
- 示例目录 `pilot-illustrative.json` 保留，`order` 由 1/2 改为 **3/4**：真实教材在前，示例在后。这是本轮唯一改动示例数据的地方；四条示例 placement 的 ID/slug/version/status/preset 一字未改（有针对性用例逐一断言），旧 URL 与 `placement_saved_state` 快照继续有效。

### D6 只放两个适配入口

`experiments/math-functions/curriculum.json` 新增两条（共 6 条）：

| placement | 位置 | 预置 |
|---|---|---|
| `math.functions.pep-8b-ch23-s2-linear-graph` (`pep-8b-23-2-linear-graph`) | 八下 23.2 一次函数的图象和性质（印刷 p.117） | `linear, a=2, b=1, c=0` |
| `math.functions.pep-9a-ch26-s2-quadratic-graph` (`pep-9a-26-2-quadratic-graph`) | 九上 26.2 二次函数的图象和性质（印刷 p.33） | `quadratic, a=1, b=-4, c=3` |

判定依据是「工具确实画得出这一节的对象」：一次函数直线（斜率 k、截距 b）与抛物线（开口、对称轴、顶点）。**23.3 一次函数与方程（组）、不等式、22.1 函数的概念、26.3 二次函数与一元二次方程一律不映射**——工具不演示它们的关系，映射就是虚假覆盖。其余 106 个节节点保留为空（`placementIds: []`），界面写「本节暂无对应工具」。

### D7 verified 的依据与限制（本轮唯一的口径判断）

`verified` 要求「已核实的出版社与版次」（requirements §3A）。本轮：出版社「人民教育出版社」由六册版权页文本层直接读到；**版次不能从 PDF 内部证明**（版权页无版次/印次/书号文本，见研究文档 §6）。因此 `revision` 字段写明判断依据本身，而不是伪造一个印刷版次：

- 新版：`2022 年课标修订版（2024—2026 年陆续启用；版别依据册别与章号结构判定，版权页未印版次）`
- 九下：`2011 年课标版（2027 年新版尚未出版；章号自第二十六章起重新编号）`

另一方面，章节标题、章序、节序与印刷页码来自「目录页 + 正文页」双重复核（98/98 命中，唯一例外是九上第二十五章图版章首页）。仍**未**与出版社在线阅读器比对（滑块验证，按纪律不破解），故置信度是「本地镜像 PDF 双重核对」，不是「官方 PDF」。该限制写在两个 catalog 文件的 `note`、研究文档 §1/§6 与本 ADR，不得在其他材料里说成「已与官方核对」。

## 3. 被否的替代方案

- **把节压平成章**：工具会被挂到整章，页面暗示 23.3/23.4 也由它覆盖；且章的 `printedPage` 与节的页码混为一谈。ADR-005 已明令禁止。
- **新增独立「节」catalog 或第二棵树**：同一本书会出现两处顺序来源，违反 ADR-005 D4。
- **让 chapter.placementIds 只列章级入口**：G2 打包产物会把 23.2 的入口显示成「本章暂无工具」——一句假话。
- **用 catalogId 前缀判断版别**：界面靠字符串约定推断语义，改个 id 就静默改语义；改用受校验的 `editionStatus` 作数据字段。
- **为了「目录看起来满」给 22.1/23.3 建占位工具**：计划明确禁止把空章伪装成有资源。
- **九下按 2027 新版标注**：该版尚未出版，本地也没有文件，任何此类标注都是编造。

## 4. 风险与边界

- **仍无九下 2027 新版**：目录里九年级下册这一册用的是 2011 课标版，版次写在 catalog 的 `label`/`revision` 里；将来拿到 2027 新版时新增第三个 catalog（`pep-math-9b-2027`），2011 版保留为历史版次。两者同样是同层教材条目。
- **页码是印刷页码**：九上第二十五章章首页为图版、九下四章章页未印页码（由正文反推），研究文档已逐条标注；目录不据此改写任何标题。
- **目录不含教材内容**：只存短标题、序号、印刷页码；不含正文、例题、习题、插图，也不托管 PDF。工具页仍是项目原创实现，摘要里明说「不含教材插图/例题/习题」。
- **示例目录仍在产品里**：它是 R8 兼容与「同名不同序」回归的对照组，徽标写「试点/示例（非教材章节）」。若将来下线，需同时保留 `placement_saved_state` 的迁移说明。
- **`chapter.placementIds` 是超集**：客户端必须按 `item.sectionId` 分流后渲染，否则会重复渲染；前端已有「每个入口恰好一次」的用例。

## 5. 本轮实测（非推断）

见 `docs/evidence/r9/g3/`：`red-api.txt`、`red-web.txt`、`check.txt`、`smoke-api.txt`、`e2e.txt` 与截图。目录计数由 `npm run validate:content` 输出：4 catalogs、`curriculum tree: 38 chapters, 108 sections`（34 章 + 4 示例章；98 编号节 + 10 综合与实践）、`math.functions: 6` placements。
