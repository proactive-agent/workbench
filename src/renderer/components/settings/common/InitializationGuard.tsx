import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from '../SettingsSection';

interface InitializationGuardProps {
  initialized: boolean;
  /** Page title, shown as the section heading while the page is unavailable */
  title: string;
  description: string;
  children: ReactNode;
}

/**
 * Guard component that shows a message when Auto-Build is not initialized.
 * Used to prevent configuration of features that require Auto-Build setup.
 */
export function InitializationGuard({
  initialized,
  title,
  description: _description,
  children
}: InitializationGuardProps) {
  const { t } = useTranslation('settings');

  if (!initialized) {
    return (
      <SettingsSection title={title}>
        <p className="text-sm text-(--nav-label-color)">{t('projectPages.initializeFirst')}</p>
      </SettingsSection>
    );
  }

  return <>{children}</>;
}
