/**
 * TaskFormFields - Shared form fields component for task create/edit
 *
 * Bundles the common form fields used in both TaskCreationWizard and TaskEditDialog:
 * - Description (required, with image paste/drop support)
 * - Reference images (clickable drop zone, Insights-style thumbnails)
 * - Title (optional)
 * - Agent profile selector
 * - Classification fields
 * - Review requirement checkbox
 */
import { useRef, useState, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, ImagePlus, X, Zap, Info } from 'lucide-react';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { Switch } from '../ui/switch';
import { AgentProfileSelector } from '../AgentProfileSelector';
import { ClassificationFields } from './ClassificationFields';
import { useImageUpload } from './useImageUpload';
import { ImagePreviewModal } from './ImagePreviewModal';
import { cn } from '../../lib/utils';
import type {
  TaskCategory,
  TaskPriority,
  TaskComplexity,
  TaskImpact,
  ImageAttachment,
  ModelType,
  ThinkingLevel
} from '../../../shared/types';
import type { PhaseModelConfig, PhaseThinkingConfig } from '../../../shared/types/settings';

interface TaskFormFieldsProps {
  // Project context (for loading image thumbnails from disk)
  projectPath?: string;
  specId?: string;

  // Description field
  description: string;
  onDescriptionChange: (value: string) => void;
  descriptionPlaceholder?: string;
  /** Optional custom content to render inside the description field (e.g., autocomplete popup) */
  descriptionOverlay?: ReactNode;
  /** Optional ref for the description textarea (used for @ mention autocomplete positioning) */
  descriptionRef?: React.RefObject<HTMLTextAreaElement | null>;

  // Title field
  title: string;
  onTitleChange: (value: string) => void;

  // Agent profile
  profileId: string;
  model: ModelType | '';
  thinkingLevel: ThinkingLevel | '';
  phaseModels?: PhaseModelConfig;
  phaseThinking?: PhaseThinkingConfig;
  onProfileChange: (profileId: string, model: ModelType | '', thinkingLevel: ThinkingLevel | '') => void;
  onModelChange: (model: ModelType | '') => void;
  onThinkingLevelChange: (level: ThinkingLevel | '') => void;
  onPhaseModelsChange: (config: PhaseModelConfig | undefined) => void;
  onPhaseThinkingChange: (config: PhaseThinkingConfig | undefined) => void;

  // Classification
  category: TaskCategory | '';
  priority: TaskPriority | '';
  complexity: TaskComplexity | '';
  impact: TaskImpact | '';
  onCategoryChange: (value: TaskCategory | '') => void;
  onPriorityChange: (value: TaskPriority | '') => void;
  onComplexityChange: (value: TaskComplexity | '') => void;
  onImpactChange: (value: TaskImpact | '') => void;

  // Images
  images: ImageAttachment[];
  onImagesChange: (images: ImageAttachment[]) => void;

  // Review requirement
  requireReviewBeforeCoding: boolean;
  onRequireReviewChange: (require: boolean) => void;

  // Fast mode
  fastMode?: boolean;
  onFastModeChange?: (value: boolean) => void;
  showFastModeToggle?: boolean;

  // Form state
  disabled?: boolean;
  error?: string | null;
  onError?: (error: string | null) => void;

  // ID prefix for accessibility
  idPrefix?: string;

  /** Optional children to render after description (e.g., @ mention highlight overlay) */
  children?: ReactNode;
}

export function TaskFormFields({
  projectPath,
  specId,
  description,
  onDescriptionChange,
  descriptionPlaceholder,
  descriptionOverlay,
  descriptionRef: externalDescriptionRef,
  title,
  onTitleChange,
  profileId,
  model,
  thinkingLevel,
  phaseModels,
  phaseThinking,
  onProfileChange,
  onModelChange,
  onThinkingLevelChange,
  onPhaseModelsChange,
  onPhaseThinkingChange,
  category,
  priority,
  complexity,
  impact,
  onCategoryChange,
  onPriorityChange,
  onComplexityChange,
  onImpactChange,
  images,
  onImagesChange,
  requireReviewBeforeCoding,
  onRequireReviewChange,
  fastMode = false,
  onFastModeChange,
  showFastModeToggle = false,
  disabled = false,
  error,
  onError,
  idPrefix = '',
  children
}: TaskFormFieldsProps) {
  const { t } = useTranslation(['tasks', 'common']);
  // Use external ref if provided (for @ mention autocomplete), otherwise use internal ref
  const internalDescriptionRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = externalDescriptionRef || internalDescriptionRef;
  const prefix = idPrefix ? `${idPrefix}-` : '';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);

  // Track images we've attempted to load thumbnails for to prevent infinite loops
  // Note: Failed thumbnail loads are not retried (persists across re-renders)
  // This prevents repeated failed IPC calls for missing/corrupt images
  const loadedThumbnailsRef = useRef<Set<string>>(new Set());

  // Track the latest images to avoid stale closure issues
  const imagesRef = useRef<ImageAttachment[]>(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // Load thumbnails for images that have path but no thumbnail (fix placeholder bug)
  // This handles the case when TaskFormFields mounts with persisted images from disk
  useEffect(() => {
    let cancelled = false;

    const loadMissingThumbnails = async () => {
      // Need project context to load images from disk
      if (!projectPath || !specId) return;

      // Find images that have path but no thumbnail and haven't been attempted yet
      const imagesToLoad = images.filter(
        img => img.path && !img.thumbnail && !loadedThumbnailsRef.current.has(img.id)
      );

      if (imagesToLoad.length === 0) return;

      // Mark these as attempted before loading to prevent re-entry
      imagesToLoad.forEach(img => loadedThumbnailsRef.current.add(img.id));

      // Collect loaded thumbnails into a Map to avoid stale closure issues
      const thumbnailMap = new Map<string, string>();

      for (const image of imagesToLoad) {
        try {
          const result = await window.electronAPI.loadImageThumbnail(projectPath, specId, image.path!);
          if (result.success && result.data) {
            thumbnailMap.set(image.id, result.data);
          }
        } catch (error) {
          // Log for debugging but don't block other images
          console.debug('Failed to load thumbnail for image', image.id, error);
        }
      }

      // Merge thumbnails into current state without overwriting user changes
      if (thumbnailMap.size > 0 && !cancelled) {
        const updatedImages = imagesRef.current.map(img => ({
          ...img,
          thumbnail: thumbnailMap.get(img.id) ?? img.thumbnail
        }));
        onImagesChange(updatedImages);
      }
    };

    loadMissingThumbnails();

    return () => {
      cancelled = true;
    };
  }, [images, onImagesChange, projectPath, specId]);

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

      <div className="space-y-6">
        {/* Description (Primary - Required) */}
        <div className="space-y-2">
          <Label htmlFor={`${prefix}description`} className="text-sm font-medium text-foreground">
            {t('tasks:form.description')} <span className="text-destructive">*</span>
          </Label>
          <div className="relative">
            {/* Optional overlay (e.g., @ mention highlighting) */}
            {descriptionOverlay}
            <Textarea
              ref={descriptionRef}
              id={`${prefix}description`}
              placeholder={descriptionPlaceholder || t('tasks:form.descriptionPlaceholder')}
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              onPaste={handlePaste}
              // Drag and drop is disabled on the description; images go through the drop zone below
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'none';
              }}
              onDrop={(e) => e.preventDefault()}
              rows={6}
              disabled={disabled}
              aria-required="true"
              aria-describedby={`${prefix}description-help`}
              className={cn(
                'resize-y min-h-[150px] max-h-[400px] relative',
                descriptionOverlay && 'bg-transparent'
              )}
              style={descriptionOverlay ? { caretColor: 'auto' } : undefined}
            />
          </div>
          <p id={`${prefix}description-help`} className="text-xs text-muted-foreground">
            {t('images.pasteHint', { shortcut: navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+V' })}
          </p>

          {/* Optional children (e.g., @ mention autocomplete) */}
          {children}
        </div>

        {/* Paste Success Indicator */}
        {pasteSuccess && (
          <div className="flex items-center gap-2 text-sm text-success animate-in fade-in slide-in-from-top-1 duration-200">
            <ImageIcon className="h-4 w-4" />
            {t('tasks:form.imageAddedSuccess')}
          </div>
        )}

        {/* Reference Images */}
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            {t('tasks:referenceImages.title')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('tasks:referenceImages.description')}
          </p>

          {/* Thumbnails (same look as the Insights composer attachments) */}
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 pt-2">
              {images.map((image) => (
                <div key={image.id} className="group relative" title={image.filename}>
                  <button
                    type="button"
                    onClick={() => setPreviewImage(image)}
                    className="block h-14 w-14 cursor-zoom-in overflow-hidden rounded-lg border border-border focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
                    aria-label={t('tasks:referenceImages.preview', { filename: image.filename })}
                  >
                    {image.thumbnail ? (
                      <img src={image.thumbnail} alt={image.filename} className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center bg-muted">
                        <ImageIcon className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
                      </span>
                    )}
                  </button>
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

          {/* Drop zone: drag images here or click to pick files */}
          {canAddMore && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
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
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                disabled={disabled}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-5',
                  'text-sm text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground',
                  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none disabled:opacity-50',
                  isDragOver && 'border-primary bg-primary/5 text-foreground'
                )}
              >
                <ImagePlus className="h-4 w-4" strokeWidth={1.75} />
                {t('tasks:referenceImages.dropZone')}
              </button>
            </>
          )}
        </div>

        {/* Title (Optional) */}
        <div className="space-y-2">
          <Label htmlFor={`${prefix}title`} className="text-sm font-medium text-foreground">
            {t('tasks:form.taskTitle')} <span className="text-muted-foreground font-normal">({t('common:labels.optional')})</span>
          </Label>
          <Input
            id={`${prefix}title`}
            placeholder={t('tasks:form.titlePlaceholder')}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            {t('tasks:form.titleHelpText')}
          </p>
        </div>

        {/* Agent Profile Selection */}
        <AgentProfileSelector
          profileId={profileId}
          model={model}
          thinkingLevel={thinkingLevel}
          phaseModels={phaseModels}
          phaseThinking={phaseThinking}
          onProfileChange={onProfileChange}
          onModelChange={onModelChange}
          onThinkingLevelChange={onThinkingLevelChange}
          onPhaseModelsChange={onPhaseModelsChange}
          onPhaseThinkingChange={onPhaseThinkingChange}
          disabled={disabled}
        />

        {/* Classification */}
        <div id={`${prefix}classification-section`} className="space-y-3">
          <Label className="text-sm font-medium text-foreground">
            {t('tasks:form.classificationOptional')}
          </Label>
          <ClassificationFields
            category={category}
            priority={priority}
            complexity={complexity}
            impact={impact}
            onCategoryChange={onCategoryChange}
            onPriorityChange={onPriorityChange}
            onComplexityChange={onComplexityChange}
            onImpactChange={onImpactChange}
            disabled={disabled}
            idPrefix={idPrefix}
          />
        </div>

        {/* Review Requirement Toggle */}
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30">
          <Checkbox
            id={`${prefix}require-review`}
            checked={requireReviewBeforeCoding}
            onCheckedChange={(checked) => onRequireReviewChange(checked === true)}
            disabled={disabled}
            className="mt-0.5"
          />
          <div className="flex-1 space-y-1">
            <Label
              htmlFor={`${prefix}require-review`}
              className="text-sm font-medium text-foreground cursor-pointer"
            >
              {t('tasks:form.requireReviewLabel')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('tasks:form.requireReviewDescription')}
            </p>
          </div>
        </div>

        {/* Fast Mode Toggle - shown when any phase uses an Opus model */}
        {showFastModeToggle && onFastModeChange && (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 shrink-0">
                  <Zap className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <Label className="text-sm font-medium text-foreground">
                    {t('tasks:form.fastModeLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('tasks:form.fastModeDescription')}
                  </p>
                </div>
              </div>
              <Switch
                checked={fastMode}
                onCheckedChange={onFastModeChange}
                disabled={disabled}
              />
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/5 border border-amber-500/20 p-2.5">
              <Info className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                {t('tasks:form.fastModeNotice')}
              </p>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive" role="alert">
            <X className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </>
  );
}
