# lingutribe 架构重构总结报告

- **版本**：v0.1.0（2026-08-06 重构完成，行为零变化）
- **范围**：服务端引擎拆分（引擎层）、路由与业务分离、数据分层、前端设置页拆分
- **关联提交**：`c657f36`（引擎拆分 + 路由提取）、`2a85665`（resources/import 路由提取）、`df3006f`（前端 Settings 拆分）
- **一句话结论**：把 1799 行的巨型 `index.ts` 与 309 行的混合 `engines.ts`，重构为「路由薄层 + 引擎层 + 数据层」三层模块化结构；`index.ts` 降到 353 行（↓80%），40 条路由全部移出，引擎按 STT / TTS / LLM / HTTP / 模型管理一文件一引擎，并用 typecheck + esbuild 打包 + API 冒烟测试三层安全网验证了**零行为变化**。

---

## 1. 修改前的问题

### 1.1 症状清单（客观事实）

| 问题 | 量化证据 |
|---|---|
| 服务端单体文件 | `src/server/index.ts` **1799 行**，40 条 Express 路由 + 静态托管 + 设置读写 + 引擎调用全部内联 |
| 引擎混合文件 | `src/server/engines.ts` **309 行**，同时容纳：curl 网络工具、STT（transcribeFile）、TTS（synthesizeSpeech）、LLM（chatWithLLM）、Kokoro 模型管理 |
| 前端单体文件 | `src/web/pages/Settings.tsx` **1118 行** |
| 路由与业务纠缠 | 路由回调里直接拼 SQL、直接操作文件系统，HTTP 层与领域逻辑无边界 |
| 数据访问散落 | 多处各自持有数据库连接/拼接库路径，无单一入口 |
| 无测试边界 | 没有任何模块可以独立单测——没有独立文件边界，就没有单元 |

### 1.2 现实是什么（这些问题的实际表现）

- **改一个小功能要通读几千行**：加一个 TTS 供应商，要在一个 309 行的引擎文件里找到 150 行的 synthesizeSpeech 并小心不碰坏旁边的 STT。
- **新增能力回归风险高**：路由和业务在同一处，改 SQL 会牵连 HTTP 行为，改 HTTP 又怕碰业务。
- **无法单元测试**：没有独立边界，测试无从挂载；只能靠人工点 UI 验证。
- **合并冲突频繁**：大家都在改 index.ts / engines.ts 两个巨型文件，任何一个功能改动都容易撞车。
- **故障定位慢**：像「打开一片黑」这类问题，实际要跨「壳层（Electron）→ 服务层（Express）→ 渲染层（React）」三层排查。只有分层清晰，才能快速归因到具体层——`server /api/health` 通、HTML/JS 返回 200、headless Chrome 能渲染，就能把问题锁定在打包集成层，而不是在几千行代码里大海捞针。

### 1.3 为什么现在改

- **时机**：功能进入稳定期（README 已刷新、打包链路已通），是做结构性收敛的最佳窗口——边加功能边重构会两头风险叠加。
- **目标**：模块化设计、路由与业务分离、数据分层、引擎拆分；每个文件遵守 **< 300 行** 的工程纪律。
- **约束（关键）**：**纯重构、零行为变化**。安全网不是"小心"，而是三层工具兜底：`tsc --noEmit` + esbuild 打包 + 全 API 冒烟测试（health / settings / resources / words / notes / chat / coca / dict / tts voices / llm / import）。

---

## 2. 修改后的架构（现状）

### 2.1 总体架构：单进程 + 内嵌服务

```
┌─────────────────────────────────────────────────────────┐
│ Electron 壳 (electron/main.cjs)                          │
│  单实例锁 · server 健康检查握手 · 开窗 · userData 重定向   │
└──────────────────────────┬──────────────────────────────┘
                           │ Dev: spawn npm run start (tsx)
                           │ Prod: import dist-server/index.mjs
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Express 单进程 (localhost:8787)                          │
│  /api/* 路由层 → 引擎层/业务层 → SQLite + 文件系统         │
│  静态托管 React SPA (dist/) · /api 404 保护              │
│  Dev 模式: live-mirror 代理到 Vite :5173                 │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ BrowserWindow (contextIsolation, 无 nodeIntegration)     │
│  React SPA: pages / components / lib                     │
└─────────────────────────────────────────────────────────┘
```

- **Dev**：`concurrently` 双进程（tsx watch 服务端 + Vite 前端），8787 在 dev 模式下把非 `/api` 请求代理到 5173——**开发时只见一个端口，无需手动 build**。
- **生产/打包**：esbuild 把服务端打成单文件 `dist-server/index.mjs`，Electron main 直接 `import()` 它，跑在 Electron 的 Node ABI 下（native 模块已由 electron-rebuild 重建）；SPA 的 `dist/` 由 Express 静态托管。

### 2.2 分层结构

| 层 | 位置 | 职责 |
|---|---|---|
| 路由层（薄 HTTP） | `src/server/routes/`（8 个模块） | 只做参数解析/校验/状态码，调业务层 |
| 业务层 | `src/server/engines/`、`analysis.ts`、`segments.ts` | 引擎能力 + 领域逻辑（转写、分段、分析、词典） |
| 数据层 | `src/server/db.ts` | SQLite（WAL）单例 + 库路径 + 迁移 + 目录规划，**全应用唯一读写入口** |
| 共享层 | `src/shared/types.ts` | 前后端共享类型 |
| 前端 | `src/web/`（pages / components / lib / settings） | 视图、API 薄客户端、纯函数工具 |

### 2.3 引擎层拆分（引擎拆分落点）

`src/server/engines.ts`（309 行）→ `src/server/engines/` 目录：

| 文件 | 行数 | 职责 |
|---|---|---|
| `http.ts` | 36 | curl 封装（代理感知，唯一网络出口） |
| `llm.ts` | 39 | LLM 对话（OpenAI 兼容协议：ollama / 云端统一） |
| `models.ts` | 12 | 模型 ensure（下载/校验一次性逻辑） |
| `stt.ts` | 61 | 语音转写（echogarden / Whisper 封装 + 模型名映射） |
| `tts.ts` | 169 | 语音合成（Kokoro 本地 / Fish Audio 等云端，多供应商） |
| `index.ts` | 16 | barrel——保持旧的 `import ... from "../engines/index.js"` 导入面不变 |

设计要点：

- **一引擎一文件，全部 < 200 行**（纪律线 300 行内）。
- **barrel 模式**：内部结构自由，对外导入面稳定，调用方零改动。
- **统一协议**：LLM 与云端 TTS 都走「baseUrl + model + 可选 apiKey」的 OpenAI 兼容协议，供应商可插拔（换 ollama / DeepSeek / Fish Audio 只改配置不改代码）。

### 2.4 路由层（路由与业务分离的落点）

40 条内联路由 → 8 个路由模块，统一 **DI 模式**：

```ts
// 例：routes/chat.ts —— 薄 HTTP 层，只做校验 + 调业务
export function registerChatRoutes(app: express.Express, ctx: { db; now }) {
  const { db, now } = ctx;
  app.get("/api/chat", ...);
  app.post("/api/chat", ...);
  app.delete("/api/chat/:id", ...);
}
```

`index.ts` 只负责组装与注册：

```ts
registerSettingsRoutes(app, { readSettings, writeSettings, dirSize });
registerWordsRoutes(app, { db, now });
registerNotesRoutes(app, { db, now });
registerChatRoutes(app, { db, now });
registerEngineRoutes(app, { readSettings, resolveLlm, resolveTts, buildTtsConfig, upload });
registerDictRoutes(app, { readSettings, resolveLlm });
registerResourcesRoutes(app, { db, now, readSettings, upload });
registerImportRoutes(app, { db, now, upload, ffmpegPath });
```

| 路由模块 | 行数 | 覆盖域 |
|---|---|---|
| `dict.ts` | 635 | 词典查询 + 音频（MDict 离线词典，域内最重） |
| `import.ts` | 440 | URL 导入（yt-dlp / RSS 兜底 / 字幕解析）+ 文本导入 |
| `resources.ts` | 251 | 资源 CRUD、文件服务、转写、分析 |
| `engines.ts` | 193 | 引擎配置探测、TTS 音色列表、LLM 测试 |
| `words.ts` / `notes.ts` / `chat.ts` / `settings.ts` | 各 ~30-50 | 单词 / 笔记 / 对话 / 设置 CRUD |

### 2.5 数据层

`db.ts`（145 行）是全应用数据唯一入口：

- `getDb()` 单例，`journal_mode = WAL`，`migrate()` 渐进式建表（`CREATE TABLE IF NOT EXISTS`）。
- 库路径可配置：`LINGO_LIBRARY_DIR` 环境变量（打包后指向 userData 可写目录），否则默认 `~/Documents/LingoLibrary`。
- 目录规划：`resources/`、`audio|video|read/`（按类型）、`tts/`，全部由 `db.ts` 的 `typeDir()` 统一创建。
- 兼容旧布局：`resolveResourceFile()` 同时支持新式 `relativePath 含类型子目录` 与 legacy 平铺文件名。

### 2.6 前端

- `Settings.tsx` **1118 行 → 106 行** + 4 个分区组件：`LlmSection / SttSection / TtsSection / SystemSection`。
- 全局分层：`pages/`（7 个页面）· `components/`（10 个复用组件）· `lib/`（5 个纯函数工具：coca / markdown / segments / locale / segment）· `settings/`（分区）。
- 路由：`react-router-dom`，`/resources/:tab`、`/read`、`/words`、`/chat`、`/settings`。
- 与后端通信统一走 `api.ts` 薄客户端（fetch 封装，FormData 自动不设 Content-Type）。

### 2.7 构建与打包

| 脚本 | 作用 |
|---|---|
| `dev` | concurrently 双进程（server + web） |
| `build` | Vite 构建 SPA → `dist/` |
| `build:server` | esbuild 打包服务端 → `dist-server/index.mjs`（native 模块 external） |
| `rebuild` | electron-rebuild 把 native 模块重建为 Electron ABI |
| `dist:mac` | 一键：build + build:server + rebuild + electron-builder dmg |

---

## 3. 前后对比

| 维度 | 修改前 | 修改后 |
|---|---|---|
| `index.ts` | 1799 行，40 路由内联 + 全部逻辑 | 353 行，纯 boot + 注册 + 静态托管 |
| 引擎组织 | 1 个 309 行混合文件（STT/TTS/LLM/HTTP/模型混居） | 6 个文件各 < 200 行，一引擎一文件 + barrel |
| 路由 | 内联在 index.ts | 8 个 `register(app, ctx)` 模块，薄 HTTP 层 |
| 业务边界 | 路由回调里拼 SQL / 操作 fs | 业务在 engines / analysis / segments，路由只调不实现 |
| 数据访问 | 多处自开连接 | `db.ts` 单例唯一入口（WAL + 迁移 + 路径策略集中） |
| 前端设置页 | 1118 行单体 | 106 行 + 4 分区组件 |
| 新增引擎成本 | 改巨型文件、高回归风险 | 新建文件 + barrel 导出，其余零改动 |
| 新增路由成本 | 改 index.ts | 新建 routes/xxx.ts + index.ts 一行注册 |
| 测试性 | 几乎不可测 | 单模块可测；typecheck / esbuild / smoke 三层安全网 |
| 心智负担 | 高（改动前要通读全局） | 低（< 300 行纪律，按域导航） |

---

## 4. 优势在哪里

1. **单一职责、按域组织**：路由层、引擎层、数据层、共享层、前端各归其位；「引擎拆分」让每个 AI 能力独立成文件，互不干扰。
2. **薄路由 + DI**：HTTP 层与业务解耦。路由只做「解析 → 调用 → 回包」，业务实现可替换、可单测；`ctx` 注入让依赖显式可见。
3. **数据分层单一入口**：SQLite 连接、迁移、库路径、目录规划全部收敛在 `db.ts`，不会出现"两处对同一路径理解不一致"的 bug（比如打包后只读目录写入问题）。
4. **引擎可插拔**：新增 STT/TTS/LLM 供应商 = 新文件 + barrel 注册。统一 OpenAI 兼容协议让「本地 ollama ↔ 云端 DeepSeek/Fish」切换只改配置。
5. **可验证、零回归**：三层安全网（typecheck + esbuild + 全 API 冒烟）使重构可以大胆做、且能证明"没改坏任何东西"。
6. **前端同构拆分**：页面/组件/工具/设置分区，设置页按引擎分区，与后端引擎目录一一对应——**前后端按同一域组织，导航成本低**。
7. **进程模型简化**：单端口 8787 同时服务 API 与 SPA；dev 的 live-mirror 让你只开一个地址就拿到热更新 UI；生产单进程让打包体积、启动复杂度、故障面都最小。
8. **面向打包的设计**：`dist/` 与 `dist-server/` 分离、native 模块 external + electron-rebuild、extraResources 打词典/模型、userData 重定向——架构从第一天就为「能发布」服务。

---

## 5. 代价与后续 TODO（诚实清单）

- `routes/dict.ts`（635）、`routes/import.ts`（440）、`routes/resources.ts`（440）、`routes/engines.ts`（193）仍超 300 行纪律线，是**下一轮拆分候选**（可再拆为 dict/lookup + dict/audio 等）。
- `index.ts` 中的设置助手（`resolveLlm` / `resolveTts` / `buildTtsConfig`）仍集中在 boot 文件，可下沉到 `engines/config.ts` 或独立模块。
- 前端 `WordPanel.tsx`（614）、`PlayerView.tsx`（518）、`Transcript.tsx`（416）是前端下一轮候选（参照 Settings 拆分模式）。
- **尚无自动化测试文件**（`tests/` 目录未建）：本次靠冒烟脚本兜底，建议下一轮补 API 集成测试（vitest + supertest 即可）。

---

## 6. 沉淀的方法论（可复用到其它项目）

1. **结构重构前先给树形方案并确认**，避免误改线上（本项目目录结构偏好的一部分）。
2. **小步提交、每步可独立验证**：引擎拆分（`c657f36`）→ 剩余路由提取（`2a85665`）→ 前端拆分（`df3006f`），每步一个 commit，各自过安全网。
3. **"零行为变化"靠工具证明，不靠小心**：typecheck + bundle + smoke test 通过才允许合入。
4. **commit message 写清 before/after 数字与验证清单**，让评审者一眼看懂改动面。
5. **给重构设纪律线（< 300 行）**：没有数字约束的重构会变成"换一种方式堆大文件"。
