import { useTranslation } from 'react-i18next';

/**
 * Shows an empty state when no project is selected in settings.
 */
export function EmptyProjectState() {
  const { t } = useTranslation('settings');

  return <p className="text-sm text-(--nav-label-color)">{t('projectSettings.noProjectSelected.description')}</p>;
}
