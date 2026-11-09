# Phase 2.M2：PCM → MediaStream 桥接验收

本次只交付可独立验证的桥接，不执行完整 ASR/LLM 端到端验收，不安装驱动，不改 Windows loopback。
PR #1 保持 Draft。M1 的 M5 核心采集证据（25/25 轮）记录在
[原型报告](macos-phase2-audio-prototype.md#m5-实机核心采集结果用户提供m2-开始前)，不能直接当作 M2 通过。

## 数据路径与权限边界

```text
Swift ScreenCaptureKit（48kHz / stereo Float32）
 → stdout 版本化 PCM 协议（匿名管道）
 → Electron 主进程格式/序号/PTS 校验 + 有界 IPC
 → sandbox preload 的固定 nativeAudio API
 → AudioWorklet 双声道环形缓冲
 → MediaStreamAudioDestinationNode
 → captureSystemAudio() / CapturedSystemAudio
 → 既有 SystemAudioMediaManager（仅用户主动开始实时面试后使用）
```

- Swift 新增 `--continuous`（只允许管道 PCM 模式），直到停止或权限/采集错误；M1 有限轮次默认行为保留。
- 主进程只接受当前本地应用 Origin、当前主窗口、mainFrame 的请求，固定 helper 路径；
  不允许网页指定可执行文件、参数、IPC 通道或接收其他窗口音频。会话 token 隔离启动/ACK/停止。
- 一次只允许一个 helper，包括停止中的状态；停止等待真实 close，TERM 超过 4 秒后 KILL，
  6.5 秒仍未 close 报错，禁止在旧进程未收回时再启动。
- 权限查询/申请属于独立 helper 的 TCC 身份，不把 Electron 的屏幕权限当作 helper 已授权。
  只有点击本机检查或开始实时面试才启动 helper 并请求权限，不后台启动，不自动反复请求。
- 本轮仅支持源码运行、原生 ARM64、48 kHz 双声道；安装版接口禁用。helper 的装包、签名与公证仍在后续阶段。
- 麦克风仍走原有独立会话，本桥接不调用 getUserMedia，不合并两路、不连接扬声器节点。
  扬声器到麦克风的物理声学回声、耳机/蓝牙路由仍需后续双路实测。
- 本机检查不创建 SmallWebRTC/ASR/LLM 连接。原始 PCM 不写文件、不记录日志、不上传；只显示聚合指标。
  只有用户主动启动原有实时面试才将 MediaStream 交给原有 transport；本轮不把该端到端链路标为通过。

## 缓冲、时钟与音量

- 输入固定校验 48 kHz/stereo/f32le/有限样本；序号缺口、PTS 倒退或帧时长不连续超过 2ms 明确失败。
  不用包到达的系统时间代替 PCM 的 PTS。大于阈值的跳变不靠插入伪造语音掩盖。
- 主进程最多 8 个未获 Worklet ACK 的包、24000 帧未确认数据；ACK 必须匹配 owner/token/sequence。
  超限直接停止，避免 renderer 卡顿时无限复制 PCM。
- Worklet 环形缓冲最多 24000 帧（500ms），2048 帧预缓冲（约 42.7ms）；缺数据填零并记录 underrunFrames、
  重新预缓冲；溢出、NaN/Infinity 明确报错。ACK 表示数据已入环形缓冲，不是已播放或已上传。
- 本轮要求实际 AudioContext 为 48 kHz，其他采样率明确失败，因此不私自降采样/改变播放速度。
  硬件时钟与 WebAudio 时钟的长期漂移、设备切换和更低延迟需要 M5 长时间测量；当前仅有界缓冲，
  不声称已有自适应重采样或达到 P95 延迟目标。WebRTC 编码阶段的浏览器重采样另验。
- 启动后 30 秒未取得 PCM，或采集中 15 秒无有效 ACK 时停止报错；有全零 PCM 的静音可以继续，
  完全没有 PCM 则不当作健康会话。
- 原生路径保持单位增益，保留 Float32 超过 ±1 的有限样本。Windows/浏览器原有高通、自动增益和压缩器保持原样。
  不对 M1 的 peak>1 未经测量加入限幅/归一化。统计 input/Worklet peak、overRangeSamples 和
  MediaStream RMS/maxMediaPeak；后续整数转换、单声道混合、WebRTC 编码可能削顶，仍待实测。
- 每次停止清空/释放 Worklet、轨道、AudioContext、事件订阅和 helper。renderer 崩溃、主框架导航、
  macOS 关闭窗口、后端异常退出、Command+Q 也会触发主进程清理。权限/运行时错误通知 source ended，
  复用原有实时面试断连处理；不自动重连或偷偷重启录音。

## 主要文件

| 文件 | 范围 |
| --- | --- |
| `desktop/native/macos-audio/Probe.swift` | 连续模式，原有权限/停止机制复用 |
| `desktop/electron/native-audio.js` | helper 管理、IPC 来源校验、背压及异常清理 |
| `desktop/electron/native-pcm-protocol.js` | 移入打包会包含的 electron 目录；原型脚本保留兼容导出 |
| `desktop/electron/main.js`, `preload.js` | 生命周期挂接和受限 API |
| `web/client/public/native-pcm-worklet.js` | 有界双声道 FIFO 与聚合指标 |
| `web/client/src/lib/native-audio.ts`, `capture.ts` | PCM → MediaStream，复用采集入口 |
| `web/client/src/components/native-audio-check.tsx` | 设置中的 30 秒本机检查，不创建 transport |
| 桌面/前端测试 | 协议、进程、IPC、环形缓冲、生命周期、取消与错误路径 |

## M5 更新、构建与启动

使用已完成 Phase 1 的 Python 3.12/Node 24 环境。先保留个人改动，不强制覆盖：

```bash
git fetch origin
git switch feature/macos-arm64
git pull --ff-only origin feature/macos-arm64
git log -1 --oneline
uname -m
xcrun swiftc --version
bash desktop/scripts/build-audio-probe.sh
npm --prefix desktop test
npm --prefix web/client test
.venv/bin/python -m pytest -q
npm --prefix web/client run build
INTERVIEW_PYTHON="$PWD/.venv/bin/python" npm --prefix desktop start
```

需要本机 Xcode 命令行工具，缺失时执行 `xcode-select --install`；本轮不增加 npm/Python 依赖。
必须重新构建 helper：旧 M1 二进制不认识 `--continuous`。重建 ad-hoc 应用可能影响 TCC，
如需授权请按系统提示/设置处理，不修改权限数据库、不关闭 SIP/Gatekeeper。

## 独立桥接实机验收（先不点击开始实时面试）

1. 播放允许采集的浏览器/本地测试音频，打开设置中 macOS 权限区域。
2. 点击 **开始本机音频检查**；按需允许系统录制权限。检查持续最多 30 秒，也可点击停止。
3. 记录显示的 JSON：trackState 应 live、contextSampleRate=48000，observations/nonSilentObservations 持续增长，
   mediaStreamRms 与 maxMediaPeak 非零，worklet.renderedFrames 增长；记录 bufferedFrames、underrunFrames、
   peak、overRangeSamples。仅 track=live 不构成有声证明。第一秒前可能尚无 worklet 聚合统计。
4. 对照暂停音源/恢复播放，观察 RMS；不先把结果写成通过。没有声音时不能靠轨道存在判定成功。
5. 停止后重启至少 20 次，包括在授权/初始化阶段立即停止。不能出现重复 helper、旧会话污染或持续占用录制指示器。
6. 检查窗口关闭与 Dock 恢复、Cmd+Q、权限拒绝/撤销/重新授权、renderer 崩溃/重载、后端退出后的清理。
   测试可能影响当前会话，先停止工作并保留资料；后端故障注入可先只观察错误路径，具体故障命令另行记录。
7. 可在另一个终端仅查看进程元数据（不采集音频）：

   ```bash
   pgrep -fl SystemAudioProbe
   ```

   检查运行时应有一个 helper；停止后数秒应无该 helper。不要把其他项目 Python 进程一并杀掉。
8. 记录 commit、系统版本、播放应用/版本、输出设备、权限归属及聚合结果；不提供音频文件或个人通话内容。
   各会议软件、蓝牙/USB/耳机、60 分钟漂移/延迟与 CPU 测量仍需独立验收。

失败排查：helper 启动失败先重建并运行 M1 `--permissions`；持续拒绝检查系统设置与启动宿主；
`Expected 48 kHz stereo`/时间戳跳变/背压错误请保留错误文字和聚合结果，不降低断言或关闭安全机制。
浏览器直接打开页面不会获得原生接口；必须通过 Electron 启动。源码版 helper 不作为正式安装包发布。

## 证据与待验

- Linux 云端：Python 95 passed（audioop 警告 1 条），桌面 54 passed，前端 8 passed，TypeScript/Vite 构建通过。
- 新增桌面测试覆盖 IPC 权限、token/ACK、包丢失/格式/时钟、背压、TERM→KILL/未退出错误、重复启动，
  Worklet 环形缓冲、超量程样本原样保留及退出清空；main 测试覆盖关闭/导航/renderer/后端退出到 controller 的调用链。
- 前端测试覆盖共同采集入口、首包 ACK、停止轨道清理、初始化取消、启动失败、运行错误与 ended 通知。
- Linux Chromium 实际 AudioWorklet + MediaStream 的合成 PCM 检查通过：非静音、live track、停止清理。
  设置检查组件的真实按钮路径也用合成源验证了启动、停止、重复启动和模拟运行错误。
  合成输入 peak 1.1000000238 在 Worklet 与 MediaStream 仍为该值；没有经过 WebRTC 编码，不能据此证明最终无削顶。
- 模拟/合成证据不代表 M5 TCC、原生 IPC 传输调度、连续 helper 或真实系统音频已集成通过。
  **本轮 M2 的 M5 桥接测试、权限拒绝/撤销、Ctrl+C、静音对照、会议软件兼容性与完整 ASR/LLM 均待验。**
- GitHub Actions 结果随提交核对；已有 desktop-platform 不会编译 Swift。新增原生 ARM64 编译 workflow
  此前持续 queued、无 runner 分配，不能以旧 M1 实测替代新连续模式的编译/实测证据。

桥接里程碑提交后暂停，等待用户 M5 反馈，再安排完整双路 SmallWebRTC / Pipecat / ASR / LLM 验收。
