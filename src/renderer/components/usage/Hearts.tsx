/**
 * The three hearts in the popover's header: how much of the 5-hour limit is left (an Enterprise
 * account's monthly spend limit, which it has instead).
 *
 * Smooth vector hearts that fill from the left in the pixel heart's column steps, so the three
 * together read to about 5% rather than snapping to thirds. The last hearts beat.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { HEART_COLS, HEART_H, heartColumns } from './clawd/heart';

/** How many hearts the limit is spread across */
const HEARTS = 3;

/** A heart outline, in a 20 x 18.35 box */
const HEART_PATH =
  'M10 18.35l-1.45-1.32C3.4 12.36 0 9.28 0 5.5 0 2.42 2.42 0 5.5 0c1.74 0 3.41.81 4.5 2.09'
  + 'C11.09.81 12.76 0 14.5 0 17.58 0 20 2.42 20 5.5c0 3.78-3.4 6.86-8.55 11.54L10 18.35z';
const PATH_W = 20;
const PATH_H = 18.35;
/** As tall as the pixel heart was */
const HEIGHT = HEART_H;
const WIDTH = (HEIGHT * PATH_W) / PATH_H;

interface HeartsProps {
  /** How much of the limit is left, 0..1, or null when usage is unknown */
  fraction: number | null;
  /** Scale of the beat */
  beat: number;
  /** The limit is a monthly spend limit (Enterprise), not the 5-hour one */
  spend?: boolean;
}

export function Hearts({ fraction, beat, spend = false }: HeartsProps) {
  const { t } = useTranslation(['common']);
  const uid = useId().replace(/:/g, '');
  if (fraction == null) return null;

  const title = t(spend ? 'common:usage.heartsLeftSpend' : 'common:usage.heartsLeft', { percent: Math.round(fraction * 100) });

  return (
    <div className="flex items-center gap-[2.5px]" title={title}>
      {Array.from({ length: HEARTS }, (_, i) => {
        // The limit runs across the hearts left to right: this one's share of what is left
        const cols = heartColumns(Math.min(1, Math.max(0, fraction * HEARTS - i)));
        const clip = `heart-fill-${uid}-${i}`;
        return (
          <svg
            key={i}
            width={WIDTH}
            height={HEIGHT}
            viewBox={`0 0 ${PATH_W} ${PATH_H}`}
            aria-hidden="true"
            className="overflow-visible"
            style={{ transform: `scale(${beat})` }}
          >
            <defs>
              <clipPath id={clip}>
                <rect x={0} y={0} width={(PATH_W * cols) / HEART_COLS} height={PATH_H} />
              </clipPath>
            </defs>
            <path d={HEART_PATH} fill="currentColor" className="text-muted-foreground/40" />
            {cols > 0 && <path d={HEART_PATH} fill="#F87171" clipPath={`url(#${clip})`} />}
          </svg>
        );
      })}
    </div>
  );
}
