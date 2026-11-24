# Agent 评估基线快照

日期：2026-11-25（Asia/Shanghai）。

实现提交：`1cdcd9b6f0639b7199b84bf752fd5e446404cbea`；工作区干净。
用例版本：`97d57a74c0eb0b497baf47ff9e65633d3566b6b254351395ccf04878a874a5a8`。

本快照区分协议回归与真实模型能力；两者不能互相替代。

## 脚本化回归

| 配置 | 用例数 | 通过 | 输入 Token（模拟计数） | 输出 Token（模拟计数） | 工具调用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 20 | 20 | 568086 | 937 | 42 |
| enhanced | 20 | 20 | 689017 | 937 | 42 |

40 组执行全部通过。模型决策来自固定脚本，生成端为 Mock ComfyUI；这证明预期工具链可执行，不能证明真实模型理解能力提高，也不衡量真实生成质量。上述 Token 为脚本化 provider 的计数，不是实际 API 账单。

## 真实模型基线

当前配置模型：`deepseek-flash`。

| 配置 | 请求用例 | 实际测量 | 配置阻塞 | 能力成功率 |
| --- | ---: | ---: | ---: | --- |
| baseline | 20 | 0 | 20 | 未测得 |
| enhanced | 20 | 0 | 20 | 未测得 |

当前 Agent 的自定义 DeepSeek 端点没有可用 API Key；运行时返回 `Provider is not configured: custom`，端点只读探测返回 HTTP 401。评估器识别第一次阻塞后停止重复调用。

因此没有可比较的真实模型样本，不能报告意图理解、视觉理解或优化收益；配置阻塞不计为 Agent 能力失败。ComfyUI 连接可用与语言模型认证是独立条件。

## 重现与继续

```bash
npm run benchmark:agent -- --profile both --output output/agent-benchmark-scripted.json
npm run benchmark:agent:live -- --output output/agent-benchmark-live.json
```

真实模型凭据配置好后可重新运行 live 对照。两个命令的生成端均为隔离的 Mock ComfyUI，不使用真实 GPU。真实生成的审美、人物一致性和完整视频时序仍需后续独立标注与 ComfyUI/GPU 实验。

本地 JSON、Markdown 和逐例轨迹位于 `output/agent-benchmark-scripted*` 与 `output/agent-benchmark-live*`，这些运行产物不提交 Git。完整使用说明见 [Agent Evaluation + Feedback Harness](agent-evaluation.md)。
