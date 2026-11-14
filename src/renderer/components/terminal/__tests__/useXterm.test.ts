/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useXterm keyboard handlers
 * Tests terminal copy/paste keyboard shortcuts and platform detection
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { Mock } from 'vitest';
import { act, render } from '@testing-library/react';
import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { useXterm } from '../useXterm';
import { terminalBufferManager } from '../../../lib/terminal-buffer-manager';
import { useTerminalStore } from '../../../stores/terminal-store';
import { useProjectStore } from '../../../stores/project-store';

// Mock xterm.js
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    loadAddon: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    input: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    cols: 80,
    rows: 24,
    options: {
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'monospace',
      fontWeight: 'normal',
      lineHeight: 1,
      letterSpacing: 0,
      theme: { cursorAccent: '#000000' },
      scrollback: 1000
    },
    refresh: vi.fn()
  }))
}));

// Mock xterm addons
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn()
  }))
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn()
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(() => ({
    serialize: vi.fn(() => ''),
    dispose: vi.fn()
  }))
}));

// Mock terminal buffer manager
vi.mock('../../../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: {
    get: vi.fn(() => ''),
    getAndClear: vi.fn(() => ''),
    set: vi.fn(),
    clear: vi.fn()
  }
}));

// Mock WebGL context manager
const mockWebglRegister = vi.fn();
const mockWebglAcquire = vi.fn();
const mockWebglUnregister = vi.fn();
vi.mock('../../../lib/webgl-context-manager', () => ({
  webglContextManager: {
    register: (...args: unknown[]) => mockWebglRegister(...args),
    acquire: (...args: unknown[]) => mockWebglAcquire(...args),
    unregister: (...args: unknown[]) => mockWebglUnregister(...args),
  }
}));

// Mock settings store (for gpuAcceleration setting)
const mockSettingsStoreState = {
  settings: { gpuAcceleration: 'auto' as string | undefined }
};
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: Object.assign(vi.fn(), {
    getState: () => mockSettingsStoreState,
    subscribe: vi.fn(() => vi.fn()),
  })
}));

// Mock navigator.platform for platform detection
const originalNavigatorPlatform = navigator.platform;

// Store original requestAnimationFrame for restoration after tests
const originalRequestAnimationFrame = global.requestAnimationFrame;
const originalCancelAnimationFrame = global.cancelAnimationFrame;

/**
 * Helper function to set up XTerm mocks and render the hook
 * Reduces test boilerplate from ~100 lines to ~20 lines per test
 */
async function setupMockXterm(overrides: {
  hasSelection?: () => boolean;
  getSelection?: () => string;
  paste?: ReturnType<typeof vi.fn>;
  input?: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
} = {}) {
  let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;

  // Override XTerm mock to be constructable
  (XTerm as unknown as Mock).mockImplementation(function() {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        keyEventHandler = handler;
      }),
      hasSelection: overrides.hasSelection ?? vi.fn(() => false),
      getSelection: overrides.getSelection ?? vi.fn(() => ''),
      paste: overrides.paste ?? vi.fn(),
      input: overrides.input ?? vi.fn(),
      onData: vi.fn(),
      onResize: vi.fn(),
      dispose: vi.fn(),
      write: overrides.write ?? vi.fn(),
      cols: 80,
      rows: 24,
      options: {
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 14,
        fontFamily: 'monospace',
        fontWeight: 'normal',
        lineHeight: 1,
        letterSpacing: 0,
        theme: { cursorAccent: '#000000' },
        scrollback: 1000
      },
      refresh: vi.fn()
    };
  });

  // Setup addon mocks
  const { FitAddon } = await import('@xterm/addon-fit');
  (FitAddon as unknown as Mock).mockImplementation(function() {
    return { fit: vi.fn() };
  });

  const { WebLinksAddon } = await import('@xterm/addon-web-links');
  (WebLinksAddon as unknown as Mock).mockImplementation(function() {
    return {};
  });

  const { SerializeAddon } = await import('@xterm/addon-serialize');
  (SerializeAddon as unknown as Mock).mockImplementation(function() {
    return {
      serialize: vi.fn(() => ''),
      dispose: vi.fn()
    };
  });

  // Mock ResizeObserver
  global.ResizeObserver = vi.fn().mockImplementation(function() {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn()
    };
  });

  // Create and render test wrapper component
  const TestWrapper = () => {
    const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
    return React.createElement('div', { ref: terminalRef });
  };

  const { container } = render(React.createElement(TestWrapper));

  // After rendering, keyEventHandler is guaranteed to be set by attachCustomKeyEventHandler
  // Use non-null assertion since we know the hook will set it
  return {
    keyEventHandler: keyEventHandler!,
    terminalElement: container.firstElementChild as HTMLElement,
    mockInstance: {
      hasSelection: overrides.hasSelection,
      getSelection: overrides.getSelection,
      paste: overrides.paste,
      input: overrides.input
    }
  };
}

/** Fire a paste event (as the browser does after Ctrl+V) carrying the given clipboard contents */
function firePaste(target: HTMLElement, clipboard: { text?: string; files?: File[]; imageTypes?: string[] }): Event {
  const files = clipboard.files ?? [];
  const items = [
    ...files.map((file) => ({ kind: 'file', type: file.type })),
    ...(clipboard.imageTypes ?? []).map((type) => ({ kind: 'file', type })),
  ];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { files, items, getData: (type: string) => (type === 'text/plain' ? clipboard.text ?? '' : '') },
  });
  target.dispatchEvent(event);
  return event;
}

describe('useXterm keyboard handlers', () => {
  let mockClipboard: {
    writeText: ReturnType<typeof vi.fn>;
    readText: ReturnType<typeof vi.fn>;
  };

  // Mock requestAnimationFrame for jsdom environment (not provided by default)
  // Isolated to this test file to prevent affecting other tests
  beforeAll(() => {
    global.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number);
    global.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
  });

  afterAll(() => {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  beforeEach(() => {
    // Use fake timers to control async behavior and prevent timer leaks
    vi.useFakeTimers();

    // Clear all mocks before each test
    vi.clearAllMocks();

    // Ensure window and navigator exist in test environment
    if (typeof window === 'undefined') {
      (global as { window: unknown }).window = {};
    }
    if (typeof navigator === 'undefined') {
      (global as { navigator: unknown }).navigator = {};
    }

    // Mock navigator.clipboard
    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue('test clipboard content')
    };

    Object.defineProperty(global.navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true
    });

    // Mock window.electronAPI
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTerminalInput: vi.fn()
    };
  });

  afterEach(() => {
    // Clear all pending timers before restoring mocks to prevent
    // "requestAnimationFrame is not defined" errors from delayed callbacks
    vi.clearAllTimers();
    vi.useRealTimers();

    vi.restoreAllMocks();
    // Reset navigator.platform to original value
    Object.defineProperty(navigator, 'platform', {
      value: originalNavigatorPlatform,
      writable: true
    });
  });

  describe('Platform detection', () => {
    it('should enable paste shortcuts on Windows (CTRL+V)', async () => {
      const mockPaste = vi.fn();

      // Mock Windows platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      const { keyEventHandler, terminalElement } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          shiftKey: false,
          cancelable: true
        });

        // xterm doesn't send ^V and the browser's paste goes ahead
        expect(keyEventHandler(event)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
        firePaste(terminalElement, { text: 'test clipboard content' });
        await vi.advanceTimersByTimeAsync(0);
      });

      // Windows should enable CTRL+V paste
      expect(mockPaste).toHaveBeenCalledWith('test clipboard content');
    });

    it('should enable paste shortcuts on Linux (both CTRL+V and CTRL+SHIFT+V)', async () => {
      const mockPaste = vi.fn();

      // Mock Linux platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler, terminalElement } = await setupMockXterm({ paste: mockPaste });

      // Test CTRL+V
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          shiftKey: false
        });

        expect(keyEventHandler(event)).toBe(false);
        firePaste(terminalElement, { text: 'test clipboard content' });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockPaste).toHaveBeenCalledTimes(1);

      // Test CTRL+SHIFT+V (Linux-specific)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'V',
          ctrlKey: true,
          shiftKey: true
        });

        expect(keyEventHandler(event)).toBe(false);
        firePaste(terminalElement, { text: 'test clipboard content' });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockPaste).toHaveBeenCalledTimes(2);
    });

    it('should enable copy shortcuts on Linux (both CTRL+C and CTRL+SHIFT+C)', async () => {
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      // Mock Linux platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      // Test CTRL+C (should copy)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          shiftKey: false
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);

      // Test CTRL+SHIFT+C (Linux-specific, should also copy)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledTimes(2);
    });

    it('should NOT enable custom paste handler on macOS (uses system Cmd+V)', async () => {
      const mockPaste = vi.fn();

      // Mock macOS platform
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          shiftKey: false
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      // macOS should NOT use custom CTRL+V handler (uses system Cmd+V instead)
      expect(mockPaste).not.toHaveBeenCalled();
    });
  });

  describe('Smart CTRL+C behavior', () => {
    it('should copy to clipboard when text is selected', async () => {
      // Create mock functions that will be shared between the mock instance and our assertions
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        // Simulate CTRL+C keydown event
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          metaKey: false
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false); // Should prevent xterm handling

        // Wait for clipboard write
        await vi.advanceTimersByTimeAsync(0);
      });

      // Verify the xterm instance methods were called
      expect(mockHasSelection).toHaveBeenCalled();
      expect(mockGetSelection).toHaveBeenCalled();

      // Verify clipboard.writeText was called with selected text
      expect(mockClipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    it('should send ^C interrupt when no text is selected', async () => {
      const mockHasSelection = vi.fn(() => false);
      const mockGetSelection = vi.fn(() => '');

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        // Simulate CTRL+C keydown event with no selection
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          metaKey: false
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(true); // Should let ^C pass through to terminal
      });

      // Verify clipboard.writeText was NOT called
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });

    it('should handle both ctrlKey (Windows/Linux) and metaKey (Mac)', async () => {
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      // Test ctrlKey (Windows/Linux)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
          // Wait for clipboard write
          await vi.advanceTimersByTimeAsync(0);
        }
      });

      // Test metaKey (Mac)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: false,
          metaKey: true
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
          // Wait for clipboard write
          await vi.advanceTimersByTimeAsync(0);
        }
      });

      // Both should trigger clipboard write
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(2);
    });
  });

  describe('Pasting images and files', () => {
    it('sends Alt+V on Windows for an image with no text, so Claude Code reads the clipboard image', async () => {
      const mockPaste = vi.fn();
      const mockInput = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Win32', writable: true });
      const { terminalElement } = await setupMockXterm({ paste: mockPaste, input: mockInput });

      let event: Event | undefined;
      await act(async () => {
        event = firePaste(terminalElement, { imageTypes: ['image/png'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockInput).toHaveBeenCalledWith('\x1bv');
      expect(mockPaste).not.toHaveBeenCalled();
      expect(event?.defaultPrevented).toBe(true);
    });

    it('sends Ctrl+V on Linux for an image with no text', async () => {
      const mockInput = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Linux', writable: true });
      const { terminalElement } = await setupMockXterm({ input: mockInput });

      await act(async () => {
        firePaste(terminalElement, { imageTypes: ['image/png'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockInput).toHaveBeenCalledWith('\x16');
    });

    it("types a pasted name of the project's chat or agent window as a tag Claude Code reads as the recipient", async () => {
      useProjectStore.setState({ projects: [{ id: 'p1', path: '/project' }] as never });
      useTerminalStore.setState({
        terminals: [
          { id: 'test-terminal', title: 'Me', projectPath: '/project', isCLIMode: true },
          { id: '1a25c6f1-0000-0000-0000-000000000000', title: 'Agent 1', projectPath: '/project', isCLIMode: true },
        ] as never,
      });
      const mockPaste = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Linux', writable: true });
      const { terminalElement } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        firePaste(terminalElement, { text: 'agent-1a25c6f1' });
        await vi.advanceTimersByTimeAsync(0);
      });
      // Typed once the recipient is looked up
      await vi.waitFor(() => expect(mockPaste).toHaveBeenLastCalledWith('[Agent #1a25c6f1]'));

      // A name of no session of the project stays text
      await act(async () => {
        firePaste(terminalElement, { text: 'agent-ffffffff' });
        await vi.advanceTimersByTimeAsync(0);
      });
      await vi.waitFor(() => expect(mockPaste).toHaveBeenLastCalledWith('agent-ffffffff'));
      useTerminalStore.setState({ terminals: [] });
    });

    it('pastes copied files as their paths, quoted when they have spaces, as the runtime sees them', async () => {
      const mockPaste = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Win32', writable: true });
      const shot = new File(['x'], 'shot.png', { type: 'image/png' });
      const notes = new File(['x'], 'notes.txt', { type: 'text/plain' });
      const paths = new Map<File, string>([
        [shot, 'C:\\Users\\me\\My Pictures\\shot.png'],
        [notes, 'C:\\notes.txt'],
      ]);
      const toTerminalRuntimePaths = vi.fn(async (list: string[]) =>
        list.map((p) => p.replace('C:\\', '/mnt/c/').replace(/\\/g, '/')));
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        sendTerminalInput: vi.fn(),
        getPathForFile: (file: File) => paths.get(file) ?? '',
        toTerminalRuntimePaths,
      };
      const { terminalElement } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        firePaste(terminalElement, { files: [shot, notes], text: 'ignored' });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(toTerminalRuntimePaths).toHaveBeenCalledWith(['C:\\Users\\me\\My Pictures\\shot.png', 'C:\\notes.txt']);
      expect(mockPaste).toHaveBeenCalledWith('"/mnt/c/Users/me/My Pictures/shot.png" /mnt/c/notes.txt');
    });

    it('treats text with NUL characters as an image (a WSLg screenshot arrives as bitmap bytes)', async () => {
      const mockPaste = vi.fn();
      const mockInput = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Linux', writable: true });
      const { terminalElement } = await setupMockXterm({ paste: mockPaste, input: mockInput });

      await act(async () => {
        firePaste(terminalElement, { text: 'BM\u0000\u0000\u0000(' });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockInput).toHaveBeenCalledWith('\x16');
      expect(mockPaste).not.toHaveBeenCalled();
    });

    it('asks the main process for copied files when a paste on Linux arrives empty (WSLg)', async () => {
      const mockPaste = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Linux', writable: true });
      const readClipboardFilePaths = vi.fn(async () => ['/mnt/c/Users/me/shot one.png']);
      (window as unknown as { electronAPI: unknown }).electronAPI = { sendTerminalInput: vi.fn(), readClipboardFilePaths };
      const { terminalElement } = await setupMockXterm({ paste: mockPaste });

      let event: Event | undefined;
      await act(async () => {
        event = firePaste(terminalElement, {});
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(event?.defaultPrevented).toBe(true);
      expect(readClipboardFilePaths).toHaveBeenCalled();
      expect(mockPaste).toHaveBeenCalledWith('"/mnt/c/Users/me/shot one.png"');
    });

    it('sends the empty paste xterm would have sent when the clipboard has no files either', async () => {
      const mockPaste = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'Linux', writable: true });
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        sendTerminalInput: vi.fn(),
        readClipboardFilePaths: vi.fn(async () => []),
      };
      const { terminalElement } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        firePaste(terminalElement, {});
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockPaste).toHaveBeenCalledWith('');
    });

    it('leaves an image-only paste to xterm on macOS', async () => {
      const mockInput = vi.fn();
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', writable: true });
      const { terminalElement } = await setupMockXterm({ input: mockInput });

      let event: Event | undefined;
      await act(async () => {
        event = firePaste(terminalElement, { imageTypes: ['image/png'] });
      });

      expect(mockInput).not.toHaveBeenCalled();
      expect(event?.defaultPrevented).toBe(false);
    });
  });

  describe('Linux CTRL+SHIFT+C copy shortcut', () => {
    it('should copy on Linux when CTRL+SHIFT+C is pressed', async () => {
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      // Mock Linux platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    it('should not trigger CTRL+SHIFT+C on Windows', async () => {
      // Mock Windows platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: vi.fn(() => false),
        getSelection: vi.fn(() => '')
      });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
        }
      });

      // Should not copy on Windows
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });
  });

  describe('Clipboard error handling', () => {
    it('should handle clipboard write errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      // Mock clipboard write failure
      mockClipboard.writeText = vi.fn().mockRejectedValue(new Error('Clipboard write failed'));

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      // Should log error but not throw
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[useXterm] Failed to copy selection:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Replaying saved output', () => {
    it('closes a link and resets the style the saved output was cut inside of', async () => {
      const write = vi.fn();
      // Saved while Claude Code was drawing its status line's link
      terminalBufferManager.set('test-terminal', 'PR \x1b]8;;https://github.com/x/pull/19\x1b\\#19');
      await setupMockXterm({ write });
      expect(write).toHaveBeenCalledWith('PR \x1b]8;;https://github.com/x/pull/19\x1b\\#19\x1b]8;;\x1b\\\x1b[0m');
    });
  });

  describe('Existing shortcuts preservation', () => {
    it('should let SHIFT+Enter pass through', async () => {
      const mockInput = vi.fn();

      const { keyEventHandler } = await setupMockXterm({ input: mockInput });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          ctrlKey: false,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
        }
      });

      // Should send ESC+newline for multi-line input
      expect(mockInput).toHaveBeenCalledWith('\x1b\n');
    });

    it('should let Ctrl+Backspace pass through', async () => {
      const mockInput = vi.fn();

      const { keyEventHandler } = await setupMockXterm({ input: mockInput });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'Backspace',
          ctrlKey: true,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
        }
      });

      // Should send Ctrl+U for delete line
      expect(mockInput).toHaveBeenCalledWith('\x15');
    });

    it('sends Ctrl+1-9 to the terminal (no app shortcut claims them)', async () => {
      const { keyEventHandler } = await setupMockXterm();

      for (let i = 1; i <= 9; i++) {
        act(() => {
          const event = new KeyboardEvent('keydown', { key: i.toString(), ctrlKey: true });
          expect(keyEventHandler(event)).toBe(true);
        });
      }
    });

    it('sends Ctrl+T and Ctrl+W to the terminal (e.g. transpose / delete word)', async () => {
      const { keyEventHandler } = await setupMockXterm();

      for (const key of ['t', 'w']) {
        act(() => {
          const event = new KeyboardEvent('keydown', { key, ctrlKey: true });
          expect(keyEventHandler(event)).toBe(true);
        });
      }
    });
  });

  describe('Event type checking', () => {
    it('should only handle keydown events, not keyup', async () => {
      const { keyEventHandler } = await setupMockXterm({
        hasSelection: vi.fn(() => true),
        getSelection: vi.fn(() => 'selected text')
      });

      act(() => {
        // Test keyup event (should be ignored)
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'c',
          ctrlKey: true
        });

        keyEventHandler(keyupEvent);
      });

      // Clipboard should not be called for keyup events
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });
  });
});

describe('useXterm WebGL context management', () => {
  // Mock requestAnimationFrame for jsdom environment
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;

  beforeAll(() => {
    global.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number);
    global.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
  });

  afterAll(() => {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Reset gpuAcceleration to default
    mockSettingsStoreState.settings.gpuAcceleration = 'auto';

    // Mock ResizeObserver
    global.ResizeObserver = vi.fn().mockImplementation(function() {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });

    // Mock window.electronAPI
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTerminalInput: vi.fn(),
      openExternal: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper to render useXterm and wait for initialization
   */
  async function renderUseXterm(terminalId = 'test-webgl-terminal') {
    // Set up XTerm mock with dispose tracking
    const mockDispose = vi.fn();
    (XTerm as unknown as Mock).mockImplementation(function() {
      return {
        open: vi.fn(),
        loadAddon: vi.fn(),
        attachCustomKeyEventHandler: vi.fn(),
        hasSelection: vi.fn(() => false),
        getSelection: vi.fn(() => ''),
        paste: vi.fn(),
        input: vi.fn(),
        onData: vi.fn(),
        onResize: vi.fn(),
        dispose: mockDispose,
        write: vi.fn(),
        cols: 80,
        rows: 24,
        options: {
          cursorBlink: true,
          cursorStyle: 'block',
          fontSize: 14,
          fontFamily: 'monospace',
          fontWeight: 'normal',
          lineHeight: 1,
          letterSpacing: 0,
          theme: { cursorAccent: '#000000' },
          scrollback: 1000
        },
        refresh: vi.fn()
      };
    });

    const { FitAddon } = await import('@xterm/addon-fit');
    (FitAddon as unknown as Mock).mockImplementation(function() {
      return { fit: vi.fn(), dispose: vi.fn() };
    });

    const { WebLinksAddon } = await import('@xterm/addon-web-links');
    (WebLinksAddon as unknown as Mock).mockImplementation(function() {
      return {};
    });

    const { SerializeAddon } = await import('@xterm/addon-serialize');
    (SerializeAddon as unknown as Mock).mockImplementation(function() {
      return { serialize: vi.fn(() => ''), dispose: vi.fn() };
    });

    let disposeHook: (() => void) | null = null;

    const TestWrapper = () => {
      const result = useXterm({ terminalId });
      // Expose dispose via ref so tests can call it
      disposeHook = result.dispose;
      return React.createElement('div', { ref: result.terminalRef });
    };

    await act(async () => {
      render(React.createElement(TestWrapper));
    });

    return { disposeHook: () => disposeHook?.() };
  }

  it('should lazily import and acquire WebGL context when gpuAcceleration is "auto"', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'auto';

    await renderUseXterm('terminal-auto');
    // Flush the dynamic import() promise + microtasks
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockWebglRegister).toHaveBeenCalledWith('terminal-auto', expect.anything());
    expect(mockWebglAcquire).toHaveBeenCalledWith('terminal-auto');
  });

  it('should lazily import and acquire WebGL context when gpuAcceleration is "on"', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'on';

    await renderUseXterm('terminal-on');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockWebglRegister).toHaveBeenCalledWith('terminal-on', expect.anything());
    expect(mockWebglAcquire).toHaveBeenCalledWith('terminal-on');
  });

  it('should NOT import WebGL module at all when gpuAcceleration is "off"', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'off';

    await renderUseXterm('terminal-off');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // When off, the dynamic import() never fires — no GPU code runs
    expect(mockWebglRegister).not.toHaveBeenCalled();
    expect(mockWebglAcquire).not.toHaveBeenCalled();
  });

  it('should unregister WebGL context on terminal disposal', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'auto';

    const { disposeHook } = await renderUseXterm('terminal-dispose');
    // Flush the dynamic import so the manager ref is populated
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockWebglRegister).toHaveBeenCalledWith('terminal-dispose', expect.anything());

    // Dispose the terminal
    act(() => {
      disposeHook();
    });

    expect(mockWebglUnregister).toHaveBeenCalledWith('terminal-dispose');
  });

  it('should NOT unregister on disposal when WebGL was never loaded (off)', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'off';

    const { disposeHook } = await renderUseXterm('terminal-off-dispose');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Dispose the terminal
    act(() => {
      disposeHook();
    });

    // WebGL was never loaded, so unregister should not be called
    expect(mockWebglUnregister).not.toHaveBeenCalled();
  });

  it('should fallback to "off" when gpuAcceleration is undefined (upgrading users)', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = undefined;

    await renderUseXterm('terminal-undefined');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // When undefined, the ?? 'off' fallback means no WebGL import at all
    expect(mockWebglRegister).not.toHaveBeenCalled();
    expect(mockWebglAcquire).not.toHaveBeenCalled();
  });
});
