import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ClipboardEvent, WheelEvent } from 'react';
import type { BrowserDrawerFrame, BrowserDrawerInput } from '../../../shared/types/browser-drawer';
import { isPasteShortcut, mouseButton } from './browser-drawer-utils';

/** How long the drawer's size has to settle before the page's viewport follows it */
const RESIZE_DEBOUNCE_MS = 150;

interface BrowserPageViewProps {
  pageId: string;
  label: string;
}

/**
 * A live page: its viewport is sized to this area (the page fills the drawer), its frames drawn
 * 1:1, and the mouse, wheel and keys on it replayed in the browser
 */
export function BrowserPageView({ pageId, label }: BrowserPageViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The viewport of the last frame drawn (input is mapped to it) */
  const viewportRef = useRef<{ width: number; height: number } | null>(null);
  const moveRef = useRef<{ x: number; y: number } | null>(null);
  const moveFrameRef = useRef<number | null>(null);

  // The page's viewport follows the area's size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) window.electronAPI.viewBrowserPage(pageId, Math.floor(width), Math.floor(height));
    };
    report();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(report, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      window.electronAPI.viewBrowserPage(null, 0, 0);
    };
  }, [pageId]);

  // Frames: the newest one is drawn, older ones waiting meanwhile are dropped
  useEffect(() => {
    let pending: BrowserDrawerFrame | null = null;
    let drawing = false;
    let disposed = false;
    viewportRef.current = null;
    const draw = async () => {
      if (drawing || !pending) return;
      drawing = true;
      const frame = pending;
      pending = null;
      try {
        const bitmap = await createImageBitmap(new Blob([frame.data as BlobPart], { type: 'image/jpeg' }));
        const canvas = canvasRef.current;
        if (canvas && !disposed) {
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          canvas.style.width = `${frame.width}px`;
          canvas.style.height = `${frame.height}px`;
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          viewportRef.current = { width: frame.width, height: frame.height };
        }
        bitmap.close();
      } catch {
        // A frame that doesn't decode is skipped
      } finally {
        drawing = false;
        if (pending && !disposed) void draw();
      }
    };
    const cleanup = window.electronAPI.onBrowserFrame((frame) => {
      if (frame.pageId !== pageId) return;
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

  const onMouseDown = (event: MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    canvasRef.current?.focus();
    const point = pagePoint(event);
    if (point) send({ kind: 'mousedown', ...point, button: mouseButton(event.button), clickCount: event.detail || 1 });
  };

  const onMouseUp = (event: MouseEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event);
    if (point) send({ kind: 'mouseup', ...point, button: mouseButton(event.button), clickCount: event.detail || 1 });
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
    send({ kind: 'keydown', key: event.key });
  };

  const onKeyUp = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.nativeEvent.isComposing || isPasteShortcut(event)) return;
    event.preventDefault();
    send({ kind: 'keyup', key: event.key });
  };

  const onPaste = (event: ClipboardEvent<HTMLCanvasElement>) => {
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    if (text) send({ kind: 'text', text });
  };

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={label}
        className="block outline-none"
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
      />
    </div>
  );
}
