import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
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
} from './dialog-styles';

const FullScreenDialog = DialogPrimitive.Root;

const FullScreenDialogTrigger = DialogPrimitive.Trigger;

const FullScreenDialogPortal = DialogPrimitive.Portal;

const FullScreenDialogClose = DialogPrimitive.Close;

const FullScreenDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(DIALOG_OVERLAY_CLASS, className)}
    {...props}
  />
));
FullScreenDialogOverlay.displayName = 'FullScreenDialogOverlay';

const FullScreenDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const { t } = useTranslation('common');
  return (
  <FullScreenDialogPortal>
    <FullScreenDialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed inset-4 z-50 flex flex-col overflow-hidden',
        DIALOG_SURFACE_CLASS,
        DIALOG_ANIMATION_CLASS,
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className={DIALOG_CLOSE_BUTTON_CLASS} aria-label={t('close')}>
        <X className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </FullScreenDialogPortal>
  );
});
FullScreenDialogContent.displayName = 'FullScreenDialogContent';

const FullScreenDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // pr-14 keeps the title clear of the close button
    className={cn('flex flex-col gap-1 border-b border-border px-6 pb-4 pr-14 pt-6', className)}
    {...props}
  />
);
FullScreenDialogHeader.displayName = 'FullScreenDialogHeader';

const FullScreenDialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 overflow-hidden', className)} {...props} />
);
FullScreenDialogBody.displayName = 'FullScreenDialogBody';

const FullScreenDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex items-center justify-end gap-2', DIALOG_FOOTER_BAR_CLASS, className)}
    {...props}
  />
);
FullScreenDialogFooter.displayName = 'FullScreenDialogFooter';

const FullScreenDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(DIALOG_TITLE_CLASS, className)}
    {...props}
  />
));
FullScreenDialogTitle.displayName = 'FullScreenDialogTitle';

const FullScreenDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(DIALOG_DESCRIPTION_CLASS, className)}
    {...props}
  />
));
FullScreenDialogDescription.displayName = 'FullScreenDialogDescription';

export {
  FullScreenDialog,
  FullScreenDialogPortal,
  FullScreenDialogOverlay,
  FullScreenDialogClose,
  FullScreenDialogTrigger,
  FullScreenDialogContent,
  FullScreenDialogHeader,
  FullScreenDialogBody,
  FullScreenDialogFooter,
  FullScreenDialogTitle,
  FullScreenDialogDescription,
};
