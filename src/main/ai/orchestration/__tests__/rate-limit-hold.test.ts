/**
 * Rate-limit hold in the build pipeline: a session that hits a provider limit
 * with a known reset time stops the build (no in-process wait) and reports a
 * hold so the main process can queue and later resume the task.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { iterateSubtasks } from '../subtask-iterator';
import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';
import { RATE_LIMIT_PAUSE_FILE } from '../pause-handler';
import type { SessionResult } from '../../session/types';

const RESET_AT = '2099-01-01T16:30:00.000Z';
const LIMIT_MESSAGE = "You've hit your session limit · resets 8:30pm (Asia/Yerevan)";

function rateLimitedResult(): SessionResult {
  return {
    outcome: 'rate_limited',
    stepsExecuted: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    error: { code: 'rate_limited', message: LIMIT_MESSAGE, retryable: true, rateLimitResetAt: RESET_AT },
    messages: [],
    durationMs: 1,
    toolCallCount: 0,
  };
}

function completedResult(): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    messages: [],
    durationMs: 1,
    toolCallCount: 1,
  };
}

function makePlan(statuses: string[]) {
  return {
    feature: 'Test',
    workflow_type: 'feature',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        subtasks: statuses.map((status, i) => ({
          id: `subtask-1-${i + 1}`,
          title: `Subtask ${i + 1}`,
          description: `Do thing ${i + 1}`,
          status,
        })),
      },
    ],
  };
}

describe('rate-limit hold', () => {
  let specDir: string;
  let planPath: string;

  beforeEach(async () => {
    specDir = await mkdtemp(join(tmpdir(), 'rate-limit-hold-test-'));
    planPath = join(specDir, 'implementation_plan.json');
  });

  afterEach(async () => {
    await rm(specDir, { recursive: true, force: true });
  });

  describe('iterateSubtasks', () => {
    it('stops immediately with a hold instead of waiting when the reset time is known', async () => {
      await writeFile(planPath, JSON.stringify(makePlan(['completed', 'pending'])));
      const runSubtaskSession = vi.fn().mockResolvedValue(rateLimitedResult());

      const result = await iterateSubtasks({
        specDir,
        projectDir: specDir,
        maxRetries: 3,
        autoContinueDelayMs: 0,
        runSubtaskSession,
      });

      expect(runSubtaskSession).toHaveBeenCalledTimes(1);
      expect(result.cancelled).toBe(false);
      expect(result.rateLimitHold).toEqual({ resetAt: RESET_AT, message: LIMIT_MESSAGE });
      expect(result.completedSubtasks).toBe(1);

      // The interrupted subtask is NOT marked completed (it resumes later)
      const plan = JSON.parse(await readFile(planPath, 'utf-8'));
      expect(plan.phases[0].subtasks[1].status).toBe('pending');
    });
  });

  describe('BuildOrchestrator', () => {
    function createOrchestrator(runSession: (config: SessionRunConfig) => Promise<SessionResult>) {
      return new BuildOrchestrator({
        specDir,
        projectDir: specDir,
        generatePrompt: async () => 'prompt',
        runSession,
      });
    }

    it('reports a coding-phase hold without entering the failed phase', async () => {
      await writeFile(planPath, JSON.stringify(makePlan(['completed', 'pending'])));
      const runSession = vi.fn().mockResolvedValue(rateLimitedResult());
      const orchestrator = createOrchestrator(runSession);
      const phases: string[] = [];
      orchestrator.on('phase-change', (phase: string) => phases.push(phase));

      const outcome = await orchestrator.run();

      expect(outcome.success).toBe(false);
      expect(outcome.rateLimitHold).toEqual({ resetAt: RESET_AT, message: LIMIT_MESSAGE, phase: 'coding' });
      expect(phases).not.toContain('failed');
      expect(outcome.finalPhase).toBe('coding');

      const marker = JSON.parse(await readFile(join(specDir, RATE_LIMIT_PAUSE_FILE), 'utf-8'));
      expect(marker.resetTimestamp).toBe(RESET_AT);
      expect(marker.phase).toBe('coding');
    });

    it('reports a QA-phase hold', async () => {
      await writeFile(planPath, JSON.stringify(makePlan(['pending'])));
      const runSession = vi.fn(async (config: SessionRunConfig) => {
        if (config.agentType === 'coder') {
          // The coder completes its subtask
          await writeFile(planPath, JSON.stringify(makePlan(['completed'])));
          return completedResult();
        }
        return rateLimitedResult();
      });

      const outcome = await createOrchestrator(runSession).run();

      expect(outcome.rateLimitHold?.phase).toBe('qa_review');
      expect(outcome.codingCompleted).toBe(true);
    });

    it('resumes QA (instead of declaring completion) after a QA-phase hold', async () => {
      await writeFile(planPath, JSON.stringify(makePlan(['completed'])));
      await writeFile(
        join(specDir, RATE_LIMIT_PAUSE_FILE),
        JSON.stringify({ pausedAt: '2026-01-01T00:00:00Z', resetTimestamp: RESET_AT, error: LIMIT_MESSAGE, phase: 'qa_review' }),
      );
      const runSession = vi.fn(async (config: SessionRunConfig) => {
        if (config.agentType === 'qa_reviewer') {
          await writeFile(join(specDir, 'qa_report.md'), 'Status: PASSED');
        }
        return completedResult();
      });

      const outcome = await createOrchestrator(runSession).run();

      expect(runSession).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'qa_reviewer' }));
      expect(outcome.success).toBe(true);
      expect(existsSync(join(specDir, RATE_LIMIT_PAUSE_FILE))).toBe(false);
    });

    it('still treats a completed build without a hold marker as complete', async () => {
      await writeFile(planPath, JSON.stringify(makePlan(['completed'])));
      const runSession = vi.fn().mockResolvedValue(completedResult());

      const outcome = await createOrchestrator(runSession).run();

      expect(outcome.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
    });
  });
});
