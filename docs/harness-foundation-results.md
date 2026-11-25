# Harness 四阶段验证结果

2026-11-25，隔离 worktree，消融与 GPU 实验源码 `5b17ba9e00408d1d2e3e2e458450891a9a1d744a`，两份报告均 `sourceDirty=false`。固定 fixture 指纹 `07170794efce123283d565ef5d5f51e87155e131ad633d2a41390fedcf9fcc60`，Mock 协议 `mock-tool-contract-v3`，Pi 1.4.0，Node 26.12.0。

机器可读的逐场景状态、资源汇总及真实执行记录见 [harness-foundation-results.json](harness-foundation-results.json)。原始 Trace 留在本地 `output/harness-final-*-traces/`，可使用实现文档中的命令复现。

## 固定决策的配置消融

| 配置 | 通过/评估/总数 | blocked | 工具调用 | 名义输入 Token | 名义输出 Token |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline，关闭专业 Harness 工具/上下文 | 20/20/20 | 0 | 42 | 574086 | 937 |
| enhanced + Context Providers | 20/20/20 | 0 | 42 | 740096 | 937 |
| enhanced + 原 focused Context | 20/20/20 | 0 | 42 | 740096 | 937 |

模型使用 `benchmark/scripted-v1`，每个场景的决策和最终回复都预先固定。这里的 Token 是 faux 模型给出的输入规模估计，不能视为真实供应商 Token 或实际费用。三组均无真实 LLM 调用和 GPU 生成，也不评估生成审美。

观察到的结论：

- 四十个 baseline/enhanced 运行全部通过，二十个 paired case 没有执行协议退化，也没有证实能力提升。
- 增强配置名义输入多 166010（约 28.9%），主要包含更多工具定义与 Harness 信息。不能宣称节省 Token；后续可据真实调用分布检验按任务提供工具定义是否值得做。
- 只切换 Context Provider/原 focused 时二十场景结果与规模相同。这些场景没有强制大型 DAG 的上下文压力，因此没有测出 Provider 排序的效率收益；必要约束超预算、去重、未知验证等边界由独立回归测试验证。
- 预期显存失败场景每组按要求执行一次模型切换；重试统计包括原有 retry_of 的修复场景。Mock 像素仍是占位素材，不据此验证修复后的画面。

## 真实执行恢复

同一源码提交在真实 ComfyUI 上另外运行恢复 smoke，不经过 Mock：

| 项目 | 结果 |
| --- | --- |
| ComfyUI / GPU | 0.41.2 / NVIDIA RTX A6000 |
| 模型 / seed / 输出 | Z-Image / 42 / 1024×1024 PNG |
| 实际 POST `/prompt` 次数 | 1 |
| 恢复前后任务 ID | 相同 |
| 恢复前后 promptId | `4e3c63c4-940d-4377-9e13-8d3aaac9635b`，相同 |
| 本地追踪关闭并重建后 | 从 queued 恢复到 done，取回真实图像 |
| 同一 operationKey 重放 | 返回原 Task，没有再次提交 |

该检查验证真实提交、持久化、重新连接与结果取回。固定 seed 的执行可能命中 ComfyUI 缓存；不据此报告推理速度、显存效率或视觉质量增益。生成 PNG 的 SHA256 保存于机器可读报告，本地文件为 `output/harness-recovery/recovered-image.png`。

## 其他检查与适用范围

- 发布前补充技能作用范围回退测试后，全量 `npm test`：310/310；`npm run build` 和 `npm run smoke` 通过。
- Chrome 1280×800：用户认可按钮实际写入 pass，成功提示出现，控制台 0 error / 0 warning；[截图](media/harness-acceptance.png)。
- 真实 LLM 创作质量对照本轮未运行；现有 [targeted 实验](agent-targeted-results.md) 的历史失败与局限保留，没有用新版 Mock 的成功覆盖旧失败。

这些结果支持合入可恢复、可控、可验证的基础设施。它们尚不足以支持增加新的视觉专用模块或声称 Agent 的综合创作能力提高。
