import { useTranslation } from 'react-i18next';
import { ImageIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import type { ImageAttachment } from '../../../shared/types';

interface ImagePreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  image: ImageAttachment | null;
}

/**
 * Full-size preview of a task image, in the same frameless style as the Insights
 * attachment preview: just the image and its name; closes on outside click or Escape.
 */
export function ImagePreviewModal({ open, onOpenChange, image }: ImagePreviewModalProps) {
  const { t } = useTranslation(['tasks']);

  if (!image) return null;

  // Prefer full-resolution data for the enlarged preview, fall back to the thumbnail
  const imageSrc = image.data ? `data:${image.mimeType};base64,${image.data}` : image.thumbnail || null;
  const isThumbnailFallback = !image.data && !!image.thumbnail;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex w-auto max-w-[90vw] flex-col items-center gap-3 overflow-visible rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]"
      >
        <DialogTitle className="sr-only">{image.filename}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('tasks:imagePreview.description', { filename: image.filename })}
        </DialogDescription>
        <div className="relative flex h-[50vh] min-w-24 items-center justify-center">
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={image.filename}
              className="h-[50vh] w-auto max-w-[90vw] rounded-lg object-contain"
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-white/60">
              <ImageIcon className="mb-3 h-16 w-16" strokeWidth={1.5} />
              <p className="text-sm">{t('tasks:imagePreview.unavailable')}</p>
            </div>
          )}
        </div>
        <p className="max-w-[90vw] truncate text-sm text-white/90">{image.filename}</p>
        {isThumbnailFallback && (
          <p className="text-xs text-white/60">{t('tasks:imagePreview.lowResolution')}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
