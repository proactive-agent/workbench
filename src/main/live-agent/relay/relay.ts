/**
 * Relay — watches agent sessions, receives hook events, and streams them to the
 * subscribed clients (Workbench's agent windows, through the worker's port).
 * From agent-flow (relay/relay.ts); here it runs in a worker thread
 * (see ../relay-worker.ts) and serves several workspaces at once.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { HookServer, type SessionOwner } from './lib/hook-server'
import { AgentEvent, SessionInfo, WatchedSession } from './lib/protocol'
import { TranscriptParser, isActivityLine } from './lib/transcript-parser'
import { readCompleteLines, readNewFileLines, foldPathCase } from './lib/fs-utils'
import { createLogger } from './lib/logger'
import { scanSubagentsDir, readSubagentNewLines, stopTailing, fileIdleMs } from './lib/subagent-watcher'
import { isWslUncPath, windowsToWsl, wslToWindows, type WslPathOptions } from '../../platform/wsl-paths'
import { isHeadlessEntrypoint, transcriptEntrypoint } from '../../claude-code/session-entrypoint'
import {
  INACTIVITY_TIMEOUT_MS, BUSY_INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, WORKSPACE_HASH_LENGTH, MAX_EVENT_BUFFER, HIDDEN_TOOLS, SUBAGENT_STALE_MS,
} from './lib/constants'

const log = createLogger('Relay')

/** The `projects` dirs of the Claude Code config dirs whose sessions are watched
 *  (~/.claude and each Claude account's CLAUDE_CONFIG_DIR) */
const claudeProjectDirs: string[] = []

/** The WSL distribution Claude Code runs in (Windows with the WSL shell), else null: its
 *  sessions record Linux working directories and live in Linux-named project dirs */
let wsl: WslPathOptions | null = null

/** How often a session file is read when it can't be watched: fs.watch doesn't work on
 *  \\wsl.localhost paths (the WSL Claude home), so those are polled, sooner than the fallback */
const WSL_POLL_MS = 1000

/** A session's recorded working directory as a host path: Claude Code inside WSL records Linux
 *  paths (`/mnt/c/x` is `C:\x`, any other `/x` is `\\wsl.localhost\<distro>\x`) */
export function sessionHostDir(cwd: string, runtime: WslPathOptions | null): string {
  return runtime && cwd.startsWith('/') ? wslToWindows(cwd, runtime) : cwd
}

const hostDir = (cwd: string) => sessionHostDir(cwd, wsl)

/** A path as compared with a session's working directory */
function dirKey(p: string): string {
  return foldPathCase(normalizePath(p))
}

// ─── Client management ──────────────────────────────────────────────────────

/** Delivers a message to clients (the worker posts it to the main process) */
type SendFn = (clientIds: string[], data: string) => void

let sendToClients: SendFn = () => {}

/** Subscribed clients: each gets the sessions run in its directory */
const clients = new Map<string, { dirKey: string }>()

function sendSSE(clientId: string, data: unknown) {
  sendToClients([clientId], JSON.stringify(data))
}

/** Send to the clients that show the session (those in its directory) */
function broadcast(sessionId: string, data: string) {
  const key = sessions.get(sessionId)?.dirKey
  if (key === undefined) return
  const ids: string[] = []
  for (const [id, client] of clients) if (client.dirKey === key) ids.push(id)
  if (ids.length > 0) sendToClients(ids, data)
}

// ─── Event buffering ────────────────────────────────────────────────────────

/** A session's recent events, plus what's needed to draw them once older ones
 *  are trimmed (see carriedOver) */
interface SessionHistory {
  /** Events carried over from the trimmed part: they precede `events` */
  prelude: AgentEvent[]
  events: AgentEvent[]
  /** Number of events ever buffered for the session (the last one's position + 1) */
  total: number
}

const eventBuffer = new Map<string, SessionHistory>()

/**
 * The events from a trimmed history that the rest still depends on, so later
 * events still have nodes to apply to: the spawn of every agent still around
 * after them (and of its ancestors, so it keeps its place in the tree), the
 * start of every tool call still running, and the completion of each kept
 * agent that had finished. The main agent is always kept.
 * (The web app trims its own buffers the same way: web/hooks/use-relay.ts.)
 */
function carriedOver(events: AgentEvent[]): AgentEvent[] {
  const spawns = new Map<string, AgentEvent>()
  const completions = new Map<string, AgentEvent>()
  const runningTools = new Map<string, AgentEvent>()
  for (const event of events) {
    const name = String(event.payload.name ?? event.payload.agent ?? '')
    switch (event.type) {
      case 'agent_spawn':
        // A finished sub-agent isn't revived (only the main agent comes back), as the graph does
        if (completions.has(name) && !spawns.get(name)?.payload.isMain) break
        spawns.set(name, event)
        completions.delete(name)
        break
      case 'agent_complete':
        for (const id of event.payload.endsSession ? spawns.keys() : [name]) completions.set(id, event)
        for (const [toolId, tool] of runningTools) {
          if (event.payload.endsSession || tool.payload.agent === name) runningTools.delete(toolId)
        }
        break
      case 'message':
      case 'tool_call_start':
        // Ignored for a finished sub-agent (only the main agent comes back), as the graph does
        if (completions.has(name) && !spawns.get(name)?.payload.isMain) break
        completions.delete(name)
        if (event.type === 'tool_call_start') runningTools.set(String(event.payload.id), event)
        break
      case 'tool_call_end':
        runningTools.delete(String(event.payload.id))
        break
    }
  }
  // Keep the live agents, the main agent, and the ancestors of all of them
  const keep = new Set<string>()
  const keepWithAncestors = (id: string | undefined) => {
    while (id && !keep.has(id) && spawns.has(id)) {
      keep.add(id)
      id = spawns.get(id)!.payload.parent as string | undefined
    }
  }
  for (const [id, spawn] of spawns) {
    if (!completions.has(id) || spawn.payload.isMain) keepWithAncestors(id)
  }
  return [
    ...[...spawns].filter(([id]) => keep.has(id)).map(([, spawn]) => spawn),
    ...[...runningTools.values()].filter(tool => keep.has(String(tool.payload.agent))),
    // One event can complete several agents (endsSession): include it once
    ...new Set([...completions].filter(([id]) => keep.has(id)).map(([, completion]) => completion)),
  ]
}

function broadcastEvent(event: AgentEvent & { sessionId: string }) {
  let history = eventBuffer.get(event.sessionId)
  if (!history) { history = { prelude: [], events: [], total: 0 }; eventBuffer.set(event.sessionId, history) }
  history.events.push(event)
  history.total++
  // Trim in chunks rather than copying the buffer on every event once it's full
  if (history.events.length > MAX_EVENT_BUFFER * 1.1) {
    const trimmed = history.events.splice(0, history.events.length - MAX_EVENT_BUFFER)
    history.prelude = carriedOver([...history.prelude, ...trimmed])
  }

  broadcast(event.sessionId, JSON.stringify({ type: 'agent-event', event }))
}

/** A session's buffered history. Clients treat it as authoritative for that
 *  session (replacing what they had, unless they already have all `total`
 *  events), so resending it never duplicates. */
function historyBatch(sessionId: string) {
  return { type: 'agent-event-batch', sessionId, ...eventBuffer.get(sessionId)! }
}

function broadcastSessionStarted(sessionId: string) {
  broadcast(sessionId, JSON.stringify({
    type: 'session-started',
    session: { id: sessionId, status: 'active', lastActivityTime: Date.now(), owner: sessionOwners.get(sessionId) } as SessionInfo,
  }))
}

// ─── Session owners ─────────────────────────────────────────────────────────

/** The agent window (terminal id) each session runs in, as its hooks report it.
 *  Kept after a session is disposed: it's still that window's if it comes back. */
const sessionOwners = new Map<string, string>()

/** A hook said which window a session runs in: clients showing it learn the
 *  change (each window's graph shows only its own sessions, see use-relay.ts) */
function handleSessionOwner({ sessionId, terminalId }: SessionOwner) {
  if (sessionOwners.get(sessionId) === terminalId) return
  sessionOwners.set(sessionId, terminalId)
  broadcast(sessionId, JSON.stringify({ type: 'session-owner', sessionId, owner: terminalId }))
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId: string): number {
  const session = sessions.get(sessionId)
  return session ? (Date.now() - session.sessionStartTime) / 1000 : 0
}

function emitEvent(event: AgentEvent, sessionId: string) {
  broadcastEvent({ ...event, sessionId })
}

/** Read whatever a sub-agent's file has left (see TranscriptParser.finishSubagent) */
function flushSubagent(sessionId: string, launchId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  // Its file may not be tailed yet (found late, or its .meta.json was pending)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  for (const [filePath, state] of session.subagentWatchers) {
    if (state.agentName === launchId) readSubagentNewLines(watcherDelegate, parser, filePath, sessionId)
  }
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  flushSubagent,
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  touchSession: (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (session) touchSession(session) // only tailed while the session is open
  },
}

/** Whether a tool call or sub-agent is still in flight in the session.
 *  Launches count while they run (their tool calls stay pending after that),
 *  if they were seen live, got a node or have their file tailed: a launch found
 *  at attach whose file never shows up (or is never read) could otherwise
 *  never finish. */
function hasWorkInFlight(session: WatchedSession): boolean {
  for (const id of session.pendingToolCalls.keys()) if (!session.launches.has(id)) return true
  const tailed = new Set([...session.subagentWatchers.values()].map(state => state.agentName))
  for (const [id, launch] of session.launches) {
    if (!launch.finished && (launch.seenLive || session.spawnedSubagents.has(id) || tailed.has(id))) return true
  }
  return false
}

/**
 * Finish the sub-agents whose transcripts have been quiet for SUBAGENT_STALE_MS,
 * along with every sub-agent under them (one waiting on a busy sub-agent of its
 * own is still working): one stopped without a word (e.g. killed with Claude
 * Code) would otherwise stay drawn as running for as long as the session goes on.
 */
function settleStaleSubagents(session: WatchedSession, now = Date.now()): void {
  if (session.sessionCompleted) return
  const idleMs = new Map<string, number>()
  for (const [filePath, state] of session.subagentWatchers) {
    idleMs.set(state.agentName, Math.min(idleMs.get(state.agentName) ?? Infinity, fileIdleMs(filePath, now)))
  }
  const busy = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    if ((idleMs.get(id) ?? Infinity) < SUBAGENT_STALE_MS) return true
    for (const [childId, launch] of session.launches) {
      if (launch.parent === id && !launch.finished && busy(childId, seen)) return true
    }
    return false
  }
  for (const id of idleMs.keys()) {
    // Only one drawn as running (one never drawn gets its node if it works again)
    if (!session.spawnedSubagents.has(id) || session.launches.get(id)?.finished || busy(id)) continue
    log.info(`[session] ${session.sessionId.slice(0, SESSION_ID_DISPLAY)} sub-agent ${id} quiet, taken as stopped`)
    // One shown without its launch being known is finished as one (see handleHookEvent)
    if (!session.launches.has(id)) session.launches.set(id, { parent: ORCHESTRATOR_NAME, seenLive: false, background: false, finished: false })
    parser.finishSubagent(id, session)
  }
}

/** The session is active: note the time and restart its inactivity countdown */
function touchSession(session: WatchedSession) {
  session.lastActivityTime = Date.now()
  armInactivityTimer(session)
}

/** (Re)start the session's inactivity countdown (a longer one while work is
 *  in flight, which can go quiet for a while) */
function armInactivityTimer(session: WatchedSession) {
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  const timeout = hasWorkInFlight(session) ? BUSY_INACTIVITY_TIMEOUT_MS : INACTIVITY_TIMEOUT_MS
  session.inactivityTimer = setTimeout(() => {
    log.info(`[session] ${session.sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
    closeSession(session)
  }, timeout)
}

/** New activity in a closed session: reopen it, before that activity is shown */
function resumeSession(session: WatchedSession) {
  const sessionId = session.sessionId
  session.sessionCompleted = false
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true },
    sessionId,
  })
  // Clients switch to the resumed session; send its history so one that
  // dropped its buffer for it (see use-relay.ts) can draw it again
  broadcastSessionStarted(sessionId)
  broadcast(sessionId, JSON.stringify(historyBatch(sessionId)))
}

/**
 * The session is over (SessionEnd, or inactive for good): close everything
 * still open in it. Its sub-agents stop being tracked too, so if the session
 * is resumed, only what happens from then on is shown.
 */
function closeSession(session: WatchedSession) {
  if (session.sessionCompleted) return
  session.sessionCompleted = true
  session.closedTime = Date.now()
  session.turnOpen = false
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.pendingToolCalls.clear()
  for (const [id, launch] of session.launches) {
    launch.finished = true
    session.spawnedSubagents.add(id)
  }
  for (const [filePath, state] of [...session.subagentWatchers]) stopTailing(session, filePath, state)
  // Files still waiting to be tailed belong to the session so far: never shown
  for (const filePath of [...session.subagentFilesAwaitingMeta.keys(), ...session.subagentFilesAwaitingLaunch.keys()]) {
    session.ignoredSubagentFiles.add(filePath)
  }
  session.subagentFilesAwaitingMeta.clear()
  session.subagentFilesAwaitingLaunch.clear()
  broadcastEvent({
    time: elapsed(session.sessionId),
    type: 'agent_complete',
    payload: { name: ORCHESTRATOR_NAME, endsSession: true },
    sessionId: session.sessionId,
  })
}

/** Start watching a session run in the directory `sessionDirKey` (see dirKey());
 *  `lastActivity` is when its files last changed */
function watchSession(sessionId: string, filePath: string, lastActivity: number, sessionDirKey: string) {
  // Read only complete lines up to the current size — anything appended (or
  // still being written) after this point is picked up by readNewLines.
  let existing: ReturnType<typeof readCompleteLines>
  try {
    existing = readCompleteLines(filePath, 0, fs.statSync(filePath).size)
  } catch { return /* unreadable right now; the next scan retries */ }

  const session: WatchedSession = {
    sessionId, filePath, dirKey: sessionDirKey,
    fileWatcher: null, pollTimer: null, fileSize: existing.nextOffset,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionCompleted: false,
    closedTime: 0,
    turnOpen: false,
    lastActivityTime: lastActivity,
    inactivityTimer: null,
    launches: new Map(),
    subagentDedup: new Map(),
    subagentWatchers: new Map(),
    ignoredSubagentFiles: new Set(),
    launchShapes: new Map(),
    readLaunchMetas: new Set(),
    subagentFilesAwaitingMeta: new Map(),
    subagentFilesAwaitingLaunch: new Map(),
    handedBackTasks: new Set(),
    attachScanDone: false,
    spawnedSubagents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: path.join(path.dirname(filePath), sessionId, 'subagents'),
  }
  sessions.set(sessionId, session)
  parser.prescanExistingContent(existing.lines, session)

  broadcastSessionStarted(sessionId)
  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true },
    sessionId,
  })
  // Tool calls already running when we attached get a node too (sub-agent
  // launches get theirs from the subagent watcher)
  for (const [id, call] of session.pendingToolCalls) {
    if (session.launches.has(id) || HIDDEN_TOOLS.has(call.name)) continue
    broadcastEvent({
      time: 0, type: 'tool_call_start',
      payload: { agent: ORCHESTRATOR_NAME, tool: call.name, id },
      sessionId,
    })
  }
  // The main agent isn't working: its last turn is already over
  if (!session.turnOpen) {
    broadcastEvent({
      time: 0, type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME },
      sessionId,
    })
  }
  // Its history so far: clients that got the events above already have it;
  // ones that still have the session from an earlier watch (it was disposed
  // and is watched again) replace that with it
  broadcast(sessionId, JSON.stringify(historyBatch(sessionId)))

  const watchable = !isWslUncPath(filePath)
  if (watchable) {
    try {
      session.fileWatcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') readNewLines(sessionId)
      }).on('error', () => { /* file removed; the poll loop covers the rest */ })
    } catch { /* fs.watch unsupported; the poll loop covers it */ }
  }

  session.pollTimer = setInterval(() => {
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
    scanSubagentsDir(watcherDelegate, parser, sessionId)
    settleStaleSubagents(session)
  }, watchable ? POLL_FALLBACK_MS : WSL_POLL_MS)

  scanSubagentsDir(watcherDelegate, parser, sessionId)
  session.attachScanDone = true
  armInactivityTimer(session)

  log.info(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize)
  if (!result) return
  session.fileSize = result.newSize
  for (const line of result.lines) {
    // Only the agent working reopens a closed session (not a title, a queue
    // entry or a local command), and it's reopened before that work is shown
    if (session.sessionCompleted && isActivityLine(line)) resumeSession(session)
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  scanSubagentsDir(watcherDelegate, parser, sessionId)
  if (!session.sessionCompleted) touchSession(session)
}

/**
 * A hook event for a session. The transcript is read first, so whatever Claude
 * Code wrote before running the hook (e.g. the turn's last message) is shown
 * before it. Completions go through the parser, so each turn or sub-agent
 * completes once however many signals report it.
 */
function handleHookEvent(event: AgentEvent) {
  const sessionId = event.sessionId
  const session = sessionId ? sessions.get(sessionId) : undefined
  if (!sessionId || !session) return // not a session we show
  readNewLines(sessionId)

  if (event.type === 'tool_call_start') {
    const agent = String(event.payload.agent), id = String(event.payload.id)
    // A late hook for a call already seen (or in a finished sub-agent) adds nothing
    if (!parser.isNewHookTool(session, agent, id)) return
    // The agent is working: a closed session reopens, as for transcript activity
    if (session.sessionCompleted) resumeSession(session)
    parser.startToolFromHook(session, agent, String(event.payload.tool), id)
    // A launch it recorded may have a sub-agent file waiting for it
    scanSubagentsDir(watcherDelegate, parser, sessionId)
    touchSession(session)
    return
  }
  if (event.type === 'tool_call_end') {
    parser.endToolFromHook(session, String(event.payload.agent), String(event.payload.id), event.payload.isError === true)
    if (!session.sessionCompleted) touchSession(session)
    return
  }
  if (event.type !== 'agent_complete') {
    broadcastEvent({ ...event, time: elapsed(sessionId), sessionId })
    return
  }
  const name = String(event.payload.name)
  if (event.payload.endsSession) {
    closeSession(session)
  } else if (name === ORCHESTRATOR_NAME) {
    parser.endTurn(session)
  } else {
    // A sub-agent shown without its launch being known (see subagent-watcher.ts)
    // is finished as one; any other unknown launch has no node to complete
    if (!session.launches.has(name) && session.spawnedSubagents.has(name)) {
      session.launches.set(name, { parent: ORCHESTRATOR_NAME, seenLive: false, background: false, finished: false })
    }
    parser.finishSubagent(name, session)
  }
  // Re-armed after the completion: work it finished no longer keeps the
  // session on the busy timeout
  if (!session.sessionCompleted) touchSession(session)
}

/** Stop watching a session and free everything it holds */
function disposeSession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.fileWatcher?.close()
  session.subagentsDirWatcher?.close()
  if (session.pollTimer) clearInterval(session.pollTimer)
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  for (const sub of session.subagentWatchers.values()) sub.watcher?.close()
  sessions.delete(sessionId)
  eventBuffer.delete(sessionId)
  sessionCwds.delete(session.filePath)
  disposedOffsets.set(session.filePath, session.fileSize)
}

/** How far the files of sessions no longer watched were read: one is watched
 *  again only when the agent works in it again (see isActivityLine) */
const disposedOffsets = new Map<string, number>()

/** Whether a session file has new agent activity since its session was disposed
 *  (or was never watched) */
function hasActivitySinceDisposed(filePath: string): boolean {
  const offset = disposedOffsets.get(filePath)
  if (offset === undefined) return true
  try {
    const read = readCompleteLines(filePath, offset, fs.statSync(filePath).size)
    disposedOffsets.set(filePath, read.nextOffset)
    if (!read.lines.some(isActivityLine)) return false
  } catch { return false /* unreadable right now; the next scan retries */ }
  disposedOffsets.delete(filePath)
  return true
}

// ─── Session scanner ────────────────────────────────────────────────────────

/** Session files' working directories (they never change), by path */
const sessionCwds = new Map<string, string>()
/** How long a session file that records no cwd yet must stay unchanged before
 *  it's watched anyway (rescanned every SCAN_INTERVAL_MS) */
const CWDLESS_SESSION_WAIT_MS = 3000
/** Session files run headless (`claude -p`: the Claude page's chats, task runs), by path: told
 *  by the `entrypoint` on the record that gives the cwd (see ../../claude-code/session-entrypoint) */
const headlessSessions = new Set<string>()

/** A transcript entry's `cwd` field, matched in raw text: entries can be huge
 *  (a pasted image), and user entries write it after the message */
const CWD_FIELD = /"cwd":"((?:[^"\\]|\\.)*)"/
/** How much of a session file one search for its cwd reads, and how much it
 *  re-reads of the previous search (a field cut at its end is found whole) */
const CWD_SEARCH_BYTES = 1024 * 1024
const CWD_SEARCH_OVERLAP = 4096
/** How far session files whose cwd isn't found yet have been searched */
const cwdSearched = new Map<string, number>()

/** The working directory a session file records, if it has one yet. Searched
 *  a chunk at a time, carrying on from the last search. */
function sessionCwd(filePath: string): string | undefined {
  const known = sessionCwds.get(filePath)
  if (known) return known
  const start = Math.max(0, (cwdSearched.get(filePath) ?? 0) - CWD_SEARCH_OVERLAP)
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const chunk = Buffer.alloc(CWD_SEARCH_BYTES)
    const read = fs.readSync(fd, chunk, 0, chunk.length, start)
    const text = chunk.subarray(0, read).toString('utf8')
    const match = CWD_FIELD.exec(text)
    if (match) {
      const cwd = JSON.parse(`"${match[1]}"`) as string
      // The record holding the cwd says how the session was run
      const lineEnd = text.indexOf('\n', match.index)
      const record = text.slice(text.lastIndexOf('\n', match.index) + 1, lineEnd < 0 ? undefined : lineEnd)
      if (isHeadlessEntrypoint(transcriptEntrypoint(record))) headlessSessions.add(filePath)
      sessionCwds.set(filePath, cwd)
      cwdSearched.delete(filePath)
      return cwd
    }
    // At the end of the file, only whole lines count as searched: a last line
    // still being written is searched again once it's complete
    const atEnd = start + read >= fs.fstatSync(fd).size
    const searched = atEnd ? start + chunk.lastIndexOf(0x0a, read - 1) + 1 : start + read
    cwdSearched.set(filePath, Math.max(searched, cwdSearched.get(filePath) ?? 0)) // never backwards
  } catch { /* unreadable right now */ } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return undefined
}


/** A directory whose sessions are watched (an agent window's working directory) */
interface Workspace {
  /** As given, and with symlinks resolved */
  path: string
  resolved: string
  /** dirKey() of the directory */
  key: string
  /** Its names as Claude Code project dirs (every non-alphanumeric character is encoded as `-`) */
  encodedNames: string[]
  /** Its project's .workbench/flow dir, where the hook script looks for relays */
  flowDir: string
  discoveryFile: string | null
}

/** Project dirs watched for new session files, by path */
const projectDirWatchers = new Map<string, fs.FSWatcher>()

/** Whether a session's recorded cwd is the workspace itself. Only sessions run
 *  in an agent window's own directory are shown in it: one run in a
 *  subdirectory (e.g. a task's worktree under .workbench) belongs elsewhere. */
function isWorkspaceDir(cwd: string, workspace: Workspace): boolean {
  const matches = (recorded: string) => {
    const dir = foldPathCase(recorded)
    return dir === workspace.key || dir === foldPathCase(workspace.path) || dirKey(recorded) === workspace.key
  }
  // A session of Claude Code inside WSL records its Linux working directory
  const host = hostDir(cwd)
  return matches(cwd) || (host !== cwd && matches(host))
}

/** Whether the workspace is one of its project's task worktrees (`.workbench/worktrees/tasks/<task>`).
 *  The headless sessions run there are the task's own run, shown in a window that follows or
 *  resumes the task (a resumed session keeps the headless entrypoint of its first record). */
function isTaskWorktree(workspace: Workspace): boolean {
  const tasksDir = path.join(path.dirname(workspace.flowDir), 'worktrees', 'tasks') + path.sep
  return foldPathCase(workspace.path).startsWith(foldPathCase(tasksDir))
}

function scanForActiveSessions(workspace: Workspace) {
  // Forget sessions that have stayed closed past the active window; if the
  // agent works in one again, the scan below picks it up again
  for (const [id, session] of sessions) {
    if (session.sessionCompleted && Date.now() - session.closedTime > ACTIVE_SESSION_AGE_S * 1000) {
      log.info(`[session] ${id.slice(0, SESSION_ID_DISPLAY)} idle — no longer watching`)
      disposeSession(id)
    }
  }

  // The workspace's project dir in each Claude Code config dir. Every
  // non-alphanumeric character is encoded as `-`, so it can also hold sessions
  // of other directories (`agent_flow` shares the dir of `agent-flow`): a
  // session is kept only if its recorded cwd is the workspace.
  const dirsToScan: string[] = []
  for (const claudeDir of claudeProjectDirs) {
    for (const encoded of workspace.encodedNames) {
      const projectDir = path.join(claudeDir, encoded)
      if (!fs.existsSync(projectDir)) continue
      dirsToScan.push(projectDir)
      watchProjectDir(projectDir, workspace)
    }
  }

  // Start watching in order of last activity, so the most recent session is
  // announced last and is the one clients end up showing
  const found: Array<{ sessionId: string; filePath: string; newestMtime: number }> = []
  for (const dirPath of dirsToScan) {
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = path.basename(file, '.jsonl')
        if (sessions.has(sessionId)) continue
        const filePath = path.join(dirPath, file)
        const stat = fs.statSync(filePath)
        let newestMtime = stat.mtimeMs
        const subagentsDir = path.join(dirPath, sessionId, 'subagents')
        try {
          if (fs.existsSync(subagentsDir)) {
            for (const subFile of fs.readdirSync(subagentsDir)) {
              if (!subFile.endsWith('.jsonl')) continue
              const subStat = fs.statSync(path.join(subagentsDir, subFile))
              if (subStat.mtimeMs > newestMtime) newestMtime = subStat.mtimeMs
            }
          }
        } catch {}

        if ((Date.now() - newestMtime) / 1000 > ACTIVE_SESSION_AGE_S) continue
        const cwd = sessionCwd(filePath)
        if (cwd === undefined) {
          // None recorded yet: taken once its whole file has been searched and has
          // been quiet for a moment (until then it waits). A headless run writes its
          // name and queue entries just before the record that says how it was run.
          if ((cwdSearched.get(filePath) ?? 0) < stat.size || Date.now() - stat.mtimeMs < CWDLESS_SESSION_WAIT_MS) continue
        } else if (!isWorkspaceDir(cwd, workspace) || (headlessSessions.has(filePath) && !isTaskWorktree(workspace))) {
          // Run elsewhere, or a headless run here (a Claude page chat, `claude -p`):
          // never an agent window's session, except a task's run in its worktree
          continue
        }
        if (hasActivitySinceDisposed(filePath)) found.push({ sessionId, filePath, newestMtime })
      }
    } catch {}
  }
  found.sort((a, b) => a.newestMtime - b.newestMtime)
  for (const { sessionId, filePath, newestMtime } of found) watchSession(sessionId, filePath, newestMtime, workspace.key)
}

/** Scan the workspace as soon as a session file in its project dir changes
 *  (the periodic scan covers the rest) */
function watchProjectDir(projectDir: string, workspace: Workspace) {
  // Not on \\wsl.localhost paths, where fs.watch doesn't work (the periodic scan covers them)
  if (projectDirWatchers.has(projectDir) || isWslUncPath(projectDir)) return
  try {
    projectDirWatchers.set(projectDir, fs.watch(projectDir, (_eventType, filename) => {
      if (filename?.endsWith('.jsonl')) scanForActiveSessions(workspace)
    }).on('error', () => { /* dir removed; the periodic scan covers it */ }))
  } catch {}
}

// ─── Discovery file ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch {}
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

/** Advertise the hook server to the hook script (installed in the project's
 *  flow dir by the Live agent setup, see ../project-setup.ts) for one
 *  workspace; returns the file written. A project without a flow dir has Live
 *  agent off: nothing is written. */
function writeDiscoveryFile(port: number, workspace: string, flowDir: string): string | null {
  if (!fs.existsSync(flowDir)) return null
  const hash = hashWorkspace(workspace)
  const discoveryFilePath = path.join(flowDir, `${hash}-${process.pid}.json`)
  fs.writeFileSync(discoveryFilePath, JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n')
  return discoveryFilePath
}

function removeDiscoveryFile(discoveryFilePath: string | null) {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Send a client the sessions run in `cwd` (its list and history now, then
   *  live events), watching that directory from now on; `flowDir` is its
   *  project's .workbench/flow dir */
  subscribe: (clientId: string, cwd: string, flowDir: string) => void
  unsubscribe: (clientId: string) => void
  /** Watch the sessions of these Claude Code config dirs too */
  addClaudeDirs: (dirs: string[]) => void
  /** Clean up all resources */
  dispose: () => void
}

interface RelayOptions {
  /** Claude Code config dirs (~/.claude, CLAUDE_CONFIG_DIR): each has a
   *  `projects` dir of session transcripts */
  claudeDirs: string[]
  send: SendFn
  /** The WSL distribution Claude Code runs in, when it runs in one */
  wsl?: WslPathOptions | null
}

const encodeProjectDir = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-')

/** The names Claude Code may give a directory's project dir under `projects`: from its path,
 *  and inside WSL from its Linux path (`C:\x` is `/mnt/c/x` there, `-mnt-c-x`) */
export function projectDirNames(dirs: string[], runtime: WslPathOptions | null): string[] {
  const runtimeDir = (dir: string) => (runtime && windowsToWsl(dir, runtime)) || dir
  return [...new Set(dirs.flatMap(dir => [dir, runtimeDir(dir)]).map(encodeProjectDir))]
}

function addClaudeDirs(dirs: string[]) {
  for (const dir of dirs) {
    const projectsDir = path.join(path.resolve(dir), 'projects')
    if (!claudeProjectDirs.includes(projectsDir)) claudeProjectDirs.push(projectsDir)
  }
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  sendToClients = options.send
  wsl = options.wsl ?? null
  addClaudeDirs(options.claudeDirs)

  const hookServer = new HookServer()
  const hookPort = await hookServer.start()

  hookServer.onEvent(handleHookEvent)
  hookServer.onOwner(handleSessionOwner)

  const workspaces = new Map<string, Workspace>()

  /** Watch a directory's sessions (once) */
  const addWorkspace = (dir: string, flowDir: string) => {
    const key = dirKey(dir)
    if (workspaces.has(key)) return
    const given = path.resolve(dir)
    const resolved = normalizePath(dir)
    const workspace: Workspace = {
      path: given, resolved, key,
      encodedNames: projectDirNames([resolved, given], wsl),
      flowDir,
      discoveryFile: null,
    }
    workspaces.set(key, workspace)
    try {
      workspace.discoveryFile = writeDiscoveryFile(hookPort, resolved, flowDir)
    } catch (e) { log.warn('Could not write the discovery file:', e) }
    scanForActiveSessions(workspace)
  }

  const scanInterval = setInterval(() => {
    for (const workspace of workspaces.values()) scanForActiveSessions(workspace)
  }, SCAN_INTERVAL_MS)

  let relayDisposed = false

  return {
    subscribe(clientId: string, cwd: string, flowDir: string) {
      if (relayDisposed) return
      const key = dirKey(cwd)
      clients.set(clientId, { dirKey: key })
      // A directory watched for the first time announces its sessions as it
      // finds them (to this client too)
      addWorkspace(cwd, flowDir)

      // Send the session list, then each session's history
      const sessionList: SessionInfo[] = [...sessions.values()].filter(session => session.dirKey === key).map(session => ({
        id: session.sessionId,
        status: session.sessionCompleted ? 'completed' : 'active',
        lastActivityTime: session.lastActivityTime,
        owner: sessionOwners.get(session.sessionId),
      }))
      if (sessionList.length > 0) {
        sendSSE(clientId, { type: 'session-list', sessions: sessionList })
      }
      for (const { id } of sessionList) sendSSE(clientId, historyBatch(id))
    },

    unsubscribe(clientId: string) {
      const client = clients.get(clientId)
      clients.delete(clientId)
      // A directory no window shows any more is no longer scanned or advertised
      // to the hook script (its sessions already watched idle out as usual)
      if (!client || [...clients.values()].some(other => other.dirKey === client.dirKey)) return
      const workspace = workspaces.get(client.dirKey)
      if (!workspace) return
      workspaces.delete(client.dirKey)
      removeDiscoveryFile(workspace.discoveryFile)
      for (const claudeDir of claudeProjectDirs) {
        for (const encoded of workspace.encodedNames) {
          const projectDir = path.join(claudeDir, encoded)
          projectDirWatchers.get(projectDir)?.close()
          projectDirWatchers.delete(projectDir)
        }
      }
    },

    addClaudeDirs(dirs: string[]) {
      addClaudeDirs(dirs)
    },

    dispose() {
      if (relayDisposed) return
      relayDisposed = true
      for (const workspace of workspaces.values()) removeDiscoveryFile(workspace.discoveryFile)
      workspaces.clear()
      hookServer.dispose()
      clearInterval(scanInterval)
      for (const watcher of projectDirWatchers.values()) watcher.close()
      projectDirWatchers.clear()
      for (const id of [...sessions.keys()]) disposeSession(id)
      sessionOwners.clear()
      clients.clear()
      sendToClients = () => {}
    },
  }
}
