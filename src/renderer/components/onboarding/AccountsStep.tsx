import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { Button } from '../ui/button';
import { ProviderAccountsList } from '../settings/ProviderAccountsList';

interface AccountsStepProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

/**
 * AccountsStep component for the onboarding wizard.
 *
 * Replaces the old AuthChoiceStep + OAuthStep two-step flow with a single
 * step that reuses the ProviderAccountsList from settings. Users can add
 * accounts from any supported provider (Anthropic, OpenAI, Google, etc.).
 *
 * Layout: The header and action buttons are pinned (always visible), while
 * the provider list scrolls independently. This prevents the "Continue"
 * button from being hidden below the fold on smaller screens.
 */
export function AccountsStep({ onNext, onBack, onSkip }: AccountsStepProps) {
  const { t } = useTranslation('onboarding');

  return (
    <div className="flex h-full flex-col items-center px-8 py-6">
      <div className="w-full max-w-2xl flex flex-col min-h-0 h-full">
        {/* Header — pinned at top */}
        <div className="text-center mb-6 flex-shrink-0">
          <div className="flex justify-center mb-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Users className="h-6 w-6 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {t('accounts.title')}
          </h1>
          <p className="mt-2 text-muted-foreground text-base">
            {t('accounts.description')}
          </p>
        </div>

        {/* Provider accounts list — scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-card/50 p-4">
          <ProviderAccountsList />
        </div>

        {/* Action Buttons — pinned at bottom, always visible */}
        <div className="flex justify-between items-center mt-4 pt-4 border-t border-border flex-shrink-0">
          <Button
            variant="ghost"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground"
          >
            {t('accounts.buttons.back')}
          </Button>
          <div className="flex gap-4">
            <Button
              variant="ghost"
              onClick={onSkip}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('accounts.buttons.skip')}
            </Button>
            <Button onClick={onNext}>
              {t('accounts.buttons.continue')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
