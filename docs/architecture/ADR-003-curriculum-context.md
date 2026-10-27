# ADR-003 — 课程上下文预置与按上下文保存参数（R7 纵向切片）

状态：已由项目负责人批准并实施（2026-10-27）。**数据布局（§D2 的 placement 内嵌 edition/book/chapter 与平面 order）已由 ADR-004（R8）取代**；本文的标识模型、快照作用域、保存/重置语义与“不得声称教材映射”的约束继续有效。覆盖 ADR-002 中“保存参数一份快照 + 显式恢复”的交互描述（数据面保留）。需求依据：`docs/requirements-v2.1.md` §3A、§4.5、§4.6、§6 决策 7/8。

## 1. 问题

同一个教学工具（如“一次函数/二次函数参数联动”）在课堂上会出现在**不同的教材位置**：某册某章先讲斜率与截距，另一章讲顶点。教师希望“从这一章点进来”就看到这一章该有的参数，而不是每次都从工具默认值开始拖。同时，教师个人的调参不应串到别的章节，也不应把章节的预置值当成自己的保存值。

要求同时满足：

- 工具只有一个稳定 ID 和一份代码，不复制实验；
- 教材“版本 / 册 / 章”是可浏览的目录条目，各自有稳定标识与可版本化的预置参数；
- 直接打开工具 URL 的老入口与老数据必须继续可用（不迁移、不覆盖、不复制）；
- 保存仍是显式动作，参数值不进诊断事件；
- 界面只留“保存参数 / 重置参数”两个控件，且载入是自动的。

## 2. 决策

### D1 工具 ID 与目录条目是两个标识

- 工具（experiment）：`math.functions`，稳定不变；收藏 `favorite`、最近使用 `recent_use`、诊断事件仍以它为单位。
- 章节位置（placement）：`math.functions.pilot-linear-slope` 这样的稳定 ID，**带整数版本**；URL 用更短且稳定的 slug：`/curriculum/pilot-linear-slope`。
- placement 不复制工具代码：目录条目只引用 `experimentId`，页面仍加载同一份 `view.tsx`。

### D2 目录数据是内容，不是代码

新增 `experiments/<folder>/curriculum.json`（与 `manifest.json`、`state-schema.json` 同级），由**服务端启动时**整体校验：

```json
{
  "schemaVersion": 1,
  "placements": [
    {
      "placementId": "math.functions.pilot-linear-slope",
      "slug": "pilot-linear-slope",
      "version": 1,
      "status": "illustrative",
      "order": 1,
      "edition": { "id": "pilot-edition", "labels": { "zh-CN": "…", "en": "…" } },
      "book":    { "id": "pilot-book-a", "labels": { "zh-CN": "…", "en": "…" } },
      "chapter": { "id": "pilot-chapter-a", "labels": { "zh-CN": "…", "en": "…" } },
      "title":   { "zh-CN": "…", "en": "…" },
      "summary": { "zh-CN": "…", "en": "…" },
      "preset":  { "mode": "linear", "a": 1, "b": 2, "c": 0 }
    }
  ]
}
```

校验规则（任一不满足 → 拒绝启动，与其他内容错误同一 `ContentIndexError` 通道）：

- `schemaVersion` 必须是 `1`；`placements` 必须是数组（可以为空）；
- `placementId` 形如 `math.functions.<suffix>`，全局唯一；`slug` kebab-case 且全局唯一（URL 唯一性）；`version`、`order` 为正整数，`order` 在同一工具内唯一；
- `status` 只能是 `illustrative` 或 `verified`；`edition`/`book`/`chapter` 必须各有 `id` 与两种语言的非空 `labels`；
- `title`/`summary` 两种语言都必须非空；
- `preset` 必须通过该工具 `state-schema.json` 的**同一** `validateStateValues()`（键集、范围、步长、枚举全查）。工具没有 state schema 却声明 placement → 启动失败（不能给出“有预置值但永远读不出来”的假目录）。

### D3 个人保存按上下文分表，不共用一行

新增迁移 `0002_placement_state.sql`（`0001_init.sql` 不动，校验和不变）：

```sql
CREATE TABLE IF NOT EXISTS placement_saved_state (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  placement_version INTEGER NOT NULL,
  content_version TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, placement_id)
);
```

为什么是新表而不是给 `saved_state` 加列：`saved_state` 的主键是 `(account_id, experiment_id)`，SQLite 改主键必须重建表；而“两个范围互不复制”在**两张表**上是结构性事实，在“一张表 + 空串标记”上只是约定。旧行原样保留，直接入口的行为与 R2 完全一致。

### D4 API 契约（全部在 `requireSession` 之后；写路由另加 CSRF 与按账号限速）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/curriculum?locale=zh-CN\|en` | 目录条目列表：`placementId, slug, version, status, order, experimentId, experimentSlug, contentVersion, stateSchemaVersion, title, summary, edition{id,label}, book{id,label}, chapter{id,label}, preset`（预置值本身是章节对使用者的承诺，不是个人数据；页面需要它来打开上下文） |
| `GET` | `/api/me/placement-state/:placementId` | 本账号在该章的快照；无 → 404；未知/非法 placement → 404/400 |
| `PUT` | `/api/me/placement-state/:placementId` | 体 `{placementVersion, stateSchemaVersion, values}`；返回规范化值；版本不匹配 409 `state_schema_incompatible`；值非法 400 `state_invalid` |

不提供 `DELETE`：界面上没有删除控件，重置也不删除；快照随账号级联删除。这三条路由登记进 `route-inventory.ts` 的受控清单（匿名一律 401）。

### D5 载入与重置的语义（覆盖 R2）

| 入口 | 无个人快照 | 有兼容快照 | 有但版本不兼容 |
|---|---|---|---|
| 直接 `/experiments/<slug>` | 工具默认值（`state-schema.json` 的 default） | **自动载入**个人工具级快照 | 工具默认值 + 说明 |
| 章节 `/curriculum/<slug>` | 该章预置值 | **自动载入**个人章级快照 | 该章预置值 + 说明 |

- “兼容”= `placementVersion`（仅章节）、`stateSchemaVersion`、`contentVersion` 三者与当前页面一致；页面加载完成前不渲染实验控件，避免“先默认值后跳变”。
- 顶部固定显示来源：`我的保存参数 / 本章预置值 / 工具默认值 / 旧版本已退回…`。
- “保存参数”读当前值 → 写本入口作用域；保存失败明说未保存。
- “重置参数”把**当前画面**恢复到本入口上下文默认值（重挂载视图，不写库、不删快照），保留已有快照；之后再“保存参数”才覆盖自己的那一份。
- 不提供“恢复我的设置 / 删除已保存设置”按钮。

### D6 页面与导航

- `/curriculum`：登录后可读的目录页，按“版本 / 册 / 章”分组展示条目，每条显示试点徽标、该章预置参数摘要，并提供到 `/curriculum/<slug>` 的链接（`<a>` + 客户端 `pushState`，可新标签打开）。
- 顶部导航新增“课程目录”，与“目录 / 我的 / 关于”同级；深链接由服务端 SPA 门禁与静态托管照旧处理。
- 章节页“返回”回课程目录，直接工具页“返回”回实验目录（旧行为不变）。

### D7 不做的事（刻意）

- 不实现章节级的收藏 / 最近使用 / 事件归属；工具 ID 仍是这些数据的键。`/me` 的最近使用仍打开直接入口。
- 不改实验内的原生控件与指针行为（滑块、模式切换、全屏保持原样）；不引入多点触控手势。
- 不做教材内容导入、章节编辑器、跨工具的统一课程树。
- 不实现删除快照的 UI/API；不提供“多份快照 / 历史版本”。

## 3. 兼容性与安全边界

- `GET/PUT/DELETE /api/me/saved-state/:experimentId` 与 `/experiments/<slug>` 行为不变；直接入口读写的仍是 `saved_state`。
- placement 一律先校验格式（pattern + 长度）再查索引：格式非法 400、未收录 404，两者都不回显其他账号的数据；所有 SQL 由会话派生的 `account_id` 限定。
- placement 是**内容元数据**，与 catalog 同级：匿名不可读。
- 预置参数值只在启动校验与页面载入时使用，不写 `event` 表（与 R2 相同的“参数不进诊断”约束）。

## 4. 验收与测试口径（与实现同批落地）

- API：目录列表（本地化、匿名 401）、恶意 placement ID（8 类载荷）、未知 404、跨账号隔离、placement 版本 / schema 版本 / 内容版本不匹配、schema 非法值、两个章节互不覆盖、工具级快照不被读取或复制、启动时非法目录/非法预置值拒绝启动。
- Web 单元：自动载入（不点按钮）、两个按钮存在且无恢复/删除控件、重置回到预置值且不调用删除、来源标签、版本不兼容回退、无 state schema 时不显示控件、路由解析 `/curriculum` 与 `/curriculum/:slug`。
- Playwright（真实进程 + 真实构建产物）：直接入口 + 两个章节入口各走一遍；保存 → 重新进入自动载入 → 重置回章节预置 → 快照仍在 → 再保存覆盖；直接入口看不到章节快照；`/me` 最近使用仍走直接入口。
- `npm run check`、`npm run smoke:api`、Playwright 全部退出码与通过数写入证据文件。

## 5. 风险与未决

- **示例条目不是教材映射**：目录里的两个条目是试点/示例，界面标注 `illustrative`。接入真实教材需要可核验书目（版本、册、章、页码）与人工评审，未做。
- **placement 版本升级**：现有快照会因 `placementVersion` 不匹配而退回预置值并提示；不做自动迁移。是否需要“章节重排时迁移旧快照”属后续决策。
- **快照无删除入口**：用户只能覆盖，不能清除章级快照。与 §6 决策 7 一致（只有保存/重置两个控件），但属已知的产品取舍。
- **内容变更**：修改 `curriculum.json` 的 slug 会让旧书签 404（这是有意的稳定标识规则）；修改放置的 preset 不会影响已保存的个人快照（预置值只作为默认值）。
