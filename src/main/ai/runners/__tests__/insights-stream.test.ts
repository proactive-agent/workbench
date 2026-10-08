/**
 * Insights runner against a mock language model (real `streamText`, no network).
 * Covers how successful answers, provider errors and empty answers surface to callers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { simulateReadableStream, APICallError, RetryError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

const mockCreateSimpleClient = vi.fn();
vi.mock('../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: vi.fn(),
  readdirSync: () => [],
}));

vi.mock('../../tools/build-registry', () => ({
  buildToolRegistry: () => ({ getToolsForAgent: () => ({}) }),
}));

import { runInsightsQuery, describeModelError, type InsightsStreamEvent } from '../insights';
import { INSIGHTS_ERROR_CODES, parseInsightsError } from '../../../../shared/constants/insights';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type StreamChunk = Record<string, unknown> & { type: string };

/** Mock model whose single step streams the given chunks */
function modelStreaming(chunks: StreamChunk[]) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: simulateReadableStream({ chunks: chunks as any[] }),
    }),
  });
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
  ];
}

function useModel(model: MockLanguageModelV3) {
  mockCreateSimpleClient.mockResolvedValue({ model, systemPrompt: 'system', tools: {}, maxSteps: 5 });
}

async function run() {
  const events: InsightsStreamEvent[] = [];
  const promise = runInsightsQuery({ projectDir: '/project', message: 'hello' }, (e) => events.push(e));
  return { promise, events };
}

describe('runInsightsQuery with a mock model', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams and returns the answer text', async () => {
    useModel(modelStreaming(textChunks('Hi there!')));
    const { promise, events } = await run();
    const result = await promise;
    expect(result.text).toBe('Hi there!');
    expect(events).toContainEqual({ type: 'text-delta', text: 'Hi there!' });
  });

  it('rejects when the provider reports an error mid-stream (e.g. 401 / 429)', async () => {
    useModel(modelStreaming([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: new Error('invalid x-api-key') },
    ]));
    const { promise } = await run();
    await expect(promise).rejects.toThrow('invalid x-api-key');
  });

  it('rejects when the request itself fails', async () => {
    useModel(new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('Overloaded');
      },
    }));
    const { promise } = await run();
    await expect(promise).rejects.toThrow('Overloaded');
  });

  it('rejects when the model finishes without producing any text', async () => {
    useModel(modelStreaming([
      { type: 'stream-start', warnings: [] },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
    ]));
    const { promise } = await run();
    await expect(promise).rejects.toThrow(/empty response/i);
  });
});

describe('describeModelError', () => {
  const apiError = (statusCode: number, body: unknown, message = 'Error') =>
    new APICallError({
      message,
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify(body),
      isRetryable: statusCode === 429 || statusCode >= 500,
    });

  it('flags the generic 429 "Error" (subscription token rejected), even when wrapped in retries', () => {
    const last = apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Error' }, request_id: 'req_123' });
    const retry = new RetryError({ message: 'Failed after 3 attempts. Last error: Error', reason: 'maxRetriesExceeded', errors: [last, last, last] });

    const description = describeModelError(retry);

    expect(parseInsightsError(description)).toEqual({
      code: INSIGHTS_ERROR_CODES.subscriptionRejected,
      details: 'HTTP 429: rate_limit_error: Error (request req_123)',
    });
  });

  it('keeps genuine rate limits as plain messages', () => {
    const error = apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } });
    const description = describeModelError(error);
    expect(parseInsightsError(description).code).toBeNull();
    expect(description).toBe('HTTP 429: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit');
  });

  it('reports status and provider message for other API errors', () => {
    expect(describeModelError(apiError(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })))
      .toBe('HTTP 401: authentication_error: invalid x-api-key');
  });

  it('redacts keys echoed in messages', () => {
    expect(describeModelError(new Error('bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz'))).toBe('bad key sk-***');
  });

  it('surfaces the description through runInsightsQuery', async () => {
    useModel(modelStreaming([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: apiError(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }) },
    ]));
    const { promise } = await run();
    await expect(promise).rejects.toThrow('HTTP 401: authentication_error: invalid x-api-key');
  });
});
