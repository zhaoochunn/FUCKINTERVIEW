# macOS ARM64 Phase 1：源码运行与验收

开发目标仅为 `https://github.com/zhaoochunn/FUCKINTERVIEW`，分支
`feature/macos-arm64`，PR 的目标为该 Fork 的 `main`。不要向原作者仓库推送。
本阶段提供桌面平台基础适配；目前 M5 已完成部分实机验收，不代表 macOS 完整支持。

## 本阶段边界

- macOS 使用原生标题栏、红黄绿按钮、应用菜单、Command+Q、Dock 激活及菜单栏图标。
- macOS 关闭窗口会保留后端，Dock 或菜单栏可重开同一服务；退出应用会停止后端。
- Windows 保留无边框窗口、关闭到托盘、Ctrl+Q、系统环回入口和内容保护入口。
- 桌面目录选择使用 Electron 原生对话框；浏览器版保留后端目录选择接口。
- macOS 显示麦克风、摄像头和屏幕录制的系统权限状态；只有用户点击才申请麦克风权限。
- **macOS 系统音频尚未实现**，开始实时面试会明确提示。没有 ScreenCaptureKit、
  Swift helper、BlackHole 集成、macOS 打包、签名或公证实现。
- **不提供 macOS 防截屏保证**，不显示该开关。权限状态不等于采集能力。
- 本文是开发流程，用户需要开发工具；自包含 `.app` / `.dmg` 属于后续阶段。
- 项目整体授权尚需确认，不公开分发构建产物。

## 1. 准备 Apple Silicon 开发环境

在原生 ARM64 Terminal 中执行。系统版本、M5 型号和测试结果应记录在验收反馈中。

```bash
uname -m
sw_vers
xcode-select -p
```

`uname -m` 应为 `arm64`。若命令行工具尚未安装，执行以下命令并完成系统安装对话框：

```bash
xcode-select --install
```

需要 Git、Python 3.12、Node.js 24（当前前端工具的实际要求高于 README 的旧 Node 20 基线）。
已安装 ARM64 Homebrew 的开发者可以执行：

```bash
brew install python@3.12 node@24
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix python@3.12)/bin:$PATH"
python3.12 --version
node --version
node -p 'process.arch'
python3.12 -c 'import platform; print(platform.machine())'
```

两个架构检查都应输出 `arm64`。没有 Homebrew 时可从 Python 和 Node 官方渠道安装
对应 ARM64 版本；不要混用 Intel Homebrew 的 `/usr/local` 运行时。

## 2. 获取 Fork 开发分支

新目录克隆：

```bash
git clone --branch feature/macos-arm64 https://github.com/zhaoochunn/FUCKINTERVIEW.git
cd FUCKINTERVIEW
git remote -v
git branch --show-current
git status --short
```

已有 checkout 时先确认并保留个人改动，然后执行：

```bash
git remote get-url origin
git fetch origin
git switch feature/macos-arm64
git pull --ff-only origin feature/macos-arm64
```

若本地尚无分支，使用 `git switch --track origin/feature/macos-arm64`。
不要在 `main` 上改代码，不要 reset 或覆盖个人改动。

## 3. 安装源码运行依赖

从仓库根目录执行：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt -e './pipecat[webrtc]' 'pytest>=8'
.venv/bin/python -m pip check
npm --prefix web/client ci
npm --prefix desktop ci
npm --prefix web/client run build
.venv/bin/python -c 'import platform, server, aiortc, onnxruntime; print(platform.machine()); print(onnxruntime.get_available_providers())'
```

`webrtc` extra 是 SmallWebRTC 源码启动所需依赖；仅安装根 requirements 不足以保证
实时传输依赖存在。Phase 1 不更改 ASR / LLM 配置。无需提供 API Key 即可验收桌面、
目录和权限状态。导入 ONNX Runtime 不能替代真实模型推理验证。

## 4. 自动化测试与启动

从仓库根目录执行：

```bash
.venv/bin/python -m pytest -q
npm --prefix desktop test
npm --prefix web/client test
npm --prefix web/client run build
INTERVIEW_PYTHON="$PWD/.venv/bin/python" npm --prefix desktop start
```

开发者工具模式：

```bash
INTERVIEW_PYTHON="$PWD/.venv/bin/python" npm --prefix desktop run dev
```

源码桌面端从 7870 起选择空闲端口，页面与 API 同源。Phase 1 本地数据默认位于：

```text
~/Library/Application Support/interview-desktop-dev/data/
~/Library/Application Support/interview-desktop-dev/backend.log
```

Chromium 偏好和会话位于同一开发 userData 下，与正式应用隔离。macOS 源码启动不默认
写入仓库的 `config/`。原有 Windows 开发数据定位保持不变。

需要完全独立的验收数据时，在同一终端执行并记录目录：

```bash
test_data_dir="$(mktemp -d /tmp/interview-phase1.XXXXXX)"
INTERVIEW_DATA_DIR="$test_data_dir" INTERVIEW_PYTHON="$PWD/.venv/bin/python" npm --prefix desktop start
```

不自动删除该目录；确认没有需要保留的数据后自行清理。不要上传个人数据、settings.json、
数据库、令牌或日志中的敏感内容。

## 5. M5 手工验收清单

每项记录通过/失败、macOS 版本、复现步骤；没有实际执行的项目标为未执行。

1. 页面正常加载，无 Python/Node 缺失提示；原生红黄绿按钮显示，前端不重复绘制 Windows 按钮。
2. 最小化、原生全屏、拖动、窗口缩放可用；菜单包含应用、编辑、视图和窗口菜单。
3. Command+C/V/A/Z 等编辑动作及 Command+Q 可用；正常退出不弹后端退出错误。
4. 关闭窗口后应用保持运行，点击 Dock 或菜单栏“显示主窗口”恢复页面；
   不应启动第二个 Python 后端。重复关闭/打开至少五次。
5. 启动画面出现后立即退出；后端不会在退出后继续启动。再次启动正常。
6. 连续两次启动同一源码应用，仅保留一个实例。
7. 在首次目录引导和设置中选择含中文/空格的测试目录；取消不改变原路径，成功选择可保存。
   本阶段使用空测试目录，不对真实资料执行迁移验收。
8. 确认设置“通用”中的 macOS 权限状态可读取、刷新；返回应用焦点时刷新。
   打开设置本身不自动弹麦克风/摄像头/录屏授权框。
9. 点击申请麦克风权限，分别记录允许、拒绝、已拒绝后的行为；系统设置中变更后刷新，
   必要时重启。开发模式可能归属于 Electron/启动宿主，最终签名应用需后续重新验收。
10. 不显示 macOS 防截屏开关；实时面试入口明确提示 Phase 1 尚未实现系统音频，
    不应发起屏幕采集或承诺可识别会议音频。
11. Command+Q 后检查 Python 后端及其子进程退出，没有持续占用开发端口。

可在另一终端辅助检查（不要把其他项目的 Python 进程当成残留）：

```bash
ps -axo pid,ppid,pgid,command | rg 'server.py|Electron'
lsof -nP -iTCP:7870-7889 -sTCP:LISTEN
git status --short
```

## 6. 常见错误

| 现象 | 排查 |
| --- | --- |
| Electron 找不到 Python | 在仓库根目录重新执行带 `INTERVIEW_PYTHON="$PWD/.venv/bin/python"` 的启动命令，确认解释器存在且可执行 |
| `No module named aiortc` | 用同一个 `.venv/bin/python` 安装上面的 `./pipecat[webrtc]`，再运行 `pip check` |
| `incompatible architecture` / dylib 加载失败 | 核对 Node、Python 和动态库架构；若 `.venv` 是从 Intel 机器复制的，保留旧目录，重新创建 ARM64 venv；不要关闭系统安全机制 |
| 提示前端未构建 | 执行 `npm --prefix web/client ci` 和 `npm --prefix web/client run build` |
| npm 原生包缺失 | 核对 ARM64 Node 24；从锁文件重新 `npm ci`，不要修改锁文件来绕过校验 |
| Electron 下载失败 | 检查网络、代理、CA 信任以及 GitHub release/CDN 访问；不要跳过校验或关闭 TLS 验证 |
| 麦克风权限被拒绝或申请异常 | 查看系统设置 → 隐私与安全性 → 麦克风，确认 Electron/启动宿主归属，修改后重启；若 usage description/宿主权限问题仍在，记录为未通过，不擅自修改系统权限数据库 |
| 关闭窗口后菜单仍在 | macOS 预期行为，使用 Command+Q 真正退出 |
| 退出提示后端没有停止 | 记录 backend.log 的非敏感错误、PID/PGID 和上述端口检查；不要使用 `killall python` 影响其他应用 |
| 系统音频不可用 | Phase 1 预期限制，等待后续批准后的音频阶段 |
| `/api/*` 手动 curl 返回 403 | 本地 API 要求页面提供的访问令牌；这是原有安全边界，不要关闭令牌保护 |

## 7. 验证证据与后续门禁

Linux 云端已验证：95 项现有 Python 测试、24 项 Node 桌面测试、5 项前端路径/采集入口测试、
TypeScript/Vite 构建。桌面测试包含真实 Python stdlib HTTP 后端启停，以及使用
Electron double 的 macOS/Windows 主进程接线验证；double 不验证原生 AppKit/TCC。
Chromium 中还使用模拟 desktop bridge、真实构建页面及 FastAPI 验证 macOS/Windows
设置界面、目录选择桥接和权限/内容保护显示；这不等同于原生 Electron 验收。
另外通过 Electron 后端管理模块启动真实 FastAPI 服务，验证就绪检查、页面、本地 API
令牌边界和 POSIX 退出清理。

GitHub Actions 已实际执行 Ubuntu/Windows/macOS 基础自动化矩阵，但并非全部通过，
详见 [Phase 1 最终审核记录](macos-phase1-review.md)。本机测试与 CI 结果分别记录，不能相互替代。
用户已提供下节所列 M5 实机结果；Windows 实机 UI 与尚未完整验证的 Mac 项目仍保持待验收。
现有 Python 测试含模型替身，不代表 ONNX 模型、ASR 或 LLM 实际工作。

完成本阶段代码提交和 Fork PR 后停止。收到 M5 验收反馈并获准前不开始 Phase 2；
不自动合并 PR，不构建或公开分发 macOS 安装包。

## 8. M5 实机验收报告（用户提供）

记录日期：2026-11-09（Asia/Shanghai）。本节仅整理用户提供的真实结果，
不是云端代替用户执行的测试；具体测试时间、操作录像和原始日志未提供。
对应功能代码提交为 `a7527f1`，分支 `feature/macos-arm64`，Fork Draft PR #1。

### 测试环境

| 项目 | 用户提供的值 |
| --- | --- |
| 设备 | Apple Silicon M5 |
| macOS | 27.0.1 |
| Python | 3.12.14 |
| Node.js | 24.21.0 |
| Electron | 项目锁定 44.8.0；用户未单独提供运行时版本查询输出 |

### 已通过的实机项目

1. Electron 桌面应用成功启动，前端页面正常加载。
2. macOS 设置页显示麦克风、摄像头、屏幕录制权限状态。
3. 观察到的权限状态：麦克风已允许、摄像头尚未询问、屏幕录制已拒绝。
   这证明状态读取与显示可用，不证明录屏/系统音频采集可用，也不证明拒绝后重新授权流程通过。
4. 关闭窗口后应用保留在 Dock，点击 Dock 图标能恢复窗口；重复关闭与恢复操作正常。
5. Command+Q 正常退出应用。
6. 退出后未发现项目 Python 后端残留，开发端口 7870–7889 无残留监听。
7. 数据目录能调用 macOS 原生文件夹选择窗口。
8. 中文及空格路径的选择、保存、取消操作正常。

### 本机自动化结果

| 套件 | 结果 |
| --- | --- |
| Python | 95 passed，1 warning |
| Electron/Node 桌面测试 | 24 passed，0 failed |
| 前端 | 5 passed，0 failed |
| 合计 | 124 passed，0 failed |

用户报告 `audioop` DeprecationWarning 与 Node.js `MODULE_TYPELESS_PACKAGE_JSON`，
均未阻断上述本机测试。该结果不等同于全部原生手工验收或 GitHub Actions 全部通过。

### 部分通过与尚未完整验证

- 窗口生命周期部分通过：关闭、Dock 恢复和 Command+Q 已通过；原生全屏、最小化、
  窗口缩放等全部窗口操作尚未完整验证。
- 权限部分通过：状态读取和麦克风当前已允许已确认；麦克风拒绝及重新授权流程尚未完整验证。
- 启动过程中立即退出、连续启动时的单实例限制尚未完整验证。
- Windows 实机回归尚未执行。

没有提供上述未完整验证项目的子项结果，不能进一步拆分为已通过。
现有数据迁移、冲突拒绝、回滚与外置卷行为也没有提供新的实机证据；路径选择/保存通过
不应扩展为这些迁移场景通过。

### 已知限制与后续建议

- 保留 Phase 1 范围：macOS 系统音频、原生安装包、签名/公证、可靠防截屏均不标记为可用。
- 完整 CI 日志已确认 Windows 路径断言失败，以及 macOS 进程组探测 `kill EPERM`。
  macOS PR 桌面任务为 22 pass/2 fail，Windows 为 22 pass/1 fail/1 skipped，
  与本节用户报告的 M5 本机 124 passed 分开记录。另有异常后端恢复问题，详见审核记录；
  此前审核轮只记录问题；用户授权后的 H1/H2/M1 修复和新测试结果见审核记录，尚未在 M5 复测。
- 合并前先定位并解决 CI 失败，再补齐上述启动、权限与 Windows 验收，并复测获准的修复。
- 不自动将 Draft 改为 Ready for Review，不自动合并；等待用户确认后才决定后续工作。

## 9. 修复后的 M5 复测（待用户执行）

保留本地改动后，从 Fork 开发分支更新，不切换或修改 main：

```bash
git remote get-url origin
git fetch origin
git switch feature/macos-arm64
git pull --ff-only origin feature/macos-arm64
git log -1 --oneline
.venv/bin/python -m pytest -q
npm --prefix desktop test
npm --prefix web/client test
npm --prefix web/client run build
INTERVIEW_PYTHON="$PWD/.venv/bin/python" npm --prefix desktop start
```

如果本地存在个人改动，先自行保留，不执行 reset/强制覆盖。本轮云端为 95+35+5 项通过，
不要将它替换为用户旧 M5 124 passed 的实机结果；复测后另记新提交和环境。

1. 重复正常启动/退出、启动中立即 Command+Q，确认没有 EPERM 对话框或残留进程/端口。
2. 在无个人资料的测试数据目录中启动应用，用另一终端查看项目后端：

   ```bash
   ps -axo pid,ppid,pgid,command | rg 'server.py|Electron'
   lsof -nP -iTCP:7870-7889 -sTCP:LISTEN
   ```

   核对命令路径确为本项目的 Python 后端后，对那个 PID 执行 `kill -TERM <确认的PID>`，
   验证错误提示、旧页面停止请求、点击 Dock/菜单栏后可重新加载；恢复后的 Python PID 应变化，
   服务端口允许复用，不要求端口必然变化。不要使用 killall 或终止其他项目。
3. 分别在窗口打开、窗口关闭时模拟后端退出；连续点击 Dock/显示主窗口，确认始终只有
   一个恢复后端和一个主窗口，没有重复启动或继续加载旧服务。
4. 对确认的本项目 PID 单独模拟 `kill -KILL <确认的PID>`；再验证恢复、清理与 Command+Q。
   在恢复启动期间立即退出，不应重启或再弹异常退出提示。
5. 桌面测试中的真实进程用例覆盖忽略 TERM 后 KILL 和父子组清理；在 Mac 上执行并记录结果。
   如果出现状态无法判断/权限拒绝，保留非敏感错误、PID/PGID 和进程状态；不得用 sudo 或
   忽略错误来通过验收。
6. 补齐原生全屏/最小化/缩放、单实例、麦克风拒绝/重新授权；Windows 实机回归仍待执行。

完整功能覆盖范围、状态与下一阶段门禁见 [macOS 功能矩阵](macos-feature-matrix.md)。
上述只是待执行清单，不是实机通过声明。PR 仍保持 Draft，等待用户确认。
