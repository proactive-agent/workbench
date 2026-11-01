import { describe, it, expect } from 'vitest';
import { buildMcpConfig } from '../mcp-config';
import { resolveClaudeCodeTaskSettings } from '../settings';
import { applyPlanningPolicy, fixedTriage } from '../triage';
import { isClaudeRunFinished } from '../task-runner';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS } from '../../../shared/types/claude-code';

describe('buildMcpConfig', () => {
  it('maps built-in and tested custom connectors to --mcp-config servers', () => {
    const config = buildMcpConfig(['context7', 'my server', 'untested'], {
      customServers: [
        { id: 'my server', name: 'My Server', type: 'http', url: 'https://example.com/mcp', verified: true },
        { id: 'untested', name: 'Untested', type: 'command', command: 'npx', verified: false },
      ],
    } as never);
    expect(Object.keys(config.mcpServers)).toEqual(['context7', 'My_Server']);
    expect(config.mcpServers.My_Server).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: undefined });
  });

  it('uses the Connectors defaults when the task has no choice', () => {
    expect(Object.keys(buildMcpConfig(undefined, undefined).mcpServers)).toEqual(['context7']);
    expect(buildMcpConfig([], undefined).mcpServers).toEqual({});
  });
});

describe('resolveClaudeCodeTaskSettings', () => {
  it('fills defaults and drops invalid values', () => {
    expect(resolveClaudeCodeTaskSettings(undefined)).toEqual(DEFAULT_CLAUDE_CODE_TASK_SETTINGS);
    const resolved = resolveClaudeCodeTaskSettings({ fixedModel: 'gpt' as never, planning: 'sometimes' as never, validation: false });
    expect(resolved.fixedModel).toBe('sonnet');
    expect(resolved.planning).toBe('auto');
    expect(resolved.validation).toBe(false);
  });

  it('keeps valid workflow limits and drops invalid ones', () => {
    expect(resolveClaudeCodeTaskSettings(undefined).workflowSize).toBe('default');
    expect(resolveClaudeCodeTaskSettings({ workflowSize: 'off' }).workflowSize).toBe('off');
    expect(resolveClaudeCodeTaskSettings({ workflowSize: 'huge' as never }).workflowSize).toBe('default');
    expect(resolveClaudeCodeTaskSettings({ workflowMaxConcurrentAgents: 8 }).workflowMaxConcurrentAgents).toBe(8);
    for (const bad of [0, 257, 2.5, Number.NaN]) {
      expect(resolveClaudeCodeTaskSettings({ workflowMaxConcurrentAgents: bad })).not.toHaveProperty('workflowMaxConcurrentAgents');
    }
  });
});

describe('planning policy', () => {
  it('overrides the triage decision', () => {
    const base = fixedTriage(DEFAULT_CLAUDE_CODE_TASK_SETTINGS, 'T', 'fixed', '');
    expect(applyPlanningPolicy(base, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'always' }).needsPlan).toBe(true);
    expect(applyPlanningPolicy({ ...base, needsPlan: true }, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'never' }).needsPlan).toBe(false);
  });
});

describe('isClaudeRunFinished', () => {
  const run = (phases: Array<Record<string, unknown>>) => ({ phases, subagents: [], totalCostUsd: 0, updatedAt: '' }) as never;
  const done = { startedAt: 'a', endedAt: 'b' };

  it('is finished after a successful validation, or implementation when validation is off', () => {
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }, { name: 'validate', ...done }]), true)).toBe(true);
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }]), true)).toBe(false);
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }]), false)).toBe(true);
  });

  it('is not finished when the last step failed or is still running', () => {
    expect(isClaudeRunFinished(run([{ name: 'validate', ...done, isError: true }]), true)).toBe(false);
    expect(isClaudeRunFinished(run([{ name: 'validate', startedAt: 'a' }]), true)).toBe(false);
    expect(isClaudeRunFinished(null, true)).toBe(false);
  });
});
