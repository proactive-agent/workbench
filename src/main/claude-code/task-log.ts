/**
 * Task log (task_logs.json)
 * =========================
 *
 * Turns Claude Code stream messages into the task log the Logs tab shows. The log keeps three
 * sections: planning (triage and plan), coding (implementation and revisions) and validation.
 * Writes are atomic (temp file + rename) and throttled.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type {
  TaskLogEntry,
  TaskLogEntryType,
  TaskLogPhase,
  TaskLogPhaseStatus,
  TaskLogs,
} from '../../shared/types/task';

const MAX_ENTRY_LENGTH = 2000;
const MAX_DETAIL_LENGTH = 8000;
const SAVE_DELAY_MS = 250;

function emptyPhase(phase: TaskLogPhase) {
  return { phase, status: 'pending' as TaskLogPhaseStatus, started_at: null, completed_at: null, entries: [] as TaskLogEntry[] };
}

/** Short, readable summary of a tool call's input for the log line */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Bash':
    case 'Monitor':
      return pick('description', 'command');
    case 'Glob':
    case 'Grep':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'Agent':
    case 'Task':
      return pick('description', 'subagent_type');
    case 'Skill':
      return pick('skill', 'command');
    case 'TaskCreate':
      return pick('subject');
    case 'TaskUpdate':
      return [pick('taskId'), pick('status')].filter(Boolean).join(' ');
    case 'SendMessage':
      // Native message to another session
      return [pick('to', 'recipient'), pick('summary', 'message')].filter(Boolean).join(': ');
    case 'Workflow': {
      // A named or saved workflow, else the `meta.name` its inline script starts with
      const meta = typeof input.script === 'string' ? /\bname\s*:\s*['"`]([^'"`\n]+)['"`]/.exec(input.script)?.[1] : undefined;
      const resuming = pick('resumeFromRunId');
      return [pick('name') || meta || pick('scriptPath'), resuming ? `resuming ${resuming}` : ''].filter(Boolean).join(', ');
    }
    case 'mcp__workbench__message_task':
      // Workbench's message to another task
      return [pick('task'), pick('message')].filter(Boolean).join(': ');
    default:
      return pick('description', 'file_path', 'path', 'command', 'query', 'url', 'name');
  }
}

export class TaskLogWriter {
  private readonly logFile: string;
  private data: TaskLogs;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(specDir: string, specId: string) {
    this.logFile = path.join(specDir, 'task_logs.json');
    this.data = this.load(specId);
  }

  private load(specId: string): TaskLogs {
    if (existsSync(this.logFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.logFile, 'utf-8')) as TaskLogs;
        if (parsed?.phases?.planning && parsed.phases.coding && parsed.phases.validation) return parsed;
      } catch {
        // Corrupt log: start over
      }
    }
    const now = new Date().toISOString();
    return {
      spec_id: specId,
      created_at: now,
      updated_at: now,
      phases: { planning: emptyPhase('planning'), coding: emptyPhase('coding'), validation: emptyPhase('validation') },
    };
  }

  startPhase(phase: TaskLogPhase, message: string): void {
    for (const key of Object.keys(this.data.phases) as TaskLogPhase[]) {
      const entry = this.data.phases[key];
      if (key !== phase && entry.status === 'active') {
        entry.status = 'completed';
        entry.completed_at = new Date().toISOString();
      }
    }
    const target = this.data.phases[phase];
    target.status = 'active';
    target.started_at = target.started_at ?? new Date().toISOString();
    target.completed_at = null;
    this.add(phase, 'phase_start', message);
  }

  /** End a step: completed or failed, or stopped when the run was stopped before it finished */
  endPhase(phase: TaskLogPhase, success: boolean | 'stopped', message: string): void {
    const target = this.data.phases[phase];
    target.status = success === 'stopped' ? 'stopped' : success ? 'completed' : 'failed';
    target.completed_at = new Date().toISOString();
    this.add(phase, 'phase_end', message);
    this.saveNow();
  }

  add(phase: TaskLogPhase, type: TaskLogEntryType, content: string, extra: Partial<TaskLogEntry> = {}): void {
    const entry: TaskLogEntry = {
      timestamp: new Date().toISOString(),
      type,
      content: content.length > MAX_ENTRY_LENGTH ? `${content.slice(0, MAX_ENTRY_LENGTH)}…` : content,
      phase,
      ...extra,
    };
    if (entry.detail && entry.detail.length > MAX_DETAIL_LENGTH) {
      entry.detail = `${entry.detail.slice(0, MAX_DETAIL_LENGTH)}…`;
    }
    this.data.phases[phase].entries.push(entry);
    this.scheduleSave();
  }

  getData(): TaskLogs {
    return this.data;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.data.updated_at = new Date().toISOString();
    const tmp = `${this.logFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      renameSync(tmp, this.logFile);
    } catch (error) {
      console.error('[TaskLogWriter] Failed to save task log:', error);
    }
  }
}
