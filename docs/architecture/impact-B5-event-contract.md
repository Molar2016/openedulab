# 影响分析：B5 事件契约变更（ADR-001 → 设计 §10）

日期：2026-10-26。状态：已实施（B5）。依据：`docs/architecture/A-stage-design.md` §6.1/§10、`docs/requirements-v2.1.md` §3B、`docs/architecture/ADR-001-experiment-contract.md`。

## 为什么要改

原型契约（`apps/web/src/experiment/contract.ts` 的 v1）定义了 6 个事件类型：`experiment_open`、`experiment_interact`、`experiment_reset`、`experiment_fullscreen`、`experiment_error`、`experiment_complete`。需求 v2.1 §3B 要求的是**能回答产品问题**的最小事件集：

| 产品问题 | 需要的数据 |
|---|---|
| 哪些资源真被用到 | `experiment_open` 按 `experiment_id` 的**账号数** |
| 打开后是否动手 | 同一 `visit_id` 里 open 与"首次实质交互"的比例 |
| 哪些控件真被用 | 控件**类别**首次使用（不是每次拖动） |
| 复位频率（重复演示 vs 操作困难） | `experiment_reset` 次数 |
| 投影/课堂的弱信号 | 全屏进出 |
| 版本回归 | `client_error` 与 `content_version`、`app_version` 交叉 |
| 反馈类型分布 | `feedback_submitted` + 类别 |

原型契约满足不了其中两条：`experiment_interact` 把"首次交互"和"控件类别"混在一个事件里（且没有 `visit_id`，无法算转化），`experiment_complete` 在探索性工具里没有可靠语义（按钮点一下就叫完成，会制造伪指标）。

## 改了什么

| 变更 | 影响范围 |
|---|---|
| 删除 `experiment_complete` | 契约枚举；实验页的"完成"按钮与文案；`tests/e2e`、`tests/host.test.tsx` 中相关断言 |
| `experiment_interact` → `experiment_first_interaction`（每次访问 ≤1 条）+ `experiment_control_used`（每访问每控件类别 ≤1 条） | 契约枚举、analytics adapter、实验视图的 `track` 调用、宿主事件断言 |
| `experiment_error` → `client_error`，错误码白名单改为 `render_error/model_error/unknown_error/incompatible_sdk/manifest_invalid` | 契约枚举、错误边界与全局异常上报 |
| 全屏方向改用 `controlGroup='fullscreen_enter'|'fullscreen_exit'`，不新增列 | 契约 `ControlGroup` 枚举、宿主全屏事件 |
| 事件新增 `contentVersion`（= manifest 的 `contentVersion`）；`moduleVersion` 不再作为内容版本使用 | 服务端事件表已有 `content_version` 列；manifest 在 B3 已加该字段；上传批次带 `contentVersion` |
| 客户端不再直连事件端点，一律经宿主 adapter 批量发送 | `services/analytics.ts`（新增远端 sink）、`main.tsx` |

数据库**不需要新迁移**：`0001_init.sql` 的 `event` 表已经有 `event_type` CHECK（正是设计 §6.1 的 7 值）、`control_group`、`interaction_bucket`、`error_code`、`issue_category`、`device_class`、`visit_id`、`client_event_id`、`dedupe_key`、`occurred_at_min`、`received_at`。B5 只写这些列。

## 兼容与回退

- 事件是**尽力而为**的诊断数据：客户端发送失败、服务端 429/503 或事件开关关闭时，实验、收藏与最近使用都不受影响（有单独测试）。
- 旧事件不变更、不迁移：B5 之前没有任何事件写入（表为空），因此不存在旧枚举数据需要清洗。
- 若将来要恢复"完成"语义，需先定义可观测的完成判据，再新增迁移与事件类型；本次不保留该类型，避免空指标。
- 回退方式：`OEL_EVENTS_ENABLED=false` 让事件端点只回答 `202 {accepted:0}` 而不落库（运维开关），前端仍照常工作；代码回退只需还原 adapter 的 sink。

## 明确不做

分钟级/逐次参数轨迹、滑块数值、自由文本、URL 查询串、UA 原文、IP、设备指纹、屏幕录像、跨站追踪。参数值只有在用户**显式**保存设置时才属于个人数据（B7 可选功能），不进入事件表。
