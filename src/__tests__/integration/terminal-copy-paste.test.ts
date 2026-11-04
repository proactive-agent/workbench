/**
 * @vitest-environment jsdom
 */

/**
 * Integration tests for terminal copy/paste functionality
 * Tests xterm.js selection API integration with clipboard operations
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import type { Mock } from 'vitest';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';

// Mock xterm.js and its addons
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function() {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn(function() { return false; }),
      getSelection: vi.fn(function() { return ''; }),
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
    };
  })
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function() {
    return {
      fit: vi.fn()
    };
  })
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function() {
    return {};
  })
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(function() {
    return {
      serialize: vi.fn(function() { return ''; }),
      dispose: vi.fn()
    };
  })
}));

/** Fire a paste event (as the browser does after Ctrl+V) carrying the given clipboard contents */
function firePaste(target: Element, clipboard: { text?: string; files?: File[] }): Event {
  const files = clipboard.files ?? [];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type })),
      getData: (type: string) => (type === 'text/plain' ? clipboard.text ?? '' : ''),
    },
  });
  target.dispatchEvent(event);
  return event;
}

describe('Terminal copy/paste integration', () => {
  let mockClipboard: {
    writeText: Mock;
    readText: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock ResizeObserver
    global.ResizeObserver = vi.fn().mockImplementation(function() {
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn()
      };
    });

    // Mock requestAnimationFrame for xterm.js integration tests
    global.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      // Synchronously execute the callback to avoid timing issues in tests
      // Just pass timestamp directly - this context isn't used by RAF callbacks
      callback(0);
      return 0;
    }) as unknown as Mock;

    // Mock navigator.clipboard
    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue('clipboard content')
    };

    Object.defineProperty(global.navigator, 'clipboard', {
      value: mockClipboard,
      writable: true
    });

    // Mock window.electronAPI
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTerminalInput: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('xterm.js selection API integration with clipboard write', () => {
    it('should integrate xterm.hasSelection() with clipboard write', async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      const mockHasSelection = vi.fn(function() { return true; });
      const mockGetSelection = vi.fn(function() { return 'selected terminal text'; });

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: mockHasSelection,
          getSelection: mockGetSelection,
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      render(React.createElement(TestWrapper));

      await act(async () => {
        // Simulate copy operation
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true
        });

        if (keyEventHandler) {
          keyEventHandler(event);
          // Wait for clipboard write
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      });

      // Verify integration: hasSelection() called
      expect(mockHasSelection).toHaveBeenCalled();

      // Verify integration: getSelection() called when hasSelection returns true
      expect(mockGetSelection).toHaveBeenCalled();

      // Verify integration: clipboard.writeText() called with selection
      expect(mockClipboard.writeText).toHaveBeenCalledWith('selected terminal text');
    });

    it('should not call getSelection when hasSelection returns false', async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      const mockHasSelection = vi.fn(function() { return false; });
      const mockGetSelection = vi.fn(function() { return ''; });

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: mockHasSelection,
          getSelection: mockGetSelection,
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      render(React.createElement(TestWrapper));

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true
        });

        if (keyEventHandler) {
          keyEventHandler(event);
        }
      });

      // Verify hasSelection was called
      expect(mockHasSelection).toHaveBeenCalled();

      // Verify getSelection was NOT called (no selection)
      expect(mockGetSelection).not.toHaveBeenCalled();

      // Verify clipboard was NOT written to
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });
  });

  describe("the browser's paste event with xterm paste integration", () => {
    let originalNavigatorPlatform: string;

    beforeEach(() => {
      // Capture original navigator.platform
      originalNavigatorPlatform = navigator.platform;
    });

    afterEach(() => {
      // Restore navigator.platform
      Object.defineProperty(navigator, 'platform', {
        value: originalNavigatorPlatform,
        writable: true
      });
    });

    it("should integrate the browser's paste event with xterm.paste()", async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      // Mock Windows platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      const mockPaste = vi.fn();

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: vi.fn(),
          getSelection: vi.fn(),
          paste: mockPaste,
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      const { container } = render(React.createElement(TestWrapper));

      let keyEvent: KeyboardEvent | undefined;
      let handled: boolean | undefined;
      await act(async () => {
        keyEvent = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true });
        handled = keyEventHandler?.(keyEvent);
        // The browser's paste event follows the shortcut
        firePaste(container.firstElementChild!, { text: 'pasted text' });
      });

      // xterm doesn't send ^V, and the browser's paste goes ahead
      expect(handled).toBe(false);
      expect(keyEvent?.defaultPrevented).toBe(false);

      // Verify integration: the paste event's text goes to xterm.paste(), without reading the clipboard
      expect(mockPaste).toHaveBeenCalledWith('pasted text');
      expect(mockClipboard.readText).not.toHaveBeenCalled();
    });

    it('sends the empty paste xterm would when the clipboard has neither text nor files (Linux)', async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      // Mock Linux platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      const mockPaste = vi.fn();

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: vi.fn(),
          getSelection: vi.fn(),
          paste: mockPaste,
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Under WSLg a file copied in Windows arrives as an empty paste: the main process reads the clipboard's files
      const readClipboardFilePaths = vi.fn(async () => [] as string[]);
      (window as unknown as { electronAPI: unknown }).electronAPI = { sendTerminalInput: vi.fn(), readClipboardFilePaths };

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      const { container } = render(React.createElement(TestWrapper));

      await act(async () => {
        keyEventHandler?.(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true }));
        firePaste(container.firstElementChild!, {});
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      // No files either: the empty paste xterm would have sent (Claude Code then looks for an image)
      expect(readClipboardFilePaths).toHaveBeenCalled();
      expect(mockPaste).toHaveBeenCalledWith('');
      expect(mockClipboard.readText).not.toHaveBeenCalled();
    });
  });

  describe('keyboard event propagation', () => {
    it('should prevent copy/paste events from interfering with other shortcuts', async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      let eventCallOrder: string[] = [];

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: vi.fn(function() { return true; }),
          getSelection: vi.fn(function() { return 'selection'; }),
          paste: vi.fn(),
          input: vi.fn(function(data: string) {
            eventCallOrder.push(`input:${data}`);
          }),
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      render(React.createElement(TestWrapper));

      await act(async () => {
        // Test SHIFT+Enter (should work independently of copy/paste)
        const shiftEnterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          ctrlKey: false,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler(shiftEnterEvent);
        }

        // Verify SHIFT+Enter still works (sends newline)
        expect(eventCallOrder.some(s => s.includes('\x1b\n'))).toBe(true);

        // Test CTRL+C with selection (should not interfere)
        eventCallOrder = [];
        const copyEvent = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true
        });

        if (keyEventHandler) {
          keyEventHandler(copyEvent);
          // Wait for clipboard write
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Copy should not send input to terminal
        expect(eventCallOrder).toHaveLength(0);

        // Test CTRL+V (should not interfere)
        const pasteEvent = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true
        });

        if (keyEventHandler) {
          keyEventHandler(pasteEvent);
          // Wait for clipboard read
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Paste should use xterm.paste(), not xterm.input()
        // The input() should not be called directly
        expect(eventCallOrder).toHaveLength(0);
      });
    });

    it('sends former app shortcut keys to the terminal and keeps copy/paste handling', async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      let handlerResults: { key: string; handled: boolean }[] = [];
      const mockHasSelection = vi.fn(function() { return false; });

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: mockHasSelection,
          getSelection: vi.fn(),
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      render(React.createElement(TestWrapper));

      // Helper to test key handling
      const testKey = (key: string, ctrl: boolean, meta: boolean, shift: boolean) => {
        const event = new KeyboardEvent('keydown', {
          key,
          ctrlKey: ctrl,
          metaKey: meta,
          shiftKey: shift
        });

        if (keyEventHandler) {
          const handled = keyEventHandler(event);
          handlerResults.push({ key, handled });
        }
      };

      await act(async () => {
        // No app shortcuts claim these anymore: they go to the terminal (e.g. ^W deletes a word)
        testKey('1', true, false, false); // Ctrl+1
        testKey('Tab', true, false, false); // Ctrl+Tab
        testKey('t', true, false, false); // Ctrl+T
        testKey('w', true, false, false); // Ctrl+W

        // Verify the terminal handles all of them
        expect(handlerResults.filter(r => r.handled)).toHaveLength(4);

        // Test copy/paste WITHOUT selection (should pass through to send ^C)
        handlerResults = [];
        mockHasSelection.mockReturnValue(false);
        testKey('c', true, false, false); // Ctrl+C without selection

        // Should return true (let ^C pass through to terminal for interrupt signal)
        expect(handlerResults[0].handled).toBe(true);
      });
    });
  });

  describe('clipboard error handling without breaking terminal', () => {
    it('should continue terminal operation after clipboard error', async () => {
      const { useXterm } = await import('../../renderer/components/terminal/useXterm');

      // Mock Windows platform to enable custom paste handler
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
      const mockPaste = vi.fn();
      const mockInput = vi.fn();
      const mockSendTerminalInput = vi.fn();
      let onDataCallback: ((data: string) => void) | undefined;

      // Pasted files' paths can't be translated for the terminal's runtime (the call fails)
      const copied = new File(['x'], 'notes.txt', { type: 'text/plain' });
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        sendTerminalInput: mockSendTerminalInput,
        getPathForFile: () => 'C:\\notes.txt',
        toTerminalRuntimePaths: vi.fn().mockRejectedValue(new Error('Clipboard denied')),
      };

      // Override XTerm mock to be constructable
      (XTerm as unknown as Mock).mockImplementation(function() {
        return {
          open: vi.fn(),
          loadAddon: vi.fn(),
          attachCustomKeyEventHandler: vi.fn(function(handler: (event: KeyboardEvent) => boolean) {
            keyEventHandler = handler;
          }),
          hasSelection: vi.fn(),
          getSelection: vi.fn(),
          paste: mockPaste,
          input: mockInput,
          onData: vi.fn(function(callback: (data: string) => void) {
            onDataCallback = callback;
          }),
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
        };
      });

      // Need to also override the addon mocks to be constructable
      (FitAddon as unknown as Mock).mockImplementation(function() {
        return { fit: vi.fn() };
      });

      (WebLinksAddon as unknown as Mock).mockImplementation(function() {
        return {};
      });

      (SerializeAddon as unknown as Mock).mockImplementation(function() {
        return {
          serialize: vi.fn(function() { return ''; }),
          dispose: vi.fn()
        };
      });

      // Create a test wrapper component that provides the DOM element
      const TestWrapper = () => {
        const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
        return React.createElement('div', { ref: terminalRef });
      };

      const { container } = render(React.createElement(TestWrapper));

      await act(async () => {
        // Paste a copied file (translating its path fails)
        keyEventHandler?.(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true }));
        firePaste(container.firstElementChild!, { files: [copied] });
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      // The paste falls back to the path as it was
      expect(mockPaste).toHaveBeenCalledWith('C:\\notes.txt');

      // Verify terminal still works (can accept input through onData callback)
      const inputData = 'test command';

      if (onDataCallback) {
        onDataCallback(inputData);
      }

      // Verify input was sent to electronAPI (terminal still functional)
      expect(mockSendTerminalInput).toHaveBeenCalledWith('test-terminal', 'test command');
    });
  });
});
