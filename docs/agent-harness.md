# Visual Agent Harness

逐次运行轨迹、用户反馈和 20 个能力用例见 [Agent Evaluation + Feedback Harness](agent-evaluation.md)。旧平面轨迹与 4 用例回归继续兼容；新的详细轨迹单独保存，含有界、脱敏的工具参数和结果。

Kynflow 保留 Pi Agent Core 和已有画布 / ComfyUI 工具，在其外围加入任务执行、专业知识、独立验收和经验反馈。以下为首版实现的实际边界；脚本化评估通过不表示真实模型的创作质量已经提高。

## 如何使用

正常向画布助手提出创作要求即可。系统提示词会引导助手为有依赖的多步任务建立任务图，并按技能目录加载专业知识。原有 Todo 面板继续展示简洁进度；新增工具以现有工具消息显示。本次没有增加独立的任务图编辑界面。

任务图、技能激活列表与执行轨迹保存在原有 `data/agent/<projectId>.json` 对话文件中，随对话归档、打开和回退；旧对话文件不需要迁移。全局经验保存在 `data/agent/experiences.json`，最多保留最近 1000 条。用户技能保存在 `data/skills/`，这些运行时文件均被 Git 忽略。

## 任务图与执行边界

`shared/types.ts` 中的 `AgentTaskGraph` / `AgentTask` 与画布连线、ComfyUI 工作流图独立。每个任务包含目标、依赖、画布输入/输出、验收条件、验收证据、状态和尝试预算。

1. `read_task_graph` 返回当前 revision 与完整状态。
2. `update_task_graph` 的 `plan` 创建或调整 DAG。循环、未知依赖、重复 id 和无效验收条件会被拒绝。
3. 只有依赖全部完成的任务进入 `ready`；`start` 将其变为 `running` 并消耗一次尝试。
4. 生成工具传入 `task_id`。运行时验证依赖和当前尝试，提交后自动关联返回节点并进入 `reviewing`，同一尝试不能再次生成。文本输出或复用已有素材用 `outputs` 显式关联。
5. 等待实际生成完成，再用 `complete` 提交每个验收条件的证据。视觉维度必须有独立 Critic 评分，且目标、输出资产和参考资产与本次任务匹配。单纯的 `record_review: pass` 不能替代视觉硬约束。
6. 工具执行异常记为失败；已交付输出被删除、生成失败或审查失败会在下次推理时被发现。相关下游失去验收状态。`retry` 清空当前及受影响下游的输出关联与证据，保留尝试次数，不删除画布上的旧素材。未受影响的任务继续有效。

`maxAttempts` 默认 3，允许 1–5，已有任务不能增加预算。耗尽后需要用户决定调整方案。重试不会自动取消已经提交到 GPU 的任务；先用现有取消工具处理仍在运行的相关任务。运行时还会拒绝上游已失效的后续生成。

重启、模型切换或重新打开历史对话后，原来的 `running` 会恢复为 `failed`，并要求先检查已有生成结果，防止重复提交。`reviewing` 保留输出关联，可继续等待和审查。恢复不自动启动 GPU 作业，也不重置尝试次数。确认卡绑定具体任务及尝试，旧卡不能在重试后提交生成。

运行时负责状态校验、可执行任务的计算、输出关联、恢复与预算，主 Agent 负责选择 ready 任务、调用工具、修复和重规划。首版不是脱离模型决策的通用 DAG 作业执行器。

示例计划参数：

```json
{
  "action": "plan",
  "revision": 0,
  "plan": {
    "objective": "同一产品的商业宣传图",
    "tasks": [
      {
        "id": "hero",
        "objective": "保留瓶身与标签，制作商业主视觉",
        "dependencies": [],
        "inputs": ["product-reference-item-id"],
        "acceptanceCriteria": [
          { "id": "product", "description": "瓶身、瓶盖和标签保持一致", "dimension": "identity", "threshold": 85 },
          { "id": "layout", "description": "产品为主体并有文案留白", "dimension": "composition", "threshold": 80 }
        ],
        "maxAttempts": 3
      }
    ]
  }
}
```

先 start，再 `generate_image` / `run_workflow` 携带 `task_id: "hero"`。调用 `visual_critic` 时提供实际输出 id 和 `task_id: "hero"`，它会自动读取目标、验收阈值和输入参考。

## Skills Engine

内置 8 项技能：短剧、角色一致性、产品摄影、广告视频、分镜、参考复刻、图像修复和提示词设计。现有 `read_guide` 和创作手册继续可用，技能按需要引用它们。

`list_skills` 动态发现技能 metadata，`read_skill` 按需读取正文或参考。最近加载的 3 项技能随对话持久化，并进入当前推理上下文。目录首次写入系统提示词，新增技能可立即通过 `list_skills` 发现；重新打开运行时后也会更新系统目录。

添加用户技能不需要修改核心代码：

```text
 data/skills/underwater-photography/
   SKILL.md
   references/lighting.md
   schemas/shot.json
```

```markdown
---
name: 水下产品摄影
description: 水下产品视觉，重点检查折射、气泡与产品轮廓。
tools: view_images, run_workflow, visual_critic
---
先检查产品参考，明确光源与水面位置。保持产品轮廓、包装和标签。
按需读取 references/lighting.md，再设计布光并通过独立审查验收。
```

Frontmatter 使用简单的单行 `name` / `description` / 逗号分隔 `tools`，不支持完整 YAML 语法。id 为小写英文、数字与连字符，最长 64 字符。正文与资源各不超过 48 KB。参考只允许该技能目录内 `references/` 或 `schemas/` 下的 md/json/txt 文件，路径解析包含符号链接检查。用户技能不能覆盖同名内置技能。工具要求是能力提示，不授予权限；本版不执行技能脚本，也不自动安装模型或外部工具。

## 独立 Visual Critic

`visual_critic` 使用当前配置的同一个多模态模型，发起独立调用：只有目标、阈值、带编号画面与参考，没有创作对话，也没有执行工具。

支持 instruction、identity、composition、spatial、style、quality、temporal、text。默认 instruction ≥ 80、quality ≥ 75；任务条件可增加或提高阈值。每个指定维度都必须有有效分数和可见证据，全部达到阈值才通过，不计算能掩盖硬性失败的加权均分。identity 必须有参考，temporal 必须有视频输出。

图片直接审查；视频采样首、中、尾三帧。最多 4 个参考节点。JSON 无效、证据缺失、模型错误、取消或输出截断均不会写入通过结论。评分、诊断、修复策略、模型、输出与参考资产标识保存在画布节点的 `critic` 字段，`read_board` 可以读取。

分数是模型的判断，尚未做人类标注校准。视频采样不能证明整段动作、闪烁、声音或字幕时序完全正确；需要更密集抽帧与相应媒体工具补充验证。首版没有新增 OCR、检测、SAM、姿态或深度模型，也不会声称已经运行这些分析。

## 经验与路由

`record_experience` 记录任务、实际输出、实际工作流、失败类别、策略和结果。写入时验证画布节点与工作流，未完成或审查失败的结果不能记为成功。Agent 只能写 `confirmation: agent`。

`search_experiences` 使用英文词与中文字符的词汇重叠检索，用户确认记录有更高检索权重。它是有界的首版检索，不替代已有语义记忆和向量检索，也不修改模型权重。

本机用户可用确认 API 标注 success 或 failure。确认接口不作为 Agent 工具暴露，不会根据助手声称「用户确认」自动提权。经验中不应存入凭据、敏感信息或用户要求不要记的内容。

`list_workflows` 在原有能力、输入数量、比例和可用性筛选之后排序。`run_workflow` 继续使用原来的执行与许可证检查。分数使用：

- 执行成功率：真实 done/error 历史，使用平滑先验，取消和排队不计入。
- 质量代理：用户明确确认的经验结果；Agent 自评不贡献质量分，没数据明确标为未知。
- 速度与相对成本：成功执行的 GPU 时间中位数；成本只是相对 GPU 时间代理，不是货币或显存估计。

默认权重为质量 0.45、可靠性 0.30、速度 0.15、相对成本 0.10。缺少数据使用中性先验，不虚构观测。排序函数接受可配置权重用于评估，当前工具没有新增偏好滑块，也没有实现 Contextual Bandit。样本尚少或任务差异大时，排序不应被理解为可靠的质量预测。

## Context Builder 与执行轨迹

每次推理临时构建任务上下文：优先列出执行中、审查中、失败与就绪任务，选取相关输入、输出、直接依赖产物和直接画布输入，再加入最多 3 项已加载技能与 3 条相关经验。总预算为 14000 字符，任务概况最多 5000 字符，相关素材最多 16 个。

该上下文只注入当前模型请求，不写入聊天历史，也不会反复进入摘要。原有系统规则、长期记忆、对话清理和压缩仍然保留。首版没有声称已经实现所有工作流或工具定义的动态裁剪。

轨迹记录 run_start/end、tool_start/end、model、generation_queued/end 和 recovery，包括调用 id、耗时、Token、费用、生成结果与重试标识。独立 Critic 的模型消耗计入总量。轨迹不复制提示词、图片或凭据。每次工具完成和运行结束持久化；每段对话最多保留 2000 条，导出会标明截断，评估命令拒绝将截断轨迹用作完整基准。未加载对话的历史 GPU 完成事件并非完整监控系统，实际 GPU 计时仍受服务可见的任务记录限制。

## 本机 API

这些接口沿用 `/api/agent/*` 的本机访问限制：

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| GET | `/api/agent/skills` | 动态技能 metadata |
| GET | `/api/agent/:projectId/task-graph` | 当前对话任务图 |
| GET | `/api/agent/:projectId/trace` | 当前对话轨迹与截断标识 |
| GET | `/api/agent/:projectId/experiences` | 当前画布的经验 |
| POST | `/api/agent/:projectId/experiences/:id/confirm` | 用户确认，body 为 `{"outcome":"success"}` 或 `{"outcome":"failure"}` |

当前 Agent View 和 SSE 也提供 `taskGraph`。新增 Harness 工具仅注册到内置 Agent，不改变已有外部 MCP 的工具权限或执行方式。

## 评估与验证

```bash
npm run eval:agent
npm run eval:agent -- --output output/custom-agent-evaluation.json
npm test
npm run build
npm run smoke
```

`eval:agent` 运行已有五个场景评估、Harness 定向检查和真实运行时的脚本化模型测试，生成 `output/agent-evaluation.json`。四个带指标的固定用例在 `test/fixtures/agent-benchmarks.json`：任务图依赖与验收、中断恢复、独立人物一致性拒绝、经验来源。报告固定 Pi 版本、模型身份、无 GPU / 无 ComfyUI 的环境说明，并记录源码 revision 与各项预算。它验证协议和控制逻辑，不是自然语言意图理解或视觉质量 Benchmark。

也可以从本机 API 导出实际 trace 和 task-graph，按固定用例检查工具、完成状态与预算：

```bash
curl http://127.0.0.1:8787/api/agent/PROJECT_ID/trace > /tmp/agent-trace.json
curl http://127.0.0.1:8787/api/agent/PROJECT_ID/task-graph > /tmp/agent-graph.json
npm run eval:agent -- --trace /tmp/agent-trace.json --graph /tmp/agent-graph.json --case task-graph-sequence
```

实际评测还需固定模型版本、输入素材、ComfyUI 版本、GPU、预算和人工标注。现有用例主要测运行机制，不能替代产品摄影、多镜头短剧等真实任务的端到端质量评估和消融实验。新增机制对质量、Token 和人工干预的净收益尚未验证。

后续阶段可以在这些持久化契约上增加人工校准的多维度视觉评估、更丰富的感知工作流、任务相关的统计路由和按需专业子 Agent。当前仍由单一主 Agent 管理画布，不引入多个 Agent 同时自由修改画布。
