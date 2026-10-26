# PROJECT_STATE

最后更新：2026-10-26 21:30（B3 完成：统一 `requireSession` 门禁 + 服务端内容索引 + SPA 登录/注册 + 深链接 302；后端 185 测试、前端 76 测试、真实进程 smoke 64/64、真实浏览器 E2E 31 通过/2 条件跳过；**仍不含**收藏/最近使用/事件/运维通道，B4/B5 才做）；buildVersion：`0.1.0-m1`（脚手架版本号，尚未对应已验收里程碑）。

## 当前状态
需求基线 `docs/requirements-v2.1.md` 已定：强制登录、自注册不分师生、本人收藏与去重最近使用、内部按账号诊断事件、参数仅显式保存一份快照。宏观架构见 `docs/architecture/ADR-002-authenticated-platform.md`；原型审计见 `docs/architecture/A-stage-audit.md`；A 阶段设计见 `docs/architecture/A-stage-design.md`（权限矩阵、数据/事件字典、认证/会话/滥用控制、API 契约、数据库选型论证、23 条需求可测试追溯、B0–B8 顺序、未决问题与风险）。
**B0（工程地基修复 + 版本控制）已完成**，`npm run check` 与 `npm run test:e2e` 均退出码 0（实测输出见下）。
**B1（服务端骨架）已完成**：`apps/api` 可启动、配置缺失即退出 1、迁移带校验和且按序单事务、`/api/healthz` 返回版本与迁移状态、构建后的 SPA 由同一进程同源托管；`npm run check` 退出码 0，API 测试 68 个全绿，真实进程 smoke 25/25 通过（证据见 `docs/evidence/b1/`）。
**B2（认证闭环）已完成**：`POST /api/auth/register|login|logout` 与 `GET /api/auth/session` 已真实可用（scrypt 口令哈希、服务端可撤销会话、HttpOnly Cookie、CSRF Origin+JSON 守卫、进程内限速、429 带 `Retry-After`）。
**B3（授权门禁）已完成**（本轮）：`requireSession()` 是唯一授权点（Cookie → sha256 → `session` 行 → `account.status`，逐请求判定，`onRequest` 阶段早于任何解析）；`/api/catalog`、`/api/experiments/:id` 由**启动时校验的内容索引**提供服务且只对有会话的请求返回；匿名访问 `/`、`/experiments/:slug` 一律 302 `/login?next=`，仅 `/login`、`/register`、`/about` 公开；SPA 有真实登录/注册页与会话感知路由。**B3 仍不含**：收藏/最近使用（B4）、事件/反馈/运维查询（B5）、参数快照（B7 可选）。`/api/me/*`、`/api/events`、`/api/feedback`、`/api/internal/*` 当前是 **404**（不挂假端点），B4/B5 逐个落地。
**仍未按需求 v2.1 验收，不可称 M1 完成，不可部署，无公网 URL。** 本机已可运行完整登录 → 目录 → 实验闭环（真实浏览器验证，见 `docs/evidence/b3/`），但“收藏/最近使用/按账号诊断”尚未实现，因此需求 §4.3/§4.4 未满足。
**历史说明（B1 时期的事实，已被 B3 取代）**：B1 时 `/api/auth/*` 未挂载（404），所有需登录的路由一律 401 占位，`/api/internal/*` 404，SPA 深链接返回公开构建产物。B2 挂载了认证；B3 用 `requireSession()` 取代了占位并把深链接改为 302。现存的不变事实是：**`/api/me/*`、`/api/events`、`/api/feedback`、`/api/internal/*` 尚未实现，一律 404**（不挂假端点）；静态 JS/CSS 包本身无法用登录保护（设计要求 §2 已声明）。
原免登录原型（`apps/web` 的旧页面 + `experiments/math-functions`）已在 B3 改造为登录后使用：目录来自 `/api/catalog`，实验页先取 `/api/experiments/:id` 再渲染。

## B0 本轮做了什么（根因修复，非打补丁）
- 根因：`Window.__openedulab` 被**两处**以不同类型重复声明 —— `apps/web/src/vite-env.d.ts:9` 为 `unknown`，`tests/e2e/m1.spec.ts:7` 为具体对象类型。TypeScript 接口合并要求同名属性类型完全一致，故报 TS2717；由于合并失败，测试文件自身的读取退化为 `{}`/隐式 any，连带 TS2339（原第 125 行）与 TS7006（原第 126 行）。
- 修法：新增**唯一**声明文件 `apps/web/src/debug-hook.d.ts`，用真实服务类型 `AppServices`（`apps/web/src/services/index.ts`）约束钩子形状；删除 `vite-env.d.ts` 与 `m1.spec.ts` 中的两处重复声明。生产运行时未改（`main.tsx` 的 `if (import.meta.env.DEV)` 赋值逻辑不变），测试一条未删、断言一条未放松；类型从 `unknown` 收紧为真实类型，属**加强**而非放宽。
- 反证（证明新声明是承重的、不是把检查关掉）：临时移走 `debug-hook.d.ts` 后 `tsc --noEmit` 立刻报 `apps/web/src/main.tsx(13,10)`、`tests/e2e/m1.spec.ts(116,53)` TS2339 与同文件 `(117,31)` TS7006；放回后 typecheck 退出码 0。
- 版本控制：`git init`（分支 `main`），`.gitignore` 排除 `node_modules/`、`dist/`、`test-results/`、`playwright-report/`、本地 `.env*` 与编辑器/OS 垃圾文件；提交前确认无 `.env`、密钥、令牌、真实服务器地址等私有数据入仓（仓库内 token/口令字样只出现在设计文档的**方案描述**里）。

## B1 本轮做了什么（服务端骨架，TDD；不含认证）
先写测试再写实现：`apps/api/test/` 的 5 个测试文件在实现前全部无法加载（`docs/evidence/b1/tests-red.txt`，5/5 失败、0 测试可运行），实现后 68/68 通过（`docs/evidence/b1/check-b1.txt`）。测试覆盖的正是闸门要求：
- **配置 fail-closed**（19 条）：缺任一必填项时一次性列出全部字段；非法端口/环境/Origin（含带路径、查询串、内嵌凭据）被拒；静态目录缺 `index.html`、迁移目录无 `NNNN_*.sql` 被拒；**未知 `OEL_*` 变量也报错**（防拼写错误静默关掉某个设置）；生产环境禁止 `:memory:`。只有 `OEL_HOST`(127.0.0.1) 与 `OEL_LOG_LEVEL`(info) 有默认值。
- **迁移运行器**（13 条）：按数字序应用；每文件 sha256 校验和 + 独立事务；重复运行幂等（`applied_at` 不变）；**改已应用文件→`checksum_mismatch` 拒绝启动**；**半途失败整文件回滚**（建了表也一并撤销、不写 `schema_migrations`、修复后可继续）；已应用文件被删→`missing_file`；同版本两文件→`duplicate_version`；文件名不合规→`invalid_filename`；`journal_mode=wal`/`foreign_keys=1`/`busy_timeout=5000` 实测生效。
- **healthz**（4 条）：200 且含 `appVersion`、`uptimeSeconds`、`timestamp`、`database.migrations{applied,latest,pending}`；**不泄露路径/配置/口令字样**；启动后新增迁移文件→503 `degraded`；迁移失败→`buildApp` 直接抛错（不监听）。
- **静态同源托管**（16 条）：`/` 与深链接 `/experiments/math.functions` 返回构建的 index.html（`no-cache`）；资源按 MIME 正确；缺资源 404 不回落 HTML；**路径穿越用例覆盖 `%2f`、`%5c`、双重编码 `%252e`、`%00` 等 8 种载荷**，全部被拒（400/403/404）且不泄露仓库 `package.json`；`/package.json` 本身 404；非 GET 深链接不返回 SPA；带 `nosniff`。
- **私有路由占位**（16 条）：12 条未来需登录的路由对匿名请求一律 401 `unauthenticated`（**带伪造 `oel_sid` Cookie 仍 401**）；`/api/internal/*` 与 `/api/auth/session` 明确 404（没有假会话、没有运维后门）；未知 `/api/*` 返回 JSON 404 而非 SPA。

实现要点（对齐设计 §1/§9）：模块化单体，一个 Fastify 5 进程同时提供 `/api/*` 与构建后 SPA（无 CORS）；DB 访问集中在 `src/db/`（`node:sqlite`，连接级 pragma 不写进迁移）；迁移只允许两库共同 SQL 子集；`0001_init.sql` 按设计 §5 建 8 张表（B2–B5 才会用，当前无任何读写）；错误体统一 `{error:{code,message}}`，5xx 不返回堆栈与内部消息；全局体上限 64KB；`trustProxy=false`。`package.json` 描述已从"no-login …"改为明确写明"pre-auth prototype, login NOT implemented"，`engines` 锁 `>=22.5 <23`（`node:sqlite` 起点），并新增 `typecheck:api`/`test:api`/`build:api`/`start:api`/`smoke:api`，`check` 串入 API typecheck 与测试。另加 `.env.example`、`apps/api/README.md`（含"不得据此宣称访问控制"的状态说明）；`.gitignore` 增加 `apps/api/data/`、`*.sqlite*`；ESLint 忽略改为 `**/dist/**`（否则 `apps/api/dist` 会被 lint）。

**未做的事（刻意）**：没有注册/登录/登出/会话、没有 Cookie、没有限速、没有目录/实验/收藏/最近使用/事件/反馈的读写实现、没有 `/api/internal` 运维通道、没有 SPA 登录门禁与 302、没有部署。因此本轮**不能**声称"未登录不能访问实验"已成立；当前能保证的只有：占位路由拒绝所有人、API 路径不会回落成页面、配置/迁移/健康检查行为可复现。

测试运行器已知问题：Vite 5 不认识 `node:sqlite` 内建模块（会去找名为 `sqlite` 的包），`apps/api/vitest.config.ts` 用别名指向 `test/support/sqlite.ts`（内部 `createRequire` 加载真实内建模块）。仅影响测试进程；运行时直接 `import 'node:sqlite'`。

依赖安全：初次安装的 `@fastify/static@8.3.0` 带 4 条**高危**路径穿越/编码分隔符绕过公告（GHSA-pr96-94w5-mx2h 等），已升级到修复版 `10.1.7`（官方兼容表：`>=8.x` ↔ Fastify `^5.x`；v10 的 `setHeaders(reply, path)` 签名变更已适配并被测试抓到）。升级后 `npm audit --omit=dev` 为 **0 漏洞**，并补了上条所列的编码穿越用例。

## B2 本轮做了什么（认证闭环，TDD；不含授权门禁）
先写 6 个测试文件再写实现：把 `registerAuthRoutes` 从 `app.ts` 卸下（回到 B1 行为）后跑同一套测试为 **74 失败 / 68 通过**（`docs/evidence/b2/tests-red.txt`），装回后 **142/142 通过**（`docs/evidence/b2/check-b2.txt`）。B1 的 68 条断言一条未删、未放宽；唯一被替换的是 B1 的 `/api/auth/session` **必须 404** 那条——它断言的是"功能不存在"，B2 交付后必然失效，替换后仍禁止假会话（改为：已挂载、匿名必返回 `authenticated:false`、`cache-control: no-store`）。
- **注册/登录/登出/会话**：`POST /api/auth/register`(201)、`POST /api/auth/login`(200)、`POST /api/auth/logout`(204)、`GET /api/auth/session`(200)。成功响应只回 `displayHint`（`t***@example.com`、`861****1234`），**不**回账号 ID、完整手机号/邮箱或 token；失败体统一 `{error:{code,message}}`，全部 `no-store`。
- **标识规范化与唯一性**：邮箱 trim + 小写（≤254、单个 `@`、域名含点、无空白/控制字符）；手机去空格/连字符/括号/点、保留前导 `+`（7–20 位数字）。唯一键 `(login_kind, normalized_login)`，大小写/空格/分隔符变体判为同一标识 → 409 `identifier_taken`；邮箱与手机命名空间互不占用。首版不验证归属，`verified_at` 恒 NULL，文案不出现"已验证"。
- **口令**：10–128 码点、允许空格与中文、拒绝纯空白；存储 `scrypt$32768$8$3$<salt16B>$<key32B>`；`timingSafeEqual` 比较；账号不存在/已停用也跑一次等价 scrypt（用例断言两条路径耗时同量级）；参数过旧的哈希在下次登录成功后升级（用例：`scrypt$16384$8$1$…` → `scrypt$32768$8$3$…`）；截断、篡改、非 scrypt 或超大 N 的存储串直接判 false，不执行 scrypt。
- **会话**：32 字节随机 token（base64url，43 字符），库内只存 `sha256(token)`；绝对 60 天、空闲 14 天（`last_seen` 最多每小时写一次）；每次请求都判 `revoked_at IS NULL`、`expires_at`、空闲窗口与 `account.status='active'`；登出写 `revoked_at` 并清 Cookie，旧 Cookie 重放 → `authenticated:false`、二次登出 401；禁用账号立刻失效（用例直接改库置 `disabled`）；只撤销登出的那条会话，另一条会话仍有效。Cookie：生产 `__Host-oel_sid` + `Secure`，本地 `oel_sid`（无 Secure），均 `HttpOnly; SameSite=Lax; Path=/; Max-Age=60d`、无 `Domain`。
- **CSRF**：写路由挂 `onRequest` 守卫（早于 body 解析）——`Origin` 必须命中允许集合（生产仅 `OEL_PUBLIC_ORIGIN`；非生产额外允许同端口的 `localhost`/`127.0.0.1`），**缺 Origin 直接拒**；`Sec-Fetch-Site` 出现时必须是 `same-origin`/`none`；`Content-Type` 出现时必须是 `application/json`（urlencoded/multipart/text 全 403）。守卫先于撤销执行：伪造的登出被拦后会话仍然有效。没有 CSRF token 表；将来加 `<form>` 提交或第三方嵌入必须先补 token（已写入 README 升级条件）。
- **限速**（进程内固定窗口，重启清零，单实例假设 D14/Q6）：注册 5/小时/IP、3/天/标识；登录 30/15min/IP、10/15min/标识+IP、连续失败 10 次锁 15 分钟；session/logout 300/分钟/IP。429 一律带 `Retry-After`，锁定文案与 401 不同（避免用户反复试正确口令），窗口过后自动恢复（用例把注入时钟 +16min 后登录成功）。
- **不信任调用方身份**：body schema `additionalProperties:false` 且 AJV `removeAdditional:false`（多余字段 400 而不是静默剥离；用例覆盖 `accountId`/`id`/`status`/`passwordHash`），query 里塞 `account_id` 也无效，账号 ID 一律服务端 UUIDv4，路由代码路径里不存在"按传入 id 取账号"。
- **无新迁移**：`0001_init.sql` 的 `account`/`session` 已够用，未改动已应用文件（校验和不变），符合"必要时才加迁移"。
- **顺带加固**：Fastify logger `redact` 掉 `cookie`/`authorization`；错误处理器补 401/403/404/429 → `unauthenticated`/`forbidden`/`not_found`/`rate_limited` 映射（原先一律 `validation_failed`）。

**未做的事（刻意）**：没有 B3 资源门禁（占位 401 保留，持有效会话也 401）、没有 `requireSession()`、没有 SPA 登录/注册页面或路由守卫、没有 `/api/internal`、没有找回密码/换绑/号码归属验证、没有多实例共享限速、没有部署或公网 URL。因此本轮**不能**声称"未登录不能访问实验"或"登录闭环完成"。

## B3 本轮做了什么（授权门禁 + 内容索引 + SPA 登录，TDD；不含个人数据与诊断）
先写 5 个测试文件（authorization / catalog / experiments / spa-gate / 重写的 private-routes 路由清单）再写实现：实现前 `npx vitest run --config apps/api/vitest.config.ts` 为 **5 个文件失败 / 10 通过，28 失败 / 136 通过**，退出码 1（`docs/evidence/b3/tests-red.txt`）；实现后 **15 文件 / 185 测试全绿**（`check-b3.txt`）。
- **唯一授权点** `src/http/auth-context.ts`：`requireSession()` 作为 `onRequest` 钩子（早于 body/query 校验与任何 handler）解析 Cookie → `sha256` → `session` 行 → 校验 `revoked_at`/`expires_at`/空闲窗口/`account.status='active'` → 把 `SessionContext` 放进 `request.account`。`buildApp` 只创建一个 `AuthService`，认证路由与门禁共用同一实例，所以“已登录”只有一个答案。
- **拒绝不可区分**：无 Cookie、伪造串、已撤销、绝对过期、空闲过期、被禁用账号、会话行被删 —— 全部返回同一个 `401 {error:{code:'unauthenticated'}}` + `cache-control: no-store`，不含资源元数据、不暗示会话是否存在。
- **内容索引** `src/domain/content-index.ts`：启动时读取 `OEL_CONTENT_DIR` 下每个 `<folder>/manifest.json`（新增必填配置项），整体校验后才建索引——重复 id/slug、非 semver（含新增必填的 `contentVersion`）、SDK 主版本不兼容、缺 `locales/zh-CN|en.json` 或其中 title/description 为空、内容目录为空，**任一问题都拒绝启动**（`ContentIndexError` 列出全部问题），不会“悄悄少一个实验”。
- **受保护内容接口**：`GET /api/catalog`（`subject`/`grade`/`concept`/`q`/`locale`/`limit`，未知参数与非法值 400，`limit` 1–50，`q` 多词 AND，默认 zh-CN）与 `GET /api/experiments/:experimentId`（非法 id 400、未收录 404），均返回**仅索引字段**（本地化标题/说明、`contentVersion`、`languages`），响应里没有文件系统路径、没有 `manifest.json` 字样、没有账号信息。
- **深链接门禁** `src/http/spa-gate.ts`：`Accept: text/html` 的 GET/HEAD 且非静态资源、非 `/login|/register|/about` → 无会话即 `302 /login?next=<编码后的原路径+查询串>`；API 路径永不重定向（仍走自己的 401）；只对“纯路径字符”生效，编码/控制字符的穿越探测仍交给静态层返回 400/403/404（这条取舍写在源码注释里：编码路径可以拿到公开壳子，但拿不到数据）。
- **路由清单** `src/http/route-inventory.ts` + `test/private-routes.test.ts`：用 Fastify `onRoute` 钩子记录真实路由表，声明“公开（healthz/auth 四个）”与“受控（catalog/experiments）”两张清单；未分类的 `/api` 路由会让测试失败，且每条受控路由都对匿名与伪造 Cookie 断言 401。新增端点必须同时改清单，不能“默认公开”。
- **取代的旧断言（不是放宽）**：B1/B2 的“所有私有路由拒绝所有人（含持会话者）”占位测试被路由清单+正向访问取代；`static.test.ts` 里“`/` 与深链接返回 200 公开壳子”的两条被 302 门禁取代，同时**新增**“`/login` 公开返回壳子”“会话被撤销后再次 302”等断言。
- **SPA**：`services/api.ts`（同源 `credentials:'same-origin'`、JSON、错误码→`ApiError`、网络失败= `network_error` 而不是假成功、不接触 token）；`LoginPage`（邮箱/手机切换、错误文案统一“账号或密码不正确”、明确写“标识未核验”，注册与登录同一组件）；`App` 会话感知路由（加载中/匿名→登录页/已登录→目录与实验；`next` 只接受站内绝对路径，`//host`、反斜杠、`javascript:`、超长值一律拒绝）；`CatalogPage` 改为 **从 `/api/catalog` 取数据**（加载中/失败/重试三种状态，失败不显示任何列表、不补造内容）；实验页先 `GET /api/experiments/:id` 再渲染，并在页首显示服务器返回的内容版本。
- **文案不再说谎**：删除 `app.noLogin`、`about.noAccounts`、`footer.noBackend` 等免登录/无后端文案，改为“账号仅用于访问控制、注册标识不是已验证身份、保存了掩码标识/口令哈希/收藏/打开过哪些实验、事件仅固定类别”。中英键集仍严格一致（`tests/i18n.test.ts` 强制）。
- **E2E 改为打真实产物**：`scripts/e2e-server.mjs` 现场构建并启动 **真实 Fastify 进程**（同源托管真实 `dist`，端口 3220，临时数据库每次重建），Playwright 用 `auth.setup` 注册共享账号并保存会话；`gate.spec.ts` 用**无 Cookie 上下文**验证 302/401/伪造 Cookie/登出后重放旧 Cookie 仍 401；`app.spec.ts` 是原 `m1.spec.ts` 的登录版（改名保留全部行为断言，新增“生产包不含调试钩子”“`contentVersion` 来自服务器”）。
- **未新增迁移**：B3 只需 `GET` 与索引，`0001_init.sql` 未改动（校验和仍 `289c27d35781…`）。

**未做的事（刻意）**：没有收藏/最近使用（B4）、没有事件/反馈/运维查询（B5）、没有参数快照（B7 可选）、没有找回密码/改绑/号码验证、没有多实例共享限速、没有部署或公网 URL。因此本轮**不能**声称需求 §4.3（收藏与最近使用）或 §4.4（按账号诊断）已满足。

## 本轮确定的架构决策（详见设计文档 §1 / §8）
同源模块化单体（Fastify + 静态 SPA，无 CORS）；服务端会话（DB 存 token 哈希，HttpOnly Cookie，非 JWT）；scrypt 口令哈希；私有 API 一律从会话派生 `account_id`（不接受请求体/路径传账号）；个人数据与诊断事件物理分表、分路由、分一致性等级；运维权限用环境变量 Bearer token，未配置时 404；本地开发 SQLite（`node:sqlite`），生产候选 PostgreSQL 但**不承诺可切换**；迁移用编号 SQL + 校验和 + 单事务且只允许两库共同子集；备份 `VACUUM INTO`/`pg_dump -Fc` + 异机复制 + 每月恢复演练。

## 本轮遗留（不变的事实）
前一次后台开发任务在用户叫停前已写入 React/Vite 代码、依赖、测试与截图/录屏等**免登录原型文件**；本轮已把它们纳入 git 以固定基线，但它们**未按需求 v2.1 验收**，不可称为已交付的 M1，也不可据此部署。`docs/CHARTER-v1.md` 是用户原件副本。`docs/architecture/ADR-000-foundation.md` 与 `docs/acceptance.md` 的旧方案标记已撤回；ADR-001 同属旧前提，须重审。

## 版本控制（本地仓库，无远端）
- 分支 `main`；**B0 首次提交**：`1bc20b2881e4e7833216277780971efe0a0b4fd9`（`1bc20b2`），61 个受跟踪文件，`node_modules/`(140M)、`dist/`、`test-results/`(1.3M)、`playwright-report/`(1.8M) 均由 `.gitignore` 排除。
- **B1 提交**：`80c2f90532b02ac63c88c1799a68b539b5b18147`（`80c2f90`），34 个文件变更（+3556/−26），受跟踪文件总数 89；`apps/api/dist/`（tsc 产物）、`apps/api/data/`（本地 SQLite）、`*.sqlite*` 均被忽略，提交后用 `git check-ignore -v` 核对过。工作区只剩一个未跟踪文件 `docs/roadmap.md`（非本轮产出，**未**纳入提交）。
- **B1 修复提交**：`9e8d1cde2e46f00aaf597f0c3542c99447541b90`（`9e8d1cd`），把 `@fastify/static` 从有 4 条高危穿越公告的 `8.3.0` 升到修复版 `10.1.7`，适配 v10 的 `setHeaders(reply, path)` 签名，并把穿越用例从 3 个扩到 8 个编码载荷；该提交后 `npm audit --omit=dev` 为 0 漏洞。
- **B2 提交**：`21b052541f799105da89a2999ed5abc9dc50a666`（`21b0525`），32 个文件变更（+4779/−27）：新增 `src/security/*`(5)、`src/db/{account,session}-repository.ts`、`src/domain/auth-service.ts`、`src/http/{auth-routes,csrf}.ts`、6 个认证测试文件 + `test/support/auth-app.ts`、`docs/evidence/b2/`(7)；改动 `src/app.ts`、`src/http/errors.ts`、`test/private-routes.test.ts`（仅替换那条"session 必须 404"的占位断言）、`vitest.config.ts`（超时）、`scripts/smoke.mjs`、`apps/api/README.md`、`.env.example`、`package.json`。**无新迁移**：`0001_init.sql` 未改动，校验和仍为 `289c27d35781…`；提交用逐路径 `git add`（未用 `-A`），`apps/api/dist`、`apps/api/data`、`*.sqlite*` 仍被忽略，未推送。
- **B3 提交**：`0c8fd507e01df2ad2befc130b8e59d8650ce6fba`（`0c8fd50`），67 个文件变更（+5112/−432）：新增 `src/domain/content-index.ts`、`src/http/{auth-context,content-routes,route-inventory,spa-gate}.ts`、`src/app.ts` 重写、`apps/api/test/{authorization,catalog,experiments,spa-gate}.test.ts`、`test/support/content.ts`、`apps/web/src/services/api.ts`、`apps/web/src/app/LoginPage.tsx`、`scripts/e2e-server.mjs`、`tests/e2e/{app,gate,auth.setup,support}.ts`、`tests/{api-client,router}.test.ts`、`docs/evidence/b3/`(21)；删除 `src/http/private-routes.ts`；`tests/e2e/m1.spec.ts` 被 `app.spec.ts` 取代（git 记为 rename）；改动 `config.ts`（新增必填 `OEL_CONTENT_DIR`）、`auth-routes.ts`（接受共享 `AuthService`）、`static.ts`（导出 `looksLikeAsset`）、`App/CatalogPage/router/ExperimentHost/contract/registry/locales/styles.css`、`experiments/math-functions/manifest.json`（新增 `contentVersion: 1.0.0`）、`playwright.config.ts`、`scripts/validate-content.mjs`、`apps/api/README.md`、`.env.example`、`package.json`。**无新迁移**：`0001_init.sql` 未改动（校验和仍 `289c27d35781…`）；逐路径 `git add`，未用 `-A`。
- 无远端、未推送、未部署、未发布；无 `AGENTS.md`（未获用户同意）。

## 已核事实（B0/B1/B2 实测，非推断）
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
- **`npm run check`：退出码 0**（`check-b1.txt`），逐段：`tsc --noEmit`（web）0；`tsc -p apps/api/tsconfig.test.json`（API src+test）0；`eslint .` 无输出；web `vitest run` **6 文件 / 46 测试全通过**；`test:api` **5 文件 / 68 测试全通过**（config 19、migrate 13、health 4、static 16、private-routes 16）；`validate-content` → `Content validation OK`；`vite build` 50 modules 成功；`tsc -p apps/api/tsconfig.json` 成功。
- **真实进程 smoke：25/25 通过**（`node apps/api/scripts/smoke.mjs` → `smoke.txt`）。实测事实：缺 `OEL_PORT`/`OEL_DATABASE_PATH` → 退出码 1、stderr 列出两个字段、无 "listening"；空库启动后 `/api/healthz` 200 且 `{"appVersion":"0.1.0-m1","database":{"ok":true,"migrations":{"applied":1,"latest":"0001","pending":0}}}`；深链接 `/experiments/math.functions`（Accept: text/html）200 且返回 1244 字节构建 index.html、`cache-control: no-cache`；同源 `/assets/index-DrcVA2Q_.js` 200、`application/javascript`、175018 字节；`/api/catalog`、`/api/me/favorites`、`/api/me/recent`、`/api/experiments/math.functions` 全部 401 `unauthenticated`（带 `Cookie: oel_sid=forged` 仍 401）；未知 `/api/does-not-exist` → 404 `application/json`（未回落 HTML）；`/assets/missing.js` 404；`schema_migrations` 恰 1 行、`checksum` 为 64 位 sha256；重启后仍 1 行且 `applied_at` 完全不变（`1793014247203`）；把 `0001_init.sql` 追加一行注释后启动 → 退出码 1，错误为 `Migration 0001 (init) was modified after it was applied: recorded 289c27d35781…, file 4ddecbcb6881…`。

### B2 实测（本轮，非推断；原文在 `docs/evidence/b2/`）
- **RED**：把 `registerAuthRoutes` 从 `app.ts` 卸下（回到 B1 行为）后跑 `npx vitest run --config apps/api/vitest.config.ts` → **7 文件失败 / 4 通过，74 失败 / 68 通过**，退出码 1（`tests-red.txt`）；装回后同一命令全绿。
- **`npm run check`：退出码 0**（`check-b2.txt`）：`tsc --noEmit`（web）0；`tsc -p apps/api/tsconfig.test.json` 0；`eslint .` 无输出；web `vitest run` **6 文件 / 46 测试**；`test:api` **11 文件 / 142 测试**（B1 68 + B2 74：register 23、login 8、session 16、security 5、csrf 14、rate-limit 6，另有 B1 的 config/migrate/health/static/private-routes 68）；`validate-content` OK；`vite build` 成功；`build:api` 成功。
- **反证（证明新测试是承重的，不是摆设）**：逐个注入退化后重跑对应用例，均按预期失败（原文 `mutation-*.txt`）：关掉 CSRF 守卫 → csrf 10 条失败（`expected 201 to be 403`）；去掉会话 `accountStatus` 检查 → 禁用账号用例失败（`authenticated:true` vs `false`）；去掉 `revoked_at` 检查 → 登出重放用例失败；去掉邮箱小写规范化 → 重复标识用例失败（400 vs 409）。
- **真实进程 smoke：51/51 通过**（`smoke.txt`；B1 的 25 条全部保留）。真 socket 上的实测事实：注册 201，`Set-Cookie` 含 `HttpOnly; SameSite=Lax; Path=/`、token 为 43 字符 base64url；匿名 `/api/auth/session` → `{authenticated:false}`；注册后 → `true` 且响应不含完整邮箱；`SMOKE@Example.com ` 重复注册 → 409 `identifier_taken`；错口令与不存在标识 **响应体逐字节相同**（401 `invalid_credentials`）且都不下发 Cookie；缺 Origin / 外站 Origin / urlencoded 表单登录 → 403；伪造 Cookie → `authenticated:false`；登出 204 + `Max-Age=0`，重放旧 Cookie → `false`，二次登出 401，重新登录拿到**新 token**；库内 `password_hash` 形如 `scrypt$32768$8$3$…` 且不含口令、`session.token_hash = sha256(cookie token)`；同 IP 连续注册第 6 次起 429 且 `Retry-After=3598`；**重启后 live session 仍 `true`**（会话在 DB，不在内存）、已撤销 session 仍 `false`；篡改迁移仍拒绝启动。
- 测试超时上调到 30s（`apps/api/vitest.config.ts`）：真实 scrypt（N=2^15,r=8,p=3，约 300ms/次）使 10 次失败锁定用例本身约 4s。这是超时，不是断言放宽。

### B3 实测（本轮，非推断；原文在 `docs/evidence/b3/`）
- **RED**：实现前同一命令 → 5 个文件加载失败（缺 `route-inventory`、`OEL_CONTENT_DIR` 未知、无门禁/无 302），**28 失败 / 136 通过**，退出码 1（`tests-red.txt`）。
- **`npm run check`：退出码 0**（`check-b3.txt`）：web `tsc --noEmit` 0；`tsc -p apps/api/tsconfig.test.json` 0；`eslint .` 无输出；web `vitest run` **8 文件 / 76 测试**（新增 `api-client` 9 + `router` 21）；`test:api` **15 文件 / 185 测试**（B1 68 + B2 74 + B3 43：authorization 17、catalog 17、experiments 6、spa-gate 12，且 private-routes 由 16 条占位断言改为 5 条更强的清单断言，static 由 16 增至 18）；`validate-content` OK；`vite build` 成功；`build:api` 成功。
- **反证（证明新测试是承重的）**：拿掉 `/api/catalog` 上的 `onRequest: gate.requireSession` → authorization+catalog+清单 **19 条失败**（`mutation-gate-off.txt`）；不注册 SPA 门禁钩子 → spa-gate+static **7 条失败**（`mutation-spa-gate-off.txt`）。两次都从备份恢复，工作区无残留。
- **真实进程 smoke：64/64 通过**（`smoke.txt`；B2 的 51 条断言只有 2 条因门禁上线而改写，其余保留）。真 socket 上新增实测：匿名 `/experiments/math.functions`（Accept text/html）→ **302 `location=/login?next=%2Fexperiments%2Fmath.functions`** 且响应体不含 `<div id="root">`；`/login` → 200 且返回构建 index.html（`cache-control: no-cache`）；`/api/catalog`、`/api/experiments/math.functions` 匿名 → 401 `unauthenticated`（伪造 `oel_sid` 仍 401；带 `Accept: text/html` 也**不**被重定向）；`/api/me/favorites`、`/api/me/recent`、`/api/events`、`/api/feedback` → **404 `not_found`**（无假端点）；登录后 `/api/catalog?locale=en` → 200 且列出 `math.functions@1.0.0`、`no-store`；实验详情 → 200 含本地化标题/`contentVersion`/`sdkVersionRange ^1.x`、无 `manifest.json` 字样；未收录 id → 404；**登录后**深链接 → 200 返回壳子；重启后会话仍有效、撤销仍失效；篡改迁移仍拒绝启动。
- **真实浏览器 E2E：31 通过 / 2 条件跳过 / 0 失败**（`e2e-b3.txt`；打的是 `scripts/e2e-server.mjs` 起的真实 Fastify + 真实 `dist`，端口 3220）。实测路径：注册（`/register` → 目录）→ 目录搜索/筛选/计数 → 中英切换 → 打开实验（页首显示服务器内容版本 1.0.0）→ 调参/重置/线性模式 → 退化告警 → 反馈预览 → 全屏进出 → 无跨源请求且**生产包无 `window.__openedulab`** → 三处可访问性检查 → 手机视口无横向滚动；匿名上下文：`/` → `/login?`、深链接 → 保留 `next`、错口令显示“Wrong identifier or password.”且不跳转、正确口令后直达该深链接、`page.request` 直取 API 全 401、`/about` 公开可读、登出后刷新仍回登录页且**旧 Cookie 重放 401**、`/api/internal/*` 对匿名与普通账号均 404。截图与 `walkthrough.webm` 存 `docs/evidence/b3/`。
- 已知取舍（写在源码里，不是遗漏）：① 编码/控制字符的路径不参与 302 门禁（交给静态层 400/403/404），因此带 `%xx` 的导航能拿到公开壳子——壳子无数据，API 仍 401；② 静态 JS/CSS 本身不可登录保护（设计要求 §2 已声明，验收口径只测 API 与 HTML 门禁）；③ E2E 用一份共享会话（注册 5/小时/IP 是刻意不放宽的限制），登出/重放测试另注册独立账号。
## 下一步（严格按序）
1. ~~**B0**：修 typecheck 根因（唯一共享 `debug-hook` 类型，两侧引用，不删测试）→ `npm run check` 退出码 0；`git init` + 首次提交。~~ **已完成（本轮）**。
2. ~~**B1**：`apps/api` 骨架 + 启动配置校验（缺项即退出、不静默降级）+ `migrations/0001_init.sql` + 迁移运行器（编号 + 校验和 + 单事务）+ `GET /api/healthz` + 由 API 同源托管构建后的 SPA。~~ **已完成（本轮）**：`npm run check` 退出码 0；API 测试 68/68；真实进程 smoke 25/25；深链接返回 index.html；私有路由占位一律 401。注意：**401 是占位拒绝，不是访问控制**。
3. ~~**B2（认证闭环）**：注册/登录/登出/会话与限速（scrypt、`timingSafeEqual`、HttpOnly Cookie、CSRF Origin+JSON、429 + `Retry-After`）。~~ **已完成（本轮）**：R-01..R-04、R-06 在 API 集成层全绿（`apps/api/test/auth.register|auth.login|session|auth.security|csrf|rate-limit.test.ts`）；哈希格式、`timingSafeEqual`、Cookie 属性、生产 `__Host-`+`Secure`、禁用账号、过期/空闲/撤销、伪造 Cookie、重复标识、重复尝试锁定都有断言；真实进程 smoke 51/51。**B2 不含授权**：占位 401 仍在，持有效会话访问 `/api/catalog` 依旧 401。
4. ~~**B3（授权门禁）**：`requireSession()` + 目录/实验 API + SPA 深链接 302 + 登录/注册页 + 路由清单。~~ **已完成（本轮）**：占位 401 与“公开深链接”两条旧断言被取代；真实浏览器注册→目录→实验通过；E2E 31 通过/2 条件跳过；mutation 反证两次。
5. **B4（下一道闸门）**：`/api/me/favorites`（GET/PUT/DELETE，幂等）+ `/api/me/recent`（GET/POST，主键去重 upsert）+ 实验页收藏按钮 + “我的收藏/最近使用”页面（跨会话回读、取消收藏生效、响应无参数键）；事件端点关闭时收藏与最近使用仍独立可用；把这三条路由加进 `route-inventory` 清单；跨账号隔离用例（他人点不开我的收藏）。
6. **B5**：`/api/events`（白名单 7 类 + 服务端二次校验/去重/限速 + `occurred_at_min` 服务端时间）、`/api/feedback`、`/api/internal/*`（Bearer + `X-Operator-Label` + `reason` + `internal_audit`）、`dataGaps`；事件契约按设计 §10 变更（`experiment_complete` 移除、拆成 `first_interaction` + `control_used`）需先写影响分析 `docs/architecture/impact-B5-event-contract.md` 再改代码。
7. **B6**：三视口完整流程 E2E + 跨账号隔离 + 过期/登出 + 故障注入（断网/事件端点 503）+ 无障碍 + 构建/迁移/备份恢复基础检查；本机测试服务器 URL 真实可测，公网/生产仍不授权。
8. **B7** 参数快照（可选，不阻塞主闭环）；**B8** CI、备份演练、状态锚收口。

## 阻塞与未决
- 阻塞公开上线（不阻塞本地）：服务器参数与部署布局（Q1）、域名/HTTPS 与 Cookie 前缀（Q2）、服务地域与未成年人政策/留存期限（Q3）、账号删除/数据导出是否前置（Q4）、多实例与共享限速（Q6）。
- 未做：服务器只读侦察、目标库迁移与授权实跑、标识归属验证（首版不做短信/邮件）。
- 不得擅自改生产；不得在无测试输出/证据时声称通过或 URL 可用；未经用户明确同意不新增 `AGENTS.md`、不推送远端、不部署（本轮未推送、未部署、未发布）。
