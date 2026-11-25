---
name: 商业产品摄影
description: 香水、珠宝、化妆品、食品、数码、皮革产品的商业摄影与电商主图；按材质选择布光，保留外观、标签与文案空间。
tools: view_images, list_workflows, run_workflow, visual_critic
---
# 商业产品摄影

## 输入与边界
适用于单张主视觉、详情图和系列产品照。视频任务在关键帧阶段使用本技能，再交给 advertising-video。先查看产品参考，提取轮廓比例、部件、包装颜色、标识原文、材质和不可遮挡区域；区分用户提供的事实与创意假设。缺少参考时可做概念图，不能宣称还原了真实商品。

明确用途、比例、产品数量、背景要求和文案位置。未给出的非关键风格可提出默认方案；真实品牌、型号和卖点不能补造。品牌保留读 [品牌与标签](references/brand-preservation.md)。

## 按任务选方案
| 条件 | 选择与理由 | 按需读取 |
| --- | --- | --- |
| 电商白底、外观核对 | 平视或轻俯视、完整轮廓、可读标签、轻接触阴影；不让戏剧光吞掉包装 | [布光与构图](references/lighting-setups.md) |
| 透明玻璃、香水 | 先决定亮背景暗边或暗背景亮边，再处理液体、透射与标签 | [玻璃与香水](references/glass-and-perfume.md) |
| 金属、珠宝、手表 | 用反射条带与明暗渐变解释曲面；区分抛光、拉丝与宝石 | [金属与珠宝](references/metal-and-jewelry.md) |
| 护肤品、彩妆 | 分开控制瓶身与瓶盖的高光；色号、液体状态和包装对应 | [化妆品](references/cosmetics.md) |
| 食物、饮品 | 先确定形态和食用状态，再选择角度、侧光或逆光 | [食品饮料](references/food-and-beverage.md) |
| 耳机、手机、电子产品 | 外壳与接口几何优先，屏幕内容另设条件 | [数码产品](references/electronics.md) |
| 布料、皮革 | 斜向光显示纹理，核对缝线、褶皱和结构 | [织物与皮革](references/fabric-and-leather.md) |

不要同时读取所有参考。混合材质按主要表面读取，必要时用 material-rendering；布局问题用 composition，光线问题用 lighting。

## 执行与工具映射
1. 用 view_images 核对产品；将用途、外观锁定项、布光、背景、取景与验收条件写成简洁拍摄计划。需要保存时用 write_note。
2. 用 list_workflows 查实际参考图输入数、比例与编辑能力，再用 run_workflow 执行。没有参考图编辑能力时明确限制，不能改用纯文生图后声称保真。
3. 先做一张主视觉；通过后再派生细节与场景变体。采用同一产品基准，不让上一次生成的错误逐轮累积。
4. 用 visual_critic 传原产品 reference_ids。identity 分别核对比例、部件和颜色；composition 检查主体尺度和文案区；quality 检查材质和阴影；有文字时另设 text 条件。最多选 4 张有判别力的参考。

## 输出与修复
交付拍摄计划、输出节点、逐项审查证据及待处理问题。计划可参考 [拍摄结构](schemas/shot-plan.json)，这是创作记录格式，不是工具参数。完整示例见 [香水主视觉](references/perfume-example.md)。

标签被高光覆盖：保留构图，改变反射条带或补光；瓶身变形：回到原始参考与编辑工作流；材质失真：只改表面与光线描述；产品太小：先调整取景，避免增加装饰。精确文字无法稳定生成时，交付可用底图并说明需后期叠字，不能把错误文字判为通过。

## 来源与验证状态
内容版本 1.0，实验性；已定义 [6 个评估场景](references/quality-cases.json)，尚未完成真实生成对照。方法为独立归纳，来源、许可边界和适用范围见 [来源记录](references/sources.md)。
