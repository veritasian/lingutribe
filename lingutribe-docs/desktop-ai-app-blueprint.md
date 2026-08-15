# 桌面 AI 工具架构蓝图（Desktop AI App Blueprint）

> 本文档由 lingutribe v0.1.0（Electron + Express + React + Vite，本地优先的语言学习工具）的实战架构沉淀而成。
> 适用场景：**本地优先 + AI 能力（TTS/STT/LLM）+ 媒体/文本处理 + 桌面分发** 的一类工具。
> 用法：作为模板直接复制骨架，按下方「从 0 到 1 检查清单」逐阶段落地。

---

## 1. 场景判断：这套架构适合什么

### 1.1 什么时候用这套架构（选这套）

- 需要**本地模型**（离线可用）、**隐私优先**（数据不出本机）、单机工具。
- 核心能力已有 **Node 生态库**（echogarden / onnxruntime-node / better-sqlite3 / ffmpeg 子进程）。
- 需要**桌面分发**（dmg/安装包），且未来可能加云同步/多设备。
- 想要**前端技术栈开发效率**（React/Vite 生态）同时拿到 Node 的系统级能力。

### 1.2 什么时候别用

| 场景 | 选型 | 原因 |
|---|---|---|
| 包体积/内存敏感、核心是纯 UI + 少量系统集成 | **Tauri 2**（Rust 侧载） | 包小 10 倍、内存低；但 Node 生态库要么重写要么 FFI，成本高 |
| 纯在线工具、无桌面分发需求 | Web 应用（Vite SPA + 云 API） | 不需要壳层与本地模型 |
| 需要多用户/账号体系/服务端协作 | 前后端分离远程部署 | 本地优先的假设不成立 |
| 核心模型只有 Python 实现 | Python 后端 + 打包，或 FastAPI 侧服务 | Electron 调 Python 子进程也可以，但增加部署复杂度 |

**决策规则**：先问「核心 AI/媒体能力有没有成熟的 Node 库」——有 → Electron 方案；没有且必须 Rust 性能 → Tauri + 原生模块；都没有 → 考虑 Web。

---

## 2. Tech Stack（技术栈清单）

| 层 | 推荐选型（lingutribe 验证） | 为什么 | 备选 |
|---|---|---|---|
| 编程语言 | **TypeScript 全栈** | server + web + shared 共享类型，一套心智；`src/shared/types.ts` 前后端复用 | Rust（Tauri 路线） |
| 桌面壳 | **Electron 33**（内嵌 Node 20） | 直接 import Node 服务端代码；native 模块生态全 | Tauri 2 |
| 服务端框架 | **Express 4 + cors + multer** | 轻量、无状态、`register(app, ctx)` DI 友好 | Fastify（需要更强插件体系时） |
| 前端 | **React 18 + react-router-dom 6 + Vite 6 + Tailwind 3** | 生态最大、组件复用成熟 | Vue 3 / Svelte |
| 服务端打包 | **esbuild**（`--bundle --format=esm --packages=external`） | 秒级打包；native 模块 external 不打包 | tsup / rollup |
| 数据库 | **better-sqlite3**（同步 API、WAL、单文件） | 零配置、事务简单、本地工具最优解；`journal_mode=WAL` | SQLite + knex（ORM 需求时） |
| 本地语音 | **echogarden**（封装 Kokoro TTS / Whisper STT） | 一个库覆盖 STT+TTS+对齐，模型自动下载管理 | sherpa-onnx |
| 本地 ML | **onnxruntime-node** | ONNX 模型跨平台推理（词频分类、标点、向量化） | transformers.js |
| LLM 接入 | **OpenAI 兼容协议**（`/chat/completions`） | ollama（本地）/ DeepSeek / 任意云 API 统一接口，**换供应商只改配置不改代码** | 各家原生 SDK |
| 网络层 | **undici（Electron 下必须锁 6.x！）+ EnvHttpProxyAgent** | Node 内置 fetch 的底层；代理感知（HTTP(S)_PROXY），国内网络必需 | node-fetch（已弃用） |
| 网页清洗 | **jsdom + @mozilla/readability** | 新闻 URL 导入时只保留正文，去广告/导航/侧栏/页脚 | cheerio（无 JS 执行，弱） |
| 离线词典 | **@divisey/js-mdict** | 直接读 .mdx 词典文件，离线查询+发音 | 自建词表 JSON |
| 媒体处理 | **ffmpeg**（平台感知定位/捆绑）+ wavesurfer.js + pitchfinder | 转码、波形、基频分析 | fluent-ffmpeg |
| Dev 编排 | **concurrently + tsx watch** | 双进程热更新 | npm-run-all |
| 打包分发 | **electron-builder + electron-rebuild** | dmg/安装包、native ABI 重建 | electron-forge |

---

## 3. 目录结构模板（复制即用）

```
<tool>/
├── electron/
│   └── main.cjs                  # 壳层：单实例锁 · server 启动/健康握手 · 开窗 · userData 重定向
├── src/
│   ├── server/
│   │   ├── index.ts              # boot：中间件 + 路由注册 + 静态托管（纪律：< 400 行）
│   │   ├── db.ts                 # 数据层唯一入口：SQLite(WAL) 单例 + 库路径 + 迁移 + 目录规划
│   │   ├── analysis.ts           # 业务服务（分析、转写后处理）
│   │   ├── segments.ts           # 领域逻辑（字幕/分段/对齐）
│   │   ├── util-ffmpeg.ts        # 平台感知的 ffmpeg 定位
│   │   ├── engines/              # 引擎层：一引擎一文件，< 300 行
│   │   │   ├── http.ts           #   统一网络出口（代理感知）
│   │   │   ├── stt.ts            #   语音转写
│   │   │   ├── tts.ts            #   语音合成（本地/云端多供应商）
│   │   │   ├── llm.ts            #   大模型对话（OpenAI 兼容协议）
│   │   │   ├── models.ts         #   本地模型 ensure/下载/校验
│   │   │   └── index.ts          #   barrel：对外导入面稳定
│   │   └── routes/               # 薄 HTTP 层：register(app, ctx)，只做解析/校验/回包
│   │       ├── resources.ts  import.ts  dict.ts  engines.ts
│   │       ├── settings.ts  words.ts  notes.ts  chat.ts
│   ├── shared/
│   │   └── types.ts              # 前后端共享类型（Resource/Word/Note/Settings…）
│   └── web/                      # 前端 SPA
│       ├── main.tsx  App.tsx  api.ts  index.css  index.html
│       ├── pages/                # 路由级页面
│       ├── components/           # 复用组件
│       ├── lib/                  # 纯函数工具（markdown、segments、coca…）
│       └── pages/settings/       # 设置分区（LlmSection/TtsSection/SttSection/SystemSection）
├── data/                         # 本地模型、词典、COCA 词表等（打包时 extraResources）
├── dist/                         # 构建产物：Vite 输出的 SPA
├── dist-server/                  # 构建产物：esbuild 输出的服务端单文件（index.mjs）
├── dist-electron/                # electron-builder 输出（dmg / .app）
├── docs/  scripts/  tests/       # 文档 / 自动化脚本 / 测试
├── package.json                  # main: electron/main.cjs；scripts 见 §4.4
├── vite.config.ts  tsconfig.json  tailwind.config.js
└── README.md  README.zh-CN.md  LICENSE  .gitignore
```

> 结构原则：**服务端按「路由 → 引擎 → 数据」分层，前端按「页面 → 组件 → 工具」分层，前后端按同一业务域组织**（settings 分区 ↔ engines 目录一一对应）。

---

## 4. 进程与部署模型

### 4.1 运行时拓扑（推荐：单进程内嵌服务）

```
Electron 壳 ──(import/spawn)──▶ Express 单进程 localhost:8787 ──▶ 静态托管 SPA
     │                                │  /api/* 路由 → 引擎 → SQLite/文件/第三方 API
     └────────── BrowserWindow 加载 http://localhost:8787 ──────────┘
```

**为什么把服务端跑在 localhost 而不是让 Electron 直接调 Node API**：

1. 渲染进程保持 `nodeIntegration:false + contextIsolation:true`，安全面最小；
2. 服务端可以用 Express/中间件/文件上传等成熟生态，且**可用 curl / 浏览器 / headless 直接测试**（本次黑屏排查就是靠这一点快速归因）；
3. 未来要拆「远程部署 / 云同步」，HTTP 边界已经就位，无需重构。

### 4.2 Dev 双进程（热更新）

- `concurrently` 起两个进程：`tsx watch src/server/index.ts`（:8787）+ `vite`（:5173）。
- 服务端在 `LINGO_DEV=1` 时把非 `/api` 请求**代理到 5173（live-mirror）**：开发时只访问 `:8787` 一个地址，就能拿到 Vite 热更新的 UI + 真实 API。
- Vite 必须 `--host 0.0.0.0`（或配置 server.host），否则 localhost 访问不到。

### 4.3 生产单进程（打包）

- `esbuild` 把服务端打成**单文件 ESM** `dist-server/index.mjs`（native 模块 external）。
- Electron main **直接 `import()` 这个文件**，服务跑在 Electron 的 Node ABI 下（native 模块已 `electron-rebuild` 重建），**运行时不需要 npm/tsx**。
- 启动顺序：单实例锁 → 健康检查握手（轮询 `/api/health`，超时兜底）→ 开窗 → 加载。
- **可写目录重定向**：应用包只读，模型/资料库必须写到 userData（macOS 即 `~/Library/Application Support/<App>`），通过 `LINGO_MODELS_DIR` / `LINGO_LIBRARY_DIR` 环境变量注入。

### 4.4 一键脚本模板

```jsonc
{
  "main": "electron/main.cjs",
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "LINGO_DEV=1 tsx watch src/server/index.ts",
    "dev:web": "vite",
    "build": "vite build",
    "build:server": "esbuild src/server/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist-server/index.mjs --packages=external --external:better-sqlite3 --external:onnxruntime-node --log-level=warning",
    "rebuild": "electron-rebuild -f -w better-sqlite3,onnxruntime-node",
    "dist:mac": "npm run build && npm run build:server && npm run rebuild && electron-builder --mac",
    "typecheck": "tsc --noEmit"
  }
}
```

### 4.5 打包与分发（electron-builder）

- `files`: `dist/**`、`dist-server/**`、`electron/**`、`node_modules/**`（可排除体积大户，如 kuromoji、speech-sdk）。
- `extraResources`: 词典/词表/模型（如 `data/coca-bands.json` → `Resources/app/data/`）。
- **`asar: false`**：native 模块直接解包在 resources/app，避免 asar 内加载问题（体积换稳定）。
- native 模块必须在打包前 `electron-rebuild` 到 Electron ABI（见 §7 坑 3）。
- **发布**：测试版先发 GitHub `prerelease`（未签名需在 release notes 写明右键打开/`xattr` 解法）；正式版做 **Developer ID 签名 + notarize**（$99/年 Apple Developer Program，公证本身免费）。CI 可上 GitHub Actions 做 mac/win/linux 三平台矩阵。

---

## 5. 数据层设计

1. **SQLite + WAL + 单例**：`getDb()` 惰性单例，`PRAGMA journal_mode=WAL`，迁移用渐进式 `CREATE TABLE IF NOT EXISTS`（不需要迁移框架的轻量场景）。
2. **设置用 key-value JSON 表**：默认值对象 + 存储值浅合并，**新增 key 对老用户配置向后兼容**（lingutribe 的 `readSettings()` 就是这种模式）。
3. **库路径可配置 + 目录规划集中**：`resources/`（导入）、`audio|video|read/`（按类型）、`tts/`（合成音频）全部由数据层统一创建，业务层只调函数不拼路径。
4. **大文件不入库**：数据库只存元数据 + `relativePath`，文件在库目录；文件解析支持新/旧两种布局兼容（`resolveResourceFile` 模式）。
5. **API key / 敏感配置**：存本地 SQLite（不入 git、不写死代码）；多供应商配置用「历史列表 + defaultId」模式，**默认模型只用自己存的 key，严格隔离**（避免 A 模型的 key 被 B 模型调用）。

---

## 6. 引擎层设计（可插拔）

- **一引擎一文件 < 300 行 + barrel 导出**：对外导入面稳定，内部自由拆分。
- **统一协议**：LLM / 云端 TTS 全部走 OpenAI 兼容接口（`baseUrl + model + 可选 apiKey`）——本地 ollama、云端 DeepSeek/Fish Audio 只是配置差异。
- **本地模型一次性 ensure**：`ensureModel(packageName)` 负责下载/校验/缓存，业务调用前确保就绪；模型目录可重定向、首次启动做旧路径迁移。
- **每个引擎独立成域**：stt / tts / llm / models / http（网络出口）——改 TTS 不碰 STT，新增供应商不动其它引擎。
- **settings 与引擎一一对应**：设置分区组件（LlmSection/TtsSection…）与后端 engines/ 目录同名同构，改配置链路直观。

---

## 7. 稳定性实践（实战提炼）

1. **健康检查握手**：Electron 开窗前轮询 `/api/health`（超时 30s 兜底），server 没起来就耐心等，不闪窗。
2. **单实例锁**：`app.requestSingleInstanceLock()` + `second-instance` 聚焦已有窗口。
3. **优雅退出**：窗口全关时 kill 服务子进程；macOS 保留进程常驻（平台惯例）。
4. **代理感知网络**：Node 内置 fetch（undici）**忽略** HTTP(S)_PROXY 环境变量 → 用 `EnvHttpProxyAgent` + `setGlobalDispatcher` 在启动时全局注入，无代理时直连（国内环境必需）。
5. **dist 路径候选探测**：esbuild 会改变 `__dirname` 深度（src/server → 2 级、dist-server → 1 级、打包后 1 级），用候选数组 `find(exists(index.html))` 兜底。
6. **dev 镜像容错**：live-mirror 代理 Vite 失败时 fallback 到 dist 静态托管（Vite 没起也能跑）。
7. **大文件与并发**：multer 限流（500MB）、ffmpeg 转码子进程、转写/分析结果缓存（避免重复计算）、STT 去重守卫。
8. **模型/库目录迁移**：首次启动检测旧路径 → 一次性复制 → 后续全走新路径（打包后只读 bundle 不写盘）。
9. **测试安全网**：`tsc --noEmit` + esbuild bundle + API 冒烟（curl 全链路）三层兜底；重构承诺"零行为变化"靠工具证明。

---

## 8. 效率实践

- **构建分离**：`build`（Vite 前端）与 `build:server`（esbuild 后端）独立，互不阻塞、可缓存。
- **懒加载大资源**：COCA 词表等只读 JSON 首载后缓存内存；模型 ensure 只跑一次。
- **分析缓存**：转写/分析结果按资源缓存（本次实测 2.4MB 分析缓存直接命中）。
- **流式处理**：大文件不整读，multer 落盘 + ffmpeg 流式转码。
- **< 300 行纪律**：文件小 → 认知负载低 → 开发/评审/排错都快（这是最被低估的效率手段）。

---

## 9. 安全实践

| 项 | 做法 |
|---|---|
| 渲染进程隔离 | `contextIsolation: true, nodeIntegration: false`（渲染层永远拿不到 Node） |
| 外链处理 | `setWindowOpenHandler` 一律 `shell.openExternal`，阻止在壳内打开 |
| API 404 保护 | `/api/*` 未命中路由必须返回 JSON 404，**绝不 fall 到 SPA shell** |
| 密钥管理 | API key 存本地 SQLite；不入 git；默认模型 key 严格隔离（见 §5.5） |
| 数据隐私（产品卖点） | 本地优先：服务端无状态、不写盘外部、音频仅内存 Blob、文本存本地；第三方 API 只发必要内容（DeepSeek/Fish Audio 属"调用第三方"，与"自己服务器留存"明确区分） |
| 沙盒预览 | webview/iframe 预览时 localStorage 可能缺失 → 提供 shim 保证可启动 |
| 分发安全 | 未签名包在 release notes 明示 Gatekeeper 解法；正式版签名 + 公证 |

---

## 10. 已知坑（lingutribe 实战踩过，直接避雷）

1. **undici 版本与 Electron Node 版本必须对齐**：undici 8.x 需要 Node 22（`webidl.util.markAsUncloneable`），而 Electron 33 内嵌 Node 20 → 服务端 import 即崩、窗口一片黑。**锁 `undici@6.28.0`（Node ≥ 18.17）**。
2. **esbuild 打包改变 `__dirname` 深度**：源文件 `src/server/`（到 dist 2 级）vs 打包后 `dist-server/`（1 级）→ 静态托管路径找不到 → 黑屏。用「候选路径探测」解决。
3. **native 模块 ABI 双轨**：dev 下 `npm rebuild`（Node ABI）与打包的 `electron-rebuild`（Electron ABI）**互斥**——`npm run rebuild` 后再 `npm run dev` 会 ABI 不匹配。打包脚本里做 rebuild 即可，别手动来回切。
4. **Electron 拒绝 `NODE_OPTIONS=--use-system-ca`**（沙箱注入）→ 用 `env -u NODE_OPTIONS` 测试 Electron 进程。
5. **spawn 下 ffmpeg 编码器兼容**：`spawn` 调 aac 进 .mp3 会 exit 234；静音占位一律用 **WAV**（`-f lavfi -i anullsrc…`），真实 TTS 返回的 mp3 不受影响。
6. **Vite 默认只绑 localhost/127.0.0.1**：dev 服务要 `--host 0.0.0.0` 才能被其它进程/容器访问。
7. **沙盒 iframe 无 localStorage**：预览环境启动即崩，提供 shim。
8. **`LINGO_PORT` vs 服务端硬编码端口**：曾出现 server 忽略环境变量端口、curl 打错端口导致"假失败"——端口逻辑统一，测试前先确认监听端口。

---

## 11. 从 0 到 1 检查清单（照此落地）

**阶段 0 · 选型（30 分钟）**
- [ ] 确认核心能力有 Node 库（无 → 评估 Tauri/Web/Python 侧服务）
- [ ] 确定 LLM/TTS 统一走 OpenAI 兼容协议
- [ ] 确定数据库（默认 better-sqlite3）

**阶段 1 · 骨架（半天）**
- [ ] 目录模板落地（§3）
- [ ] 双进程 dev（8787 + 5173 live-mirror）跑通
- [ ] `/api/health` + SPA 静态托管跑通
- [ ] 空壳打包（electron-builder dmg）跑通 + userData 重定向

**阶段 2 · 数据层 + 第一个域（1 天）**
- [ ] `db.ts` 单例 + WAL + 迁移 + 库路径
- [ ] 一个完整 CRUD 域（resources）全链路：routes → db → 前端页面

**阶段 3 · 引擎接入（按需）**
- [ ] 顺序：LLM（最简单）→ TTS → STT → 本地模型
- [ ] 每个引擎：文件 < 300 行 + barrel + 设置分区对应

**阶段 4 · 稳定性/效率**
- [ ] 健康握手 + 单实例锁 + 优雅退出
- [ ] 代理感知 fetch + dist 路径探测
- [ ] 缓存 / 去重 / 大文件流式

**阶段 5 · 发布**
- [ ] GitHub prerelease（未签名 caveat）
- [ ] 正式版：Developer ID 签名 + notarize（$99/年会员，公证免费）
- [ ] CI 三平台构建矩阵

---

## 12. 演进路线（这套架构的成长路径）

1. **server 拆独立进程**：与 Electron 壳彻底解耦，实现进程崩溃隔离、多窗口、可远程调试（当前是 import 进主进程，崩溃即整窗黑）。
2. **Tauri 备选**：若未来包体积成为硬指标，UI 层可平移，服务端逻辑仍可复用（Rust 侧需评估）。
3. **云同步/多设备**：HTTP 边界已就位，加一个同步模块（加密上传可选资源）即可，不影响本地优先。
4. **自动化测试补全**：vitest + supertest 补 API 集成测试，把冒烟脚本固化进 CI。
5. **数据导出/备份**：库单文件 + 资源目录，天然可整体备份。
