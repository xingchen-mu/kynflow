# Agent Evaluation + Feedback Harness

这套评估先记录可观测执行证据，再讨论 Agent 能力。运行时继续使用 Pi Agent Core、现有画布工具和记忆系统；本次没有增加新的 Multi-Agent、记忆架构或 ComfyUI 节点编辑器。

## 三类结论

| 模式 / 状态 | 可以得出的结论 | 不能得出的结论 |
| --- | --- | --- |
| scripted + Mock ComfyUI | 工具协议、参数、实际执行管线、失败恢复与验收规则没有回退 | 模型理解能力或视觉质量变强 |
| live + Mock ComfyUI | 当前模型在固定任务上的自主工具选择、参数和可检查结果 | 真实生成的审美、人物一致性或 GPU 成本 |
| blocked | 认证、模型配置或评估运行环境需要修复 | Agent 在该能力维度失败 |

ComfyUI 的连接状态与 Agent 模型的认证状态是两件事。能访问 ComfyUI 并不代表语言模型 API 已经配置完成。

## 运行 20 个固定用例

```bash
# 默认无外部模型、无 GPU：真实工具与 TaskManager，脚本化模型决策
npm run benchmark:agent

# 同一测试集对比基础工具模式与现有 Harness 模式
npm run benchmark:agent -- --profile both --output output/agent-benchmark-scripted.json

# 使用 Kynflow 设置中的真实模型，自主做出决策；生成端仍是 Mock ComfyUI
npm run benchmark:agent:live -- --output output/agent-benchmark-live.json

# 单例定位问题
npm run benchmark:agent -- --mode live --profile baseline --case intent-upscale

# 原有 4 个带预算的回归用例继续保留
npm run eval:agent
```

`baseline` 关闭已有 Task Graph / Skills / Experience 工具、增强提示词与路由排序，使用原有画布工具与记忆。`enhanced` 使用目前应用中的 Harness。二者是当前代码的功能消融配置，不等同于检出某个历史提交。简单任务不要求测试驱动额外建立 DAG。

第一批用例在 `server/agent/evaluation/fixtures/core.ts`，十个维度各两例：

| 维度 | 用例 |
| --- | --- |
| 意图理解 | 原图超分；去背景 |
| 工具选择 | 无编辑能力时不拿超分替代；选择双参考图工作流 |
| 参数构造 | Z-Image / 1k / 1:1；单图编辑 / 16:9 |
| 视觉理解 | 红蓝方块的左右关系；方块与圆形比较 |
| 自主纠错 | 站位图约束后重做；精确文字 MOON 修复 |
| 任务规划 | 先计划不生成；三张产物共用原始参考 |
| 上下文管理 | 只改第三镜头；从长分镜中提取原句 |
| 记忆利用 | 使用已确认颜色偏好；检索角色外套颜色 |
| 异常恢复 | Qwen 显存不足后降级一次；ComfyUI 离线时停止重试 |
| 资源效率 | 只检查选中图；一次批量更名 |

预期行为和参数检查在运行真实模型前固定。检查器不会读取隐藏思维链，也不通过助手口头说「完成」来认定资产已经产生。它核对成功调用的工具与参数、真实 TaskManager 记录、原图引用、被保护节点是否变动，以及可确定事实的回答。

视觉用例使用人工定义事实的几何图：红方块在左、蓝方块在右，另一张图为绿色圆形。它们测试基础视觉感知，不代表人脸一致性、视频连续性或审美能力。本批用例不生成或评分真实图片和视频质量。

## 隔离与预算

每个 CLI 用例在独立子进程和临时 `DATA_DIR` 中运行。语言模型配置从当前设置加载并通过进程环境传递，密钥不写入报告；用户原有画布、资产和记忆不被修改。

Mock ComfyUI 只绑定临时本机端口，实现 `/prompt`、`/history`、`/view`、上传、队列和状态等 HTTP 行为，向现有 TaskManager 投递执行事件。工作流经过现有构建、上传、结果下载和落盘流程，但节点图仅被记录，不会提交给真实 ComfyUI。模拟的生成耗时不是 GPU 实测时间。

每个用例固定工具调用数、模型调用数、Token、墙钟时间和生成数量预算。运行时在下一次模型或工具调用前检查调用数和 Token 预算，并限制输出长度与墙钟时间；生成数量由最终 TaskManager 记录核对。已发出的单次请求可能超过剩余 Token 预算，最终报告仍会将超限列为失败。子进程有独立超时兜底。

遇到认证或模型未配置时标记 `blocked`，停止后续重复调用。blocked 用例不计入能力成功率，全部 blocked 时成功率为 `null` / unmeasured。基础与增强配置只比较同一模型、同一用例、同一模式且确实测量的成对结果；没有测量的用例不会被计为提升。

退出码：0 表示所有已请求用例通过；1 表示实际断言或预算失败；2 表示存在配置或运行环境阻塞。

## 报告

每次运行生成 JSON、Markdown，以及以报告文件名为前缀的轨迹目录，例如：

```text
output/agent-benchmark-scripted.json
output/agent-benchmark-scripted.md
output/agent-benchmark-scripted-traces/
  baseline-intent-upscale.json
  enhanced-intent-upscale.json
```

报告记录源码提交与工作区是否有未提交修改、用例 SHA-256、模型、Pi 版本、Node 版本、提示词版本、执行环境、每项检查和预算消耗。每条轨迹记录模型与提示词身份，避免模型切换后无法解释旧数据。

自定义端点的模型定价可能未知；费用字段中的 0 不表示免费。模型名称可能是服务端别名，未报告实际模型修订版时，不应把单次对照当成严格固定版本的因果实验。真实能力对照还需要多次采样、固定模型修订版和输入环境，视觉质量另需人工标注及真实 ComfyUI / GPU 测试。

## 逐次运行 Trace

新增 `shared/types.ts` 中的 `AgentRunTrace` 与扩展后的 `AgentTraceEvent`。实现位于：

```text
server/agent/trace/
  types.ts
  redact.ts
  recorder.ts
  store.ts
server/agent/evaluation/
  types.ts
  metrics.ts
  runner.ts
  mock-comfy.ts
  fixtures/core.ts
```

每次用户发起或事件唤醒的运行有独立 runId。记录项目、对话、父运行、用户意图、模型、提示词摘要版本、可见工具参数和结果、失败分类、输入/输出及缓存 Token、费用、生成/重试次数和关联节点。模型的 thinking / reasoning 块、图片 base64 和凭据字段不写入轨迹；字符串中的常见凭据形式会脱敏，内容有长度和层数上限。

输入 Token 总数包括未缓存输入、缓存读取和缓存写入；`paidTokens` 沿用应用不计缓存读取的口径。模型调用数是尝试次数，认证前失败的调用也会留下错误证据，但 Token 为 0。生成环境标记 `mock` 或 `comfyui`，用于区分模拟计时与实际任务计时。

确认卡的接受/拒绝，以及在运行结束后返回的生成结果，仍关联最初提交它们的运行。用户反馈与这些迟到事件串行更新，避免结果到达后覆盖用户判定。

轨迹独立保存在 `data/agent/traces/<projectId>/<runId>.json`，不会因打开新对话或历史压缩而丢失。恢复到仍为 running 的旧轨迹时标记 interrupted，保留证据，不认定成功。每个运行保留最多 2000 个事件并显式记录截断数；累计指标继续记录，截断轨迹不能获得完整基准通过结论。轨迹随运行累积，当前版本没有自动删除历史运行的保留策略。

## 用户反馈

正常执行结束时 outcome 默认为 partial / unconfirmed。即使 Agent 的 record_review 写了 pass，也只记录为 Agent 自评；不会自动升级为用户确认。

用户可接受、拒绝或给出 mixed 反馈，附评论及本次运行关联节点。反馈保留最近 20 次修订，明确 `source: user`，不会反向伪造 Agent 自评，也不会自动训练模型或写入成功经验。反馈接口不作为 Agent 工具暴露。它沿用现有本机 API 边界，属于本机用户操作接口，不是对调用者进行人类身份认证的机制。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/agent/:projectId/traces?sessionId=...` | 查询项目 / 对话运行 |
| GET | `/api/agent/:projectId/traces/:runId` | 读取单次详细轨迹 |
| POST | `/api/agent/:projectId/traces/:runId/feedback` | 提交反馈 |

```bash
curl -X POST http://127.0.0.1:8787/api/agent/PROJECT_ID/traces/RUN_ID/feedback \
  -H 'Content-Type: application/json' \
  -d '{"verdict":"rejected","comment":"人物外套与参考不一致","assetIds":["OUTPUT_ITEM_ID"]}'
```

反馈不要求模型 API 已经可用，也不要求该对话仍是当前对话。节点必须属于指定运行；跨项目、未知运行或无效反馈会被拒绝。旧 `/trace` 平面接口继续只提供统计元数据，详细参数和内容通过新的逐次运行接口读取。

## 后续优化门槛

现有 Visual Critic、验收阈值、失败到修复策略映射和 Context Builder 可以在此基础上做对照。本阶段首先补测量，不继续扩充这些模块。真实模型基线可执行后，再根据失败明细选择下一项改进；人物一致性、局部缺陷定位和完整视频时序需要单独的标注集，不以本批几何图用例替代。
