/**
 * The Claude Code session an agent window shows, for opening it as a chat: the live session
 * running in the window (it changes on /clear or /resume), else the one Workbench last started
 * there, with the account it runs on and its transcript.
 */
import path from 'path';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { windowSessionAccount } from '../terminal/cli-integration-handler';
import { findTranscript } from '../terminal/session-follower';
import { expandClaudeHome } from '../platform/claude-home';
import type { TerminalProcess } from '../terminal/types';
import { windowLiveSession } from './live-sessions';

export interface WindowChatSource {
  sessionId: string;
  transcriptPath: string;
  profileId?: string;
}

const sameDir = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && path.resolve(expandClaudeHome(a)).toLowerCase() === path.resolve(expandClaudeHome(b)).toLowerCase();

/** The window's session with its transcript, or null when it has none saved yet */
export async function windowChatSource(terminal: TerminalProcess): Promise<WindowChatSource | null> {
  const live = await windowLiveSession(terminal);
  const { own, configDir } = await windowSessionAccount(terminal);
  const sessionId = live?.sessionId ?? own?.sessionId;
  if (!sessionId) return null;
  const transcriptPath = await findTranscript(sessionId, configDir);
  if (!transcriptPath) return null;
  // The account the window runs it on: the one of its config dir, else the window's own
  const profiles = getClaudeProfileManager().getSettings().profiles;
  const profileId = profiles.find((profile) => sameDir(profile.configDir, configDir))?.id ?? terminal.claudeProfileId;
  return { sessionId, transcriptPath, ...(profileId ? { profileId } : {}) };
}
