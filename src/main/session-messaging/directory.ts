/**
 * The chats and agent windows messages can reach, by their stable names
 * (shared/utils/session-names.ts). The Claude chat and the terminals register here at startup,
 * so the messaging tools reach them without importing them (which would import the tools back).
 */
import type { SessionMessageOrigin } from '../../shared/types';
import type { TerminalProcess } from '../terminal/types';

/** A chat of a project, as the messaging tools list it */
export interface ChatEntry {
  chatId: string;
  title?: string;
  /** Writing a reply right now (a message waits until it ends) */
  replying: boolean;
}

/** What delivering a message to a chat did */
export type ChatDelivery =
  | { status: 'started' }
  | { status: 'queued' }
  /** Shown in the chat without a reply: it answered too many in a row, and waits for the user */
  | { status: 'held'; answered: number }
  | { status: 'notFound' };

/** The Claude chat, as the messaging tools need it */
export interface ChatSource {
  list: (projectId: string, projectPath: string) => ChatEntry[];
  /** Add the message to the chat and have it reply (now, or after the reply it is writing) */
  deliver: (projectId: string, projectPath: string, chatId: string, from: SessionMessageOrigin, text: string) => Promise<ChatDelivery>;
}

let chatSource: ChatSource | null = null;
let windowSource: () => TerminalProcess[] = () => [];

export function setChatSource(source: ChatSource | null): void {
  chatSource = source;
}

export function getChatSource(): ChatSource | null {
  return chatSource;
}

/** Where the agent windows are (the terminal manager's terminals) */
export function setWindowSource(source: () => TerminalProcess[]): void {
  windowSource = source;
}

/** A project's agent windows */
export function projectWindows(projectPath: string): TerminalProcess[] {
  return windowSource().filter((terminal) => terminal.projectPath === projectPath);
}

/** An agent window by its id */
export function findWindow(terminalId: string): TerminalProcess | undefined {
  return windowSource().find((terminal) => terminal.id === terminalId);
}
