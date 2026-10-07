/**
 * TaskCreationWizard - Dialog for creating new tasks
 *
 * Now uses the shared TaskModalLayout for consistent styling with other task modals,
 * and TaskFormFields for the form content.
 *
 * Features unique to creation (not in TaskEditDialog):
 * - Draft persistence (auto-save to localStorage)
 * - @ mention autocomplete for file references
 * - File explorer drawer sidebar
 * - Git branch selection options
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { SettingsRow, SettingsRows } from './settings/SettingsRow';
import { SettingsSection } from './settings/SettingsSection';
import { Combobox } from './ui/combobox';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { FileAutocomplete } from './FileAutocomplete';
import { createTask, saveDraft, loadDraft, clearDraft, isDraftEmpty } from '../stores/task-store';
import { useProjectStore } from '../stores/project-store';
import { buildBranchOptions } from '../lib/branch-utils';
import type { TaskCategory, TaskPriority, TaskComplexity, TaskImpact, TaskMetadata, ImageAttachment, TaskDraft, ModelType, ThinkingLevel, ReferencedFile, GitBranchDetail } from '../../shared/types';
import type { PhaseModelConfig, PhaseThinkingConfig } from '../../shared/types/settings';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  FAST_MODE_MODELS,
  PHASE_KEYS,
  getProviderPreset
} from '../../shared/constants';
import { useSettingsStore } from '../stores/settings-store';
import { useActiveProvider } from '../hooks/useActiveProvider';

interface TaskCreationWizardProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Special value for "use project default" branch
const PROJECT_DEFAULT_BRANCH = '__project_default__';

export function TaskCreationWizard({
  projectId,
  open,
  onOpenChange
}: TaskCreationWizardProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useSettingsStore();
  const { isAnthropic, provider: activeProvider } = useActiveProvider();

  // Resolve per-provider settings (same chain as AgentProfileSettings)
  const providerConfig = activeProvider ? settings.providerAgentConfig?.[activeProvider] : undefined;
  const resolvedProfileId = providerConfig?.selectedAgentProfile ?? settings.selectedAgentProfile ?? 'auto';
  const selectedProfile = DEFAULT_AGENT_PROFILES.find(
    p => p.id === resolvedProfileId
  ) || DEFAULT_AGENT_PROFILES.find(p => p.id === 'auto')!;
  const providerPreset = activeProvider ? getProviderPreset(activeProvider, resolvedProfileId) : null;
  const profilePhaseModels = providerPreset?.phaseModels ?? selectedProfile.phaseModels ?? DEFAULT_PHASE_MODELS;
  const profilePhaseThinking = providerPreset?.phaseThinking ?? selectedProfile.phaseThinking ?? DEFAULT_PHASE_THINKING;
  // When a provider is active, use provider-specific config or preset defaults (skip global fallback)
  const resolvedPhaseModels = activeProvider
    ? (providerConfig?.customPhaseModels ?? profilePhaseModels)
    : (settings.customPhaseModels ?? profilePhaseModels);
  const resolvedPhaseThinking = activeProvider
    ? (providerConfig?.customPhaseThinking ?? profilePhaseThinking)
    : (settings.customPhaseThinking ?? profilePhaseThinking);

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Git options state - using structured GitBranchDetail for type indicators
  const [branches, setBranches] = useState<GitBranchDetail[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [baseBranch, setBaseBranch] = useState<string>(PROJECT_DEFAULT_BRANCH);
  const [projectDefaultBranch, setProjectDefaultBranch] = useState<string>('');
  // Worktree isolation - default to true for safety
  const [useWorktree, setUseWorktree] = useState(true);
  const [pushNewBranches, setPushNewBranches] = useState(true);

  // Get project path from project store
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(() => {
    const project = projects.find((p) => p.id === projectId);
    return project?.path ?? null;
  }, [projects, projectId]);
  const projectPushNewBranches = useMemo(() => {
    const project = projects.find((p) => p.id === projectId);
    return project?.settings?.pushNewBranches !== false;
  }, [projects, projectId]);

  // Build branch options using shared utility - groups by local/remote with type indicators
  const branchOptions = useMemo(() => {
    const options = buildBranchOptions(branches, {
      t,
      includeProjectDefault: {
        value: PROJECT_DEFAULT_BRANCH,
        branchName: projectDefaultBranch,
        labelKey: projectDefaultBranch
          ? 'tasks:wizard.gitOptions.useProjectDefaultWithBranch'
          : 'tasks:wizard.gitOptions.useProjectDefault',
      },
    });
    // Show the branch type ("Local" / "Remote") as plain muted text instead of a colored badge
    return options.map((option) => {
      if (!option.badge) return option;
      const branchName = option.value === PROJECT_DEFAULT_BRANCH ? projectDefaultBranch : option.value;
      const branchType = branches.find((b) => b.name === branchName)?.type;
      if (!branchType) return option;
      return {
        ...option,
        badge: (
          <span className="text-xs text-(--nav-label-color)">
            {t(branchType === 'local' ? 'common:git.branchType.local' : 'common:git.branchType.remote')}
          </span>
        ),
      };
    });
  }, [branches, projectDefaultBranch, t]);

  // Determine if the selected branch is local (for useLocalBranch flag)
  const isSelectedBranchLocal = useMemo(() => {
    if (baseBranch === PROJECT_DEFAULT_BRANCH) return false;
    const selectedGitBranchDetail = branches.find((b) => b.name === baseBranch);
    return selectedGitBranchDetail?.type === 'local';
  }, [baseBranch, branches]);

  // Classification fields
  const [category, setCategory] = useState<TaskCategory | ''>('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [complexity, setComplexity] = useState<TaskComplexity | ''>('');
  const [impact, setImpact] = useState<TaskImpact | ''>('');

  // Model configuration
  const [profileId, setProfileId] = useState<string>(resolvedProfileId);
  const [model, setModel] = useState<ModelType | ''>(selectedProfile.model);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | ''>(selectedProfile.thinkingLevel);
  const [phaseModels, setPhaseModels] = useState<PhaseModelConfig | undefined>(resolvedPhaseModels);
  const [phaseThinking, setPhaseThinking] = useState<PhaseThinkingConfig | undefined>(resolvedPhaseThinking);

  // Images and files
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [referencedFiles, setReferencedFiles] = useState<ReferencedFile[]>([]);

  // Review setting
  const [requireReviewBeforeCoding, setRequireReviewBeforeCoding] = useState(false);

  // Fast mode
  const [fastMode, setFastMode] = useState(false);

  // Show Fast Mode toggle when any phase uses an Opus model
  const showFastModeToggle = useMemo(() => {
    if (!isAnthropic) return false;
    if (!phaseModels) return false;
    return PHASE_KEYS.some(phase => FAST_MODE_MODELS.includes(phaseModels[phase]));
  }, [isAnthropic, phaseModels]);

  // Draft state
  const [isDraftRestored, setIsDraftRestored] = useState(false);

  // @ autocomplete state
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [autocomplete, setAutocomplete] = useState<{
    show: boolean;
    query: string;
    startPos: number;
    position: { top: number; left: number };
  } | null>(null);

  // Load draft when dialog opens
  useEffect(() => {
    if (open && projectId) {
      const draft = loadDraft(projectId);
      if (draft && !isDraftEmpty(draft)) {
        setTitle(draft.title);
        setDescription(draft.description);
        setCategory(draft.category);
        setPriority(draft.priority);
        setComplexity(draft.complexity);
        setImpact(draft.impact);
        setProfileId(draft.profileId || resolvedProfileId);
        setModel(draft.model || selectedProfile.model);
        setThinkingLevel(draft.thinkingLevel || selectedProfile.thinkingLevel);
        setPhaseModels(draft.phaseModels || resolvedPhaseModels);
        setPhaseThinking(draft.phaseThinking || resolvedPhaseThinking);
        setImages(draft.images);
        setReferencedFiles(draft.referencedFiles ?? []);
        setRequireReviewBeforeCoding(draft.requireReviewBeforeCoding ?? false);
        setFastMode(draft.fastMode ?? false);
        setPushNewBranches(draft.pushNewBranches ?? projectPushNewBranches);
        setIsDraftRestored(true);
      } else {
        // No draft - reset to clean state for new task creation
        // This ensures no stale data from previous task creation persists
        setTitle('');
        setDescription('');
        setCategory('');
        setPriority('');
        setComplexity('');
        setImpact('');
        setProfileId(resolvedProfileId);
        setModel(selectedProfile.model);
        setThinkingLevel(selectedProfile.thinkingLevel);
        setPhaseModels(resolvedPhaseModels);
        setPhaseThinking(resolvedPhaseThinking);
        setImages([]);
        setReferencedFiles([]);
        setRequireReviewBeforeCoding(false);
        setFastMode(false);
        setBaseBranch(PROJECT_DEFAULT_BRANCH);
        setUseWorktree(true);
        setPushNewBranches(projectPushNewBranches);
        setIsDraftRestored(false);
      }
    }
  }, [open, projectId, projectPushNewBranches, resolvedProfileId, resolvedPhaseModels, resolvedPhaseThinking, selectedProfile.model, selectedProfile.thinkingLevel]);

  // Fetch branches when dialog opens - using structured branch data with type indicators
  useEffect(() => {
    let isMounted = true;

    const fetchBranches = async () => {
      if (!projectPath) return;
      if (isMounted) setIsLoadingBranches(true);
      try {
        // Use structured branch data with type indicators
        const result = await window.electronAPI.getGitBranchesWithInfo(projectPath);
        if (isMounted && result.success && result.data) {
          setBranches(result.data);
        }
      } catch (err) {
        console.error('Failed to fetch branches:', err);
      } finally {
        if (isMounted) setIsLoadingBranches(false);
      }
    };

    const fetchProjectDefaultBranch = async () => {
      if (!projectId) return;
      try {
        const result = await window.electronAPI.getProjectEnv(projectId);
        if (isMounted && result.success && result.data?.defaultBranch) {
          setProjectDefaultBranch(result.data.defaultBranch);
        } else if (projectPath) {
          const detectResult = await window.electronAPI.detectMainBranch(projectPath);
          if (isMounted && detectResult.success && detectResult.data) {
            setProjectDefaultBranch(detectResult.data);
          }
        }
      } catch (err) {
        console.error('Failed to fetch project default branch:', err);
      }
    };

    if (open && projectPath) {
      fetchBranches();
      fetchProjectDefaultBranch();
    }

    return () => {
      isMounted = false;
    };
  }, [open, projectPath, projectId]);

  /**
   * Get current form state as a draft
   */
  const getCurrentDraft = useCallback((): TaskDraft => ({
    projectId,
    title,
    description,
    category,
    priority,
    complexity,
    impact,
    profileId,
    model,
    thinkingLevel,
    phaseModels,
    phaseThinking,
    images,
    referencedFiles,
    requireReviewBeforeCoding,
    fastMode,
    pushNewBranches,
    savedAt: new Date()
  }), [projectId, title, description, category, priority, complexity, impact, profileId, model, thinkingLevel, phaseModels, phaseThinking, images, referencedFiles, requireReviewBeforeCoding, fastMode, pushNewBranches]);

  /**
   * Detect @ mention being typed and show autocomplete
   */
  const detectAtMention = useCallback((text: string, cursorPos: number) => {
    const beforeCursor = text.slice(0, cursorPos);
    const match = beforeCursor.match(/@([\w\-./\\]*)$/);
    if (match) {
      return { query: match[1], startPos: cursorPos - match[0].length };
    }
    return null;
  }, []);

  /**
   * Handle description change and check for @ mentions
   */
  const handleDescriptionChange = useCallback((newValue: string) => {
    const textarea = descriptionRef.current;
    const cursorPos = textarea?.selectionStart || 0;

    setDescription(newValue);

    const mention = detectAtMention(newValue, cursorPos);
    if (mention && textarea) {
      const rect = textarea.getBoundingClientRect();
      const textareaStyle = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(textareaStyle.lineHeight) || 20;
      const paddingTop = parseFloat(textareaStyle.paddingTop) || 8;
      const paddingLeft = parseFloat(textareaStyle.paddingLeft) || 12;

      const textBeforeCursor = newValue.slice(0, cursorPos);
      const lines = textBeforeCursor.split('\n');
      const currentLineIndex = lines.length - 1;
      const currentLineLength = lines[currentLineIndex].length;

      const charWidth = 8;
      const top = paddingTop + (currentLineIndex + 1) * lineHeight + 4;
      const left = paddingLeft + Math.min(currentLineLength * charWidth, rect.width - 300);

      setAutocomplete({
        show: true,
        query: mention.query,
        startPos: mention.startPos,
        position: { top, left: Math.max(0, left) }
      });
    } else if (autocomplete?.show) {
      setAutocomplete(null);
    }
  }, [detectAtMention, autocomplete?.show]);

  /**
   * Handle autocomplete selection
   */
  const handleAutocompleteSelect = useCallback((filename: string, _fullPath?: string) => {
    if (!autocomplete) return;
    const textarea = descriptionRef.current;
    if (!textarea) return;

    const beforeMention = description.slice(0, autocomplete.startPos);
    const afterMention = description.slice(autocomplete.startPos + 1 + autocomplete.query.length);
    const newDescription = beforeMention + '@' + filename + afterMention;

    setDescription(newDescription);
    setAutocomplete(null);

    // Use queueMicrotask instead of setTimeout - doesn't need cleanup on unmount
    queueMicrotask(() => {
      const newCursorPos = autocomplete.startPos + 1 + filename.length;
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    });
  }, [autocomplete, description]);

  /**
   * Parse @mentions from description
   */
  const parseFileMentions = useCallback((text: string, existingFiles: ReferencedFile[]): ReferencedFile[] => {
    const mentionRegex = /@([\w\-./\\]+\.\w+)/g;
    const matches = Array.from(text.matchAll(mentionRegex));
    if (matches.length === 0) return existingFiles;

    const existingNames = new Set(existingFiles.map(f => f.name));
    const newFiles: ReferencedFile[] = [];

    matches.forEach(match => {
      const fileName = match[1];
      if (!existingNames.has(fileName)) {
        newFiles.push({
          id: crypto.randomUUID(),
          path: fileName,
          name: fileName,
          isDirectory: false,
          addedAt: new Date()
        });
        existingNames.add(fileName);
      }
    });

    return [...existingFiles, ...newFiles];
  }, []);

  const handleCreate = async () => {
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const allReferencedFiles = parseFileMentions(description, referencedFiles);

      const metadata: TaskMetadata = { sourceType: 'manual' };
      if (category) metadata.category = category;
      if (priority) metadata.priority = priority;
      if (complexity) metadata.complexity = complexity;
      if (impact) metadata.impact = impact;
      if (model) metadata.model = model;
      if (thinkingLevel) metadata.thinkingLevel = thinkingLevel;
      if (activeProvider) metadata.provider = activeProvider;
      if (phaseModels && phaseThinking) {
        metadata.isAutoProfile = true;
        metadata.phaseModels = phaseModels;
        metadata.phaseThinking = phaseThinking;
      }

      // Cross-provider mode: override phaseModels/phaseThinking from mixed config
      // and add phaseProviders to metadata
      if (settings.customMixedProfileActive && settings.customMixedPhaseConfig) {
        const mixed = settings.customMixedPhaseConfig;
        metadata.phaseModels = {
          spec: mixed.spec.modelId,
          planning: mixed.planning.modelId,
          coding: mixed.coding.modelId,
          qa: mixed.qa.modelId,
        };
        metadata.phaseThinking = {
          spec: mixed.spec.thinkingLevel,
          planning: mixed.planning.thinkingLevel,
          coding: mixed.coding.thinkingLevel,
          qa: mixed.qa.thinkingLevel,
        };
        metadata.phaseProviders = {
          spec: mixed.spec.provider,
          planning: mixed.planning.provider,
          coding: mixed.coding.provider,
          qa: mixed.qa.provider,
        };
        metadata.isAutoProfile = true; // Ensure per-phase resolution is used
      }

      if (images.length > 0) metadata.attachedImages = images;
      if (allReferencedFiles.length > 0) metadata.referencedFiles = allReferencedFiles;
      if (requireReviewBeforeCoding) metadata.requireReviewBeforeCoding = true;
      // Always include baseBranch - resolve PROJECT_DEFAULT_BRANCH to actual branch name
      // This ensures the backend always knows which branch to use for worktree creation
      if (baseBranch === PROJECT_DEFAULT_BRANCH) {
        // Use the resolved project default branch
        if (projectDefaultBranch) metadata.baseBranch = projectDefaultBranch;
      } else if (baseBranch) {
        metadata.baseBranch = baseBranch;
      }
      // Pass worktree preference - false means use --direct mode
      if (!useWorktree) metadata.useWorktree = false;
      // Set useLocalBranch when user explicitly selects a local branch
      // This preserves gitignored files (.env, configs) by not switching to origin
      if (isSelectedBranchLocal) metadata.useLocalBranch = true;
      if (!pushNewBranches) metadata.pushNewBranches = false;
      metadata.fastMode = fastMode;

      const task = await createTask(projectId, title.trim(), description.trim(), metadata);
      if (task) {
        clearDraft(projectId);
        resetForm();
        onOpenChange(false);
      } else {
        setError(t('tasks:wizard.errors.createFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:errors.unknownError'));
    } finally {
      setIsCreating(false);
    }
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setCategory('');
    setPriority('');
    setComplexity('');
    setImpact('');
    setProfileId(resolvedProfileId);
    setModel(selectedProfile.model);
    setThinkingLevel(selectedProfile.thinkingLevel);
    setPhaseModels(resolvedPhaseModels);
    setPhaseThinking(resolvedPhaseThinking);
    setImages([]);
    setReferencedFiles([]);
    setRequireReviewBeforeCoding(false);
    setFastMode(false);
    setBaseBranch(PROJECT_DEFAULT_BRANCH);
    setUseWorktree(true);
    setPushNewBranches(projectPushNewBranches);
    setError(null);
    setIsDraftRestored(false);
  };

  const handleClose = () => {
    if (isCreating) return;

    const draft = getCurrentDraft();
    if (!isDraftEmpty(draft)) {
      saveDraft(draft);
    } else {
      clearDraft(projectId);
    }

    resetForm();
    onOpenChange(false);
  };

  const handleDiscardDraft = () => {
    clearDraft(projectId);
    resetForm();
    setError(null);
  };

  // Render @ mention highlight overlay for the description textarea
  const descriptionOverlay = (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden rounded-lg border border-transparent"
      style={{
        padding: '0.5rem 0.75rem',
        font: 'inherit',
        lineHeight: '1.5',
        wordWrap: 'break-word',
        whiteSpace: 'pre-wrap',
        color: 'transparent'
      }}
    >
      {description.split(/(@[\w\-./\\]+\.\w+)/g).map((part, i) => {
        if (part.match(/^@[\w\-./\\]+\.\w+$/)) {
          return (
            <span
              key={i}
              className="bg-info/20 text-info-foreground rounded px-0.5"
              style={{ color: 'hsl(var(--info))' }}
            >
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );

  // Git options - unique to creation; rendered as the last section of the form
  const gitOptionsSection = (
    <SettingsSection title={t('tasks:wizard.gitOptions.title')}>
      <SettingsRows>
        <SettingsRow
          label={t('tasks:wizard.gitOptions.baseBranchLabel')}
          description={t('tasks:wizard.gitOptions.helpText')}
          htmlFor="base-branch"
        >
          <Combobox
            id="base-branch"
            value={baseBranch}
            onValueChange={setBaseBranch}
            options={branchOptions}
            placeholder={projectDefaultBranch
              ? t('tasks:wizard.gitOptions.useProjectDefaultWithBranch', { branch: projectDefaultBranch })
              : t('tasks:wizard.gitOptions.useProjectDefault')
            }
            searchPlaceholder={t('tasks:wizard.gitOptions.searchBranches')}
            emptyMessage={t('tasks:wizard.gitOptions.noBranchesFound')}
            disabled={isCreating || isLoadingBranches}
            className="h-8 w-auto max-w-[18rem] gap-1.5 border-transparent bg-transparent px-2 hover:bg-nav-hover focus:border-transparent focus:ring-0 focus-visible:shadow-(--shadow-focus) data-[state=open]:bg-nav-hover"
          />
        </SettingsRow>
        <SettingsRow
          label={t('tasks:wizard.gitOptions.pushNewBranchesLabel')}
          description={t('tasks:wizard.gitOptions.pushNewBranchesDescription')}
          htmlFor="push-new-branches"
        >
          <Switch
            id="push-new-branches"
            checked={pushNewBranches}
            onCheckedChange={setPushNewBranches}
            disabled={isCreating}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );

  return (
    <TaskModalLayout
      open={open}
      onOpenChange={handleClose}
      title={t('tasks:wizard.createTitle')}
      description={t('tasks:wizard.createDescription')}
      disabled={isCreating}
      footer={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Draft restored indicator */}
            {isDraftRestored && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-(--nav-label-color)">
                  {t('tasks:wizard.draftRestored')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={handleDiscardDraft}
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {t('tasks:wizard.startFresh')}
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleClose} disabled={isCreating}>
              {t('common:buttons.cancel')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={isCreating || !description.trim()}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('tasks:wizard.creating')}
                </>
              ) : (
                t('tasks:wizard.createTask')
              )}
            </Button>
          </div>
        </div>
      }
    >
      {/* Main form fields (Git options are appended as an extra section) */}
      <TaskFormFields
        description={description}
        onDescriptionChange={handleDescriptionChange}
        descriptionPlaceholder={t('tasks:wizard.descriptionPlaceholder')}
        descriptionOverlay={descriptionOverlay}
        descriptionRef={descriptionRef}
        title={title}
        onTitleChange={setTitle}
        profileId={profileId}
        model={model}
        thinkingLevel={thinkingLevel}
        phaseModels={phaseModels}
        phaseThinking={phaseThinking}
        onProfileChange={(newProfileId, newModel, newThinkingLevel) => {
          setProfileId(newProfileId);
          setModel(newModel);
          setThinkingLevel(newThinkingLevel);
        }}
        onModelChange={setModel}
        onThinkingLevelChange={setThinkingLevel}
        onPhaseModelsChange={setPhaseModels}
        onPhaseThinkingChange={setPhaseThinking}
        category={category}
        priority={priority}
        complexity={complexity}
        impact={impact}
        onCategoryChange={setCategory}
        onPriorityChange={setPriority}
        onComplexityChange={setComplexity}
        onImpactChange={setImpact}
        images={images}
        onImagesChange={setImages}
        requireReviewBeforeCoding={requireReviewBeforeCoding}
        onRequireReviewChange={setRequireReviewBeforeCoding}
        fastMode={fastMode}
        onFastModeChange={setFastMode}
        showFastModeToggle={showFastModeToggle}
        disabled={isCreating}
        error={error}
        onError={setError}
        idPrefix="create"
        extraSections={gitOptionsSection}
      >
        {/* File autocomplete popup - positioned relative to TaskFormFields */}
        {autocomplete?.show && projectPath && (
          <FileAutocomplete
            query={autocomplete.query}
            projectPath={projectPath}
            position={autocomplete.position}
            onSelect={handleAutocompleteSelect}
            onClose={() => setAutocomplete(null)}
          />
        )}
      </TaskFormFields>
    </TaskModalLayout>
  );
}
