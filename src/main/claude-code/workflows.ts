/**
 * Workflows for large tasks
 * =========================
 *
 * A Claude Code workflow is a script Claude writes that runs many subagents in parallel or in
 * stages; their results stay in the script instead of the session's context
 * (https://code.claude.com/docs/en/workflows). Task runs use them when triage sizes a task as
 * large: validation reviews the change from several angles and checks each finding before it is
 * reported, and the implementation may fan out across many files.
 *
 * - `claude -p` never asks to approve a launch; the Workflow call goes through the session's
 *   permission checks, which an isolated task run skips. The `ultracode` keyword does not count
 *   in a `-p` prompt, but a request in plain words does, so the turns ask for a workflow directly.
 * - Settings > Agents > Limits sets the size guideline (`workflowSizeGuideline`, advice to Claude
 *   on how many agents to aim for; `default` keeps the user's own) and how many agents run at once
 *   (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`); `off` disables workflows in task runs.
 * - A relaunch with `resumeFromRunId` in the same session returns the saved results of the agents
 *   that already finished. The run records each launch (`ClaudeRunInfo.workflows`), so a step
 *   continued after a stop or a usage limit is told which run to relaunch.
 */

import type {
  ClaudeCodeTaskSettings,
  ClaudeRunInfo,
  ClaudeRunPhaseName,
  ClaudeRunWorkflow,
  TaskTriage,
} from '../../shared/types/claude-code';

/** Environment for a task run's Claude Code process */
export function workflowEnv(settings: ClaudeCodeTaskSettings): Record<string, string> {
  if (settings.workflowSize === 'off') return { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' };
  const concurrency = settings.workflowMaxConcurrentAgents;
  return concurrency ? { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: String(concurrency) } : {};
}

/**
 * Claude Code settings (`--settings`) for a task run, or undefined when workflows are off or the
 * size is left to the user's own Claude Code configuration (a `--settings` value would override it)
 */
export function workflowSettings(settings: ClaudeCodeTaskSettings): { workflowSizeGuideline: string } | undefined {
  const size = settings.workflowSize;
  return size === 'off' || size === 'default' ? undefined : { workflowSizeGuideline: size };
}

/** Whether the task's turns ask for workflows: they are on, and triage sized the task as large */
export function usesWorkflows(settings: ClaudeCodeTaskSettings, triage: TaskTriage | undefined): boolean {
  return settings.workflowSize !== 'off' && triage?.scope === 'large';
}

/** Validation's review step for a large task: a multi-angle review whose findings are each checked */
export function workflowReviewStep(baseBranch: string): string {
  return `Review the full change against \`${baseBranch}\` (\`git diff ${baseBranch}...HEAD\` plus any uncommitted changes) with fresh eyes, and use a workflow for it: run the Workflow tool with a review that reads the diff from several independent angles (correctness and edge cases, the task's requirements, error handling and failure paths, the project's CLAUDE.md rules and conventions), then has a separate agent check each finding against the code and keeps only the findings it confirms. Keep it within the workflow size guideline and wait for its result before going on. If the Workflow tool isn't available or the launch is refused, use the /code-review skill instead, or a subagent that sees only the diff and the task. Fix only confirmed findings that affect correctness or the task's requirements; don't gold-plate. If review agents failed (for example at a usage limit), name the angles left unreviewed and report "partial" at most.`;
}

/** Added to the implement turn of a large task */
export function workflowImplementHint(): string {
  return `This task is large, so you may use a workflow (the Workflow tool) for changes that span many files and can be made independently: give each agent its own files so no two agents edit the same file, keep the scale within the workflow size guideline, and verify and commit the combined result yourself in this session. Work directly when the changes are tightly coupled.`;
}

/**
 * Workflow runs the step being continued launched and never finished: the last steps recorded are
 * attempts at the same step that ended early (stopped, rate limited, failed or crashed), the runs
 * started during those attempts (an attempt that was cut off again before relaunching a run still
 * passes it on), and they belong to the session that continues the step (a run can only be resumed
 * in the session that launched it). Nothing when workflows are off: the Workflow tool is gone.
 */
export function interruptedWorkflows(
  info: ClaudeRunInfo,
  phase: ClaudeRunPhaseName,
  sessionId: string | undefined,
  settings: ClaudeCodeTaskSettings,
): ClaudeRunWorkflow[] {
  if (!sessionId || settings.workflowSize === 'off') return [];
  let since: string | undefined;
  for (let index = info.phases.length - 1; index >= 0; index--) {
    const attempt = info.phases[index];
    if (attempt.name !== phase || (attempt.endedAt && !attempt.isError)) break;
    since = attempt.startedAt;
  }
  if (!since) return [];
  const from = since;
  return (info.workflows ?? []).filter((run) =>
    run.phase === phase && run.sessionId === sessionId && run.status !== 'completed' && run.startedAt >= from);
}

/** Tells the continued step to relaunch its interrupted workflow runs, reusing the agents that finished */
export function interruptedWorkflowHint(runs: ClaudeRunWorkflow[]): string {
  if (runs.length === 0) return '';
  const list = runs.map((run) => {
    const name = run.name ? ` "${run.name.replace(/"/g, "'")}"` : '';
    const script = run.scriptPath ? `, script \`${run.scriptPath}\`` : '';
    return `- run \`${run.runId}\`${name}${script}`;
  }).join('\n');
  return `\n\nThis step was interrupted while ${runs.length === 1 ? 'a workflow was' : 'workflows were'} still running:
${list}
If you still need ${runs.length === 1 ? 'it' : 'them'}, relaunch with the Workflow tool, passing \`resumeFromRunId\` and the same script (its \`scriptPath\`), so the agents that already finished return their saved results instead of running again.`;
}

/** The run id a Workflow tool result names, from its structured result or its text */
export function parseWorkflowLaunch(
  toolUseResult: unknown,
  text: string,
): { runId: string; taskId?: string; name?: string; scriptPath?: string } | null {
  const result = (toolUseResult && typeof toolUseResult === 'object' ? toolUseResult : {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  // A script that fails its syntax check is "launched" with an error and never runs
  if (str(result.error)) return null;
  const runId = str(result.runId) ?? /\bwf_[A-Za-z0-9-]{6,}/.exec(text)?.[0];
  if (!runId) return null;
  return {
    runId,
    taskId: str(result.taskId),
    name: str(result.workflowName),
    scriptPath: str(result.scriptPath),
  };
}
