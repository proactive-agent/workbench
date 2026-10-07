/**
 * TaskModalLayout - Shared layout component for large task modals
 *
 * Provides consistent styling matching TaskDetailModal exactly:
 * - Full-height modal (95vw width, near full height)
 * - Positioned 16px from top (same as TaskDetailModal)
 * - Header with title, description, and close button
 * - Scrollable body content
 * - Footer with action buttons
 */
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  DIALOG_ANIMATION_CLASS,
  DIALOG_CLOSE_BUTTON_CLASS,
  DIALOG_CLOSE_ICON_CLASS,
  DIALOG_CLOSE_ICON_STROKE,
  DIALOG_DESCRIPTION_CLASS,
  DIALOG_FOOTER_BAR_CLASS,
  DIALOG_OVERLAY_CLASS,
  DIALOG_SURFACE_CLASS,
  DIALOG_TITLE_CLASS
} from '../ui/dialog-styles';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import type { ReactNode } from 'react';

interface TaskModalLayoutProps {
  /** Whether the modal is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Modal title */
  title: string;
  /** Modal description */
  description?: string;
  /** Main content of the modal */
  children: ReactNode;
  /** Footer content (action buttons) */
  footer: ReactNode;
  /** Whether the modal is in a loading/disabled state */
  disabled?: boolean;
}

export function TaskModalLayout({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  disabled = false
}: TaskModalLayoutProps) {
  const { t } = useTranslation('common');

  const handleClose = () => {
    if (!disabled) {
      onOpenChange(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleClose}>
      <DialogPrimitive.Portal>
        {/* Semi-transparent overlay */}
        <DialogPrimitive.Overlay className={DIALOG_OVERLAY_CLASS} />

        {/* Full-height modal content - matches TaskDetailModal exactly */}
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50',
            '-translate-x-1/2 -translate-y-1/2',
            // Same size as the opened task dialog
            'w-[min(760px,calc(100vw-2rem))] h-[min(600px,calc(100vh-2rem))]',
            'overflow-hidden flex flex-col',
            DIALOG_SURFACE_CLASS,
            DIALOG_ANIMATION_CLASS
          )}
        >
          <div className="flex h-full min-h-0 overflow-hidden">
            {/* Main content area */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
              {/* Header */}
              <div className="relative shrink-0 border-b border-border px-6 pb-4 pr-14 pt-6">
                <DialogPrimitive.Title className={DIALOG_TITLE_CLASS}>
                  {title}
                </DialogPrimitive.Title>
                {description && (
                  <DialogPrimitive.Description className={cn('mt-1', DIALOG_DESCRIPTION_CLASS)}>
                    {description}
                  </DialogPrimitive.Description>
                )}
                <DialogPrimitive.Close
                  className={DIALOG_CLOSE_BUTTON_CLASS}
                  disabled={disabled}
                  aria-label={t('buttons.close')}
                >
                  <X className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                </DialogPrimitive.Close>
              </div>

              {/* Scrollable body */}
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-6">
                  {children}
                </div>
              </ScrollArea>

              {/* Footer */}
              <div className={cn('shrink-0', DIALOG_FOOTER_BAR_CLASS)}>
                {footer}
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
