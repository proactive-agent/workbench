import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { getSentAttachmentDataUrl } from '../stores/insights-store';
import type { ImageAttachment } from '../../shared/types';

interface AttachmentPreviewDialogProps {
  projectId: string;
  /** Image to preview; null closes the dialog */
  attachment: ImageAttachment | null;
  onClose: () => void;
}

/**
 * Full-size preview of an image attachment, before or after the message is sent.
 * Source order: in-memory data (pending) → recently sent cache → stored file → thumbnail.
 */
export function AttachmentPreviewDialog({ projectId, attachment, onClose }: AttachmentPreviewDialogProps) {
  const { t } = useTranslation('common');
  const [src, setSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!attachment) {
      setSrc(null);
      return;
    }

    const immediate = attachment.data
      ? `data:${attachment.mimeType};base64,${attachment.data}`
      : getSentAttachmentDataUrl(attachment.id);
    if (immediate) {
      setSrc(immediate);
      setIsLoading(false);
      return;
    }

    // Show the thumbnail right away, then swap in the stored full-size file
    setSrc(attachment.thumbnail ?? null);
    if (!attachment.path) return;

    let cancelled = false;
    setIsLoading(true);
    window.electronAPI
      .getInsightsAttachment(projectId, attachment.path, attachment.mimeType)
      .then((result) => {
        if (!cancelled && result.success && result.data) setSrc(result.data);
      })
      .catch(() => {
        // Keep the thumbnail when the stored file can't be read
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, projectId]);

  return (
    <Dialog open={attachment !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Frameless: just the image and its name; closes on outside click or Escape */}
      <DialogContent
        hideCloseButton
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex w-auto max-w-[90vw] flex-col items-center gap-3 overflow-visible rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]"
      >
        <DialogTitle className="sr-only">{t('insights.attachments.previewTitle')}</DialogTitle>
        <DialogDescription className="sr-only">{attachment?.filename}</DialogDescription>
        <div className="relative flex h-[50vh] min-w-24 items-center justify-center">
          {src && (
            <img
              src={src}
              alt={attachment?.filename ?? ''}
              className="h-[50vh] w-auto max-w-[90vw] rounded-lg object-contain"
            />
          )}
          {isLoading && (
            <Loader2 className="absolute h-5 w-5 animate-spin text-white/70" aria-label={t('insights.attachments.loadingPreview')} />
          )}
        </div>
        <p className="max-w-[90vw] truncate text-sm text-white/90">{attachment?.filename}</p>
      </DialogContent>
    </Dialog>
  );
}
