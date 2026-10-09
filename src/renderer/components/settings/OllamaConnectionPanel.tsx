import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { ExternalLink } from '../ui/external-link';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useSettingsStore } from '../../stores/settings-store';
import type { ProviderAccount } from '@shared/types/provider-account';

type OllamaConnectionState = 'checking' | 'not-installed' | 'not-running' | 'connected';

interface OllamaConnectionPanelProps {
  accounts: ProviderAccount[];
  onAccountCreated?: () => void;
}

export function OllamaConnectionPanel({ accounts, onAccountCreated }: OllamaConnectionPanelProps) {
  const { t } = useTranslation('settings');
  const addProviderAccount = useSettingsStore((state) => state.addProviderAccount);

  const [connectionState, setConnectionState] = useState<OllamaConnectionState>('checking');
  const [llmModelCount, setLlmModelCount] = useState<number | null>(null);
  const [customUrl, setCustomUrl] = useState('http://localhost:11434');
  const [showCustomUrl, setShowCustomUrl] = useState(false);
  const [autoConnected, setAutoConnected] = useState(false);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  const hasOllamaAccount = accounts.length > 0;

  const checkConnection = useCallback(async (abortSignal?: AbortSignal) => {
    setConnectionState('checking');

    try {
      const installResult = await window.electronAPI.checkOllamaInstalled();
      if (abortSignal?.aborted) return;

      if (!installResult?.success || !installResult?.data?.installed) {
        setConnectionState('not-installed');
        return;
      }

      const statusResult = await window.electronAPI.checkOllamaStatus(customUrl !== 'http://localhost:11434' ? customUrl : undefined);
      if (abortSignal?.aborted) return;

      if (!statusResult?.success || !statusResult?.data?.running) {
        setConnectionState('not-running');
        return;
      }

      setConnectionState('connected');

      // Fetch model count (LLMs only, filter out embedding models)
      const modelsResult = await window.electronAPI.listOllamaModels(customUrl !== 'http://localhost:11434' ? customUrl : undefined);
      if (abortSignal?.aborted) return;

      if (modelsResult?.success && modelsResult?.data?.models) {
        const llmModels = modelsResult.data.models.filter((m) => !m.is_embedding);
        setLlmModelCount(llmModels.length);
      }

      // Auto-create account if none exists yet
      if (!hasOllamaAccount && !isCreatingAccount) {
        setIsCreatingAccount(true);
        try {
          await addProviderAccount({
            provider: 'ollama',
            name: 'Ollama (Local)',
            authType: 'api-key',
            billingModel: 'pay-per-use',
            baseUrl: customUrl,
          });
          setAutoConnected(true);
          onAccountCreated?.();
        } catch {
          // Auto-creation failed silently; user can add manually
        } finally {
          setIsCreatingAccount(false);
        }
      }
    } catch (err) {
      if (!abortSignal?.aborted) {
        setConnectionState('not-running');
      }
    }
  }, [customUrl, hasOllamaAccount, isCreatingAccount, addProviderAccount, onAccountCreated]);

  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    checkConnection(controller.signal);
    return () => {
      controller.abort();
    };
  }, [checkConnection]);

  if (connectionState === 'checking') {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-(--nav-label-color)">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        {t('providers.ollama.connection.checking', { defaultValue: 'Checking Ollama connection...' })}
      </div>
    );
  }

  // Not installed or not running: plain settings-style text with soft buttons
  if (connectionState === 'not-installed' || connectionState === 'not-running') {
    const notInstalled = connectionState === 'not-installed';
    return (
      <div className="space-y-3">
        <div>
          <p className="text-sm text-foreground">
            {notInstalled
              ? t('providers.ollama.connection.notInstalled', { defaultValue: 'Ollama not installed' })
              : t('providers.ollama.connection.notRunning', { defaultValue: 'Ollama not running' })}
          </p>
          <p className="mt-0.5 text-sm text-(--nav-label-color)">
            {notInstalled
              ? t('providers.ollama.connection.notInstalledDescription', { defaultValue: 'Install Ollama to run open-source AI models locally' })
              : t('providers.ollama.connection.notRunningDescription', { defaultValue: 'Start the Ollama service to connect' })}
          </p>
          {!notInstalled && (
            <p className="mt-0.5 font-mono text-xs text-(--nav-label-color)">
              {t('providers.ollama.connection.startCommand', { defaultValue: "Run 'ollama serve' in your terminal" })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {notInstalled && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.electronAPI?.openExternal?.('https://ollama.com/download')}
              className="gap-1.5"
            >
              <Download className="h-4 w-4" strokeWidth={1.75} />
              {t('providers.ollama.connection.install', { defaultValue: 'Install Ollama' })}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => checkConnection()} className="gap-1.5">
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
            {t('providers.ollama.connection.retry', { defaultValue: 'Retry' })}
          </Button>
          {notInstalled && (
            <ExternalLink href="https://ollama.com">
              {t('providers.ollama.connection.learnMore', { defaultValue: 'Learn more' })}
            </ExternalLink>
          )}
        </div>
      </div>
    );
  }

  // Connected
  const notes = [
    llmModelCount === null
      ? null
      : llmModelCount > 0
        ? t('providers.ollama.connection.modelsAvailable', { count: llmModelCount, defaultValue: '{{count}} LLM model(s) installed' })
        : t('providers.ollama.connection.noModels', { defaultValue: 'No LLM models installed yet' }),
    autoConnected || hasOllamaAccount
      ? t('providers.ollama.connection.autoConnected', { defaultValue: 'Auto-connected as local provider' })
      : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm text-foreground">
          {t('providers.ollama.connection.connected', { defaultValue: 'Connected' })}
        </p>
        <p className="mt-0.5 text-sm text-(--nav-label-color)">
          {t('providers.ollama.connection.connectedDescription', { defaultValue: 'Ollama is running and ready to use' })}
          {notes && ` · ${notes}`}
        </p>
      </div>

      {/* Custom URL (collapsed by default) */}
      <button
        type="button"
        onClick={() => setShowCustomUrl((prev) => !prev)}
        aria-expanded={showCustomUrl}
        className="text-sm text-(--nav-label-color) underline-offset-2 hover:text-foreground hover:underline"
      >
        {t('providers.ollama.connection.customUrl', { defaultValue: 'Custom URL' })}
      </button>
      {showCustomUrl && (
        <div className="flex items-center gap-2">
          <Input
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder={t('providers.ollama.connection.customUrlPlaceholder', { defaultValue: 'http://localhost:11434' })}
            className="h-8 font-mono text-[0.8125rem]"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => checkConnection()}
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label={t('providers.ollama.connection.retry', { defaultValue: 'Retry' })}
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      )}
    </div>
  );
}
