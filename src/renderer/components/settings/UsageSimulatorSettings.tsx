import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { SessionResets, SpendUsed, UsageCardSurface, UsageHero } from '../usage/UsageBreakdown';
import { SAMPLE_SPEND_LIMIT } from '../usage/spend-limit';
import { ApiProfileUsageCard, ReauthRequiredCard, UsageUnavailableCard } from '../usage/UsageStateCards';
import { createSkinPicker } from '../usage/clawd/skins';
import { IS_DEV_BUILD } from '../../lib/title-bar';
import {
  simulatedMoment,
  TIME_MAX_MINUTES,
  TIME_STEP_MINUTES,
  useUsageSimulatorStore,
} from '../../stores/usage-simulator-store';
import { useUsageStore } from '../../stores/usage-store';
import type { ClaudeUsageSnapshot } from '../../../shared/types/agent';

/**
 * The previews' own skin memories, one per row (a row's two cards wear the same skin, and a skin
 * is picked again when the moment changes, so the rows can't share one). Trying values here never
 * changes the popover's Clawd.
 */
const PREVIEW_ROWS = [
  { half: 'am', pm: false, pickSkin: createSkinPicker() },
  { half: 'pm', pm: true, pickSkin: createSkinPicker() },
] as const;

/** The Enterprise preview's own skin memory */
const SPEND_PICK_SKIN = createSkinPicker();

/** The simulator's sliders */
const RANGE_CLASS = cn(
  'h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-segment-track',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
  '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground',
  '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer',
  '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground'
);

/** The theme classes (globals.css) the two preview cards are forced into */
const PREVIEW_THEMES = ['dark', 'light'] as const;

/** Stands in for the real usage before any has arrived */
const NO_USAGE: ClaudeUsageSnapshot = {
  sessionPercent: 0,
  weeklyPercent: 0,
  profileId: '',
  profileName: '',
  fetchedAt: new Date(0),
};

/**
 * Development builds only (like the DEVELOPMENT BUILD strip): live previews of the top of the
 * usage popover in the dark and the light theme (also an Enterprise account's, with its monthly
 * spend limit), at its real size, with a pretend date, time and
 * 5-hour usage - to see the sky (day and night, the moon's phase, rain and winter snow) and
 * Clawd's moods and seasonal skins at any moment. The time is shown twice: in the morning (top
 * row) and in the evening (bottom row). An empty date is today, and the usage starts at the real
 * one; the real popover is never affected.
 */
export function UsageSimulatorSettings() {
  const { t } = useTranslation('settings');
  const date = useUsageSimulatorStore((state) => state.date);
  const setDate = useUsageSimulatorStore((state) => state.setDate);
  const minutes = useUsageSimulatorStore((state) => state.minutes);
  const setMinutes = useUsageSimulatorStore((state) => state.setMinutes);
  const sessionPercent = useUsageSimulatorStore((state) => state.sessionPercent);
  const setSessionPercent = useUsageSimulatorStore((state) => state.setSessionPercent);
  const realUsage = useUsageStore((state) => state.usage);
  // The sidebar's badge feeds the store, but it is not mounted while the sidebar is collapsed:
  // keep the store fed from here while the preview is on screen
  useEffect(() => {
    if (!IS_DEV_BUILD) return;
    const { setUsage } = useUsageStore.getState();
    const unsubscribe = window.electronAPI.onUsageUpdated((snapshot) => setUsage(snapshot));
    if (!useUsageStore.getState().usage) {
      window.electronAPI.requestUsageUpdate()
        .then((result) => { if (result.success && result.data) setUsage(result.data); })
        .catch(() => {});
    }
    return unsubscribe;
  }, []);

  // The 5-hour usage slider starts out at the real usage, once it is known
  const filledPercent = useRef(false);
  useEffect(() => {
    if (filledPercent.current || !realUsage) return;
    filledPercent.current = true;
    if (useUsageSimulatorStore.getState().sessionPercent == null) setSessionPercent(Math.round(realUsage.sessionPercent));
  }, [realUsage, setSessionPercent]);

  // The moment each row shows: the time in the morning, then in the evening
  const moments = useMemo(
    () => PREVIEW_ROWS.map((row) => simulatedMoment(date, minutes, row.pm)),
    [date, minutes],
  );
  const timeFormat = { hour: 'numeric', minute: '2-digit' } as const;
  const usage = useMemo(() => {
    const base = realUsage ?? NO_USAGE;
    return sessionPercent == null ? base : { ...base, sessionPercent };
  }, [realUsage, sessionPercent]);
  // An Enterprise account's card: its monthly spend limit (the real one when the account in use
  // has one, else a sample) spent as far as the usage slider says
  const spendUsage = useMemo((): ClaudeUsageSnapshot => {
    const base = realUsage ?? NO_USAGE;
    const limit = base.spendLimit?.limit ? base.spendLimit : SAMPLE_SPEND_LIMIT;
    const percent = sessionPercent ?? Math.round(base.sessionPercent);
    return {
      ...base,
      sessionPercent: percent,
      weeklyPercent: percent,
      sessionResetTimestamp: undefined,
      weeklyResetTimestamp: undefined,
      spendLimit: { ...limit, used: ((limit.limit ?? 0) * percent) / 100 },
    };
  }, [realUsage, sessionPercent]);

  if (!IS_DEV_BUILD) return null;

  return (
    <SettingsSection title={t('usageSimulator.title')}>
      {/* The popover's other states, when it has no usage to draw, in each theme */}
      <div className="mb-6 space-y-4">
        {STATE_PREVIEWS.map((state) => (
          <div key={state} className="flex items-center gap-4">
            {PREVIEW_THEMES.map((theme) => (
              <div
                key={theme}
                className={`${theme} w-[17rem] rounded-xl border border-border bg-popover text-xs text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.24)]`}
              >
                <StatePreview state={state} pinned={moments[0]} />
              </div>
            ))}
            {/* What the row shows, in the space beside its cards */}
            <div className="flex min-w-0 flex-1 justify-center text-center text-sm text-muted-foreground">
              {t(`usageSimulator.states.${state}`)}
            </div>
          </div>
        ))}
      </div>

      {/* An Enterprise account's popover: a monthly spend limit instead of the 5-hour and weekly
          windows, at the morning row's moment */}
      <div className="mb-6 flex items-center gap-4">
        {PREVIEW_THEMES.map((theme) => (
          <div
            key={theme}
            className={`${theme} w-[17rem] rounded-xl border border-transparent text-xs text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.24)]`}
          >
            <div className="relative isolate space-y-2.5 p-3">
              <UsageCardSurface />
              <UsageHero usage={spendUsage} active pickSkin={SPEND_PICK_SKIN} pinned={moments[0]} />
              <SpendUsed usage={spendUsage} />
            </div>
          </div>
        ))}
        <div className="flex min-w-0 flex-1 justify-center text-center text-sm text-muted-foreground">
          {t('usageSimulator.spendLimit')}
        </div>
      </div>

      {/* The popover in each theme side by side, whatever the app's theme, so both can be compared
          at the same moment: the morning on top, the evening below. Each card has the popover's own
          width, shape and padding. */}
      <div className="space-y-4">
        {PREVIEW_ROWS.map((row, i) => (
          <div key={row.half} className="flex items-center gap-4">
            {PREVIEW_THEMES.map((theme) => (
              <div
                key={theme}
                className={`${theme} w-[17rem] rounded-xl border border-transparent text-xs text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.24)]`}
              >
                <div className="relative isolate space-y-2.5 p-3">
                  <UsageCardSurface />
                  <UsageHero usage={usage} active pickSkin={row.pickSkin} pinned={moments[i]} />
                  <SessionResets usage={usage} />
                </div>
              </div>
            ))}
            {/* The row's moment, in the space beside its cards */}
            <div className="flex min-w-0 flex-1 justify-center text-2xl font-light tabular-nums text-foreground">
              {moments[i].toLocaleTimeString([], timeFormat)}
            </div>
          </div>
        ))}
      </div>

      <SettingsRows className="mt-4">
        <SettingsRow
          label={t('usageSimulator.dateLabel')}
          description={t('usageSimulator.dateDescription')}
          htmlFor="usage-simulator-date"
        >
          <Input
            id="usage-simulator-date"
            type="date"
            className="w-40"
            value={date ?? ''}
            onChange={(e) => setDate(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          label={t('usageSimulator.timeLabel')}
          description={t('usageSimulator.timeDescription')}
          htmlFor="usage-simulator-time"
        >
          <input
            id="usage-simulator-time"
            type="range"
            min={0}
            max={TIME_MAX_MINUTES}
            step={TIME_STEP_MINUTES}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className={RANGE_CLASS}
          />
        </SettingsRow>
        <SettingsRow
          label={t('usageSimulator.percentLabel')}
          description={t('usageSimulator.percentDescription')}
          htmlFor="usage-simulator-percent"
        >
          <input
            id="usage-simulator-percent"
            type="range"
            min={0}
            max={100}
            step={1}
            value={sessionPercent ?? Math.round(realUsage?.sessionPercent ?? 0)}
            onChange={(e) => setSessionPercent(Number(e.target.value))}
            className={RANGE_CLASS}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}

/** The popover's states with no usage to draw */
const STATE_PREVIEWS = ['apiProfile', 'reauth', 'unavailable'] as const;

/** One of the popover's states at the morning row's moment, its buttons doing nothing */
function StatePreview({ state, pinned }: { state: (typeof STATE_PREVIEWS)[number]; pinned: Date }) {
  const noop = () => {};
  switch (state) {
    case 'apiProfile':
      return <ApiProfileUsageCard onManageAccounts={noop} active pinned={pinned} />;
    case 'unavailable':
      return <UsageUnavailableCard active pinned={pinned} />;
    case 'reauth':
      return <ReauthRequiredCard onReauth={noop} active pinned={pinned} />;
  }
}
