# Lingutribe 开发总结（lingutribe）

> 本地优先（local-first）的英语学习工具。核心能力：听音频/看视频/读文章 → 自动转写文字 → 逐词查离线词典 + AI 解释 → 跟读/朗读（本地 TTS）→ 记单词、做笔记、问 AI。
> 仓库：`https://github.com/veritasian/lingutribe` （私有，初始提交 `5d7ac34`，作者 Andy `<keniskey@gmail.com>`，2026-08-04）

---

## 一、项目定位

Lingutribe 解决的是「学英语时想边听边查、想跟读、想把生词沉淀下来」的需求。它刻意做成**本地优先**：

- 语音识别（STT）、语音合成（TTS）、词典查询 **默认全部本地运行**，不需要把音频/文本上传到任何云服务；
- 唯一的云依赖是「可选」的 LLM 解释（可接本机 Ollama，也可接 OpenAI 兼容端点）；
- 用户数据（媒体文件、转写稿、单词本、笔记、对话）全部落在本地 `~/Documents/LingoLibrary`，数据库用单文件 `better-sqlite3`。

这套设计让它在断网、隐私敏感、或只想用自己显卡跑模型的场景下都能用。

---

## 二、技术栈

| 层 | 选型 |
|----|------|
| 前端 | React 18 + TypeScript + Vite 6 + TailwindCSS 3 + react-router-dom 6 |
| 后端 | Node.js + Express 4（`tsx` 直接跑 TS，免编译热重载）|
| 本地数据库 | better-sqlite3（WAL 模式，单文件 `lingo.db`）|
| 语音识别 | echogarden（Whisper，模型 tiny/base/small/medium/large 可选）|
| 语音合成 | Kokoro（本地神经网络 TTS，onnx）；另支持 Fish Audio / OpenAI 兼容端点作为可选项 |
| 离线词典 | MDict（`.mdx`/`.mdd`，如牛津 OALD8/9），无本地词典时用 LLM 兜底 |
| 桌面壳 | Electron 33（仅起一个子进程跑后端 + 开个 Chromium 窗口，不嵌入后端代码）|
| 音频/视频抓取 | yt-dlp（视频/播客链接）+ 内置 RSS 解析（播客直接拉音频+字幕）|
| 词频数据 | COCA/Nation & Crabbe BNC 词频表（`coca-bands.json`，运行时染色用）|

依赖通过 `package.json` 锁定；`data/` 内的 ML 模型（约 564MB）与 COCA PDF **不入库**（见第九节）。

---

## 三、整体架构

```
浏览器 / Electron 窗口
        │  HTTP + REST (/api/*)
        ▼
┌─────────────────────────────┐
│  Express 后端 (src/server)  │
│  index.ts  (路由 + 业务)    │
│  db.ts      (SQLite + 库路径)│
│  engines.ts  (STT/TTS/LLM)  │
└───────────┬─────────────────┘
            │  better-sqlite3
            ▼
   ~/Documents/LingoLibrary
   ├── lingo.db            (资源/单词/笔记/对话/设置)
   ├── audio/ video/ read/ (导入的媒体)
   ├── tts/                (勾选"保存音频"时落盘)
   └── dictionaries/        (用户放 .mdx/.mdd 词典)
```

- **开发模式**：Vite 跑在 `:5173`，`/api` 代理到后端 `:8787`（见 `vite.config.ts`）。
- **生产模式**：`vite build` 生成 SPA 到 `dist/`，Express 直接托管 `dist/` 并兜底 `index.html`——**单进程**即可同时提供页面与 API。
- **Electron**：`electron/main.cjs` 用 `spawn("npm", ["run","start"])` 起后端子进程，等 `/api/health` 起来后开窗口；若端口已被占用（比如你手动起的后端），它就不重复起，直接开窗口。原生模块（better-sqlite3、onnxruntime）因此跑在普通 Node 运行时，无需 `electron-rebuild`。

---

## 四、功能模块详解

### 1. 资源（Resources）：音频 / 视频
- 来源三种：**本地文件上传**、**视频链接**（YouTube 等，yt-dlp 拉媒体+字幕）、**播客 RSS**（直接抓音频 enclosure + transcript）。
- 转写：点「Transcribe」调用 echogarden/Whisper，产出整篇 `transcript` + 逐词时间轴 `words[{text,start,end}]`。
- 播放体验（`PlayerView`）：
  - 音频：内置 `<audio>` 控件 + 可折叠波形（`WaveformPlayer`，点击波形跳转）；
  - 视频：左播放器 / 右字幕的**可拖拽分栏**，窄屏自动竖向堆叠；
  - 倍速 0.5×–2×；**空格键**播放/暂停；波形随播放高亮当前词。
- 字幕区（`Transcript`）：逐词**按 COCA 词频染色**（1k 绿 → 6k+ 灰红），可单独隐藏某些频段；**点词**弹出右侧词典面板；**划词**弹出「Ask AI」浮层。

### 2. 阅读（Read）：文本/文章
- 导入本地 `.txt/.md` 或粘贴 URL（自动扒网页正文、解码 HTML 实体）；
- 内容区是 `contentEditable`，**改完 800ms 自动保存**；
- 「Read aloud」用 Kokoro 等 TTS 实时朗读（默认不落盘），并用 **CSS Custom Highlight API** 高亮「正在读的句子」+ 进度条（不破坏可编辑 DOM）；
- 右侧 Tab「Layout」展示该文的 **VocabProfile**（词汇分布/高频词）。

### 3. 右侧词典面板（WordPanel）—— 全应用复用
点任意词/划任意句，从右滑入，带三个 Tab：
- **Dictionary**：先查本地 MDict（牛津等），结构化解析出「词头 + 音标（BrE/NAmE）+ 发音按钮（取 .mdd 音频）+ 至多 2 个词性、每词性 2 条释义（英+中一行）+ 例句」；找不到本地词条时**自动回退 LLM 解释**（自带的双语词典 prompt）。支持**词形还原**（不规则表 + 规则后缀剥离），复数/过去式也能查到原型。
- **Grammar**：把选中句交给 LLM，按「句子结构 / 语法 / 词汇短语」三段式分析（prompt 可在设置里自定义，支持 `{L}`/`{N}` 占位符）。
- **Ask AI**：基于当前文章上下文的迷你对话，按 thread（如资源 id）持久化。
- 一键「+ Add to Words」收藏。

### 4. 单词（Words）
- 卡片网格展示收藏词，按 COCA 频段**过滤（1k/3k/5k/6k/6k+）**与搜索；
- 点卡片打开同一个离线词典面板（`dictOnly` 模式，只显词典）。

### 5. 对话（Chat）
- ChatGPT 风格多会话界面，驱动本地 LLM（设置 → LLM）；
- 会话存进 `notes` 表（body 存消息 JSON 数组），刷新不丢；
- 轻量 Markdown 渲染（标题/代码块/列表/加粗等）。

### 6. 设置（Settings）
分四类：
- **System**：主题（亮/暗/跟随系统）、UI 语言（中/英）、学习语言 & 母语、词库路径、磁盘占用进度条。
- **STT**：Whisper 模型选择 + 「Deploy locally」（下载模型）+ Test。
- **TTS**：引擎切换（Kokoro 本地 / OpenAI 兼容 / Fish Audio）；男声/女声选择；Kokoro 模型（量化 80MB / fp32 330MB）+ 一键部署；可保存**多套配置并拖拽排序**（置顶=默认）；可勾选「保存音频到磁盘」。
- **LLM**：引擎（Ollama / OpenAI 兼容）、Base URL、模型、API key；「Confirm」记录进历史（同样可拖拽排序、置顶默认）；自定义 Grammar prompt。每个配置**自带 key**（切换模型不会误用别人的凭证）。

---

## 五、关键实现细节 / 技术亮点

1. **模型路径重定向**：echogarden 在不同 OS 把模型放不同位置（macOS `~/Library/Application Support`，Windows 用 `APPDATA`）。`index.ts` 通过覆盖 `os.homedir()`（mac/Linux）或设 `ECHOGARDEN_APPDATA_DIR`（Windows），把 Whisper/Kokoro 模型统一收进 `<tool>/data/models`，并在首次启动时把旧位置的模型迁移过来。打包时可用 `LINGO_MODELS_DIR` 指向可写目录，避免写入只读包。
2. **离线词典解析**：`lookupWord` 用 js-mdict 读 `.mdx`，对牛津 OALD8/9 的 HTML 结构做精确解析（`<span class="n-g">` 核心义项、`<phon>` 音标、`sound://` 发音引用 → 映射 `.mdd` key 取音频），并严格限制「最多 2 词性 × 2 释义 × 2 例句」产出干净卡片，过滤掉 `★` 与重复。
3. **LLM/网络走 curl 子进程**：`engines.ts` 的 `curl()` 用 `execFile("curl", …)` 而非 Node fetch，自动继承系统代理，且用 `encoding:"buffer"` + `-w "\n%{http_code}"` 让**二进制音频（MP3/WAV）不被 UTF-8 破坏**，状态码从末尾单独解析。
4. **TTS 实时 vs 落盘**：朗读默认返回 `data:` base64 内联（不写盘）；勾选「保存」才写 `library/tts/` 并返回 `/api/audio/xxx` URL。
5. **URL 导入容错**：先试 yt-dlp；失败且是音频链接时回退 RSS 解析；再失败则扫描临时目录里最大的媒体文件；字幕（.vtt/.srt，含 YouTube「弹层堆叠」式字幕去重）解析成逐词时间轴。
6. **本地优先标识**：侧边栏底部常驻「100% local · no cloud」徽标，强调隐私定位。

---

## 六、目录结构（已入库部分）

```
lingo/
├── package.json / package-lock.json   # 依赖与脚本
├── vite.config.ts / tsconfig.json
├── tailwind.config.js / postcss.config.js
├── electron/main.cjs                   # 桌面壳（起后端子进程+开窗口）
├── docs/lingutribe-manual-zh.html           # 中文使用手册
├── public/                             # 静态资源
└── src/
    ├── server/
    │   ├── index.ts                    # 所有 REST 路由 + 词典解析 + 导入
    │   ├── db.ts                       # SQLite + 库路径管理 + 建表迁移
    │   └── engines.ts                  # STT / TTS / LLM 封装
    ├── shared/types.ts                 # 前后端共享类型
    └── web/
        ├── App.tsx / main.tsx / index.html / index.css
        ├── api.ts                      # 前端 API 客户端
        ├── pages/                      # Resources / Read / Words / Chat / Settings / Notes
        ├── components/                 # PlayerView / WordPanel / Transcript / WaveformPlayer /
        │                               #   VocabProfile / WordPanel / Icon ...
        └── lib/                        # coca（词频）、segment、locale（中/英）
```

> 注意：上面是**已推送到 GitHub 的源码**。运行期产物 `data/`（约 566MB，含 ML 模型、COCA PDF、`coca-bands.json`）、`node_modules/`、`dist/` 均被 `.gitignore` 排除，见第九节。

---

## 七、本地启动方式

```bash
cd lingo
npm install                 # 装依赖（better-sqlite3 需本地编译）

# 开发：后端 :8787 + 前端 :5173（用 Vite，需 --host 才能用 127.0.0.1 访问）
npm run dev                 # 同时起 server + web（concurrently）
# 或分开：
npm run dev:server          # 仅后端 tsx watch
npm run dev:web -- --host   # 仅前端（--host 绑定 0.0.0.0）

# 生产：构建 SPA 后单进程起服务（Express 托管 dist/）
npm run build
npm start                   # 访问 http://localhost:8787

# 桌面端
npm run app                 # Electron 窗口（内部 spawn npm start）
```

常用地址：后端 `http://localhost:8787`，Web UI `http://localhost:5173`。
首次用 STT/TTS 会按需从 HuggingFace 下载 Whisper / Kokoro 模型（需联网一次，之后离线）。

---

## 八、已推送状态（GitHub）

- 仓库：`veritasian/lingutribe`（**私有**）
- 提交：`5d7ac34` — "Initial commit: Lingo local-first language-learning tool"
- 作者：`Andy <keniskey@gmail.com>`（符合项目约定，非 bot 身份）
- 内容：33 个相关文件（src 21 个源码 + electron + docs + 配置 + 锁文件），无密钥泄露、无个人路径硬编码（`db.ts` 用 `os.homedir()` 可移植）
- 排除：`node_modules/`、`.venv/`、`dist/`、`data/`（566MB 运行数据）、`.DS_Store`

克隆后需 `npm install` 还原依赖；`data/` 的词库/模型需重新生成或下载。

---

## 九、明确不入库的内容（与代码分离）

| 内容 | 大小 | 原因 |
|------|------|------|
| `node_modules/` | — | 依赖，可 `npm install` 再生 |
| `.venv/` | — | Python 虚拟环境（仅 `extract.py` 用）|
| `dist/` | — | 构建产物 |
| `data/models/` | ~564MB | ML 模型（Whisper/Kokoro），下载即得 |
| `data/*.pdf` + COCA 原始文件 | 数 MB | 词频原始语料 |
| `data/coca-bands.json` | 268KB | 运行时词频表（可由 `extract.py` 重建）|
| `.DS_Store` ×3 | — | macOS 垃圾 |

即：**仓库只保留「能重建出工具的代码与配置」**，运行时大数据不进版本库，克隆后首次运行会自动建 `~/Documents/LingoLibrary` 并引导下载模型。

---

## 十、可作为后续方向（未做/可加强）

1. **真正的间隔重复（SRS）**：`words` 表已有 `level`/`reviewedAt` 字段，但还没做复习调度算法（如 SM-2），目前只是收藏。
2. **词典管理 UI**：`.mdx` 现在靠手动丢进 `dictionaries/` 目录，可加一个「词典列表 + 启用/禁用」界面。
3. **多词典合并**：目前取第一个命中的词典，可支持多本词典结果聚合/切换。
4. **移动端**：Electron 仅桌面；如需移动端可评估 Capacitor/Expo，但 STT/TTS 本地推理在手机上需换方案。
5. **CI / 发布**：可加 GitHub Actions 自动 `npm run build` + 打 Electron 安装包（macOS/Windows dmg/exe）。
6. **测试**：目前无自动化测试；`engines.ts` 的 curl 封装与词典解析是最值得补单测的部分。

---

*本文档基于 `lingo` 仓库初始提交（2026-08-04）的源码撰写，覆盖前端、后端、Electron 壳与离线优先设计。*
