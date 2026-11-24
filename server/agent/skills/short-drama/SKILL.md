---
name: 短剧制作
description: 多镜头短剧、故事改编、角色设定和成片；先读现有短剧手册，再建立带验收条件的任务图。
tools: read_guide, write_note, batch_generate_images, batch_generate_videos, visual_critic
---
先用 read_guide 读取 short_drama，涉及改编时读 drama_craft 的 adaptation 部分。保留原作事件与人物动机，不能以方便生成为由改剧情。
将剧本、角色参考、场景底图、分镜、每镜关键帧、每镜视频、成片拆成依赖任务。角色和场景完成并验收后，才开始依赖它们的镜头；视频沿用原有确认卡。
每镜记录景别、人物左右、视线、动作起止和承接。关键帧用 identity、spatial、composition 验收，视频增加 temporal。人物参考始终传给审查员。
失败只重做当前镜头及受影响下游。站位失败用 mark_layout，人物过小先 crop_image。不要因单镜失败重做所有角色与场景。
