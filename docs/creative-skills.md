# 视觉创作技能库

本库把「如何设计视觉内容」与「如何执行工具」分开维护。当前有 15 项内置技能；本次优先深化已有 8 项，新增 7 项共用知识/制作技能，没有把候选清单中的 50 项全部发布。所有内容版本 1.0 均为实验性，尚未完成真实生成质量对照。

## 当前分层与职责

| 层 | 当前入口 | 职责 |
| --- | --- | --- |
| L4 应用 | short-drama、advertising-video、viral-replication | 组织用户目标、阶段交付与制作流程 |
| L3 制作 | product-photography、character-consistency、storyboard、image-restoration、film-editing | 产出拍摄方案、资产、分镜、修复或成片 |
| L2 专业知识 | lighting、composition、material-rendering、cinematography、camera-movement、shot-continuity | 解决光线、布局、材质、机位、运动与承接问题 |
| L1 模型适配 | prompt-engineering → read_guide 的 qwen_image 与 short_drama/video | 按实际工作流与现有模型手册组织提示词 |

分层是内容组织约定，不是新增的引擎 metadata 或自动依赖机制。shot-continuity 与 camera-movement 也支持独立制作任务。没有安装的模型、剪辑、调色或声音功能不因出现技能描述而变得可用。

## 按阶段组合

当前最多保留最近 3 项技能，使用 read_skill 按需替换；参考通过同一技能的 resource 读取，不自动加载所有文件。下面是 15 秒香水广告的可选路径，不是每个任务必做的固定流程：

| 阶段 | 本阶段技能 | 交付/判断 |
| --- | --- | --- |
| 策划与分镜 | advertising-video、storyboard、cinematography | 镜头信息作用、目标剪辑时长与识别镜头 |
| 产品主视觉 | product-photography、lighting、material-rendering | 产品基准、布光与材质、合格关键帧 |
| 空间与版式修正 | product-photography、composition | 主体尺度、文案空间与保真 |
| 视频生成 | advertising-video、camera-movement、character-consistency | 可完成动作、运动路径、产品稳定性 |
| 剪辑与复查 | film-editing、shot-continuity | 实际时长、对白、切点与承接 |

读过的方案与关键锁定项要留在画布文档，不能假设早期技能正文会一直保留在上下文。用户只要某个阶段时只做该阶段。既有授权、确认卡与工作流输入约束继续生效。

## 编写与资源约定

- name、description 与逗号分隔的 tools 继续使用现有单行 frontmatter。描述写具体触发条件；tools 是当前引擎用于能力检查的工具清单，不是授权，也不表示所有步骤必须调用所有工具。
- 正文交代输入/边界、按条件选择方案、执行与工具映射、输出、验收/修复及来源/状态；不为凑模板把每项机械拆成 11 个标题。
- 只把确实按材质或场景分流的细节移入 references/。资源链接相对当前文件；跨技能使用 read_skill 的 id/resource，不用越目录链接绕过加载器。
- schemas/ 用于可复用的创作记录结构，不能混成工具参数。本次没有引入完整 YAML、自动依赖、任意脚本、下载或技能安装流程。
- 每项正文记录内容版本、验证状态与来源。运行时的 version 仍是现有正文/metadata 哈希，参考文件没有独立版本追踪；更新参考后应同步正文内容版本与状态，不能宣称已有完整版本管理。

产品摄影的参考覆盖布光构图、玻璃香水、金属珠宝、化妆品、食品饮料、数码、织物皮革、品牌保留，并提供拍摄计划 Schema 和虚构香水示例。来源清单在该技能的 references/sources.md；其他技能在正文末尾记录。外部教学页面只用于概念核对和独立归纳，不复制原文或图片，也不将外部资料重新标成 MIT。复用既有 Toonflow 改编手册时保留 THIRD_PARTY_NOTICES.md 的归属。

## 验证与评估

内容接入检查：

```bash
node --import tsx --test test/skills-library.test.ts test/agent-harness.test.ts test/guides.test.ts
```

这些检查验证真实 SkillEngine 能发现/读取技能、声明工具存在、本地资源可达、JSON 可解析及用例引用有效。它们不能证明专业视觉质量。

真实任务评估有 15 个待运行场景：product-photography/references/quality-cases.json 中的 6 个产品场景，以及 test/fixtures/skill-quality-cases.json 中的 9 个跨技能场景。两份文件均标记 not_run，不接入现有脚本化 Benchmark 的得分，也不把模拟工具结果冒充真实作品。

进行质量对照时：

1. 准备各用例要求的真实素材，记录节点/资产、用户要求、可用工作流、模型与版本、种子（如支持）、时长/次数/费用预算、环境与实际技能版本。
2. 同一模型与工作流下比较无技能、修改前简版、新版、新版加独立审查/修复。修改前简版从真实旧版本保留；若不可得，记录该组缺失，不重写一个「旧版」来比较。允许随机性时做多次重复，记录重试预算；不要求不同平台的种子等价。
3. 先按 expectedBehavior 检查决策与工具使用，再按 outputChecks 盲评实际产物。文字/身份硬错误逐项失败；纯分析/分镜用例由人工检查文本交付，不能把文字分镜直接送入视觉审查冒充实拍检查。
4. 视频分别记录抽样覆盖与实际播放确认；对白完整、音质与口型不能靠静态帧或声音区间检测判定。没有所需能力时标为环境阻塞，不当作质量通过。
5. 记录每项通过/失败/不可判、证据节点/时间、修复次数、模型调用/Token 消耗与实际成本；助手自评和用户评价分开。汇总前先检查失败条件，不用平均美感分覆盖品牌或需求错误。

本次仅完成内容接入验证。真实 ComfyUI/视觉模型对照完成后才更新验证状态与结果；未测模块继续标实验性。

### 脚本化上下文开销

在相同工作区代码、Node 26.12.0 与 faux/faux-1 下，将旧 8 项技能目录和正文放入隔离副本，与新库比较了三个 Harness 用例。以下是脚本化 Trace 的累计 Token 指标，不是真实 API 账单，也不测量专业质量：

| 用例 | 旧库 | 新库 | 增量 | 新预算 |
| --- | ---: | ---: | ---: | ---: |
| task-graph-sequence | 24482 | 32649 | 33.4% | 36000 |
| interrupted-task-recovery | 19635 | 22517 | 14.7% | 25000 |
| independent-identity-rejection | 23729 | 29301 | 23.5% | 33000 |

新增目录信息在多个请求中重复出现；首个用例还加载了更完整的分镜正文。对应固定预算按本次实测保留约 10% 余量，工具数、费用、GPU 与重试预算未放宽。技能按需读取避免全部正文常驻，但不代表扩库没有上下文成本；将来进一步扩库应重新测量，不能无限抬高预算。
