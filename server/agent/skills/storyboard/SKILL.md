---
name: 分镜与空间连续性
description: 将剧本转成可执行分镜；检查景别、人物左右、视线、轴线和前后镜头承接。
tools: write_note, crop_image, mark_layout, visual_critic
---
先读剧本，给镜头稳定编号 S01、S02。每镜明确场景、景别、机位、人物左右、视线、动作起止、道具、对白和前镜承接。
可用 schemas/shot.json 作为单镜结构参考，通过 read_skill 读取。分镜表写在画布文本中，任务图只引用它，不把整部剧本塞进任务目标。
多人和复杂遮挡先画站位；近景从场景底图裁出取景。保持同一场戏的轴线，越轴要明确过渡镜头。
验收 composition 与 spatial；连续镜头增加 identity 和 temporal，参考图包括角色基准、场景底图和上一个镜头。失败后重排任务依赖时只使受影响下游失效。
