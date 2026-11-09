# Phase 2.M3：首个实时面试端到端验收版本

基线为 `8a82380`。M2 已获用户确认的核心 M5 实测通过，具体证据见
[M2 报告](macos-phase2-media-stream.md#m2-核心-m5-验收通过用户反馈)。本次交付代码和可执行验收步骤，
不宣称真实供应商、完整 M3 或所有会议软件已通过。PR #1 仍 Draft，不合并。

## 审查结论与实际修改

M2 流符合现有接口，可以直接复用，不需要再造 WebRTC/供应商协议：

| 路径 | 现有调用链与归属 |
| --- | --- |
| 系统音频 | `captureSystemAudio()` → 原生 MediaStream → `SystemAudioMediaManager.setStream()` → `useLiveInterview.transportFactory` → `SmallWebRTCTransport` |
| 麦克风 | 独立 SmallWebRTC 默认 media manager；现有“采集麦克风”开关控制，无系统音频混入代码 |
| 信令 | 两路 `/start` requestData 都含 `transport: webrtc`，共享 `body.interviewId`；系统为 `body.mode=live`，麦克风为 `listen`，档案仅随 live 下发 |
| 服务端 | `server.bot()` → `create_transport()` → `run_bot()` → `transport.input()` → `build_stt()` → `TermCorrector` → 用户回合聚合器 |
| 回答 | live → `QaAnswer` 检索；高分命中允许直出类型时直接答，未命中/检索失败 → `GlossaryPrompt` → `build_llm()` → `TextOnlyOutput` → `LLMTextProcessor` → RTVI |
| 候选人 | listen 没有 LLM；UserTranscript 在前端标为 candidate，单独 interim 状态，不从 live 连接复用转写 |
| 历史 | 两个 SessionRecorder 共享 SQLite 会话；interviewer/interviewer_stt、candidate/candidate_stt、ai/qa 或 ai/llm 分别保存 |

查到并修复的缺口：

1. **准备期间取消缺少所有权**：`use-live-interview.ts` 原先只保存完成的 stream，停止无法取消待授权/初始化；
   晚到结果可能重新挂流。新增 `lib/live-capture.ts` 管理待完成与已完成采集，拒绝并发开始，旧结果主动 dispose。
   麦克风初始化结束后复查会话；旧初始化及清理完成后新一轮才可连接，避免串到新一场。
2. **过期 Console 继续连接**：卸载/音源 ended 后，原 `handleConnect` 仍可能在 await 返回后调用 connect 或触发旧错误回调。
   Console 用一次尝试的引用作同步锁及失效检查，卸载后不再启动/更新旧尝试。
3. **运行期供应商错误没有明确界面处理**：SDK 的非 fatal RTVI Error 未被应用消费。
   `use-pipecat-app.ts` 监听 Error，显示通用可操作提示、清理该 client；不回显供应商原始载荷。
   系统路失败由原 Console 错误回调停止两路，麦克风路失败明确显示麦克风错误、保留系统路。
   音源外部结束会显示安全提示并结束尝试，准备阶段也解锁；不把音源故障自动记成用户正常完成。
   该处理适用于共享客户端，包括 Windows 的服务错误；Windows loopback、采集与增益逻辑不变。
4. **预热任务覆盖、异常收尾遗漏**：`run_bot()` 原先 ASR warm_task 被 QA warm_task 覆盖，且 finally 只涵盖 runner.run。
   改为跟踪所有任务，在整个设置/运行作用域的 finally 中取消并 await；历史在 pipeline 停止后收尾一次，
   覆盖初始化异常、pipeline 异常、取消及正常断线，避免重复指标和遗漏部分回答。
5. **初始化错误输出**：对本次涉及的 ASR/LLM/配置错误日志复用 vendored Pipecat 的 `redact_secrets`；
   运行期 ErrorFrame 已有框架凭据脱敏。新增模拟凭据回显的回归；未读取/使用个人凭据。

不改供应商选择、模型、API 地址、业务提示词、原有检索规则/阈值、存储格式及历史时长规则。
干净 CI 实际报错 `ModuleNotFoundError: aiortc`：原 requirements 只装基础 Pipecat，未装已有 WebRTC 可选依赖。
补齐 `-e ./pipecat[webrtc]`，沿用 vendored 声明（aiortc/PyAV、opencv-python-headless）；没有新的供应商、付费依赖、驱动或采集权限。M2 的 48kHz/stereo/单位增益桥接保留；本轮没有新增音质 DSP。
SmallWebRTC 服务端默认把解码后的输入重采样为 16kHz mono；真实 Opus 音质、削顶与自然语音回合仍需 M5。

## 云端证据的边界

- Python 回归：103 passed（含新增 8 项）；桌面回归：54 passed；前端回归：13 passed；TypeScript/Vite 构建通过。
- `tests/test_live_webrtc.py`：3 个本机双路集成用例。真实 aiortc/SmallWebRTC、RTP/Opus、Pipecat、RTVI data channel、
  原有术语/QA/文本输出处理与临时 SQLite；48kHz 双声道合成输入，到模拟 ASR 前确认为 16kHz mono、非零。
  系统问题与候选人句子各写一次，live 有回答、listen 无回答；验证 QA 命中、未命中及检索异常回退，
  以及主动结束 completed 和断线 interrupted。服务是确定性的模拟 ASR/LLM，不证明真实识别或模型回答。
  此测试直接交换 SDP，**不覆盖浏览器 SDK 或 HTTP `/start` 信令**；其请求格式另有前端契约测试。
- `tests/test_live_lifecycle.py`：5 项设置/运行异常、取消、重复断开收尾、预热任务结束和模拟凭据脱敏回归。
- `web/client/tests/live-capture.test.ts`：准备取消、过期结果不污染新流、ended 监听清理、失效源，以及麦克风初始化跨会话隔离。
- Linux Chromium + 实际 React hook/AudioWorklet 的检查：模拟 native IPC，麦克风初始化期间停止、晚到初始化清理后重启；
  此时没有发出 startBot。模拟麦克风 RTVI Error 显示通用错误，系统 helper 保持，最后停止后清理。
  原生 helper 和麦克风设备/API 是替身，不作为实机双路证明。
  实际 Console 的准备期音源故障检查也通过：安全错误可见、disconnect 调用、没有 startBot、没有正常结束标记。
- Linux 冒烟：随仓库的 Silero VAD 和 Smart Turn ONNX 模型初始化成功；并非 M5 自然语音推理或准确率验证。
- 云端没有调用真实 ASR/LLM、没有个人 API Key、没有用户音频。GitHub Actions 按提交检查，不沿用旧 SHA 的全绿声明。
  首次 `3b4bd42` backend CI 在收集 WebRTC 测试时因缺 aiortc 失败；这是运行时依赖声明遗漏。补齐后的 `7365323`
  [backend CI](https://github.com/zhaoochunn/FUCKINTERVIEW/actions/runs/42647420440) 已通过。
  后续 `f4a9896` 的 push backend 通过，但 PR run `42647782423` 出现一次 `miss` 用例的 bot-output 断言失败：
  测试仅等待数据库已有答案就关连接，再检查客户端交付，存在真实的断言时序错误。
  修复为在原 12 秒上限内等待完整客户端答案与两路转写，再断开；增加固定 50ms 的客户端输出交付延迟以回归。
  不跳过、不放宽原角色/保存/输出断言；本地修复后 5 次重复合计 15/15 用例通过。
  `7365323` 桌面 CI 的 Ubuntu/Windows 已通过、macOS 尚排队；原生构建另看对应检查，未自动标为全绿。

## M5 更新与启动

沿用已通过 M2 的 Python 3.12、Node 24 环境和 helper。本次 Swift 源码未改，无需为 M3 强制重签 M2 二进制：

```bash
git fetch origin
git switch feature/macos-arm64
git pull --ff-only origin feature/macos-arm64
git log -1 --oneline
.venv/bin/python -m pip install -r requirements.txt
# 若已有 M2 helper，则保持原二进制/权限身份；缺失时才构建。
test -x desktop/native/macos-audio/build/SystemAudioProbe.app/Contents/MacOS/SystemAudioProbe || bash desktop/scripts/build-audio-probe.sh
.venv/bin/python -m pytest -q
npm --prefix desktop test
npm --prefix web/client test
npm --prefix web/client run build
INTERVIEW_PYTHON="$PWD/.venv/bin/python" npm --prefix desktop start
```

保留本地改动，不强制 reset；不要将设置、API Key、档案或录音提交到 Git。
只在现有设置界面检查自己的 ASR/LLM 供应商、模型、Key 和网络；无需把 Key 放入命令行或发给云端。
真实调用可能按已有供应商方案计费，由用户明确开始面试才触发；云端不代调用。

## 最小真实场景：先只开系统音频

1. 停止 M2 的本机检查，避免它占用唯一 helper。设置里暂时关闭现有“采集麦克风”开关。
2. 准备用户允许采集的浏览器语音，使用清楚的一段提问，例如：
   “请解释数据库事务隔离级别，并举一个可重复读的例子。”
   **先开始面试并确认连接就绪，再播放提问**，随后保留几秒停顿让 VAD/Smart Turn 判定回合结束。
3. 检查界面出现面试官转写，内容对应播放的语音；不能仅以 RMS 或 live track 判定 ASR 成功。
4. 检查流式答案逐步出现。问答库命中直出只证明 QA 分支；若要验 LLM，换一个未命中的独特提问，
   并在历史里确认回答 source=llm。不要为测试删除原条目或提高/降低阈值。
5. 本场持续至少 **70 秒**后点击正常断开（包含实际转写/回答）。现有业务规则会删除不足 60 秒的会话，
   因此短场不出历史不是 M3 保存成功或失败的充分证据；本轮没有改变这条规则。
6. 打开历史详情：检查 interviewer/interviewer_stt、ai/llm（或明确识别的 ai/qa）、答案内容、完成状态，
   再退出重启应用确认仍存在。只读新增测试场次，不删改个人历史/档案。
7. 停止后另一个终端执行 `pgrep -fl SystemAudioProbe`，预期数秒内无该 helper；再开始下一场确认可恢复。

可选的本地测试语音（只生成公开测试问题，不是录制采集内容；没有云端语音服务）：

```bash
/usr/bin/say -v '?'  # 先确认已安装的中文声音；没有 Tingting 时选择已有声音或使用自己的授权测试 WAV
M3_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fuckinterview-m3.XXXXXX")
/usr/bin/say -v Tingting -r 145 -o "$M3_TEST_DIR/question.aiff" '请解释数据库事务隔离级别，并举一个可重复读的例子。'
/usr/bin/afconvert -f WAVE -d LEI16@48000 -c 2 "$M3_TEST_DIR/question.aiff" "$M3_TEST_DIR/question.wav"
.venv/bin/python -m http.server 8765 --bind 127.0.0.1 --directory "$M3_TEST_DIR"
```

在浏览器打开 `http://127.0.0.1:8765/question.wav`，手动点击播放。`say`/`afconvert` 步骤本身也待 M5 执行；
若指定声音未安装，不自动下载声音/安装工具，使用已有可用声音或授权音频即可。测试后在该 HTTP 终端 Ctrl+C。

## 第二步：开启独立麦克风

先结束上一场，再开启“采集麦克风”。建议戴耳机，减少扬声器被麦克风物理重复收音；
代码隔离不能消除声学回声，会议软件的本地监听/回送也需单独测试。

- 播放带独特词语的系统问题，同时本人保持安静：应只有 interviewer 转写并触发回答。
- 暂停系统播放，自己说另一段独特句子（如“我主要负责订单服务的幂等设计”）：应只有 candidate，
  不通过候选人通道触发 LLM。不要求两路时间戳完全同步，但不得角色互换或每句无故重复。
- 同时发声作补充测试，确认两路都保留各自内容；历史同一 interviewId 下有不同 source。
- 持续至少 70 秒后正常结束，检查候选人文字、系统问题、AI 回复均保存且重启可读。
  若麦克风报错而系统路继续，记录为“系统路通过、麦克风路失败”，不能整体标通过。

## 异常与剩余验收

| 项目 | 真实 M5 操作/判定（均未预先标为通过） |
| --- | --- |
| 权限拒绝/撤销/恢复 | 系统设置手动操作；采集失败应停止 helper/流，显示错误，恢复授权后显式重启；不绕过 TCC |
| 外网或供应商网络断开 | 先停止个人工作，用测试场次断网；等待原供应商超时/错误；确认错误可见、相应通道停止，恢复网络后重新开始 |
| ASR/LLM 401、429、超时 | 不故意触发付费请求风暴；遇到实际错误记录状态/通道和泛化提示，不粘贴完整供应商载荷或 Key |
| 运行中/初始化中停止与重启 | 至少多轮；不得出现旧转写污染新场、重复 helper 或晚到的麦克风连接 |
| 页面切换、窗口关闭/Dock、Cmd+Q | 应停止采集/连接，源失败不偷偷重启；关闭窗口可能按 interrupted 收尾，不能当正常结束已验证 |
| 历史异常收尾 | 已有句子增量保存；部分 AI 输出尽力在 finally 收尾；硬杀进程不保证保存未收到的最后片段 |
| 设备/路由切换、最小化/后台 | 分别记录音频与连接表现，不推定已支持 |
| 60 分钟稳定与延迟 | 观察队列、丢包/欠载、漂移、CPU、内存与模型响应；短测不替代长期测试 |
| 会议软件兼容 | 应用/版本/输出设备逐一验收，不从浏览器通过推导支持所有会议软件 |
| 削顶/音质 | M1 peak>1 的实际分布、Opus 编码后音质和 ASR 影响仍需测量；未增添未验证的限幅策略 |
| Windows | 云端自动回归与实机运行分开；原生 loopback 未修改，实机仍需回归 |

验收反馈请提供 commit、系统/Python/Node 版本、供应商/模型名称（不含 Key）、通道开关、测试音源应用、
实际转写/流式输出/历史是否正确及错误发生阶段。可以用上面的公开测试句，避免上传个人通话、简历或原始音频。

M3 首个可验证版本交付后暂停，等待用户真实 API 与 M5 反馈，再决定下一轮修复/验收。
