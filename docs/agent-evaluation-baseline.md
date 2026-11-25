# Agent 评估基线快照

日期：2026-11-25（Asia/Shanghai）。

协议版本：`mock-tool-contract-v2`。
用例 SHA-256：`ccbb12c5065369f9291062c4cb7b62dc6db92896ae9d43510d717e122743704a`。
脚本化补测源码提交：`3ffbb855fb5d090867db8f8ecd02d36de7ccc48a`；工作区干净。

本快照区分协议回归与真实模型能力；两者不能互相替代。

## 脚本化回归

| 配置 | 用例数 | 通过 | 输入 Token（模拟计数） | 输出 Token（模拟计数） | 工具调用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 20 | 20 | 573096 | 937 | 42 |
| enhanced | 20 | 20 | 694038 | 937 | 42 |

40 组执行全部通过。模型决策来自固定脚本，生成端为 Mock ComfyUI；这证明预期工具链可执行，不能证明真实模型理解能力提高，也不衡量真实生成质量。上述 Token 为脚本化 provider 的计数，不是实际 API 账单。

## 真实模型基线

实际配置模型：`deepseek-flash`，使用用户提供的临时凭据。运行时间：2026-11-25 11:59:34 至 12:06:10（Asia/Shanghai）。

| 配置 | 实测 / 通过 | 配置阻塞 | 输入 Token（含缓存） | 输出 Token | 工具调用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 20 / 20 | 0 | 1185303 | 19256 | 76 |
| enhanced | 20 / 20 | 0 | 1460202 | 25695 | 84 |

20 个成对用例的二元结果相同：提升 0、回退 0、相同 20。enhanced 工具调用多 8 次，总输入/输出 Token 多 281338，不能据此声称增强配置已经提高能力。输入计数包含缓存读取，不能等同于未缓存付费 Token；自定义模型的费用没有定价，报告 cost=0 不表示免费。

这些结果来自真实模型在 Mock 工具环境中的自主决策，不是真实生成质量成功率。十个维度每个仅两例，且只有单次采样；当前测试集出现满分，后续需增加更难、带人工标注的样本，不能用满分宣称整体能力已达到生产标准。

可复现性限制：这批 live 报告启动时记录提交 `a62187c`、`sourceDirty=true`；评估协议修改随后提交为 `3ffbb85`，运行期间补齐了规划工具成功状态检查，之后增强配置沿用相同逻辑。它是开发期诊断，不是锁定 checkout 的严格实验。原始逐例轨迹与检查结果保留在 `output/agent-benchmark-live-v2*`，没有回写源码版本或伪装成干净提交的结果。

早期没有 API Key 时，两个配置各 20 例曾标为 blocked；现已由上述实测补齐。另外一次旧协议 live 试跑已中止：占位生成图诱发视觉重试，且「只剩超分能力」的夹具漏禁用内置 Qwen 编辑；这些条件不适合作为能力失败样本。v2 修正并明确环境协议，规划检查也接受按顺序覆盖目标的便笺/正文。旧试跑轨迹留在 `output/agent-benchmark-live-tested-traces/`，不与 v2 计算改进幅度。

## 真实 GPU 补测

用户提供临时模型凭据后，已完成以下实际运行，ComfyUI **0.41.2**，GPU **NVIDIA RTX A6000**。

| 阶段 | 实际执行 | 结果 |
| --- | --- | --- |
| Z-Image 文生图 | 现有工作流测试器生成 1024×1024 橙色陶瓷杯；冷启动 154.2 秒 | 文件实际下载，可见单个橙色杯子、木桌和浅灰背景；此阶段不是 Agent 自主选工具 |
| Agent 参考图编辑 | 真实 DeepSeek 决策，经 Qwen 传入原图资产；提交一次，136.008 秒 | 实际下载 1024×1024 编辑图，灰背景变为蓝色，主体和构图保持较好 |
| 独立视觉复核 | 新会话调用 `visual_critic`，禁止 GPU 生成 | 模型判为 fail：instruction 76/80；quality 88/75；identity 93/85；composition 95/80 |

编辑任务 ID：`mySPhLUKy6`；ComfyUI prompt ID：`e11a4174-dce9-44da-972f-d782fbc953a6`。真实参考图资产出现在任务的 `images` 中；没有以纯文生图冒充编辑，也没有重试。独立复核没有再提交生成。

执行链路成功不代表视觉要求全部满足。生成 Agent 和独立模型都指出背景蓝色比要求的「柔和浅蓝」更饱和。对原图与结果相同区域（x=100、y=100、800×200）的取色均值为 RGB `(205, 209, 209)` → `(154, 216, 244)`；这只证实颜色发生变化，不构成主观颜色要求的标准答案。上述分数来自模型，未获得用户质量确认。

还观察到生成 Agent 在文字答复中声称「约 45 秒」，与任务实测 136.008 秒不同。因此耗时以 TaskManager / Trace 为准，不采信自然语言中的估计。

本地证据：`output/gpu-smoke/zimage_00001_.png`、`output/agent-gpu-evaluation.json`、`output/agent-gpu-evaluation-assets/`。GPU 报告在源码提交 `3ffbb85` 结束时生成，工作区干净；测试启动时相关修改尚未提交。密钥只通过隐藏输入进入测试进程环境，没有写入设置、报告或 Git。

## 重现与继续

```bash
npm run benchmark:agent -- --profile both --output output/agent-benchmark-scripted.json
npm run benchmark:agent:live -- --output output/agent-benchmark-live.json
```

上面两个命令的生成端均为隔离的 Mock ComfyUI，不使用真实 GPU。真实 GPU 入口为 `npm run benchmark:agent:gpu -- --real-gpu`；可加 `--input` 复用已有图像，具体隔离和预算规则见使用说明。当前真实 GPU 样本仅检验一张产品图的编辑及复核，不能外推到人物一致性、完整视频时序或整体能力提升。

本地 JSON、Markdown 和逐例轨迹位于 `output/agent-benchmark-scripted-v2-committed*` 与 `output/agent-benchmark-live-v2*`，这些运行产物不提交 Git。完整使用说明见 [Agent Evaluation + Feedback Harness](agent-evaluation.md)。
