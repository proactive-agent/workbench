import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectorySessions, summarizeTranscript } from '../claude-sessions';
import { getSessionFilePath } from '../../claude-profile/session-utils';

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const user = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: text }, ...extra });
const assistant = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });

describe('summarizeTranscript', () => {
  it('names a session by its set title, then its AI title, then its name, then its prompt', () => {
    const body = user('fix the login') + assistant;
    const named = (records: string) => summarizeTranscript(body + records, body + records).name;
    expect(named(line({ type: 'ai-title', aiTitle: 'Login fix' }) + line({ type: 'custom-title', customTitle: 'Mine' }))).toBe('Mine');
    expect(named(line({ type: 'ai-title', aiTitle: 'Old' }) + line({ type: 'ai-title', aiTitle: 'Login fix' }))).toBe('Login fix');
    expect(named(line({ type: 'agent-name', agentName: 'workbench-01' }))).toBe('workbench-01');
    expect(named(line({ type: 'last-prompt', lastPrompt: 'and the logout' }))).toBe('and the logout');
    expect(named('')).toBe('fix the login');
  });

  it('tells a headless run and a title-only transcript apart', () => {
    const headless = user('go', { entrypoint: 'sdk-cli' }) + assistant;
    expect(summarizeTranscript(headless, headless).entrypoint).toBe('sdk-cli');
    const titleOnly = line({ type: 'ai-title', aiTitle: 'Nothing' });
    expect(summarizeTranscript(titleOnly, titleOnly).hasConversation).toBe(false);
  });
});

describe('listDirectorySessions', () => {
  let configDir: string;
  const cwd = '/tmp/some-project';
  const write = (sessionId: string, content: string, mtimeSeconds: number) => {
    const file = getSessionFilePath(configDir, cwd, sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    utimesSync(file, mtimeSeconds, mtimeSeconds);
  };

  beforeEach(() => {
    configDir = mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('lists what /resume offers: interactive sessions with a conversation, newest first', async () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    write(a, user('first') + assistant + line({ type: 'ai-title', aiTitle: 'Older' }), 1000);
    write(b, user('second') + assistant + line({ type: 'ai-title', aiTitle: 'Newer' }), 2000);
    write('33333333-3333-4333-8333-333333333333', user('headless', { entrypoint: 'sdk-cli' }) + assistant, 3000);
    write('44444444-4444-4444-8444-444444444444', line({ type: 'ai-title', aiTitle: 'Empty' }), 4000);
    writeFileSync(path.join(path.dirname(getSessionFilePath(configDir, cwd, a)), 'notes.txt'), 'not a session');

    const sessions = await listDirectorySessions(configDir, cwd);
    expect(sessions.map((session) => [session.sessionId, session.name])).toEqual([[b, 'Newer'], [a, 'Older']]);
  });

  it('is empty when nothing ran in the directory', async () => {
    expect(await listDirectorySessions(configDir, '/tmp/elsewhere')).toEqual([]);
  });
});
