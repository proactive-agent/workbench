import { motion, AnimatePresence } from 'motion/react';
import { memo, useRef, useState, useEffect } from 'react';
import { cn } from '../lib/utils';
import type { ExecutionPhase, Subtask } from '../../shared/types';

interface PhaseProgressIndicatorProps {
  phase?: ExecutionPhase;
  subtasks: Subtask[];
  isStuck?: boolean;
  isRunning?: boolean;
  className?: string;
}

// Phase display configuration (colors only - labels are translated)
const PHASE_COLORS: Record<ExecutionPhase, { color: string; bgColor: string }> = {
  idle: { color: 'bg-muted-foreground', bgColor: 'bg-muted' },
  planning: { color: 'bg-amber-500', bgColor: 'bg-amber-500/20' },
  coding: { color: 'bg-info', bgColor: 'bg-info/20' },
  rate_limit_paused: { color: 'bg-orange-500', bgColor: 'bg-orange-500/20' },
  auth_failure_paused: { color: 'bg-red-500', bgColor: 'bg-red-500/20' },
  qa_review: { color: 'bg-purple-500', bgColor: 'bg-purple-500/20' },
  qa_fixing: { color: 'bg-orange-500', bgColor: 'bg-orange-500/20' },
  complete: { color: 'bg-success', bgColor: 'bg-success/20' },
  failed: { color: 'bg-destructive', bgColor: 'bg-destructive/20' },
};

/**
 * Progress bar that adapts based on execution phase:
 * - Planning/Validation: Shows an animated activity bar
 * - Coding: Shows subtask-based progress
 * - Stuck: Shows warning state with interrupted animation
 *
 * Performance: Uses IntersectionObserver to pause animations when not visible
 */
export const PhaseProgressIndicator = memo(function PhaseProgressIndicator({
  phase: rawPhase,
  subtasks,
  isStuck = false,
  isRunning = false,
  className,
}: PhaseProgressIndicatorProps) {
  const phase = rawPhase || 'idle';
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true);
  const prevVisibleRef = useRef(true);

  // Use IntersectionObserver to pause animations when component is not visible
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nowVisible = entry.isIntersecting;

        if (prevVisibleRef.current !== nowVisible && window.DEBUG) {
          console.log(`[PhaseProgress] Visibility changed: ${prevVisibleRef.current} -> ${nowVisible}, animations ${nowVisible ? 'resumed' : 'paused'}`);
        }

        prevVisibleRef.current = nowVisible;
        setIsVisible(nowVisible);
      },
      { threshold: 0.1 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Only animate when visible and running
  const shouldAnimate = isVisible && isRunning && !isStuck;

  // Calculate subtask-based progress (for coding phase)
  const completedSubtasks = subtasks.filter((c) => c.status === 'completed').length;
  const totalSubtasks = subtasks.length;
  const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

  // Determine if we should show indeterminate (activity) vs determinate (%) progress
  const isIndeterminatePhase = phase === 'planning' || phase === 'qa_review' || phase === 'qa_fixing';
  // Show subtask progress whenever subtasks exist (stops pulsing animation when spec completes)
  const showSubtaskProgress = totalSubtasks > 0;

  const colors = PHASE_COLORS[phase] || PHASE_COLORS.idle;

  return (
    <div ref={containerRef} className={className}>
      {/* Progress bar */}
      <div
        className={cn(
          'relative h-1.5 w-full overflow-hidden rounded-full',
          isStuck ? 'bg-warning/20' : 'bg-border'
        )}
      >
        <AnimatePresence mode="wait">
          {isStuck ? (
            // Stuck/Interrupted state - pulsing warning bar (only animate when visible)
            <motion.div
              key="stuck"
              className="absolute inset-0 bg-warning/40"
              initial={{ opacity: 0 }}
              animate={isVisible ? { opacity: [0.3, 0.6, 0.3] } : { opacity: 0.45 }}
              transition={isVisible ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : undefined}
            />
          ) : showSubtaskProgress ? (
            // Determinate progress for coding phase
            <motion.div
              key="determinate"
              className={cn('h-full rounded-full', colors.color)}
              initial={{ width: 0 }}
              animate={{ width: `${subtaskProgress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          ) : shouldAnimate && isIndeterminatePhase ? (
            // Indeterminate animated progress for planning/validation (only when visible)
            <motion.div
              key="indeterminate"
              className={cn('absolute h-full w-1/3 rounded-full', colors.color)}
              animate={{
                x: ['-100%', '400%'],
              }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />
          ) : isRunning && isIndeterminatePhase && !isVisible ? (
            // Static placeholder when not visible but running
            <motion.div
              key="indeterminate-static"
              className={cn('absolute h-full w-1/3 rounded-full left-1/3', colors.color)}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
});
