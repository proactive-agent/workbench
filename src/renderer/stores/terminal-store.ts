import { create } from 'zustand';
import { createActor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import { arrayMove } from '@dnd-kit/sortable';
import type { Task, TerminalSession, TerminalTaskSessionOptions, TerminalWorktreeConfig } from '../../shared/types';
import { getTaskWorktreeBranch } from '../../shared/utils/claude-run';
import { terminalMachine, type TerminalEvent } from '@shared/state-machines';
import { terminalBufferManager } from '../lib/terminal-buffer-manager';
import { startTerminalLoading, stopTerminalLoading, TERMINAL_LOADING_TIMEOUT_MS, type TerminalLoadingKind } from '../lib/terminal-loading';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import { DEFAULT_MAX_TERMINALS, MIN_TERMINALS, MAX_TERMINALS_LIMIT } from '../../shared/constants';

type TerminalActor = ActorRefFrom<typeof terminalMachine>;

/**
 * Module-level Map to store terminal ID -> XState actor mappings.
 *
 * DESIGN NOTE: Stored outside Zustand because actors are mutable references
 * that shouldn't be serialized in state. Similar pattern to xtermCallbacks.
 */
const terminalActors = new Map<string, TerminalActor>();

/**
 * Get or create an XState terminal actor for a given terminal ID.
 * Actors are lazily created on first access and cached for the terminal's lifetime.
 */
function getOrCreateTerminalActor(terminalId: string): TerminalActor {
  let actor = terminalActors.get(terminalId);
  if (!actor) {
    actor = createActor(terminalMachine);
    actor.start();
    terminalActors.set(terminalId, actor);
    debugLog(`[TerminalStore] Created XState actor for terminal: ${terminalId}`);
  }
  return actor;
}

/**
 * Send an event to a terminal's XState machine.
 * Creates the actor if it doesn't exist yet.
 */
function sendTerminalMachineEvent(terminalId: string, event: TerminalEvent): void {
  const actor = getOrCreateTerminalActor(terminalId);
  const stateBefore = String(actor.getSnapshot().value);
  actor.send(event);
  const stateAfter = String(actor.getSnapshot().value);
  debugLog(`[TerminalStore] Machine ${terminalId}: ${event.type} (${stateBefore} -> ${stateAfter})`);
}

/**
 * Module-level Map to store terminal ID -> xterm write callback mappings.
 *
 * DESIGN NOTE: This is stored outside of Zustand state because:
 * 1. Callbacks are functions and shouldn't be serialized in state
 * 2. The callbacks need to be accessible from the global terminal listener
 * 3. Registration/unregistration happens on terminal mount/unmount, not state changes
 *
 * When a terminal component mounts, it registers its xterm.write function here.
 * When the global terminal output listener receives data, it calls the callback
 * if registered (terminal is visible), otherwise just buffers the data.
 * This allows output to be written to xterm immediately when visible, while
 * still buffering when the terminal is not rendered (project switched away).
 */
const xtermCallbacks = new Map<string, (data: string) => void>();

// Restored agent windows waiting to resume their Claude Code session, resumed one at a time
const claudeResumeQueue: string[] = [];
let claudeResumeRunning = false;

/**
 * Register an xterm write callback for a terminal.
 * Called when a terminal component mounts and xterm is ready.
 *
 * @param terminalId - The terminal ID
 * @param callback - Function to write data to xterm instance
 */
export function registerOutputCallback(
  terminalId: string,
  callback: (data: string) => void
): void {
  xtermCallbacks.set(terminalId, callback);
  debugLog(`[TerminalStore] Registered output callback for terminal: ${terminalId}`);
}

/**
 * Unregister an xterm write callback for a terminal.
 * Called when a terminal component unmounts.
 *
 * @param terminalId - The terminal ID
 */
export function unregisterOutputCallback(terminalId: string): void {
  xtermCallbacks.delete(terminalId);
  debugLog(`[TerminalStore] Unregistered output callback for terminal: ${terminalId}`);
}

/**
 * Write terminal output to the appropriate destination.
 *
 * If the terminal has a registered callback (component is mounted and visible),
 * writes directly to xterm AND buffers. If no callback is registered (terminal
 * component is unmounted due to project switch), only buffers the data.
 *
 * This function is called by the global terminal output listener in
 * useGlobalTerminalListeners, which ensures output is always captured
 * regardless of which project is currently active.
 *
 * @param terminalId - The terminal ID
 * @param data - The output data to write
 */
export function writeToTerminal(terminalId: string, data: string): void {
  // Always buffer the data to ensure persistence
  terminalBufferManager.append(terminalId, data);

  // If terminal has a registered callback, write to xterm immediately
  const callback = xtermCallbacks.get(terminalId);
  if (callback) {
    try {
      callback(data);
    } catch (error) {
      debugError(`[TerminalStore] Error writing to terminal ${terminalId}:`, error);
    }
  }
}

/**
 * Whether this window holds the terminal: its project's, or one of a project it has shown.
 *
 * Terminal output reaches every project window, and another window's terminals are never
 * drawn here, so the output listener drops what isn't ours instead of buffering it twice.
 */
export function isWindowTerminal(terminalId: string): boolean {
  return useTerminalStore.getState().terminals.some((terminal) => terminal.id === terminalId);
}

export type TerminalStatus = 'idle' | 'running' | 'claude-active' | 'exited';

/** A task's Claude Code session to resume once the agent window's shell is ready */
export type PendingTaskSession = Omit<TerminalTaskSessionOptions, 'cwd'>;

/** Everything needed to open a task's Claude Code session in an agent window */
export interface TaskSessionRequest {
  /** Project the task belongs to (the agent window is opened there) */
  projectPath: string;
  /** The same project by id, which is how the main process keys a task's run */
  projectId: string;
  taskId: string;
  specId: string;
  /** Window title (the task title) */
  title: string;
  sessionId: string;
  /** The task's git worktree (the session's working directory) */
  worktreePath: string;
  profileId?: string;
  configDir?: string;
  baseBranch?: string;
}

/**
 * The session request for a task, or null when it has no Claude Code session.
 * The worktree is the one the session ran in, else the task's default worktree path.
 */
export function getTaskSessionRequest(task: Task, projectPath: string): TaskSessionRequest | null {
  const run = task.claudeRun;
  if (!run?.sessionId) return null;
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  const worktreePath =
    run.worktreePath ||
    run.init?.cwd ||
    [projectPath.replace(/[\\/]+$/, ''), '.workbench', 'worktrees', 'tasks', task.specId].join(separator);
  return {
    projectPath,
    projectId: task.projectId,
    taskId: task.id,
    specId: task.specId,
    title: task.title,
    sessionId: run.sessionId,
    worktreePath,
    profileId: run.profileId,
    configDir: run.configDir,
    baseBranch: task.metadata?.baseBranch
  };
}

/**
 * The session an agent window resumes once its shell is ready. Both ways into a task's session
 * (a new window, and moving an existing window onto the task) build it here, so the project the
 * main process needs to find the task's run always travels with the request.
 */
export function buildPendingTaskSession(request: TaskSessionRequest): PendingTaskSession {
  return {
    taskId: request.taskId,
    projectId: request.projectId,
    sessionId: request.sessionId,
    profileId: request.profileId,
    configDir: request.configDir
  };
}

/** Worktree config that shows a task's worktree in an agent window's worktree selector */
export function buildTaskWorktreeConfig(request: TaskSessionRequest, terminalId: string): TerminalWorktreeConfig {
  return {
    name: request.specId,
    worktreePath: request.worktreePath,
    branchName: getTaskWorktreeBranch(request.specId),
    baseBranch: request.baseBranch ?? '',
    hasGitBranch: true,
    taskId: request.taskId,
    createdAt: new Date().toISOString(),
    terminalId
  };
}

/** Ask the app to show the Agents page of a project (e.g. after opening a task's session) */
interface AgentsViewRequest {
  projectPath: string;
  /** Increases with every request, so the same project can be requested again */
  seq: number;
}

export interface Terminal {
  id: string;
  title: string;
  status: TerminalStatus;
  cwd: string;
  createdAt: Date;
  isCLIMode: boolean;
  // outputBuffer removed - now managed by terminalBufferManager singleton
  isRestored?: boolean;  // Whether this terminal was restored from a saved session
  associatedTaskId?: string;  // ID of task associated with this terminal (for context loading)
  projectPath?: string;  // Project this terminal belongs to (for multi-project support)
  worktreeConfig?: TerminalWorktreeConfig;  // Associated worktree for isolated development
  isClaudeBusy?: boolean;  // Whether Claude Code is actively processing (for visual indicator)
  pendingCLIResume?: boolean;  // Whether this terminal has a Claude Code session to resume (resumed once its window is shown)
  launchCLIOnCreate?: boolean;  // Start Claude Code as soon as the PTY is ready ("New agent")
  pendingTaskSession?: PendingTaskSession;  // With launchCLIOnCreate: resume this task session instead of starting a new one
  displayOrder?: number;  // Display order for tab persistence (lower = further left)
  cliNamedOnce?: boolean;  // Whether this Claude terminal has been auto-named based on initial message (prevents repeated naming)
  loading?: TerminalLoadingKind;  // Starting (a shell, or Claude Code): the window shows a spinner until it is ready
}

/** Each loading window's fallback timer (see setTerminalLoading) */
const loadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface TerminalLayout {
  id: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

interface TerminalState {
  terminals: Terminal[];
  layouts: TerminalLayout[];
  activeTerminalId: string | null;
  maxTerminals: number;
  hasRestoredSessions: boolean;  // Track if we've restored sessions for this project
  agentsViewRequest: AgentsViewRequest | null;  // Latest request to show the Agents page (App switches view)

  // Actions
  addTerminal: (cwd?: string, projectPath?: string, options?: { launchCLI?: boolean }) => Terminal | null;
  addRestoredTerminal: (session: TerminalSession) => Terminal | null;
  // Add a terminal with a specific ID (for terminals created in main process, like OAuth login terminals)
  addExternalTerminal: (id: string, title: string, cwd?: string, projectPath?: string) => Terminal | null;
  removeTerminal: (id: string) => void;
  setMaxTerminals: (max: number) => void;
  updateTerminal: (id: string, updates: Partial<Terminal>) => void;
  setActiveTerminal: (id: string | null) => void;
  setTerminalStatus: (id: string, status: TerminalStatus) => void;
  setCLIMode: (id: string, isCLIMode: boolean) => void;
  /** Show a spinner over the window until what it starts is ready (undefined: hide it) */
  setTerminalLoading: (id: string, kind: TerminalLoadingKind | undefined) => void;
  setAssociatedTask: (id: string, taskId: string | undefined) => void;
  setWorktreeConfig: (id: string, config: TerminalWorktreeConfig | undefined) => void;
  setClaudeBusy: (id: string, isBusy: boolean) => void;
  setPendingClaudeResume: (id: string, pending: boolean) => void;
  setClaudeNamedOnce: (id: string, named: boolean) => void;
  clearAllTerminals: () => void;
  setHasRestoredSessions: (value: boolean) => void;
  reorderTerminals: (activeId: string, overId: string) => void;
  /** Resume a restored agent window's Claude Code session (queued: one window at a time) */
  queueClaudeResume: (id: string) => void;
  /**
   * Open a task's Claude Code session in a new agent window of its project: the window starts in
   * the task's worktree, resumes the session and is titled after the task. Also asks the app to
   * show the Agents page. Returns null when the project has no room for another window.
   */
  openTaskSession: (request: TaskSessionRequest) => Terminal | null;

  // Selectors
  getTerminal: (id: string) => Terminal | undefined;
  getActiveTerminal: () => Terminal | undefined;
  canAddTerminal: (projectPath?: string) => boolean;
  getTerminalsForProject: (projectPath: string) => Terminal[];
  getWorktreeCount: () => number;
}

/**
 * Whether a window belongs to a project.
 *
 * Strictly its own project: a window with no project used to match every project's grid, which both
 * showed it where it did not belong and hid it from that project's limit.
 */
export function isProjectTerminal(terminal: Terminal, projectPath?: string): boolean {
  return terminal.projectPath === projectPath;
}

/**
 * Helper function to count active (non-exited) terminals for a specific project.
 * Extracted to avoid duplicating the counting logic across multiple methods.
 *
 * @param terminals - The array of all terminals
 * @param projectPath - The project path to filter by
 * @returns The count of active terminals for the given project
 */
export function getActiveProjectTerminalCount(terminals: Terminal[], projectPath?: string): number {
  return terminals.filter(t => t.status !== 'exited' && isProjectTerminal(t, projectPath)).length;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  layouts: [],
  activeTerminalId: null,
  // Maximum terminals per project, synced from the "Maximum windows" app setting.
  // Capped to prevent excessive memory usage from terminal buffers (~1MB each)
  // and PTY process resource exhaustion.
  maxTerminals: DEFAULT_MAX_TERMINALS,
  hasRestoredSessions: false,
  agentsViewRequest: null,

  addTerminal: (cwd?: string, projectPath?: string, options?: { launchCLI?: boolean }) => {
    const state = get();
    const activeCount = getActiveProjectTerminalCount(state.terminals, projectPath);
    if (activeCount >= state.maxTerminals) {
      debugLog(`[TerminalStore] Cannot add terminal: limit of ${state.maxTerminals} reached for project ${projectPath}`);
      return null;
    }

    const newTerminal: Terminal = {
      id: crypto.randomUUID(),
      title: `Terminal ${state.terminals.length + 1}`,
      status: 'idle',
      cwd: cwd || process.env.HOME || '~',
      createdAt: new Date(),
      isCLIMode: false,
      // outputBuffer removed - managed by terminalBufferManager
      projectPath,
      displayOrder: state.terminals.length,  // New terminals appear at the end
      launchCLIOnCreate: options?.launchCLI,
    };

    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: newTerminal.id,
    }));
    // A new window shows a spinner until its shell, or Claude Code for "New agent", is ready
    get().setTerminalLoading(newTerminal.id, options?.launchCLI ? 'claude' : 'shell');

    return newTerminal;
  },

  addRestoredTerminal: (session: TerminalSession) => {
    const state = get();
    debugLog(`[TerminalStore] addRestoredTerminal called for session: ${session.id}, title: "${session.title}", projectPath: ${session.projectPath}`);

    // CRITICAL: Always restore buffer to buffer manager FIRST, even if terminal already exists.
    // This ensures useXterm can replay the buffer regardless of whether this is a fresh restore
    // or a re-restore (e.g., after project switch). The buffer must be available before
    // the Terminal component mounts and useXterm tries to read it.
    if (session.outputBuffer) {
      terminalBufferManager.set(session.id, session.outputBuffer);
      debugLog(`[TerminalStore] Restored buffer for terminal ${session.id}, size: ${session.outputBuffer.length} chars`);
    } else {
      debugLog(`[TerminalStore] No output buffer to restore for terminal ${session.id}`);
    }

    // Check if terminal already exists
    const existingTerminal = state.terminals.find(t => t.id === session.id);
    if (existingTerminal) {
      debugLog(`[TerminalStore] Terminal ${session.id} already exists in store, returning existing (buffer was still restored above)`);

      // If session was in Claude mode before shutdown, update pendingCLIResume for re-restore scenarios
      // (e.g., after project switch). This ensures the deferred resume logic can trigger even when
      // the terminal already exists in the store.
      if (session.isCLIMode === true && !existingTerminal.pendingCLIResume) {
        debugLog(`[TerminalStore] Updating pendingCLIResume for existing terminal ${session.id}`);
        set((state) => ({
          terminals: state.terminals.map(t =>
            t.id === session.id ? { ...t, pendingCLIResume: true } : t
          )
        }));
      }

      return existingTerminal;
    }

    // Restored windows count against the limit like any other: a project whose file holds more
    // sessions than the limit allows gets the first ones back, in display order, and the rest stay
    // on disk rather than opening a grid the user cannot create by hand.
    const activeCount = getActiveProjectTerminalCount(state.terminals, session.projectPath);
    if (activeCount >= state.maxTerminals) {
      debugLog(`[TerminalStore] Not restoring ${session.id}: limit of ${state.maxTerminals} reached for project ${session.projectPath}`);
      return null;
    }

    const restoredTerminal: Terminal = {
      id: session.id,
      title: session.title,
      status: 'idle',  // Will be updated to 'running' when PTY is created
      cwd: session.cwd,
      createdAt: new Date(session.createdAt),
      // Reset Claude mode to false - Claude Code is killed on app restart
      isCLIMode: false,
      // outputBuffer now stored in terminalBufferManager (done above before existence check)
      isRestored: true,
      projectPath: session.projectPath,
      // Worktree config is validated in main process before restore
      worktreeConfig: session.worktreeConfig,
      // Restore displayOrder for tab position persistence (falls back to end if not set)
      displayOrder: session.displayOrder ?? state.terminals.length,
      // If session was in Claude mode before shutdown, mark for deferred resume.
      // This ensures the renderer knows to trigger 'claude --continue' when the terminal
      // becomes active, without relying on the TERMINAL_PENDING_RESUME IPC event timing
      // (which may be sent before the Terminal component mounts its listener).
      pendingCLIResume: session.isCLIMode === true,
    };

    set((state) => ({
      terminals: [...state.terminals, restoredTerminal],
      activeTerminalId: state.activeTerminalId || restoredTerminal.id,
    }));
    // A restored window starts over too (a new shell, and Claude Code again when its session is
    // resumed): it shows a spinner instead of the buffer it replays and the start-up that follows
    get().setTerminalLoading(restoredTerminal.id, restoredTerminal.pendingCLIResume ? 'claude' : 'shell');

    debugLog(`[TerminalStore] Successfully added restored terminal ${session.id} to store, isRestored: true, pendingCLIResume: ${session.isCLIMode === true}`);
    return restoredTerminal;
  },

  addExternalTerminal: (id: string, title: string, cwd?: string, projectPath?: string) => {
    const state = get();

    // Check if terminal with this ID already exists
    const existingTerminal = state.terminals.find(t => t.id === id);
    if (existingTerminal) {
      // Just activate it and return it
      set({ activeTerminalId: id });
      return existingTerminal;
    }

    const activeCount = getActiveProjectTerminalCount(state.terminals, projectPath);
    if (activeCount >= state.maxTerminals) {
      debugLog(`[TerminalStore] Cannot add external terminal: limit of ${state.maxTerminals} reached for project ${projectPath}`);
      return null;
    }

    const newTerminal: Terminal = {
      id,
      title,
      status: 'running',  // External terminals are already running
      cwd: cwd || process.env.HOME || '~',
      createdAt: new Date(),
      isCLIMode: false,
      projectPath,
      displayOrder: state.terminals.length,  // New terminals appear at the end
    };

    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: newTerminal.id,
    }));

    return newTerminal;
  },

  setMaxTerminals: (max: number) => {
    set({ maxTerminals: Math.min(MAX_TERMINALS_LIMIT, Math.max(MIN_TERMINALS, Math.round(max))) });
  },

  removeTerminal: (id: string) => {
    clearTimeout(loadingTimers.get(id));
    loadingTimers.delete(id);
    stopTerminalLoading(id);
    // Clean up buffer manager, output callback, and XState actor
    terminalBufferManager.dispose(id);
    xtermCallbacks.delete(id);
    const actor = terminalActors.get(id);
    if (actor) {
      actor.stop();
      terminalActors.delete(id);
      debugLog(`[TerminalStore] Cleaned up XState actor for terminal: ${id}`);
    }

    set((state) => {
      const newTerminals = state.terminals.filter((t) => t.id !== id);
      const newActiveId = state.activeTerminalId === id
        ? (newTerminals.length > 0 ? newTerminals[newTerminals.length - 1].id : null)
        : state.activeTerminalId;

      return {
        terminals: newTerminals,
        activeTerminalId: newActiveId,
      };
    });
  },

  updateTerminal: (id: string, updates: Partial<Terminal>) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    }));
  },

  setActiveTerminal: (id: string | null) => {
    set({ activeTerminalId: id });
  },

  setTerminalStatus: (id: string, status: TerminalStatus) => {
    // Notify XState machine of lifecycle transitions
    if (status === 'running') {
      sendTerminalMachineEvent(id, { type: 'SHELL_READY' });
    } else if (status === 'exited') {
      sendTerminalMachineEvent(id, { type: 'SHELL_EXITED' });
    }

    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, status } : t
      ),
    }));
  },

  setTerminalLoading: (id: string, kind: TerminalLoadingKind | undefined) => {
    clearTimeout(loadingTimers.get(id));
    loadingTimers.delete(id);
    if (kind) {
      startTerminalLoading(id, kind);
      // Nothing recognisable came: the window is shown as it is rather than hidden for good
      loadingTimers.set(id, setTimeout(() => get().setTerminalLoading(id, undefined), TERMINAL_LOADING_TIMEOUT_MS));
    } else {
      stopTerminalLoading(id);
    }
    set((state) => ({
      terminals: state.terminals.map((terminal) => (terminal.id === id ? { ...terminal, loading: kind } : terminal)),
    }));
  },

  setCLIMode: (id: string, isCLIMode: boolean) => {
    // Send corresponding event to XState machine
    if (isCLIMode) {
      // Ensure machine has transitioned past idle before sending CLAUDE_ACTIVE
      const actor = getOrCreateTerminalActor(id);
      if (String(actor.getSnapshot().value) === 'idle') {
        sendTerminalMachineEvent(id, { type: 'SHELL_READY' });
      }
      sendTerminalMachineEvent(id, { type: 'CLAUDE_ACTIVE' });
    } else {
      // Only send CLAUDE_EXITED if machine is in a state that accepts it
      const actor = getOrCreateTerminalActor(id);
      const currentState = String(actor.getSnapshot().value);
      if (currentState === 'claude_starting' || currentState === 'claude_active') {
        sendTerminalMachineEvent(id, { type: 'CLAUDE_EXITED' });
      }
    }

    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id
          ? {
              ...t,
              isCLIMode,
              status: isCLIMode ? 'claude-active' : (t.status === 'exited' ? 'exited' : 'running'),
              // Reset busy state and naming flag when leaving Claude mode
              isClaudeBusy: isCLIMode ? t.isClaudeBusy : undefined,
              cliNamedOnce: isCLIMode ? t.cliNamedOnce : undefined
            }
          : t
      ),
    }));
  },

  setAssociatedTask: (id: string, taskId: string | undefined) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, associatedTaskId: taskId } : t
      ),
    }));
  },

  setWorktreeConfig: (id: string, config: TerminalWorktreeConfig | undefined) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, worktreeConfig: config } : t
      ),
    }));
  },

  setClaudeBusy: (id: string, isBusy: boolean) => {
    // Send CLAUDE_BUSY event to XState machine
    sendTerminalMachineEvent(id, { type: 'CLAUDE_BUSY', isBusy });

    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, isClaudeBusy: isBusy } : t
      ),
    }));
  },

  setPendingClaudeResume: (id: string, pending: boolean) => {
    // Send RESUME_REQUESTED or RESUME_COMPLETE to XState machine
    if (pending) {
      // Resuming runs `claude --continue` in the project (its latest session); make sure the
      // machine has left idle so it accepts the request
      const actor = getOrCreateTerminalActor(id);
      if (String(actor.getSnapshot().value) === 'idle') {
        sendTerminalMachineEvent(id, { type: 'SHELL_READY' });
      }
      sendTerminalMachineEvent(id, { type: 'RESUME_REQUESTED' });
    } else {
      // Resume cleared - either completed or cancelled
      const actor = terminalActors.get(id);
      if (actor && String(actor.getSnapshot().value) === 'pending_resume') {
        sendTerminalMachineEvent(id, { type: 'RESUME_COMPLETE' });
      }
    }

    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, pendingCLIResume: pending } : t
      ),
    }));
  },

  setClaudeNamedOnce: (id: string, named: boolean) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, cliNamedOnce: named } : t
      ),
    }));
  },

  clearAllTerminals: () => {
    // Clean up all resources for every terminal
    const terminals = get().terminals;
    for (const terminal of terminals) {
      terminalBufferManager.dispose(terminal.id);
      xtermCallbacks.delete(terminal.id);
    }

    // Clean up all XState actors
    for (const [_id, actor] of terminalActors) {
      actor.stop();
    }
    terminalActors.clear();
    set({ terminals: [], activeTerminalId: null, hasRestoredSessions: false });
  },

  setHasRestoredSessions: (value: boolean) => {
    set({ hasRestoredSessions: value });
  },

  reorderTerminals: (activeId: string, overId: string) => {
    set((state) => {
      const oldIndex = state.terminals.findIndex((t) => t.id === activeId);
      const newIndex = state.terminals.findIndex((t) => t.id === overId);

      if (oldIndex === -1 || newIndex === -1) {
        return state;
      }

      // Reorder terminals and update displayOrder values based on new positions
      const reorderedTerminals = arrayMove(state.terminals, oldIndex, newIndex);
      const terminalsWithOrder = reorderedTerminals.map((terminal, index) => ({
        ...terminal,
        displayOrder: index,
      }));

      return {
        terminals: terminalsWithOrder,
      };
    });
  },

  queueClaudeResume: (id: string) => {
    if (!claudeResumeQueue.includes(id)) claudeResumeQueue.push(id);
    if (claudeResumeRunning) return;
    claudeResumeRunning = true;
    void (async () => {
      try {
        while (claudeResumeQueue.length > 0) {
          const terminalId = claudeResumeQueue.shift() as string;
          // Skip windows closed or already resumed while waiting
          if (!get().terminals.find((t) => t.id === terminalId)?.pendingCLIResume) continue;
          debugLog(`[TerminalStore] Resuming Claude Code in terminal: ${terminalId}`);
          get().setPendingClaudeResume(terminalId, false);
          // The spinner waits for this window's Claude Code, counting from the moment it starts:
          // the windows resume one after another, so the later ones start well after the restore
          get().setTerminalLoading(terminalId, 'claude');
          window.electronAPI.activateDeferredClaudeResume(terminalId);
          // The terminal now runs `claude --continue` in the project: show it in Claude mode
          get().setCLIMode(terminalId, true);
          // Stagger the starts: many Claude Code processes starting at once can crash the app
          if (claudeResumeQueue.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } finally {
        claudeResumeRunning = false;
      }
    })();
  },

  openTaskSession: (request: TaskSessionRequest) => {
    const terminal = get().addTerminal(request.worktreePath, request.projectPath, { launchCLI: true });
    if (terminal) {
      get().updateTerminal(terminal.id, {
        title: request.title,
        associatedTaskId: request.taskId,
        worktreeConfig: buildTaskWorktreeConfig(request, terminal.id),
        pendingTaskSession: buildPendingTaskSession(request)
      });
    }
    set((state) => ({
      agentsViewRequest: { projectPath: request.projectPath, seq: (state.agentsViewRequest?.seq ?? 0) + 1 }
    }));
    return terminal ? get().getTerminal(terminal.id) ?? null : null;
  },

  getTerminal: (id: string) => {
    return get().terminals.find((t) => t.id === id);
  },

  getActiveTerminal: () => {
    const state = get();
    return state.terminals.find((t) => t.id === state.activeTerminalId);
  },

  canAddTerminal: (projectPath?: string) => {
    const state = get();
    return getActiveProjectTerminalCount(state.terminals, projectPath) < state.maxTerminals;
  },

  getTerminalsForProject: (projectPath: string) => {
    return get().terminals.filter(t => isProjectTerminal(t, projectPath));
  },

  getWorktreeCount: () => {
    return get().terminals.filter(t => t.worktreeConfig).length;
  },
}));

// Track in-progress restore operations to prevent race conditions
const restoringProjects = new Set<string>();

/**
 * Restore terminal sessions for a project from persisted storage
 */
export async function restoreTerminalSessions(projectPath: string): Promise<void> {
  // Validate input
  if (!projectPath || typeof projectPath !== 'string') {
    debugLog('[TerminalStore] Invalid projectPath, skipping restore');
    return;
  }

  // Prevent concurrent restores for same project (race condition protection)
  if (restoringProjects.has(projectPath)) {
    debugLog('[TerminalStore] Already restoring terminals for this project, skipping');
    return;
  }
  restoringProjects.add(projectPath);

  try {
    const store = useTerminalStore.getState();

    // Get terminals for this project that exist in state
    const projectTerminals = store.terminals.filter(t => t.projectPath === projectPath);

    if (projectTerminals.length > 0) {
      // Check if PTY processes are alive for existing terminals
      const aliveChecks = await Promise.all(
        projectTerminals.map(async (terminal) => {
          try {
            const result = await window.electronAPI.checkTerminalPtyAlive(terminal.id);
            return { terminal, alive: result.success && result.data?.alive === true };
          } catch {
            return { terminal, alive: false };
          }
        })
      );

      // Remove dead terminals from store (they have state but no PTY process)
      const deadTerminals = aliveChecks.filter(c => !c.alive);

      for (const { terminal } of deadTerminals) {
        debugLog(`[TerminalStore] Removing dead terminal: ${terminal.id}`);
        store.removeTerminal(terminal.id);
      }

      // If all terminals were alive, we're done
      if (deadTerminals.length === 0) {
        debugLog('[TerminalStore] All terminals have live PTY processes');
        return;
      }

      // Note: We don't skip disk restore when alive terminals exist because:
      // 1. Dead terminals were removed from state above
      // 2. addRestoredTerminal() has duplicate protection (checks terminal ID)
      // 3. Disk restore will safely only add back the dead terminals
      debugLog(`[TerminalStore] ${deadTerminals.length} terminals had dead PTY, will restore from disk`);
    }

    // Restore from disk
    debugLog(`[TerminalStore] Fetching terminal sessions from disk for project: ${projectPath}`);
    const result = await window.electronAPI.getTerminalSessions(projectPath);
    if (!result.success || !result.data || result.data.length === 0) {
      debugLog(`[TerminalStore] No sessions found on disk for project: ${projectPath}, success: ${result.success}, sessionCount: ${result.data?.length || 0}`);
      return;
    }
    debugLog(`[TerminalStore] Found ${result.data.length} sessions on disk for project: ${projectPath}`);

    // Sort sessions by displayOrder before restoring (lower = further left)
    // Sessions without displayOrder are placed at the end
    const sortedSessions = [...result.data].sort((a, b) => {
      const orderA = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });

    // Add terminals to the store in correct order (they'll be created in the TerminalGrid component)
    debugLog(`[TerminalStore] Adding ${sortedSessions.length} sorted sessions to store`);
    for (const session of sortedSessions) {
      store.addRestoredTerminal(session);
    }

    store.setHasRestoredSessions(true);
    debugLog(`[TerminalStore] Completed terminal session restoration for project: ${projectPath}`);
  } catch (error) {
    debugError('[TerminalStore] Error restoring sessions:', error);
  } finally {
    restoringProjects.delete(projectPath);
  }
}
