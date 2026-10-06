import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

vi.mock('../../../client/factory', () => ({
  createSimpleClient: vi.fn(async () => ({ model: {}, systemPrompt: 'system' })),
}));

import { generateText } from 'ai';
import { ParallelFollowupReviewer } from '../parallel-followup';

type RunSpecialist = (
  type: string,
  prompt: string,
  model: string,
  thinking: string,
) => Promise<{ type: string; result: string }>;

function runSpecialist(type: string): Promise<{ type: string; result: string }> {
  const reviewer = new ParallelFollowupReviewer({ repo: 'owner/repo' });
  const fn = (reviewer as unknown as { runSpecialist: RunSpecialist }).runSpecialist.bind(reviewer);
  return fn(type, 'prompt', 'sonnet', 'low');
}

function schemaMismatch(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    text,
    response: {} as never,
    usage: {} as never,
    finishReason: 'stop',
  });
}

describe('ParallelFollowupReviewer specialist output fallback', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
  });

  it('returns the raw text when the structured output does not match the schema', async () => {
    const raw = '{"findings":[{"title":"t","file":"a.ts","line":1,"category":"duplication","severity":"high"}]}';
    vi.mocked(generateText).mockRejectedValueOnce(schemaMismatch(raw));

    const result = await runSpecialist('new-code-reviewer');

    expect(result).toEqual({ type: 'new-code-reviewer', result: raw });
  });

  it('returns the raw text when reading the output throws (e.g. finishReason length)', async () => {
    const raw = '{"verifications":[]}';
    const result = {
      text: raw,
      get output(): never {
        throw new NoOutputGeneratedError({ message: 'No output generated.' });
      },
    };
    vi.mocked(generateText).mockResolvedValueOnce(result as never);

    expect(await runSpecialist('resolution-verifier')).toEqual({ type: 'resolution-verifier', result: raw });
  });

  it('still rethrows errors that are not schema mismatches', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('network down'));

    await expect(runSpecialist('resolution-verifier')).rejects.toThrow('network down');
  });
});
