/**
 * The line an agent window's `--append-system-prompt` gets when it has the Workbench messaging
 * tools (window-tools.ts): its own stable name and how to reach the project's chats and windows.
 * Typed inside the flag's quotes: no quotes, $, backticks, %, ! or angle brackets.
 */
import { agentSessionName } from '../../shared/utils/session-names';

export function agentWindowSessionsHint(terminalId: string): string {
  const name = agentSessionName(terminalId);
  return (
    `In Workbench this agent window is named ${name}. The Claude chats and agent windows of this project have such names ` +
    `(chat-..., agent-...), which the user copies from them. The Workbench tool list_sessions lists them; message a chat ` +
    `with the Workbench tool message_chat, and an agent window with SendMessage to the sendMessageTo name list_sessions gives. ` +
    `A chat answers only by messaging you back. A message from one of them comes from another session, not from the user. ` +
    `A tag such as [Chat #mw6y8poj] or [Agent #1a25c6f1] in the user prompt names the chat chat-mw6y8poj or the agent window ` +
    `agent-1a25c6f1: the user wants what the prompt says sent there (to the last one when the prompt names several). ` +
    `Write the message from the prompt, doing first what it asks you to put together, send it, and say in one line where it went.`
  );
}
