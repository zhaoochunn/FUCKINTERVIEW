# Phase 2.M1：原生系统音频采集原型与验证接口

本里程碑仅实现独立采集原型，不修改 Electron 主程序、浏览器采集入口、麦克风、SmallWebRTC、
Pipecat、ASR/LLM 或会话历史。Windows 原流程保持不变。Phase 1 已由用户确认通过当前门禁，
未执行的异常注入等场景不因此改为通过。PR #1 保持 Draft，不自动合并/发布。

## 方案评估与选择

项目实际固定 Electron **44.8.0**。该版本[官方采集说明](https://github.com/electron/electron/blob/v44.8.0/docs/api/desktop-capturer.md#macos-versions-142-or-higher)
指出：macOS 14.2+ 默认桌面音频后端为 CoreAudio Tap，需要 `NSAudioCaptureUsageDescription`；
从终端/IDE 启动时宿主的 plist 也可能影响权限；失败不会自动回退旧录制权限路径。
同版本 [session 文档](https://github.com/electron/electron/blob/v44.8.0/docs/api/session.md#sessetdisplaymediarequesthandlerhandler-opts)
仍把 `audio: "loopback"` 参数标为仅支持 Windows。不能以已有音轨对象证明 Mac 真采集可用。

| 方案 | 本里程碑判断 | 验证边界 |
| --- | --- | --- |
| ScreenCaptureKit | 选择独立 Swift helper，直接拿 CMSampleBuffer PCM，清楚控制格式/时间戳/启停 | 在 macOS SDK 原生编译；真实浏览器/会议声音及 TCC 行为待 M5 |
| Electron CoreAudio Tap | 已核对固定版本文档，保留后续对照路线；不是本里程碑已验证的替代实现 | 后续需在带正确 plist/签名身份的宿主上实测，不靠禁用安全机制或直接复用 Windows 参数 |
| BlackHole | 不安装、不依赖；仅作为后续明确选择的兼容备选 | 安装、路由与授权须另行确认 |

选择独立 helper 是为了先隔离原生 API 与现有业务，不是宣称 ScreenCaptureKit 对所有应用或系统版本都可用。
源码目标为 macOS 13+、arm64；最低系统版本的完整兼容性没有实机验证。主要目标是用户 M5 macOS 27.0.1。

## 实现与边界

- `desktop/native/macos-audio/Probe.swift`：ScreenCaptureKit、权限检查、每轮独立 SCStream、音频输出及清理。
- `Info.plist`：独立开发身份 `com.fuckinterview.system-audio-probe.dev`，包含音频用途说明；
  不申请麦克风、摄像头、辅助功能，不增加系统驱动。
- `desktop/scripts/build-audio-probe.sh`：用本机 Xcode SDK 构建 ARM64 `.app` helper 并 ad-hoc 签名/验证。
  这是本地开发产物，不是可分发安装包、Developer ID 签名或公证。不要删除 quarantine、关闭 Gatekeeper/SIP。
- `desktop/scripts/audio-probe.js`：启动 helper、在内存解析并验证 PCM，只打印聚合统计。
- `audio-probe-protocol.js`：版本化帧协议与独立验证器，后续可作为桥接参考，本轮未接 MediaStream。

过滤器采用第一块 display 的系统采集范围，音频混合由 ScreenCaptureKit 提供，排除 helper 自身音频。
只注册 `.audio` 输出，不输出/保存视频帧；底层配置使用极低视频尺寸/帧率，不代表无需屏幕录制权限。
不指定或枚举用户应用名，不保证所有浏览器、会议软件、受保护内容或输出路由都可采集。
对每个会议软件必须用应用/版本/输出设备单独记录，不能以浏览器播放通过推定全部会议软件支持。

音频请求 48kHz、双声道；实际数据按 ASBD 校验 Float32 PCM，并把 planar/交错缓冲统一为
**interleaved f32le**。报文携带实际采样率、声道、帧数、递增序号、CMSampleBuffer PTS 纳秒及
单独的 arrival host-time 纳秒字符串。没有把两种时钟当同一时钟或承诺跨进程端到端延迟。
不在本里程碑降采样到 ASR 输入格式。

协议：`u32be JSON长度 + UTF-8 JSON(v=1) + u32be PCM长度 + PCM`。
header 最大 16KiB、PCM 最大 256KiB/包。控制事件为 permission/cycle-start/cycle-stop/complete/error。
原生写队列最多 16 个包，背压时计数丢包而不无限缓存；验证器检测序号缺口/丢包并拒绝通过。
Node 逐包校验长度、格式、有限样本和递增 PTS，报告 RMS、peak、audioSeconds、nonSilentPackets。
`--require-signal` 要求每轮有非静音 PCM（默认包 RMS ≥0.001），且每轮至少收到 min(duration/2,1) 秒 PCM。
这证明收到有能量的数据，不证明语音可识别、音源正确或会议软件兼容；仍须用户控制音源对照验证。

## M5 准备与构建

在项目根目录、原生 ARM64 Terminal 执行。保留本地个人改动，不强制覆盖：

```bash
git fetch origin
git switch feature/macos-arm64
git pull --ff-only origin feature/macos-arm64
git log -1 --oneline
uname -m
sw_vers
xcode-select -p
xcrun swiftc --version
bash desktop/scripts/build-audio-probe.sh
```

若没有命令行工具，执行 `xcode-select --install` 并完成系统安装后再构建。
`uname -m` 应为 arm64。产物在已忽略的
`desktop/native/macos-audio/build/SystemAudioProbe.app`；脚本只写该构建目录，不动用户资料。
预期输出 `Built local development probe: ...`，随后可检查：

```bash
lipo -archs desktop/native/macos-audio/build/SystemAudioProbe.app/Contents/MacOS/SystemAudioProbe
codesign --verify --strict desktop/native/macos-audio/build/SystemAudioProbe.app
```

预期架构 arm64，签名验证退出码 0；这不是 Gatekeeper/公证验收。

## 权限：查询、请求、拒绝与撤销

查询不会弹授权框：

```bash
node desktop/scripts/audio-probe.js --permissions
```

预期 `{ "permission": "granted" }` 或 `denied-or-not-determined`。
CoreGraphics 的布尔查询不能精确区分尚未询问与已拒绝，不伪造细分状态。
用户明确触发请求：

```bash
node desktop/scripts/audio-probe.js --permissions --request-permission
```

在系统授权提示中按意愿选择。在系统设置 → 隐私与安全性 → 屏幕与系统音频录制（名称随版本变化）
查看 SystemAudioProbe/Terminal/启动宿主；真实归属需要 M5 记录，不能预设一定显示哪一个。
拒绝后不会自动循环弹框，后续可在设置中修改；已允许仍返回 false 时退出原型并重启宿主后复查。
重建本地 ad-hoc 程序可能影响 TCC 身份，需重新确认；不要修改系统权限数据库。

采集中每秒复查已知屏幕录制授权，不自动再次请求。已知撤销或 SCStream delegate 错误会停止并报告错误；
若 OS 仍返回 granted 但输出变静音，不能凭静音断言撤权，验证器会报告缺少 PCM/非静音数据。
权限拒绝/撤销、错误码和资源释放需要在 M5 实测，CI 不申请这些权限。

## 真实音频验证（不接任何 ASR/LLM）

1. 只播放你允许采集的本地音频或浏览器测试内容，持续覆盖整个测试时长。无需 API Key。
2. 执行：

   ```bash
   node desktop/scripts/audio-probe.js --duration 10 --cycles 3 --require-signal
   ```

3. 成功应退出码 0，JSON 含 permission=granted、complete=true、3 轮统计；每轮 frames>0、
   audioSeconds 达标、nonSilentPackets>0、peak>0、droppedPackets=0、missingPackets=0，采样率/声道实际显示。
   数值取决于真实数据，不提供伪造的实测数值。无声/无 PCM/时间戳倒退/数据无效/背压会非零退出。
4. 对照暂停播放/静音来源后复测，确认非静音统计随实际音源变化。静音不是采集成功的充分证据。
5. 重复启停：

   ```bash
   node desktop/scripts/audio-probe.js --duration 1 --cycles 20 --require-signal
   node desktop/scripts/audio-probe.js --duration 10 --cycles 2 --require-signal
   ```

6. 测试时按 Ctrl+C：runner 发 TERM，等待原生 stopCapture，最长 4 秒后强制结束未退出 helper。
   输出 cancelled=true，退出码 130，不计为完整通过；随后再次启动应成功。
7. 采集中在系统设置撤销权限，记录错误/停止表现，恢复授权并重启再测。分别验证浏览器、目标会议软件、
   内置扬声器/耳机/蓝牙/USB 路由。不要在未经参与者同意的通话中测试。

`--duration` 范围 1..60 秒，`--cycles` 1..20，`--min-rms` 可显式设置阈值；不要通过降低阈值
把静音当作成功。runner 有总时限与失败清理。PCM 仅通过匿名管道在内存流转，最终只打印统计，
没有音频文件、转写、网络上传或供应商调用。不要直接将 helper 的 `--pcm` 输出重定向为日志；
它是二进制音频协议，直接输出到 TTY 被拒绝。原生默认不带 --pcm 时只输出控制元数据。

## 云端验证与 M5 验收记录

Linux 可执行协议/PCM 合成缓冲单元测试及原项目回归，但没有 Swift、macOS SDK、TCC 或真实系统音源。
新增 `macos-audio-prototype` CI 在实际 ARM64 macOS 上编译、签名验证、确认 Mach-O 架构及无效参数拒绝，
并执行协议测试；不自动授权录音、不采集 CI 音频，不把合成输入当作真实声音。

```bash
node --test desktop/electron/audio-probe.test.js
npm --prefix desktop test
.venv/bin/python -m pytest -q
npm --prefix web/client test
npm --prefix web/client run build
```

本轮 Linux 云端已通过：Python **95 passed**（audioop 弃用警告 1 条）、Electron/协议 **44 passed**、
前端 **5 passed**、Vite 构建成功。新增 5 项测试使用合成 PCM，不是系统音频实测。
代码提交 `67f78e9` 的 [desktop-platform CI](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42635987334)
在 Ubuntu、Windows、macOS 三平台通过；[backend CI](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42635987209) 通过。
新增 [原生 ARM64 构建任务](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42635987179)
检查时仍为 queued，runner 尚未分配，**Swift 编译与 helper 签名尚未获得通过证据**；
已有桌面 CI 不会编译 Swift，因此不能替代这一验证。后续提交的 CI 应以对应 SHA 的实际结果为准。

待 M5 提供：commit/系统/Swift 版本、授权归属、每轮统计、是否非静音、20 轮启停、Ctrl+C 后重启、
拒绝/撤销/恢复、测试应用版本与输出设备、进程残留观察。**目前没有 M5 原型实测通过声明。**
原型验收前不接入 MediaStream、麦克风双路、Pipecat/ASR/LLM 或历史记录；通过后再提交下一里程碑计划。


## M5 实机核心采集结果（用户提供，M2 开始前）

环境：Apple Silicon M5、macOS 27.0.1。用户未在本次反馈中指定精确测试 SHA 或 Swift 版本，
因此不将此证据归到后续 M2 的连续采集/IPC 改动。

| 实际测试 | 用户报告结果 |
| --- | --- |
| Swift ScreenCaptureKit helper 构建 | 编译成功 |
| 最终权限状态 | granted |
| 10 秒 × 3 轮 | 成功 |
| 1 秒 × 20 轮 | 成功 |
| 10 秒 × 2 轮 | 成功 |
| 合计 | 25/25 轮完成，每轮均有非静音 PCM |
| 实际格式 | 48 kHz，双声道 |
| 完整性 | missingPackets=0、droppedPackets=0、complete=true |
| 幅度观察 | 个别 peak 略高于 1.0，具体峰值和分布未提供 |

这些是真实核心音频采集结果，不是合成测试。**权限撤销、Ctrl+C、静音对照、会议软件兼容性
仍未执行，不标为通过**。麦克风/ASR/LLM/编码后音质也未因此获得验收。
此前“等待 M5”段落是 M1 初次交付时的历史状态，本节为后续用户反馈。

Float32 PCM 可以表示超过 ±1 的有限样本；混音或上游增益可能造成超量程。
仅凭峰值不能判断波形已削顶，也无法证明是 helper 引入的失真。M2 保持原始样本的单位增益，
分别测量原生/Worklet 峰值、超过 ±1 的样本数及 MediaStream 的 RMS/峰值；暂不增加归一化、
硬裁剪、限幅器或自动增益。后续 WebRTC 编码、单声道混合、整数格式转换处仍有削顶风险，
需用已知信号与实际语音测量后决定处理策略，不以此说明编码后的音质已合格。

用户已授权 [Phase 2.M2 桥接里程碑](macos-phase2-media-stream.md)，本次仅接线并等待新的 M5 验收。
