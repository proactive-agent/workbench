import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ClipboardEvent, WheelEvent } from 'react';
import type { BrowserDrawerFrame, BrowserDrawerInput } from '../../../shared/types/browser-drawer';

type BrowserDrawerButton = Extract<BrowserDrawerInput, { kind: 'mousedown' | 'mouseup' }>['button'];
import { alignedViewportLength, devicePixelOffset, isCopyShortcut, isPasteShortcut, mouseButton, pageCursor } from './browser-drawer-utils';
import { noteDrawerInput } from '../../stores/browser-drawer-store';
import { cn } from '../../lib/utils';

/** How long the drawer's size has to settle before the page's viewport follows it */
const RESIZE_DEBOUNCE_MS = 150;
/** At most this many device pixels per CSS pixel in frames (pixel-scale.ts in the main process) */
const MAX_FRAME_SCALE = 2;

/** The device pixels per CSS pixel frames are asked at: the window's devicePixelRatio, 1 to 2 */
const frameScale = () => Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_FRAME_SCALE);

/** Modifier keys as Playwright names them, with the mouse event's flag for each */
const MODIFIERS = [['Control', 'ctrlKey'], ['Shift', 'shiftKey'], ['Alt', 'altKey'], ['Meta', 'metaKey']] as const;

interface BrowserPageViewProps {
  pageId: string;
  label: string;
  /** An extension's popup, shown over the tab (the window views both at once) */
  popup?: boolean;
}

/**
 * A live page: its viewport is sized to this area (the page fills the drawer), its frames drawn
 * 1:1 on device pixels, and the mouse, wheel and keys on it replayed in the browser
 */
/** Put the canvas on whole device pixels (the drawer's edge can sit between two), so frames are drawn without resampling */
function alignCanvas(canvas: HTMLCanvasElement, container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const dx = devicePixelOffset(rect.left, scale);
  const dy = devicePixelOffset(rect.top, scale);
  const transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
  if (canvas.style.transform !== transform) canvas.style.transform = transform;
}

export function BrowserPageView({ pageId, label, popup = false }: BrowserPageViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The viewport of the last frame drawn (input is mapped to it) */
  const viewportRef = useRef<{ width: number; height: number } | null>(null);
  const moveRef = useRef<{ x: number; y: number } | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  /** The cursor the page asks for where the mouse is (the main process asks it), by page */
  const [cursor, setCursor] = useState<{ pageId: string; cursor: string } | null>(null);

  useEffect(() => window.electronAPI.onBrowserCursor?.((update) => {
    if (update.pageId === pageId) setCursor({ pageId, cursor: pageCursor(update.cursor) });
  }), [pageId]);

  // The page's viewport follows the area's size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const { width, height } = container.getBoundingClientRect();
      // Frames at the screen's pixel density, so the page is as sharp as the rest of the window,
      // and a viewport of whole device pixels, so they are drawn without resampling
      const scale = frameScale();
      if (width > 0 && height > 0) {
        window.electronAPI.viewBrowserPage(pageId, alignedViewportLength(width, scale), alignedViewportLength(height, scale), window.devicePixelRatio || 1, popup);
      }
    };
    report();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(report, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    // The window resized: the drawer's edge moved, maybe between device pixels (a still page sends no new frame)
    const onWindowResize = () => {
      if (canvasRef.current) alignCanvas(canvasRef.current, container);
    };
    window.addEventListener('resize', onWindowResize);
    // Moved to a screen of another density (or zoomed): frames follow
    let density: MediaQueryList | undefined;
    const onDensity = () => {
      watchDensity();
      report();
    };
    const watchDensity = () => {
      density?.removeEventListener('change', onDensity);
      density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      density?.addEventListener('change', onDensity);
    };
    watchDensity();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      density?.removeEventListener('change', onDensity);
      clearTimeout(timer);
      window.electronAPI.viewBrowserPage(null, 0, 0, undefined, popup);
    };
  }, [pageId, popup]);

  // Frames: the newest one is drawn, older ones waiting meanwhile are dropped. Each one drawn (or
  // dropped) is acknowledged: the next frame waits for it, so frames never pile up
  useEffect(() => {
    let pending: BrowserDrawerFrame | null = null;
    let drawing = false;
    let disposed = false;
    viewportRef.current = null;
    const drawn = () => window.electronAPI.browserFrameDrawn(pageId);
    const draw = async () => {
      if (drawing || !pending) return;
      drawing = true;
      const frame = pending;
      pending = null;
      try {
        const bitmap = await createImageBitmap(new Blob([frame.data as BlobPart], { type: 'image/jpeg' }));
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (canvas && container && !disposed) {
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          canvas.style.width = `${frame.width}px`;
          canvas.style.height = `${frame.height}px`;
          alignCanvas(canvas, container);
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          viewportRef.current = { width: frame.width, height: frame.height };
        }
        bitmap.close();
      } catch {
        // A frame that doesn't decode is skipped
      } finally {
        drawing = false;
        if (!disposed) drawn();
        if (pending && !disposed) void draw();
      }
    };
    const cleanup = window.electronAPI.onBrowserFrame((frame) => {
      if (frame.pageId !== pageId) return;
      // A frame still waiting is replaced: acknowledged as dropped
      if (pending) drawn();
      pending = frame;
      void draw();
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [pageId]);

  useEffect(() => () => {
    if (moveFrameRef.current !== null) cancelAnimationFrame(moveFrameRef.current);
  }, []);

  /**
   * Keys and buttons the page has been sent as pressed and not yet released. They are released on
   * that page when another tab is shown or the focus leaves (else the page keeps them down: after a
   * Ctrl+click opened a tab, every key typed back there would be Ctrl+key)
   */
  const heldKeysRef = useRef(new Set<string>());
  const heldButtonsRef = useRef(new Map<BrowserDrawerButton, { x: number; y: number }>());
  const releaseHeld = (target: string) => {
    for (const key of heldKeysRef.current) window.electronAPI.sendBrowserInput(target, { kind: 'keyup', key });
    for (const [button, point] of heldButtonsRef.current) {
      window.electronAPI.sendBrowserInput(target, { kind: 'mouseup', ...point, button, clickCount: 1 });
    }
    heldKeysRef.current.clear();
    heldButtonsRef.current.clear();
  };
  const releaseRef = useRef(releaseHeld);
  releaseRef.current = releaseHeld;
  useEffect(() => () => releaseRef.current(pageId), [pageId]);

  const send = (input: BrowserDrawerInput) => window.electronAPI.sendBrowserInput(pageId, input);

  /** The pointer's position in the page's CSS pixels */
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.round(((event.clientX - rect.left) * viewport.width) / rect.width),
      y: Math.round(((event.clientY - rect.top) * viewport.height) / rect.height),
    };
  };

  /**
   * The page gets the modifiers a click is made with (pressed before the canvas had the focus, its
   * keys never reached it): Ctrl/Cmd+click and a middle click on a link open it in a new tab, as the
   * browser itself does
   */
  const syncModifiers = (event: MouseEvent<HTMLCanvasElement>) => {
    for (const [key, flag] of MODIFIERS) {
      const held = heldKeysRef.current.has(key);
      if (event[flag] && !held) {
        heldKeysRef.current.add(key);
        send({ kind: 'keydown', key });
      } else if (!event[flag] && held) {
        heldKeysRef.current.delete(key);
        send({ kind: 'keyup', key });
      }
    }
  };

  const onMouseDown = (event: MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    canvasRef.current?.focus();
    const point = pagePoint(event);
    if (!point) return;
    noteDrawerInput(pageId);
    syncModifiers(event);
    const button = mouseButton(event.button);
    heldButtonsRef.current.set(button, point);
    send({ kind: 'mousedown', ...point, button, clickCount: event.detail || 1 });
  };

  const onMouseUp = (event: MouseEvent<HTMLCanvasElement>) => {
    const button = mouseButton(event.button);
    // Released on the page it was pressed on (another tab may be shown by now)
    if (!heldButtonsRef.current.delete(button)) return;
    const point = pagePoint(event);
    if (point) send({ kind: 'mouseup', ...point, button, clickCount: event.detail || 1 });
  };

  // Moves go once per animation frame
  const onMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
    moveRef.current = pagePoint(event);
    if (moveFrameRef.current !== null) return;
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null;
      if (moveRef.current) send({ kind: 'mousemove', ...moveRef.current });
    });
  };

  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event);
    if (point) send({ kind: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.nativeEvent.isComposing || isPasteShortcut(event)) return;
    event.preventDefault();
    noteDrawerInput(pageId);
    // Asked before the keys go: a cut removes the text once they reach the page
    if (isCopyShortcut(event) && !event.repeat) void window.electronAPI.copyBrowserSelection(pageId);
    heldKeysRef.current.add(event.key);
    send({ kind: 'keydown', key: event.key });
  };

  const onKeyUp = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.nativeEvent.isComposing || isPasteShortcut(event)) return;
    event.preventDefault();
    heldKeysRef.current.delete(event.key);
    send({ kind: 'keyup', key: event.key });
  };

  const onPaste = (event: ClipboardEvent<HTMLCanvasElement>) => {
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    if (text) send({ kind: 'text', text });
  };

  return (
    <div ref={containerRef} className={cn('absolute inset-0 overflow-hidden', !popup && 'bg-background')}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={label}
        className="block outline-none"
        style={{ cursor: cursor?.pageId === pageId ? cursor.cursor : 'default' }}
        // Captured: a button released outside the canvas still reaches the page (no stuck drag)
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // A pointer that is no longer active can't be captured
          }
        }}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onContextMenu={(event) => event.preventDefault()}
        // Keys still down when the focus leaves are released: their release goes elsewhere
        onBlur={() => releaseHeld(pageId)}
      />
    </div>
  );
}
