# PROJECT_STATE

最后更新：2026-10-26（B1 完成：`apps/api` 骨架 + 配置校验 + 迁移运行器 + healthz + 同源 SPA 托管）；buildVersion：`0.1.0-m1`（脚手架版本号，尚未对应已验收里程碑）。

## 当前状态
需求基线 `docs/requirements-v2.1.md` 已定：强制登录、自注册不分师生、本人收藏与去重最近使用、内部按账号诊断事件、参数仅显式保存一份快照。宏观架构见 `docs/architecture/ADR-002-authenticated-platform.md`；原型审计见 `docs/architecture/A-stage-audit.md`；A 阶段设计见 `docs/architecture/A-stage-design.md`（权限矩阵、数据/事件字典、认证/会话/滥用控制、API 契约、数据库选型论证、23 条需求可测试追溯、B0–B8 顺序、未决问题与风险）。
**B0（工程地基修复 + 版本控制）已完成**，`npm run check` 与 `npm run test:e2e` 均退出码 0（实测输出见下）。
**B1（服务端骨架）已完成**：`apps/api` 可启动、配置缺失即退出 1、迁移带校验和且按序单事务、`/api/healthz` 返回版本与迁移状态、构建后的 SPA 由同一进程同源托管；`npm run check` 退出码 0，API 测试 62 个全绿，真实进程 smoke 25/25 通过（证据见 `docs/evidence/b1/`）。
**B1 不含认证，也不得被当作访问控制**：`/api/auth/*` 未挂载（404）；所有将来需登录的路由（`/api/catalog`、`/api/experiments/:id`、`/api/me/*`、`/api/events`、`/api/feedback`）当前一律返回 **401 `unauthenticated`**，这是"拒绝所有人"的占位，不是"已保护资源"；`/api/internal/*` 未挂载（404）。SPA 深链接现在返回公开的构建产物（B3 才做 302 登录门禁），前端仍是**免登录原型**。
**仍未按需求 v2.1 验收，不可称 M1 完成，不可部署，无可用 URL。** 现有 `apps/web` + `experiments/math-functions` 是**免登录原型代码**，只作 B 阶段的代码素材与回归基线，不满足需求 v2.1。

## B0 本轮做了什么（根因修复，非打补丁）
- 根因：`Window.__openedulab` 被**两处**以不同类型重复声明 —— `apps/web/src/vite-env.d.ts:9` 为 `unknown`，`tests/e2e/m1.spec.ts:7` 为具体对象类型。TypeScript 接口合并要求同名属性类型完全一致，故报 TS2717；由于合并失败，测试文件自身的读取退化为 `{}`/隐式 any，连带 TS2339（原第 125 行）与 TS7006（原第 126 行）。
- 修法：新增**唯一**声明文件 `apps/web/src/debug-hook.d.ts`，用真实服务类型 `AppServices`（`apps/web/src/services/index.ts`）约束钩子形状；删除 `vite-env.d.ts` 与 `m1.spec.ts` 中的两处重复声明。生产运行时未改（`main.tsx` 的 `if (import.meta.env.DEV)` 赋值逻辑不变），测试一条未删、断言一条未放松；类型从 `unknown` 收紧为真实类型，属**加强**而非放宽。
- 反证（证明新声明是承重的、不是把检查关掉）：临时移走 `debug-hook.d.ts` 后 `tsc --noEmit` 立刻报 `apps/web/src/main.tsx(13,10)`、`tests/e2e/m1.spec.ts(116,53)` TS2339 与同文件 `(117,31)` TS7006；放回后 typecheck 退出码 0。
- 版本控制：`git init`（分支 `main`），`.gitignore` 排除 `node_modules/`、`dist/`、`test-results/`、`playwright-report/`、本地 `.env*` 与编辑器/OS 垃圾文件；提交前确认无 `.env`、密钥、令牌、真实服务器地址等私有数据入仓（仓库内 token/口令字样只出现在设计文档的**方案描述**里）。

## B1 本轮做了什么（服务端骨架，TDD；不含认证）
先写测试再写实现：`apps/api/test/` 的 5 个测试文件在实现前全部无法加载（`docs/evidence/b1/tests-red.txt`，5/5 失败、0 测试可运行），实现后 62/62 通过（`docs/evidence/b1/check-b1.txt`）。测试覆盖的正是闸门要求：
- **配置 fail-closed**（19 条）：缺任一必填项时一次性列出全部字段；非法端口/环境/Origin（含带路径、查询串、内嵌凭据）被拒；静态目录缺 `index.html`、迁移目录无 `NNNN_*.sql` 被拒；**未知 `OEL_*` 变量也报错**（防拼写错误静默关掉某个设置）；生产环境禁止 `:memory:`。只有 `OEL_HOST`(127.0.0.1) 与 `OEL_LOG_LEVEL`(info) 有默认值。
- **迁移运行器**（13 条）：按数字序应用；每文件 sha256 校验和 + 独立事务；重复运行幂等（`applied_at` 不变）；**改已应用文件→`checksum_mismatch` 拒绝启动**；**半途失败整文件回滚**（建了表也一并撤销、不写 `schema_migrations`、修复后可继续）；已应用文件被删→`missing_file`；同版本两文件→`duplicate_version`；文件名不合规→`invalid_filename`；`journal_mode=wal`/`foreign_keys=1`/`busy_timeout=5000` 实测生效。
- **healthz**（4 条）：200 且含 `appVersion`、`uptimeSeconds`、`timestamp`、`database.migrations{applied,latest,pending}`；**不泄露路径/配置/口令字样**；启动后新增迁移文件→503 `degraded`；迁移失败→`buildApp` 直接抛错（不监听）。
- **静态同源托管**（10 条）：`/` 与深链接 `/experiments/math.functions` 返回构建的 index.html（`no-cache`）；资源按 MIME 正确；缺资源 404 不回落 HTML；路径穿越被拒（403/404）且不泄露仓库文件；非 GET 深链接不返回 SPA；带 `nosniff`。
- **私有路由占位**（16 条）：12 条未来需登录的路由对匿名请求一律 401 `unauthenticated`（**带伪造 `oel_sid` Cookie 仍 401**）；`/api/internal/*` 与 `/api/auth/session` 明确 404（没有假会话、没有运维后门）；未知 `/api/*` 返回 JSON 404 而非 SPA。

实现要点（对齐设计 §1/§9）：模块化单体，一个 Fastify 5 进程同时提供 `/api/*` 与构建后 SPA（无 CORS）；DB 访问集中在 `src/db/`（`node:sqlite`，连接级 pragma 不写进迁移）；迁移只允许两库共同 SQL 子集；`0001_init.sql` 按设计 §5 建 8 张表（B2–B5 才会用，当前无任何读写）；错误体统一 `{error:{code,message}}`，5xx 不返回堆栈与内部消息；全局体上限 64KB；`trustProxy=false`。`package.json` 描述已从"no-login …"改为明确写明"pre-auth prototype, login NOT implemented"，`engines` 锁 `>=22.5 <23`（`node:sqlite` 起点），并新增 `typecheck:api`/`test:api`/`build:api`/`start:api`/`smoke:api`，`check` 串入 API typecheck 与测试。另加 `.env.example`、`apps/api/README.md`（含"不得据此宣称访问控制"的状态说明）；`.gitignore` 增加 `apps/api/data/`、`*.sqlite*`；ESLint 忽略改为 `**/dist/**`（否则 `apps/api/dist` 会被 lint）。

**未做的事（刻意）**：没有注册/登录/登出/会话、没有 Cookie、没有限速、没有目录/实验/收藏/最近使用/事件/反馈的读写实现、没有 `/api/internal` 运维通道、没有 SPA 登录门禁与 302、没有部署。因此本轮**不能**声称"未登录不能访问实验"已成立；当前能保证的只有：占位路由拒绝所有人、API 路径不会回落成页面、配置/迁移/健康检查行为可复现。

测试运行器已知问题：Vite 5 不认识 `node:sqlite` 内建模块（会去找名为 `sqlite` 的包），`apps/api/vitest.config.ts` 用别名指向 `test/support/sqlite.ts`（内部 `createRequire` 加载真实内建模块）。仅影响测试进程；运行时直接 `import 'node:sqlite'`。

## 本轮确定的架构决策（详见设计文档 §1 / §8）
同源模块化单体（Fastify + 静态 SPA，无 CORS）；服务端会话（DB 存 token 哈希，HttpOnly Cookie，非 JWT）；scrypt 口令哈希；私有 API 一律从会话派生 `account_id`（不接受请求体/路径传账号）；个人数据与诊断事件物理分表、分路由、分一致性等级；运维权限用环境变量 Bearer token，未配置时 404；本地开发 SQLite（`node:sqlite`），生产候选 PostgreSQL 但**不承诺可切换**；迁移用编号 SQL + 校验和 + 单事务且只允许两库共同子集；备份 `VACUUM INTO`/`pg_dump -Fc` + 异机复制 + 每月恢复演练。

## 本轮遗留（不变的事实）
前一次后台开发任务在用户叫停前已写入 React/Vite 代码、依赖、测试与截图/录屏等**免登录原型文件**；本轮已把它们纳入 git 以固定基线，但它们**未按需求 v2.1 验收**，不可称为已交付的 M1，也不可据此部署。`docs/CHARTER-v1.md` 是用户原件副本。`docs/architecture/ADR-000-foundation.md` 与 `docs/acceptance.md` 的旧方案标记已撤回；ADR-001 同属旧前提，须重审。

## 版本控制（本地仓库，无远端）
- 分支 `main`；**B0 首次提交**：`1bc20b2881e4e7833216277780971efe0a0b4fd9`（`1bc20b2`），61 个受跟踪文件，`node_modules/`(140M)、`dist/`、`test-results/`(1.3M)、`playwright-report/`(1.8M) 均由 `.gitignore` 排除。
- **B1 提交**：`80c2f90532b02ac63c88c1799a68b539b5b18147`（`80c2f90`），34 个文件变更（+3556/−26），受跟踪文件总数 89；`apps/api/dist/`（tsc 产物）、`apps/api/data/`（本地 SQLite）、`*.sqlite*` 均被忽略，提交后用 `git check-ignore -v` 核对过。工作区只剩一个未跟踪文件 `docs/roadmap.md`（非本轮产出，**未**纳入提交）。
- 无远端、未推送、未部署、未发布；无 `AGENTS.md`（未获用户同意）。

## 已核事实（B0/B1 实测，非推断）
- 环境：Windows 10；Node v22.23.0、npm 10.9.8、Git 2.53.0.windows.3；Playwright 浏览器已安装（chromium-1248 等）；`node:sqlite` 此前实测可用（建表 + WAL、upsert、`VACUUM INTO` 一致快照可独立重开，启动有 experimental 警告）。
- 修复前 `npm run typecheck`：退出码 2，报 TS2717 + TS2339 + TS7006（原文存 `docs/evidence/b0/check-before.txt`）。
- 修复后 `npm run check`：**退出码 0**（原文存 `docs/evidence/b0/check-after.txt`），逐段为：
  - `tsc --noEmit` 无输出、退出码 0；
  - `eslint .` 无告警/错误；
  - `vitest run`：**6 个测试文件、46 个测试全部通过**（host 9、model 19、analytics 5、errors 4、i18n 5、registry 4），耗时 2.77s；
  - `node scripts/validate-content.mjs`：`Content validation OK`（experiments: math.functions；UI 字典 zh-CN/en 各 66 键；host SDK 1.0.0）；
  - `vite build`：50 modules，`dist/index.html` 1.24 kB、CSS 10.67 kB、`view-*.js` 11.05 kB、`index-*.js` 175.02 kB（gzip 57.70 kB），耗时 759ms。
- `npm run test:e2e`（Playwright，desktop-chromium + mobile-chromium，本地 dev server 127.0.0.1:5199）：**20 个测试中 18 通过、2 跳过（按项目条件显式 skip：手机布局仅 mobile、录屏仅 desktop）、0 失败，退出码 0**，18.3s（原文存 `docs/evidence/b0/e2e-after.txt`）。截图已按用例刷新到 `docs/evidence/m1/`。
- 现有契约 `apps/web/src/experiment/contract.ts` 已有白名单事件/错误码/控件组；与新设计要求有差异（设计文档 §10）。
- 服务器、域名、部署布局、远端仓库、目标数据库仍**未知**；无经授权的服务器侦察，未虚构任何 URL。

### B1 实测（本轮，非推断；原文在 `docs/evidence/b1/`）
- **RED**：实现前 `npx vitest run --config apps/api/vitest.config.ts` → **5 个测试文件全部加载失败、0 个测试可运行**，退出码 1（`tests-red.txt`）。随后补实现，同一命令转绿。
- **`npm run check`：退出码 0**（`check-b1.txt`），逐段：`tsc --noEmit`（web）0；`tsc -p apps/api/tsconfig.test.json`（API src+test）0；`eslint .` 无输出；web `vitest run` **6 文件 / 46 测试全通过**；`test:api` **5 文件 / 62 测试全通过**（config 19、migrate 13、health 4、static 10、private-routes 16）；`validate-content` → `Content validation OK`；`vite build` 50 modules 成功；`tsc -p apps/api/tsconfig.json` 成功。
- **真实进程 smoke：25/25 通过**（`node apps/api/scripts/smoke.mjs` → `smoke.txt`）。实测事实：缺 `OEL_PORT`/`OEL_DATABASE_PATH` → 退出码 1、stderr 列出两个字段、无 "listening"；空库启动后 `/api/healthz` 200 且 `{"appVersion":"0.1.0-m1","database":{"ok":true,"migrations":{"applied":1,"latest":"0001","pending":0}}}`；深链接 `/experiments/math.functions`（Accept: text/html）200 且返回 1244 字节构建 index.html、`cache-control: no-cache`；同源 `/assets/index-DrcVA2Q_.js` 200、`application/javascript`、175018 字节；`/api/catalog`、`/api/me/favorites`、`/api/me/recent`、`/api/experiments/math.functions` 全部 401 `unauthenticated`（带 `Cookie: oel_sid=forged` 仍 401）；未知 `/api/does-not-exist` → 404 `application/json`（未回落 HTML）；`/assets/missing.js` 404；`schema_migrations` 恰 1 行、`checksum` 为 64 位 sha256；重启后仍 1 行且 `applied_at` 完全不变（`1793014247203`）；把 `0001_init.sql` 追加一行注释后启动 → 退出码 1，错误为 `Migration 0001 (init) was modified after it was applied: recorded 289c27d35781…, file 4ddecbcb6881…`。

## 下一步（严格按序）
1. ~~**B0**：修 typecheck 根因（唯一共享 `debug-hook` 类型，两侧引用，不删测试）→ `npm run check` 退出码 0；`git init` + 首次提交。~~ **已完成（本轮）**。
2. ~~**B1**：`apps/api` 骨架 + 启动配置校验（缺项即退出、不静默降级）+ `migrations/0001_init.sql` + 迁移运行器（编号 + 校验和 + 单事务）+ `GET /api/healthz` + 由 API 同源托管构建后的 SPA。~~ **已完成（本轮）**：`npm run check` 退出码 0；API 测试 62/62；真实进程 smoke 25/25；深链接返回 index.html；私有路由占位一律 401。注意：**401 是占位拒绝，不是访问控制**。
3. **B2/B3（下一道闸门）**：注册/登录/登出/会话与限速（scrypt、HttpOnly Cookie、`timingSafeEqual`、429 + `Retry-After`）；随后目录/实验 API + SPA 深链接 302 门禁 + 跨账号隔离；同时把 401 占位替换为 `requireSession()`，并加"无路由可绕过"的路由清单测试。
4. **B4/B5**：收藏与最近使用；事件管线 + 内部查询/导出 + 审计 + 数据缺口标记。
5. **B6**：端到端切片 + 三视口截图/录屏证据；B7 参数快照可选；B8 CI 与备份演练收口。

## 阻塞与未决
- 阻塞公开上线（不阻塞本地）：服务器参数与部署布局（Q1）、域名/HTTPS 与 Cookie 前缀（Q2）、服务地域与未成年人政策/留存期限（Q3）、账号删除/数据导出是否前置（Q4）、多实例与共享限速（Q6）。
- 未做：服务器只读侦察、目标库迁移与授权实跑、标识归属验证（首版不做短信/邮件）。
- 不得擅自改生产；不得在无测试输出/证据时声称通过或 URL 可用；未经用户明确同意不新增 `AGENTS.md`、不推送远端、不部署（本轮未推送、未部署、未发布）。
