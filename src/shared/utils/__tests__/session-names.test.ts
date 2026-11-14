import { describe, it, expect } from 'vitest';
import { agentSessionName, chatIdFromName, chatSessionName, parseSessionName, sessionNameTag } from '../session-names';

describe('session names', () => {
  it("names a chat by its id's timestamp, and reads the id back", () => {
    const name = chatSessionName('session-1794072161229');
    expect(name).toMatch(/^chat-[0-9a-z]+$/);
    expect(chatIdFromName(name!)).toBe('session-1794072161229');
    expect(chatIdFromName(name!.toUpperCase())).toBe('session-1794072161229');
    expect(chatSessionName('draft')).toBeNull();
    expect(chatIdFromName('agent-1a2b3c4d')).toBeNull();
    expect(chatIdFromName('chat-')).toBeNull();
  });

  it('names an agent window by the start of its id', () => {
    const name = agentSessionName('1A2B3C4D-aaaa-bbbb-cccc-ddddeeeeffff');
    expect(name).toBe('agent-1a2b3c4d');
  });

  it('reads a pasted name, and tags it for an agent window', () => {
    expect(parseSessionName(' agent-1A25C6F1\n')).toEqual({ kind: 'agent', name: 'agent-1a25c6f1', hash: '1a25c6f1' });
    expect(parseSessionName('chat-mw6y8poj')).toEqual({ kind: 'chat', name: 'chat-mw6y8poj', hash: 'mw6y8poj' });
    for (const text of ['window-1a25c6f1', 'agent-1a25c6f', 'agent-1a25c6fz', 'chat-', 'see chat-mw6y8poj', 'chat-mw6y8poj now']) {
      expect(parseSessionName(text)).toBeNull();
    }
    expect(sessionNameTag({ kind: 'agent', hash: '1a25c6f1' })).toBe('[Agent #1a25c6f1]');
    expect(sessionNameTag({ kind: 'chat', hash: 'mw6y8poj' })).toBe('[Chat #mw6y8poj]');
  });
});
