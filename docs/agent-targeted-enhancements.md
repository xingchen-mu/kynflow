# 第二阶段：针对性增强

在第一阶段的 Trace / Evaluation / Feedback 上增强视觉验收、定向修复和上下文选择。没有增加新的 Agent 框架；继续使用当前模型、画布工具和 ComfyUI。

## 独立 Visual Critic 与逐条验收

`visual_critic` 默认使用 `criteria-v2`：单独的模型调用，只输入目标、验收条目、媒体尺寸、编号图像与参考。创作对话、素材名称、生成提示词、Agent 自评和旧 Critic 分数均不进入审查请求。独立是上下文与工具权限隔离，仍使用当前配置的同一个多模态模型，并不保证不同模型之间的统计独立性。

任务图中的视觉 `acceptanceCriteria` 原样成为逐条标准。同一维度的两个要求不会合并成一个平均分。没有任务图时也可以显式传入条件：

```json
{
  "id": "edited-item",
  "objective": "保留产品，只调整背景颜色",
  "reference_ids": ["original-item"],
  "criteria": [
    { "id": "shape", "dimension": "identity", "description": "杯子外形、杯把和橙色保持原样", "threshold": 85 },
    { "id": "background", "dimension": "instruction", "description": "仅背景变为低饱和浅蓝，木桌不变", "threshold": 80 }
  ]
}
```

每项结果包含标准 id、描述、维度、硬阈值、分数、可见证据、可见性和本地判定。`uncertain` / `unobservable` 即使分数为 100 也不能通过。缺项、重复 id、未知 id、无证据、无效 JSON、错误、取消或截断均不能产生通过结论。维度分数仅为兼容展示，任务验收以具体条目为准。

旧的维度评分仍可读取，但不能代替当前条目验收。完成任务必须匹配条目 id、描述、维度、范围、分数、实际输出资产和参考资产。修改标准或替换素材后必须重新审查；不会自动重新生成。

视频仍只取首中尾帧。`coverage: sampled_video` 不能通过默认的完整时序要求；只有显式声明 `scope: sampled_frames` 的时序条件可按这些帧验收。抽样通过不表示整段视频或声音通过。没有新增 OCR、检测或全帧视频分析模型。

## 缺陷到修复方案

失败项返回可定位的缺陷、证据和可选归一化区域（以目标图为准）。服务端校验区域范围，不把模型的定位当成检测器输出。分类与操作映射位于 `server/agent/visual-repairs.ts`：

| 缺陷 | 首选策略 |
| --- | --- |
| 身份漂移、文字错误、风格漂移、颜色不符 | 保持原始参考，定向编辑 |
| 构图或空间关系错误 | 标出布局，再用参考图编辑 |
| 主体比例不符 | 裁出所需景别，再编辑 |
| 粘连、缺损、伪影 | 有实际蒙版和能力时局部编辑，否则查询参考编辑能力 |
| 动作未完成、指令不符 | 重写可观察要求，查询匹配能力 |
| 时序不连续、证据不足 | 先补充检查或素材，不盲目重做 |

结构化方案包含 action、所需能力、参考要求、必须保留的已通过条件、需要复核的条目 id，并明确禁止只换 seed。方案本身不提交 GPU 作业，不增加重试预算，不假定存在蒙版或工作流。主 Agent 仍通过现有工具在现有预算和审批规则内执行。

## Context Builder

默认选择执行中、审查中、失败、就绪任务中的当前焦点；同状态优先与选择节点有关的任务。先放目标、实际输入/输出、尝试预算和逐条硬标准，再放相关素材、失败证据和修复方案，然后是其它任务概况、技能和经验。直接依赖产物和一层画布输入可进入上下文，不递归展开整张画布。

预算最多 14000 字符，相关素材最多 16 个。完整记录按优先级纳入，不通过末尾截断切掉半条标准；放不下时明确提示按需读取原文。长剧本按当前意图提取相关行，并标为摘录。记录 `context` 轨迹，包含所选节点、字符数和省略项，不额外复制素材正文；临时上下文不写入对话历史。

## 优化前后对照

两个配置都开启原有 Harness；只切换 `enhancement`：`legacy` 保留第一阶段的 Critic、标签和 Context Builder，`targeted` 使用本阶段实现。它是同一源码上的功能对照，不等同于检出两个历史提交。

```bash
# 必须先提交修改，保持两个配置来自同一干净提交
npm run compare:agent -- --mode scripted --output output/agent-stage2-scripted.json
npm run compare:agent -- --mode live --output output/agent-stage2-live.json

# 相同原图、相同 seed；两次实际 GPU 编辑各有一次提交上限
npm run benchmark:agent:gpu -- --real-gpu --enhancement legacy --seed 42 --input output/gpu-smoke/zimage_00001_.png --output output/agent-stage2-gpu-legacy.json
npm run benchmark:agent:gpu -- --real-gpu --enhancement targeted --seed 42 --input output/gpu-smoke/zimage_00001_.png --output output/agent-stage2-gpu-targeted.json

# 复核已经生成的图：禁止任何 GPU 提交，两个结果可使用相同的固定逐条标准
npm run benchmark:agent:gpu -- --real-gpu --input ORIGINAL.png --existing-result RESULT.png --output output/agent-stage2-rereview.json
```

凭据仅通过进程环境传入；不写入报告或 Git。JSON/Markdown、逐例轨迹和实际图像保存在忽略的 `output/`。协议对照固定 20 个任务、同一模型、同一源码和夹具版本。不同版本、脏工作区和配置阻塞不计为能力提升。报告保留回退，不按成功案例筛选结果。

`--existing-result` 模式只读取已有的原图和结果，记录来源路径，并给模型同一组固定标准；报告校验实际返回的条目 id、描述、维度与阈值。此模式不连接进度 WebSocket、不轮询任务、不取消队列，生成预算为零。它用于模型或参数错误后的复核，不能伪装成一次重新成功完成的生成。

协议中的生成输出仍是占位图，不能计为视觉质量成功率。真实 GPU 结果单独记录执行状态、模型审查与实际图像。两种 Critic 的标准粒度不同，不能直接把维度分差当成图像质量提升；相同 seed 也不能消除模型提示词和采样差异。一次采样只用于诊断，需要人工标注和重复实验才能判断泛化收益。费用未知时 cost=0 仍不代表免费。
