import { appLog } from '../app-logger';

/**
 * Profile assignment for a task
 */
interface TaskProfileAssignment {
  profileId: string;
  profileName: string;
  reason: 'proactive' | 'reactive' | 'manual';
  sessionId?: string;
}

/**
 * What every entry knows about itself. A lookup that names no project finds its entry by the
 * task id alone, and the key cannot be taken apart for it, so each entry carries both.
 */
interface TaskEntry {
  taskId: string;
  projectId?: string;
}

interface RunningTask extends TaskEntry {
  startedAt: Date;
}

type AssignedTask = TaskEntry & TaskProfileAssignment;

/**
 * A task id is its spec id (`001-<slug>`), which each project numbers from its own start, so two
 * projects can be running the same one. Every entry is therefore held per project and task: keyed
 * by the task alone, one project's run would read, overwrite and remove the other's. An entry
 * stored before its project was known keeps the empty project.
 */
const stateKey = (taskId: string, projectId?: string): string => `${projectId ?? ''}\u0000${taskId}`;

/**
 * Running tasks and their Claude profile assignments
 */
export class AgentState {
  private running: Map<string, RunningTask> = new Map();

  // The Claude profile and session of each task
  private taskProfileAssignments: Map<string, AssignedTask> = new Map();

  /**
   * The key a task's entry is held under, or undefined when this state holds none for it.
   *
   * A caller that names the project gets that project's entry, and otherwise an entry stored
   * before any project was known - never another project's. The task handlers all name their
   * project now (the board sends it with the request), but a bare task id still has to answer for
   * callers that have none, such as the Insights task tools: with one project running that task
   * there is nothing to confuse it with. When two projects are running it there is no honest
   * answer, and guessing would read or remove the wrong project's entry, so the lookup says which
   * task it was asked about and refuses. The caller then sees "not running", which the user can
   * repeat from the project's own board, instead of another project's run quietly losing its
   * state.
   */
  private resolveKey(
    map: Map<string, TaskEntry>,
    taskId: string,
    projectId: string | undefined,
    operation: string
  ): string | undefined {
    const { key, ambiguous } = this.locate(map, taskId, projectId);
    if (ambiguous) {
      appLog.warn(
        `[AgentState] ${operation}: ${taskId} is in more than one project and no project was named, doing nothing`
      );
    }
    return key;
  }

  /**
   * The lookup itself: `ambiguous` tells a caller that has to write apart from one that only
   * reads, since adding an entry under no project while two projects hold one would leave a
   * third that every later bare-task-id lookup would find first.
   */
  private locate(
    map: Map<string, TaskEntry>,
    taskId: string,
    projectId: string | undefined
  ): { key: string | undefined; ambiguous: boolean } {
    const exact = stateKey(taskId, projectId);
    if (map.has(exact)) return { key: exact, ambiguous: false };
    if (projectId) {
      const projectless = stateKey(taskId, undefined);
      return { key: map.has(projectless) ? projectless : undefined, ambiguous: false };
    }

    let found: string | undefined;
    for (const [key, entry] of map) {
      if (entry.taskId !== taskId) continue;
      if (found !== undefined) return { key: undefined, ambiguous: true };
      found = key;
    }
    return { key: found, ambiguous: false };
  }

  /** Mark a task as running */
  addRunning(taskId: string, projectId?: string): void {
    this.running.set(stateKey(taskId, projectId), { taskId, projectId, startedAt: new Date() });
  }

  /** Mark a task as no longer running */
  removeRunning(taskId: string, projectId?: string): boolean {
    const key = this.resolveKey(this.running, taskId, projectId, 'removeRunning');
    return key !== undefined && this.running.delete(key);
  }

  /** Check if a task is running */
  isRunning(taskId: string, projectId?: string): boolean {
    return this.resolveKey(this.running, taskId, projectId, 'isRunning') !== undefined;
  }

  /** All running task IDs */
  getRunningTaskIds(): string[] {
    return Array.from(this.running.values(), (task) => task.taskId);
  }

  /** Clear all state (for testing or cleanup) */
  clear(): void {
    this.running.clear();
    this.taskProfileAssignments.clear();
  }

  // ============================================
  // Profile and session of tasks
  // ============================================

  /**
   * Running tasks grouped by profile.
   *
   * The task ids are reported as they are, without the project they are keyed under. Two
   * projects running the same task therefore show up as that id twice, which is the truth about
   * how many runs are on the profile. Each one's assignment is looked up by its own project, so
   * the two never read each other's profile.
   */
  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    const byProfile: Record<string, string[]> = {};
    let totalRunning = 0;

    for (const task of this.running.values()) {
      // Through the same lookup every other read goes through, rather than straight into the map:
      // the project is still the last and optional argument of `assignProfileToTask` and
      // `updateTaskSession`, so an assignment can have been stored before the project was known,
      // and only `locate` falls back to that entry. Reading the composite key directly would miss
      // it and report a run that does know its project as the `default` profile.
      const assignment = this.getTaskProfileAssignment(task.taskId, task.projectId);
      const profileId = assignment?.profileId || 'default';
      if (!byProfile[profileId]) {
        byProfile[profileId] = [];
      }
      byProfile[profileId].push(task.taskId);
      totalRunning++;
    }

    return { byProfile, totalRunning };
  }

  /** Assign a profile to a task */
  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: 'proactive' | 'reactive' | 'manual',
    projectId?: string
  ): void {
    // An assignment stored before any project was known is taken over rather than left beside the
    // new one. Two entries for one task make every later bare-task-id lookup ambiguous, so it
    // refuses: the session id would stop being recorded and project-scoped readers would go on
    // answering from the older entry while nothing ever read the newer one. This is the same
    // consolidation `TaskStateManager.keyForProject` does, for the same reason.
    const { key: held } = this.locate(this.taskProfileAssignments, taskId, projectId);
    const existing = held !== undefined ? this.taskProfileAssignments.get(held) : undefined;
    const key = stateKey(taskId, projectId);
    if (held !== undefined && held !== key) this.taskProfileAssignments.delete(held);
    this.taskProfileAssignments.set(key, {
      taskId,
      projectId,
      profileId,
      profileName,
      reason,
      sessionId: existing?.sessionId // Preserve session ID if exists
    });
  }

  /** Profile assignment of a task */
  getTaskProfileAssignment(taskId: string, projectId?: string): TaskProfileAssignment | undefined {
    const key = this.resolveKey(this.taskProfileAssignments, taskId, projectId, 'getTaskProfileAssignment');
    return key !== undefined ? this.taskProfileAssignments.get(key) : undefined;
  }

  /**
   * Update the Claude Code session ID for a task
   *
   * @param profileInfo - Optional profile info when creating a new assignment
   */
  updateTaskSession(
    taskId: string,
    sessionId: string,
    profileInfo?: { profileId: string; profileName: string },
    projectId?: string
  ): void {
    const { key, ambiguous } = this.locate(this.taskProfileAssignments, taskId, projectId);
    if (ambiguous) {
      appLog.warn(
        `[AgentState] updateTaskSession: ${taskId} is in more than one project and no project was named, doing nothing`
      );
      return;
    }
    const assignment = key !== undefined ? this.taskProfileAssignments.get(key) : undefined;
    if (assignment) {
      assignment.sessionId = sessionId;
    } else {
      this.taskProfileAssignments.set(stateKey(taskId, projectId), {
        taskId,
        projectId,
        profileId: profileInfo?.profileId ?? 'unknown',
        profileName: profileInfo?.profileName ?? 'Unknown',
        reason: 'proactive',
        sessionId
      });
    }
  }

  /** Claude Code session ID of a task */
  getTaskSessionId(taskId: string, projectId?: string): string | undefined {
    return this.getTaskProfileAssignment(taskId, projectId)?.sessionId;
  }

  /** Clear the profile assignment of a task */
  clearTaskProfileAssignment(taskId: string, projectId?: string): void {
    const key = this.resolveKey(this.taskProfileAssignments, taskId, projectId, 'clearTaskProfileAssignment');
    if (key !== undefined) this.taskProfileAssignments.delete(key);
  }
}
