# PROJECT_STATE

最后更新：2026-10-26（B0 完成：typecheck 根因修复 + 本地 git 首次提交）；buildVersion：`0.1.0-m1`（脚手架版本号，尚未对应已验收里程碑）。

## 当前状态
需求基线 `docs/requirements-v2.1.md` 已定：强制登录、自注册不分师生、本人收藏与去重最近使用、内部按账号诊断事件、参数仅显式保存一份快照。宏观架构见 `docs/architecture/ADR-002-authenticated-platform.md`；原型审计见 `docs/architecture/A-stage-audit.md`；A 阶段设计见 `docs/architecture/A-stage-design.md`（权限矩阵、数据/事件字典、认证/会话/滥用控制、API 契约、数据库选型论证、23 条需求可测试追溯、B0–B8 顺序、未决问题与风险）。
**B0（工程地基修复 + 版本控制）已完成**，`npm run check` 与 `npm run test:e2e` 均退出码 0（实测输出见下）。
**B1 尚未开始；仍未按新需求开发/验收，不可称 M1 完成，不可部署，无可用 URL。** 现有 `apps/web` + `experiments/math-functions` 是**免登录原型代码**，只作 B 阶段的代码素材与回归基线，不满足需求 v2.1。

## B0 本轮做了什么（根因修复，非打补丁）
- 根因：`Window.__openedulab` 被**两处**以不同类型重复声明 —— `apps/web/src/vite-env.d.ts:9` 为 `unknown`，`tests/e2e/m1.spec.ts:7` 为具体对象类型。TypeScript 接口合并要求同名属性类型完全一致，故报 TS2717；由于合并失败，测试文件自身的读取退化为 `{}`/隐式 any，连带 TS2339（原第 125 行）与 TS7006（原第 126 行）。
- 修法：新增**唯一**声明文件 `apps/web/src/debug-hook.d.ts`，用真实服务类型 `AppServices`（`apps/web/src/services/index.ts`）约束钩子形状；删除 `vite-env.d.ts` 与 `m1.spec.ts` 中的两处重复声明。生产运行时未改（`main.tsx` 的 `if (import.meta.env.DEV)` 赋值逻辑不变），测试一条未删、断言一条未放松；类型从 `unknown` 收紧为真实类型，属**加强**而非放宽。
- 反证（证明新声明是承重的、不是把检查关掉）：临时移走 `debug-hook.d.ts` 后 `tsc --noEmit` 立刻报 `apps/web/src/main.tsx(13,10)`、`tests/e2e/m1.spec.ts(116,53)` TS2339 与同文件 `(117,31)` TS7006；放回后 typecheck 退出码 0。
- 版本控制：`git init`（分支 `main`），`.gitignore` 排除 `node_modules/`、`dist/`、`test-results/`、`playwright-report/`、本地 `.env*` 与编辑器/OS 垃圾文件；提交前确认无 `.env`、密钥、令牌、真实服务器地址等私有数据入仓（仓库内 token/口令字样只出现在设计文档的**方案描述**里）。

## 本轮确定的架构决策（详见设计文档 §1 / §8）
同源模块化单体（Fastify + 静态 SPA，无 CORS）；服务端会话（DB 存 token 哈希，HttpOnly Cookie，非 JWT）；scrypt 口令哈希；私有 API 一律从会话派生 `account_id`（不接受请求体/路径传账号）；个人数据与诊断事件物理分表、分路由、分一致性等级；运维权限用环境变量 Bearer token，未配置时 404；本地开发 SQLite（`node:sqlite`），生产候选 PostgreSQL 但**不承诺可切换**；迁移用编号 SQL + 校验和 + 单事务且只允许两库共同子集；备份 `VACUUM INTO`/`pg_dump -Fc` + 异机复制 + 每月恢复演练。

## 本轮遗留（不变的事实）
前一次后台开发任务在用户叫停前已写入 React/Vite 代码、依赖、测试与截图/录屏等**免登录原型文件**；本轮已把它们纳入 git 以固定基线，但它们**未按需求 v2.1 验收**，不可称为已交付的 M1，也不可据此部署。`docs/CHARTER-v1.md` 是用户原件副本。`docs/architecture/ADR-000-foundation.md` 与 `docs/acceptance.md` 的旧方案标记已撤回；ADR-001 同属旧前提，须重审。

## 版本控制（本地仓库，无远端）
- 分支 `main`；**B0 首次提交**：`1bc20b2881e4e7833216277780971efe0a0b4fd9`（`1bc20b2`），61 个受跟踪文件，`node_modules/`(140M)、`dist/`、`test-results/`(1.3M)、`playwright-report/`(1.8M) 均由 `.gitignore` 排除。
- 无远端、未推送、未部署、未发布；无 `AGENTS.md`（未获用户同意）。
- 提交后 `git status --short --branch` 输出仅 `## main`（工作区干净）。

## 已核事实（B0 实测，非推断）
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

## 下一步（严格按序）
1. ~~**B0**：修 typecheck 根因（唯一共享 `debug-hook` 类型，两侧引用，不删测试）→ `npm run check` 退出码 0；`git init` + 首次提交。~~ **已完成（本轮）**。
2. **B1（下一道闸门，尚未开始）**：`apps/api` 骨架 + 启动配置校验（缺项即退出、不静默降级）+ `migrations/0001_init.sql` + 迁移运行器（编号 + 校验和 + 单事务）+ `GET /api/healthz` + 由 API 同源托管构建后的 SPA。**通过标准**：`npm run check` 仍为 0；新增 API 单测通过；`/api/healthz` 本机实测 200 且响应体含版本与迁移状态；SPA 深链接经 API 直接访问返回 index.html；未登录访问私有路由按设计返回 401 而非页面。
3. **B2/B3**：注册登录会话与限速；目录/实验 API 与深链接门禁（跨账号隔离测试先行）。
4. **B4/B5**：收藏与最近使用；事件管线 + 内部查询/导出 + 审计 + 数据缺口标记。
5. **B6**：端到端切片 + 三视口截图/录屏证据；B7 参数快照可选；B8 CI 与备份演练收口。

## 阻塞与未决
- 阻塞公开上线（不阻塞本地）：服务器参数与部署布局（Q1）、域名/HTTPS 与 Cookie 前缀（Q2）、服务地域与未成年人政策/留存期限（Q3）、账号删除/数据导出是否前置（Q4）、多实例与共享限速（Q6）。
- 未做：服务器只读侦察、目标库迁移与授权实跑、标识归属验证（首版不做短信/邮件）。
- 不得擅自改生产；不得在无测试输出/证据时声称通过或 URL 可用；未经用户明确同意不新增 `AGENTS.md`、不推送远端、不部署（本轮未推送、未部署、未发布）。
