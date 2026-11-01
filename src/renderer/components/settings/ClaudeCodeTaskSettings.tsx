/**
 * Agents page (app settings): how tasks run in the Claude Code CLI. A short triage run picks
 * each task's model, effort and whether to plan (or a fixed model and effort are used), then
 * Claude Code plans, implements and validates in the task's worktree.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { SettingsSection } from './SettingsSection';
import { SegmentedControl, SettingsRow, SettingsRows } from './SettingsRow';
import {
  DEFAULT_MAX_TERMINALS,
  MIN_TERMINALS,
  MAX_TERMINALS_LIMIT,
  DEFAULT_MAX_PARALLEL_TASKS,
  MIN_PARALLEL_TASKS,
  MAX_PARALLEL_TASKS_LIMIT
} from '../../../shared/constants';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  DEFAULT_CLAUDE_CODE_TASK_SETTINGS,
  type ClaudeCodeTaskSettings as TaskSettings,
  type ClaudeEffort,
  type ClaudeModelAlias,
  type PlanningPolicy,
  type TriageMode
} from '../../../shared/types/claude-code';
import type { AppSettings } from '../../../shared/types';
import { useProjectStore } from '../../stores/project-store';
import { useLiveAgentStore } from '../../stores/live-agent-store';

interface ClaudeCodeTaskSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/** Fallback model choices (`--fallback-model`); 'none' leaves it unset */
const FALLBACK_OPTIONS = ['none', 'sonnet', 'haiku', 'opus'] as const;

/** Task execution, permissions, agent windows and limits sections of the Agents page */
export function ClaudeCodeTaskSettings({ settings, onSettingsChange }: ClaudeCodeTaskSettingsProps) {
  const { t } = useTranslation('settings');
  const stored = settings.claudeCodeTasks ?? {};
  const current: TaskSettings = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, ...stored };

  const update = (patch: Partial<TaskSettings>) => {
    onSettingsChange({ ...settings, claudeCodeTasks: { ...stored, ...patch } });
  };

  // Live agent is the selected project's setting (its .workbench/flow directory), saved at once
  const project = useProjectStore((state) => state.projects.find((p) => p.id === state.selectedProjectId));
  const projectPath = project?.path;
  const liveAgent = useLiveAgentStore((state) => (projectPath ? state.enabled[projectPath] === true : false));
  const hooksError = useLiveAgentStore((state) => (projectPath ? state.hooksError[projectPath] : undefined));
  const [liveAgentError, setLiveAgentError] = useState<string | undefined>();
  useEffect(() => {
    setLiveAgentError(undefined);
    if (projectPath) void useLiveAgentStore.getState().load(projectPath);
  }, [projectPath]);
  const liveAgentProblem = liveAgentError
    ? t('claudeCode.agentWindows.liveAgentFailed', { error: liveAgentError })
    : liveAgent && hooksError
      ? t('claudeCode.agentWindows.liveAgentHooksFailed', { error: hooksError })
      : undefined;

  const modelLabel = (model: ClaudeModelAlias) => t(`claudeCode.models.${model}`);
  const effortLabel = (effort: ClaudeEffort) => t(`claudeCode.efforts.${effort}`);

  const modelSelect = (id: string, value: ClaudeModelAlias, onChange: (model: ClaudeModelAlias) => void) => (
    <Select value={value} onValueChange={(v) => onChange(v as ClaudeModelAlias)}>
      <SelectTrigger id={id} className="h-8">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CLAUDE_MODEL_ALIASES.map((model) => (
          <SelectItem key={model} value={model}>
            {modelLabel(model)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const fallbackValue = current.fallbackModel && current.fallbackModel.trim() !== '' ? current.fallbackModel : 'none';

  return (
    <>
      <SettingsSection title={t('claudeCode.execution.title')}>
        <SettingsRows>
          <SettingsRow
            label={t('claudeCode.execution.modelChoice')}
            description={
              current.triage === 'auto'
                ? t('claudeCode.execution.modelChoiceAutoDescription')
                : t('claudeCode.execution.modelChoiceFixedDescription')
            }
          >
            <SegmentedControl<TriageMode>
              value={current.triage}
              onValueChange={(triage) => update({ triage })}
              ariaLabel={t('claudeCode.execution.modelChoice')}
              options={[
                { value: 'auto', label: t('claudeCode.execution.triageModes.auto') },
                { value: 'fixed', label: t('claudeCode.execution.triageModes.fixed') }
              ]}
            />
          </SettingsRow>

          {current.triage === 'fixed' ? (
            <>
              <SettingsRow
                label={t('claudeCode.execution.model')}
                description={t('claudeCode.execution.modelDescription')}
                htmlFor="claude-code-fixed-model"
              >
                {modelSelect('claude-code-fixed-model', current.fixedModel, (fixedModel) => update({ fixedModel }))}
              </SettingsRow>
              <SettingsRow
                label={t('claudeCode.execution.effort')}
                description={t('claudeCode.execution.effortDescription')}
                htmlFor="claude-code-fixed-effort"
              >
                <Select value={current.fixedEffort} onValueChange={(v) => update({ fixedEffort: v as ClaudeEffort })}>
                  <SelectTrigger id="claude-code-fixed-effort" className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLAUDE_EFFORTS.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {effortLabel(effort)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            </>
          ) : (
            <>
              <SettingsRow
                label={t('claudeCode.execution.triageModel')}
                description={t('claudeCode.execution.triageModelDescription')}
                htmlFor="claude-code-triage-model"
              >
                {modelSelect('claude-code-triage-model', current.triageModel, (triageModel) => update({ triageModel }))}
              </SettingsRow>
              <SettingsRow
                label={t('claudeCode.execution.allowFable')}
                description={t('claudeCode.execution.allowFableDescription')}
              >
                <Switch
                  checked={current.allowFable}
                  onCheckedChange={(allowFable) => update({ allowFable })}
                  aria-label={t('claudeCode.execution.allowFable')}
                />
              </SettingsRow>
            </>
          )}

          <SettingsRow
            label={t('claudeCode.execution.planning')}
            description={t(`claudeCode.execution.planningDescriptions.${current.planning}`)}
          >
            <SegmentedControl<PlanningPolicy>
              value={current.planning}
              onValueChange={(planning) => update({ planning })}
              ariaLabel={t('claudeCode.execution.planning')}
              options={[
                { value: 'auto', label: t('claudeCode.execution.planningModes.auto') },
                { value: 'always', label: t('claudeCode.execution.planningModes.always') },
                { value: 'never', label: t('claudeCode.execution.planningModes.never') }
              ]}
            />
          </SettingsRow>

          <SettingsRow
            label={t('claudeCode.execution.validation')}
            description={t('claudeCode.execution.validationDescription')}
          >
            <Switch
              checked={current.validation}
              onCheckedChange={(validation) => update({ validation })}
              aria-label={t('claudeCode.execution.validation')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('claudeCode.execution.taskMessaging')}
            description={t('claudeCode.execution.taskMessagingDescription')}
          >
            <Switch
              checked={current.taskMessaging}
              onCheckedChange={(taskMessaging) => update({ taskMessaging })}
              aria-label={t('claudeCode.execution.taskMessaging')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('claudeCode.execution.sessionMessages')}
            description={t('claudeCode.execution.sessionMessagesDescription')}
          >
            <Switch
              checked={current.taskMessaging && current.sessionMessages}
              disabled={!current.taskMessaging}
              onCheckedChange={(sessionMessages) => update({ sessionMessages })}
              aria-label={t('claudeCode.execution.sessionMessages')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('claudeCode.execution.fallbackModel')}
            description={t('claudeCode.execution.fallbackModelDescription')}
            htmlFor="claude-code-fallback-model"
          >
            <Select
              value={fallbackValue}
              onValueChange={(v) => update({ fallbackModel: v === 'none' ? undefined : v })}
            >
              <SelectTrigger id="claude-code-fallback-model" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FALLBACK_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === 'none' ? t('claudeCode.execution.fallbackNone') : modelLabel(option)}
                  </SelectItem>
                ))}
                {/* A custom chain set elsewhere stays selectable */}
                {!(FALLBACK_OPTIONS as readonly string[]).includes(fallbackValue) && (
                  <SelectItem value={fallbackValue}>{fallbackValue}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingsRow>

          {/* Agent windows (terminals) start Claude Code with or without permission prompts */}
          <SettingsRow
            label={t('claudeCode.agentWindows.skipPermissions')}
            description={t('claudeCode.agentWindows.skipPermissionsDescription')}
          >
            <Switch
              checked={settings.dangerouslySkipPermissions === true}
              onCheckedChange={(dangerouslySkipPermissions) => onSettingsChange({ ...settings, dangerouslySkipPermissions })}
              aria-label={t('claudeCode.agentWindows.skipPermissions')}
            />
          </SettingsRow>

          {/* The project's agent windows show a live agent-flow graph of their Claude Code session */}
          <SettingsRow
            label={t('claudeCode.agentWindows.liveAgent')}
            description={
              <>
                {project
                  ? t('claudeCode.agentWindows.liveAgentDescription', { project: project.name })
                  : t('claudeCode.agentWindows.liveAgentNoProject')}
                {liveAgentProblem && <span className="mt-1 block text-destructive">{liveAgentProblem}</span>}
              </>
            }
          >
            <Switch
              checked={liveAgent}
              disabled={!projectPath}
              onCheckedChange={(enabled) => {
                if (!projectPath) return;
                void useLiveAgentStore.getState().setEnabled(projectPath, enabled).then(setLiveAgentError);
              }}
              aria-label={t('claudeCode.agentWindows.liveAgent')}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      {/* How many agent windows and parallel tasks a project can run */}
      <SettingsSection title={t('general.limits')}>
        <SettingsRows>
          <SettingsRow
            label={t('general.maxTerminals')}
            description={t('general.maxTerminalsDescription', { min: MIN_TERMINALS, max: MAX_TERMINALS_LIMIT })}
            htmlFor="maxTerminals"
          >
            <Input
              id="maxTerminals"
              type="number"
              min={MIN_TERMINALS}
              max={MAX_TERMINALS_LIMIT}
              className="w-20"
              value={settings.maxTerminals ?? DEFAULT_MAX_TERMINALS}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (e.target.value === '' || !Number.isFinite(value)) return;
                const clamped = Math.min(MAX_TERMINALS_LIMIT, Math.max(MIN_TERMINALS, Math.round(value)));
                onSettingsChange({ ...settings, maxTerminals: clamped });
              }}
            />
          </SettingsRow>
          <SettingsRow
            label={t('projectSections.queue.maxParallelTasks')}
            description={t('projectSections.queue.maxParallelTasksDescription', {
              min: MIN_PARALLEL_TASKS,
              max: MAX_PARALLEL_TASKS_LIMIT
            })}
            htmlFor="maxParallelTasks"
          >
            <Input
              id="maxParallelTasks"
              type="number"
              min={MIN_PARALLEL_TASKS}
              max={MAX_PARALLEL_TASKS_LIMIT}
              className="w-20"
              value={settings.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (e.target.value === '' || !Number.isFinite(value)) return;
                const clamped = Math.min(MAX_PARALLEL_TASKS_LIMIT, Math.max(MIN_PARALLEL_TASKS, Math.round(value)));
                onSettingsChange({ ...settings, maxParallelTasks: clamped });
              }}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
    </>
  );
}
