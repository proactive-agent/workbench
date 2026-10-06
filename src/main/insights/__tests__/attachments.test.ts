/**
 * Stored Insights image attachments: path generation/containment and lifecycle with sessions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InsightsPaths } from '../paths';
import { SessionStorage } from '../session-storage';
import type { InsightsSession } from '../../../shared/types';

const paths = new InsightsPaths();
const projects: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'insights-attachments-'));
  projects.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('InsightsPaths attachments', () => {
  it('builds a per-session relative path with the image extension', () => {
    expect(paths.getAttachmentRelativePath('session-123', 'abc-def', 'image/png')).toBe('attachments/session-123/abc-def.png');
    expect(paths.getAttachmentRelativePath('session-123', 'abc', 'image/jpeg')).toBe('attachments/session-123/abc.jpg');
  });

  it('refuses non-image types and unsafe ids', () => {
    expect(paths.getAttachmentRelativePath('session-1', 'abc', 'text/plain')).toBeNull();
    expect(paths.getAttachmentRelativePath('session-1', '../../evil', 'image/png')).toBeNull();
    expect(() => paths.getAttachmentRelativePath('../session', 'abc', 'image/png')).toThrow();
  });

  it('only resolves paths inside the attachments directory', () => {
    const project = makeProject();
    const insightsDir = paths.getInsightsDir(project);
    expect(paths.resolveAttachmentPath(project, 'attachments/session-1/a.png')).toBe(path.join(insightsDir, 'attachments', 'session-1', 'a.png'));
    expect(paths.resolveAttachmentPath(project, 'sessions/session-1.json')).toBeNull();
    expect(paths.resolveAttachmentPath(project, 'attachments/../../../../etc/passwd')).toBeNull();
    expect(paths.resolveAttachmentPath(project, '/etc/passwd')).toBeNull();
  });
});

describe('SessionStorage attachments', () => {
  const session = (): InsightsSession => ({
    id: 'session-42',
    projectId: 'p',
    title: 't',
    messages: [{
      id: 'm1',
      role: 'user',
      content: 'look',
      timestamp: new Date(),
      images: [{ id: 'img', filename: 'a.png', mimeType: 'image/png', size: 3, data: 'AAAA', thumbnail: 'data:thumb', path: 'attachments/session-42/img.png' }]
    }],
    createdAt: new Date(),
    updatedAt: new Date()
  } as InsightsSession);

  it('persists the stored file path but not the full image data', () => {
    const project = makeProject();
    const storage = new SessionStorage(paths);
    storage.saveSession(project, session());

    const image = storage.loadSessionById(project, 'session-42')?.messages[0].images?.[0];
    expect(image?.path).toBe('attachments/session-42/img.png');
    expect(image?.thumbnail).toBe('data:thumb');
    expect(image?.data).toBeUndefined();
  });

  it('deletes the session attachments together with the session', () => {
    const project = makeProject();
    const storage = new SessionStorage(paths);
    storage.saveSession(project, session());
    const attachmentsDir = paths.getAttachmentsDir(project, 'session-42');
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(path.join(attachmentsDir, 'img.png'), 'png');

    expect(storage.deleteSession(project, 'session-42')).toBe(true);
    expect(existsSync(attachmentsDir)).toBe(false);
  });
});
