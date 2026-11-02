/**
 * The openings of the turns Workbench itself sends a task run, phase by phase.
 *
 * They live here, apart from the prompts they begin, because two places need the same strings:
 * `buildInput()` in `task-runner.ts` composes the turns from them, and the memory backfill
 * (`self-improve/transcripts.ts`) drops transcript turns that start with one. Those turns are the
 * app talking to Claude Code rather than the user talking, and a "preference" learned from one
 * would be a memory of Workbench's own instructions stated as if the user had asked for it.
 *
 * Keeping one copy is what makes the filter safe to rely on: a reworded prompt changes both sides
 * at once instead of silently leaving the backfill matching text that is no longer sent.
 *
 * The phases whose turn opens with the `<task>` block need nothing here - the backfill already
 * drops a turn that opens with a tag.
 */
export const PHASE_PROMPT_OPENINGS = {
  /** `implement`, resuming a session that already did some of the work */
  continuing: 'Continue the task from where you left off.',
  /** `implement`, resuming the session that planned */
  planApproved: 'The plan is approved. Implement it now',
  /** `validate` */
  validate: 'Before handing this off, validate the work:',
  /** `revise` */
  revise: 'The reviewer requested changes:',
  /** `resync`: the task's base branch moved on and the session merges it in */
  resync: 'Your base branch moved on:',
  /** `resync`, second pass after Workbench checked the merge */
  resyncCheck: 'Workbench checked your merge and found problems:',
  /** Any step, carried on in a new process after messages from the user's sessions were switched off */
  restarted: 'This step\'s Claude Code process was restarted',
} as const;

/** Every opening, for matching a transcript turn against all of them */
export const PHASE_PROMPT_OPENING_LIST: readonly string[] = Object.values(PHASE_PROMPT_OPENINGS);

/**
 * How the turns Workbench writes into a session start (`formatMessage()` in
 * `task-messaging/broker.ts`): notices and peer messages, never something the user said. The
 * memory backfill drops them like phase prompts.
 */
export const WORKBENCH_TURN_PREFIXES: readonly string[] = ['[Workbench]', '[Message from task '];

/** Marker Workbench adds to every message it writes to a running session's stdin */
export const WORKBENCH_INPUT_MARKER_PATTERN = /\[Workbench message wbm-[A-Za-z0-9_-]+\]/;
