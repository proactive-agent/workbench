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
  regenerateInsightsMessage: vi.fn(),
  editInsightsMessage: vi.fn(),
  newInsightsSession: vi.fn(async () => ({ success: true })),
  switchInsightsSession: vi.fn(async (projectId: string, sessionId: string) => ({ success: true, data: session(projectId, { id: sessionId }) }))
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
  localStorage.clear();
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

    expect(state().session).toBeNull();
    expect(state().status.phase).toBe('idle');
  });

  it('opens a new chat without a conversation, then takes the one its first message created', async () => {
    await store.newSession('project-a');
    expect(state().session).toBeNull();

    store.sendMessage('project-a', 'hello');
    expect(state().session?.id).toBe(store.DRAFT_SESSION_ID);

    emit.session('project-a', session('project-a', {
      id: 'session-created',
      title: 'hello',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: new Date() }]
    }));

    expect(state().session?.id).toBe('session-created');
    expect(state().session?.title).toBe('hello');
  });

  it('opens the page on the chat it showed last', async () => {
    expect(state().session?.id).toBe('session-project-a');

    await store.openInsightsPage('project-a');

    expect(state().session?.id).toBe('session-project-a');
    expect(electronAPI.newInsightsSession).not.toHaveBeenCalled();
  });

  it('opens the last chat again after a restart, and a new chat when it is gone', async () => {
    await store.switchSession('project-a', 'session-7');
    // A fresh store (the app started again) opens that chat
    vi.resetModules();
    store = await import('../insights-store');
    await store.openInsightsPage('project-a');
    expect(electronAPI.switchInsightsSession).toHaveBeenLastCalledWith('project-a', 'session-7');
    expect(state().session?.id).toBe('session-7');

    // Deleted meanwhile: a new chat
    vi.resetModules();
    store = await import('../insights-store');
    electronAPI.switchInsightsSession.mockResolvedValueOnce({ success: false } as never);
    await store.openInsightsPage('project-a');
    expect(state().session).toBeNull();
    expect(electronAPI.newInsightsSession).toHaveBeenCalledWith('project-a');
  });

  it('opens the New chat page again when that is where the user left', async () => {
    await store.newSession('project-a');
    store.useInsightsStore.getState().setDraftModelConfig({ model: 'opus' } as never);
    vi.clearAllMocks();

    await store.openInsightsPage('project-a');

    expect(state().session).toBeNull();
    expect(state().draftModelConfig).toEqual({ model: 'opus' });
    expect(electronAPI.switchInsightsSession).not.toHaveBeenCalled();
  });

  it("keeps another window's project entry when it remembers its own last chat", async () => {
    // Another window (project B) remembered its chat after this store read the storage
    const stored = JSON.parse(localStorage.getItem('workbench.claude.lastChats') ?? '{}');
    localStorage.setItem('workbench.claude.lastChats', JSON.stringify({ ...stored, 'project-b': 'session-b' }));
    await store.switchSession('project-a', 'session-9');
    expect(JSON.parse(localStorage.getItem('workbench.claude.lastChats')!)).toEqual({ 'project-a': 'session-9', 'project-b': 'session-b' });
  });

  it("remembers the user's own showing or hiding of the history, not the drawer's", () => {
    state().setChatHistoryOpen(false, false);
    expect(state().chatHistoryOpen).toBe(false);
    expect(localStorage.getItem('workbench.claude.historyOpen')).toBeNull();
    state().setChatHistoryOpen(false);
    expect(localStorage.getItem('workbench.claude.historyOpen')).toBe('0');
  });

  it('lists the history once when the last chat is gone', async () => {
    await store.switchSession('project-a', 'session-7');
    vi.resetModules();
    store = await import('../insights-store');
    vi.clearAllMocks();
    electronAPI.switchInsightsSession.mockResolvedValueOnce({ success: false } as never);
    await store.openInsightsPage('project-a');
    expect(electronAPI.newInsightsSession).toHaveBeenCalledTimes(1);
    expect(electronAPI.listInsightsSessions).toHaveBeenCalledTimes(1);
  });

  it('asks the page for a new chat (the sidebar item on its own page)', () => {
    const before = state().newChatRequest;
    state().requestNewChat();
    expect(state().newChatRequest).toBe(before + 1);
  });

  it('keeps a reply being written on screen when the page opens again', async () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'partial' });

    await store.openInsightsPage('project-a');

    expect(state().session?.messages.map((m) => m.role)).toEqual(['user']);
    expect(state().streamingContent).toBe('partial');
    expect(electronAPI.newInsightsSession).not.toHaveBeenCalled();
  });

  it('regenerates the latest reply in its place', () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'First answer' });
    emit.chunk('project-a', { type: 'done' });
    emit.status('project-a', { phase: 'complete' });
    expect(state().session?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    store.regenerateMessage('project-a');

    expect(state().session?.messages.map((m) => m.role)).toEqual(['user']);
    expect(state().status.phase).toBe('thinking');
    expect(electronAPI.regenerateInsightsMessage).toHaveBeenCalledWith('project-a', undefined, 'session-project-a');

    emit.chunk('project-a', { type: 'text', content: 'Second answer' });
    emit.chunk('project-a', { type: 'done' });
    expect(state().session?.messages.at(-1)?.content).toBe('Second answer');
  });

  it('replaces the chat from an edited message on and sends the edit', () => {
    store.sendMessage('project-a', 'first');
    emit.chunk('project-a', { type: 'text', content: 'Answer one' });
    emit.chunk('project-a', { type: 'done' });
    store.sendMessage('project-a', 'second');
    emit.chunk('project-a', { type: 'text', content: 'Answer two' });
    emit.chunk('project-a', { type: 'done' });
    const firstId = state().session!.messages[0].id;

    store.editMessage('project-a', firstId, 'first, edited');

    expect(state().session?.messages.map((m) => m.content)).toEqual(['first, edited']);
    expect(state().status.phase).toBe('thinking');
    expect(electronAPI.editInsightsMessage).toHaveBeenCalledWith('project-a', firstId, 'first, edited', undefined, 'session-project-a');
  });

  it('leaves a reply of a chat the user left out of a new chat', async () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'partial', sessionId: 'session-project-a' });

    await store.newSession('project-a');
    emit.chunk('project-a', { type: 'text', content: ' more', sessionId: 'session-project-a' });
    emit.chunk('project-a', { type: 'done', sessionId: 'session-project-a' });

    expect(state().session).toBeNull();
    expect(state().streamingContent).toBe('');

    // The next message of the new chat takes only the conversation it created
    store.sendMessage('project-a', 'new question');
    emit.session('project-a', session('project-a', {
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: new Date() }]
    }));
    expect(state().session?.id).toBe(store.DRAFT_SESSION_ID);
  });

  it('leaves a reply of a chat the user left out of the chat switched to', async () => {
    store.sendMessage('project-a', 'hello');
    emit.chunk('project-a', { type: 'text', content: 'partial', sessionId: 'session-project-a' });

    await store.switchSession('project-a', 'session-other');
    emit.chunk('project-a', { type: 'text', content: ' more', sessionId: 'session-project-a' });
    emit.chunk('project-a', { type: 'done', sessionId: 'session-project-a' });

    expect(state().session?.id).toBe('session-other');
    expect(state().session?.messages).toEqual([]);
    expect(state().streamingContent).toBe('');

    // Its own replies still stream in
    emit.chunk('project-a', { type: 'text', content: 'Answer', sessionId: 'session-other' });
    expect(state().streamingContent).toBe('Answer');
  });

  it('keeps a new chat empty when another conversation is updated', async () => {
    await store.newSession('project-a');

    emit.session('project-a', session('project-a', { id: 'session-older' }));

    expect(state().session).toBeNull();
  });
});
