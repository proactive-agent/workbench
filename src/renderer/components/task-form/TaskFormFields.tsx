/**
 * TaskFormFields - Shared form fields component for task create/edit
 *
 * Bundles the common form fields used in both TaskCreationWizard and TaskEditDialog:
 * - Description: a composer like the Claude page's (Insights) input, with image thumbnails,
 *   a paperclip button to attach images, paste (Ctrl/Cmd+V) and drag and drop
 * - Connectors (MCP servers for the task's Claude Code session)
 *
 * Model, effort and planning are decided per task by the Claude Code triage run.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { SettingsSection } from '../settings/SettingsSection';
import { useImageUpload } from './useImageUpload';
import { ImagePreviewModal } from './ImagePreviewModal';
import { cn } from '../../lib/utils';
import { TaskConnectorRows } from './TaskConnectorRows';
import type { ImageAttachment } from '../../../shared/types';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';
import { AttachmentTile } from './AttachmentTile';
import { useAttachmentThumbnails } from './useAttachmentThumbnails';

interface TaskFormFieldsProps {
  // Project context (for loading image thumbnails from disk)
  projectPath?: string;
  specId?: string;

  // Description field
  description: string;
  onDescriptionChange: (value: string) => void;
  descriptionPlaceholder?: string;

  // Images
  images: ImageAttachment[];
  onImagesChange: (images: ImageAttachment[]) => void;

  // MCP connectors for this task (ids); the rows show when a change handler is given
  mcpConnectors?: string[];
  onMcpConnectorsChange?: (value: string[]) => void;
  /** The Puppeteer connector's browser profile picked for the task (undefined follows Settings) */
  puppeteerBrowser?: PuppeteerBrowserChoice | null;
  onPuppeteerBrowserChange?: (choice: PuppeteerBrowserChoice | null) => void;

  // Form state
  disabled?: boolean;
  error?: string | null;
  onError?: (error: string | null) => void;

  // ID prefix for accessibility
  idPrefix?: string;

  /** Optional extra sections rendered after the built-in ones, before the error (e.g., Git options) */
  extraSections?: ReactNode;
}

export function TaskFormFields({
  projectPath,
  specId,
  description,
  onDescriptionChange,
  descriptionPlaceholder,
  images,
  onImagesChange,
  mcpConnectors = [],
  onMcpConnectorsChange,
  puppeteerBrowser,
  onPuppeteerBrowserChange,
  disabled = false,
  error,
  onError,
  idPrefix = '',
  extraSections
}: TaskFormFieldsProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const prefix = idPrefix ? `${idPrefix}-` : '';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);

  // Saved attachments have no thumbnail: loaded from the task folder for display only
  const thumbnails = useAttachmentThumbnails(projectPath, specId, images);

  // Use the shared image upload hook with translated error messages
  const {
    isDragOver,
    pasteSuccess,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    addFiles,
    removeImage,
    canAddMore
  } = useImageUpload({
    images,
    onImagesChange,
    disabled,
    // Any kind of file can be attached: images as thumbnails, other files by name
    acceptAllFiles: true,
    onError,
    errorMessages: {
      maxImagesReached: t('tasks:form.errors.maxImagesReached'),
      invalidImageType: t('tasks:form.errors.invalidImageType'),
      processPasteFailed: t('tasks:form.errors.processPasteFailed'),
      processDropFailed: t('tasks:form.errors.processDropFailed')
    }
  });

  return (
    <>
      <ImagePreviewModal
        open={previewImage !== null}
        onOpenChange={(open) => !open && setPreviewImage(null)}
        image={previewImage}
      />

      <div>
        <div className="mb-10 space-y-6 last:mb-0">
          {/* Description (required): composer with attachments, like the Claude page's input */}
          <div className="space-y-2">
            <div
              className={cn(
                'relative rounded-(--radius-composer) bg-settings-surface',
                'shadow-[0_4px_20px_rgba(0,0,0,0.075),0_0_0_1px_var(--input)]',
                'transition-shadow duration-150 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.1),0_0_0_1px_var(--input)]'
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Attachments */}
              {images.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
                  {images.map((image) => (
                    <div key={image.id} className="group relative" title={image.filename}>
                      <AttachmentTile attachment={image} thumbnail={thumbnails[image.id]} onPreview={setPreviewImage} />
                      {/* Remove button centered on the thumbnail's top-right corner */}
                      {!disabled && (
                        <button
                          type="button"
                          onClick={() => removeImage(image.id)}
                          className="absolute right-0 top-0 flex h-4 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                          title={t('images.removeImageAriaLabel', { filename: image.filename })}
                          aria-label={t('images.removeImageAriaLabel', { filename: image.filename })}
                        >
                          <X className="h-2.5 w-2.5" strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="relative">
                <textarea
                  ref={descriptionRef}
                  id={`${prefix}description`}
                  placeholder={descriptionPlaceholder || t('tasks:form.descriptionPlaceholder')}
                  value={description}
                  onChange={(e) => onDescriptionChange(e.target.value)}
                  onPaste={handlePaste}
                  rows={5}
                  disabled={disabled}
                  aria-required="true"
                  aria-label={t('tasks:form.description')}
                  className={cn(
                    'relative block max-h-96 min-h-[7.5rem] w-full resize-none overflow-y-auto border-0 bg-transparent',
                    'px-4 pt-4 pb-1 text-[0.9375rem] leading-relaxed',
                    'text-foreground placeholder:text-(--field-placeholder)',
                    'focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'
                  )}
                />
              </div>

              {/* Toolbar: attach images */}
              <div className="flex items-center px-2.5 pb-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length > 0) void addFiles(files);
                  }}
                />
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || !canAddMore}
                  title={t('tasks:form.attachFiles')}
                  aria-label={t('tasks:form.attachFiles')}
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              </div>

              {/* Drag-over overlay */}
              {isDragOver && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-(--radius-composer) border-2 border-dashed border-primary bg-primary/5">
                  <span className="text-sm font-medium text-primary">{t('tasks:form.dropToAttach')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Paste Success Indicator */}
          {pasteSuccess && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in slide-in-from-top-1 duration-200">
              <ImageIcon className="h-4 w-4 text-success" strokeWidth={1.75} />
              {t('tasks:form.imageAddedSuccess')}
            </div>
          )}
        </div>

        {/* MCP connectors for the task's Claude Code session */}
        {onMcpConnectorsChange && (
          <SettingsSection title={t('tasks:form.sections.connectors')}>
            <TaskConnectorRows
              value={mcpConnectors}
              onChange={onMcpConnectorsChange}
              puppeteerBrowser={puppeteerBrowser}
              onPuppeteerBrowserChange={onPuppeteerBrowserChange}
              disabled={disabled}
              idPrefix={prefix}
            />
          </SettingsSection>
        )}

        {/* Extra sections from the parent (e.g., Git options in the creation wizard) */}
        {extraSections}

        {/* Error Display */}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
