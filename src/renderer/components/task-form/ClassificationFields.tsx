/**
 * ClassificationFields - Shared component for task classification fields
 *
 * Renders one settings row per classification dropdown (category, priority, complexity, impact)
 * used in both TaskCreationWizard and TaskEditDialog.
 */
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import type { TaskCategory, TaskPriority, TaskComplexity, TaskImpact } from '../../../shared/types';

// Classification option keys (values are used for translation key lookup)
const CATEGORY_OPTIONS: TaskCategory[] = ['feature', 'bug_fix', 'refactoring', 'documentation', 'security'];
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const COMPLEXITY_OPTIONS: TaskComplexity[] = ['trivial', 'small', 'medium', 'large', 'complex'];
const IMPACT_OPTIONS: TaskImpact[] = ['low', 'medium', 'high', 'critical'];

interface ClassificationFieldsProps {
  /** Current category value */
  category: TaskCategory | '';
  /** Current priority value */
  priority: TaskPriority | '';
  /** Current complexity value */
  complexity: TaskComplexity | '';
  /** Current impact value */
  impact: TaskImpact | '';
  /** Callback when category changes */
  onCategoryChange: (value: TaskCategory | '') => void;
  /** Callback when priority changes */
  onPriorityChange: (value: TaskPriority | '') => void;
  /** Callback when complexity changes */
  onComplexityChange: (value: TaskComplexity | '') => void;
  /** Callback when impact changes */
  onImpactChange: (value: TaskImpact | '') => void;
  /** Whether the fields are disabled */
  disabled?: boolean;
  /** Optional ID prefix for form elements (for accessibility) */
  idPrefix?: string;
}

export function ClassificationFields({
  category,
  priority,
  complexity,
  impact,
  onCategoryChange,
  onPriorityChange,
  onComplexityChange,
  onImpactChange,
  disabled = false,
  idPrefix = ''
}: ClassificationFieldsProps) {
  const { t } = useTranslation('tasks');
  const prefix = idPrefix ? `${idPrefix}-` : '';

  // One row per classification field: label left, borderless select in the control slot
  const fields = [
    {
      id: 'category',
      value: category,
      options: CATEGORY_OPTIONS,
      onChange: (value: string) => onCategoryChange(value as TaskCategory)
    },
    {
      id: 'priority',
      value: priority,
      options: PRIORITY_OPTIONS,
      onChange: (value: string) => onPriorityChange(value as TaskPriority)
    },
    {
      id: 'complexity',
      value: complexity,
      options: COMPLEXITY_OPTIONS,
      onChange: (value: string) => onComplexityChange(value as TaskComplexity)
    },
    {
      id: 'impact',
      value: impact,
      options: IMPACT_OPTIONS,
      onChange: (value: string) => onImpactChange(value as TaskImpact)
    }
  ] as const;

  const selectPlaceholderKeys = {
    category: 'form.classification.selectCategory',
    priority: 'form.classification.selectPriority',
    complexity: 'form.classification.selectComplexity',
    impact: 'form.classification.selectImpact'
  } as const;

  return (
    <div>
      <SettingsRows>
        {fields.map((field) => (
          <SettingsRow
            key={field.id}
            label={t(`form.classification.${field.id}`)}
            htmlFor={`${prefix}${field.id}`}
          >
            <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
              <SelectTrigger id={`${prefix}${field.id}`} className="h-8 w-auto">
                <SelectValue placeholder={t(selectPlaceholderKeys[field.id])} />
              </SelectTrigger>
              <SelectContent align="end">
                {field.options.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`form.classification.values.${field.id}.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ))}
      </SettingsRows>

      <p className="mt-3 text-xs text-(--nav-label-color)">
        {t('form.classification.helpText')}
      </p>
    </div>
  );
}
