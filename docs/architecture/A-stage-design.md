# A 阶段设计：已认证教学平台的权限、数据与接口契约

状态：架构设计（可据以实施，但**不授权生产部署**）。日期：2026-10-26。
依据：`docs/requirements-v2.1.md`（产品基线）、`docs/architecture/ADR-002-authenticated-platform.md`（宏观边界与阶段门禁）、`docs/architecture/A-stage-audit.md`（原型实测审计）、`docs/CHARTER-v1.md`（原件，冲突处按需求基线 v2.1 优先）。
本文只覆盖 A 阶段交付：权限矩阵、数据/事件字典、认证与会话与滥用控制、API 契约、数据库选型论证、迁移与备份、可测试追溯、B 阶段顺序、未决问题。**不修改应用代码、不启动服务、不接触生产。**

---

## 0. 本文的边界

| 本文做 | 本文不做 |
|---|---|
| 把需求 v2.1 落成可实现的表、接口、判据 | 写业务代码、跑通登录、出截图 |
| 明确“个人数据”与“诊断事件”的物理/逻辑隔离 | 选生产服务器、开端口、配 HTTPS/域名 |
| 给出本地开发与将来服务器两种数据库路径及其**不承诺事项** | 声称“以后可无缝切换数据库” |
| 给出 B 阶段可逐条关门的顺序 | 承诺上线时间、公网 URL |
| 记录影响架构的未决问题与默认取值 | 替用户决定地域、留存年限、未成年人政策 |

可复用/需改造/废弃的结论沿用 `A-stage-audit.md`，本文只补契约层面的差异（见 §10）。需求优先级冲突一律按 v2.1：**强制登录覆盖章程的免登录与离线**，离线另行专题。

---

## 1. 技术决策摘要

每条都是“已决定”，并附理由与可回退性；影响产品/成本/公开上线的才上交（见 §13）。

| ID | 决策 | 理由 | 回退代价 |
|---|---|---|---|
| D1 | 模块化单体：一个 Node 进程同时提供 `/api/*` 与构建后的 SPA 静态文件，同源 | 无 CORS、Cookie 语义简单、单机部署最省运维；ADR-002 明确不先拆服务 | 拆出静态托管需处理跨源 Cookie 与 CORS，中等 |
| D2 | 服务端 Node 22 + TypeScript + Fastify 5；请求/响应用 zod 校验 | 与前端同语言共享类型；Fastify 自带 schema 校验、hook、成熟的 cookie/rate-limit 插件；比手写 `node:http` 少犯安全错 | 换框架主要影响路由层，低 |
| D3 | 本地开发数据库 SQLite（`node:sqlite`，WAL）；生产候选 PostgreSQL，**A 阶段不承诺可切换** | 见 §8 实测：`node:sqlite` 免原生编译、支持 upsert/`VACUUM INTO`；服务器参数未知 | 见 §8.4，必须重跑迁移与授权测试 |
| D4 | 服务端会话：DB 存 `sha256(token)`，浏览器只持 HttpOnly Cookie；不用 JWT | 可即时撤销、可枚举、可强制下线；JWT 无法可靠撤销且易被误放 localStorage | 低（表已在） |
| D5 | 口令 scrypt（N=2^15, r=8, p=3），哈希串自描述参数 | 零原生依赖（Windows 开发机不折腾 node-gyp）；参数可升级、登录时自动重哈希 | 换 argon2id 需加依赖并保留旧校验分支，中 |
| D6 | 私有 API **永不接受** 路径/请求体里的 `account_id`，一律从会话派生 | 结构性消灭 IDOR：没有可篡改的他人标识 | 无（是约束不是实现） |
| D7 | 个人数据表与诊断事件表物理分表、分路由、分一致性等级，禁止互相回填 | 需求 v2.1 §3 明令：事件不能拿来凑“我的最近使用”，UI 也不读事件 | 高（数据污染后难拆） |
| D8 | 事件白名单 + 服务端二次校验 + 服务端时间戳（分钟粒度）+ 批量上限 | 客户端不可信；不存滑块值、文本、URL 查询串 | 低 |
| D9 | 维护者权限 = 环境变量 Bearer token，独立于账号体系；未配置时运维路由返回 404 | 首版不做图形后台；“不分师生”≠所有人能看诊断 | 未来加角色表，中 |
| D10 | 实验注册表（manifest 文件）是内容唯一事实源；`event` 不对 `experiment` 建外键 | 内容随代码版本走，不进货表；实验下线后历史事件仍可聚合 | 低 |
| D11 | 迁移 = 编号 SQL 文件 + 校验和 + 单事务；只用 SQLite/PG 共同子集 | 无 ORM 迁移漂移；校验和防止改历史迁移 | 低 |
| D12 | 备份：SQLite `VACUUM INTO` 定时快照 + 异机复制 + 恢复演练脚本；PG 用 `pg_dump -Fc` | 一致快照不需要停写；演练可验证而不是“以为有备份” | 低 |
| D13 | 参数快照走 `serializeState()/restoreState()`，带 `content_version` + `state_schema_version`，超限/不兼容回退默认并提示 | 需求 v2.1 §4.5；插件升级不能弄坏旧状态 | 低（可延后实现） |
| D14 | 单实例假设：限速与节流在进程内，会话以 DB 为准 | 首版并发低；多实例需要共享限速器，属未决（§13-Q6） | 中，需引入共享存储 |

明确**不做**（首版）：邮件/短信发送、找回密码、换绑、账号自助删除/导出、管理后台 UI、PWA/离线、教师/学生角色区分、第三方统计 SDK。

---

## 2. 系统边界与运行形状

```
Browser (React SPA，构建产物由同一进程托管)
   │  同源 HTTPS，Cookie: __Host-oel_sid (HttpOnly, Secure, SameSite=Lax)
   ▼
Fastify 进程
   ├─ /api/auth/*        注册 / 登录 / 登出 / 会话查询      [凭据接口，限速最严]
   ├─ /api/catalog       目录与筛选（需登录）
   ├─ /api/experiments/:id  实验元数据 + 内容版本（需登录）
   ├─ /api/me/*          收藏 / 最近使用 / 参数快照         [强一致，账号派生]
   ├─ /api/events        诊断事件批量接收                   [尽力而为，可丢]
   ├─ /api/feedback      主动反馈（结构 + 长度受限文本）
   ├─ /api/internal/*    运维查询/导出（Bearer token，默认 404）
   └─ /*                 SPA 静态文件 + 深链接门禁
   ▼
DB: accounts / sessions / favorites / recent_use / saved_state / events / feedback / internal_audit
```

**诚实的边界声明**：登录门禁保护的是*资源目录元数据、实验元数据接口、个人数据、诊断数据*。已下载到浏览器的 JS 包本身是公开文件，无法用登录阻止有意的技术用户阅读实验代码。因此“未登录不能访问实验”在执行层面等于：HTML 深链接在服务端 302 到登录页、目录与实验 API 401、SPA 路由守卫；不宣称能保护前端源码。这一条必须写进验收口径，避免把不可能的安全承诺当成 bug 反复返工。

### 2.1 目录布局（B 阶段落地目标，不建空包）

```
apps/api/                 # 服务端：路由、领域、DB、迁移、脚本
  src/{app,http,domain,db,security}/
  migrations/0001_init.sql
  test/
apps/web/                 # 复用原型：现有 src 结构 + 新增 auth/me 页面
experiments/math-functions/
packages/contract/        # 共享：事件枚举、错误码、DTO 类型（唯一事实源）
docs/architecture/*.md
scripts/                  # backup / restore-check / retention-purge
```

不设 `packages/analytics`、`packages/observability` 等空包（章程 §7 明令按实际代码量调整）。

---

## 3. 身份与权限矩阵

### 3.1 主体定义

| 主体 | 取得方式 | 说明 |
|---|---|---|
| 匿名访客 (ANON) | 无会话 | 仅首页宣传与登录/注册页 |
| 普通账号 (USER) | 手机或邮箱 + 口令自注册，**不验证归属** | 无角色字段；`account.status='active'` |
| 被停用账号 (DISABLED) | `status='disabled'` | 会话立即失效，登录返回统一失败 |
| 维护者 (OPS) | 环境变量 `OEL_OPERATOR_TOKEN` | 不在账号表内，不参与收藏/事件；无 Cookie 路径 |
| 其他账号 (OTHER) | 另一个合法会话 | 用于验证隔离 |

### 3.2 动作矩阵（✔ 允许 / ✘ 拒绝 / — 不适用）

| 资源 / 动作 | ANON | USER(本人) | OTHER | DISABLED | OPS |
|---|---|---|---|---|---|
| 首页宣传、登录页、注册页 | ✔ | ✔ | ✔ | ✔ | ✔ |
| `POST /api/auth/register` | ✔（限速） | ✘ 409 已有会话 | ✔ | ✔ | — |
| `POST /api/auth/login` | ✔（限速） | ✘ 409 | ✔ | ✘ 统一失败 | — |
| `POST /api/auth/logout` | ✘ 401 | ✔ 204 | ✔ | ✔ | — |
| `GET /api/auth/session` | ✔ 200 `{authenticated:false}` | ✔ 200 掩码标识 | ✔ | ✔(空) | — |
| `GET /api/catalog`、`/api/experiments/:id` | ✘ 401 | ✔ | ✔ | ✘ 401 | ✔(经 internal 通道) |
| SPA 深链接 `/experiments/:slug` | 302 `/login?next=` | ✔ | ✔ | 302 | ✔ |
| `GET /api/me/favorites` | ✘ 401 | ✔ 仅本人 | ✔ 仅本人（看不到对方） | ✘ 401 | ✘ 404 |
| `PUT/DELETE /api/me/favorites/:expId` | ✘ 401 | ✔ 幂等 | ✔ 只改自己 | ✘ 401 | ✘ |
| `GET /api/me/recent`、`POST /api/me/recent` | ✘ 401 | ✔ 去重 upsert | ✔ 只写自己 | ✘ 401 | ✘ |
| `GET/PUT/DELETE /api/me/saved-state/:expId` | ✘ 401 | ✔ 本人单快照 | ✔ 只碰自己 | ✘ 401 | ✘ |
| `POST /api/events` | ✘ 401（不产生匿名事件） | ✔ 202 | ✔ 记到自己 | ✘ 401 | ✘ |
| `POST /api/feedback` | ✘ 401 | ✔ | ✔ | ✘ 401 | ✘ |
| `GET /api/internal/*`（汇总/导出/单账号定位） | ✘ 404 | ✘ 404 | ✘ 404 | ✘ 404 | ✔ Bearer |
| 读 `events` 原始表 | — | ✘ | ✘ | — | ✔ 仅经审计记录 |
| 关掉前端分析通道 | — | ✔（本人可见开关，首版仅 no-op 降级） | ✔ | — | — |
| 停用账号 / 执行留存清理 | ✘ | ✘ | ✘ | — | ✔ 仅 CLI（不在 HTTP 暴露） |

### 3.3 授权实现点（防“前端隐藏=权限”）

1. **每个私有路由**用统一 preHandler `requireSession()`：解析 Cookie → 哈希 → 查 `session`（`revoked_at IS NULL AND expires_at > now`）→ 关联 `account.status='active'` → 把 `account_id` 放进请求上下文。**路由处理器签名里拿不到 account_id 之外的账号标识**。
2. 个人资源以 `(account_id, experiment_id)` 为主键，SQL 恒带 `account_id = ctx.accountId`；不存在“按 id 取别人行”的代码路径。
3. 越权访问他人资源返回 **404 而非 403**（避免存在性泄露）；跨账号在数据模型上不可表达。
4. SPA 守卫只负责体验，**不作为安全边界**；所有数据由 API 再判一次。
5. 运维路由单独注册，`OPS` 未配置时整体不挂载或统一 404；不使用 Cookie，不参与 CSRF 面。

---

## 4. 认证、会话与滥用控制

### 4.1 标识规范化（不验证归属）

| 类型 | 规范化 | 校验 | 存储 |
|---|---|---|---|
| `email` | `trim` + 全小写，不删点号 | 长度 ≤254，`local@domain` 且含一个 `.`；不做 RFC 5322 全量 | `normalized_login` 唯一；另存 `display_hint`（`a***@d.com`） |
| `phone` | 去空格/连字符/括号，允许前导 `+`，只留数字与 `+` | 7–20 位数字 | 同上；`display_hint` = 前 3 + `****` + 后 4 |

- `login_kind + normalized_login` 联合唯一（`UNIQUE(login_kind, normalized_login)`），跨类型不互相占用（`+8613...` 与邮箱不可能撞）。
- 账号有内部随机 `id`（UUIDv4）；手机/邮箱**不进 URL、不进事件、不回显完整值**。
- 预留 `verified_at`（NULL）供将来短信/邮件验证；文案始终写“未验证的账号标识”，不出现“已验证手机号”。

### 4.2 口令

- 规则：长度 10–128 字符，允许任意字符与空格，不做复杂度强制（长度优先，减少课堂演示时的输入摩擦）；拒绝纯空白。
- 存储：`scrypt$32768$8$3$<salt_b64>$<hash_b64>`，salt 16B，key 32B，`maxmem=64MiB`。自描述参数 → 将来提参或换算法可登录时重哈希。
- 比较：`crypto.timingSafeEqual`；**用户不存在或已停用也执行一次等价的假哈希校验**，抹平“存在/不存在”的时序差。
- 口令永不出现在日志、事件、错误信息、导出；请求体在日志层整体屏蔽。

### 4.3 会话

| 项 | 取值 | 说明 |
|---|---|---|
| Token | 32 随机字节 base64url | 只回 Cookie，不回 JSON |
| 存储 | `sha256(token)` | 库泄露不能直接复用会话 |
| Cookie 名 | 生产 `__Host-oel_sid`；本地 `oel_sid` | `__Host-` 强制 Secure/Path=/ 无 Domain |
| 属性 | `HttpOnly; Secure(HTTPS); SameSite=Lax; Path=/` | 无 `Domain` |
| 绝对过期 | 60 天 | 课堂/家用长期复访 |
| 空闲过期 | 14 天 | 每次请求若 `last_seen_at` 距今 >1h 才更新，避免每请求写库 |
| 登录 | 新建 session，不复用旧 token | 防会话固定 |
| 登出 | `revoked_at=now` + 清 Cookie | 服务端为准，前端清态不算 |
| 停用账号 | 立即 `revoke` 该账号全部 session | 授权每次查 `account.status` |

### 4.4 CSRF / 跨站

- `SameSite=Lax` + 全部写操作要求 `Content-Type: application/json`（表单无法伪造该类型且不触发预检）+ 校验 `Origin` 命中 `OEL_PUBLIC_ORIGIN`（同源开发则用 `http://localhost:<port>`）+ 有 `Sec-Fetch-Site` 时必须是 `same-origin`/`none`。
- 不引入 CSRF token 表：本系统无跨站表单、无第三方嵌入，上述三重已覆盖；若将来嵌入第三方页面或需要 `<form>` 提交，必须先补 token（记录为升级条件，而不是“以后再说”）。

### 4.5 限速与滥用控制

| 动作 | 维度 | 阈值 | 超限响应 |
|---|---|---|---|
| `register` | IP | 5/小时，20/天 | 429 `rate_limited` + `Retry-After` |
| `register` | `login_kind+normalized` | 3/天 | 429 |
| `login` | 标识+IP | 10/15 分钟 | 429 |
| `login` | IP | 30/15 分钟 | 429 |
| 连续失败 | 标识 | 10 次/15 分钟 → 临时锁 15 分钟 | 429（**文案与 401 不同**，避免用户反复试） |
| `logout`/`session` | IP | 300/分钟 | 429 |
| 收藏写 | 账号 | 60/分钟 | 429 |
| 最近使用写 | 账号 | 120/分钟 | 429 |
| 事件 | 账号 | 120/分钟，单批 ≤20，体 ≤8KB，日上限 3000 | 429 或 `202 {accepted:0}`（见 §7.6） |
| 反馈 | 账号 | 5/小时，正文 ≤2000 字符 | 429 |
| `internal/*` | token | 60/分钟 | 429 |

配套：全局限体上限 64KB（事件 8KB）；不支持 `multipart`；错误响应不含堆栈；`/api/internal` 未授权一律 404；登录响应时间做噪声下限（≥150ms）以免时序侧信道。**注册重复标识必须明确返回 409**（需求要求“重复标识拒绝”），这天然允许枚举——这是有意识接受的取舍，用 IP/标识限速压低批量探测，并在隐私说明里写清。

---

## 5. 数据字典

通用约定：主键 TEXT（UUIDv4，应用生成，无自增序列 → 两库同构）；时间一律 INTEGER（Unix ms, UTC）；布尔用 INTEGER 0/1；无 JSON1 专属函数依赖。所有表建 `IF NOT EXISTS`，迁移见 §9。

### 5.1 `account`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | 内部随机 ID，唯一对外标识 |
| `login_kind` | TEXT | NOT NULL, CHECK in ('email','phone') | |
| `normalized_login` | TEXT | NOT NULL | 规范化标识 |
| `display_hint` | TEXT | NOT NULL | 掩码展示，如 `a***@d.com` |
| `password_hash` | TEXT | NOT NULL | `scrypt$...` |
| `status` | TEXT | NOT NULL DEFAULT 'active', CHECK in ('active','disabled') | |
| `verified_at` | INTEGER | NULL | 预留，首版恒 NULL |
| `created_at` | INTEGER | NOT NULL | |

索引：`UNIQUE(login_kind, normalized_login)`。留存：直至账号删除（首版无自助删除，见 §13-Q5）。

### 5.2 `session`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK |
| `account_id` | TEXT | NOT NULL, FK → account(id) ON DELETE CASCADE |
| `token_hash` | TEXT | NOT NULL, UNIQUE（sha256 hex） |
| `created_at` / `last_seen_at` / `expires_at` | INTEGER | NOT NULL |
| `revoked_at` | INTEGER | NULL |

索引：`(account_id)`、`(expires_at)`。清理：过期或撤销 30 天后物理删除。

### 5.3 `favorite`

| 列 | 类型 | 约束 |
|---|---|---|
| `account_id` | TEXT | NOT NULL, FK → account ON DELETE CASCADE |
| `experiment_id` | TEXT | NOT NULL（内容 ID，不建外键） |
| `created_at` | INTEGER | NOT NULL |

主键 `(account_id, experiment_id)` → 重复收藏天然幂等。

### 5.4 `recent_use`

| 列 | 类型 | 约束 |
|---|---|---|
| `account_id` | TEXT | NOT NULL, FK → account ON DELETE CASCADE |
| `experiment_id` | TEXT | NOT NULL |
| `last_opened_at` | INTEGER | NOT NULL |

主键 `(account_id, experiment_id)`；写为 `ON CONFLICT ... DO UPDATE SET last_opened_at=excluded.last_opened_at`（**已实测可用**，见 §8.2）。
不存次数、不存参数、不存进入/离开明细。索引 `(account_id, last_opened_at DESC)`。

### 5.5 `saved_state`（条件功能，可延后）

| 列 | 类型 | 约束 |
|---|---|---|
| `account_id` | TEXT | NOT NULL, FK → account ON DELETE CASCADE |
| `experiment_id` | TEXT | NOT NULL |
| `content_version` | TEXT | NOT NULL（保存时实验内容版本） |
| `state_schema_version` | INTEGER | NOT NULL |
| `payload` | TEXT | NOT NULL，JSON，≤4096 字节（服务端按实验 schema 白名单校验后重新序列化） |
| `updated_at` | INTEGER | NOT NULL |

主键 `(account_id, experiment_id)`：每资源至多一个当前快照（覆盖式，不做版本历史）。

### 5.6 `event`（诊断专用，见 §6）

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK |
| `account_id` | TEXT | NOT NULL, FK → account ON DELETE CASCADE |
| `experiment_id` | TEXT | NOT NULL |
| `content_version` | TEXT | NOT NULL |
| `app_version` | TEXT | NOT NULL |
| `locale` | TEXT | NOT NULL, CHECK in ('zh-CN','en') |
| `event_type` | TEXT | NOT NULL, CHECK in 白名单 7 值 |
| `control_group` | TEXT | NOT NULL DEFAULT ''（白名单枚举或空串，**避免 NULL 破坏唯一索引**） |
| `interaction_bucket` | TEXT | NOT NULL DEFAULT ''（`1`,`2-5`,`6-20`,`21+`） |
| `error_code` | TEXT | NOT NULL DEFAULT ''（白名单 5 值） |
| `issue_category` | TEXT | NOT NULL DEFAULT ''（反馈类别） |
| `device_class` | TEXT | NOT NULL DEFAULT 'unknown'（desktop/mobile/tablet/unknown，服务端由 UA 粗分，**不存 UA 原文**） |
| `visit_id` | TEXT | NOT NULL（页面加载时生成的一次性 UUID，不持久化到设备） |
| `client_event_id` | TEXT | NOT NULL（客户端随机，重试去重用） |
| `dedupe_key` | TEXT | NULL（仅一次性事件填 `visit_id:type:control_group/error_code`；可重复事件为 NULL） |
| `occurred_at_min` | INTEGER | NOT NULL（服务端接收时间向下取整到分钟） |
| `received_at` | INTEGER | NOT NULL（精确值，仅内部排序/排查，导出不暴露） |

索引：`UNIQUE(account_id, client_event_id)`（请求重试幂等）、`UNIQUE(account_id, dedupe_key)`（只对非 NULL 的一次性事件去重，重置与全屏每次操作可重复）、`(experiment_id, occurred_at_min)`、`(account_id, occurred_at_min)`、`(event_type, occurred_at_min)`。`dedupe_key` 必须由服务端根据已校验字段生成，不接受客户端直接指定。

### 5.7 `feedback`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK |
| `account_id` | TEXT | NOT NULL, FK → account ON DELETE CASCADE |
| `experiment_id` | TEXT | NOT NULL |
| `content_version` / `app_version` | TEXT | NOT NULL |
| `category` | TEXT | NOT NULL, CHECK 枚举 |
| `message` | TEXT | NULL，≤2000 字符，去控制字符，禁止换行折叠超限 |
| `created_at` | INTEGER | NOT NULL |

反馈正文属**用户主动提交的文本**，只进本表，**绝不进 event 表**；导出时与账号 ID 同列但需审计记录。留存 180 天。

### 5.8 `internal_audit`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `operator_label` | TEXT | 运维身份自述（如 `owner-laptop`），来自请求头 `X-Operator-Label` |
| `action` | TEXT | `overview` / `account_timeline` / `export_events` / `export_feedback` |
| `target_type` / `target_id` | TEXT | 如 `account` + 账号 ID |
| `reason` | TEXT | 必填（≥8 字符），落“用途” |
| `row_count` | INTEGER | 本次返回/导出行数 |
| `created_at` | INTEGER | |

用途：满足“最小访问范围、用途、留存”的可核查要求；留存 365 天。**不记录被查内容的正文。**

---

## 6. 事件字典、账号关联诊断价值、与个人历史的分离

### 6.1 事件白名单（7 类，全部枚举，无自由文本）

| `event_type` | 触发时机 | 允许属性 | 诊断用途 | 记录频率 |
|---|---|---|---|---|
| `experiment_open` | 实验模块挂载成功 | experiment_id, content_version, app_version, locale, device_class | 资源热度、入口有效性 | 每次打开 1 条 |
| `experiment_first_interaction` | 本次 `visit_id` 内首次实质交互（拖动结束/按钮） | experiment_id, content_version, app_version, locale, device_class | 打开→动手转化（首屏/入口问题） | 每 visit 至多 1 条 |
| `experiment_control_used` | 某控件类别首次使用 | 上述 + control_group, interaction_bucket | 哪些控件真被用、演示路径 | 每 visit 每 control_group 至多 1 条 |
| `experiment_reset` | 点“重置” | 上述（无 interaction_bucket） | 复位频率（重复演示 vs 操作困难，需其他证据） | 每 visit 每次点击（限速内） |
| `experiment_fullscreen` | 进入/退出全屏 | 上述 + control_group=`fullscreen_enter` / `fullscreen_exit`（复用枚举，不新增列） | 投影/课堂代理信号 | 每次切换 1 条 |
| `client_error` | 错误边界或全局异常 | + error_code（render_error/model_error/unknown_error/incompatible_sdk/manifest_invalid）, app_version | 版本回归、崩溃定位 | 每 visit 每 error_code 至多 1 条 |
| `feedback_submitted` | 反馈提交成功 | + issue_category（bug/confusing/content/wrong_value/other） | 问题类型分布 | 每次提交 1 条，正文在 `feedback` 表 |

实现细节：全屏方向复用 `control_group` 取值 `fullscreen_enter` / `fullscreen_exit`（白名单枚举），不新增列；`experiment_complete` 从原型契约中**移除**（探索性工具没有可靠“完成”语义，留着只会产生伪指标）——这是对 ADR-001 契约的明确变更，见 §10。

**禁止写入**：滑块连续值、参数快照内容、任意文本、页面 URL/查询串、Referer、UA 原文、IP、设备指纹、鼠标轨迹、每帧数据。

### 6.2 账号关联的“有用”边界

事件带 `account_id` 的目的只有一个：**回答内容与程序问题**。允许的分析问题 → 查询：

| 诊断问题 | 查询（示意） | 允许得出的结论 | 禁止的推论 |
|---|---|---|---|
| 哪些资源被真正使用 | 按 experiment_id 统计 `count(DISTINCT account_id)` 的 open | 资源相对热度 | 不等于“教师人数” |
| 打开后是否动手 | 同一 visit 有 open 无 first_interaction 的比例 | 首屏/入口可能有问题 | 不等于“用户不会用” |
| 疑似卡点 | 某实验 reset/open 比高、first_interaction 比例低 | 值得人工看回放式复现 | 不能断定是困难 |
| 版本回归 | 按 content_version 分组 client_error/open | 新版本错误率上升 | 不推断具体用户受影响 |
| 常用交互 | control_used 按 control_group 分布 | 教学上真正用到的控件 | 不推断教学意图 |
| 课堂/投影代理 | fullscreen 比例 | 一个弱信号 | 全屏 ≠ 课堂 |
| 单账号问题定位 | 按 account_id + 时间窗取该账号事件序列（需 reason + 审计） | 复现某用户报告的问题 | 不得导出他人可识别内容 |

### 6.3 与“我的”数据的强制分离

| 维度 | 个人历史（favorite / recent_use / saved_state） | 诊断事件（event / feedback） |
|---|---|---|
| 路由 | `/api/me/*` | `/api/events`、`/api/feedback` |
| 写时机 | 用户动作同步写入，纳入请求事务 | 异步批量，失败即丢 |
| 一致性 | **强一致**：写失败必须返回错误，UI 提示“未保存” | **尽力而为**：202 接受，可丢、可缺 |
| 失败时 UI | 明确报错，不得显示成功 | 静默降级，实验照常可用 |
| 读取者 | 仅本人 UI | 仅 OPS 经审计导出 |
| 能否互相重建 | **禁止**用 event 回填 recent_use；**禁止** UI 读 event | 禁止把 saved_state 值写进 event |
| 保留 | 直至账号删除 | 90 天（可配） |
| 引用完整性 | 有 FK 到 account | 有 FK 到 account；**无** FK 到 experiment |

落地约束（写进代码评审清单）：
1. `apps/api/src/domain/events/*` 不得 import 任何 `me/*` 模块，反向亦然；用 lint 规则（`no-restricted-imports`）固化。
2. `recent_use` 的写只在 `POST /api/me/recent`（由打开动作显式调用），事件管线无权写它。
3. 关闭分析通道（前端开关/后端 503）不影响 open/收藏/最近使用；验收里要单独跑这条。

---

## 7. API 契约

统一：`Content-Type: application/json; charset=utf-8`；错误体 `{"error":{"code":"...","message":"...","field":"..."}}`；成功可 204；不做 `/v1` 前缀（无外部消费者，改为“只增不改”规则 + 事件自带 `schema_version`）。
错误码表：`validation_failed`(400) `unauthenticated`(401) `invalid_credentials`(401) `forbidden`(403，仅运维 token 场景) `not_found`(404) `identifier_taken`(409) `already_authenticated`(409) `rate_limited`(429) `payload_too_large`(413) `server_error`(500)。

### 7.1 认证

| 方法 路径 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /api/auth/register` | `{loginKind:'email'|'phone', identifier, password}` | `201` + `Set-Cookie` + `{account:{displayHint}}` | 400 校验；409 `identifier_taken`；429 |
| `POST /api/auth/login` | 同上 | `200` + `Set-Cookie` + `{account:{displayHint}}` | 401 `invalid_credentials`（不区分标识不存在/口令错/已停用）；429 |
| `POST /api/auth/logout` | 空体 | `204` + 清 Cookie（幂等：无会话也 204？→无会话 401，见矩阵） | 401 |
| `GET /api/auth/session` | — | `200 {authenticated:true, account:{displayHint, createdAt}}` 或 `{authenticated:false}` | 429 |

注册成功即建立会话（减少一次输入），但**不**回传完整手机号/邮箱。

### 7.2 目录与实验

| 方法 路径 | 说明 |
|---|---|
| `GET /api/catalog?subject=&grade=&concept=&q=&locale=` | 需登录；返回 `{items:[{id, slug, title, description, subjects, grades, concepts, contentVersion, languages}]}`；`q` 只做标题/概念子串匹配，最多 50 条 |
| `GET /api/experiments/:id` | 需登录；404 表示无此 ID 或未发布；含 `manifest` + `contentVersion` + `sdkVersionRange` |

目录数据来自构建期 manifest 索引（文件），服务启动时加载并校验唯一 `id`/`slug`、翻译键齐全；**API 返回内容版本，前端把它带进事件与快照**。

### 7.3 我的收藏

| 方法 路径 | 语义 |
|---|---|
| `GET /api/me/favorites` | `{items:[{experimentId, createdAt}]}` 按 `created_at DESC` |
| `PUT /api/me/favorites/:experimentId` | 幂等：已存在返回 `200 {createdAt}`，新插入 `201`；404 若实验不存在 |
| `DELETE /api/me/favorites/:experimentId` | 幂等：不存在也 `204` |

### 7.4 最近使用

| 方法 路径 | 语义 |
|---|---|
| `GET /api/me/recent?limit=20` | `{items:[{experimentId, lastOpenedAt}]}` 按时间倒序，按资源去重（主键保证） |
| `POST /api/me/recent` `{experimentId}` | upsert `last_opened_at=now`，`204`；实验不存在 404 |

**何时调用**：实验模块挂载成功后调用一次；失败时仅在实验页显示非阻断提示“最近使用未记录”，不影响操作。参数值一律不传。

### 7.5 参数快照（条件功能）

| 方法 路径 | 语义 |
|---|---|
| `GET /api/me/saved-state/:experimentId` | 200 `{contentVersion, stateSchemaVersion, values:object}` / 404 无快照 |
| `PUT /api/me/saved-state/:experimentId` `{stateSchemaVersion, values}` | 服务端用实验 schema 校验：仅白名单键、数值范围、总字节 ≤4096；存当前 `content_version`；`200` |
| `DELETE /api/me/saved-state/:experimentId` | `204` |

恢复规则（B 阶段若实现必须测）：`content_version` 或 `state_schema_version` 不匹配 → 不恢复、回退教学默认值，并显示“该设置来自旧版本，已恢复默认”。重置按钮**只**恢复默认值，不等于“恢复我保存的设置”。

### 7.6 诊断事件

`POST /api/events`
```json
{ "schemaVersion": 1,
  "appVersion": "0.2.0",
  "visitId": "0f0c…", 
  "events": [
    { "clientEventId":"…", "type":"experiment_open", "experimentId":"math.functions",
      "contentVersion":"1.0.0", "locale":"zh-CN" }
  ] }
```
- 服务端：校验批量 ≤20、体 ≤8KB、枚举/正则、`experimentId` 必须在内容索引内、`contentVersion` 与索引一致（不一致 → 丢弃该条并计数 `dropped`，防止伪造版本污染回归分析）；`account_id` 从会话取；`occurred_at_min` 用服务端时间。
- 响应：`202 {"accepted":n,"dropped":m}`；部分丢弃不报错（客户端不重试丢弃项）。重复 `client_event_id`，或一次性事件的服务端 `dedupe_key` 命中唯一索引 → 计入 `dropped`，不报 500；重置和全屏切换没有该去重键，可按次统计。
- 限速命中：`429` 且**不**影响实验；前端 adapter 只保留 1 次重试，随后丢弃。
- 事件端点可被运维关闭（`OEL_EVENTS_ENABLED=false` → `204` 静默接受但落盘为 0，或 `503`）；无论哪种，前端不得因此报错给用户。

### 7.7 反馈

`POST /api/feedback` `{experimentId, contentVersion, appVersion, category, message?}` → `201 {id}`。提交前 UI 必须展示将发送的内容（章程要求）。`message` 去 `\u0000`、折叠超长、≤2000。

### 7.8 运维接口（`Authorization: Bearer $OEL_OPERATOR_TOKEN` + `X-Operator-Label`）

| 方法 路径 | 用途 | 约束 |
|---|---|---|
| `GET /api/internal/overview?from&to` | 按资源：open 账号数、first_interaction 比例、reset 比、fullscreen 比、错误率 | 时间窗 ≤180 天；返回值含 `dataGaps` 标记 |
| `GET /api/internal/experiments/:id/funnel?from&to&contentVersion=` | 单实验漏斗与控件分布 | 同上 |
| `GET /api/internal/accounts/:id/timeline?from&to&reason=` | 单账号事件序列（定位问题） | `reason` ≥8 字符，写 `internal_audit`，返回 ≤500 行 |
| `GET /api/internal/export/events.csv?from&to&experimentId&reason=` | CSV 导出（无 `received_at`、无 UA、无文本） | 行数上限 50000，超限 413 并提示缩窗 |
| `GET /api/internal/export/feedback.csv?from&to&reason=` | 反馈导出（含正文与账号 ID） | 同上；必须审计 |
| ~~`POST /api/internal/retention/purge`~~ | **不存在**：留存清理只由 CLI 执行（B8 定稿），删除不由网络调用触发 | `scripts/retention-purge.mjs`，默认 dry-run，`--apply` 须 `--confirm-database` 重复同一路径；见 `docs/ops/runbook.md` §7 |

响应统一附 `{"window":{"from":…,"to":…},"generatedAt":…,"dataGaps":[{"from","to","reason":"events_disabled"|"ingest_error"}]}`——数据缺失必须显式呈现“未知”，不得补造（章程 §8）。

---

## 8. 数据库选型：本地开发 vs 将来服务器

### 8.1 约束（已核事实）

- 开发机 Windows 10，Node v22.23.0 / npm 10.9.8 / Git 2.53.0；**未发现 docker、pnpm**（`PROJECT_STATE` 已记录，本轮复核仍无仓库无 git）。
- 生产服务器 OS/内存/是否有容器运行时/是否允许装 PG **全部未知**；ADR-002 明令不得先承诺拓扑。
- 因此选型的核心不是“哪个数据库更好”，而是“在未知服务器上，哪种方案不会把项目卡死”。

### 8.2 本地开发：SQLite（`node:sqlite`）— 已实测

本轮在开发机实测（`node:sqlite`，Node 22.23.0）：

| 项目 | 结果 |
|---|---|
| 建表 + WAL | 通过 |
| `INSERT … ON CONFLICT(a,b) DO UPDATE SET x=excluded.x` | 通过（`recent_use` upsert 得到 2000） |
| `VACUUM INTO '<file>'` 一致快照 | 通过（12KB 副本可独立打开，数据一致） |
| `PRAGMA foreign_keys` 默认 | `1`（已开启，无需每次连接显式打开） |
| 备注 | 启动有 `ExperimentalWarning: SQLite is an experimental feature` |

选择理由：零原生编译（Windows 上 `better-sqlite3` 需要 node-gyp/VS 工具链，是本项目最可能卡住新贡献者的点）；标准库随 Node 走，无供应链；单文件便于备份/演练；本地并发只有开发与 E2E，绰绰有余。
风险与对策：API 标 “experimental” → 在 `package.json` 固定 Node 主版本范围，并把 SQL 访问集中在 `domain/db` 一层（换 `better-sqlite3` 或 PG 时只改这一层）。

### 8.3 生产候选：PostgreSQL 16（若服务器允许），否则单实例 SQLite

| 判据 | 选 PG | 选 SQLite |
|---|---|---|
| 服务器内存 | ≥1GB 可用（PG 常驻 ~150–300MB） | 极小内存/共用 VPS |
| 部署方式 | 允许容器或 systemd 安装 pg | 只能放一个 Node 进程 + 文件 |
| 并发预期 | 多实例/多进程、或写入并发明显 | 单进程、课堂级并发 |
| 备份能力 | 允许 `pg_dump` + 异机存储 | 允许定时快照 + 异机复制 |
| 运维能力 | 有人能处理 pg 升级/连接数 | 无人值守，越简单越好 |

**明确不承诺**：“以后可轻松切换”。SQL 抽象能降低迁移成本，但不能消除（事务隔离、并发写、索引统计、备份工具全不同）。真正的保证只有一条：同一套迁移与授权测试能在目标库上跑通（B 阶段留出 `db:test:pg` 脚本位置，D 阶段在目标服务器实跑）。

### 8.4 可移植子集（写进迁移规范）

允许：`TEXT/INTEGER` 列、`PRIMARY KEY`、`UNIQUE`、`CHECK`、`FOREIGN KEY … ON DELETE CASCADE`、`ON CONFLICT … DO UPDATE`、`CREATE INDEX IF NOT EXISTS`、表达式索引（仅用 `COALESCE`/列本身）。
禁止：自增序列、`STRICT` 表、`AUTOINCREMENT`、`json_extract`/`->>` 查询、`datetime()` 函数、`PRAGMA` 写进迁移（连接层单独设）、触发器、部分索引（partial index 语法差异大）。
约定：ID 应用生成、时间应用写入、布尔用 INTEGER、枚举用 `CHECK`，使两库 DDL/ DML 逐字相同。

---

## 9. 迁移、备份与恢复

### 9.1 迁移

- 位置 `apps/api/migrations/NNNN_name.sql`，`0001_init.sql` 起；单文件单事务执行。
- 表 `schema_migrations(version TEXT PK, checksum TEXT, applied_at INTEGER)`；启动时（或 `npm run db:migrate`）按序应用，**已应用文件校验和不符即拒绝启动**（防有人改历史迁移造成环境漂移）。
- 连接参数（非迁移内容）：SQLite `journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`（实测默认已开，仍显式设以防驱动变更）。
- 迁移必须**前向兼容一个版本**：新增列允许 `DEFAULT`；删列/改类型走“新增→双写→回填→切换→清理”多步，禁止单步破坏。
- 测试：空库全量应用、重复应用幂等、故意篡改校验和必须失败、在半途失败时事务回滚（用可控坏迁移验证）。

### 9.2 备份（按用途分档）

| 环境 | 方式 | 频率 | 保留 | 异地 |
|---|---|---|---|---|
| 本地开发 | 不备份（有 seed 脚本） | — | — | — |
| 生产候选（SQLite） | `VACUUM INTO backups/opel-YYYYMMDDTHHMM.db`（本轮已实测可用；WAL 下并发写入行为需在 B8 实测确认） | 每日 1 次 + 迁移/发布前各 1 次 | 14 日 + 4 周 | 必须复制到另一台/对象存储；**同盘备份不算备份** |
| 生产候选（PG） | `pg_dump -Fc` | 每日 + 发布前 | 同上 | 同上 |

目标（写清而不是暗示）：RPO ≤ 24 小时，RTO ≤ 1 小时（单实例、单库，规模为教学站点量级）。若将来要求 RPO < 1 小时，需 WAL 归档/流复制，属新决策。

### 9.3 恢复演练（不可跳过）

`scripts/restore-check.mjs`：
1. 取最新备份到临时目录，独立打开；
2. `PRAGMA integrity_check` + 关键表计数（account/session/favorite/recent_use/event）；
3. 插一条 canary 行、读回、删除（验证可写）；
4. 输出 JSON 报告到 `docs/evidence/backup/<date>.json`（不含真实账号数据，只含计数）。
每月至少一次；**未演练过的备份视为不存在**。发布回滚：保留上一个构建目录 + 迁移只前向兼容 → 回滚代码不需回滚库（若必须回库，用发布前快照）。

### 9.4 留存与清理

`scripts/retention-purge.mjs`（CLI，非 HTTP）：event > 90 天、feedback > 180 天、internal_audit > 365 天、session 过期/撤销 > 30 天。默认 `--dry-run`，输出将删行数；真删需 `--apply`。清理前若需要长期趋势，先做日粒度汇总表——**首版不做汇总，因此清理后老数据不可再聚合**，这是显式接受的损失（§14-R7）。

---

## 10. 对 ADR-001 插件契约的变更（B 阶段必须同步）

| 变更 | 原因 | 影响 |
|---|---|---|
| 移除 `experiment_complete` | 探索性工具无可靠“完成”语义，会制造伪指标 | 契约枚举减一；旧测试若断言则调整 |
| 拆 `experiment_interact` → `experiment_first_interaction` + `experiment_control_used` | v2.1 要求“首次实质交互”与“控件类别”分开，才能算转化与控件分布 | 事件类型 +2；需要 `visit_id` |
| 全屏方向用 `control_group='fullscreen_enter'|'fullscreen_exit'` | 不新增列，保持白名单 | UI 统一走宿主 |
| 新增可选 `serializeState()/restoreState(schema)` + `stateSchema`（参数白名单/范围/默认值） | 需求 §4.5 显式快照 | 实验模块需声明 schema，宿主与 API 共用同一份校验 |
| 事件字段新增 `contentVersion`（= `moduleVersion` 的内容版本） | 版本回归需要区分内容版本与 app 版本 | manifest 增 `contentVersion`，构建期注入 |
| 明确“无 SDK 直连网络/DB” | 原有约束不变，补：实验不得自行 `fetch` 事件端点 | 由宿主 adapter 统一发送 |

重置语义不变：重置 = 回教学默认值，与“恢复我保存的设置”是两件事。

---

## 11. 需求可测试追溯

| ID | 需求（v2.1） | 验收测试 | 层级 | 位置（B 阶段） |
|---|---|---|---|---|
| R-01 | 手机**或**邮箱 + 口令可注册 | `register phone/email 成功并建会话` | API 集成 | `apps/api/test/auth.register.test.ts` |
| R-02 | 重复标识拒绝 | `重复 email/phone → 409 identifier_taken；大小写/空格规范化后仍判重` | API 集成 | 同上 |
| R-03 | 错误口令拒绝 | `错口令 → 401 invalid_credentials；不存在标识同文案同状态` | API 集成 | `apps/api/test/auth.login.test.ts` |
| R-04 | 退出后不能访问实验 | `logout 后 /api/me/* 与 /api/catalog 均 401；旧 Cookie 重放 401` | API + E2E | `apps/api/test/session.test.ts`、`tests/e2e/gate.spec.ts`、`tests/e2e/full-flow.spec.ts` |
| R-05 | 未登录直达资源 URL/API 被拒绝 | `GET /experiments/x 302→/login；/api/experiments/x 401` | E2E + API | `tests/e2e/gate.spec.ts` |
| R-06 | 过期会话重登 | `expires_at 过去 → 401；空闲超时同上` | API 集成（注入时钟） | `apps/api/test/session.test.ts` |
| R-07 | 按学科/学段/知识点查找 | `筛选与搜索返回子集；非法参数 400` | API + E2E | `apps/api/test/catalog.test.ts`、`tests/e2e/app.spec.ts` |
| R-08 | 中英双语可操作 | `zh-CN/en 切换后标题与控件文案一致；缺键报告` | 单元 + E2E | `tests/i18n.test.ts`、`tests/e2e/app.spec.ts`（语言切换） |
| R-09 | 首实验公式/范围/边界/说明可核查 | 模型黄金用例（含退化、临界、非法输入） | 单元 | `experiments/math-functions/tests/model.test.ts` |
| R-10 | 手机与投影可用；重置/全屏 | 3 视口（390×844、1280×720、1024×768）截图 + 重置/全屏断言 | E2E | `tests/e2e/full-flow.spec.ts`（390×844 / 1280×720 / 1024×768 截图与断言）+ `tests/e2e/app.spec.ts` |
| R-11 | 收藏跨会话可见 | `会话 A 收藏 → 新 Cookie 会话 B 可见` | API + E2E | `apps/api/test/favorites.test.ts` |
| R-12 | 取消收藏生效 | `DELETE 幂等；列表消失；重复删除 204` | API 集成 | 同上 |
| R-13 | 最近使用按资源去重、无参数流水 | `打开 A、B、A → 2 条且 A 时间最新；响应无任何参数键` | API + 契约 | `apps/api/test/recent.test.ts` |
| R-14 | 事件按账号可导出/查询 | `overview 计数正确；CSV 行数=插入数-去重；缺 GAP 标记正确` | API 集成 | `apps/api/test/internal.test.ts` |
| R-15 | 跨账号隔离 | `账号 B 读不到 A 的收藏/历史/事件；internal 无 token 404` | API 集成 + E2E | `apps/api/test/authorization.test.ts`、`tests/e2e/isolation.spec.ts` |
| R-16 | 分析通道故障不影响实验与收藏历史 | `事件端点 503/断网 → 收藏/最近使用仍成功；UI 无阻断` | E2E | `tests/e2e/resilience.spec.ts`（`/api/events` 503 注入） |
| R-17 | 快照保存/恢复/版本不兼容回退 | `保存→刷新恢复；contentVersion 变更→回默认+提示` | API + E2E | 未实现（B7 可选，未做）：`saved_state` 表为空，`/api/me/saved-state/*` 返回 404 |
| R-18 | 无显式保存则不持久化参数 | `拖动后无快照行；localStorage 无参数项` | API + E2E | 未实现（B7 未做）；当前没有任何参数持久化路径，`recent_use` 响应键集由 `recent.test.ts` 断言 |
| R-19 | 口令存储/会话/最小化测试与证据 | `哈希串非明文、含参数；事件白名单拒绝自由字段；证据目录齐全` | 单元 + 集成 | `apps/api/test/auth.security.test.ts`、`docs/evidence/b2/` |
| R-20 | 维护者权限独立 | `普通账号带 Cookie 访问 internal → 404；仅 Bearer 通过` | API 集成 | `apps/api/test/internal.test.ts`（`the operator channel is closed to everyone else`） |
| R-21 | 未验证标识不宣称真实身份 | `UI 文案与隐私页无“已验证/实名”；API 只回掩码` | 文案检查 + E2E | `tests/e2e/app.spec.ts`（页面文案与可访问名）+ `tests/i18n.test.ts`（键集一致） |
| R-22 | 诊断数据不含文本/滑块/查询串 | `注入恶意 payload（name、?token=、slider=0.37）→ 全部被丢弃` | 单元 + 集成 | `apps/api/test/events.test.ts`（未知字段/非法枚举/文本字段被丢弃） |
| R-23 | 事件缺失显示“未知”不补造 | `关闭事件 24h → overview dataGaps 非空；UI/CSV 标 unknown` | API 集成 | `apps/api/test/internal.test.ts`（`dataGaps` 在事件关闭时非空） |

每条测试都必须能给出“真实运行输出”，无截图/日志不算通过（章程 §12.6）。R-09/R-10 需要真实手机尺寸截图，不接受仅 DOM 断言。

---

## 12. B 阶段实施顺序（每步可关门，禁止跳步补丁）

| 步 | 内容 | 退出判据（可观察） |
|---|---|---|
| **B0** | 修旧原型 typecheck 根因：`vite-env.d.ts` 的 `Window.__openedulab?: unknown` 与 `tests/e2e/m1.spec.ts:7` 的具体类型声明冲突（TS2717）。做法：把调试钩子形状抽成**唯一**导出类型（`packages/contract/src/debug-hook.ts`），两侧都引用；测试不再重复 `declare global`。**不删测试**。 | `npm run check` 退出码 0（typecheck/lint/unit/build 全过）；`git` 初始化并提交，记录 commit |
| **B1** | 骨架：`apps/api` + Fastify + 配置校验（缺 `OEL_*` 即启动失败）+ `0001_init.sql` + 迁移运行器 + `GET /api/healthz` + SPA 同源托管 | 空库迁移后 `schema_migrations` 有 1 行；重启幂等；healthz 200；迁移篡改测试失败为预期 |
| **B2** | 认证闭环：注册/登录/登出/会话 + Cookie + 限速 + 枚举与时序防护 | R-01..R-04、R-06 全绿；`security.test.ts` 断言哈希格式与 `timingSafeEqual`；429 有 `Retry-After` |
| **B3** | 授权门禁：目录/实验 API + SPA 深链接 302 + 跨账号隔离用例 | R-05、R-07、R-15、R-20 全绿；无任何路由可绕过 `requireSession()`（用路由清单测试覆盖） |
| **B4** | 个人数据：收藏 + 最近使用（含 upsert 去重、失败提示） | R-11..R-13 全绿；断开事件端点仍通过；无参数键出现在响应 |
| **B5** | 诊断链路：事件批量 + 服务端校验/去重/限速 + internal overview/timeline/export + 审计 + dataGaps | R-14、R-22、R-23 全绿；伪造 version 被丢弃；导出无 UA/`received_at`；`internal_audit` 有行 |
| **B6** | 纵向切片端到端：注册→目录→实验→收藏/历史→后台查询，三视口截图 + 短录屏 + 断网降级 | 全量 e2e 绿；证据落 `docs/evidence/b6/`；R-10、R-16、R-21 全绿 |
| **B7** | 可选：参数快照（若切片验证认为必要） | R-17、R-18 全绿；不兼容回退演示；未实现则项目状态明确写“未实现” |
| **B8** | 收口：CI（typecheck/lint/unit/api/e2e/build/迁移/备份演练）、备份恢复演练报告、`PROJECT_STATE` 与 ADR 更新 | CI 全绿且有运行记录；恢复演练 JSON 存在；无“假登录/假数据/未验证 URL” |

顺序理由：B0 先恢复门禁可信度（否则后面所有“绿”都不可信）；B1 先立迁移与配置，避免边写边改表；B2/B3 是安全边界，必须在有个人数据前完成；B5 放在个人数据之后，确保事件无法顺手污染“我的”；B7 明确可延期，不挡主闭环。

---

## 13. 未决问题（会实质改变架构，附默认取值）

| # | 问题 | 为何改变架构 | 未定期间的默认 |
|---|---|---|---|
| Q1 | 生产服务器 OS/内存/是否允许装 PG 或容器 | 决定 SQLite 单文件 vs PG、备份工具、限速器是否需共享存储 | 按单实例 + SQLite 设计，接口层隔离；D 阶段实测后再定 |
| Q2 | 域名、HTTPS 终止位置（反代/直连）、是否 CDN | 决定 `__Host-` 前缀与 `Secure`、`OEL_PUBLIC_ORIGIN`、Cookie 域、Origin 校验 | 本地 `http://localhost` + `oel_sid`；上线前必换 |
| Q3 | 实际服务地域、是否面向未成年人、告知与同意方式 | 决定留存期限、是否允许默认开启诊断、隐私文案与是否需监护同意 | 按最短留存（事件 90 天）+ 明确告知；不假设合规 |
| Q4 | 账号删除/数据导出是否为公开前置条件 | 若需要，现在就要定“删除=级联+匿名化聚合”与导出格式，否则后期改表 | 预留 `ON DELETE CASCADE`；首版不提供自助入口 |
| Q5 | 是否/何时做手机号短信验证 | 需要 `verified_at` 之外的验证码表、频控、供应商、费用；也改变“找回”能力 | `verified_at` 留空，文案写“未验证” |
| Q6 | 是否需要多实例/高可用 | 会话仍可共享 DB，但限速器/节流需 Redis 或 DB 计数；影响部署复杂度 | 单实例；进程内限速；重启即清零（可接受） |
| Q7 | 离线/PWA 是否重新进入 P0 | 与强制登录直接冲突，需要离线身份/缓存令牌/事件补传设计 | 首版不做离线，不承诺脱网可用 |
| Q8 | 内容版本由谁负责递增、实验下线策略 | 影响 `content_version` 语义、快照回退判定、事件按版本聚合的可比性 | 由内容作者在 manifest 手动递增；下线只从目录移除、不删历史事件 |
| Q9 | 参数快照是否需要“分享链接” | 若需要，参数会进 URL → 与“URL 不携带个人数据”冲突，需签名/短链方案 | 不分享；快照仅本人可读 |
| Q10 | 错误上报是否允许保存客户端错误文本/堆栈 | 可能含用户输入或 URL 参数；决定是否需要清洗管线与私有 sourcemap 托管 | 只存 `error_code` 枚举，不存文本 |

Q1/Q2 未定不阻塞 B 阶段本地实现；Q3/Q4 未定**阻塞公开上线**，不阻塞本地验证。

---

## 14. 风险登记（按后果排序）

| # | 风险 | 触发条件 | 缓解 |
|---|---|---|---|
| R1 | 把“前端隐藏页面”当访问控制 | 赶进度抄原型 | §3.3 强制；路由清单测试；代码评审清单 |
| R2 | 事件表被拿来生成“最近使用” | 图省事少一张表 | §6.3 隔离 + lint 禁止跨模块 import + 独立测试 |
| R3 | 未验证标识被误当实名，出现抢注争议 | 文案/客服口径松懈 | 全站文案“未验证”；不提供找回/换绑；公开前定处置流程（Q5/Q4） |
| R4 | 数据库选型被“以后能换”掩盖 | 直接上 ORM + SQLite 写方言 SQL | §8.4 子集规范；D 阶段目标库实跑迁移与授权测试 |
| R5 | 备份存在但不可恢复 | 只备份不演练 | §9.3 每月演练 + 证据落盘 |
| R6 | 限速/会话在单进程内，重启清零或多实例失效 | 部署方式变化 | 记录为不变式；Q6 一旦变化必须改共享存储 |
| R7 | 90 天清理后历史趋势不可回看 | 无日汇总表 | 首版接受；若需长期趋势，先加日汇总再开清理 |
| R8 | 注册必须返回“已占用”，天然可枚举 | 需求要求明确拒绝 | IP/标识双限速；隐私说明写明；不提供“该标识是否注册”查询接口 |
| R9 | 静态 JS 无法用登录保护，被当成安全缺陷 | 验收口径不清 | §2 显式声明边界，验收只测 API/深链接门禁 |
| R10 | `node:sqlite` 仍标 experimental，行为随 Node 版本变 | 升级 Node | 固定 Node 版本范围；DB 访问集中一层；CI 锁版本 |

---

## 15. A 阶段出口自检（对照 ADR-002 §5）

- [x] 边界与部署形状（§2）
- [x] 权限矩阵（§3，含负向与越权返回码）
- [x] 数据字典（§5）
- [x] 事件字典 + 账号关联诊断用途 + 个人历史隔离（§6）
- [x] 认证/会话/滥用控制（§4）
- [x] API 契约（§7）
- [x] 数据库选型论证（§8，含实测与不承诺项）
- [x] 迁移/备份/恢复（§9）
- [x] 需求可测试追溯（§11，23 条）
- [x] B 阶段顺序（§12）
- [x] 未决问题与默认（§13）
- [ ] 服务器只读侦察：**无接入信息与授权，未做**（不臆测，见 Q1/Q2）
- [ ] 生产库上的迁移/授权实跑：**无目标环境，未做**

结论：A 阶段设计可关门进入 B0；**不可**据此宣称 M1 完成、不可部署、不可声称任何 URL 可用。
