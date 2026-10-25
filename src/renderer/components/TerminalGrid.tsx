import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  PointerSensor,
  KeyboardSensor,
  MeasuringStrategy,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import { AgentNodeIcon, AgentsIcon, SettingsIcon as Settings, TerminalPromptIcon } from './icons/app-icons';
import { SortableTerminalWrapper } from './SortableTerminalWrapper';
import { Button } from './ui/button';
import { useTerminalStore, getActiveProjectTerminalCount, isProjectTerminal } from '../stores/terminal-store';
import { useTaskStore } from '../stores/task-store';
import { useLiveAgentStore } from '../stores/live-agent-store';
import { TERMINAL_DOM_UPDATE_DELAY_MS, PANEL_CLEANUP_GRACE_PERIOD_MS } from '../../shared/constants';
import { computeTerminalGridLayout, computeWeightedTerminalLayout, dropTargetId, movePreviewOrder, overWindowId } from '../lib/terminal-grid-layout';
import { setTerminalGridDragging } from '../lib/terminal-grid-drag';

/**
 * Windows are never shifted by transforms while one is dragged: the grid itself is laid out in the
 * order the drop would give (its cells differ in size, which transforms can't show)
 */
const noShiftStrategy: SortingStrategy = () => null;

/**
 * What a dragged window is over: the window under the pointer (else the closest), never the file
 * drop zone inside a window. The two have almost the same center, so `closestCenter` alone flipped
 * between them as the preview re-rendered the windows; each flip made dnd-kit look up the scrollable
 * ancestors again and re-render, until React gave up (the crash while holding a window)
 */
const windowCollisions: CollisionDetection = (args) => {
  if ((args.active.data.current as { type?: string } | undefined)?.type !== 'terminal-panel') return closestCenter(args);
  const windows = args.droppableContainers.filter((container) => !String(container.id).startsWith('terminal-'));
  const under = pointerWithin({ ...args, droppableContainers: windows });
  return under.length > 0 ? under : closestCenter({ ...args, droppableContainers: windows });
};

/**
 * Windows are measured once, before the drag: the preview moves and resizes them, and measuring
 * again would change what is under the cursor, and so the preview, while the pointer holds still
 */
const MEASURE_BEFORE_DRAGGING = { droppable: { strategy: MeasuringStrategy.BeforeDragging } };

interface TerminalGridProps {
  projectPath?: string;
  onNewTaskClick?: () => void;
}

export function TerminalGrid({ projectPath, onNewTaskClick }: TerminalGridProps) {
  const { t } = useTranslation(['common', 'terminal']);
  const allTerminals = useTerminalStore((state) => state.terminals);

  // Track terminals that are in the grace period before being filtered out
  // Map of terminal ID -> timestamp when it was marked for cleanup
  const [pendingCleanup, setPendingCleanup] = useState<Map<string, number>>(new Map());

  // Ref to track active cleanup timers — avoids including pendingCleanup in effect deps
  const cleanupTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Helper to clear all active cleanup timers
  const clearAllCleanupTimers = useCallback(() => {
    for (const timer of cleanupTimersRef.current.values()) {
      clearTimeout(timer);
    }
    cleanupTimersRef.current.clear();
  }, []);

  // Filter terminals to show only those belonging to the current project
  // Also include legacy terminals without projectPath (created before this change)
  // Keep exited terminals in DOM during grace period to allow react-resizable-panels to reconcile
  const terminals = useMemo(() => {
    const filtered = projectPath
      ? allTerminals.filter(t => isProjectTerminal(t, projectPath))
      : allTerminals;

    // Filter out exited terminals UNLESS they are still in the grace period
    return filtered.filter(t => {
      if (t.status !== 'exited') {
        return true; // Keep all non-exited terminals
      }
      // Check if this exited terminal is in grace period
      const cleanupTime = pendingCleanup.get(t.id);
      if (cleanupTime) {
        const now = Date.now();
        return now < cleanupTime; // Keep if still within grace period
      }
      return false; // Remove if not in grace period
    });
  }, [allTerminals, projectPath, pendingCleanup]);

  // Manage grace period timers for exited terminals
  // When a terminal exits, add it to pendingCleanup and schedule its removal
  // Uses cleanupTimersRef to track scheduled timers, avoiding pendingCleanup in deps
  // No cleanup function here — timers must survive dependency changes
  useEffect(() => {
    const filtered = projectPath
      ? allTerminals.filter(t => t.projectPath === projectPath || !t.projectPath)
      : allTerminals;

    const exitedTerminals = filtered.filter(t => t.status === 'exited');

    for (const terminal of exitedTerminals) {
      // Check ref (not state) to see if a timer is already scheduled
      if (!cleanupTimersRef.current.has(terminal.id)) {
        const cleanupTime = Date.now() + PANEL_CLEANUP_GRACE_PERIOD_MS;
        setPendingCleanup(prev => new Map(prev).set(terminal.id, cleanupTime));

        const timer = setTimeout(() => {
          cleanupTimersRef.current.delete(terminal.id);
          setPendingCleanup(prev => {
            const next = new Map(prev);
            next.delete(terminal.id);
            return next;
          });
        }, PANEL_CLEANUP_GRACE_PERIOD_MS);

        cleanupTimersRef.current.set(terminal.id, timer);
      }
    }
  }, [allTerminals, projectPath]);

  // Clear all cleanup timers on unmount
  useEffect(() => {
    return clearAllCleanupTimers;
  }, [clearAllCleanupTimers]);

  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const canAddTerminal = useTerminalStore((state) => state.canAddTerminal);
  const maxTerminals = useTerminalStore((state) => state.maxTerminals);
  const reorderTerminals = useTerminalStore((state) => state.reorderTerminals);

  // Get tasks from task store for task selection dropdown in terminals
  const tasks = useTaskStore((state) => state.tasks);

  // Expanded terminal state - when set, this terminal takes up the full grid space
  const [expandedTerminalId, setExpandedTerminalId] = useState<string | null>(null);

  // Reset expanded terminal and clear pending cleanup when project changes
  useEffect(() => {
    setExpandedTerminalId(null);
    setPendingCleanup(new Map());
    clearAllCleanupTimers();
  }, [projectPath, clearAllCleanupTimers]);

  // Setup drag sensors for both file and terminal drag operations
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement required before drag starts
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Track dragging terminal for overlay
  const [draggingTerminalId, setDraggingTerminalId] = React.useState<string | null>(null);
  const draggingTerminal = terminals.find(t => t.id === draggingTerminalId);

  const handleCloseTerminal = useCallback((id: string) => {
    window.electronAPI.destroyTerminal(id);
    removeTerminal(id);
    // Clear expanded state if the closed terminal was expanded
    if (expandedTerminalId === id) {
      setExpandedTerminalId(null);
    }
  }, [removeTerminal, expandedTerminalId]);

  const handleAddTerminal = useCallback(() => {
    if (canAddTerminal(projectPath)) {
      addTerminal(projectPath, projectPath);
    }
  }, [addTerminal, canAddTerminal, projectPath]);

  // A terminal that starts Claude Code as soon as its shell is ready
  const handleAddAgent = useCallback(() => {
    if (canAddTerminal(projectPath)) {
      addTerminal(projectPath, projectPath, { launchCLI: true });
    }
  }, [addTerminal, canAddTerminal, projectPath]);

  // Toggle terminal expand state
  const handleToggleExpand = useCallback((terminalId: string) => {
    setExpandedTerminalId(prev => prev === terminalId ? null : terminalId);
  }, []);


  // While a window is dragged, the order the drop would give: the grid is laid out in it, so the
  // windows move into their new cells as the cursor moves (null when nothing is dragged)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const previewOrderRef = useRef<string[] | null>(null);
  // The order when the drag started. dnd-kit keeps its items and measurements in this order for the
  // whole drag: feeding it the previewed order made it re-measure on every move, find another
  // window under the cursor, move again, and so on until React gave up (a crash while holding)
  const [dragStartOrder, setDragStartOrder] = useState<string[] | null>(null);
  const updatePreviewOrder = useCallback((order: string[] | null) => {
    previewOrderRef.current = order;
    setPreviewOrder(order);
  }, []);

  /** Leave the drag: plain order again, and every window refit to the cell it ends up in */
  const finishDrag = useCallback(() => {
    setDraggingTerminalId(null);
    setDragStartOrder(null);
    updatePreviewOrder(null);
    setTerminalGridDragging(false);
    // After the cells settle; refits were held while the window was dragged
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('terminal-refit-all'));
    }, TERMINAL_DOM_UPDATE_DELAY_MS);
  }, [updatePreviewOrder]);

  // Handle drag start - store dragged item data
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { type: string } | undefined;

    if (data?.type === 'terminal-panel') {
      setDraggingTerminalId(event.active.id.toString());
      setTerminalGridDragging(true);
      const order = terminals.map((terminal) => terminal.id);
      setDragStartOrder(order);
      updatePreviewOrder(order);
    }
  }, [terminals, updatePreviewOrder]);

  // The dragged window takes the place under the cursor, live. Worked out from the order at drag
  // start (where dnd-kit measured the windows), so the same cursor position always gives the same
  // preview and holding still changes nothing
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const current = previewOrderRef.current;
    if (!dragStartOrder || !current || !event.over) return;
    const next = movePreviewOrder(dragStartOrder, event.active.id.toString(), overWindowId(event.over.id.toString()));
    if (next.join('\0') !== current.join('\0')) updatePreviewOrder(next);
  }, [dragStartOrder, updatePreviewOrder]);

  // Handle drag end - apply the previewed order
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeData = event.active.data.current as { type?: string } | undefined;
    const order = previewOrderRef.current;
    finishDrag();
    // Dropped outside the grid: nothing changes, as with Escape
    if (activeData?.type !== 'terminal-panel' || !order || !event.over) return;

    // The previewed order is the original with the dragged window moved to its final index, which
    // is what moving it onto the window that held that index does
    const activeId = event.active.id.toString();
    const targetId = dropTargetId(terminals.map((terminal) => terminal.id), order, activeId);
    if (!targetId) return;
    reorderTerminals(activeId, targetId);

    // Persist the new order to disk so it survives app restarts
    // Use a microtask to ensure the store has updated before we read the new order
    if (projectPath) {
      queueMicrotask(async () => {
        const updatedTerminals = useTerminalStore.getState().terminals;
        const orders = updatedTerminals
          .filter(t => t.projectPath === projectPath || !t.projectPath)
          .map(t => ({ terminalId: t.id, displayOrder: t.displayOrder ?? 0 }));
        try {
          const result = await window.electronAPI.updateTerminalDisplayOrders(projectPath, orders);
          if (!result.success) {
            console.warn('[TerminalGrid] Failed to persist terminal order:', result.error);
          }
        } catch (error) {
          console.warn('[TerminalGrid] Failed to persist terminal order:', error);
        }
      });
    }
  }, [reorderTerminals, terminals, projectPath, finishDrag]);

  // Escape (or a lost pointer): the order before the drag
  const handleDragCancel = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  // The windows in the order they are drawn: the previewed one while a window is dragged
  const orderedTerminals = useMemo(() => {
    if (!previewOrder) return terminals;
    const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));
    const ordered = previewOrder.flatMap((id) => byId.get(id) ?? []);
    // A window added or closed mid-drag: the plain order rather than a wrong one
    return ordered.length === terminals.length ? ordered : terminals;
  }, [terminals, previewOrder]);

  // Each window's place in the order drawn (its grid cell or box)
  const placeOf = useMemo(() => new Map(orderedTerminals.map((terminal, index) => [terminal.id, index])), [orderedTerminals]);

  // Near-square grid without empty cells: the newest row or column is shared by its windows
  const gridLayout = useMemo(() => computeTerminalGridLayout(terminals.length), [terminals.length]);

  // Live agent (the project's setting): agent windows show their graph next to the terminal and take
  // twice the width. Without any, the plain grid above is used as it is
  const liveAgent = useLiveAgentStore((state) => (projectPath ? state.enabled[projectPath] === true : false));
  useEffect(() => {
    if (projectPath) void useLiveAgentStore.getState().load(projectPath);
  }, [projectPath]);
  const weightKey = orderedTerminals
    .map((terminal) => (liveAgent && terminal.isCLIMode && (terminal.cwd || projectPath) ? 2 : 1))
    .join(',');
  const weightedBoxes = useMemo(
    () => (weightKey.includes('2') ? computeWeightedTerminalLayout(weightKey.split(',').map(Number)) : null),
    [weightKey]
  );

  // Terminal IDs for SortableContext
  // dnd-kit's items stay in the drag-start order while a window is dragged (see dragStartOrder)
  const terminalIds = useMemo(() => dragStartOrder ?? terminals.map(t => t.id), [dragStartOrder, terminals]);
  // What the limit counts: a closing window still draws for its grace period but no longer counts
  const activeCount = useMemo(
    () => getActiveProjectTerminalCount(terminals, projectPath),
    [terminals, projectPath]
  );

  // Empty state
  if (terminals.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 pb-[12vh]">
        <div className="flex max-w-[672px] flex-col items-center text-center">
          <h1 className="flex items-center justify-center gap-3 font-heading text-[2.125rem] font-normal! leading-tight tracking-tight text-foreground">
            <AgentNodeIcon className="h-9 w-9 shrink-0" />
            <span>{t('terminal:grid.emptyTitle')}</span>
          </h1>
          <p className="mt-3 max-w-md text-[0.9375rem] leading-relaxed text-muted-foreground">
            {t('terminal:grid.emptyDescription')}
          </p>
          <div className="mt-8 flex items-center gap-2">
            <Button onClick={handleAddAgent} className="gap-2">
              <AgentsIcon className="h-4 w-4" />
              {t('terminal:grid.newAgent')}
            </Button>
            <Button variant="ghost" onClick={handleAddTerminal} className="gap-2 hover:bg-nav-hover">
              <TerminalPromptIcon className="h-4 w-4" />
              {t('terminal:grid.newTerminal')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={windowCollisions}
      measuring={MEASURE_BEFORE_DRAGGING}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-1">
            <span className="px-1 text-[0.8125rem] text-muted-foreground">
              {t('terminal:grid.count', { count: activeCount, max: maxTerminals })}
            </span>
            {/* Settings > Agents at the window limit */}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:bg-nav-hover hover:text-foreground transition-colors"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('open-app-settings', { detail: { section: 'agent', focusId: 'maxTerminals' } }));
              }}
              aria-label={t('terminal:grid.settingsAriaLabel')}
              title={t('terminal:grid.settingsAriaLabel')}
            >
              <Settings className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-[0.8125rem] text-muted-foreground hover:bg-nav-hover hover:text-foreground"
              onClick={handleAddAgent}
              disabled={!canAddTerminal(projectPath)}
            >
              <AgentsIcon className="h-3.5 w-3.5" />
              {t('terminal:grid.newAgent')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-[0.8125rem] text-muted-foreground hover:bg-nav-hover hover:text-foreground"
              onClick={handleAddTerminal}
              disabled={!canAddTerminal(projectPath)}
            >
              <TerminalPromptIcon className="h-3.5 w-3.5" />
              {t('terminal:grid.newTerminal')}
            </Button>
          </div>
        </div>

        {/* Main content area with the terminal grid */}
        <div className="flex flex-1 overflow-hidden">
          {/* Terminal grid using resizable panels */}
          <div className="flex-1 overflow-hidden px-2 pb-2">
            {expandedTerminalId ? (
              // Show only the expanded terminal
              (() => {
                const expandedTerminal = terminals.find(t => t.id === expandedTerminalId);
                if (!expandedTerminal) return null;
                return (
                  <div className="h-full p-1">
                    <SortableTerminalWrapper
                      id={expandedTerminal.id}
                      cwd={expandedTerminal.cwd || projectPath}
                      projectPath={projectPath}
                      isActive={expandedTerminal.id === activeTerminalId}
                      onClose={() => handleCloseTerminal(expandedTerminal.id)}
                      onActivate={() => setActiveTerminal(expandedTerminal.id)}
                      tasks={tasks}
                      onNewTaskClick={onNewTaskClick}
                      terminalCount={1}
                      isExpanded={true}
                      onToggleExpand={() => handleToggleExpand(expandedTerminal.id)}
                    />
                  </div>
                );
              })()
            ) : (
              // Flat CSS Grid layout — all terminals are siblings of the same parent.
              // This prevents React from unmounting/remounting terminal components during
              // drag-drop reorder. With the old nested Group/Panel structure from
              // react-resizable-panels, terminals that changed rows got new parents,
              // causing React to unmount → dispose xterm → blank screen.
              // With a flat grid, React just reorders siblings (no unmount needed).
              <SortableContext items={terminalIds} strategy={noShiftStrategy}>
                {/* With Live agent the same windows are placed as boxes (same elements, so switching
                    never remounts a terminal) */}
                <div
                  className="relative h-full grid"
                  style={weightedBoxes ? undefined : {
                    gridTemplateColumns: `repeat(${gridLayout.columns}, 1fr)`,
                    gridTemplateRows: `repeat(${gridLayout.rows}, 1fr)`,
                  }}
                >
                  {/* Always in the stored order in the DOM: a preview only moves each window to the cell
                      of its place in the previewed order (moving DOM nodes mid-drag made dnd-kit
                      re-read the dragged window's surroundings on every render, without end) */}
                  {terminals.map((terminal) => {
                    const index = placeOf.get(terminal.id) ?? 0;
                    return (
                      <div
                        key={terminal.id}
                        className="p-1 min-h-0 min-w-0"
                        style={weightedBoxes ? {
                          position: 'absolute',
                          left: `${weightedBoxes[index].x * 100}%`,
                          top: `${weightedBoxes[index].y * 100}%`,
                          width: `${weightedBoxes[index].width * 100}%`,
                          height: `${weightedBoxes[index].height * 100}%`,
                        } : {
                          gridRow: `${gridLayout.cells[index].row} / span ${gridLayout.cells[index].rowSpan}`,
                          gridColumn: `${gridLayout.cells[index].column} / span ${gridLayout.cells[index].columnSpan}`,
                        }}
                      >
                        <SortableTerminalWrapper
                          id={terminal.id}
                          cwd={terminal.cwd || projectPath}
                          projectPath={projectPath}
                          isActive={terminal.id === activeTerminalId}
                          onClose={() => handleCloseTerminal(terminal.id)}
                          onActivate={() => setActiveTerminal(terminal.id)}
                          tasks={tasks}
                          onNewTaskClick={onNewTaskClick}
                          terminalCount={terminals.length}
                          isExpanded={false}
                          onToggleExpand={() => handleToggleExpand(terminal.id)}
                        />
                      </div>
                    );
                  })}
                </div>
              </SortableContext>
            )}
          </div>

        </div>

        {/* Drag overlay - shows what's being dragged */}
        <DragOverlay>
          {/* A small window card follows the cursor; the grid behind it shows where it lands */}
          {draggingTerminal && (
            <div className="w-64 overflow-hidden rounded-md border border-primary bg-card shadow-lg">
              <div className="flex h-8 items-center gap-2 border-b border-border px-2.5">
                {draggingTerminal.isCLIMode
                  ? <AgentsIcon className="h-4 w-4 shrink-0 text-primary" />
                  : <TerminalPromptIcon className="h-4 w-4 shrink-0 text-primary" />}
                <span className="truncate text-sm font-medium">
                  {draggingTerminal.title || t(draggingTerminal.isCLIMode ? 'terminal:header.agent' : 'terminal:header.terminal')}
                </span>
              </div>
              <div className="h-24 bg-background/60" />
            </div>
          )}
        </DragOverlay>
      </div>
    </DndContext>
  );
}
