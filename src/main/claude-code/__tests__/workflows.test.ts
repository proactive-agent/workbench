import { describe, it, expect } from 'vitest';
import {
  interruptedWorkflowHint,
  interruptedWorkflows,
  parseWorkflowLaunch,
  usesWorkflows,
  workflowEnv,
  workflowSettings,
} from '../workflows';
import { summarizeToolInput } from '../task-log';
import {
  DEFAULT_CLAUDE_CODE_TASK_SETTINGS,
  type ClaudeRunInfo,
  type ClaudeRunWorkflow,
  type TaskTriage,
} from '../../../shared/types/claude-code';

const settings = DEFAULT_CLAUDE_CODE_TASK_SETTINGS;
const triage = (scope: TaskTriage['scope']) => ({ scope }) as TaskTriage;

describe('workflow settings', () => {
  it('passes the size guideline and the concurrency limit, or turns workflows off', () => {
    // The default keeps the user's own Claude Code guideline
    expect(workflowSettings(settings)).toBeUndefined();
    expect(workflowSettings({ ...settings, workflowSize: 'small' })).toEqual({ workflowSizeGuideline: 'small' });
    expect(workflowEnv(settings)).toEqual({});
    expect(workflowEnv({ ...settings, workflowMaxConcurrentAgents: 4 })).toEqual({ CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '4' });

    const off = { ...settings, workflowSize: 'off' as const, workflowMaxConcurrentAgents: 4 };
    expect(workflowSettings(off)).toBeUndefined();
    expect(workflowEnv(off)).toEqual({ CLAUDE_CODE_DISABLE_WORKFLOWS: '1' });
  });

  it('asks for workflows only for large tasks while they are on', () => {
    expect(usesWorkflows(settings, triage('large'))).toBe(true);
    expect(usesWorkflows(settings, triage('medium'))).toBe(false);
    expect(usesWorkflows(settings, undefined)).toBe(false);
    expect(usesWorkflows({ ...settings, workflowSize: 'off' }, triage('large'))).toBe(false);
  });

  it("reviews a change request by the larger of the task's and the request's scope", () => {
    expect(usesWorkflows(settings, triage('large'), triage('trivial'))).toBe(true);
    expect(usesWorkflows(settings, triage('small'), triage('large'))).toBe(true);
    expect(usesWorkflows(settings, triage('small'), triage('medium'))).toBe(false);
    expect(usesWorkflows({ ...settings, workflowSize: 'off' }, triage('small'), triage('large'))).toBe(false);
  });
});

describe('parseWorkflowLaunch', () => {
  it('reads the structured result, or the run id in the text', () => {
    expect(parseWorkflowLaunch({ status: 'async_launched', taskId: 't1', runId: 'wf_abc123', workflowName: 'review', scriptPath: '/s.js' }, ''))
      .toEqual({ runId: 'wf_abc123', taskId: 't1', name: 'review', scriptPath: '/s.js' });
    expect(parseWorkflowLaunch(undefined, 'Launched workflow run wf_def456-7 in the background')).toEqual({ runId: 'wf_def456-7' });
  });

  it('ignores a script that failed its syntax check, and results without a run', () => {
    expect(parseWorkflowLaunch({ status: 'async_launched', runId: 'wf_abc123', error: 'SyntaxError' }, '')).toBeNull();
    expect(parseWorkflowLaunch(undefined, 'nothing here')).toBeNull();
  });
});

describe('interruptedWorkflows', () => {
  const run = (fields: Partial<ClaudeRunWorkflow>): ClaudeRunWorkflow => ({
    runId: 'wf_aaaaaa', phase: 'implement', sessionId: 's1', status: 'stopped', startedAt: '2026-11-01T10:00:00.000Z', ...fields,
  });
  const info = (workflows: ClaudeRunWorkflow[], last: Record<string, unknown>): ClaudeRunInfo => ({
    phases: [{ name: 'triage', startedAt: '2026-11-01T09:00:00.000Z', endedAt: '2026-11-01T09:01:00.000Z' }, {
      name: 'implement', startedAt: '2026-11-01T09:30:00.000Z', ...last,
    }],
    subagents: [],
    workflows,
    totalCostUsd: 0,
    updatedAt: '',
  }) as ClaudeRunInfo;
  const interrupted = { endedAt: '2026-11-01T11:00:00.000Z', isError: true };

  it('offers an implement step the runs a resync launched while it carried on with the work', () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const base = (phases: ClaudeRunInfo['phases']): ClaudeRunInfo => ({
      phases: [
        { name: 'triage', startedAt: at(0), endedAt: at(1) },
        { name: 'implement', startedAt: at(2), endedAt: at(10), isError: true },
        ...phases,
      ],
      subagents: [],
      workflows: [
        run({ runId: 'wf_before', phase: 'implement', startedAt: at(5) }),
        run({ runId: 'wf_resync', phase: 'resync', startedAt: at(25) }),
      ],
      totalCostUsd: 0,
      updatedAt: '',
    });
    const carried = { name: 'resync' as const, startedAt: at(20), endedAt: at(30), isError: true, resync: { ref: 'main', into: 'main', continued: true } };
    // Cut off in the resync; the next start checks the merge, then continues implementing
    expect(interruptedWorkflows(base([carried]), 'implement', 's1', settings).map((r) => r.runId)).toEqual(['wf_resync']);
    // Cut off again in that implement step: still offered
    const again = base([carried, { name: 'implement', startedAt: at(35), endedAt: at(40), isError: true }]);
    expect(interruptedWorkflows(again, 'implement', 's1', settings).map((r) => r.runId)).toEqual(['wf_resync']);
    // A merge fix after it changed the code: stale
    const fixed = base([carried, { name: 'resync', startedAt: at(32), endedAt: at(34), resync: { ref: 'main', into: 'main', continued: false } }]);
    expect(interruptedWorkflows(fixed, 'implement', 's1', settings)).toEqual([]);
    // A resync that only merged ends the walk as before
    const merged = base([{ ...carried, resync: { ref: 'main', into: 'main', continued: false } }]);
    expect(interruptedWorkflows(merged, 'implement', 's1', settings)).toEqual([]);
  });

  it("finds the unfinished runs of the step being continued in the session's own runs", () => {
    const runs = [run({}), run({ runId: 'wf_bbbbbb', status: 'failed' }), run({ runId: 'wf_cccccc', status: 'completed' })];
    expect(interruptedWorkflows(info(runs, interrupted), 'implement', 's1', settings).map((r) => r.runId)).toEqual(['wf_aaaaaa', 'wf_bbbbbb']);
    // A step that crashed without an end counts as interrupted too
    expect(interruptedWorkflows(info(runs, {}), 'implement', 's1', settings)).toHaveLength(2);
  });

  it('leaves out other sessions, other steps, earlier attempts and steps that finished', () => {
    expect(interruptedWorkflows(info([run({ sessionId: 's2' })], interrupted), 'implement', 's1', settings)).toEqual([]);
    expect(interruptedWorkflows(info([run({ phase: 'validate' })], interrupted), 'implement', 's1', settings)).toEqual([]);
    expect(interruptedWorkflows(info([run({ startedAt: '2026-11-01T09:10:00.000Z' })], interrupted), 'implement', 's1', settings)).toEqual([]);
    expect(interruptedWorkflows(info([run({})], { endedAt: '2026-11-01T11:00:00.000Z' }), 'implement', 's1', settings)).toEqual([]);
    expect(interruptedWorkflows(info([run({})], interrupted), 'validate', 's1', settings)).toEqual([]);
    expect(interruptedWorkflows(info([run({})], interrupted), 'implement', undefined, settings)).toEqual([]);
    expect(interruptedWorkflows(info([run({})], interrupted), 'implement', 's1', { ...settings, workflowSize: 'off' })).toEqual([]);
  });

  it('passes on a run an attempt that was cut off again never relaunched', () => {
    const runs = [run({ startedAt: '2026-11-01T09:40:00.000Z' })];
    const twice = info(runs, interrupted);
    twice.phases.push({ name: 'implement', startedAt: '2026-11-01T12:00:00.000Z', endedAt: '2026-11-01T12:05:00.000Z', isError: true });
    expect(interruptedWorkflows(twice, 'implement', 's1', settings).map((r) => r.runId)).toEqual(['wf_aaaaaa']);
  });

  it('looks past the steps a revise run records before continuing an interrupted step', () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString();
    const base = info([], {});
    // A validation cut off by a usage limit, then a swap restart in revise mode: triage, revise, validate
    const validating: ClaudeRunInfo = {
      ...base,
      phases: [
        { name: 'implement', startedAt: at(0), endedAt: at(10) },
        { name: 'validate', startedAt: at(11), endedAt: at(20), isError: true },
        { name: 'triage', startedAt: at(21), endedAt: at(22) },
        { name: 'revise', startedAt: at(23), endedAt: at(30) },
      ],
      workflows: [run({ runId: 'wf_review', phase: 'validate', startedAt: at(12) }), run({ runId: 'wf_revise', phase: 'revise', startedAt: at(24) })],
    } as ClaudeRunInfo;
    // The revise changed the code after the review was launched: its agents' findings are stale
    expect(interruptedWorkflows(validating, 'validate', 's1', settings)).toEqual([]);
    // A revise that was cut off (nothing finished) is looked past
    const cutOff = { ...validating, phases: validating.phases.map((p) => p.name === 'revise' ? { ...p, isError: true } : p) };
    expect(interruptedWorkflows(cutOff, 'validate', 's1', settings).map((r) => r.runId)).toEqual(['wf_review']);
    // ... unless the commit the review saw moved on
    cutOff.workflows = [run({ runId: 'wf_review', phase: 'validate', startedAt: at(12), head: 'aaa' })];
    expect(interruptedWorkflows(cutOff, 'validate', 's1', settings, 'aaa').map((r) => r.runId)).toEqual(['wf_review']);
    expect(interruptedWorkflows(cutOff, 'validate', 's1', settings, 'bbb')).toEqual([]);
    // A resync after the review, even a failed one, may have merged: stale
    const resynced = { ...cutOff, phases: [...cutOff.phases, { name: 'resync' as const, startedAt: at(31), endedAt: at(32), isError: true }] };
    expect(interruptedWorkflows(resynced, 'validate', 's1', settings, 'aaa')).toEqual([]);
    // A validation cut off again after the revise passes on only the runs launched since
    validating.phases.push({ name: 'validate', startedAt: at(31), endedAt: at(35), isError: true });
    validating.workflows!.push(run({ runId: 'wf_review2', phase: 'validate', startedAt: at(32) }));
    expect(interruptedWorkflows(validating, 'validate', 's1', settings).map((r) => r.runId)).toEqual(['wf_review2']);
    validating.phases.pop();
    validating.workflows!.pop();
    // An interrupted revise continued after the fresh triage
    const revising: ClaudeRunInfo = {
      ...base,
      phases: [
        { name: 'revise', startedAt: at(0), endedAt: at(10), isError: true },
        { name: 'triage', startedAt: at(11), endedAt: at(12) },
      ],
      workflows: [run({ runId: 'wf_fix', phase: 'revise', startedAt: at(1) })],
    } as ClaudeRunInfo;
    expect(interruptedWorkflows(revising, 'revise', 's1', settings).map((r) => r.runId)).toEqual(['wf_fix']);
    // A validation that finished after the interrupted one is the last word
    validating.phases.push({ name: 'validate', startedAt: at(31), endedAt: at(40) });
    expect(interruptedWorkflows(validating, 'validate', 's1', settings)).toEqual([]);
  });

  it('gives a resync that carries on an interrupted implementation its runs', () => {
    const withResync = info([run({})], interrupted);
    withResync.phases.push({ name: 'resync', startedAt: '2026-11-01T12:00:00.000Z', endedAt: '2026-11-01T12:05:00.000Z', isError: true });
    expect(interruptedWorkflows(withResync, ['resync', 'implement'], 's1', settings).map((r) => r.runId)).toEqual(['wf_aaaaaa']);
    // A resync of its own (not continuing) doesn't relaunch the implementation's runs
    expect(interruptedWorkflows(withResync, 'resync', 's1', settings)).toEqual([]);
  });

  it('tells the step to relaunch with resumeFromRunId and the same script', () => {
    expect(interruptedWorkflowHint([])).toBe('');
    const hint = interruptedWorkflowHint([run({ name: 'migrate', scriptPath: '/runs/wf.js' })]);
    expect(hint).toContain('`wf_aaaaaa` "migrate", script `/runs/wf.js`');
    expect(hint).toContain('resumeFromRunId');
  });
});

describe('summarizeToolInput for Workflow', () => {
  it("names the workflow from its script's meta, or the saved name, and a resume", () => {
    expect(summarizeToolInput('Workflow', { script: "export const meta = { name: 'review-diff', description: 'x' }" })).toBe('review-diff');
    expect(summarizeToolInput('Workflow', { name: 'deep-research', resumeFromRunId: 'wf_abcdef' })).toBe('deep-research, resuming wf_abcdef');
  });
});
