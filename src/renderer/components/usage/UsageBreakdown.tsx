/**
 * The usage breakdown: the 5-hour limit up top with Clawd walking in the sky beside it, then
 * the weekly rows underneath. An Enterprise account has neither window, only a monthly spend
 * limit: the top shows that instead, with what was spent of it below and no weekly rows.
 *
 * Modelled on the clawd-usage widget (https://github.com/Enhed/clawd-usage-winwidget): the
 * hearts in the header are the session limit left, and the crab's mood follows the app's own
 * tasks. See ./clawd for the sprite and the tick loop.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTimeRemaining, localizeUsageWindowLabel } from '../../../shared/utils/format-time';
import type { ClaudeUsageSnapshot } from '../../../shared/types/agent';
import { useTaskStore } from '../../stores/task-store';
import { BAR_SIDE_MASK, ClawdScene, ClawdSky, SCENE_H, useMinute } from './ClawdScene';
import { Hearts } from './Hearts';
import { createSkinPicker, skinForUsage, type SkinPicker } from './clawd/skins';
import { useClawd } from './clawd/useClawd';
import { holidayDecor } from './clawd/decor';
import { getBarColorClass, getColorClass } from './usage-colors';
import { formatSpend } from './spend-limit';

/** The label the main process sends for Anthropic's second window */
const ANTHROPIC_WEEKLY_WINDOW = 'common:usage.window7Day';

interface UsageBreakdownProps {
  usage: ClaudeUsageSnapshot;
  /** The popover is open; Clawd only animates while it is */
  open: boolean;
}

/**
 * The track every bar sits in. It is a shade lighter than the popover so an empty bar still
 * reads as a bar - a limit at 0% should look untouched, not missing.
 */
const BAR_TRACK = 'overflow-hidden rounded-full bg-muted-foreground/15';

/**
 * One of the weekly rows: a label, the percentage, how long until it resets, and a bar.
 *
 * Only the 5-hour limit is colour-coded; these stay neutral so the one window you can actually
 * run out of in a sitting is the one that catches the eye.
 */
function UsageRow({ label, percent, resets }: { label: string; percent: number; resets?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{Math.round(percent)}%</span>
          {resets && <span className="mx-1">·</span>}
          {resets}
        </span>
      </div>
      <div className={`h-1.5 ${BAR_TRACK}`}>
        <div
          className="h-full rounded-full bg-muted-foreground/70 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

interface UsageHeroProps {
  usage: ClaudeUsageSnapshot;
  /** Clawd only animates while this is on (the popover is open, the preview is on screen) */
  active: boolean;
  /** Picks his skin; each view keeps its own so a preview never changes the popover's */
  pickSkin?: SkinPicker;
  /** A pinned moment for the sky and the skins (the usage simulator's), or null for now */
  pinned?: Date | null;
}

/**
 * The top of the usage popover: the header with the hearts, and the 5-hour limit, large, with
 * the sky behind it and Clawd walking alongside. The card's background follows the app's theme;
 * only the sky follows the daylight. The parent must be the card's content: 12px padding inside
 * a 1px border, rounded-xl, and UsageCardSurface for the background (the popover and the usage
 * simulator in Settings both are).
 */
export function UsageHero({ usage, active, pickSkin = skinForUsage, pinned = null }: UsageHeroProps) {
  const { t } = useTranslation(['common']);
  const [span, setSpan] = useState(0);
  const [pointerX, setPointerX] = useState<number | null>(null);

  // Clawd's mood comes from the app's own tasks: something running means he runs too, a task
  // waiting on the user makes him hop and wave, and an empty board sends him to sleep.
  const tasks = useTaskStore((state) => state.tasks);
  const { busy, waiting } = useMemo(() => ({
    busy: tasks.filter((task) => task.status === 'in_progress' || task.status === 'ai_review').length,
    waiting: tasks.filter((task) => task.status === 'human_review').length,
  }), [tasks]);

  // A new random skin every time the numbers change; a failed refresh brings no new numbers, so
  // he keeps the one he has. The 5-hour window resetting earns him the crown.
  // A new pinned moment picks a skin for that moment.
  const pinnedAt = pinned?.getTime() ?? null;
  const skin = useMemo(
    () => pickSkin(
      {
        session: usage.sessionPercent, weekly: usage.weeklyPercent, fable: usage.fablePercent,
        clock: pinnedAt == null ? null : String(pinnedAt),
        profile: usage.profileId, reset: usage.sessionResetTimestamp,
      },
      pinnedAt == null ? new Date() : new Date(pinnedAt),
    ),
    [
      pickSkin, usage.sessionPercent, usage.weeklyPercent, usage.fablePercent, usage.profileId,
      usage.sessionResetTimestamp, pinnedAt,
    ],
  );

  const { render, pet } = useClawd({
    sessionPercent: usage.sessionPercent,
    sessionReset: usage.sessionResetTimestamp,
    busy,
    waiting,
    total: tasks.length,
    span,
    pointerX,
    active,
    skin,
  });

  const sessionPercent = Math.round(usage.sessionPercent);
  // Pumpkins on Halloween, presents over the winter holidays
  // (the minute ticks on, so they come and go at midnight with the popover open)
  const now = useMinute(pinned);
  const day = now.toDateString();
  // Worked out again once a day
  const decor = useMemo(() => holidayDecor(new Date(day)), [day]);

  return (
    <div className="relative isolate space-y-2.5">
      {/* Header: the three hearts are the 5-hour limit left */}
      <div className="flex items-center justify-between gap-2 pb-2 text-popover-foreground">
        <span className="text-xs font-semibold">
          {t('common:usage.usageBreakdown')}
        </span>
        <Hearts fraction={render?.shownFraction ?? null} beat={render?.beat ?? 1} spend={!!usage.spendLimit} />
      </div>

      {/* The bar is the ground Clawd stands on, so the two sit flush with no gap between them */}
      <div>
        <div className="relative flex items-end gap-2 text-popover-foreground" style={{ height: SCENE_H }}>
          <ClawdSky percent={usage.sessionPercent} pinned={pinned} />
          {/* Clawd stands on the bar, the number sits a touch above it */}
          <div className="relative mb-1 flex shrink-0 items-start self-end" style={{ marginLeft: 7.5 }}>
            <span className={`text-[2rem] font-medium leading-none tabular-nums ${getColorClass(usage.sessionPercent)}`}>
              {sessionPercent}
            </span>
            <span className={`ml-0.5 mt-0.5 text-sm font-medium ${getColorClass(usage.sessionPercent)}`}>%</span>
          </div>
          <ClawdScene render={render} onSpan={setSpan} onPointer={setPointerX} onPet={pet} decor={decor} />
        </div>

        {/* Positioned, so it is drawn over the sky, which goes on behind it. Square on top and
            round below, with the sky's side fades at its ends; the track is solid in both themes,
            so it reads the same over any sky. */}
        <div
          className="relative h-2 overflow-hidden rounded-b-[4px] bg-[#e5e5e5] dark:bg-[#383835]"
          style={{ maskImage: BAR_SIDE_MASK, WebkitMaskImage: BAR_SIDE_MASK }}
        >
          <div
            className={`h-full rounded-b-[4px] ${usage.sessionPercent >= 100 ? '' : 'rounded-tr-[4px]'} transition-[width] duration-500 ease-out ${getBarColorClass(usage.sessionPercent)}`}
            style={{ width: `${Math.min(usage.sessionPercent, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The sky with Clawd asleep in it, for the popover's states with no usage to show (no number, no
 * bar), in gray but for the sun and the moon. The sky still follows the time of day; with no
 * tasks to watch he sleeps.
 */
export function SleepingSky({ active, pinned = null }: {
  /** Clawd only animates while this is on */
  active: boolean;
  /** A pinned moment for the sky and the skins (the usage simulator's), or null for now */
  pinned?: Date | null;
}) {
  const [span, setSpan] = useState(0);
  const [pointerX, setPointerX] = useState<number | null>(null);
  // A skin memory of its own, so this view never changes the usage card's
  const [pickSkin] = useState(createSkinPicker);
  const pinnedAt = pinned?.getTime() ?? null;
  const skin = useMemo(
    () => pickSkin(
      { session: 0, weekly: 0, clock: pinnedAt == null ? null : String(pinnedAt) },
      pinnedAt == null ? new Date() : new Date(pinnedAt),
    ),
    [pickSkin, pinnedAt],
  );
  const { render, pet } = useClawd({
    sessionPercent: null, busy: 0, waiting: 0, total: 0, span, pointerX, active, skin,
  });
  const now = useMinute(pinned);
  const day = now.toDateString();
  const decor = useMemo(() => holidayDecor(new Date(day)), [day]);

  return (
    <div className="relative flex items-end" style={{ height: SCENE_H }}>
      {/* In gray but for the sun and the moon, and Clawd half in color: something is keeping
          the usage from showing */}
      <ClawdSky percent={null} pinned={pinned} bar={false} gray />
      <div className="flex h-full flex-1 brightness-150 grayscale-50">
        <ClawdScene render={render} onSpan={setSpan} onPointer={setPointerX} onPet={pet} decor={decor} />
      </div>
    </div>
  );
}

/**
 * The usage card's background and border in the app's theme. The card itself (the popover, a
 * simulator card) draws neither; this goes first inside its padded content, which is relative
 * and isolate.
 */
export function UsageCardSurface() {
  return (
    <div
      aria-hidden="true"
      className="absolute -inset-px -z-10 m-0 rounded-xl border border-border bg-popover"
    />
  );
}

/**
 * "resets in 0h 47m" under the hero: when the 5-hour limit resets. With no window running (no
 * reset time, or one already past) the next one starts with the next message, as claude.ai says.
 */
export function SessionResets({ usage }: { usage: ClaudeUsageSnapshot }) {
  const { t } = useTranslation(['common']);
  const resets = formatTimeRemaining(usage.sessionResetTimestamp, t, {
    hoursKey: 'common:usage.resetsInLowerHours',
    daysKey: 'common:usage.resetsInLowerDays',
  }) ?? t('common:usage.sessionNotStarted');
  return <div className="text-[11px] text-muted-foreground">{resets}</div>;
}

/**
 * "$136.22 of $250.00 this month" under the hero of an Enterprise account: its monthly spend limit
 * has no reset time to count down to, so what was spent of it shows instead
 */
export function SpendUsed({ usage }: { usage: ClaudeUsageSnapshot }) {
  const { t } = useTranslation(['common']);
  const spend = usage.spendLimit;
  if (!spend) return null;
  const used = formatSpend(spend.used, spend.currency);
  const text = spend.limit
    ? t('common:usage.spendOfLimit', { used, limit: formatSpend(spend.limit, spend.currency) })
    : t('common:usage.spendNoLimit', { used });
  return <div className="text-[11px] tabular-nums text-muted-foreground">{text}</div>;
}

export function UsageBreakdown({ usage, open }: UsageBreakdownProps) {
  const { t } = useTranslation(['common']);

  const compact = useCallback((timestamp?: string) => formatTimeRemaining(timestamp, t, {
    hoursKey: 'common:usage.compactHours',
    daysKey: 'common:usage.compactDays',
  }), [t]);

  // Anthropic's second window is a week, and the design calls it that. Other providers meter a
  // different span there - z.ai bills a calendar month - so those keep their own name.
  const weeklyLabel = usage.usageWindows?.weeklyWindowLabel
    && usage.usageWindows.weeklyWindowLabel !== ANTHROPIC_WEEKLY_WINDOW
    ? localizeUsageWindowLabel(usage.usageWindows.weeklyWindowLabel, t, 'common:usage.weekAllModels')
    : t('common:usage.weekAllModels');

  // Enterprise: one monthly spend limit, no windows to reset
  if (usage.spendLimit) {
    return (
      <div className="relative isolate space-y-2.5 p-3">
        <UsageCardSurface />
        <UsageHero usage={usage} active={open} />
        <SpendUsed usage={usage} />
      </div>
    );
  }

  return (
    <div className="relative isolate space-y-2.5 p-3">
      <UsageCardSurface />
      <UsageHero usage={usage} active={open} />
      <SessionResets usage={usage} />

      <UsageRow
        label={weeklyLabel}
        percent={usage.weeklyPercent}
        resets={compact(usage.weeklyResetTimestamp)}
      />

      {/* One model has a weekly limit of its own; the provider names it, and some report none */}
      {usage.fablePercent != null && (
        <UsageRow
          label={t('common:usage.weekScoped', { model: usage.fableModelName ?? 'Fable' })}
          percent={usage.fablePercent}
          resets={compact(usage.fableResetTimestamp ?? usage.weeklyResetTimestamp)}
        />
      )}
    </div>
  );
}
