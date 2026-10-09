import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Download,
  Loader2,
  RefreshCw
} from 'lucide-react';
import { ExternalLink } from '../ui/external-link';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { useDownloadStore } from '../../stores/download-store';

type OllamaState = 'checking' | 'not-installed' | 'not-running' | 'available';

interface OllamaModel {
  name: string;
  description: string;
  size_estimate?: string;
  dim: number;
  installed: boolean;
  badge?: 'recommended' | 'quality' | 'fast';
}

interface OllamaModelSelectorProps {
  selectedModel: string;
  onModelSelect: (model: string, dim: number) => void;
  disabled?: boolean;
  className?: string;
  baseUrl?: string;
}

// Recommended embedding models for Auto Claude Memory
// qwen3-embedding:4b is first as the recommended default (balanced quality/speed)
const RECOMMENDED_MODELS: OllamaModel[] = [
  {
    name: 'qwen3-embedding:4b',
    description: 'Qwen3 4B - Balanced quality and speed',
    size_estimate: '3.1 GB',
    dim: 2560,
    installed: false,
    badge: 'recommended',
  },
  {
    name: 'qwen3-embedding:8b',
    description: 'Qwen3 8B - Best embedding quality',
    size_estimate: '6.0 GB',
    dim: 4096,
    installed: false,
    badge: 'quality',
  },
  {
    name: 'qwen3-embedding:0.6b',
    description: 'Qwen3 0.6B - Smallest and fastest',
    size_estimate: '494 MB',
    dim: 1024,
    installed: false,
    badge: 'fast',
  },
  {
    name: 'embeddinggemma',
    description: "Google's lightweight embedding model",
    size_estimate: '621 MB',
    dim: 768,
    installed: false,
  },
  {
    name: 'nomic-embed-text',
    description: 'Popular general-purpose embeddings',
    size_estimate: '274 MB',
    dim: 768,
    installed: false,
  },
];

/**
 * OllamaModelSelector Component
 *
 * Provides UI for selecting and downloading Ollama embedding models for semantic search.
 * Features:
 * - Displays list of recommended embedding models (embeddinggemma, nomic-embed-text, mxbai-embed-large)
 * - Shows installation status with checkmarks for installed models
 * - Download buttons with file size estimates for uninstalled models
 * - Real-time download progress tracking with speed and ETA
 * - Automatic list refresh after successful downloads
 * - Graceful handling when Ollama service is not running
 *
 * @component
 * @param {Object} props - Component props
 * @param {string} props.selectedModel - Currently selected model name
 * @param {Function} props.onModelSelect - Callback when a model is selected (model: string, dim: number) => void
 * @param {boolean} [props.disabled=false] - If true, disables selection and downloads
 * @param {string} [props.className] - Additional CSS classes to apply to root element
 *
 * @example
 * ```tsx
 * <OllamaModelSelector
 *   selectedModel="embeddinggemma"
 *   onModelSelect={(model, dim) => console.log(`Selected ${model} with ${dim} dimensions`)}
 *   disabled={false}
 * />
 * ```
 */
export function OllamaModelSelector({
  selectedModel,
  onModelSelect,
  disabled = false,
  className,
  baseUrl,
}: OllamaModelSelectorProps) {
  const { t } = useTranslation('onboarding');
  const [models, setModels] = useState<OllamaModel[]>(RECOMMENDED_MODELS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ollamaState, setOllamaState] = useState<OllamaState>('checking');
  const [isInstalling, setIsInstalling] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  // Track timeout for cleanup on unmount
  const installCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use global download store for tracking downloads
  const downloads = useDownloadStore((state) => state.downloads);
  const startDownload = useDownloadStore((state) => state.startDownload);
  const completeDownload = useDownloadStore((state) => state.completeDownload);
  const failDownload = useDownloadStore((state) => state.failDownload);

  /**
   * Checks if Ollama is installed, running, and fetches installed models.
   * Updates component state based on Ollama availability.
   *
   * @param {AbortSignal} [abortSignal] - Optional abort signal to cancel the request
   * @returns {Promise<void>}
   */
  const checkInstalledModels = useCallback(async (abortSignal?: AbortSignal) => {
    setIsLoading(true);
    setError(null);
    setOllamaState('checking');

    try {
      // First check if Ollama is installed (binary exists)
      const installResult = await window.electronAPI.checkOllamaInstalled();
      if (abortSignal?.aborted) return;

      if (!installResult?.success || !installResult?.data?.installed) {
        setOllamaState('not-installed');
        setIsLoading(false);
        return;
      }

      // Ollama is installed, now check if it's running
      const statusResult = await window.electronAPI.checkOllamaStatus(baseUrl);
      if (abortSignal?.aborted) return;

      if (!statusResult?.success || !statusResult?.data?.running) {
        setOllamaState('not-running');
        setIsLoading(false);
        return;
      }

      setOllamaState('available');

      // Get list of installed embedding models
      const result = await window.electronAPI.listOllamaEmbeddingModels(baseUrl);
      if (abortSignal?.aborted) return;

      if (result?.success && result?.data?.embedding_models) {
        // Build a set of installed model names (full, base, and version-matched)
        const installedFullNames = new Set<string>();
        const installedBaseNames = new Set<string>();
        const installedVersionNames = new Set<string>();

        result.data.embedding_models.forEach((m: { name: string }) => {
          const name = m.name;
          installedFullNames.add(name);

          // Normalize :latest suffix
          if (name.endsWith(':latest')) {
            installedBaseNames.add(name.replace(':latest', ''));
          } else if (!name.includes(':')) {
            installedBaseNames.add(name);
          }

          // Handle quantization variants (e.g., qwen3-embedding:8b-q4_K_M)
          // Extract base:version without quantization suffix
          const quantMatch = name.match(/^([^:]+:[^-]+)/);
          if (quantMatch) {
            installedVersionNames.add(quantMatch[1]);
          }
        });

        // Update models with installation status
        setModels(
          RECOMMENDED_MODELS.map(model => {
            // Check multiple matching strategies:
            // 1. Exact match (e.g., "qwen3-embedding:8b" === "qwen3-embedding:8b")
            // 2. Base name match for :latest normalization (handles "embeddinggemma" matching "embeddinggemma:latest")
            // 3. Version match ignoring quantization suffix (e.g., "qwen3-embedding:8b" matches "qwen3-embedding:8b-q4_K_M")
            const isInstalled = installedFullNames.has(model.name) ||
              installedBaseNames.has(model.name) ||
              installedVersionNames.has(model.name);
            return {
              ...model,
              installed: isInstalled,
            };
          })
        );
      }
    } catch (err) {
      if (!abortSignal?.aborted) {
        console.error('Failed to check Ollama models:', err);
        setError('Failed to check Ollama models');
      }
    } finally {
      if (!abortSignal?.aborted) {
        setIsLoading(false);
      }
    }
  }, [baseUrl]);

  /**
   * Install Ollama by opening terminal with the official install command.
   */
  const handleInstallOllama = async () => {
    setIsInstalling(true);
    setError(null);

    try {
      const result = await window.electronAPI.installOllama();
      if (result?.success) {
        setInstallSuccess(true);
        // Clear any existing timeout before setting a new one
        if (installCheckTimeoutRef.current) {
          clearTimeout(installCheckTimeoutRef.current);
        }
        // Re-check after a delay to give user time to complete installation
        installCheckTimeoutRef.current = setTimeout(() => {
          checkInstalledModels();
        }, 5000);
      } else {
        setError(result?.error || 'Failed to start Ollama installation');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install Ollama');
    } finally {
      setIsInstalling(false);
    }
  };

  // On open: the last check's result for this Ollama URL; only check when it never ran
  // (Retry checks again)
  const cacheKey = `ollama-embedding-models:${baseUrl ?? 'default'}`;
  const checkRef = useRef(checkInstalledModels);
  checkRef.current = checkInstalledModels;
  useEffect(() => {
    const controller = new AbortController();
    const cached = readRefreshCache<{ state: OllamaState; models: OllamaModel[] }>(cacheKey);
    if (cached) {
      setOllamaState(cached.state);
      setModels(cached.models);
      setIsLoading(false);
    } else {
      void checkRef.current(controller.signal);
    }
    return () => {
      controller.abort();
      // Clean up the install check timeout to prevent setState on unmounted component
      if (installCheckTimeoutRef.current) {
        clearTimeout(installCheckTimeoutRef.current);
      }
    };
  }, [cacheKey]);

  // Remember each finished check
  useEffect(() => {
    if (!isLoading && ollamaState !== 'checking') writeRefreshCache(cacheKey, { state: ollamaState, models });
  }, [cacheKey, isLoading, ollamaState, models]);

  // Progress is now handled globally by the download store listener initialized in App.tsx

   /**
    * Initiates download of an Ollama embedding model.
    * Uses global download store for state tracking and refreshes model list after completion.
    *
    * @param {string} modelName - Name of the model to download (e.g., 'embeddinggemma')
    * @returns {Promise<void>}
    */
   const handleDownload = async (modelName: string) => {
     startDownload(modelName);
     setError(null);

     try {
       const result = await window.electronAPI.pullOllamaModel(modelName);
       if (result?.success) {
         completeDownload(modelName);
         // Refresh the model list
         await checkInstalledModels();
       } else {
         const errorMsg = result?.error || `Failed to download ${modelName}`;
         failDownload(modelName, errorMsg);
         setError(errorMsg);
       }
     } catch (err) {
       const errorMsg = err instanceof Error ? err.message : 'Download failed';
       failDownload(modelName, errorMsg);
       setError(errorMsg);
     }
   };

   /**
    * Handles model selection with toggle behavior.
    * Clicking an already-selected model will deselect it.
    * Only allows selection of installed models and when component is not disabled.
    *
    * @param {OllamaModel} model - The model to select or deselect
    * @returns {void}
    */
   const handleSelect = (model: OllamaModel) => {
     if (!model.installed || disabled) return;

     // Toggle behavior: if already selected, deselect by passing empty values
     if (selectedModel === model.name) {
       onModelSelect('', 0);
     } else {
       onModelSelect(model.name, model.dim);
     }
   };

  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-2 py-2 text-sm text-(--nav-label-color)', className)}>
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        {t('ollama.models.checking')}
      </div>
    );
  }

  // Ollama not installed or not running: plain settings-style text with soft buttons
  if (ollamaState === 'not-installed' || ollamaState === 'not-running') {
    const notInstalled = ollamaState === 'not-installed';
    const key = notInstalled ? 'ollama.notInstalled' : 'ollama.notRunning';
    return (
      <div className={cn('space-y-3', className)}>
        <div>
          <p className="text-sm text-foreground">{t(`${key}.title`)}</p>
          <p className="mt-0.5 text-sm text-(--nav-label-color)">{t(`${key}.description`)}</p>
        </div>

        {installSuccess && <p className="text-sm text-(--nav-label-color)">{t('ollama.notInstalled.installSuccess')}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {notInstalled && (
            <Button variant="outline" size="sm" onClick={handleInstallOllama} disabled={isInstalling} className="gap-1.5">
              {isInstalling ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : <Download className="h-4 w-4" strokeWidth={1.75} />}
              {isInstalling ? t('ollama.notInstalled.installing') : t('ollama.notInstalled.installButton')}
            </Button>
          )}
          {/* Retry re-checks (the loading state replaces this block, so it can't be double-clicked) */}
          <Button variant="outline" size="sm" onClick={() => checkInstalledModels()} className="gap-1.5">
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
            {t(`${key}.retry`)}
          </Button>
          {notInstalled && <ExternalLink href="https://ollama.com">{t('ollama.notInstalled.learnMore')}</ExternalLink>}
        </div>

        <p className="text-xs text-(--nav-label-color)">{t(`${key}.fallbackNote`)}</p>
      </div>
    );
  }

  // Model list: rows like a settings list; click an installed model to use it
  return (
    <div className={cn('space-y-2', className)}>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="[&>*+*]:border-t [&>*+*]:border-settings-divider">
        {models.map((model) => {
          const isSelected = selectedModel === model.name;
          const download = downloads[model.name];
          const isCurrentlyDownloading = download?.status === 'starting' || download?.status === 'downloading';
          const notes = [
            t('ollama.models.dimensions', { dim: model.dim }),
            model.badge ? t(`ollama.models.${model.badge}`) : null,
            model.installed ? t('ollama.models.installed') : null,
          ].filter(Boolean).join(' · ');

          return (
            <div
              key={model.name}
              role={model.installed ? 'button' : undefined}
              tabIndex={model.installed && !disabled ? 0 : undefined}
              aria-pressed={model.installed ? isSelected : undefined}
              className={cn(
                '-mx-2 rounded-lg px-2 py-2.5 outline-none focus-visible:shadow-(--shadow-focus)',
                model.installed && !disabled && 'hover:bg-nav-hover'
              )}
              onClick={() => handleSelect(model)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(model);
                }
              }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm text-foreground">{model.name}</div>
                  <div className="text-sm text-(--nav-label-color)">{notes}</div>
                  {model.description && <div className="text-sm text-(--nav-label-color)">{model.description}</div>}
                </div>

                {isSelected ? (
                  <Check className="h-4 w-4 shrink-0 text-(--menu-check)" strokeWidth={2} />
                ) : !model.installed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload(model.name);
                    }}
                    disabled={isCurrentlyDownloading || disabled}
                    className="shrink-0 gap-1.5"
                  >
                    {isCurrentlyDownloading ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : <Download className="h-4 w-4" strokeWidth={1.75} />}
                    {isCurrentlyDownloading ? t('ollama.models.downloading') : t('ollama.models.download')}
                    {!isCurrentlyDownloading && model.size_estimate && (
                      <span className="text-(--nav-label-color)">{model.size_estimate}</span>
                    )}
                  </Button>
                ) : null}
              </div>

              {/* Download progress */}
              {isCurrentlyDownloading && (
                <div className="mt-2 space-y-1">
                  <div className="h-1 w-full overflow-hidden rounded-full bg-segment-track">
                    {download && download.percentage > 0 ? (
                      <div
                        className="h-full rounded-full bg-foreground/60 transition-all duration-300"
                        style={{ width: `${Math.max(0, Math.min(100, download.percentage))}%` }}
                      />
                    ) : (
                      <div className="h-full w-1/4 rounded-full bg-foreground/60 animate-indeterminate" />
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs text-(--nav-label-color)">
                    <span>
                      {download && download.percentage > 0 ? `${Math.round(download.percentage)}%` : t('ollama.models.startingDownload')}
                    </span>
                    <span className="flex items-center gap-2">
                      {download?.speed && <span>{download.speed}</span>}
                      {download?.timeRemaining && <span>{download.timeRemaining}</span>}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-(--nav-label-color)">{t('ollama.models.selectHint')}</p>
    </div>
  );
}
