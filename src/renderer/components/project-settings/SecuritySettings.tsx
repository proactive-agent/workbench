import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { SettingsSection } from '../settings/SettingsSection';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import { OllamaModelSelector } from '../onboarding/OllamaModelSelector';
import type { ProjectEnvConfig, ProjectSettings as ProjectSettingsType, MemoryEmbeddingProvider } from '../../../shared/types';

interface SecuritySettingsProps {
  envConfig: ProjectEnvConfig | null;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;

  // Password visibility
  showOpenAIKey: boolean;
  setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;

  // Kept for API compatibility; the page is always expanded now
  expanded: boolean;
  onToggle: () => void;
}

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  visible: boolean;
  onToggleVisible: () => void;
  showLabel: string;
  hideLabel: string;
}

function SecretInput({ value, onChange, placeholder, visible, onToggleVisible, showLabel, hideLabel }: SecretInputProps) {
  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
      />
      <button
        type="button"
        onClick={onToggleVisible}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={visible ? hideLabel : showLabel}
      >
        {visible ? <EyeOff className="h-4 w-4" strokeWidth={1.75} /> : <Eye className="h-4 w-4" strokeWidth={1.75} />}
      </button>
    </div>
  );
}

function KeyLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
      {children}
    </a>
  );
}

/**
 * Project "Memory" page: memory toggle, embedding provider and storage, as claude.ai sections.
 */
export function SecuritySettings({
  envConfig,
  settings,
  setSettings,
  updateEnvConfig,
  showOpenAIKey,
  setShowOpenAIKey,
  expanded: _expanded,
  onToggle: _onToggle
}: SecuritySettingsProps) {
  const { t } = useTranslation('settings');

  // Password visibility for multiple providers
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({
    openai: showOpenAIKey,
    voyage: false,
    google: false,
    azure: false
  });

  // Sync parent's showOpenAIKey prop to local state
  useEffect(() => {
    setShowApiKey(prev => ({ ...prev, openai: showOpenAIKey }));
  }, [showOpenAIKey]);

  const embeddingProvider = envConfig?.memoryProviderConfig?.embeddingProvider || 'ollama';

  // Toggle API key visibility
  const toggleShowApiKey = (key: string) => {
    const newValue = !showApiKey[key];
    setShowApiKey(prev => ({ ...prev, [key]: newValue }));
    // Sync with parent for OpenAI
    if (key === 'openai') {
      setShowOpenAIKey(newValue);
    }
  };

  // Handle Ollama model selection
  const handleOllamaModelSelect = (modelName: string, dim: number) => {
    updateEnvConfig({
      memoryProviderConfig: {
        ...envConfig?.memoryProviderConfig,
        embeddingProvider: 'ollama',
        ollamaEmbeddingModel: modelName,
        ollamaEmbeddingDim: dim,
      }
    });
  };

  if (!envConfig) return null;

  const updateProviderConfig = (
    provider: MemoryEmbeddingProvider,
    updates: Partial<NonNullable<ProjectEnvConfig['memoryProviderConfig']>>
  ) => {
    updateEnvConfig({
      memoryProviderConfig: {
        ...envConfig.memoryProviderConfig,
        embeddingProvider: provider,
        ...updates,
      }
    });
  };

  const secretProps = (key: string, name: string) => ({
    visible: !!showApiKey[key],
    onToggleVisible: () => toggleShowApiKey(key),
    showLabel: t('projectPages.memory.showKey', { name }),
    hideLabel: t('projectPages.memory.hideKey', { name })
  });

  // Render provider-specific configuration rows
  const renderProviderFields = () => {
    // OpenAI
    if (embeddingProvider === 'openai') {
      return (
        <SettingsRow
          stacked
          label={envConfig.openaiKeyIsGlobal ? t('projectPages.memory.openaiKeyOverride') : t('projectPages.memory.openaiKey')}
          description={
            <>
              {envConfig.openaiKeyIsGlobal
                ? t('projectPages.memory.usingGlobalKey')
                : t('projectPages.memory.requiredFor', { name: 'OpenAI' })}{' '}
              <KeyLink href="https://platform.openai.com/api-keys">{t('projectPages.memory.getKey', { name: 'OpenAI' })}</KeyLink>
            </>
          }
        >
          <SecretInput
            value={envConfig.openaiKeyIsGlobal ? '' : (envConfig.openaiApiKey || '')}
            onChange={(value) => updateEnvConfig({ openaiApiKey: value || undefined })}
            placeholder={envConfig.openaiKeyIsGlobal ? t('projectPages.memory.overridePlaceholder') : 'sk-xxxxxxxx'}
            {...secretProps('openai', 'OpenAI')}
          />
        </SettingsRow>
      );
    }

    // Voyage AI
    if (embeddingProvider === 'voyage') {
      return (
        <>
          <SettingsRow
            stacked
            label={t('projectPages.memory.apiKey', { name: 'Voyage AI' })}
            description={
              <>
                {t('projectPages.memory.requiredFor', { name: 'Voyage AI' })}{' '}
                <KeyLink href="https://dash.voyageai.com/api-keys">{t('projectPages.memory.getKey', { name: 'Voyage AI' })}</KeyLink>
              </>
            }
          >
            <SecretInput
              value={envConfig.memoryProviderConfig?.voyageApiKey || ''}
              onChange={(value) => updateProviderConfig('voyage', { voyageApiKey: value || undefined })}
              placeholder="pa-xxxxxxxx"
              {...secretProps('voyage', 'Voyage AI')}
            />
          </SettingsRow>
          <SettingsRow stacked label={t('projectPages.memory.embeddingModelOptional')}>
            <Input
              placeholder="voyage-3"
              value={envConfig.memoryProviderConfig?.voyageEmbeddingModel || ''}
              onChange={(e) => updateProviderConfig('voyage', { voyageEmbeddingModel: e.target.value || undefined })}
            />
          </SettingsRow>
        </>
      );
    }

    // Google AI
    if (embeddingProvider === 'google') {
      return (
        <SettingsRow
          stacked
          label={t('projectPages.memory.apiKey', { name: 'Google AI' })}
          description={
            <>
              {t('projectPages.memory.requiredFor', { name: 'Google AI' })}{' '}
              <KeyLink href="https://aistudio.google.com/apikey">{t('projectPages.memory.getKey', { name: 'Google AI Studio' })}</KeyLink>
            </>
          }
        >
          <SecretInput
            value={envConfig.memoryProviderConfig?.googleApiKey || ''}
            onChange={(value) => updateProviderConfig('google', { googleApiKey: value || undefined })}
            placeholder="AIzaSy..."
            {...secretProps('google', 'Google')}
          />
        </SettingsRow>
      );
    }

    // Azure OpenAI
    if (embeddingProvider === 'azure_openai') {
      return (
        <>
          <SettingsRow stacked label={t('projectPages.memory.apiKey', { name: 'Azure OpenAI' })}>
            <SecretInput
              value={envConfig.memoryProviderConfig?.azureOpenaiApiKey || ''}
              onChange={(value) => updateProviderConfig('azure_openai', { azureOpenaiApiKey: value || undefined })}
              placeholder={t('projectPages.memory.azureKeyPlaceholder')}
              {...secretProps('azure', 'Azure OpenAI')}
            />
          </SettingsRow>
          <SettingsRow stacked label={t('projectPages.memory.baseUrl')}>
            <Input
              placeholder="https://your-resource.openai.azure.com"
              value={envConfig.memoryProviderConfig?.azureOpenaiBaseUrl || ''}
              onChange={(e) => updateProviderConfig('azure_openai', { azureOpenaiBaseUrl: e.target.value || undefined })}
            />
          </SettingsRow>
          <SettingsRow stacked label={t('projectPages.memory.azureDeployment')}>
            <Input
              placeholder="text-embedding-ada-002"
              value={envConfig.memoryProviderConfig?.azureOpenaiEmbeddingDeployment || ''}
              onChange={(e) =>
                updateProviderConfig('azure_openai', { azureOpenaiEmbeddingDeployment: e.target.value || undefined })
              }
            />
          </SettingsRow>
        </>
      );
    }

    // Ollama (Local) - uses OllamaModelSelector component
    if (embeddingProvider === 'ollama') {
      return (
        <>
          <SettingsRow stacked label={t('projectPages.memory.baseUrl')}>
            <Input
              placeholder="http://localhost:11434"
              value={envConfig.memoryProviderConfig?.ollamaBaseUrl || 'http://localhost:11434'}
              onChange={(e) => updateProviderConfig('ollama', { ollamaBaseUrl: e.target.value })}
            />
          </SettingsRow>
          <SettingsRow stacked label={t('projectPages.memory.embeddingModel')}>
            <OllamaModelSelector
              selectedModel={envConfig.memoryProviderConfig?.ollamaEmbeddingModel || ''}
              baseUrl={envConfig.memoryProviderConfig?.ollamaBaseUrl}
              onModelSelect={handleOllamaModelSelect}
            />
          </SettingsRow>
        </>
      );
    }

    return null;
  };

  return (
    <>
      <SettingsSection title={t('projectSections.memory.title')}>
        <SettingsRows>
          <SettingsRow
            label={t('projectPages.memory.enable')}
            description={
              envConfig.memoryEnabled
                ? t('projectPages.memory.enableDescription')
                : t('projectPages.memory.fileBasedDescription')
            }
          >
            <Switch
              checked={envConfig.memoryEnabled}
              onCheckedChange={(checked) => {
                updateEnvConfig({ memoryEnabled: checked });
                setSettings({ ...settings, memoryBackend: checked ? 'memory' : 'file' });
              }}
              aria-label={t('projectPages.memory.enable')}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      {envConfig.memoryEnabled && (
        <>
          <SettingsSection title={t('projectPages.memory.embeddingsTitle')}>
            <SettingsRows>
              <SettingsRow
                label={t('projectPages.memory.provider')}
                description={t('projectPages.memory.providerDescription')}
              >
                <Select
                  value={embeddingProvider}
                  onValueChange={(value: MemoryEmbeddingProvider) => updateProviderConfig(value, {})}
                >
                  <SelectTrigger aria-label={t('projectPages.memory.provider')}>
                    <SelectValue placeholder={t('projectPages.memory.providerPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ollama">{t('projectPages.memory.providers.ollama')}</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="voyage">Voyage AI</SelectItem>
                    <SelectItem value="google">Google AI</SelectItem>
                    <SelectItem value="azure_openai">Azure OpenAI</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>

              {/* Provider-specific fields */}
              {renderProviderFields()}
            </SettingsRows>
          </SettingsSection>

          <SettingsSection title={t('projectPages.memory.storageTitle')}>
            <SettingsRows>
              <SettingsRow
                stacked
                label={t('projectPages.memory.databaseName')}
                description={t('projectPages.memory.databaseNameDescription')}
              >
                <Input
                  placeholder="auto_claude_memory"
                  value={envConfig.memoryDatabase || ''}
                  onChange={(e) => updateEnvConfig({ memoryDatabase: e.target.value })}
                />
              </SettingsRow>
              <SettingsRow
                stacked
                label={t('projectPages.memory.databasePath')}
                description={t('projectPages.memory.databasePathDescription')}
              >
                <Input
                  placeholder="~/.auto-claude/memories"
                  value={envConfig.memoryDbPath || ''}
                  onChange={(e) => updateEnvConfig({ memoryDbPath: e.target.value || undefined })}
                />
              </SettingsRow>
            </SettingsRows>
          </SettingsSection>
        </>
      )}
    </>
  );
}
