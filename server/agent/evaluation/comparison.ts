import type { BenchmarkResult } from './types.ts';

export interface EnhancementReport {
  revision: string;
  sourceDirty: boolean;
  fixtureVersion: string;
  environment: { model: string; mode: string; enhancement?: string };
  results: BenchmarkResult[];
}

/** Same Harness, model, source and fixtures; only the targeted enhancement package changes. */
export function compareEnhancements(before: EnhancementReport, after: EnhancementReport) {
  const reasons: string[] = [];
  if (before.sourceDirty || after.sourceDirty || before.revision !== after.revision) reasons.push('Source must be the same clean commit');
  if (before.fixtureVersion !== after.fixtureVersion) reasons.push('Fixture/protocol versions differ');
  if (before.environment.model !== after.environment.model || before.environment.mode !== after.environment.mode) reasons.push('Model or execution mode differs');
  if (before.environment.enhancement !== 'legacy' || after.environment.enhancement !== 'targeted') reasons.push('Expected stage-one legacy and stage-two targeted configurations');
  const pairs = reasons.length ? [] : before.results.flatMap((control) => {
    const treatment = after.results.find((result) => result.id === control.id && result.profile === control.profile && result.model === control.model && result.mode === control.mode);
    if (control.status === 'blocked' || !treatment || treatment.status === 'blocked') return [];
    return [{ id: control.id, before: control.passed, after: treatment.passed,
      toolCallsDelta: treatment.metrics.toolCalls - control.metrics.toolCalls,
      totalTokensDelta: treatment.metrics.inputTokens + treatment.metrics.outputTokens - control.metrics.inputTokens - control.metrics.outputTokens,
      paidTokensDelta: treatment.metrics.paidTokens - control.metrics.paidTokens,
      generationsDelta: treatment.metrics.generations - control.metrics.generations,
      retriesDelta: treatment.metrics.retries - control.metrics.retries,
    }];
  });
  return { comparable: !reasons.length && pairs.length > 0, reasons, pairedCases: pairs.length, excludedControlCases: before.results.length - pairs.length,
    improved: pairs.filter((pair) => !pair.before && pair.after).length, regressed: pairs.filter((pair) => pair.before && !pair.after).length, unchanged: pairs.filter((pair) => pair.before === pair.after).length,
    toolCallsDelta: pairs.reduce((n, pair) => n + pair.toolCallsDelta, 0), totalTokensDelta: pairs.reduce((n, pair) => n + pair.totalTokensDelta, 0), pairs };
}
