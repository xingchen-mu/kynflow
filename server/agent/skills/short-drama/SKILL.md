---
name: 短剧制作
description: 多镜头短剧、故事改编、角色设定和成片；先读现有短剧手册，再建立带验收条件的任务图。
tools: read_guide, write_note, batch_generate_images, batch_generate_videos, visual_critic
---
# 短剧制作

## 输入与范围
输入故事/原作、目标时长、风格、已有角色与场景、用户要求的交付阶段。只要剧本就交付剧本，只要关键帧就做到关键帧。先用 read_guide 读 short_drama 的 overview，再按阶段读对应章节；已有授权覆盖的步骤不重复确认。

## 创作决策
- 有原作：用 read_guide 读 drama_craft 的 adaptation，锁定关键事件、动机、关系和结局。需要压缩时说明删并理由，不为方便生成而改掉用户要求。
- 从零创作：读 drama_craft 的 genres 和 script；先定主角目标、阻力、行动与结果，再把信息转折变成可拍动作。每镜必须承担新信息、关系变化或情绪反应。
- 对话密集：留够台词和反应时长，必要时减少镜头；不要把原台词无声删短。
- 复杂打斗、群像、交接道具：先拆关键动作与空间状态，保留用户要求的事件；技术限制需要改写时让取舍可见。

## 分阶段组合
1. 剧本与分镜用 write_note 保存；分镜阶段读 storyboard，写景别、站位、视线、动作起止、对白和承接。
2. 角色与场景基准先验收；身份问题读 character-consistency，空间/持物问题读 shot-continuity。任务图引用画布文档，不把全剧本复制进目标。
3. 每镜关键帧使用已验收基准；用 batch_generate_images 或合适参考图工作流。站位复杂时先 mark_layout，近景可从已通过底图 crop_image。
4. 视频前读 short_drama 的 video；视频沿用原有确认卡。batch_generate_videos 的每项需有合格关键帧、可完成的动作和当前模型支持的时长。
5. 成片阶段加载 film-editing；不要让每镜自行生成不连续的配乐。

## 输出与质量门槛
交付所需阶段的文档与节点、上下游关系、未通过项及实际完成范围。关键帧审查 identity、spatial、composition，视频再增加 temporal；reference_ids 必须含关键身份/空间证据，单次最多 4 张，必要时分开审查。

人物左右反转先修布局；人物崩坏先修关键帧；持物跳变先查状态链；节奏拖沓先剪重复信息。失败仅重做当前镜头及受影响下游，不把单镜问题扩成全片重做。视频抽样与声学片段检测都不能证明全片表演、对白和口型合格，缺乏证据的部分明确列出。

## 来源与状态
内容版本 1.0，实验性。叙事、模型规范与状态链继续引用仓库 short_drama / drama_craft 手册及已有 MiniMax、Toonflow 来源与 THIRD_PARTY_NOTICES.md；本技能负责流程组合，尚未完成真实短剧对照评估。
