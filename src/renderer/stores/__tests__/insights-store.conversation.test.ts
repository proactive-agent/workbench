/**
 * @vitest-environment jsdom
 */
/**
 * Mock Insights conversations: drive the renderer store through the same IPC events the
 * main process emits (stream chunks, status, error, session-updated) and check the UI state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InsightsChatStatus, InsightsSession, InsightsStreamChunk } from '../../../shared/types';

type ChunkListener = (projectId: string, chunk: InsightsStreamChunk) => void;
type StatusListener = (projectId: string, status: InsightsChatStatus) => void;
type ErrorListener = (projectId: string, error: string) => void;
type SessionListener = (projectId: string, session: InsightsSession) => void;

const listeners = {
  chunk: [] as ChunkListener[],
  status: [] as StatusListener[],
  error: [] as ErrorListener[],
  session: [] as SessionListener[]
};

function session(projectId: string, overrides: Partial<InsightsSession> = {}): InsightsSession {
  return {
    id: `session-${projectId}`,
    projectId,
    title: 'New Conversation',
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  } as InsightsSession;
}

const electronAPI = {
  onInsightsStreamChunk: vi.fn((cb: ChunkListener) => {
    listeners.chunk.push(cb);
    return () => {};
  }),
  onInsightsStatus: vi.fn((cb: StatusListener) => {
    listeners.status.push(cb);
    return () => {};
  }),
  onInsightsError: vi.fn((cb: ErrorListener) => {
    listeners.error.push(cb);
    return () => {};
  }),
  onInsightsSessionUpdated: vi.fn((cb: SessionListener) => {
    listeners.session.push(cb);
    return () => {};
  }),
  getInsightsSession: vi.fn(async (projectId: string) => ({ success: true, data: session(projectId) })),
  listInsightsSessions: vi.fn(async () => ({ success: true, data: [] })),
  sendInsightsMessage: vi.fn(),
  newInsightsSession: vi.fn(async (projectId: string) => ({ success: true, data: session(projectId, { id: 'session-new' }) }))
};

// Emitters mirroring what InsightsExecutor/InsightsService send over IPC
const emit = {
  chunk: (projectId: string, chunk: InsightsStreamChunk) => listeners.chunk.forEach((cb) => cb(projectId, chunk)),
  status: (projectId: string, status: InsightsChatStatus) => listeners.status.forEach((cb) => cb(projectId, status)),
  error: (projectId: string, error: string) => listeners.error.forEach((cb) => cb(projectId, error)),
  session: (projectId: string, s: InsightsSession) => listeners.session.forEach((cb) => cb(projectId, s))
};

let store: typeof import('../insights-store');
let cleanup: () => void;

beforeEach(async () => {
  vi.resetModules();
  listeners.chunk = [];
  listeners.status = [];
  listeners.error = [];
  listeners.session = [];
  vi.clearAllMocks();
  (window as unknown as { electronAPI: typeof electronAPI }).electronAPI = electronAPI;
  store = await import('../insights-store');
  cleanup = store.setupInsightsListeners();
  await store.loadInsightsSession('project-a');
});

afterEach(() => cleanup());

const state = () => store.useInsightsStore.getState();

describe('Insights mock conversations', () => {
  it('shows the user message, streams the answer and ends idle-complete', () => {
    store.sendMessage('project-a', 'How is auth implemented?');
    expect(state().session?.messages.map((m) => m.role)).toEqual(['user']);
    expect(state().status.phase).toBe('thinking');

    emit.status('project-a', { phase: 'thinking', message: 'Processing your message...' });
    emit.chunk('project-a', { type: 'tool_start', tool: { name: 'Grep', input: 'pattern: auth' } });
    expect(state().currentTool?.name).toBe('Grep');
    emit.chunk('project-a', { type: 'tool_end', tool: { name: 'Grep' } });
    emit.chunk('project-a', { type: 'text', content: 'Auth uses ' });
    emit.chunk('project-a', { type: 'text', content: 'JWT.' });
    expect(state().streamingContent).toBe('Auth uses JWT.');

    emit.chunk('project-a', { type: 'done' });
    emit.status('project-a', { phase: 'complete' });

    const messages = state().session?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('Auth uses JWT.');
    expect(messages[1].toolsUsed?.[0].name).toBe('Grep');
    expect(state().streamingContent).toBe('');
    expect(state().status.phase).toBe('complete');
  });

  it('keeps the error visible when the request fails (runner rejects: error chunk + error event)', () => {
    store.sendMessage('project-a', 'hello');
    emit.status('project-a', { phase: 'thinking', message: 'Processing your message...' });

    // InsightsExecutor's catch path: an error chunk, then the error event — and no "done"
    emit.chunk('project-a', { type: 'error', error: 'invalid x-api-key' });
    emit.error('project-a', 'invalid x-api-key');

    expect(state().status).toEqual({ phase: 'error', error: 'invalid x-api-key' });
    // No empty assistant bubble is added
    expect(state().session?.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('reports an empty response as an error instead of a blank answer', () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'error', error: 'The model returned an empty response' });
    emit.error('project-a', 'The model returned an empty response');

    expect(state().status.phase).toBe('error');
    expect(state().session?.messages).toHaveLength(1);
  });

  it('replaces the local conversation with the persisted session after the reply is saved', () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'Hi!' });
    emit.chunk('project-a', { type: 'done' });

    const persisted = session('project-a', {
      title: 'hello',
      messages: [
        { id: 'u1', role: 'user', content: 'hello', timestamp: new Date() },
        { id: 'a1', role: 'assistant', content: 'Hi!', timestamp: new Date() }
      ]
    });
    emit.session('project-a', persisted);

    expect(state().session?.title).toBe('hello');
    expect(state().session?.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('ignores events from another project', () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-b', { type: 'text', content: 'wrong project' });
    emit.error('project-b', 'boom');

    expect(state().streamingContent).toBe('');
    expect(state().status.phase).toBe('thinking');
  });

  it('resets in-flight state when switching to another project', async () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'partial' });

    await store.loadInsightsSession('project-b');

    expect(state().projectId).toBe('project-b');
    expect(state().status.phase).toBe('idle');
    expect(state().streamingContent).toBe('');
  });

  it('keeps in-flight state when the same project is reloaded (Insights page remount)', async () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'partial' });

    await store.loadInsightsSession('project-a');
    emit.chunk('project-a', { type: 'done' });

    expect(state().session?.messages.at(-1)?.content).toBe('partial');
  });

  it('clears a previous error when starting a new conversation', async () => {
    store.sendMessage('project-a', 'hello');
    emit.error('project-a', 'HTTP 429: rate_limit_error: Error');
    expect(state().status.phase).toBe('error');

    await store.newSession('project-a');

    expect(state().session?.id).toBe('session-new');
    expect(state().status.phase).toBe('idle');
  });
});
