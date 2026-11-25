/** Shared environment description, never an answer key or a suggested tool choice. */
export const MOCK_PROTOCOL_VERSION = 'mock-tool-contract-v3';
export const MOCK_PROTOCOL_INSTRUCTIONS = `当前运行在无 GPU 的工具协议评估环境中。
画布原始输入图是真实测试素材，可以使用视觉工具分析其可见内容。
生成工具经过真实参数校验、排队和结果落盘，但返回图像是占位数据，不代表提示词对应的真实生成结果。
返回媒体保留请求的尺寸协议：超分按输入尺寸乘倍率，编辑按指定宽高；像素内容仍是占位数据。
有生成需求时，完成正确的工具选择、输入和参数构造，等待成功或失败的执行状态后报告模拟执行结果；不要对模拟生成图做审美/内容验收，不要因占位画面不符合提示词而重试，也不能声称已经验证真实创作质量。
执行状态中的显存不足、连接失败和缺少依赖是真实的协议测试信号，仍需按用户要求处理。`;
