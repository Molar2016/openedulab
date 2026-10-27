# OpenEduLab 下一次执行：教材目录收束验收计划

> **For Hermes:** 用户要求在任何下一次执行之前先把本计划的任务边界和步骤在聊天中讲清并等待认可；当前只做规划，不启动子任务、不写业务代码、不提交、不部署。获得认可后按下列四步执行，每步结束更新进度，不追加未经认可的架构层。

**Goal:** 把当前本地未提交的六册教材目录接入工作收束成简单的“学科→教材版次→本版册/章/节→工具入口”，不再做新版/旧版专区。

**Architecture:** 学科只有数学等导航；每个教材版次是同层普通目录条目，属性包含出版年份/所据课标/来源。教材自己的册章顺序只属于该教材。工具代码只保留一个稳定 ID，章节入口通过 placement 引用它并带独立预设/保存。九下资料与另一本的章号冲突时用不同 catalogId 识别，不添加旧版专属界面、徽标、路由或权限。

**Tech Stack:** 现有 TypeScript/Fastify/React、JSON 目录、Vitest/Playwright、工作机本地实例；不引入新服务、数据库表或外部系统。

---

## 起点和硬边界

- 用户刚纠正“旧教材单列”：之前按新/旧划特殊展示是误解，应删除这种 UI 语义；必要的版次字段只是教材属性。六册 PDF 已在 `G:/hermes/downloads/人教版初中教材/`，`docs/research/pep-math-six-volumes.md` 已核过 34 章/98 节；无需重新下载。
- 工作区有 R8/G2 及尚未完成的 G3 **未提交改动**。`curricula/math/pep-math-2022.json` 已写入五册，另一 catalog 包含九下；`experiments/math-functions/curriculum.json` 已出现新入口。部分 E2E 修改了历史 `docs/evidence/b6/` 截图/录屏，属无关生成物，不准顺手提交。当前 `main` HEAD 仍为 d3edb4c。G3 子任务已叫停；本计划未经用户看到和认可前不继续编码。
- 本次不增加“旧版区/新版区”、教学班/学期/学生进度、教材正文/插图/PDF 托管、新工具、新登录规则、新数据库迁移，不修改 VPS/DNS/防火墙。

## 下一次执行的四步（按序完成，不并发改同一仓库）

### 1. 对已写内容做差异盘点，不重做六册

**检查：** `git status --short`；`curricula/math/pep-math-2022.json`、`curricula/math/pep-math-9b-legacy.json`、`experiments/math-functions/curriculum.json` 与 `docs/research/pep-math-six-volumes.md`。程序化统计册、章、节、入口个数并随机回查目录页；列出已经有、缺失、错误及无关改动，不根据文件名猜年份。

**验收：** 六册目录目标是 34 章/98 节；只有八下 23.2 与九上 26.2 两个新增适配入口，同一个 `math.functions`；旧四个示例入口 ID/个人快照不动。这里仅核实，不据此称已上线。

### 2. 修正目录展示，不做新架构

**修改范围（只在已有代码需要处）：** `apps/web/src/app/CurriculumPage.tsx`、`apps/web/src/app/curriculum-tree.ts`、`apps/web/src/services/api.ts`、`apps/web/src/i18n/locales/{zh-CN,en}.json`；若数据标签暗示特殊分组，则改两份 `curricula/math/*.json` 中的教材标签。按“数学→教材版次（同层）→册→章→节”展示，年份/版次放在教材名称或普通详情里；删除“current/legacy”专用徽标与任何旧教材专区逻辑。章节没有工具时只显示“暂无对应工具”。不改工具代码、收藏/最近使用/保存 API。

**测试先行：** `tests/curriculum-tree.test.ts`、`tests/curriculum-page.test.tsx` 断言两个版次位于同一教材列表、各自顺序独立、没有专属旧版分组；记录 RED 后修到 GREEN。若审查表明现有代码本就没有特殊分支，则**不为改而改**，保留数据的必要版次标识并直接走下一步。

### 3. 完整回归，清理无关生成物

**运行：** `npm run check`、`npm run smoke:api`、`npx playwright test`；新增/更新 `apps/api/test/curriculum-six-volumes.test.ts` 与 `tests/e2e/curriculum.spec.ts`，核实六册章序、两个入口保存互不串、旧示例链接仍可用。检查 `git diff --check`、`git diff --cached`；对测试生成的 `docs/evidence/b6/*` 只回退**确定由本轮测试新改的产物**，不动用户原有其他修改。

**通过判据：** 静态/单测/真实 API smoke/浏览器 E2E 全绿且旧 placement ID 不变；若失败，先定位根因，不能通过删断言放宽结果。

### 4. 工作机本地体验与交付

**动作：** 精确确认 `127.0.0.1:3320` 的进程/数据库，仅对本项目隔离实例重启构建，不碰 `127.0.0.1:3221` VPS 转发。真浏览器登录后打开教材目录，逐项看同层教材、各自章节、八下 23.2/九上 26.2 工具入口并各保存一次，刷新回读；观察收藏/最近使用仍按同一个工具合并。

**交付：** 更新 `docs/PROJECT_STATE.md` 一次性写明真实测试和已知缺口；仅将审查过的业务文件和必要 R8/G2/G3 文档按范围 stage/提交，远端 CI 及推送如执行须回证。向用户报“文件/版本、页面地址（工作机远程桌面内）、测试结果、未覆盖章节”；未通过任何关口就暂停在该关并告知。不要宣称公网发布。

## 汇报和停止规则

- 获用户认可前状态为 **暂停待确认**，周期性 R9 播报已暂停，避免它错误显示还在开发。
- 真正启动时先登记本轮任务/目标关口，再开每 15 分钟的**任务级**飞书状态（要核首次回执，避免仅 scheduler 返回 ok），显示“进行中/失败/待复核/完成”。本轮完成或暂停即关闭；正式完成报告由主会话主动发送。
- 上一步未通过，不自动跳到下一步；若发现版别语义又与用户意思不同，先向用户展示实际目录层级再改数据，不凭自己增加分类。
