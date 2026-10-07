import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { ProviderAccountCard } from './ProviderAccountCard';
import { OllamaConnectionPanel } from './OllamaConnectionPanel';
import type { BillingModel, BuiltinProvider, ProviderAccount, ProviderInfo } from '@shared/types/provider-account';

interface ProviderSectionProps {
  provider: ProviderInfo;
  accounts: ProviderAccount[];
  envDetected: boolean;
  onAddAccount: (provider: BuiltinProvider, authType: 'oauth' | 'api-key', billingModel?: BillingModel) => void;
  onEditAccount: (account: ProviderAccount) => void;
  onDeleteAccount: (id: string) => void;
  onReauthAccount?: (account: ProviderAccount) => void;
}

/**
 * A provider row (claude.ai settings style): name + muted description on the left, account
 * count and an expand chevron on the right. Expanding reveals the connected accounts and the
 * add-account actions.
 */
export function ProviderSection({
  provider,
  accounts,
  envDetected,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onReauthAccount,
}: ProviderSectionProps) {
  const { t } = useTranslation('settings');
  const [isOpen, setIsOpen] = useState(accounts.length > 0);

  const hasOAuth = provider.authMethods.includes('oauth');
  const hasApiKey = provider.authMethods.includes('api-key');
  const isOllamaLike = provider.authMethods.length === 0 || (provider.authMethods.length === 0 && provider.configFields.includes('baseUrl'));
  const canAdd = hasOAuth || hasApiKey || isOllamaLike;
  const contentId = `provider-${provider.id}-accounts`;

  const accountList = accounts.length > 0 && (
    <div className="rounded-xl border border-border px-4 [&>*+*]:border-t [&>*+*]:border-settings-divider">
      {accounts.map((account) => (
        <ProviderAccountCard
          key={account.id}
          account={account}
          onEdit={onEditAccount}
          onDelete={onDeleteAccount}
          onReauth={onReauthAccount}
        />
      ))}
    </div>
  );

  return (
    <div>
      {/* Row header */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={contentId}
        className="group flex w-full items-center justify-between gap-7 rounded-lg py-3 text-left outline-none focus-visible:shadow-(--shadow-focus)"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm text-foreground">{provider.name}</span>
          <span className="text-sm text-(--nav-label-color)">{provider.description}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm text-(--nav-label-color)">
          {accounts.length > 0 ? (
            <span>{t('providers.section.accountCount', { count: accounts.length })}</span>
          ) : (
            envDetected && <span>{t('providers.section.envDetected')}</span>
          )}
          <ChevronDown
            className={cn(
              'h-4 w-4 transition-transform duration-150 group-hover:text-foreground',
              isOpen && 'rotate-180'
            )}
            strokeWidth={1.75}
          />
        </div>
      </button>

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pb-4">
              {provider.id === 'ollama' ? (
                <>
                  {accountList}
                  {/* Ollama connection panel handles its own empty state and auto-creation */}
                  <OllamaConnectionPanel accounts={accounts} />
                </>
              ) : (
                <>
                  {accountList}

                  {accounts.length === 0 && (
                    <p className="text-sm text-(--nav-label-color)">
                      {envDetected
                        ? t('providers.section.envCredentialDetected', { envVar: provider.envVars[0] })
                        : t('providers.section.noAccounts')}
                    </p>
                  )}

                  {/* Add buttons */}
                  {canAdd && (
                    <div className="flex flex-wrap items-center gap-2">
                      {hasOAuth && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAddAccount(provider.id, 'oauth')}
                          className="gap-1.5"
                        >
                          <Plus className="h-4 w-4" strokeWidth={1.75} />
                          {provider.id === 'openai'
                            ? t('providers.section.addCodexSubscription')
                            : provider.id === 'anthropic'
                              ? t('providers.section.addClaudeCode')
                              : t('providers.section.addOAuth')}
                        </Button>
                      )}
                      {/* Z.AI: Coding Plan subscription button before generic API Key */}
                      {provider.id === 'zai' && hasApiKey && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAddAccount(provider.id, 'api-key', 'subscription')}
                          className="gap-1.5"
                        >
                          <Plus className="h-4 w-4" strokeWidth={1.75} />
                          {t('providers.section.addCodingPlan')}
                        </Button>
                      )}
                      {hasApiKey && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAddAccount(provider.id, 'api-key')}
                          className="gap-1.5"
                        >
                          <Plus className="h-4 w-4" strokeWidth={1.75} />
                          {provider.id === 'zai'
                            ? t('providers.section.addUsageBased')
                            : t('providers.section.addApiKey')}
                        </Button>
                      )}
                      {/* No-key providers with baseUrl (non-Ollama) */}
                      {!hasOAuth && !hasApiKey && provider.configFields.includes('baseUrl') && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAddAccount(provider.id, 'api-key')}
                          className="gap-1.5"
                        >
                          <Plus className="h-4 w-4" strokeWidth={1.75} />
                          {t('providers.section.addEndpoint')}
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
