# PROJECT_STATE

最后更新：2026-10-27（R5 依赖安全与决策同步；R4 交付前验证 + R3 只读侦察）。**当前声明以「R1」「R2」「R3」「R4」「R5」各节为准**：源码已推送到公开仓库 `Molar2016/openedulab`（PUBLIC，`main`），GitHub Actions 上的 CI **已在真实运行并通过**（run 链路见 `docs/evidence/r1/remote-ci.txt`），参数快照 B7 已实现并验收；R5 同步了负责人的产品决策（首版不做账号删除/个人数据导出、不设未成年人年龄门槛）、修正了 GitHub Pages 的可用性说法并把 6 条开发依赖公告修掉。buildVersion：`0.1.0-m1`。**仍无公网应用 URL**：仓库只有源码，没有部署、没有域名。

## 当前状态
需求基线 `docs/requirements-v2.1.md` 已定：强制登录、自注册不分师生、本人收藏与去重最近使用、内部按账号诊断事件、参数仅显式保存一份快照。宏观架构见 `docs/architecture/ADR-002-authenticated-platform.md`；原型审计见 `docs/architecture/A-stage-audit.md`；A 阶段设计见 `docs/architecture/A-stage-design.md`（权限矩阵、数据/事件字典、认证/会话/滥用控制、API 契约、数据库选型论证、23 条需求可测试追溯、B0–B8 顺序、未决问题与风险）。
**B0（工程地基修复 + 版本控制）已完成**，`npm run check` 与 `npm run test:e2e` 均退出码 0（实测输出见下）。
**B1（服务端骨架）已完成**：`apps/api` 可启动、配置缺失即退出 1、迁移带校验和且按序单事务、`/api/healthz` 返回版本与迁移状态、构建后的 SPA 由同一进程同源托管；`npm run check` 退出码 0，API 测试 68 个全绿，真实进程 smoke 25/25 通过（证据见 `docs/evidence/b1/`）。
**B2（认证闭环）已完成**：`POST /api/auth/register|login|logout` 与 `GET /api/auth/session` 已真实可用（scrypt 口令哈希、服务端可撤销会话、HttpOnly Cookie、CSRF Origin+JSON 守卫、进程内限速、429 带 `Retry-After`）。
**B3（授权门禁）已完成**（本轮）：`requireSession()` 是唯一授权点（Cookie → sha256 → `session` 行 → `account.status`，逐请求判定，`onRequest` 阶段早于任何解析）；`/api/catalog`、`/api/experiments/:id` 由**启动时校验的内容索引**提供服务且只对有会话的请求返回；匿名访问 `/`、`/experiments/:slug` 一律 302 `/login?next=`，仅 `/login`、`/register`、`/about` 公开；SPA 有真实登录/注册页与会话感知路由。**B3 仍不含**：收藏/最近使用（B4）、事件/反馈/运维查询（B5）、参数快照（B7 可选）。B3 交付时 `/api/me/*`、`/api/events`、`/api/feedback`、`/api/internal/*` 一律 **404**（不挂假端点），随后由 B4/B5 逐个落地。
**B4（个人数据）已完成**（本轮）：`/api/me/favorites`（GET/PUT/DELETE，幂等）与 `/api/me/recent`（GET/POST，按资源去重 upsert）在 `requireSession` 之后、CSRF 守卫之下工作，SQL 逐条按会话派生的 `account_id` 限定；实验页有收藏开关（失败不谎报成功），`/me` 页展示“我的收藏”与“最近使用”，最近使用只存“哪个资源、最近一次何时”，重启与换会话后仍可回读。
**B5（诊断与运维）已完成**（本轮）：事件契约按设计 §10 变更（`experiment_complete` 移除、拆成 `first_interaction` + `control_used`、全屏方向进 `control_group`、增 `contentVersion`），`POST /api/events` 只接受白名单枚举并以服务端时间/账号/去重键落库，`POST /api/feedback` 是唯一自由文本入口（只进 `feedback` 表），`/api/internal/*` 用环境变量 Bearer 令牌（未配置即 404）+ 强制“用途 + 运维标识”+ `internal_audit` 落账，`dataGaps` 把“事件关闭”的窗口标成未知而不是 0。关闭诊断端点后实验、收藏、最近使用照常（有浏览器级故障注入用例）。
**B6（端到端验收）已完成**（本轮）：三视口（390×844 / 1280×720 / 1024×768）完整流程、跨账号隔离、登出与异地撤销、断网与 503 故障注入、键盘可用性、`VACUUM INTO` 备份恢复检查；真实日志、截图、录屏与备份报告在 `docs/evidence/b6/`。
**本机已可完成需求 §4 的全部六条场景**（注册/登录/目录/实验/收藏与最近使用/内部诊断/失败路径），取证见 `docs/evidence/b3`–`b6`，B8 的复核实测见 `docs/evidence/b8/`。**仍不可称 M1 完成、不可部署、无公网 URL**：源码已在公开仓库且 CI 在 GitHub 上真实运行通过（2026-10-26 起）；没有找回密码、标识归属验证；**账号删除与个人数据导出经 2026-10-27 决定不在首版范围**（不是待实现的缺口，见「R5」）；留存清理只有 CLI（无 HTTP 入口）；没有真实服务器与域名，公网相关事项仍待授权。**公开仓库只有源码，没有可访问的应用地址**（详见「R1」一节）；**GitHub Pages 未启用**（静态托管无法承载登录/API/SQLite，详见「R5」）。
**历史说明（仅描述 B1/B2 当时的形态，已被 B3–B8 取代，勿据此判断当前行为）**：B1 时 `/api/auth/*` 未挂载（404），需登录的路由一律 401 占位，`/api/internal/*` 404，SPA 深链接返回公开构建产物；B2 挂载认证；B3 用 `requireSession()` 取代占位并把深链接改为 302；B4 落地 `/api/me/*`，B5 落地 `/api/events`、`/api/feedback` 与 `/api/internal/*`。**不变事实**：①静态 JS/CSS 包本身无法用登录保护（设计要求 §2 已声明）；②`/api/me/saved-state/*` 自 R2（B7）起**存在且受门禁**，不再是"不挂假端点"的 404 状态（历史句子保留，勿据此判断当前行为）。
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

**未做的事（刻意，当时）**：没有收藏/最近使用（B4）、没有事件/反馈/运维查询（B5）、没有参数快照（B7，已在 R2 落地）。当轮**不能**声称需求 §4.3 或 §4.4 已满足。

## B4 本轮做了什么（个人数据，TDD；不含诊断）
先写 `test/favorites.test.ts`(13) 与 `test/recent.test.ts`(9) 再写实现：把三条 `/api/me` 路由从 app 上摘掉时 **22/27 断言失败**（`docs/evidence/b4/tests-red.txt`），装回后全绿。
- **表已存在，无新迁移**：`0001_init.sql` 的 `favorite`（PK `account_id+experiment_id`）与 `recent_use`（同 PK + `ON CONFLICT DO UPDATE`）就是为这一步准备的；校验和未变。
- **收藏**：`PUT` 幂等（重复 PUT 返回原 `created_at`，不重排列表），实验不在索引内 404、id 格式非法 400；`DELETE` 幂等 204（**不是** 404，避免用它探测别人是否收藏）；`GET` 按 `created_at DESC`。
- **最近使用**：`POST {experimentId}` → 204，主键去重（A→B→A 得到 2 行且 A 最新）；`GET?limit=`（1–50，默认 20）；响应只有 `experimentId` + 时间，**没有任何参数键**（用例断言键集恰为两个）。
- **隔离是结构性的**：每条 SQL 都带 `account_id = ctx.accountId`，代码里不存在“按传入 id 取行”的路径；用例覆盖“B 看不到 A 的收藏”“B 删除‘同一个’收藏对 A 无效”。
- **限速**：收藏写 60/分钟/账号、最近使用写 120/分钟/账号，429 带 `Retry-After`，且已被拒绝的写入不会回滚已存在的数据（用例）。
- **前端**：实验页收藏开关（`aria-pressed`，失败时显示“收藏没有更新成功”且不改状态），`/me` 页并列“我的收藏 / 最近使用”，最近一次打开时间按 locale 格式化；最近使用写入失败只显示一条非阻断提示，不影响实验。
- **取代的旧断言**：`private-routes.test.ts` 里“`/api/me/*` 不得存在”改为“五条 me 路由必须已挂载且匿名一律 401”。

**未做的事（刻意，当时）**：没有参数快照（B7 已在 R2 落地）、没有“打开次数”统计（需求不要求）、没有用事件表反推最近使用（设计明令禁止）。

## B5 本轮做了什么（诊断、反馈、运维通道，TDD）
先写 `events.test.ts`(24)、`feedback.test.ts`(11)、`internal.test.ts`(17) 再写实现；实现过程中发现并修正三处**测试自身**的问题（客户端 id 短于 8 字符、跨账号共用 `visit_id`、把同一分钟的时序当有序），没有放宽任何生产约束。契约变更的影响分析先落盘：`docs/architecture/impact-B5-event-contract.md`。
- **契约 v2**：`EVENT_TYPES` = open / first_interaction / control_used / reset / fullscreen / client_error（`feedback_submitted` 由服务端产生）；`CONTROL_GROUPS` 增加 `fullscreen_enter|exit` 并禁止 `control_used` 使用它们；`ERROR_CODES` 5 值；每条事件带 `contentVersion`。
- **`POST /api/events`**：批量 ≤20、体 ≤8 KB（路由级 `bodyLimit`）、envelope 未知字段 400、单条非法**丢弃并计数**（`accepted/dropped`），`experimentId` 必须在索引内且 `contentVersion` 必须一致（不一致丢弃，防伪造版本污染回归分析），时间 `occurred_at_min` 由服务端向下取整、`received_at` 仅内部用，`device_class` 由 UA 粗分（**不存 UA 原文**），`dedupe_key` 由服务端生成（一次性事件每 visit 一条，重置/全屏可重复），重复 `clientEventId` 计入 dropped 而非 500。限速 120/分钟/账号、3000/天/账号；`OEL_EVENTS_ENABLED=false` 时返回 `202 {accepted:0}` 且**不落库**。
- **`POST /api/feedback`**：唯一接受自由文本的接口，只写 `feedback` 表（去控制字符、≤2000 截断、分类枚举），同时写一条只含类别的 `feedback_submitted` 事件；5/小时/账号；正文不会出现在事件表（用例断言）。
- **`/api/internal/*`**：`OEL_OPERATOR_TOKEN`（未配置 → **不挂载**，一律 404）+ `Authorization: Bearer`（sha256 + `timingSafeEqual`）+ 60/分钟；`overview`（按资源的账号数/访问数/首次交互转化/重置比/全屏比/错误率）、`experiments/:id/funnel`（各步计数 + 控件分布）、`accounts/:id/timeline`（≤500 行，需 `reason`≥8 字符 + `X-Operator-Label`，写审计）、`export/events.csv`（无 `received_at`、无 UA）+ `export/feedback.csv`；窗口 ≤180 天、行数上限 50000；CSV 对 `=+-@` 前缀做防注入；`dataGaps` 在事件关闭时给出 `events_disabled`。
- **审计**：单账号时间线与两个导出各写一条 `internal_audit`（operator_label / action / target / reason / row_count），**不记录被查内容**；缺 `reason` 或缺少运维标识时 400 且**不**写审计（用例）。
- **前端**：adapter 派生 `first_interaction`（每访问一次）并按控件类别去重，批量发送（10 条或 400ms）、失败重试一次即丢弃；`FeedbackDialog` 先预览再发送，失败明说“没有保存”，成功后显示“已收到”；`main.tsx` 在 `pagehide` 时冲洗队列；生产包仍不含调试钩子。

**未做的事（刻意）**：没有日粒度汇总表（因此 90 天清理后不可再聚合，设计 §9.4 已接受）、没有图形化运维后台（设计允许只有导出/查询）、没有 `ingest_error` 型 dataGaps（只实现了 `events_disabled`）、没有留存清理 CLI。

## B6 本轮做了什么（端到端验收）
- **三视口完整流程**（`tests/e2e/full-flow.spec.ts`，390×844 / 1280×720 / 1024×768）：访客被 302 到登录页并记住 `next` → 表单登录直达深链接 → 目录 → 实验（`y = 2x² − 4x`、顶点 (1, −2)）→ 收藏 → `/me` 两列表 → 刷新仍在 → 登出后受保护页再次 302 → 收尾清理收藏；每步断言视口无横向滚动并截图。
- **跨账号隔离**（`isolation.spec.ts`）：两个真实账号两个上下文，B 的 `/me` 为空、`GET /api/me/favorites` 返回空数组、B 删除“同一个”收藏是 204 且 A 的仍在；A 的账号提示只显示掩码。
- **失效与故障**：异地撤销后刷新即 302 回登录页且 `GET /api/me/favorites` 401（`resilience.spec.ts`）；`/api/catalog` 被中止时目录显示错误与“重试”，恢复后重试成功；`/api/events` 返回 503 时实验、收藏、最近使用全部照常且界面无错误。
- **可访问性**：每页按钮/链接有可访问名、每个输入有 label、无重复 id（app.spec）+ 登录表单可纯键盘完成（resilience.spec）。
- **构建/迁移/备份**：`scripts/backup-check.mjs` 对真实 SQLite 做 `VACUUM INTO` 快照、独立打开、`integrity_check`、七张表计数、canary 写入/读回/删除、迁移基线比对，报告写 `docs/evidence/b6/backup.json`（只含计数，不含账号数据）。
- **本机真实 URL**：`http://127.0.0.1:3220`（`node scripts/e2e-server.mjs` 现场构建 + 启动；`/api/healthz` 可查）。公网/生产仍未授权、未部署。

## B8 本轮做了什么（工程化与发布前准备）

**1) 独立审查 B3–B6，先修根因再加回归用例**（完整清单见 `docs/architecture/review-B8.md`）：
- **H-1（高危，已修）**：`/api/internal/*` 的令牌检查原先写在各 handler 内，晚于 Fastify 的 query 校验——未授权者发 `?from=abc` 得到 400、发合法窗口得到 404，等于给运维通道做了存在性探针；且限速只在令牌正确后扣减，错误令牌可无限猜测。改为 **逐路由 `preValidation` 钩子**（早于任何输入校验），错误令牌按对端地址 10 次/分钟后 429，**未携带令牌的普通请求不扣预算、永远 404**（避免正常用户被 429）。回归用例 7 条。
- **H-2（高危，已修）**：`GET /api/experiments/:id` 没有 querystring schema，`?locale=fr` 实测 **500**（`entry.texts['fr']` 为 undefined 后取 `.title` 抛错）、`?locale=__proto__` 实测 **200 但标题/说明缺失**、未知参数被静默忽略。改为显式 schema（`locale` 枚举 + `additionalProperties:false`），与 `/api/catalog` 一致。回归用例 8 条（含“不得泄露文件系统路径/`manifest.json`”）。
- **文档/文案矛盾（已修）**：设计 §7.8 的 `POST /api/internal/retention/purge` 从未实现（删除只走 CLI），§11 需求追溯表指向 11 个**不存在**的测试文件路径；应用内隐私文案称“保存掩码后的标识”，而库里实际保存**完整规范化标识**（`account.normalized_login`），只有回包用掩码；`me-routes.ts` 注释写“四条路径”实际三条。均已改正（`docs/architecture/A-stage-design.md`、`apps/web/src/i18n/locales/{zh-CN,en}.json`、`me-routes.ts`）。
- **反证（证明新用例是承重的）**：拿掉实验详情的 querystring schema → `experiments.test.ts` **6 失败**（`docs/evidence/b8/mutation-locale-schema-off.txt`）；把运维通道的 `preValidation` 改成 `preHandler` → `internal.test.ts` **3 失败**（`mutation-internal-ordering-off.txt`）。两次都从备份恢复，工作区无残留。**未删除、未放宽任何既有断言**。

**2) CI 与发布前检查**：`.github/workflows/ci.yml` 两个 job——`checks`（Node 固定 `22.23.0`、`npm ci` 走 lockfile、web+API typecheck、lint、web 单测、API 单测、`validate-content`（manifest+i18n）、SPA 构建、真实进程 smoke）与 `e2e`（装 Chromium、四视口 Playwright、备份快照检查、恢复演练、留存 dry-run、上传报告）。**CI 内没有任何生产凭据**：所有 `OEL_*` 都由测试脚本自己生成，`OEL_OPERATOR_TOKEN` 是本机一次性测试串。新增 `npm run ci:local` 用同一顺序在本机跑完全部步骤。**（B8 当时的事实，保留为历史）仓库没有远端、未推送，因此从未在 GitHub 上运行过；R1 之后远端已建立，CI 在 GitHub 上真实运行并通过，见「R1」一节。**

**3) 留存清理（CLI，非 HTTP）**：`apps/api/src/domain/retention.ts`（规则与单事务删除）+ `scripts/retention-purge.mjs`（默认 dry-run；`--apply` 必须 `--confirm-database` 重复同一路径；拒绝 `:memory:`；`--now` 可复现）。窗口沿用设计 §9.4：event 90 天、feedback 180 天、internal_audit 365 天、已撤销/已过期 session 30 天；边界用严格 `<`（恰好在边界上的行保留）。6 条测试覆盖：计划与执行一致、dry-run 不改数据、幂等、活动会话不死、**没有任何 HTTP 留存路由**、缺少/不匹配确认即拒绝。

**4) 备份与恢复演练**：新增 `scripts/restore-check.mjs`——把快照**拷贝到临时目录**后独立打开、`integrity_check`、七表计数、迁移基线、canary 写读删，然后**用真实构建产物在该恢复库上启动 API**（端口 3321），要求 `/api/healthz` 为 `ok` 且 `applied>0`，再通过 HTTP 注册一个一次性账号证明恢复库可写。生产异机复制**未做也未验证**（没有服务器访问），在 runbook 与状态里明写为待服务器确认的事项。

**5) 文档**：新增根 `README.md`、`docs/ops/runbook.md`、`docs/ops/rollback.md`、`docs/privacy/data-map.md`、`docs/third-party.md`（只列实际用到的 4 个运行时依赖 + 18 个开发依赖及其真实版本/许可，不展开素材审查）、`docs/architecture/review-B8.md`；修正设计文档两处与实现不符之处；`PROJECT_STATE` 重写自相矛盾段（B1/B2 的历史形态被明确标注为历史）。

**未做（刻意，B8 当时）**：B7 参数快照（R2 已落地）、生产部署/域名/HTTPS、异机备份复制、账号删除与个人数据导出、标识归属验证、找回密码、图形化运维后台。

## R1（远端落地与真实 CI，本轮）

**事实（实测，证据 `docs/evidence/r1/`）**：
- `gh auth status` → 当前账号 **Molar2016**（scopes `gist, read:org, repo, workflow`）。
- `gh repo view Molar2016/openedulab` → **`visibility: PUBLIC`**、`isPrivate: false`、默认分支 `main`、`https://github.com/Molar2016/openedulab`。
- `git ls-remote origin main` → `caf2b759dc1a2e2bf3d6ac9a0347e2c6be627f39`，与本地 `HEAD` **逐字相同**。
- **CI run [40350561703](https://github.com/Molar2016/openedulab/actions/runs/40350561703)**（push，`headSha=caf2b75`）：**conclusion `success`**，两个 job 均 success——`typecheck / lint / unit / api / content / build`（1m9s）、`browser E2E / backup+restore drill / retention dry-run`（1m35s）。这是**在 GitHub 上真实运行的结果**，不是本机等效。
- 该 run 有一条**非阻断 annotation**：`actions/checkout@v4`、`actions/setup-node@v4` 声明的 Node 20 运行时已被 GitHub 强制改跑 Node 24（弃用警告，不影响结论）。是否升级到 v5 记为待办，不在本关改。

**安全告警审查（不把未知说成绿）**：
- `secret_scanning: enabled`、`secret_scanning_push_protection: enabled` → 告警数 **0**。
- **Dependabot alerts / Dependabot security updates：`disabled`**（API 返回 403 "Dependabot alerts are disabled for this repository"）→ **GitHub 侧没有在替我们盯依赖**。开启属仓库设置变更，需所有者批准，本轮未改。
- **Code scanning：未配置**（API 404 "no analysis found"）→ 无此类告警，不等于"扫描通过"。
- 本机实际审计：`npm audit --omit=dev` → **0 漏洞**；`npm audit` → **6（2 critical / 1 high / 3 moderate）**，全部位于前端**开发**工具链（`vitest`/`tinypool`/`vite`/`@vitest/mocker`/`vite-node`/`esbuild`），只能靠 `vite` 5→8、`vitest` 2→5 的大版本升级修掉。已逐条写入 `docs/third-party.md`「Known advisories」并说明可达面（仅开发服务器/Vitest UI，`vite.config.ts` 只绑 `127.0.0.1`，生产产物是静态文件 + Fastify，不含这些）。

**文档断代清理**：README 的「no remote / CI not running / nothing has been pushed anywhere」、`PROJECT_STATE` 的「没有远端仓库，因此从未在 GitHub 上运行过」「无远端、未推送」「GitHub CI 从未运行」等句子已改为当前事实，并在原处标注为**历史**；同时明确写出**公开仓库只有源码，没有可访问的应用地址**（无部署、无域名），以及**尚无许可证文件**（不得据此认为已开源授权）。

**未做**：未开启 Dependabot、未配置 code scanning、未升级 actions 版本（三者都记录为待办，任一都不影响"CI 在 GitHub 上真实通过"这一结论）。

## R2（B7 参数快照，本轮）

**做了什么**：给用户一个**显式**的“保存当前设置 / 恢复我保存的设置 / 删除已保存的设置”，全部落在既有 `saved_state` 表里，**没有新增迁移**（`0001_init.sql` 校验和仍 `289c27d35781…`，`schema_migrations` 仍只有 1 行）。

- **契约**：参数白名单是**数据**，不是代码——`experiments/math-functions/state-schema.json`（`schemaVersion: 1`；`mode` 枚举、`a/b/c` 数值 −10..10 step 0.1，默认值与 `model.ts` 的 `DEFAULT_COEFFICIENTS` 一致）。服务器启动时读入并校验（缺失=该实验不支持保存；存在但非法=拒绝启动），浏览器用同一个文件。两条实现（`apps/api/src/domain/state-validator.ts`、`apps/web/src/experiment/state-schema.ts`）由 `tests/state-schema.test.ts` 用**同一张用例表**逐条比对，防漂移。
- **API**：`GET/PUT/DELETE /api/me/saved-state/:experimentId`。GET 200 / 无快照 404；PUT 200 并回规范化值；DELETE 204 幂等。**保存 30 次/分钟/账号**、写路由走既有 CSRF 守卫、三条路由都登记进 `route-inventory.ts` 受控清单（匿名 401）。新增两个错误码：`state_invalid`(400) 与 `state_schema_incompatible`(409)。
- **校验**：未知键**拒绝**（不静默剥离）、缺键拒绝、类型/范围/步长（含浮点噪声容差 1e-6）全查、`payload` ≤4096 字节且键排序后落库（同一份设置=同一串字节）。`stateSchemaVersion` 用 `preValidation` 严肃数字判断，绕开 Fastify AJV 的 `"1"→1` 强制转换（这条是被测试逼出来的：先写成 handler 内判断，却被 AJV 先转换掉了）。
- **UI**：实验页工具栏在实验声明了 schema 时出现三个按钮；拖动滑块**不写任何东西**；恢复是**用户点击**才发生（兼容的旧快照不会自动套用），实现方式是带 `initialState` 重挂载视图；版本不兼容时只显示“来自旧版本，已使用默认值”并只给删除按钮；保存失败明说“没有保存成功”。
- **不进诊断**：保存/读取/删除都不写 `event`，参数值不进事件表（`saved-state.test.ts` 直接查库断言事件表里没有 `"mode"`/`linear`/参数值；smoke 用事件计数前后相等断言）。
- **顺带加固**：`scripts/backup-check.mjs` 与 `scripts/restore-check.mjs` 的表清单补上 `saved_state`——原先只数 7 张表，B7 开始写第 8 张，不补就是漏检。

**RED（先写测试，记录在 `docs/evidence/b7/`）**：`tests-red-api.txt` = 2 个文件失败（`state-validator.test.ts` 0 个测试可运行；`saved-state.test.ts` 26 个里 23 个失败，路由全 404）；`tests-red-web.txt` = 2 个文件失败（`state-schema.test.ts` 0 个测试；`host-saved-state.test.tsx` 11 个里 8 个失败，`save-state-button` 不存在）。

**实测（非推断）**：
- `npm run check` **退出码 0**（`docs/evidence/b7/check-b7.txt`）：web **10 文件 / 122 测试**（B8 的 90 + 状态 schema 21 + host 保存 11）；API **23 文件 / 330 测试**（B8 的 274 + 校验器 25 + 路由/隔离/限速/事件 28 + 索引 schema 2）；`validate-content` OK；两个构建成功；无新迁移。
- **真实进程 smoke：108/108**（`smoke.txt`，B8 的 90 + 保存快照 18 条；含匿名三方法 401、规范化落库、未知键/越界 400、旧 schema 409、跨账号 404/204、事件计数不变、删后 404）。
- **真实浏览器 E2E：78 通过 / 52 条件跳过 / 0 失败**（`e2e-b7.txt`，4 个 project；新增 `saved-state.spec.ts` 6 通过）。实测路径：拖 20 次→`y = 3x²`→API 仍 404（无显式保存=无落库）→点保存→`GET` 200 且 `values.a≈3`→刷新回默认且出现“恢复”→点恢复→`y = 3x²`、滑块回到 3→删除→404；另一账号看不到（404）、其删除是 204 而本人快照仍在；手机视口无横向滚动。截图 5 张在 `docs/evidence/b7/`（`saved-state-{saved,offered,restored,owner,mobile}.png`）。
- **备份/恢复**：`check:backup` PASS（快照 180224 字节、`integrity_check=ok`、**八张表**含 `saved_state:1`）；`check:restore` PASS（恢复库里 `saved_state:1` 仍在、`healthz=ok`、`writeProbe=201`）；`retention --dry-run` 0 行。

**未做（刻意）**：`saved_state` 没有自己的留存期限（跟随账号，删除按钮是自助入口）；不做多份快照/版本历史；快照损坏（JSON 解不开）时返回 409 让用户覆盖，不做自动修复；未把参数写进任何导出/运维视图（也没有这样的视图）。

## R3（发布前只读侦察）：结论是阻塞，不是部署

**做了只读侦察，没有接触任何远端**（命令与输出：`docs/evidence/r3/recon.txt`）：
- 仓库只有一个远端 `https://github.com/Molar2016/openedulab.git`（源码远端，不是部署目标）。
- 本机**没有** `~/.ssh/config`；`~/.ssh` 里存在 `deliver_vps`、`id_ed25519`、`id_ed25519_classroom_vps` 等密钥文件，但**没有任何证据表明其中任何一个属于本项目**，且"用 VPS 做交付替代"本就被排除。
- `known_hosts` 里有 `[172.16.12.27]:30134`、`8.148.14.233` 与一条哈希条目——这些是本机别的工作流联系过的主机，**未连接、未探测、未推断归属**。
- 仓库内没有任何部署物料（无 Dockerfile/compose/unit/部署脚本；`systemctl` 只出现在 runbook 的通用示例里）。
- 本机候选端口（3220/3321/3000/8080/80/443）无监听；本机无 docker/podman/pm2/nginx/caddy/rsync。
- 刻意不做：不 ssh/scp、不扫端口、不查 DNS、不申请费用、不建账号、不改任何既有服务。

**状态：远端测试部署阻塞：需服务器地址/访问方式/独立域名等**（另需：数据库选型、留存窗口/未成年人政策/删除与导出范围的决策）。在拿到这些之前，本地只形成了可执行的隔离部署方案与前置核对表：`docs/ops/deployment-plan.md`（含五条从代码学到的硬约束：生产必须 HTTPS 否则 `__Host-`+`Secure` 会话无法建立；`trustProxy=false` 会让反代后的按 IP 限速塌缩成一个桶；单实例假设；SQLite 是宿主机上的文件、备份必须离机；没有邮件短信因此不能承诺找回密码）。

**发布前风险与前置条件**：`docs/privacy/launch-readiness.md`。
- **自注册不验证归属**：可被抢注他人邮箱/手机（对方随后无法注册，409 `identifier_taken`），可被脚本批量注册（每 IP 5 次/小时，但每个新账号都重新获得 120 条/分钟、3000 条/天的诊断额度 → 单 IP 理论日增约 12 万账号×事件上限的量级）。**不存在**通过邮箱/手机接管既有账号的路径（没有找回密码、登录不区分"账号不存在"与"口令错误"），也**不存在**读取他人数据的路径（每条 SQL 由会话账号限定，已有跨账号用例）。当前可用的缓解只有限速、运维定位、数据库层禁用账号（无 HTTP 入口）与留存清理；是否加验证码/邮箱验证/邀请码属所有者决策（涉及第三方与费用）。
- **账号删除与个人数据导出：未实现**，是公开发布的硬阻塞（`ON DELETE CASCADE` 已覆盖 6 张表，`internal_audit` 刻意无外键）。已在该文档给出实现范围与测试口径，未动代码。
- **未成年人**：产品面向课堂，含 14 岁以下学生即触达 PIPL 敏感个人信息（需监护人同意与专门规则）；当前无年龄门槛、无同意机制，文案也未作任何承诺。三种模型（机构控制/18+/监护人同意）待所有者选一种。

**本轮未做**：无服务器动作、无 DNS/防火墙/证书、无部署、无费用、无注册流程改动、无许可证/条款/隐私政策选择。

## R4（交付前最终验证）

**本地全套（同一棵工作树，证据 `docs/evidence/r4/final-verification.txt`）**：
- `npm run check` **退出码 0**：web **10 文件 / 122 测试**；API **23 文件 / 330 测试**；lint 与 typecheck 无输出；`validate-content` OK；SPA 与 API 构建成功。
- `npm run smoke:api` → **108/108 checks passed**（真实进程、真实 socket）。
- `npx playwright test`（4 个 project）→ **78 passed / 52 skipped / 0 failed**（52 条跳过全部是显式 `test.skip(project…)`）。
- `npm run check:backup` PASS（八张表：account 4 / session 15 / favorite 0 / recent_use 2 / **saved_state 1** / event 68 / feedback 5 / internal_audit 3；`integrity_check=ok`）。
- `npm run check:restore` PASS（恢复库上 `healthz=ok`、`migrations.applied=1`、`writeProbe=201`，`saved_state` 仍在）。
- `retention --dry-run` → 0 行。

**GitHub Actions（本仓库真实运行，均为 push 到 `main`）**：

| run | commit | 结论 | 说明 |
|---|---|---|---|
| [40350561703](https://github.com/Molar2016/openedulab/actions/runs/40350561703) | `caf2b75`（B8 收口） | success | 两个 job 全绿 |
| [40351474575](https://github.com/Molar2016/openedulab/actions/runs/40351474575) | `84dfaee`（R1 文档） | success | 两个 job 全绿 |
| [40355418679](https://github.com/Molar2016/openedulab/actions/runs/40355418679) | `7f3730d`（R2/B7） | success | e2e job 的 Chromium 安装耗时 ~17 分钟（见下） |
| [40358303228](https://github.com/Molar2016/openedulab/actions/runs/40358303228) | `fdfa466`（R3/R4 文档 + CI 缓存） | success | 加入浏览器缓存后 e2e job 回到 1m49s |

本文件所在的提交是**纯文档改动**（`docs/` 与 CI 注释），其 CI 运行号记录在夜间交付文件里；上表覆盖所有携带代码/工作流改动的提交。

**CI 加固（由上面第 3 个 run 暴露）**：`e2e` job 里 `npx playwright install --with-deps chromium` 在缓存未命中时跑成了 ~17 分钟（前两次同样的步骤只要 ~40 秒），把 30 分钟 job 预算吃掉一半多。已加 `actions/cache@v4` 缓存 `~/.cache/ms-playwright`（key 跟 `package-lock.json` 哈希），Playwright 升级时仍会重下一次。这是对 CI 可靠性的修复，不是放宽任何检查。

**仍然成立**：**没有公网应用 URL、没有部署、没有域名**；公开仓库只有源码；R3 的部署前置条件与风险清单见 `docs/ops/deployment-plan.md` 与 `docs/privacy/launch-readiness.md`。

## R5（依赖安全与决策同步）

### R5-1 产品决策同步（文档/决定层面，未改代码）

2026-10-27 项目负责人的决定，已落到需求、状态、发布检查、隐私数据地图、部署方案与第三方清单：

1. **首版不做账号删除、不做个人数据导出**——是"不在范围"，不是"没实现"。因此：应用内隐私文案、README、`docs/privacy/data-map.md` 一律**不得**出现"可自助删除/导出"的说法（现有文案本来就没有，本轮把"未来会有"的措辞改成"按决定不会有"）；当前唯一真实的终止使用手段是维护者在数据库层停用账号（无 HTTP 入口）。负责人已知晓并接受"个人对自己的数据没有自助处置入口"这一残余风险，记录在 `docs/privacy/launch-readiness.md` §2。
2. **不设"未成年人禁止使用"的年龄门槛**（教学用途，课堂里本就有未成年人）。同时明确**不得据此断言"无需处理儿童个人数据"**：代码不采集年龄/真实姓名/学校/班级/名册（这部分是事实，见 `docs/privacy/data-map.md`），但"谁注册、服务在哪个地区提供"才是决定因素。保留一项**最小必要的事实核查**（真实服务地区 + 实际触达的个人数据清单），**不臆造法定年龄、不加硬编码年龄闸门**；文案既不说"适合儿童"也不说"仅成人"。
3. **其他发布前工作继续**：依赖安全（下一节）、测试路径、开源许可决策。
4. **开源许可仍未选**：候选 MIT 或 Apache-2.0，由负责人决定；仓库**没有** `LICENSE`，不得自行新增或代选。`docs/third-party.md` 新增候选对照表与应用内 `about.licensePending` 一致（"许可尚未最终确定"）。
5. **GitHub Pages 修正为"只适合静态介绍页，不适合本应用"**：现有站点是强制登录的 Fastify + SQLite 同源动态应用（登录态是服务端 Cookie、目录/实验/收藏/参数全走 `/api/*` 的 `requireSession()`），Pages 只能托管静态文件，**无法**承载；**本轮不启用 Pages**——公开一个登不进去的空壳会误导访问者，做成"看起来完整"就必须有假后端/假数据，这是被明令禁止的。若将来要静态介绍页，必须写明"无在线演示、无公开实例、需服务端才能登录"（`docs/ops/deployment-plan.md` §2.1）。
6. **上线仍需单独授权**：同意"继续推进发布前工作"**不等于**同意把网站放到公网上；本轮未开隧道、未改生产、未动 DNS/防火墙、未产生费用（`docs/privacy/launch-readiness.md` §5 保留了上线闸门表）。

### R5-2 依赖安全：把 6 条开发工具链公告真实修掉

**基线（先重现，后动手）**：在未改动的锁文件上跑 `npm audit` → **6（2 critical / 1 high / 3 moderate）**，`npm audit --omit=dev` → **0**；`npm run check` → 退出码 0（web 10 文件/122 测试、API 23 文件/330 测试）。原文：`docs/evidence/r5/audit-before.txt`、`check-before.txt`。

**升级组合（最小且真正安全，不用 `--force`）**：
- `vite` 5.4.21 → **7.3.7**（清掉 vite 自身的 dev-server 穿越 / `server.fs.deny` 绕过，以及经 esbuild 的代理读取）
- `vitest` 2.1.9 → **5.0.5**（清掉 vitest/mocker 文件读取与手动 mock 注入、tinypool 原型污染→RCE）
- `@vitejs/plugin-react` 4.7.0 → **5.2.0**（peer 覆盖 vite 4–8）

**为什么不按 `npm audit fix --force` 上 vite 8**：vite 8 把 esbuild/Rollup 换成 **Rolldown/Oxc**（打包器重写、产物会变），安全性上相对 7 没有额外收益——上面每条公告在 `vite >= 7` 即已清除（esbuild `^0.27||^0.28`，`vitest@5` 只要求 `vite >= 6.4`）。所以 7 是"最小的安全版本组合"；升 8 记为后续独立事项，不夹在安全修复里。

**升级逼出来的两处配置改动（都在 `vite.config.ts`，各有理由）**：
1. `/// <reference types="vitest" />` + 从 `vite` 取 `defineConfig` 在 vitest 5 下不再给 `test` 字段类型（TS2769）。改为从 `vitest/config` 取 `defineConfig`（它转出 vite 的同名函数并类型化 `test`），构建与测试共用同一份配置。
2. **浏览器目标显式钉住**：vite 7 默认 `build.target` 变成 `baseline-widely-available`（Chrome 111 / Safari 16.4），而 vite 5 默认是 `modules` 那组（Chrome 87 / Edge 88 / Firefox 78 / Safari 14）。若放任默认值，一次**安全**升级会顺手把课堂/投影老旧机器的支持面砍掉。故钉为 vite 5 的那组，支持面不变；要抬门槛是另一个产品决定，需单独验证。

**实测（同一棵工作树，证据 `docs/evidence/r5/`）**：
- `npm audit` → **0 vulnerabilities**；`npm audit --omit=dev` → **0**（`audit-after.txt`）。
- `npm run check` → 退出码 0：web **10 文件 / 122 测试**、API **23 文件 / 330 测试**、lint/typecheck 无输出、`validate-content` OK、两个构建成功（`check-after.txt`、`build.txt`）。**测试一条未删、断言一条未放宽**，通过数与升级前逐项相同。
- `npm run smoke:api` → **108/108 checks passed**（真实进程、真 socket，`smoke.txt`）。
- `npx playwright test` → **78 passed / 52 skipped / 0 failed**（4 个 project，1.3 分钟，`e2e.txt`）；52 条跳过仍是既有的显式 `test.skip(project…)`。
- `npm run check:backup` PASS（八张表、`integrity_check=ok`、快照 180224 字节）；`npm run check:restore` PASS（恢复库 `healthz=ok`、`applied=1`、写探针 201）；`retention --dry-run` 0 行（`backup.txt`/`restore.txt`/`retention-dry-run.txt`）。
- `npm ci --dry-run` 退出码 0（锁文件与 `package.json` 一致，`npm-ci-dry-run.txt`）；实际解析版本见 `npm-ls-after.txt`。

**没有做的事**：没有 `npm audit fix --force`；没有用 `overrides` 强行钉住传递依赖来"消音"；没有删测试/跳过测试/放宽断言换绿；没有升 vite 8（Rolldown 重写）、没有升 React 18→19、没有动运行时依赖（`fastify`/`@fastify/static`/`react`/`react-dom` 版本不变，`npm audit --omit=dev` 本来就是 0）。

## 本轮确定的架构决策（详见设计文档 §1 / §8）


同源模块化单体（Fastify + 静态 SPA，无 CORS）；服务端会话（DB 存 token 哈希，HttpOnly Cookie，非 JWT）；scrypt 口令哈希；私有 API 一律从会话派生 `account_id`（不接受请求体/路径传账号）；个人数据与诊断事件物理分表、分路由、分一致性等级；运维权限用环境变量 Bearer token，未配置时 404；本地开发 SQLite（`node:sqlite`），生产候选 PostgreSQL 但**不承诺可切换**；迁移用编号 SQL + 校验和 + 单事务且只允许两库共同子集；备份 `VACUUM INTO`/`pg_dump -Fc` + 异机复制 + 每月恢复演练。

## 本轮遗留（不变的事实）
前一次后台开发任务在用户叫停前已写入 React/Vite 代码、依赖、测试与截图/录屏等**免登录原型文件**；本轮已把它们纳入 git 以固定基线，但它们**未按需求 v2.1 验收**，不可称为已交付的 M1，也不可据此部署。`docs/CHARTER-v1.md` 是用户原件副本。`docs/architecture/ADR-000-foundation.md` 与 `docs/acceptance.md` 的旧方案标记已撤回；ADR-001 同属旧前提，须重审。

## 版本控制（本地仓库 + GitHub 远端）
- 分支 `main`；**B0 首次提交**：`1bc20b2881e4e7833216277780971efe0a0b4fd9`（`1bc20b2`），61 个受跟踪文件，`node_modules/`(140M)、`dist/`、`test-results/`(1.3M)、`playwright-report/`(1.8M) 均由 `.gitignore` 排除。
- **B1 提交**：`80c2f90532b02ac63c88c1799a68b539b5b18147`（`80c2f90`），34 个文件变更（+3556/−26），受跟踪文件总数 89；`apps/api/dist/`（tsc 产物）、`apps/api/data/`（本地 SQLite）、`*.sqlite*` 均被忽略，提交后用 `git check-ignore -v` 核对过。工作区只剩一个未跟踪文件 `docs/roadmap.md`（非本轮产出，**未**纳入提交）。
- **B1 修复提交**：`9e8d1cde2e46f00aaf597f0c3542c99447541b90`（`9e8d1cd`），把 `@fastify/static` 从有 4 条高危穿越公告的 `8.3.0` 升到修复版 `10.1.7`，适配 v10 的 `setHeaders(reply, path)` 签名，并把穿越用例从 3 个扩到 8 个编码载荷；该提交后 `npm audit --omit=dev` 为 0 漏洞。
- **B2 提交**：`21b052541f799105da89a2999ed5abc9dc50a666`（`21b0525`），32 个文件变更（+4779/−27）：新增 `src/security/*`(5)、`src/db/{account,session}-repository.ts`、`src/domain/auth-service.ts`、`src/http/{auth-routes,csrf}.ts`、6 个认证测试文件 + `test/support/auth-app.ts`、`docs/evidence/b2/`(7)；改动 `src/app.ts`、`src/http/errors.ts`、`test/private-routes.test.ts`（仅替换那条"session 必须 404"的占位断言）、`vitest.config.ts`（超时）、`scripts/smoke.mjs`、`apps/api/README.md`、`.env.example`、`package.json`。**无新迁移**：`0001_init.sql` 未改动，校验和仍为 `289c27d35781…`；提交用逐路径 `git add`（未用 `-A`），`apps/api/dist`、`apps/api/data`、`*.sqlite*` 仍被忽略，未推送。
- **B3 提交**：`0c8fd507e01df2ad2befc130b8e59d8650ce6fba`（`0c8fd50`），67 个文件变更（+5112/−432）：新增 `src/domain/content-index.ts`、`src/http/{auth-context,content-routes,route-inventory,spa-gate}.ts`、`src/app.ts` 重写、`apps/api/test/{authorization,catalog,experiments,spa-gate}.test.ts`、`test/support/content.ts`、`apps/web/src/services/api.ts`、`apps/web/src/app/LoginPage.tsx`、`scripts/e2e-server.mjs`、`tests/e2e/{app,gate,auth.setup,support}.ts`、`tests/{api-client,router}.test.ts`、`docs/evidence/b3/`(21)；删除 `src/http/private-routes.ts`；`tests/e2e/m1.spec.ts` 被 `app.spec.ts` 取代（git 记为 rename）；改动 `config.ts`（新增必填 `OEL_CONTENT_DIR`）、`auth-routes.ts`（接受共享 `AuthService`）、`static.ts`（导出 `looksLikeAsset`）、`App/CatalogPage/router/ExperimentHost/contract/registry/locales/styles.css`、`experiments/math-functions/manifest.json`（新增 `contentVersion: 1.0.0`）、`playwright.config.ts`、`scripts/validate-content.mjs`、`apps/api/README.md`、`.env.example`、`package.json`。**无新迁移**：`0001_init.sql` 未改动（校验和仍 `289c27d35781…`）；逐路径 `git add`，未用 `-A`。
- **B4 提交**：`4dbc87d`，19 个文件变更：新增 `src/db/{favorite,recent}-repository.ts`、`src/http/me-routes.ts`、`apps/api/test/{favorites,recent}.test.ts`、`apps/web/src/app/MePage.tsx`、`docs/evidence/b4/`；改动 `app.ts`、`route-inventory.ts`（+5 条受控路由）、`private-routes.test.ts`、`App/router/api.ts/ExperimentHost/i18n/styles`、`smoke.mjs`、`tests/{api-client,e2e/app}`。**无新迁移**。
- **B5 提交**：`51e0499`，40 个文件变更：新增 `src/domain/events.ts`、`src/db/{event,feedback}-repository.ts`、`src/http/{event,internal}-routes.ts`、`apps/api/test/{events,feedback,internal}.test.ts`、`docs/architecture/impact-B5-event-contract.md`、`docs/evidence/b5/`；改动 `contract.ts`（v2）、`services/{analytics,api,index}.ts`、`FeedbackDialog`、`ExperimentHost`、`experiments/math-functions/{view.tsx,locales}`、`main.tsx`、`config.ts`（`OEL_OPERATOR_TOKEN`/`OEL_EVENTS_ENABLED`）、`smoke.mjs`、`tests/{analytics,host,registry,e2e/app,e2e/internal}`。**无新迁移**。
- **B6 提交**：`e60fd8a`，43 个文件变更：新增 `tests/e2e/{full-flow,isolation,resilience}.spec.ts`、`scripts/backup-check.mjs`、`docs/evidence/b6/`（39 个文件，含 3 个视口各 5 张截图、`walkthrough.webm`、`backup.json`）；改动 `playwright.config.ts`（4 个 project）、`tests/e2e/{app,gate,internal}.spec.ts`（截图统一写 `b6`，b3–b5 证据保持冻结）、`package.json`（`check:backup`）、`docs/evidence/b5/{e2e-b5,smoke}.txt`（补正）、`docs/PROJECT_STATE.md`。
- **B8 提交**：`19765beea62e8310e38e58e26af6fc7fb3b50075`（`19765be`），44 个文件变更（+3592/−63）：新增 `.github/workflows/ci.yml`、`README.md`、`apps/api/src/domain/retention.ts`、`apps/api/test/retention.test.ts`、`scripts/retention-purge.mjs`、`scripts/restore-check.mjs`、`docs/architecture/review-B8.md`、`docs/ops/{runbook,rollback}.md`、`docs/privacy/data-map.md`、`docs/third-party.md`、`docs/evidence/b8/`（13）、`docs/evidence/backup/`（2）；改动 `content-routes.ts`（实验详情 querystring schema）、`internal-routes.ts`（preValidation 门禁 + 猜测预算）、`me-routes.ts`（注释）、`experiments.test.ts`(+8)、`internal.test.ts`(+7)、两个 i18n 字典（隐私文案）、`package.json`（check 顺序、`ci:local`、retention/restore 脚本入口）、`backup-check.mjs`（默认报告目录）、`docs/architecture/A-stage-design.md`（§7.8/§11）、`docs/PROJECT_STATE.md`、以及 B8 的 E2E 重新生成的 `docs/evidence/b6/` 截图与录屏（7 个文件；规格里写死的输出路径，内容为当前构建）。**无新迁移**：`0001_init.sql` 校验和仍 `289c27d35781…`；逐路径 `git add`，未用 `-A`，未推送。
- 仓库里另有两条不是本任务产生的提交：`293a7ba`、`c0b3936`（均为 `scripts/status_watch.py` 的运维看板改动，作者 `molar`），不属于 B0–B8 任一关的产物，本轮未修改、未改写历史。
- **R1 之后**：远端 `origin` = `https://github.com/Molar2016/openedulab`（PUBLIC），`main` 与远端同步；**未部署、未发布、没有任何公网应用 URL**；无 `AGENTS.md`（未获用户同意，本轮亦未新增）。

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
### B4 实测（本轮，非推断；原文在 `docs/evidence/b4/`）
- **RED**：把三条 `/api/me` 路由从 `app.ts` 摘掉后跑 `test/{favorites,recent,private-routes}.test.ts` → **3 文件失败，22/27 断言失败**（`tests-red.txt`）。
- **`npm run check`：退出码 0**（`check-b4.txt`）：web 8 文件 / **78 测试**；API **17 文件 / 207 测试**（B3 的 185 + B4 的 22：favorites 13、recent 9，路由清单同步扩充）；`validate-content` OK；两个构建成功。
- **反证**：把 `GET /api/me/favorites` 上的 `requireSession` 换成空钩子 → favorites+recent+路由清单 **9 条失败**（`mutation-me-gate-off.txt`），随后从备份恢复。
- **真实进程 smoke：78/78 通过**（`smoke.txt`）。新增实测：`PUT` 收藏 201、重复 `PUT` 200 且 `createdAt` 不变、未收录实验 404；`GET` 收藏只含 `createdAt,experimentId`；`POST /api/me/recent` 连续两次都 204 且列表仍 1 行；另一账号列表为空、其 `DELETE` 对第一个账号无影响；`DELETE` 两次都 204 且列表清空。
- **真实浏览器 E2E：35 通过 / 2 条件跳过 / 0 失败**（`e2e-b4.txt`，当时的 3 个 project）。实测路径：实验页加入收藏 → `aria-pressed=true` → `/me` 出现该收藏 → 取消收藏 → 回实验页按钮变回“加入收藏”；两次打开同一实验后 `/me` 的 `recent-list` 仍只有 1 条，且文本不含任何参数名/值。

### B5 实测（本轮，非推断；原文在 `docs/evidence/b5/`）
- **`npm run check`：退出码 0**（`check-b5.txt`）：web 8 文件 / **90 测试**（analytics 16、host 10、api-client 11、router 21 等）；API **20 文件 / 253 测试**（B5 新增 events 24、feedback 11、internal 17，并扩充 config/private-routes）；`validate-content` OK；构建成功。
- **反证**：删掉 `normalizeEvents` 里的 `contentVersion` 一致性检查 → `events.test.ts` 的“版本不一致必须丢弃”用例失败（1 失败 / 17 通过，`mutation-version-check-off.txt`），随后恢复。
- **真实进程 smoke：90/90 通过**（`smoke.txt`）。真 socket 上实测：合法批次 202 且 `accepted=4`；含“未收录实验 + 已移除事件类型”的批次 202 且 `accepted=0, dropped=2`；重放同批次 202 且 `accepted=0`（去重）；反馈 201；`/api/internal/overview`（Bearer + label）200 且 `openAccounts=1, opens=1, interactedVisits=1`、`dataGaps=[]`；无 `reason` 的导出 400；`events.csv` 首行为约定的 11 列、无 `received_at`、无 `Mozilla`；`feedback.csv` 含正文与账号 id；两次导出留下 **2 行 `internal_audit`**；无 token 与“普通会话”访问运维通道均 404。
- **真实浏览器 E2E：42 通过 / 5 条件跳过 / 0 失败**（`e2e-b5.txt`，当时 3 个 project）。实测：浏览器真的操作实验（`y = 2x²` + 重置）后，运维通道能查到 `openAccounts≥1`、`interactedVisits≥1`、控件类别含 `a`，且 funnel 响应不含 `coef`/`slider`/数值；`events.csv` 含表头且不含 `HeadlessChrome`/`Mozilla`；普通会话与匿名访客访问 `/api/internal/*` 均 404；浏览器内提交的反馈出现在 `feedback.csv` 且账号列是内部 id；`/api/events` 被注入 503 后实验、收藏、最近使用照常且界面无错误。

### B6 实测（本轮，非推断；原文在 `docs/evidence/b6/`）
- **`npm run check`：退出码 0**（`check-b6.txt`）：web **90/90**；API **253/253**；lint 与 typecheck 无输出；`validate-content` OK；`vite build` 与 `build:api` 成功；**无新迁移**（校验和仍 `289c27d35781…`）。
- **真实进程 smoke：90/90 通过**（`smoke.txt`，与 B5 同一套断言，包含重启后会话仍有效、撤销仍失效、篡改迁移拒绝启动）。
- **真实浏览器 E2E：74 通过 / 40 条件跳过 / 0 失败**（`e2e-b6.txt`，**4 个 project**：desktop 1440×950、mobile 390×844、projector 1280×720、tablet 1024×768）。跳过项全部是显式 `test.skip(project…)`（例如“手机布局只在手机 project 跑”“一次提交只跑一次”“注册预算只给 desktop+mobile”），不是失败的掩盖。
- **三视口完整流程**：`mobile-chromium-390x844-*`、`projector-chromium-1280x720-*`、`tablet-chromium-1024x768-*` 各 5 张截图（gate / catalog / experiment / my-library / signed-out），每步都断言无横向滚动。
- **跨账号隔离**（`isolation-*.png`）：第二账号 `/me` 为空、`GET /api/me/favorites` 为 `[]`、其 `DELETE` 为 204 而第一账号仍有收藏。
- **失效与故障**：异地撤销后刷新即回登录页且 `GET /api/me/favorites` 401；目录请求被中止时显示错误与重试、恢复后成功；`/api/events` 503 时核心功能不受影响；登录表单可纯键盘完成。
- **备份恢复**：`npm run check:backup` → **PASS**（`backup.json`）：快照 176128 字节、`integrity_check=ok`、七张表计数（account 4 / session 15 / favorite 0 / recent_use 1 / event 60 / feedback 5 / internal_audit 3）、canary 写入读回删除成功、迁移基线 `["0001"]`。
- **本机 URL**：`http://127.0.0.1:3220`（由 `node scripts/e2e-server.mjs` 现场构建并启动，`/api/healthz` 可核）。该进程只在测试期间存在；**没有常驻服务、没有公网 URL、没有部署**。

### B8 实测（本轮，非推断；原文在 `docs/evidence/b8/`）

- **`npm run check`：退出码 0**（`check-b8.txt`）：web **8 文件 / 90 测试**；API **21 文件 / 274 测试**（B6 的 253 + 实验详情查询 8 + 运维通道路由顺序 7 + 留存清理 6）；web/API typecheck 与 lint 无输出；`validate-content` OK（math.functions、zh-CN/en 各 125 键、host SDK 1.0.0）；`vite build` 与 `build:api` 成功。**无新迁移**：`0001_init.sql` 校验和仍为 `289c27d35781…`，`schema_migrations` 仍只有 1 行。
- **真实进程 smoke：90/90 通过**（`smoke.txt`，含重启后会话仍有效、撤销仍失效、篡改迁移拒绝启动、运维通道 404/CSV/审计）。
- **真实浏览器 E2E：74 通过 / 40 条件跳过 / 0 失败**（`e2e-b8.txt`，4 个 project，1.2 分钟）。**过程记录（不是一次过）**：第一次跑出 **4 个失败**——`gate.spec.ts` / `internal.spec.ts` 里“普通账号访问 `/api/internal/*` 必须是 404”实际得到 **429**，因为 H-1 的修复把“未携带令牌”的请求也计入了猜测预算；这正是 E2E 该抓的东西。改法不是放宽测试，而是收紧语义：只有**错误的令牌**才扣猜测量，未携带令牌的请求永远 404（并补了“普通账号连续 15 次仍是 404”的用例）。复跑 **74/74 + 40 skip、0 失败**。
- **备份快照检查：PASS**（`backup-check.txt` / `backup.json`）：快照 176128 字节、`integrity_check=ok`、七表计数（account 4 / session 15 / favorite 0 / recent_use 1 / event 61 / feedback 5 / internal_audit 3）、canary 写读删成功、迁移基线 `["0001"]`。
- **恢复演练：PASS**（`restore-check.txt` / `restore.json`）：把快照拷到临时目录后独立打开校验，然后**用真实构建产物在该恢复库上启动 API**（127.0.0.1:3321），`/api/healthz` 返回 `ok` 且 `migrations.applied=1`，随后通过 HTTP 注册一次性账号得到 **201**（证明恢复库可写），进程用 SIGTERM 停掉。
- **留存清理**：对 E2E 库 `--dry-run` 为 0 行（数据都是几分钟内的，符合预期，`retention.json`）；在**副本**上播种两条超窗数据后跑真实 CLI：dry-run 报 2 行 → `--apply` 删 2 行 → 再 `--apply` **删 0 行**（幂等），见 `retention-apply-drill.txt`。HTTP 侧没有任何留存端点（用例断言）。
- **反证**：拿掉实验详情的 querystring schema → 6 条失败（`mutation-locale-schema-off.txt`）；`preValidation`→`preHandler` → 3 条失败（`mutation-internal-ordering-off.txt`）；均从备份恢复。
- **本机 URL**：E2E 期间为 `http://127.0.0.1:3220`（由 `scripts/e2e-server.mjs` 现场构建并启停，每次重建临时库）；恢复演练临时占用 `127.0.0.1:3321`。**没有公网 URL、没有部署**（B8 当时也未推送；推送发生在 R1，见上）。

## 下一步（严格按序）
1. ~~**B0**：修 typecheck 根因（唯一共享 `debug-hook` 类型，两侧引用，不删测试）→ `npm run check` 退出码 0；`git init` + 首次提交。~~ **已完成（本轮）**。
2. ~~**B1**：`apps/api` 骨架 + 启动配置校验（缺项即退出、不静默降级）+ `migrations/0001_init.sql` + 迁移运行器（编号 + 校验和 + 单事务）+ `GET /api/healthz` + 由 API 同源托管构建后的 SPA。~~ **已完成（本轮）**：`npm run check` 退出码 0；API 测试 68/68；真实进程 smoke 25/25；深链接返回 index.html；私有路由占位一律 401。注意：**401 是占位拒绝，不是访问控制**。
3. ~~**B2（认证闭环）**：注册/登录/登出/会话与限速（scrypt、`timingSafeEqual`、HttpOnly Cookie、CSRF Origin+JSON、429 + `Retry-After`）。~~ **已完成（本轮）**：R-01..R-04、R-06 在 API 集成层全绿（`apps/api/test/auth.register|auth.login|session|auth.security|csrf|rate-limit.test.ts`）；哈希格式、`timingSafeEqual`、Cookie 属性、生产 `__Host-`+`Secure`、禁用账号、过期/空闲/撤销、伪造 Cookie、重复标识、重复尝试锁定都有断言；真实进程 smoke 51/51。**B2 不含授权**：占位 401 仍在，持有效会话访问 `/api/catalog` 依旧 401。
4. ~~**B3（授权门禁）**：`requireSession()` + 目录/实验 API + SPA 深链接 302 + 登录/注册页 + 路由清单。~~ **已完成（本轮）**：占位 401 与“公开深链接”两条旧断言被取代；真实浏览器注册→目录→实验通过；E2E 31 通过/2 条件跳过；mutation 反证两次。
5. ~~**B4（个人数据）**：收藏/取消收藏 + 按资源去重的最近使用，跨会话回读，事件端点关闭时独立可用。~~ **已完成（本轮）**：API 207 测试、smoke 78/78、E2E 35 通过；跨账号隔离与幂等有断言。
6. ~~**B5（诊断与运维）**：白名单事件、反馈、`/api/internal/*` + 审计 + `dataGaps`，关闭诊断仍可实验。~~ **已完成（本轮）**：API 253 测试、smoke 90/90、E2E 42 通过；契约变更的影响分析先于代码落盘。
7. ~~**B6（端到端验收）**：三视口完整流程、跨账号隔离、过期与登出、故障注入、无障碍、构建/迁移/备份恢复检查。~~ **已完成（本轮）**：4 个 project 的 E2E 74 通过/0 失败、备份恢复 PASS、截图/录屏/日志齐全。
8. ~~**B7（参数快照）**：`saved_state`（一资源一份、`content_version`/`state_schema_version` 不匹配时回退默认并提示）。~~ **已完成（R2）**：三条路由受门禁/CSRF/限速约束，schema 由实验目录 `state-schema.json` 声明并在启动时校验，保存是唯一写入路径，需求 §4.5 因此满足。
9. ~~**B8（收口）**：CI（typecheck/lint/unit/api/e2e/build/迁移/备份演练）、`scripts/retention-purge.mjs`、运维手册、状态锚更新。~~ **已完成（本轮）**：CI 文件已写、本机等效全流程通过（`npm run ci:local`）；留存清理 CLI 有 6 条测试与一次真实 apply 演练；恢复演练 PASS；README/runbook/rollback/隐私数据地图/第三方清单齐备。（B8 当时仍不可称 CI 绿色，因无远端仓库；R1 已完成远端落地并实测 CI 通过。）、B8 当时不可部署。
10. **下一关（需用户选择，二者都需要新的授权）**：
    - ~~**B7（参数快照）**~~ **已完成（R2）**：`GET/PUT/DELETE /api/me/saved-state/:experimentId` + 路由清单登记 + 实验目录 `state-schema.json` + R-17/R-18 用例（含"拖动不落库"与"不兼容回默认"）。
    - **D/E**：服务器只读侦察与部署审批。前置条件（不满足则不开始）：服务器参数/域名/HTTPS（Q1/Q2）、留存与服务地域（Q3；未成年人政策已决定不设年龄门槛）、远端仓库与 CI 真实运行、异机备份复制方案，以及负责人**单独**的上线授权。**Q4（账号删除/数据导出）已移出首版范围（2026-10-27）**。

## 停止点与恢复命令（本次任务到此为止）

**停止点（2026-10-27，R1+R2 之后）**：B0→B8 + R1（远端落地与真实 CI）全部完成并有真实运行证据；B7 参数快照已在 R2 实现并验收。**源码已推送到公开仓库**，但**没有公网 URL、没有部署**；生产/DNS/防火墙/收费/扩大采集等动作一律未做（R3 只做本机只读侦察与风险清单）。

**本机服务**：B8 开始前 3220 上有一个交接用的 `node apps/api/dist/index.js`（PID 2864），已按 PID 精确停止（未用宽泛的 node.exe 终止）；B8 的 E2E 自己起停 3220，恢复演练临时用 3321，**收尾时不留常驻进程**。要手工验看，用下面第 5 步。

**恢复时按顺序执行（都能直接复制）**：

```bash
cd G:/hermes/projects/openedulab

# 0. 依赖与锁文件一致性（等价于 CI 的 npm ci，不写 node_modules）
npm ci --dry-run

# 1. 环境自检：类型/规范/单元/API/内容/构建（约 2.5 分钟，退出码 0 才算通过）
npm run check

# 2. 真实进程 smoke（90 条断言，含重启、撤销、篡改迁移、运维通道）
npm run build && npm run build:api && npm run smoke:api

# 3. 本机真实浏览器端到端（4 个视口；会现场构建并占用 127.0.0.1:3220）
npx playwright test

# 4. 备份快照 + 恢复演练 + 留存 dry-run（默认打 test-results/e2e/app.sqlite）
npm run check:backup
npm run check:restore
npm run retention:dry-run -- --db test-results/e2e/app.sqlite

# 4b. 以上 0–4 的等价一条龙（CI 的步骤顺序，本机跑）
npm run ci:local

# 5. 只想手工看页面：构建并启动同源服务（真实 Fastify + 构建后的 SPA）
npm run build && npm run build:api
OEL_ENV=development OEL_HOST=127.0.0.1 OEL_PORT=3220 OEL_PUBLIC_ORIGIN=http://127.0.0.1:3220 OEL_DATABASE_PATH=apps/api/data/local.sqlite OEL_STATIC_DIR=dist OEL_MIGRATIONS_DIR=apps/api/migrations OEL_CONTENT_DIR=experiments OEL_LOG_LEVEL=info node apps/api/dist/index.js
# 打开 http://127.0.0.1:3220/ → 会被 302 到 /login；注册一个账号即可完整走一遍
```

注意：
- 第 3 步用 `reuseExistingServer: false`；若第 5 步的服务还在跑，先用 `netstat -ano | grep ':3220 '` 找到 PID、`wmic process where "ProcessId=<PID>" get CommandLine` 核对是 `apps/api/dist/index.js`，再 `taskkill /PID <PID> /F`。**不要**按名字杀 node。
- 第 5 步的数据库是持久的（`apps/api/data/local.sqlite`，已 gitignore），第 3 步每次重建自己的临时库。
- 留存清理若要真删，必须 `--apply --confirm-database <同一路径>`（runbook §7）。
- 恢复演练会临时启动 3321 端口的一个 API 进程并在结束时停掉；若 3321 被占用脚本会失败，先查占用。

**B7（参数快照）的现状与入口**：已实现（R2）。`/api/me/saved-state/:experimentId` 的 GET/PUT/DELETE 已挂载并登记在受控清单里，参数白名单来自 `experiments/<folder>/state-schema.json`（服务器启动时校验，非法即拒绝启动）。给新实验加保存能力 = 加一个 `state-schema.json` 并在视图里读写 `initialState` / `stateBridge`；服务端不需要改代码。

## 阻塞与未决
- 阻塞公开上线（不阻塞本地）：服务器参数与部署布局（Q1）、域名/HTTPS 与 Cookie 前缀（Q2）、服务地域与留存期限（Q3，**未成年人政策已决定：不设年龄门槛**，见 R5-1）、**多实例与共享限速（Q6）**、**生产备份异机复制（需服务器确认，未做未验证）**。**Q4（账号删除/数据导出）已由负责人于 2026-10-27 决定移出首版范围**，不再作为上线阻塞项，但转为"不得宣称拥有"的文案约束与已记录的残余风险。**远端仓库与 CI 已在 R1 落地并实测通过，此项已解除**；R3 已把 Q1/Q2/Q3/Q6 的前置条件与本机侦察结论写进 `docs/ops/deployment-plan.md` 与 `docs/privacy/launch-readiness.md`（**远端测试部署仍阻塞：需服务器地址/访问方式/独立域名**，且**上线前仍需负责人单独授权**）。
- 未做：服务器只读侦察、目标库迁移与授权实跑、标识归属验证（首版不做短信/邮件）。
- 不得擅自改生产；不得在无测试输出/证据时声称通过或 URL 可用；未经用户明确同意不新增 `AGENTS.md`、不部署、不发布。**推送公开仓库已获项目所有者 2026-10-26 授权**（仅逐路径审查过的源码），本轮已推送且未部署。
