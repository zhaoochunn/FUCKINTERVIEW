# Phase 1 最终审核记录

当前状态：用户已提供 `f5766a4` 的 M5 Python 95 / 桌面 39 / 前端 5 项通过、构建成功，
并确认启动、关窗/Dock、Command+Q 正常，未发现异常弹窗或明显进程残留，接受当前 Phase 1 门禁。
异常注入等没有提供结果的项目仍待验。本文以下发现与日志为历史证据；当前验收记录见
[Phase 1 第 11 节](macos-phase1.md#11-phase-1-当前验收门禁通过用户确认)。
用户已授权 Phase 2.M1 独立采集原型，不代表授权直接接通全部 AI 工作流或合并 PR。

记录日期：2026-11-09（Asia/Shanghai）。审核对象为 Fork
[`zhaoochunn/FUCKINTERVIEW` 的 Draft PR #1](https://github.com/zhaoochunn/FUCKINTERVIEW/pull/1)，
base `main`，head `feature/macos-arm64`，功能提交
`a7527f11c6e8595ac656f44de6bf5dfd3220363c`。
此前审核阶段仅修改验收/审核文档；其后用户已授权修复 H1/H2/M1。
历史问题和日志保持原样，下节单独记录修复状态，不把旧 M5 结果扩展到新提交。

## H1/H2/M1 修复记录

功能修复提交 `7820ff6`，跨宿主测试隔离提交 `932ce1c`。

| 问题 | 已实施修复 | 验证边界 |
| --- | --- | --- |
| H1 | main.test.js 使用 path.join 构造宿主一致的期望路径；保留窗口/Dock/退出完整断言 | 云端通过，Windows CI 以新提交实际结果为准；不跳过原失败用例 |
| H2 | 进程组探测遇 EPERM 后读取非特权 ps 快照，核对组成员 UID 与状态；仅在无活成员且已收到组长退出状态时完成。保留 TERM→KILL、超时与实际发送信号的错误；无法判定/其他 UID/发送信号 EPERM 均不作为成功 | 增加 zombie、存活后代、状态未知、TERM/KILL 拒绝、退出事件同步、真实父子进程回归；M5 新修复尚未复测 |
| M1 | 后端 exit 后清空当前引用、撤销 Origin、移开失效页面并报错；清理旧进程组后才恢复。bootPromise 串行化 Dock/托盘/第二实例触发，退出过程中不重启 | 覆盖窗口开/关、并发恢复、旧 exit、恢复中退出；M5 新修复尚未复测 |

`932ce1c` 还明确给 POSIX 模拟用例指定 darwin 目标平台，避免在 Windows 宿主误走
taskkill 分支。没有删除或跳过失败测试；只有两项真实 POSIX 进程测试在 Windows 按平台跳过。
本轮未修改后端业务、依赖清单/锁文件、采集代码或 Windows 的 taskkill /T 功能。

云端本轮执行结果：Python 95 passed（1 个 audioop 弃用警告）、桌面 35 passed、
前端 5 passed、TypeScript/Vite 构建通过，合计 135 passed；不代表新的 M5 验收。
历史 M5 124 passed 对应 a7527f1，保持不变。修复提交 `932ce1c` 的新 CI 快照：

| 检查 | 实际状态 | 证据 |
| --- | --- | --- |
| Backend | success | [run 42622281103](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42622281103) |
| 平台 Ubuntu | success | [run 42622280942](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42622280942) |
| 平台 Windows | success（桌面、前端测试与构建完成） | 同上 |
| 平台 macOS ARM64 | queued，尚未取得执行结果 | 同上；不可计为通过 |

首个功能提交 `7820ff6` 的 Windows 桌面任务未通过，随后 `932ce1c` 补齐了 POSIX 用例的
显式平台参数，新提交的 Windows 任务通过。不得用旧失败或某次本机结果替代新 head 的 CI。
本轮文档提交触发的检查也应按其 SHA 单独观察；没有宣称排队任务通过。

随后 `878ed39`（功能代码与 `932ce1c` 一致）的实际 push 检查已完成：
Backend [run 42622615198](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42622615198) success；
平台 [run 42622615382](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42622615382) 中
Ubuntu、Windows、macOS ARM64 均 success，桌面/前端测试、安装和构建步骤均通过。
macOS [job 129178319147](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42622615382/job/129178319147)
提供 H2 在真实 macOS ARM64 CI 上的验证；H1/H2/M1 的代码与自动化修复已验证，仍待用户 M5 原生复测。
没有把 Windows 按平台跳过的真实 POSIX 测试计为通过。

本轮完整功能盘点与后续方案见 [macOS 功能矩阵](macos-feature-matrix.md)。
本轮范围不包括 Phase 2 采集编码、悬浮窗等新功能、安装包或发布。

### 后续 M5 fixture 回归（5d371d4）

用户在 M5 再测为 Python 95 passed、桌面 34 passed/1 failed、前端 5 passed、构建成功。
失败位于原 process-lifecycle.test.js:164 的正 PID 断言，尚未进入显式清理验证。
旧 fixture 把 stdout 第一个 data chunk 当完整 PID，存在启动输出污染/字节分块导致误解析的
确定性测试通信缺陷；隔离复现分别得到 NaN 和错误的部分 PID。
原始 M5 chunk 未被捕获，具体触发内容未知；不能从当前证据认定 process-lifecycle.js 有新运行时缺陷。

`5d371d4` 用专用 IPC 与后代→父进程→测试的双层就绪握手取代 stdout 解析，
保留真实后代、父进程退出及 ESRCH 原断言；加入有界诊断、超时、无效消息和提前退出回归。
运行时进程管理文件保持不变。Linux 桌面 39 项全部通过，真实进程树重复 10/10 通过；
该修复后的 M5 结果仍待用户提供，命令见 [M5 复测文档第 10 节](macos-phase1.md#10-m5-父子进程-fixture-失败与修复复测)。

`5d371d4` 的实际 CI 已完成：Backend [run 42624082137](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42624082137)
success；平台 [run 42624080268](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42624080268)
中 Ubuntu、macOS ARM64、Windows 均 success。macOS 桌面 39 pass/0 fail/0 skipped，
Windows 为 37 pass/0 fail/2 个真实 POSIX 用例按平台跳过；各平台前端测试与构建通过。
macOS [job 129183227368](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42624080268/job/129183227368)
日志确认目标真实后代清理用例通过。云端 Python 95 passed、前端 5 passed、构建通过。
CI 不替代用户 M5 的新复测；文档提交的新检查按其 SHA 另记。

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

初次审核时，日志下载被 `results-receiver.actions.githubusercontent.com` 的代理 403 阻止。
本次已在新实例确认该域名白名单生效，并读取下述 `329d187` 的 Windows/macOS 完整任务日志，
以及同一提交 push 运行的失败步骤日志。以下定位取代此前“macOS 失败断言未查明”的结论。
上表 `a7527f1` 的历史结果仍单独保留，不把新运行的错误细节倒推为旧运行的完整证据。

### 完整日志复核（对应文档提交 329d187，功能代码仍为 a7527f1）

| 任务 | 环境与结果 | 日志证据 |
| --- | --- | --- |
| PR：Windows | Windows Server 2025 10.0.26100 x64，Node 24.22.2、Python 3.12.10；24 项中 22 pass、1 fail、1 skipped | [job 129166725171](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42619216955/job/129166725171) |
| PR：macOS | macOS 26.7.2，image macos-26-arm64 20261102.0473.1，Node 24.22.2、Python 3.12.10 ARM64；24 项中 22 pass、2 fail、0 skipped | [job 129166724724](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42619216955/job/129166724724) |
| 同提交 push：Windows | 22 pass、1 fail、1 skipped；相同路径断言失败 | [job 129166698478](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42619209127/job/129166698478) |
| 同提交 push：macOS | 23 pass、1 fail、0 skipped；强制退出测试仍报 kill EPERM，后端 fixture 启停测试通过 | [job 129166697959](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42619209127/job/129166697959) |

两次运行的后端工作流和 Ubuntu 平台任务均通过；Windows/macOS 平台任务后续前端测试、
npm ci 和构建均 skipped。未重新运行 CI，也未更改依赖或测试以使其通过。
CI 环境与用户 M5 的 macOS 27.0.1、Node 24.21.0、Python 3.12.14 不同，不能相互替代。

Windows 日志（2026-11-09 20:42:37，北京时间）明确记录：

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal
actual: '\\user\\appData\\interview-desktop-dev\\data'
expected: '/user/appData/interview-desktop-dev/data'
at TestContext.<anonymous> (.../desktop/electron/main.test.js:86:10)
```

macOS PR 日志（2026-11-09 20:43:00，北京时间）记录两个错误：

```text
test at electron/backend.test.js:12:1
Error: kill EPERM
  at alive (.../desktop/electron/process-lifecycle.js:14:13)
  at .../desktop/electron/process-lifecycle.js:30:10
  at stopBackend (.../desktop/electron/backend.js:190:30)
  at stopAll (.../desktop/electron/backend.js:196:25)
  at TestContext.<anonymous> (.../desktop/electron/backend.test.js:24:11)

test at electron/process-lifecycle.test.js:62:1
Error: kill EPERM
  at alive (.../desktop/electron/process-lifecycle.js:14:13)
  at waitUntilGone (.../desktop/electron/process-lifecycle.js:25:14)
  at .../desktop/electron/process-lifecycle.js:49:16
  at async TestContext.<anonymous> (.../desktop/electron/process-lifecycle.test.js:73:5)
```

分类结论：Windows 是确定的测试代码跨平台缺陷；macOS 是运行时进程组探测与当前
macOS 环境不兼容，已定位到应用清理代码，不应当作普通 CI 下载故障忽略。
日志没有提供 Node/Python 模块缺失、Electron 下载失败或依赖解析失败的证据。
但是，单凭 EPERM 不能断言 runner 限制了权限、进程仍存活、出现僵尸进程，或 Node 本身存在缺陷。
没有进程 PID/PGID、UID、退出事件与进程状态的同步记录，底层触发条件仍需目标 Mac/runner 诊断。

## 发现的问题

### Critical

未发现有证据支持的 Critical 问题。静态审核不能证明不存在所有安全问题。

### High — H1：Windows 测试含确定的平台路径缺陷

- 位置：`desktop/electron/main.test.js:71`、`:86`；CI 入口
  `.github/workflows/desktop-platform.yml:26`。
- 原因：测试仅模拟 `process.platform`，仍导入宿主 `node:path`。Windows 上运行
  macOS 分支测试时，`path.join` 返回 `\\user\\appData\\interview-desktop-dev\\data`，
  但断言固定比较 `/user/appData/interview-desktop-dev/data`。
- 证据：Win32 内存探针与两次实际 Windows 任务日志一致。所读两个 Windows 桌面任务均只有
  该项失败；POSIX 实进程测试按平台明确跳过 1 项，不能计为通过。
- 建议：统一测试的路径平台语义与期望值，补齐跨平台测试隔离；不要把它误判为 Windows UI 功能损坏。
- 门禁：必须在合并前修复并核查 Windows CI；修复需另获批准，本轮未改测试或功能。

### High — H2：macOS 进程组状态探测抛出 EPERM，清理流程失败

- 位置：`desktop/electron/process-lifecycle.js:14`、`:15`、`:25`、`:30`、`:49`；
  调用链 `desktop/electron/backend.js:190`、`:196`；失败测试为
  `desktop/electron/backend.test.js:24` 和 `desktop/electron/process-lifecycle.test.js:73`。
- 已确认的代码原因：`alive()` 通过 `process.kill(-child.pid, 0)` 检查进程组，仅把 ESRCH
  当作结束，其余异常直接抛出。PR 的普通退出清理以及强制退出后的轮询都在这里遇到 EPERM。
  强制退出测试的堆栈位于第 49 行，未到第 74 行 signalCode 断言；因此不能把此前提出的
  signalCode 通知顺序排查点当作本次已确认根因。
- Apple 公开 XNU 源码的 [`killpg1`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
  在遍历中排除僵尸进程，并可在没有可命中成员时返回 EPERM。这说明 EPERM 不必然代表
  “缺少管理员权限”。这份源码是语义参考，不等于已经证明该 CI 内核版本或当时进程正处于该状态。
- 证据限制：PR 中后端 fixture 的最终堆栈来自 finally 内 `stopAll()`，可能覆盖 try 中先前的错误；
  不能据此断言该项启动/请求的每个步骤都通过。push 中该项通过而强制退出仍失败，表明失败
  随退出路径/时序变化，但日志不足以证明确切竞争条件。
- 建议：基于 ChildProcess exit/close 与明确的进程组所有权设计清理状态机，记录退出/探测顺序，
  区分探测结果不确定与发送终止信号失败；验证正常退出、TERM 超时、KILL、组长先退出且
  子进程仍存活等场景。不应简单把所有 EPERM 当作已退出，也不应使用 sudo 或降低系统安全策略。
- 门禁：合并前必须解决这一运行时代码兼容问题并在 CI/M5 验证，不能仅跳过测试或反复重跑。

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
  完整 CI 日志确认当前 macOS 强制退出测试失败于进程组探测，而非 signalCode 断言。

## 合并建议与 Phase 2 前置条件

当前建议保留 Draft。H1/H2/M1 已有代码修复，需核实新 CI 并在 M5 复测，再补齐启动中立即退出、
单实例限制、完整窗口操作、麦克风拒绝/重新授权及 Windows 实机回归。重新查看新 head 的 CI，
不得仅重跑直到偶然变绿。用户确认前不更改 Draft 状态、不合并、不开始 Phase 2。

Phase 2 另需明确 macOS 最低版本、Electron CoreAudio Tap 与 ScreenCaptureKit 的实际行为差异、
系统录制权限及 helper 授权归属、PCM/MediaStream 桥接延迟、双路音频防重复、设备切换/后台恢复，
并在 M5 上建立会议软件测试矩阵。BlackHole 授权与项目整体分发授权仍需单独确认；
这些是后续技术前置条件，不是本轮已完成能力。
