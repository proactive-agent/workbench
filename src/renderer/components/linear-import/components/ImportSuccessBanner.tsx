/**
 * Success banner shown after successful import
 */

import { CheckCircle2 } from 'lucide-react';
import { Button } from '../../ui/button';
import type { LinearImportResult } from '../types';

interface ImportSuccessBannerProps {
  importResult: LinearImportResult;
  onClose: () => void;
}

export function ImportSuccessBanner({ importResult, onClose }: ImportSuccessBannerProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm">
      <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-foreground">
          Successfully imported {importResult.imported} task{importResult.imported !== 1 ? 's' : ''}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Tasks are being processed. Check your Kanban board for progress.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
