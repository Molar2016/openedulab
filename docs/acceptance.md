# M0/M1 执行与验收

> **暂停执行：以下为旧版免登录范围，已被用户后续澄清覆盖。先确认 docs/requirements-v2-draft.md，再重写验收；不得将本文件作为开发依据。**

## 依赖顺序（8 项）
1. 确认公开实验是否免登录；批准 M1 采用原创素材/合规许可；明确本地新项目而非改现有仓库。
2. 只读确认本机与未来部署环境（远端需访问方式和授权）；留风险清单。
3. 初始化独立仓库、README、状态锚和 ADR；仅安装实际使用的依赖。
4. 建 React/TS/Vite 框架、中文/英文切换、首页与筛选目录。
5. 完成 manifest 校验/自动发现、动态加载、实验宿主、错误边界、重置/全屏。
6. 写一次函数和二次函数的纯函数模型及边界/非法输入单测，再实现 SVG 交互视图、教学说明与公式假设。
7. 实装可关闭的匿名事件接口（默认不联网）、最小隐私声明、反馈预览 UI（未有接收端时不虚报已提交）。
8. 运行 typecheck、lint、单测、构建、PC/手机端 E2E 与可访问性检查；截图/短录屏、版本记录、本机访问 URL，提交具体文件并回读状态。

## 建议的最小树
```
apps/web/src/{app,host,services,i18n}/
experiments/math-functions/{manifest.ts,model.ts,view.tsx,locales/,tests/,teaching-notes.md}
docs/architecture/{ADR-000-foundation.md,ADR-001-experiment-contract.md}
docs/{PROJECT_STATE.md,acceptance.md}
README.md  package.json  .gitignore
```
仅随着真实代码出现而建目录。

## M1 验收（可操作）
- 首页 3 次点击以内开始实验；按学段/学科/知识点检索、切换中英文，缺失翻译有检测。
- 新实验只改实验目录和清单，不改宿主逻辑；版本不兼容明确报错。
- 参数 a/b/c 变化带来符合 y=ax²+bx+c / y=mx+b 的曲线；a=0、顶点、根、极值边界及非法输入测试；图上单位/刻度和坐标轴可读。
- 重置恢复默认值；全屏进出状态一致；窄屏与投影尺寸可操作；错误隔离、卸载无残留资源。
- 禁用分析/无网络仍可实验；不得传手机号、邮箱、原始输入值或堆栈秘密；反馈必须预览，未配置后端不发送。
- typecheck、lint、unit、build、manifest/i18n 校验、关键 E2E/基础可访问性全部通过，保留截图与短录屏路径。公开部署不属于本机 M1 的自动完成标准。
