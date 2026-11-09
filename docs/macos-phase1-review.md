# Phase 1 最终审核记录

记录日期：2026-11-09（Asia/Shanghai）。审核对象为 Fork
[`zhaoochunn/FUCKINTERVIEW` 的 Draft PR #1](https://github.com/zhaoochunn/FUCKINTERVIEW/pull/1)，
base `main`，head `feature/macos-arm64`，功能提交
`a7527f11c6e8595ac656f44de6bf5dfd3220363c`。
本轮仅修改验收/审核文档，功能代码和测试代码保持原样。

## 审核证据与边界

- 读取了 PR API 的文件列表、状态、head SHA、实际检查结果，以及本地与该 SHA 一致的完整 diff。
- 追踪了 Electron 入口、preload、IPC、窗口重建、后端启动/停止、权限 UI、目录选择及
  原有 FastAPI 数据保存/迁移调用链；检查了新增测试、依赖清单和 CI 配置。
- 通过只在内存中调整现有 Electron double 的宿主路径语义，复现 Windows 路径断言不一致；
  通过发送模拟的后端 exit/close 事件复现失效 backend 引用。没有将探针写入项目或修改功能。
- M5 实机证据来自用户，详见 [验收报告](macos-phase1.md#8-m5-实机验收报告用户提供)。
- 没有把 Linux 探针当作 Windows/macOS 原生执行，没有把本机 124 passed 当作 CI 全绿。

## 实际 CI 结果（对应 a7527f1）

以下由 GitHub Actions API 查询，不是计划执行的命令。时间转换为北京时间：

| 事件/任务 | 结果 | 证据 |
| --- | --- | --- |
| PR：backend / test | success | [run 42599494496](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42599494496)，2026-11-09 18:15 完成 |
| PR：desktop-platform / Ubuntu | success | [job 129100164788](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42599494402/job/129100164788) |
| PR：desktop-platform / Windows | failure | [job 129100164470](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42599494402/job/129100164470) |
| PR：desktop-platform / macOS | failure | [job 129100164773](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42599494402/job/129100164773) |
| 较早 push：backend | success | [run 42598648258](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42598648258) |
| 较早 push：desktop-platform | Ubuntu success、Windows failure、macOS success | [run 42598648256](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42598648256) |

PR 的 Windows、macOS 任务均失败在 `Run npm --prefix desktop test`，退出码 1；
随后前端测试、npm ci 和前端构建均为 skipped，不能标记为通过。
任务注释另含旧 Actions Node 20 运行时弃用警告；macOS 注释还有 ARM64 runner 容量提示。
这些提示本身不能解释测试失败。

完整日志下载被 `results-receiver.actions.githubusercontent.com` 的代理 403 阻止，
因此 macOS 的具体失败断言仍未查明，也不能确认 Windows 是否还有路径断言以外的失败。
已读取任务步骤和 check-run annotations；它们仅提供失败步骤与退出码。
文档提交触发的新检查是另一组运行，不能沿用上述提交的结果。

## 发现的问题

### Critical

未发现有证据支持的 Critical 问题。静态审核不能证明不存在所有安全问题。

### High — H1：跨平台 CI 失败，且 Windows 测试含确定的平台路径缺陷

- 位置：`desktop/electron/main.test.js:71`、`:86`；CI 入口
  `.github/workflows/desktop-platform.yml:26`。
- 原因：测试仅模拟 `process.platform`，仍导入宿主 `node:path`。Windows 上运行
  macOS 分支测试时，`path.join` 返回 `\\user\\appData\\interview-desktop-dev\\data`，
  但断言固定比较 `/user/appData/interview-desktop-dev/data`。
- 证据：内存中的 Win32 路径语义探针得到不相等结果；实际 Windows CI 在桌面测试步骤失败。
  不能在缺少完整日志时声称这是唯一失败原因。
- 建议：统一测试的路径平台语义与期望值，补齐跨平台测试隔离；获取失败日志，分别定位
  macOS 和 Windows 的其他错误。macOS 曾成功后失败，应调查时序/环境差异，而非直接认定是偶发错误。
- 门禁：必须在合并前解决 CI 红灯；修复需另获批准，本轮未改测试或功能。

### Medium — M1：后端就绪后异常退出，Dock 恢复仍复用失效服务

- 位置：`desktop/electron/main.js:243`、`:534`；相关启动检测
  `desktop/electron/backend.js:146`、`:171`。
- 原因：启动后子进程退出仅结束日志，主进程未清空 `backend` 或标记故障。
  `showMainWindow` 只检查引用是否存在，直接重建窗口并加载旧 URL。
- 证据：对现有 Electron double 注入 exit/close 后关闭窗口并 activate，得到两个窗口创建记录、
  后端仅启动一次、重开旧 URL、错误对话框为零。该探针不等同于 M5 原生崩溃恢复测试。
- 影响：后端因异常退出时，用户可能看到连接失败/空白页面，Dock 重开无法恢复。
  正常启动和退出的 M5 已通过结果不覆盖此场景。
- 建议：明确运行期后端状态；退出时更新引用并显示故障，恢复时只启动一个后端，
  退出应用期间禁止自动重启；增加异常退出与重开窗口的测试。
- 门禁：建议作为合并前生命周期缺口修复并复测；本轮未修改功能。

### Low — L1：CI 使用已触发 Node 20 弃用提示的 Actions 版本

- 位置：`.github/workflows/desktop-platform.yml:18`、`:19`、`:22`，以及既有
  `.github/workflows/backend.yml:11`、`:13`。
- 原因：GitHub 注释指出 checkout@v4、setup-node@v4、setup-python@v5 的 Node 20
  运行时被强制转为 Node 24。这与项目使用 Node 24 是两层配置。
- 建议：后续核对官方支持的 Actions 版本并评估升级；不把它当作已确认的失败根因，
  也不与用户已接受的 MODULE_TYPELESS_PACKAGE_JSON/audioop 警告混为一谈。
- 门禁：此提示单独不阻断本轮验收，不应靠隐藏警告替代定位失败。

## 其他审核结论

- IPC：新增目录与权限接口限制为当前主窗口、主 frame 和精确应用 Origin；目录初始值
  校验类型、长度及 NUL，拒绝并发选择。对话框只返回路径，保存/迁移仍走有令牌保护的 API。
- Electron：保留 contextIsolation、sandbox、关闭 nodeIntegration，未新增任意命令执行接口，
  未扩大 HID/USB 权限。权限查询不会自动请求 TCC；用户操作只申请麦克风。
- 数据：本 PR 没有修改 app/、server.py、Pipecat、依赖版本或锁文件；macOS 开发数据改到
  userData/data，明确尊重环境变量覆盖。未在 diff 中发现 API Key、用户数据库或个人配置。
  原有迁移逻辑包含冲突预检、SQLite 快照和失败清理；不能据此宣称并发迁移、外置卷、
  中途强杀或真实资料迁移已经实机验证。
- Windows：无边框、托盘、Ctrl+Q、loopback、内容保护与 taskkill /T 的分支仍存在。
  停止进程的等待/错误处理及目录对话框实现发生变化，需真实 Windows 回归；保留分支不等于无回归。
- 构建：本 PR 没有新增 macOS 安装包或签名配置，现有 dist 仍为 Windows NSIS；符合 Phase 1 边界。
- 能力：macOS 系统音频在入口被拒绝，内容保护开关不显示；不宣称这些功能已可用。
- 测试覆盖：现有 main double 把单实例锁固定为 true，不覆盖锁失败路径；没有运行期后端崩溃恢复测试。
  POSIX 强制退出测试以进程组消失后立即检查 signalCode，存在事件通知顺序的排查点，
  但未获得 macOS 失败断言，不能认定其为本次 macOS CI 根因。

## 合并建议与 Phase 2 前置条件

当前建议保留 Draft，不建议合并。先处理 H1，修复并复测 M1，再补齐启动中立即退出、
单实例限制、完整窗口操作、麦克风拒绝/重新授权及 Windows 实机回归。重新查看新 head 的 CI，
不得仅重跑直到偶然变绿。用户确认前不更改 Draft 状态、不合并、不开始 Phase 2。

Phase 2 另需明确 macOS 最低版本、Electron CoreAudio Tap 与 ScreenCaptureKit 的实际行为差异、
系统录制权限及 helper 授权归属、PCM/MediaStream 桥接延迟、双路音频防重复、设备切换/后台恢复，
并在 M5 上建立会议软件测试矩阵。BlackHole 授权与项目整体分发授权仍需单独确认；
这些是后续技术前置条件，不是本轮已完成能力。
