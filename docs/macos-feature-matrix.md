# macOS ARM64 完整功能矩阵与实施门禁

目标设备：Apple Silicon M5，用户已报告 macOS 27.0.1。macOS 实际可用性优先，Windows
兼容作为次要回归目标；不主动删除现有 Windows 功能。所有代码继续在 Fork
`zhaoochunn/FUCKINTERVIEW` 的 `feature/macos-arm64` 开发，PR #1 保持 Draft。

## 扫描范围与状态定义

基线为 Fork main `7e82f0b` 与当前开发分支，不将其他上游版本的功能推定为此基线已有。
扫描 desktop/electron、desktop/scripts、app、server.py、内置 Pipecat、web/client/src 及 CI。
矩阵逐项区分可运行的业务入口、SDK 通用组件/未接线代码和用户新增目标，避免把文件存在当作功能完成。

- **M5 部分验证**：仅限用户报告的旧功能提交 a7527f1，不扩展到后续修复或其他场景。
- **保留/待验**：代码已有，尚无真实 macOS 端到端验收证据。
- **待移植**：平台能力尚未接通；Phase 1 只给出明确不可用提示。
- **新增目标**：在当前基线未找到该功能的完整实现，仍纳入最终目标。
- **基础件**：代码存在，但不是当前实时面试端到端能力。

## 功能矩阵

| ID / 功能 | 实际代码依据与当前状态 | macOS 实现方式/系统边界 | M5 验收标准 |
| --- | --- | --- | --- |
| A1 系统音频 | lib/capture.ts、main.js、use-live-interview.ts；Windows loopback 已有，Mac 待移植 | 优先 ScreenCaptureKit 原型，与 Electron 44 CoreAudio Tap 对照；必要时 Swift helper；不把 Windows loopback 当作 Mac 实现 | 已授权/拒绝/取消/撤权均正确；真实 PCM 非静音；连续 60 分钟，设备切换和采集停止可恢复 |
| A2 候选人麦克风 | use-live-interview.ts 的 listen 会话、InterviewAudioCheck、DeviceSelect；保留/待验 | getUserMedia + TCC，独立于系统音频；沿用 SmallWebRTC | 分别转写候选人/面试官、不串路、不重复；内置/USB/蓝牙设备切换、拒绝后授权通过 |
| A3 双路会话与连接 | lib/session-request.ts、SystemAudioMediaManager、server.py run_bot；保留/待验 | 同一 interviewId、两条 WebRTC；本机无 STUN 默认路径；重连与清理联动 | 20 次启停、断网/恢复、单路失败无另一条残留；结束时历史正确合并 |
| A4 音量/增益/可视化 | capture.ts WebAudio、audio-visualizer、visualizer.ts；保留/待验 | 复用高通/限幅与增益，避免重复 AGC；原生桥接采样率需明确 | 安静/大音量/静音正常，无削顶或反馈；单独测量采集延迟与 CPU |
| A5 设备枚举/偏好/PTT | app-device-dock、preferences.ts、user-audio-control.ts；组件/保留待验 | 复用设备选择；PTT 是窗口 KeyboardEvent，不等同 OS 全局快捷键 | 已接线入口设备选择与偏好重启保留；焦点/输入控件/PTT 释放不误触发 |
| B1 ASR 供应商 | app/providers.py build_stt；Qwen、MiniMax、Deepgram、OpenAI；保留/待验 | 保持服务实现和网络协议，按供应商安装可选 SDK；密钥由用户本地填写 | 每个声明支持的供应商真实语音识别、中文术语、超时/401/限流与重试有可理解状态 |
| B2 LLM 流式答案 | providers.py build_llm、materials_ai.py、server.py；保留/待验 | 保持 OpenAI 兼容、Qwen、Anthropic 适配；不改无关提示词业务 | 真实问题到首字/完整答案，取消不中断下一轮；对每个声明支持的供应商测试 |
| B3 VAD/Smart Turn | server.py _shared_*、pipecat/audio；保留/待验 | ARM64 ONNX CPU 优先；保留流内独立状态；验证模型资源打包 | 真实模型推理、轻声/句中停顿/连续问题；双路并发无状态污染 |
| B4 问答命中与术语纠错 | server.py QaAnswer/TermCorrector/GlossaryPrompt；保留/待验 | 保持命中原文直出、未命中走 LLM、术语提示和纠错 | 已知命中/未命中/别名测试，不误改候选人原话；历史记录和显示一致 |
| B5 TTS/机器人音频 | app/services/qwen_tts.py、providers.py build_tts、BotAudioOutput；基础件 | 当前 live/listen 管线不用 TTS（server.py 注释与处理器链）；若后续恢复语音模式，独立设计开关和反馈隔离 | 仅在模式被正式接通后验收生成/播放/中断；不把文本回答通过等同 TTS 通过 |
| C1 主窗口/菜单/Dock/托盘 | main.js、platform.js、WindowControls；M5 部分验证 | 原生窗口与菜单，Dock/菜单栏恢复；AppKit 全屏/Spaces 需实测 | 补测最小化、全屏、缩放、Spaces、多显示器；已通过关窗/Dock/退出不覆盖全部 |
| C2 后端生命周期 | main.js、backend.js、process-lifecycle.js；本轮修复待 M5 复测 | 独立进程组、TERM→KILL；EPERM 状态核查；异常退出先清理再串行恢复 | 正常/启动中退出、崩溃、组长退出但后代存活、恢复中退出；无旧端口/子进程残留 |
| C3 单实例/开发数据隔离 | main.js requestSingleInstanceLock、userData/sessionData；部分待验 | 保持单实例与 dev/production 目录边界 | 连续启动仅一个后端；现有窗口恢复；不读写正式版数据 |
| C4 悬浮答题窗 | 当前 main.js 只有主窗口；**新增目标** | 后续轻量 BrowserWindow/面板复用答案状态，受控 IPC；是否跨 Spaces 单独验证 | 显示实时答案、与主窗同步、可恢复位置、多屏和关闭行为明确 |
| C5 窗口置顶 | 未发现 alwaysOnTop/setAlwaysOnTop；**新增目标** | Electron always-on-top；全屏/其他应用/Spaces 存在层级限制 | 普通窗口、全屏会议、多屏分别验证；明确不能覆盖的场景 |
| C6 窗口透明度/鼠标穿透 | 未发现 setOpacity/setIgnoreMouseEvents；**新增目标** | 独立设置与持久化，保留可操作恢复入口；不把 CSS opacity 当窗口能力 | 透明度范围、可读性、焦点/交互、重启恢复；不可把用户锁在无法操作的状态 |
| C7 快捷键 | 菜单 Command+Q/Ctrl+Q、组件键盘事件已有；OS 全局控制**新增目标** | 后续 globalShortcut 注册/冲突检测，按需评估系统权限；不默认申请辅助功能 | 前后台、输入法、冲突、睡眠恢复、释放注册；不窃取常见编辑快捷键 |
| D1 截图/截图问答 | 未发现 capturePage/截图保存/截图分析端到端入口；**新增目标** | 若需要捕获屏幕，由用户明确触发、授权和选择范围；视觉 LLM 是额外业务接线 | 授权/取消、选区/多屏、临时数据清理；不上传未选择内容 |
| D2 录屏/屏幕共享 | user-screen-control.tsx、user-video-control.tsx 等 SDK 基础件；不等于完整录屏产品 | 当前系统音频入口的低帧率视频仅维持采集会话，不代表本地录像；Mac Phase 1 display handler 拒绝 | 后续逐项确认共享/录像是否为目标；启停、授权、输出、轨道释放分别验收 |
| D3 防截屏/防录屏 | Windows setContentProtection；Mac 开关隐藏 | macOS 无法承诺阻止 ScreenCaptureKit/所有会议软件采集；NSWindowSharingNone 不可靠 | 建立系统截图/录屏/具体会议软件共享矩阵；只标记测得效果，不给“绝对防截屏”承诺 |
| D4 摄像头/通用视频 | UserVideoControl 与 Pipecat transport 的基础件；权限状态可读，实际未验 | 只有确认产品入口后请求摄像头；不因查询状态自动授权 | 接线后的预览/断开/设备占用/拒绝与恢复；不能由尚未询问状态推定可用 |
| E1 模型下载/缓存/重建 | app/qa_index.py、settings-dialog、storage model_dir；保留/待验 | FastEmbed 按需下载；现有默认 hf-mirror；清晰展示失败/重试和关键词降级 | 空缓存下载、断网、损坏/只读缓存、自定义中文路径；不把 fallback 当向量推理通过 |
| E2 模型推理/资源 | ONNX Silero/Smart Turn/FastEmbed，numpy/soxr/soundfile/aiortc/PyAV；待原生验证 | 固定发布依赖集合，检查 arm64 Mach-O 与 dylib/rpath；不依赖 Rosetta/Homebrew | 无开发工具干净 Mac 真推理与检索；模型缺失错误明确，性能/内存和长稳通过 |
| E3 全模型管理器/离线 ASR/LLM | 目前仅供应商/模型名配置和 embedding 模型缓存，不是完整本地模型管理产品 | **新增目标（如最终需要）**：模型清单/下载取消/校验/删除和离线推理引擎独立评估；不把在线模型名当本地文件 | 每个声明离线支持的模型下载/加载/释放/磁盘不足/校验/版本升级分别验收 |
| F1 档案/简历/JD/经历卡/教练 | app/materials*.py、profile-flow/coach-panel；保留/待验 | 复用现有 CRUD、整合/规划/生成、教练问答与应用卡片 | 建立档案→生成/编辑→保存→重启→实时提示链；缺 Key/网络错误可恢复 |
| F2 问答库导入/管理/检索 | app/qa.py、qa_import.py、qa_index.py；保留/待验 | 保留 CSV/XLSX/Markdown 预览、提交/撤销、编辑/批删、FTS+向量/RRF | 中文/别名/重复项/编码、导入撤销、持久化；关键词与向量各自验收 |
| F3 术语库/模板/纠错历史 | app/terms.py、terms-library；保留/待验 | 复用模板开关/重置、批量解析、别名、最近纠错 | 模板切换、录入、纠错、历史、重启保持一致 |
| F4 资料库/阅读器 | app/documents.py、documents-page、PDF/Markdown viewer；保留/待验 | 保留上传/重命名/删除/预览；PDF worker、字体/CMap/WASM 随构建 | 中文文件名、PDF/Markdown、大小限制、缩放/触控板、删除与重启；不推定 PDF 属于 QA 导入格式 |
| F5 历史/转写/统计 | sessions.py、session_recorder.py、history-page、首页热力图/模型用量/延迟；保留/待验 | 保留统一会话、两路转写、答案/纠错、用量和图表 | 开始/结束/异常断开、跨日、重复结束、历史详情和统计一致；不把转写记录说成原始音频录像 |
| F6 设置/界面偏好 | config.py、settings-dialog、preferences/theme/i18n、布局存储；M5 部分验证 | 复用供应商、模型、Key、语言、主题、布局、采麦开关；敏感设置不进入代码/日志 | 修改保存/重启、多语言主题、密钥不泄露；已验目录保存不等同所有设置通过 |
| F7 数据目录/迁移/恢复 | storage_migration.py、fsutil.py、SQLite WAL、native picker；选择保存已验 | 保留冲突预检/快照/回滚；选择路径不等于迁移完成；考虑 APFS 大小写/外置盘 | 真实测试样本迁移、同目录、目标冲突、磁盘满/断开/中途退出与恢复，不覆盖个人原件 |
| F8 本地安全/权限/日志 | security.py、url-policy.js、desktop-services.js、MacOSPermissions；部分已验 | 保持回环绑定、token、精确 Origin、主 frame IPC、TCC；日志脱敏 | 非应用 origin/iframe/无 token 拒绝；Key/简历不进包/CI；权限拒绝和恢复可理解 |
| G1 自包含 .app/.dmg | scripts/build-backend.py、release-check.py、package.json 当前偏 Windows；待移植 | macOS ARM64 runner 构建独立 CPython/依赖与原生 helper，electron-builder mac/dmg | 用户无 Python/Node/Homebrew 可安装启动；可写数据外置、无绝对路径/开发者数据，卸载升级行为明确 |
| G2 签名/公证/Gatekeeper | 当前无 mac 发布流水线；待实施 | Developer ID、嵌套运行时与 helper 签名、最小 entitlements、notarize/staple | 真下载 quarantine 安装、离线 ticket、首次权限、升级；不要求关闭 SIP/Gatekeeper |
| G3 Windows 回归/CI/授权 | 已有 NSIS、backend/platform workflow；待新修复 CI/实机复测 | 保留 Windows 现有行为，Mac 优先；检查项目整体及模型/依赖/BlackHole 授权 | Mac/Windows/Linux 分别标 passed/skipped；授权未明确前不公开分发 |

以上依据路径除 desktop/app/server 外，前端文件均位于 web/client/src。其余 Pipecat 可选服务、
未注册的通用 transport loader、DTMF/机器人视频等代码按基础件管理，不推定为本项目已启用功能。
例如 index.tsx 显式 noDTMF，server.py live/listen 只提供当前面试处理链。后续每次发现新增入口，
补充矩阵 ID、调用链、验收及状态，避免遗漏。

## 阶段实施顺序

1. **Phase 1 修复门禁**：H1/H2/M1 自动化和 CI，补充 M5 崩溃恢复/强制退出/单实例/权限测试。
   旧 M5 124 项结果保留，修复后的结果另记，不自动视为通过。
2. **Phase 2：采集方案定案**：在真实 M5 上对照 ScreenCaptureKit 与固定 Electron 的 CoreAudio Tap，
   记录 TCC、是否能获得真实系统音频、应用过滤、自身输出排除和延迟；优先无额外驱动。
   Swift helper 用独立进程隔离；版本化 PCM 协议包括格式、时间戳、序号、背压、停止和错误。
   通过受控本地通道/AudioWorklet 接入 MediaStream，保留当前双路 SmallWebRTC/ASR/LLM。
   原型门禁：明确最低 macOS、授权/拒绝/撤销、真实音频、20 次启停、设备切换、60 分钟稳定。
   采集桥接新增延迟先以 P95 ≤100ms 为目标，实测后定版；不把在线模型网络延迟计入采集延迟。
   BlackHole 只作用户明确选择的备选，安装、路由和授权分别验证，不自动安装驱动。
3. **Phase 3：全功能与桌面体验**：先完成实时双路链和所有业务页端到端验收，再增加 C4–C7
   悬浮/置顶/透明/全局快捷键；D1/D2/E3 新目标先确认产品行为，不假设已有实现。
   对截图/共享/模型管理与防截屏分别给能力边界和实测证据，不以 UI 开关代表系统能力。
4. **Phase 4：自包含 ARM64 打包**：CPython、原生依赖、模型资源、helper、读写目录和干净机测试。
5. **Phase 5：签名、公证与发布验收**：授权、凭据、Gatekeeper 与真实安装升级测试；只有用户批准后发布。

## 当前结论

完整功能矩阵是移植范围与验收计划，不是完成声明。用户已确认 Phase 1 当前验收门禁通过，
并授权 [Phase 2.M1](macos-phase2-audio-prototype.md)：独立 ScreenCaptureKit 原生 PCM 原型与验证器。
原型代码不等于 M5 实机通过，现有系统音频 MediaStream/ASR/LLM 工作流仍未接通。
系统音频、悬浮/置顶/透明度、全局快捷键、安装包与可靠防截屏均不标记已可用。
矩阵目标全部保留；等待原型 M5 验收后再获准进入后续音频接线里程碑。
