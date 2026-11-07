/**
 * API profiles on a local endpoint (`http://localhost`, any port) may have no API key. Claude Code
 * and the Anthropic SDK still need a credential to send, so such a profile sends a placeholder.
 */

/** Sent as the credential of a local API profile without a key */
export const LOCAL_API_KEY_PLACEHOLDER = 'no-key';

/** Whether the base URL is a local endpoint (`http://localhost`, with or without a port or path) */
export function isLocalhostBaseUrl(baseUrl: string): boolean {
  return /^http:\/\/localhost(?=[:/?#]|$)/i.test(baseUrl.trim());
}

/** Whether a profile with this base URL can be saved without an API key */
export function isApiKeyOptional(baseUrl: string): boolean {
  return isLocalhostBaseUrl(baseUrl);
}

/** The credential to send for a profile: its key, or the placeholder for a local one without */
export function apiKeyToSend(baseUrl: string, apiKey: string | undefined): string {
  const key = apiKey?.trim() ?? '';
  return key || (isApiKeyOptional(baseUrl) ? LOCAL_API_KEY_PLACEHOLDER : '');
}
