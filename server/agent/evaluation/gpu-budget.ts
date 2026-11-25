/** Evaluation-only guard: reserve an attempt before any asynchronous GPU submission. */
export class GpuSubmissionBudget {
  private limit = 0;
  private used = 0;
  private active = 0;

  start(limit: number) {
    if (this.active) throw new Error('A GPU submission is still in flight');
    if (!Number.isInteger(limit) || limit < 0 || limit > 4) throw new Error('Invalid GPU evaluation limit');
    this.limit = limit;
    this.used = 0;
  }

  async submit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.used >= this.limit) throw new Error('真实 GPU 评估生成预算已用完；本阶段不能再提交，请报告当前结果');
    this.used++;
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }
}
