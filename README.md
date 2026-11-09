<p align="center">
  <img src="desktop/build/icon.png" width="112" alt="FUCKINTERVIEW logo" />
</p>

<h1 align="center">FUCKINTERVIEW</h1>

<p align="center">
  实时语音面试助手：听懂面试官的问题，结合你的简历与问答库，给出可以直接说出口的回答。
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4" />
  <img alt="Python" src="https://img.shields.io/badge/Python-3.11%2B-3776AB" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F" />
</p>

---

FUCKINTERVIEW 是一个本地运行的桌面端面试辅助工具。它采集系统音频里的面试官提问，经语音识别转成文字，再结合你准备的面试档案、问答库与术语库生成回答，并以文字实时显示。数据、模型与 API Key 都留在本机。

## 安装

### Windows 安装包

从 [Releases](https://github.com/hu-qi-jia/FUCKINTERVIEW/releases) 下载最新的 `FUCKINTERVIEW-Setup-<版本>.exe`，双击安装。如果 Releases 中还没有可用的安装包，按下方「从源码运行」自行构建。

首次启动会让你选择**数据目录**和**模型目录**（可直接跳过，之后在「设置 → 通用设置」里随时更换）。进入应用后打开「设置 → 模型配置」，填入 ASR / LLM 的 API Key 即可开始使用。

- 数据默认保存在 `%APPDATA%\FUCKINTERVIEW\data`，卸载应用不会删除
- 实时面试依赖 Windows 环回音频，需要 Windows 10 2004 及以上
- 从旧版本「面试语音助手」升级时，首次启动会自动把旧数据复制到新目录，旧目录保留

### 从源码运行

需要 Python 3.11+、Node.js 20+：

```bash
git clone https://github.com/hu-qi-jia/FUCKINTERVIEW.git
cd FUCKINTERVIEW

python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

npm --prefix web/client install
npm --prefix web/client run build

npm --prefix desktop install
npm --prefix desktop start
```

只想在浏览器里使用（不启动桌面端）：

```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe server.py
```

打开 <http://localhost:7860/>。macOS / Linux 把 `.venv/Scripts/python` 换成 `.venv/bin/python`。

自行打包 Windows 安装包：

```bash
npm --prefix desktop run dist
```

产物在 `desktop/dist/FUCKINTERVIEW-Setup-<版本>.exe`。

## macOS 开发（Phase 1）

Apple Silicon 源码开发环境、启动命令、测试与 M5 验收清单见
[macOS Phase 1 开发说明](docs/macos-phase1.md)。当前仅适配桌面基础功能，
macOS 系统音频采集、原生安装包及可靠防截屏能力尚未提供。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面端 | Electron 44（无边框窗口、托盘常驻、系统音频环回、防截屏） |
| 前端 | React 19 · TypeScript · Vite · Tailwind CSS · Pipecat React SDK |
| 后端 | Python 3.12 · FastAPI · Pipecat 语音管线（SmallWebRTC 传输） |
| 语音处理 | Silero VAD · Smart Turn v3（本地 ONNX 推理） |
| 模型服务 | ASR：Qwen / MiniMax / Deepgram / OpenAI Whisper<br />LLM：任意 OpenAI 兼容接口 / Qwen / Anthropic |
| 本地检索 | SQLite FTS5 + `BAAI/bge-small-zh-v1.5` 向量检索（ONNX，无需 PyTorch） |

<p align="center"><sub>Built with Pipecat · © 2026 hu-qi-jia</sub></p>
