/**
 * @vitest-environment jsdom
 */
/**
 * Several chats replying at once: the shown chat's reply streams on screen, the others' go on in
 * the background (by conversation id) and come back when their chat is opened again
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InsightsChatStatus, InsightsSession, InsightsStreamChunk } from '../../../shared/types';

type ChunkListener = (projectId: string, chunk: InsightsStreamChunk) => void;
type StatusListener = (projectId: string, status: InsightsChatStatus, sessionId?: string) => void;
type ErrorListener = (projectId: string, error: string, sessionId?: string) => void;
type SessionListener = (projectId: string, session: InsightsSession) => void;

const listeners = { chunk: [] as ChunkListener[], status: [] as StatusListener[], error: [] as ErrorListener[], session: [] as SessionListener[] };

const chat = (id: string, overrides: Partial<InsightsSession> = {}): InsightsSession => ({
  id, projectId: 'p', title: id, messages: [], createdAt: new Date(), updatedAt: new Date(), ...overrides,
} as InsightsSession);

const electronAPI = {
  onInsightsStreamChunk: vi.fn((cb: ChunkListener) => { listeners.chunk.push(cb); return () => {}; }),
  onInsightsStatus: vi.fn((cb: StatusListener) => { listeners.status.push(cb); return () => {}; }),
  onInsightsError: vi.fn((cb: ErrorListener) => { listeners.error.push(cb); return () => {}; }),
  onInsightsSessionUpdated: vi.fn((cb: SessionListener) => { listeners.session.push(cb); return () => {}; }),
  getInsightsSession: vi.fn(async () => ({ success: true, data: chat('a') })),
  listInsightsSessions: vi.fn(async () => ({ success: true, data: [] })),
  sendInsightsMessage: vi.fn(),
  stopInsightsMessage: vi.fn(async () => true),
  newInsightsSession: vi.fn(async () => ({ success: true })),
  switchInsightsSession: vi.fn(async (_p: string, id: string) => ({ success: true, data: chat(id) })),
};

const emit = {
  chunk: (chunk: InsightsStreamChunk) => listeners.chunk.forEach((cb) => cb('p', chunk)),
  status: (status: InsightsChatStatus, sessionId?: string) => listeners.status.forEach((cb) => cb('p', status, sessionId)),
  error: (error: string, sessionId?: string) => listeners.error.forEach((cb) => cb('p', error, sessionId)),
};

let store: typeof import('../insights-store');
let cleanup: () => void;

beforeEach(async () => {
  vi.resetModules();
  listeners.chunk = []; listeners.status = []; listeners.error = []; listeners.session = [];
  vi.clearAllMocks();
  (window as unknown as { electronAPI: typeof electronAPI }).electronAPI = electronAPI;
  store = await import('../insights-store');
  cleanup = store.setupInsightsListeners();
  await store.loadInsightsSession('p');
});

afterEach(() => cleanup());

const state = () => store.useInsightsStore.getState();

describe('chats replying at once', () => {
  it("keeps a chat's reply going in the background and brings it back with its chat", async () => {
    store.sendMessage('p', 'question A');
    emit.status({ phase: 'thinking', message: '' }, 'a');
    emit.chunk({ type: 'text', content: 'Half ', sessionId: 'a' });

    // Another chat: its composer is free, A goes on in the background
    await store.switchSession('p', 'b');
    expect(state().session?.id).toBe('b');
    expect(state().status.phase).toBe('idle');
    expect(state().streamingContent).toBe('');
    expect(store.replyingSessionIds(state())).toEqual(new Set(['a']));

    emit.chunk({ type: 'tool_start', tool: { name: 'Grep', input: 'x' }, sessionId: 'a' });
    emit.chunk({ type: 'tool_end', tool: { name: 'Grep' }, sessionId: 'a' });
    emit.chunk({ type: 'text', content: 'way', sessionId: 'a' });
    expect(state().backgroundRuns.a.streamingContent).toBe('Half way');

    // B replies too, on screen
    store.sendMessage('p', 'question B');
    emit.chunk({ type: 'text', content: 'B text', sessionId: 'b' });
    expect(state().streamingContent).toBe('B text');
    expect(store.replyingSessionIds(state())).toEqual(new Set(['a', 'b']));

    // Back to A: its reply is still streaming, with what it wrote meanwhile; B goes on
    await store.switchSession('p', 'a');
    expect(state().streamingContent).toBe('Half way');
    expect(state().toolsUsed.map((tool) => tool.name)).toEqual(['Grep']);
    expect(state().status.phase).toBe('streaming');
    expect(state().backgroundRuns.b.streamingContent).toBe('B text');

    // B ends while not shown: nothing of it stays here (its chat shows the saved reply)
    emit.chunk({ type: 'done', sessionId: 'b' });
    emit.status({ phase: 'complete' }, 'b');
    expect(state().backgroundRuns.b).toBeUndefined();
    expect(store.replyingSessionIds(state())).toEqual(new Set(['a']));
  });

  it("stops the shown chat's reply, by its id", async () => {
    store.sendMessage('p', 'question');
    await store.stopMessage('p');
    expect(electronAPI.stopInsightsMessage).toHaveBeenCalledWith('p', 'a');
  });

  it('keeps an error of a chat not shown for when it is opened again', async () => {
    store.sendMessage('p', 'question');
    emit.status({ phase: 'thinking', message: '' }, 'a');
    await store.newSession('p');
    expect(state().session).toBeNull();
    emit.error('invalid x-api-key', 'a');
    expect(store.replyingSessionIds(state())).toEqual(new Set());
    await store.switchSession('p', 'a');
    expect(state().status).toMatchObject({ phase: 'error', error: 'invalid x-api-key' });
  });

  it('applies chunks to a background reply and ends it on done', () => {
    const idle = { status: { phase: 'idle', message: '' }, streamingContent: '', streamingTasks: [], currentTool: null, toolsUsed: [] } as const;
    const run = store.applyRunChunk({ ...idle, streamingTasks: [], toolsUsed: [] }, { type: 'text', content: 'Hi' })!;
    expect(run).toMatchObject({ streamingContent: 'Hi', status: { phase: 'streaming' } });
    expect(store.applyRunChunk(run, { type: 'done' })).toBeNull();
    expect(store.applyBackgroundStatus(run, { phase: 'complete' })).toBeNull();
  });
});
