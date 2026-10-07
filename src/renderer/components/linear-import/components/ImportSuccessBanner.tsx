/**
 * Success banner shown after successful import
 */

import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import type { LinearImportResult } from '../types';

interface ImportSuccessBannerProps {
  importResult: LinearImportResult;
  onClose: () => void;
}

export function ImportSuccessBanner({ importResult, onClose }: ImportSuccessBannerProps) {
  const { t } = useTranslation(['dialogs', 'common']);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-segment-track px-4 py-3 text-sm">
      <Check className="h-4 w-4 text-success shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-foreground">
          {t('dialogs:linearImport.importedCount', { count: importResult.imported })}
        </p>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('dialogs:linearImport.importedDescription')}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onClose}>
        {t('common:buttons.close')}
      </Button>
    </div>
  );
}
