# 示例：透明香水瓶的暗调主视觉

这是虚构拍摄计划，不是真实生成成功记录。

用户输入：一张透明矩形香水瓶参考，琥珀色液体、黑色方盖，标签原文「LUNE」。要求 4:5 暗色海报，右上留标题空间。未提供容量与功效。

## 设计决策
锁瓶型、方盖比例、液面、液色和标签；不补容量与香调。主视觉用轻微三分之四视角，保持正面文字可读。深灰背景，瓶身在左侧偏中，右上为低细节文案区；侧后长条反射勾边，正面留柔和可读层次，深色台面有接触阴影。

先读取 glass-and-perfume.md 与 brand-preservation.md，再查支持产品参考的 image_edit 工作流；Qwen 路径的提示词用 read_guide 的 qwen_image/i2i 规范。比例用工作流参数传，不伪造具体工作流 id 或引用槽位。

## 拍摄记录示意
```json
{
  "purpose": "4:5 暗调香水主视觉，右上后期排标题",
  "referenceIds": ["用户实际产品节点id"],
  "lockedFeatures": ["透明矩形瓶", "黑色方盖", "琥珀色液体及原液面", "标签原文 LUNE"],
  "material": "透明玻璃瓶身、黑色盖、纸质标签",
  "framing": "轻微三分之四视角，完整瓶身，左侧偏中",
  "lighting": "侧后长条反射勾边，正面柔和可读，接触阴影",
  "background": "深灰背景与深色台面",
  "copySpace": "右上低细节区域",
  "acceptanceCriteria": [
    {"id": "shape", "dimension": "identity", "description": "瓶身与方盖比例符合原参考", "threshold": 90},
    {"id": "label", "dimension": "text", "description": "标签 LUNE 拼写、方向与位置正确", "threshold": 95},
    {"id": "space", "dimension": "composition", "description": "右上文案区不被高光或道具占据", "threshold": 85},
    {"id": "glass", "dimension": "quality", "description": "透明边缘、液面与接触阴影可解释", "threshold": 85}
  ]
}
```

分数是示例任务门槛，不是专业质量已被证明。visual_critic 对照真实产品节点逐条审查。若结果只有标签错误，则保留已通过布局，尝试定向编辑；仍不可靠时交底图并说明待后期排字，状态为部分完成。
