/**
 * AccountSettings - how Claude Code signs in
 *
 * claude.ai settings layout: Claude accounts (subscriptions, with usage) and API profiles
 * (Anthropic-compatible endpoints), then spending per project (Metrics).
 */
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { SettingsRows } from './SettingsRow';
import { ClaudeAccountsSection } from './ClaudeAccountsSection';
import { ProfileList } from './ProfileList';
import { ProjectMetricsSection } from './ProjectMetricsSection';
import type { AppSettings } from '../../../shared/types';

interface AccountSettingsProps {
  /** Kept for the page signature; accounts are stored by the main process, not in app settings */
  settings?: AppSettings;
  onSettingsChange?: (settings: AppSettings) => void;
  isOpen: boolean;
}

export function AccountSettings(_props: AccountSettingsProps) {
  const { t } = useTranslation('settings');

  return (
    <>
      {/* Claude subscriptions and API profiles (Anthropic-compatible endpoints) Claude Code signs in with */}
      <SettingsSection title={t('accounts.title')}>
        <SettingsRows>
          <ClaudeAccountsSection />
          <ProfileList />
        </SettingsRows>
      </SettingsSection>

      {/* Spending per project (all tasks' Claude Code run costs) */}
      <ProjectMetricsSection />
    </>
  );
}
