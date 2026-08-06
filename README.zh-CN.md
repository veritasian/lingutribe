# Lingutribe 中文说明

> **本地优先的语言学习工具。** 离线语音识别、文本转语音、离线词典；可选的 LLM 用于深度讲解、语法和对话。

Lingutribe 是一个轻量、可自托管的英语学习助手。你把音频 / 视频 / 文本丢进去，它就帮你学：自动转写语音、逐句朗读、离线查词、和 AI 老师对话。凡是能本地跑的都本地跑，只有可选的 LLM 功能才需要联网。

## 最近更新

- **Transcript 双视图** — *Subtitle*（带时间戳行，点词即查词典）与 *Content*（正文段落，选中文字弹出 **Ask AI / Copy**）。字幕行按固定 ~5–10 秒分块、不重叠；正文合并为 ~25 秒段落。
- **STT 输出更干净** — Whisper/echogarden 偶发的"循环重复"（如 *…like I have this immense guilt towards I have this like…*）在服务端转写时与客户端展示时自动去重；已有字幕（如 YouTube 自带字幕）的资源不再重复转写。
- **保存的提示词（Saved prompts）** — 设置 → LLM 中提示词可保存历史；在 Ask 对话框输入 `/` 可展开并插入已保存的提示词（名称 + 内容）。
- **播放器头部** — Transcript / Statistics / Transcribe / Delete 变为图标按钮，与"点击切换倍速"的速度控制一起放在右侧；波形开关、面板关闭均为图标 + tooltip；右侧面板宽度可拖拽并记忆。
- **侧边栏与筛选** — 展开/折叠改为图标式并统一 hover 圆形样式；COCA 筛选栏固定不动，单词列表在其下方独立滚动。
- **安装包更小** — 未使用的 `kuromoji`（日语分词）与微软语音 SDK 已从 dmg 中排除（≈240 MB → ≈224 MB）；完全离线的 Whisper/Kokoro/Ollama 技术栈不变。
- **字幕体验** — 每行显示 `MM:SS – MM:SS` 时间区间（YouTube 风格），固定行高 + 局部平滑滚动（跟随播放进度）。
- **COCA 词形还原增强** — 缩略词（`I'm`、`it'll`、`gonna` 等）纳入 1K 区段；新增不规则变化（`went→go`、`children→child`、`men→man`）与更多派生规则。

---

## 一、这个项目是什么

Lingutribe 把"听、说、读、背、问"整合进一个本地应用：

- **Resources（素材）**：导入本地音频 / 视频，或粘贴一个视频链接，自动转写成文字。
- **Read（阅读）**：打开或粘贴英文文章，点任意一句就能本地朗读。
- **Dictionary（词典）**：选中一个单词，离线给出释义，查不到时回退到 AI 解释。
- **Words（单词）**：按 COCA 词频标注和筛选，优先攻克高频词。
- **Chat（对话）**：多轮 AI 辅导，带历史记录。

一句话：**一个不强制上云、数据留在自己电脑上的英语学习工作台。**

## 二、解决什么问题

| 学习痛点 | Lingutribe 怎么做 |
|----------|-------------------|
| 听不懂音频 / 视频 | Whisper 本地转写，配词级波形，可拆分、变速、空格播放 |
| 不会读、发音没反馈 | Kokoro 本地 TTS，点句子即朗读，完全离线 |
| 生词不认识 | 离线 MDict 词典 + AI 兜底解释 |
| 没人答疑 / 纠音 | 可接 Ollama 或 OpenAI 兼容接口的 AI 导师 |
| 隐私顾虑、不想数据上云 | 核心功能全本地；只有你主动配置的 LLM 才联网 |
| 工具太多、来回切 | 资源 / 阅读 / 词典 / 单词 / 对话一处搞定 |

## 三、功能特性

- **素材导入** — 本地音视频或 URL；Whisper 自动转写、词级波形、拆分合并、变速、空格播放。
- **阅读跟读** — 粘贴或打开文本，自动保存；点句子本地朗读（Kokoro）。
- **词典面板** — 选中单词得离线 MDict 释义 + LLM 兜底（语法、提问、词形还原）。
- **单词管理** — COCA 词频着色与过滤，聚焦高频词。
- **AI 对话** — 多会话导师，历史持久化。
- **引擎设置** — STT / TTS / LLM 多配置可拖拽排序，本地优先、云端兜底。
- **桌面端** — 可选 Electron 外壳，把同一套服务包成原生应用。

## 四、技术栈

| 层 | 选型 |
|----|------|
| 前端 | React + Vite + Tailwind + TypeScript |
| 后端 | Express + `tsx` + better-sqlite3 |
| 语音识别（STT） | echogarden（Whisper，本地） |
| 语音合成（TTS） | Kokoro（本地）/ Fish Audio / OpenAI（可选云端） |
| 词典 | MDict 词库（离线）+ LLM 兜底 |
| 桌面端 | Electron |
| 媒体抓取 | `yt-dlp` / `curl`（系统二进制） |

## 五、如何安装

### 方式一：从源码运行（推荐）

```bash
git clone https://github.com/veritasian/lingutribe.git
cd lingutribe
npm install

# 开发模式（Web UI 在 :5173，API 在 :8787）
npm run dev

# 生产模式（构建一次，之后在 :8787 提供完整应用）
npm run build
npm start

# 桌面端（Electron 外壳，包住同一个服务）
npm run app
```

打开 **http://localhost:5173**（开发）或 **http://localhost:8787**（生产）即可使用。

### 架构与端口

- **开发模式** — 两个进程、两个端口：Vite 开发服务器（React + HMR）在 **5173**，Express API 在 **8787**；Vite 把 `/api/*` 代理到 8787。开发时 **8787 会实时镜像 5173**（Express 把前端页面代理给 Vite），所以 **两个端口永远显示同一份最新界面**，开发期无需手动 `npm run build`（Vite 未启动时自动回退到 `dist/`）。
- **生产模式** — 一个进程、一个端口：Express 同时托管 `dist/` 里构建好的前端与 API，统一在 **8787**（`npm run build && npm start`）。
- **桌面端（dmg）** — Electron 主进程直接 `import()` 预编译的服务端（`dist-server/index.mjs`），API 就跑在 **Electron 主进程内部**（单进程，没有独立的服务进程）。只监听 **8787，完全不占用 5173**。如果 8787 已被占用（比如 dev 服务在跑），app 会直接复用已有服务，不再启动自己的实例。

**系统要求**
- Node.js 18 或更高（推荐 20+）。
- 可选：`yt-dlp` / `ffmpeg` 系统二进制，用于抓取网络媒体；没有也能正常使用本地文件。

### 第一次打开就能用什么（无需下载任何模型）

界面、数据库、素材浏览、阅读（纯文本）、单词、对话历史、设置，在 `npm install` 之后都能直接用。**装完即可启动，不用等模型下载。**

---

## 六、模型会自动安装吗？

**会，而且是"按需下载、缓存后离线"。** 首次用到某个功能时，echogarden 才从 HuggingFace 拉取对应模型包并缓存，之后完全离线可用。

### 三个核心模型（及下载链接）

| # | 用途 | 包名 | 大小 |
|---|------|------|------|
| 1 | 语音识别 STT（Whisper） | `whisper-tiny-20231126` + 必需的 `whisper-tiktoken-data-20240408` | ≈225 MB + ≈1.6 MB |
| 2 | 语音合成 TTS 模型（Kokoro） | `kokoro-82m-v1.0-quantized-20250209` | ≈88 MB |
| 3 | 语音合成 TTS 音色库（Kokoro voices） | `kokoro-82m-v1.0-voices-20250209` | ≈27 MB |

> 想要更高精度时：Whisper 还可选 `base` / `small` / `medium`；Kokoro 另有 `fp32` 版。默认 tiny + quantized 已足够日常。

**下载基础地址（二选一）**

- 官方源：`https://huggingface.co/echogarden/echogarden-packages/resolve/main/{包名}.tar.gz`
- 国内镜像：`https://hf-mirror.com/echogarden/echogarden-packages/resolve/main/{包名}.tar.gz`（把上面域名里的 `huggingface.co` 换成 `hf-mirror.com` 即可，国内更易连通）

**直接可用的四个链接**

- `https://huggingface.co/echogarden/echogarden-packages/resolve/main/whisper-tiny-20231126.tar.gz`
- `https://huggingface.co/echogarden/echogarden-packages/resolve/main/whisper-tiktoken-data-20240408.tar.gz`
- `https://huggingface.co/echogarden/echogarden-packages/resolve/main/kokoro-82m-v1.0-quantized-20250209.tar.gz`
- `https://huggingface.co/echogarden/echogarden-packages/resolve/main/kokoro-82m-v1.0-voices-20250209.tar.gz`

（把链接里的 `huggingface.co` 换成 `hf-mirror.com` 即为国内镜像链接。）

### 下载不成功时：手动安装模型

适用于：网络访问不了 HuggingFace，或自动下载总失败。

1. 用上面的链接（**建议用 `hf-mirror.com` 镜像**）手动下载对应的 `.tar.gz`。
2. 解压，你会得到一个**以包名命名的文件夹**，例如 `kokoro-82m-v1.0-quantized-20250209/`。
3. 把该文件夹**整体复制**到 echogarden 的模型包缓存目录：
   - **macOS**：`~/Library/Application Support/echogarden/packages/`
   - **Windows**：`C:\Users\<你的用户名>\AppData\Local\echogarden\packages\`
   - **Linux**：`~/.local/share/echogarden/packages/`
4. 重启应用，即可离线使用，无需联网。

> 注意：包名文件夹必须**完整且名字完全匹配**（例如 `kokoro-82m-v1.0-quantized-20250209`），不要改名、不要只把里面的文件平铺出来。
> Whisper 需要把 `whisper-tiny-20231126` 和 `whisper-tiktoken-data-20240408` 两个包都放进去，缺一不可。

### 用设置页预下载（更省心）

不需要命令行也能准备模型：打开 **设置 → 引擎 → 部署（Deploy）**，可提前拉取 Whisper（tiny / base / …）和 Kokoro（quantized / fp32）。首次使用某功能时也会自动下载。

---

## 七、如果"软件本身"下载 / 安装不顺利

Lingutribe 目前以**源码方式**分发（没有预编译的安装包），所以"下载软件"= 拿到仓库源码。以下几种情况都有对策：

### 1. `git clone` 慢或被墙（GitHub 连不上）

- 用 GitHub 代理克隆：
  ```bash
  git clone https://ghproxy.com/https://github.com/veritasian/lingutribe.git
  ```
- 或一次性给 git 配置代理（之后所有 github.com 都走代理）：
  ```bash
  git config --global url."https://ghproxy.com/https://github.com/".insteadOf "https://github.com/"
  ```
- 或去 `https://github.com/veritasian/lingutribe` 点 **Code → Download ZIP** 手动下载（网页打不开时，给地址加 `https://ghproxy.com/` 前缀再访问）。

下载到本地后，解压进入目录，照常 `npm install` 即可。

### 2. `npm install` 慢 / 失败（npm 源被墙）

把 npm 源切到国内镜像：

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

装完照常 `npm run dev` / `npm run build && npm start`。

### 3. 想要桌面应用（不用命令行）

仓库里没有发布好的 `.dmg` / `.exe`。从源码启动桌面端：

```bash
npm install
npm run app
```

Electron 会拉起同一个本地服务并打开原生窗口。若要制作可分发的安装包，需要额外的打包步骤（如 `electron-builder`），可按需自行配置。

---

## 八、离线词典（MDict）怎么装

右侧词典面板使用 **MDict 离线词库（`.mdx`）**。本项目**不捆绑任何词库文件**，词库由用户自行提供，属于运行时数据，已排除在仓库之外。

- **放哪**：把你的 `.mdx`（以及配套的 `.mdd`，如果有）放进资料库目录下的 `dictionaries` 文件夹 —— 默认 `~/Documents/LingoLibrary/dictionaries`（本地开发版为 `data/models/Library/dictionaries`）。应用每次查词都会重新扫描该目录，放入新文件**无需重启**。
- **没有词库也能用**：查不到的词会自动回退到已配置的 LLM（设置 → 引擎 → LLM），所以不装词库也完全可用。
- **版权提示**：牛津 / 朗文 / 柯林斯 / 韦氏等高质量商业词典均为版权作品，其 `.mdx` 转换物**不得再分发**。请使用你合法拥有的词库，或免费开源词库（如基于 Wiktionary 的 MDict 版本）。
- **推荐词典下载**：社区维护的 MDict 词典汇总站 [`https://mdx.mdict.org/`](https://mdx.mdict.org/)，可自行挑选你合法拥有或免费开源的词库下载（请遵守上面的版权提示）。
- 那 564 MB 的 `data/models/Library` 文件夹其实是 **echogarden 的模型缓存（Whisper + Kokoro）**，不是词典数据。

---

## 九、可选：LLM 功能怎么接

AI 导师、语法检查、以及"查不到词时的词典兜底"都依赖 LLM。在 **设置 → 引擎 → LLM** 里配置：

- **Ollama**（本地、免费）：填 `http://localhost:11434`，模型如 `llama3`。
- **任意 OpenAI 兼容接口**：填 base URL + 模型名 +（可选）API Key。

这些引擎不下载任何本地文件，但需要网络和你的凭据。

---

## 十、目录结构

```
lingutribe/
├── src/
│   ├── server/        # Express API + better-sqlite3 + echogarden 引擎
│   │   ├── index.ts      # 服务入口（启动 + 资源/导入路由）
│   │   ├── db.ts         # SQLite + 资料库路径
│   │   ├── engines/      # 按引擎拆分：stt / tts / llm / models / http
│   │   ├── routes/       # 薄 HTTP 层：settings、words、notes、chat、
│   │   │                 # engines（STT/TTS/LLM 端点）、dict（MDict）
│   │   ├── analysis.ts   # 媒体分析（时长、波形、分段）
│   │   ├── segments.ts   # 词/段计时类型与辅助
│   │   └── util-ffmpeg.ts# ffmpeg 探测/工具
│   ├── web/           # React 前端（页面 + 组件）
│   │   ├── components/ # PlayerView、Transcript、Caption、AudioBar、VocabProfile…
│   │   └── lib/       # coca.ts（词频段）、segments.ts（计时）
│   └── shared/        # 共享 TypeScript 类型
├── electron/          # 桌面端外壳（main.cjs — 打包时内嵌服务端）
├── docs/              # 用户手册（中文 HTML）
├── package.json
└── vite.config.ts
```

> **不在仓库内**：`node_modules/`、`.venv/`、`dist/`、`dist-electron/`、`data/`（运行时词库 + 模型缓存，约 566 MB）、`.DS_Store`。详见 `.gitignore`。

## 许可证

参见仓库 LICENSE 文件。
