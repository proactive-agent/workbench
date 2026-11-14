/**
 * Session follower
 * ================
 *
 * Shows a running task's Claude Code session in an agent window, read-only. The task's headless
 * run is still writing to the session, so resuming it in a second Claude Code would fork the
 * conversation; instead the window follows the session transcript
 * (`<configDir>/projects/<project>/<sessionId>.jsonl`) and prints what the agent does. Keys do
 * nothing while the task runs. Once it stops, Enter continues the session in Claude Code (the
 * normal resume), and Ctrl+C stops following and leaves the shell.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { expandClaudeHome, isClaudeHomeInWsl, joinClaudeHome } from '../platform/claude-home';
import { toHostPath } from '../platform/shell-runtime';

/** What the follower needs to know about the task run */
export interface FollowedRun {
  /** Whether the task's run is still active */
  isRunning(): boolean;
  /** Current session and config dir (a profile swap moves the transcript to another config dir) */
  getSession(): { sessionId?: string; configDir?: string; profileId?: string } | undefined;
}

export interface SessionFollowerOptions {
  sessionId: string;
  configDir?: string;
  profileId?: string;
  /** Working directory of the session (tool paths are shown relative to it) */
  cwd: string;
  run: FollowedRun;
  /** Write text to the agent window */
  write: (data: string) => void;
  /** Enter after the task stopped: resume the session with this profile and config dir */
  onContinue: (session: { sessionId: string; configDir?: string; profileId?: string }) => void;
  /** Ctrl+C: stop following and hand the window back to the shell */
  onRelease: () => void;
  /** How often the transcript and the run are checked (ms) */
  pollMs?: number;
}

const POLL_MS = 1000;
/** The run must look stopped this many polls in a row (steps start one after another) */
const STOPPED_POLLS = 2;
const MAX_RESULT_CHARS = 160;

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

type Block = { type?: string; [key: string]: unknown };
interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: string | Block[] };
}

export class SessionFollower {
  private timer: NodeJS.Timeout | null = null;
  private transcript: string | null = null;
  private transcriptConfigDir: string | undefined;
  private offset = 0;
  private partial = '';
  private stoppedPolls = 0;
  private stopped = false;
  private ended = false;
  private polling = false;

  constructor(private readonly options: SessionFollowerOptions) {}

  start(): void {
    this.options.write(
      `\x1b[2J\x1b[3J\x1b[H${DIM}Following this task's Claude Code session (read-only). ` +
        `Once the task stops, press Enter to continue the session here.${RESET}\r\n`
    );
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? POLL_MS);
  }

  /** Stop following (window closed, or the session continues in Claude Code) */
  stop(): void {
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Keys typed in the window while following */
  handleInput(data: string): void {
    if (this.ended) return;
    if (data.includes('\x03')) {
      this.stop();
      this.options.write(`\r\n${DIM}Stopped following the session.${RESET}\r\n`);
      this.options.onRelease();
      return;
    }
    if (this.stopped && data.includes('\r') && !this.options.run.isRunning()) {
      this.stop();
      const session = this.currentSession();
      this.options.onContinue({ ...session, sessionId: session.sessionId ?? this.options.sessionId });
    }
  }

  private currentSession(): { sessionId?: string; configDir?: string; profileId?: string } {
    const live = this.options.run.getSession();
    return {
      sessionId: live?.sessionId ?? this.options.sessionId,
      configDir: live?.configDir ?? this.options.configDir,
      profileId: live?.profileId ?? this.options.profileId,
    };
  }

  private async poll(): Promise<void> {
    if (this.ended || this.polling) return;
    this.polling = true;
    try {
      await this.readTranscript();
      this.updateRunState();
    } catch {
      // A transcript that is being moved or rewritten is read again on the next poll
    } finally {
      this.polling = false;
    }
  }

  private updateRunState(): void {
    if (this.ended) return;
    if (this.options.run.isRunning()) {
      if (this.stopped) this.options.write(`\r\n${DIM}The task is running again.${RESET}\r\n`);
      this.stopped = false;
      this.stoppedPolls = 0;
      return;
    }
    this.stoppedPolls++;
    if (!this.stopped && this.stoppedPolls >= STOPPED_POLLS) {
      this.stopped = true;
      this.options.write(
        `\r\n${YELLOW}The task stopped. Press Enter to continue this session in Claude Code.${RESET}\r\n`
      );
    }
  }

  private async readTranscript(): Promise<void> {
    const { sessionId, configDir } = this.currentSession();
    if (!sessionId) return;
    // Find the transcript again after a profile swap (the run copies it to the new config dir)
    if (!this.transcript || this.transcriptConfigDir !== configDir) {
      const found = await findTranscript(sessionId, configDir);
      if (!found) return;
      this.transcript = found;
      this.transcriptConfigDir = configDir;
    }

    const handle = await fsp.open(this.transcript, 'r');
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        // Rewritten from scratch: start over
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset = size;
      const text = this.partial + buffer.toString('utf-8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      let out = '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          out += formatLine(JSON.parse(line) as TranscriptLine, this.options.cwd);
        } catch {
          // Not a complete JSON line
        }
      }
      if (out && !this.ended) this.options.write(out);
    } finally {
      await handle.close();
    }
  }
}

/**
 * `<configDir>/projects/<any project>/<sessionId>.jsonl`. In the WSL runtime the config dir is in
 * the Linux home, read through its UNC path (a Linux path is translated), and the app's own
 * CLAUDE_CONFIG_DIR (a Windows setting Claude Code in WSL doesn't see) is left out.
 */
export async function findTranscript(sessionId: string, configDir: string | undefined): Promise<string | null> {
  const appConfigDir = isClaudeHomeInWsl() ? undefined : process.env.CLAUDE_CONFIG_DIR;
  const root = configDir ? toHostPath(expandClaudeHome(configDir)) : appConfigDir || joinClaudeHome('.claude');
  const projectsDir = path.join(root, 'projects');
  let projects: string[];
  try {
    projects = await fsp.readdir(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // Not in this project
    }
  }
  return null;
}

/** Terminal text for one transcript line: assistant text, tool calls and their results */
function formatLine(line: TranscriptLine, cwd: string): string {
  if (line.isMeta || (line.type !== 'user' && line.type !== 'assistant')) return '';
  const content = line.message?.content;
  const indent = line.isSidechain ? '  ' : '';
  if (typeof content === 'string') {
    return line.type === 'user' ? prompt(content, indent) : text(content, indent);
  }
  if (!Array.isArray(content)) return '';

  let out = '';
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out += line.type === 'user' ? prompt(block.text, indent) : text(block.text, indent);
    } else if (block.type === 'tool_use') {
      const summary = summarizeInput(String(block.name ?? ''), block.input, cwd);
      out += `\r\n${indent}${CYAN}●${RESET} ${BOLD}${String(block.name ?? 'Tool')}${RESET}${summary ? `(${summary})` : ''}\r\n`;
    } else if (block.type === 'tool_result') {
      out += toolResult(block.content, block.is_error === true, indent);
    }
  }
  return out;
}

function prompt(value: string, indent: string): string {
  const first = value.trim().split('\n')[0] ?? '';
  return first ? `\r\n${indent}${DIM}› ${truncate(first, MAX_RESULT_CHARS)}${RESET}\r\n` : '';
}

function text(value: string, indent: string): string {
  const body = value.trim();
  if (!body) return '';
  return `\r\n${indent}● ${body.split('\n').join(`\r\n${indent}  `)}\r\n`;
}

function toolResult(content: unknown, isError: boolean, indent: string): string {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n')
        : '';
  const lines = raw.trim().split('\n').filter((l) => l.trim());
  if (lines.length === 0) return '';
  const more = lines.length > 1 ? ` ${DIM}(+${lines.length - 1} lines)${RESET}` : '';
  const color = isError ? RED : DIM;
  return `${indent}  ${DIM}⎿${RESET}  ${color}${truncate(lines[0], MAX_RESULT_CHARS)}${RESET}${more}\r\n`;
}

/** Short description of a tool call, like Claude Code's own (file, command, pattern, ...) */
function summarizeInput(name: string, input: unknown, cwd: string): string {
  if (!input || typeof input !== 'object') return '';
  const value = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
    return '';
  };
  // Claude Code in WSL writes Linux paths (/mnt/c/..., /home/...): compared as host paths, and
  // shown as host paths when outside the working directory
  const relative = (file: string) => {
    const hostFile = toHostPath(file);
    const rel = path.relative(toHostPath(cwd), hostFile);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : hostFile;
  };
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return relative(pick('file_path', 'notebook_path'));
    case 'Bash':
      return truncate(pick('command').split('\n')[0] ?? '', 100);
    default: {
      const summary = pick('description', 'subject', 'pattern', 'query', 'url', 'skill', 'prompt');
      return truncate(summary.split('\n')[0] ?? '', 100);
    }
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
