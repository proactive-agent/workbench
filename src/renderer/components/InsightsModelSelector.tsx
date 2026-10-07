import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './ui/dropdown-menu';
import { cn } from '../lib/utils';
import { DEFAULT_AGENT_PROFILES, AVAILABLE_MODELS, THINKING_LEVELS } from '../../shared/constants';
import type { InsightsModelConfig } from '../../shared/types';
import { CustomModelModal } from './CustomModelModal';

interface InsightsModelSelectorProps {
  currentConfig?: InsightsModelConfig;
  onConfigChange: (config: InsightsModelConfig) => void;
  disabled?: boolean;
}

type ThinkingLevel = InsightsModelConfig['thinkingLevel'];

/** Models listed at the top of the menu (claude.ai style); the rest live under "More models" */
const PRIMARY_MODELS = ['opus', 'sonnet', 'haiku'] as const;

const menuItemClass = 'cursor-pointer rounded-lg px-3 py-2 focus:bg-nav-hover data-[highlighted]:bg-nav-hover';

/** "Claude Opus 4.6" → "Opus 4.6", the way claude.ai labels its models */
function shortModelLabel(model: string): string {
  const label = AVAILABLE_MODELS.find((m) => m.value === model)?.label ?? model;
  return label.replace(/^Claude\s+/, '');
}

export function InsightsModelSelector({
  currentConfig,
  onConfigChange,
  disabled
}: InsightsModelSelectorProps) {
  const { t } = useTranslation('common');
  const [showCustomModal, setShowCustomModal] = useState(false);

  // Resolve the effective model/effort: an explicit config wins, otherwise the Balanced profile
  const balanced = DEFAULT_AGENT_PROFILES.find((p) => p.id === 'balanced');
  const profile = DEFAULT_AGENT_PROFILES.find((p) => p.id === currentConfig?.profileId && p.id !== 'auto');
  const activeModel: string = currentConfig?.model ?? profile?.model ?? balanced?.model ?? 'sonnet';
  const activeThinking: ThinkingLevel = currentConfig?.thinkingLevel ?? profile?.thinkingLevel ?? balanced?.thinkingLevel ?? 'medium';

  const isKnownModel = AVAILABLE_MODELS.some((m) => m.value === activeModel);
  const moreModels = AVAILABLE_MODELS.filter((m) => !(PRIMARY_MODELS as readonly string[]).includes(m.value));

  const select = (model: string, thinkingLevel: ThinkingLevel) => {
    onConfigChange({ profileId: 'custom', model: model as InsightsModelConfig['model'], thinkingLevel });
  };

  const effortLabel = (level: ThinkingLevel) => t(`insights.model.effortLevels.${level}`);

  const renderCheck = (selected: boolean) =>
    selected ? <Check className="ml-3 h-4 w-4 shrink-0 text-(--menu-check)" strokeWidth={2} /> : <span className="ml-3 w-4 shrink-0" />;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-nav-hover focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-nav-hover"
            disabled={disabled}
            title={t('insights.model.title', { name: `${shortModelLabel(activeModel)} · ${effortLabel(activeThinking)}` })}
          >
            <span className="truncate">{shortModelLabel(activeModel)}</span>
            <span className="truncate text-muted-foreground">{effortLabel(activeThinking)}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={6} className="w-80 rounded-xl p-1.5">
          {PRIMARY_MODELS.map((model) => (
            <DropdownMenuItem
              key={model}
              onSelect={() => select(model, activeThinking)}
              className={cn(menuItemClass, 'flex items-center')}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground">{shortModelLabel(model)}</div>
                <div className="text-[0.8125rem] text-muted-foreground">{t(`insights.model.descriptions.${model}`)}</div>
              </div>
              {renderCheck(activeModel === model)}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator className="mx-2 my-1.5" />

          {/* Effort (thinking level) */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn(menuItemClass, 'flex h-10 items-center text-sm')}>
              <span className="flex-1">{t('insights.model.effort')}</span>
              <span className="mr-1 text-muted-foreground">{effortLabel(activeThinking)}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent sideOffset={6} className="w-56 rounded-xl p-1.5">
              {THINKING_LEVELS.map((level) => (
                <DropdownMenuItem
                  key={level.value}
                  onSelect={() => select(activeModel, level.value)}
                  className={cn(menuItemClass, 'flex items-center')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground">{effortLabel(level.value)}</div>
                    <div className="text-[0.8125rem] text-muted-foreground">{t(`insights.model.effortDescriptions.${level.value}`)}</div>
                  </div>
                  {renderCheck(activeThinking === level.value)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator className="mx-2 my-1.5" />

          {/* Other Claude models and the custom (multi-provider) picker */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn(menuItemClass, 'flex h-10 items-center text-sm')}>
              <span className="flex-1">{t('insights.model.moreModels')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent sideOffset={6} className="w-64 rounded-xl p-1.5">
              {moreModels.map((model) => (
                <DropdownMenuItem
                  key={model.value}
                  onSelect={() => select(model.value, activeThinking)}
                  className={cn(menuItemClass, 'flex items-center text-sm')}
                >
                  <span className="min-w-0 flex-1 truncate">{shortModelLabel(model.value)}</span>
                  {renderCheck(activeModel === model.value)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="mx-2 my-1.5" />
              <DropdownMenuItem
                onSelect={() => setShowCustomModal(true)}
                className={cn(menuItemClass, 'flex items-center')}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">{t('insights.model.custom')}</div>
                  <div className="text-[0.8125rem] text-muted-foreground">{t('insights.model.customDescription')}</div>
                </div>
                {renderCheck(!isKnownModel)}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <CustomModelModal
        open={showCustomModal}
        currentConfig={currentConfig}
        onSave={(config) => {
          onConfigChange(config);
          setShowCustomModal(false);
        }}
        onClose={() => setShowCustomModal(false)}
      />
    </>
  );
}
