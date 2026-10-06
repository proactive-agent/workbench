import path from 'path';

const INSIGHTS_DIR = '.auto-claude/insights';
const SESSIONS_DIR = 'sessions';
const CURRENT_SESSION_FILE = 'current_session.json';
const ATTACHMENTS_DIR = 'attachments';

/** Attachment ids are generated UUIDs; anything else is rejected to keep paths contained */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** File extensions for image attachments that are stored on disk */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

/**
 * Path utilities for insights service
 * Provides consistent path resolution for sessions and insights data
 */
export class InsightsPaths {
  /**
   * Get insights directory path for a project
   */
  getInsightsDir(projectPath: string): string {
    return path.join(projectPath, INSIGHTS_DIR);
  }

  /**
   * Get sessions directory path for a project
   */
  getSessionsDir(projectPath: string): string {
    return path.join(this.getInsightsDir(projectPath), SESSIONS_DIR);
  }

  /**
   * Validate that a session ID matches the expected safe pattern.
   * Prevents path traversal attacks via crafted session IDs.
   */
  private validateSessionId(sessionId: string): void {
    if (!/^session-\d{1,20}$/.test(sessionId)) {
      throw new Error('Invalid session ID format');
    }
  }

  /**
   * Directory holding the full-size images attached to a session's messages
   */
  getAttachmentsDir(projectPath: string, sessionId: string): string {
    this.validateSessionId(sessionId);
    return path.join(this.getInsightsDir(projectPath), ATTACHMENTS_DIR, sessionId);
  }

  /**
   * Path (relative to the insights directory) where an image attachment is stored,
   * or null when the attachment can't be stored (unsupported type or unsafe id)
   */
  getAttachmentRelativePath(sessionId: string, attachmentId: string, mimeType: string): string | null {
    this.validateSessionId(sessionId);
    const extension = IMAGE_EXTENSIONS[mimeType];
    if (!extension || !ATTACHMENT_ID_PATTERN.test(attachmentId)) return null;
    return path.posix.join(ATTACHMENTS_DIR, sessionId, `${attachmentId}${extension}`);
  }

  /**
   * Resolve a stored attachment path, or null if it points outside the attachments directory
   */
  resolveAttachmentPath(projectPath: string, relativePath: string): string | null {
    const attachmentsRoot = path.resolve(this.getInsightsDir(projectPath), ATTACHMENTS_DIR);
    const resolved = path.resolve(this.getInsightsDir(projectPath), relativePath);
    return resolved.startsWith(attachmentsRoot + path.sep) ? resolved : null;
  }

  /**
   * Get session file path for a specific session
   */
  getSessionPath(projectPath: string, sessionId: string): string {
    this.validateSessionId(sessionId);
    return path.join(this.getSessionsDir(projectPath), `${sessionId}.json`);
  }

  /**
   * Get current session pointer file path
   */
  getCurrentSessionPath(projectPath: string): string {
    return path.join(this.getInsightsDir(projectPath), CURRENT_SESSION_FILE);
  }

  /**
   * Get old session path for migration
   */
  getOldSessionPath(projectPath: string): string {
    return path.join(this.getInsightsDir(projectPath), 'session.json');
  }
}
