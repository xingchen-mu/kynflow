import { AsyncLocalStorage } from 'node:async_hooks';
import type { Task, TaskRequest } from '../../../shared/types.ts';
import type { TaskManager } from '../../tasks/manager.ts';
import { ToolExecutionError } from '../tool-errors.ts';
import type { RunController } from './run-controller.ts';

export interface SubmissionScope {
  controller: RunController;
  signal?: AbortSignal;
  owner: Omit<NonNullable<Task['agentOwner']>, 'operationKey'>;
  callId: string;
  reserveSessionGeneration(): Promise<void>;
}

/** All Agent tool paths, including batches and delayed approval, pass one submission boundary. */
export class AgentSubmissions {
  private scope = new AsyncLocalStorage<SubmissionScope & { index: number }>();
  within<T>(context: SubmissionScope, operation: () => Promise<T>): Promise<T> { return this.scope.run({ ...context, index: 0 }, operation); }

  guard(manager: TaskManager): TaskManager {
    return new Proxy(manager, { get: (target, property) => {
      if (property === 'create') return async (request: TaskRequest, id?: string) => {
        const context = this.scope.getStore();
        if (!context) throw new ToolExecutionError('PERMISSION_DENIED', 'Agent 生成必须处于有效执行范围内');
        context.controller.check();
        context.signal?.throwIfAborted();
        const index = context.index++;
        const owner = context.owner;
        const key = owner.graphTaskId ? `${owner.projectId}/${owner.sessionId}/${owner.graphTaskId}/${owner.attempt}/${index}` : `${owner.projectId}/${owner.sessionId}/${owner.runId}/${context.callId}/${index}`;
        const previous = manager.list().find((task) => task.agentOwner?.operationKey === key);
        if (previous) {
          if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new ToolExecutionError('STALE_STATE', '这次任务尝试已提交过不同参数；先检查原任务，不能重复提交');
          return previous;
        }
        context.controller.reserve('generations');
        await context.reserveSessionGeneration();
        context.controller.check();
        context.signal?.throwIfAborted();
        return manager.create(request, id, { signal: context.signal ? AbortSignal.any([context.signal, context.controller.signal]) : context.controller.signal, owner: { ...owner, operationKey: key } });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
