/**
 * Individual issue card component
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { Checkbox } from '../../ui/checkbox';
import type { LinearIssue } from '../types';

interface IssueCardProps {
  issue: LinearIssue;
  isSelected: boolean;
  onToggle: (issueId: string) => void;
}

export function IssueCard({ issue, isSelected, onToggle }: IssueCardProps) {
  const { t } = useTranslation('dialogs');
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div
      className={`
        rounded-lg p-3 cursor-pointer transition-colors
        ${isSelected ? 'bg-nav-active' : 'hover:bg-nav-hover'}
      `}
      onClick={() => onToggle(issue.id)}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <div className="mt-0.5">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggle(issue.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={issue.title}
          />
        </div>

        {/* Issue Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
            <span className="font-mono">{issue.identifier}</span>
            <span aria-hidden="true">·</span>
            <span>{issue.state.name}</span>
            <span aria-hidden="true">·</span>
            <span>{issue.priorityLabel}</span>
            {issue.labels.slice(0, 2).map(label => (
              <span key={label.id}>
                <span aria-hidden="true">· </span>
                {label.name}
              </span>
            ))}
            {issue.labels.length > 2 && (
              <span>{t('linearImport.moreLabels', { count: issue.labels.length - 2 })}</span>
            )}
          </div>

          <h4 className="text-sm font-medium text-foreground mt-1 line-clamp-2">
            {issue.title}
          </h4>

          {/* Expandable description */}
          {issue.description && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  {t('linearImport.hideDescription')}
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {t('linearImport.showDescription')}
                </>
              )}
            </button>
          )}

          {isExpanded && issue.description && (
            <div className="mt-2 text-xs text-muted-foreground rounded-lg bg-segment-track px-3 py-2 max-h-32 overflow-auto">
              {issue.description}
            </div>
          )}

          {/* Meta info */}
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            {issue.assignee && (
              <span>{t('linearImport.assignedTo', { name: issue.assignee.name })}</span>
            )}
            {issue.project && (
              <span>{t('linearImport.projectLabel', { name: issue.project.name })}</span>
            )}
            <a
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              {t('linearImport.viewInLinear')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
