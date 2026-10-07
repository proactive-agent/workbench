import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Prefix animation frames (Claude Code spinner glyphs) */
const PREFIX_FRAMES = ['·', '✻', '✽', '✶', '✳', '✢'] as const;

/** One step of the prefix and dot animations */
const STEP_MS = 500;

function pickWord(words: string[], previous?: string): string {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];
  let next = previous;
  while (next === previous) {
    next = words[Math.floor(Math.random() * words.length)];
  }
  return next as string;
}

/**
 * Sidebar header sticker ("✻ Vibing..."): primary-colored monospace text with a thick border in
 * the theme's sticker color and a soft shadow. Each random status word gets six text states,
 * shown 0.5s apart (the prefix advances one glyph, the dots grow from one to three); after the
 * sixth state a new random word is picked.
 */
export function HeaderStatus() {
  const { t } = useTranslation('navigation');
  const words = useMemo(() => {
    const list = t('header.statusWords', { returnObjects: true });
    return Array.isArray(list) ? (list as string[]) : [];
  }, [t]);

  const wordsRef = useRef(words);
  wordsRef.current = words;

  // Step within the current word's six states; a new random word starts each cycle
  const [{ step, word }, setStatus] = useState(() => ({ step: 0, word: pickWord(words) }));
  useEffect(() => {
    const timer = setInterval(() => {
      setStatus(({ step: current, word: previous }) => {
        const next = (current + 1) % PREFIX_FRAMES.length;
        return { step: next, word: next === 0 ? pickWord(wordsRef.current, previous) : previous };
      });
    }, STEP_MS);
    return () => clearInterval(timer);
  }, []);

  // The six states of the current word ("·Vibing.", "✻Vibing..", "✽Vibing...", ...):
  // each state advances the prefix by one glyph and the dots by one
  const states = useMemo(
    () => PREFIX_FRAMES.map((prefix, index) => `${prefix}\u2004${word}${'.'.repeat((index % 3) + 1)}`),
    [word]
  );
  const text = states[step];

  return (
    <span
      role="img"
      aria-label={word}
      className="header-status relative inline-flex select-none whitespace-nowrap text-[1.0625rem] font-semibold leading-none"
    >
      {/* Rendered twice: a bordered copy behind (the sticker) and the colored text on top */}
      <span aria-hidden="true" className="header-status-outline absolute inset-0 whitespace-nowrap">
        {text}
      </span>
      <span aria-hidden="true" className="relative whitespace-nowrap text-primary">
        {text}
      </span>
    </span>
  );
}
