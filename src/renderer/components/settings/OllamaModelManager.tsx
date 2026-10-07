import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Check, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { useDownloadStore } from '../../stores/download-store';

interface InstalledModel {
  name: string;
  size_bytes: number;
  is_embedding: boolean;
}

interface RecommendedCodingModel {
  name: string;
  description: string;
  size: string;
  badge?: 'recommended' | 'fast' | 'quality';
}

const RECOMMENDED_CODING_MODELS: RecommendedCodingModel[] = [
  { name: 'qwen3:32b', description: 'Qwen3 32B - Excellent coding model', size: '20 GB', badge: 'recommended' as const },
  { name: 'qwen3:8b', description: 'Qwen3 8B - Fast and capable', size: '5.2 GB', badge: 'fast' as const },
  { name: 'deepseek-r1:32b', description: 'DeepSeek R1 32B - Strong reasoning', size: '20 GB' },
  { name: 'deepseek-r1:8b', description: 'DeepSeek R1 8B - Compact reasoner', size: '5.0 GB' },
  { name: 'codestral', description: 'Mistral Codestral - Code specialist', size: '13 GB' },
  { name: 'llama3.3:70b', description: 'Llama 3.3 70B - Large and powerful', size: '43 GB', badge: 'quality' as const },
  { name: 'llama3.3', description: 'Llama 3.3 - Good general purpose', size: '4.9 GB' },
];

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

/**
 * OllamaModelManager
 *
 * Shows installed Ollama LLM models and lets users download recommended coding models.
 * Filters out embedding models (is_embedding === true) from the installed list.
 * Uses the global download store for progress tracking.
 */
export function OllamaModelManager() {
  const { t } = useTranslation('settings');

  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [ollamaAvailable, setOllamaAvailable] = useState(false);

  const downloads = useDownloadStore((state) => state.downloads);
  const startDownload = useDownloadStore((state) => state.startDownload);
  const completeDownload = useDownloadStore((state) => state.completeDownload);
  const failDownload = useDownloadStore((state) => state.failDownload);

  const fetchModels = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.listOllamaModels();
      if (signal?.aborted) return;

      if (result?.success && Array.isArray(result?.data?.models)) {
        const llmModels = (result.data.models as InstalledModel[]).filter(
          (m) => m.is_embedding === false
        );
        setInstalledModels(llmModels);
        setOllamaAvailable(true);
      } else {
        setOllamaAvailable(false);
        setInstalledModels([]);
      }
    } catch {
      if (!signal?.aborted) {
        setOllamaAvailable(false);
        setInstalledModels([]);
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchModels(controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchModels]);

  // Build sets for fast installed-model lookup
  const installedNames = new Set<string>();
  const installedBaseNames = new Set<string>();
  installedModels.forEach((m) => {
    installedNames.add(m.name);
    if (m.name.endsWith(':latest')) {
      installedBaseNames.add(m.name.replace(':latest', ''));
    } else if (!m.name.includes(':')) {
      installedBaseNames.add(m.name);
    }
  });

  const isInstalled = (name: string): boolean =>
    installedNames.has(name) || installedBaseNames.has(name);

  const handleDownload = async (modelName: string) => {
    startDownload(modelName);

    try {
      const result = await window.electronAPI.pullOllamaModel(modelName);
      if (result?.success) {
        completeDownload(modelName);
        // Refresh installed list after successful download
        await fetchModels();
      } else {
        const errorMsg = result?.error || `Failed to download ${modelName}`;
        failDownload(modelName, errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Download failed';
      failDownload(modelName, errorMsg);
    }
  };

  const title = t('agentProfile.ollamaModels.title', { defaultValue: 'Ollama models' });
  const mutedClass = 'text-sm text-(--nav-label-color)';

  if (isLoading) {
    return (
      <SettingsSection title={title}>
        <div className={`flex items-center gap-2 py-3 ${mutedClass}`}>
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          <span>{t('agentProfile.ollamaModels.loading', { defaultValue: 'Loading models...' })}</span>
        </div>
      </SettingsSection>
    );
  }

  if (!ollamaAvailable) {
    return (
      <SettingsSection title={title}>
        <p className={`rounded-xl bg-segment-track px-4 py-3 ${mutedClass}`}>
          {t('agentProfile.ollamaModels.ollamaNotAvailable', {
            defaultValue: 'Connect Ollama in Account Settings to manage models',
          })}
        </p>
      </SettingsSection>
    );
  }

  const badgeLabels: Record<NonNullable<RecommendedCodingModel['badge']>, string> = {
    recommended: t('agentProfile.ollamaModels.badgeRecommended'),
    fast: t('agentProfile.ollamaModels.badgeFast'),
    quality: t('agentProfile.ollamaModels.badgeQuality'),
  };

  return (
    <>
      {/* Installed models */}
      <SettingsSection
        title={title}
        description={t('agentProfile.ollamaModels.description', {
          defaultValue: 'Manage locally installed models for AI agent tasks',
        })}
      >
        <SettingsRows>
          <SettingsRow
            label={t('agentProfile.ollamaModels.installed', { defaultValue: 'Installed models' })}
            description={
              installedModels.length === 0
                ? t('agentProfile.ollamaModels.noModels', { defaultValue: 'No LLM models installed' })
                : t('agentProfile.ollamaModels.installedCount', {
                    count: installedModels.length,
                    defaultValue: '{{count}} model(s)',
                  })
            }
          >
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fetchModels()}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t('agentProfile.ollamaModels.refresh', { defaultValue: 'Refresh' })}
            </Button>
          </SettingsRow>
          {installedModels.map((model) => (
            <SettingsRow key={model.name} label={<span className="font-mono text-[0.8125rem]">{model.name}</span>}>
              <span className={mutedClass}>{formatSize(model.size_bytes)}</span>
            </SettingsRow>
          ))}
        </SettingsRows>
      </SettingsSection>

      {/* Recommended for coding */}
      <SettingsSection
        title={t('agentProfile.ollamaModels.recommended', { defaultValue: 'Recommended for coding' })}
        description={t('agentProfile.ollamaModels.recommendedDescription', {
          defaultValue: 'Popular models optimized for code generation and reasoning',
        })}
      >
        <SettingsRows>
          {RECOMMENDED_CODING_MODELS.map((model) => {
            const installed = isInstalled(model.name);
            const download = downloads[model.name];
            const isCurrentlyDownloading =
              download?.status === 'starting' || download?.status === 'downloading';

            return (
              <SettingsRow
                key={model.name}
                label={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[0.8125rem]">{model.name}</span>
                    {/* Model quality/speed tag as plain muted text */}
                    {model.badge && <span className={mutedClass}>{badgeLabels[model.badge]}</span>}
                  </span>
                }
                description={`${model.description} · ${model.size}`}
                footer={
                  isCurrentlyDownloading ? (
                    <div className="space-y-1.5">
                      <div className="h-1 w-full overflow-hidden rounded-full bg-segment-track">
                        {download && download.percentage > 0 ? (
                          <div
                            className="h-full rounded-full bg-foreground/70 transition-all duration-300"
                            style={{
                              width: `${Math.max(0, Math.min(100, download.percentage))}%`,
                            }}
                          />
                        ) : (
                          /* Indeterminate sliding state while waiting for progress events */
                          <div className="h-full w-1/4 rounded-full bg-foreground/70 animate-indeterminate" />
                        )}
                      </div>
                      {/* Progress info: percentage, speed, time remaining */}
                      <div className="flex items-center justify-between text-xs text-(--nav-label-color)">
                        <span>
                          {download && download.percentage > 0
                            ? `${Math.round(download.percentage)}%`
                            : t('agentProfile.ollamaModels.startingDownload')}
                        </span>
                        <div className="flex items-center gap-2">
                          {download?.speed && <span>{download.speed}</span>}
                          {download?.timeRemaining && <span>{download.timeRemaining}</span>}
                        </div>
                      </div>
                    </div>
                  ) : undefined
                }
              >
                {installed ? (
                  <span className={`flex items-center gap-1.5 ${mutedClass}`}>
                    <Check className="h-4 w-4 text-[var(--success)]" strokeWidth={1.75} />
                    {t('agentProfile.ollamaModels.installedLabel')}
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => handleDownload(model.name)}
                    disabled={isCurrentlyDownloading}
                  >
                    {isCurrentlyDownloading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                    {isCurrentlyDownloading
                      ? t('agentProfile.ollamaModels.downloading', { defaultValue: 'Downloading...' })
                      : t('agentProfile.ollamaModels.download', { defaultValue: 'Download' })}
                  </Button>
                )}
              </SettingsRow>
            );
          })}
        </SettingsRows>
      </SettingsSection>
    </>
  );
}
