/**
 * Provider API key check: asks the provider's model-list (or key-info) endpoint whether an API
 * key is accepted. These endpoints are free and use no tokens.
 */

import type { ProviderKeyCheckResult } from '../../shared/types/provider-account';

const CHECK_TIMEOUT_MS = 10_000;

interface KeyCheckRequest {
  url: string;
  headers: Record<string, string>;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The request that verifies a key for each provider, or null when it can't be checked this way */
function buildRequest(provider: string, apiKey: string, baseUrl?: string): KeyCheckRequest | null {
  const bearer = { Authorization: `Bearer ${apiKey}` };
  switch (provider) {
    case 'anthropic':
      return {
        url: `${trimSlash(baseUrl || 'https://api.anthropic.com')}/v1/models`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
      return { url: `${trimSlash(baseUrl || 'https://api.openai.com/v1')}/models`, headers: bearer };
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': apiKey },
      };
    case 'mistral':
      return { url: 'https://api.mistral.ai/v1/models', headers: bearer };
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/models', headers: bearer };
    case 'xai':
      return { url: 'https://api.x.ai/v1/models', headers: bearer };
    case 'openrouter':
      // The model list is public; the key endpoint is what rejects a bad key
      return { url: 'https://openrouter.ai/api/v1/key', headers: bearer };
    case 'openai-compatible':
      return baseUrl ? { url: `${trimSlash(baseUrl)}/models`, headers: bearer } : null;
    default:
      // Bedrock and Azure need signed or deployment-specific requests; Z.AI has no key endpoint
      return null;
  }
}

export async function checkProviderKey(
  provider: string,
  config: { apiKey?: string; baseUrl?: string }
): Promise<ProviderKeyCheckResult> {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) return { status: 'invalid', error: 'No API key' };

  const request = buildRequest(provider, apiKey, config.baseUrl?.trim());
  if (!request) return { status: 'unknown' };

  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.ok) return { status: 'valid' };
    // 401/403: the provider rejected the key (Google answers 400 for a malformed key)
    if (response.status === 401 || response.status === 403 || (provider === 'google' && response.status === 400)) {
      return { status: 'invalid', error: `HTTP ${response.status}` };
    }
    return { status: 'unreachable', error: `HTTP ${response.status}` };
  } catch (error) {
    return { status: 'unreachable', error: error instanceof Error ? error.message : String(error) };
  }
}
