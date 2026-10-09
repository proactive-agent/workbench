import { useEffect, useState } from 'react';
import { readRefreshCache, writeRefreshCache } from '../lib/refresh-cache';

export interface OllamaLlmModel {
  name: string;
  size_bytes: number;
  is_embedding: boolean;
}

/** Shared with the Agents page's Ollama model manager, which refreshes it */
const MODELS_CACHE_KEY = 'ollama-llm-models';

/**
 * Installed Ollama LLM models (embedding models left out) for model pickers: the last fetched
 * list, fetched only when none was fetched before. The Agents page's Ollama section refreshes it.
 */
export function useOllamaLlmModels(enabled: boolean) {
  const [models, setModels] = useState<OllamaLlmModel[]>(
    () => readRefreshCache<{ available: boolean; models: OllamaLlmModel[] }>(MODELS_CACHE_KEY)?.models ?? []
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const cached = readRefreshCache<{ available: boolean; models: OllamaLlmModel[] }>(MODELS_CACHE_KEY);
    if (cached) {
      setModels(cached.models);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    window.electronAPI.listOllamaModels()
      .then((result) => {
        if (controller.signal.aborted) return;
        const available = !!result?.success && Array.isArray(result.data?.models);
        const llmModels = available
          ? (result.data!.models as OllamaLlmModel[]).filter((m) => m.is_embedding === false)
          : [];
        writeRefreshCache(MODELS_CACHE_KEY, { available, models: llmModels });
        setModels(llmModels);
      })
      .catch(() => {
        // Ollama not available: leave the list empty
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [enabled]);

  return { models: enabled ? models : [], isLoading };
}
