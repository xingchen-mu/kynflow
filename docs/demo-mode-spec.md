# Demo 模式规格（可直接粘进 TRAE 的会话）

> 用途：让评委**点开链接就能体验**，不需要 ComfyUI、不需要 GPU、不需要装任何东西。
> 这是本次参赛唯一必须新写的功能，也是"产品完整可用 + 可公开访问体验入口"两条要求的唯一解。
> **代码请在 TRAE 里写**（规则要求 + 要留 Session ID），这份文件只是它的需求书。

---

## 1. 目标

`npm run build:demo` 产出一个**纯静态**站点：打开就是一条已经做完的短剧画布，能平移缩放、能点开成片播放、能看到连线含义、能点"生成"看到假的进度条最后落下一张真实预置图。

## 2. 非目标（明确不做，省时间）

- 不做真生成、不连 ComfyUI、不做登录、不做多画布管理、不做模型下载页面、不做助手对话（或只做一段预置对话回放）。
- 不改动正常模式的任何行为：`npm run dev` / `npm start` 必须和现在完全一致。

## 3. 实现要点

**唯一改动点：`src/lib/api.ts`。** 所有请求都从这里发出（`request()` / `api` 对象 / `EventSource('/api/events')`），所以做一层 adapter 是最小侵入：

1. 新增 `src/lib/demo.ts`，导出与 `api` 同形状的 `demoApi`，以及一个 `isDemo()`（`import.meta.env.VITE_DEMO === '1'`）。
2. `api.ts` 里导出 `const impl = isDemo() ? demoApi : realApi`，其余调用方不变。
3. `EventSource('/api/events')` 在 demo 下用本地定时器替代（demo 不需要跨端同步）。

**需要伪装的接口（按 demo 页面实际用到的最小集）**：

| 接口 | demo 行为 |
|---|---|
| `GET /api/projects` | 返回 1 条 fixture 画布 |
| `GET /api/projects/:id` | 返回 fixture 工程（items 完整，含连线） |
| `PUT /api/projects/:id` | 内存里接受改动，返回假 `updatedAt`（刷新即还原，可接受） |
| `GET /api/assets` | 返回 fixture 资产清单 |
| `GET /api/presets` / `GET /api/workflows` | 静态返回 fixture 里的 2–3 条 |
| `POST /api/tasks` | 假进度：0→30→70→100，每步 600–1200ms，最后按请求的 kind 返回**预置结果**（同一条片子的图/视频），并带上真实尺寸 |
| `GET /api/tasks?ids=` | 从内存任务表返回 |
| `GET /api/settings` / `GET /api/capabilities` | 静态：`comfyUrl` 为空、一切显示"演示模式" |

**Fixture 结构**（`demo/` 目录，构建时被 `public/` 收录）：

```
demo/
  board.json        # 一个 Project：剧本笔记 → 设定图 → 关键帧(3-5张) → 镜头(2-3段) → 成片(1条)
  assets/           # 上面用到的图（webp/jpg，单张 ≤ 300KB）与视频（mp4 h264，≤ 6MB，≤ 20s）
  meta.json         # 标题、一句话说明、许可标签（Z-Image / Wan 2.2 等）
```

**导出脚本**：`scripts/export-demo.mjs`——从真实 `data/` 目录按画布 id 导出 `board.json` + 用到的资产，图片转 webp、视频按需截短并压到 720p；缺 ffmpeg 时直接复制原文件。

## 4. 界面上的三处必须

1. **顶部一条常驻提示条**：`演示模式 · 结果为预置素材，不连接 GPU`（规则第六条：信息真实，不得误导）。
2. **首屏 10 秒内能看到成片**：进来默认视口对准成片节点，并有一个明显的播放按钮。
3. **一个"试一下"按钮**：点击后走真实 UI 与进度，落下预置结果——让评委体验"提交—排队—完成"的手感。

## 5. 构建与部署

```bash
npm run build:demo     # VITE_DEMO=1 vite build --outDir dist-demo
```

部署目标（挑一个，都要能拿到公开 URL）：Cloudflare Pages / Vercel / GitHub Pages。
注意：SPA 需要 history fallback（把 404 指到 `index.html`）。

## 6. 验收标准（缺一条不算完成）

- [ ] 手机浏览器打开能正常平移缩放，不白屏
- [ ] 不连网、`ComfyUI` 完全不存在时，页面无任何报错弹窗
- [ ] 首屏 10 秒内能看到"一条片子"；点播放能放完
- [ ] 点"试一下"能跑完假进度并落下预置图
- [ ] 顶部常驻"演示模式 · 预置素材"提示
- [ ] `npm run typecheck` 通过；`npm test` 131 个仍全过
- [ ] `npm run dev` 与 `npm start` 行为未变
- [ ] 页面加载体积 < 15MB（首屏 < 3MB）

## 7. 给 TRAE 的第一句话（连同上文一起粘）

> 读仓库根目录的 `AGENTS.md` 与 `docs/demo-mode-spec.md`。用最小侵入的方式实现 Demo 模式：只在 `src/lib/api.ts` 加一层 adapter，不改任何调用方；新增 `src/lib/demo.ts`、`scripts/export-demo.mjs`、`npm run build:demo` 脚本和一个 `demo/` fixture 目录。先给我一份改动清单和风险点，确认后再写代码。**不要改正常模式的任何行为。**
