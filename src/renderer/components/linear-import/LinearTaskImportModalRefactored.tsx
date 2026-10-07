/**
 * Refactored Linear Task Import Modal
 * Main modal component that orchestrates the import workflow
 * Uses extracted hooks and components for better maintainability
 */

import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useLinearImportModal } from './hooks';
import {
  ImportSuccessBanner,
  ErrorBanner,
  TeamProjectSelector,
  SearchAndFilterBar,
  SelectionControls,
  IssueList
} from './components';
import type { LinearTaskImportModalProps } from './types';

export function LinearTaskImportModalRefactored({
  projectId,
  open,
  onOpenChange,
  onImportComplete
}: LinearTaskImportModalProps) {
  const { t } = useTranslation(['dialogs', 'common']);
  // Use the orchestration hook to manage all state and handlers
  const {
    teams,
    projects,
    issues,
    uniqueStateTypes,
    selectedTeamId,
    selectedProjectId,
    selectedIssueIds,
    selectionControls,
    searchQuery,
    filterState,
    isLoadingTeams,
    isLoadingProjects,
    isLoadingIssues,
    isImporting,
    error,
    importResult,
    setSelectedTeamId,
    setSelectedProjectId,
    setSearchQuery,
    setFilterState,
    handleRefresh,
    handleImport,
    resetState
  } = useLinearImportModal({ projectId, open, onImportComplete });

  // Handle modal open/close with state reset
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetState();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t('dialogs:linearImport.title')}
          </DialogTitle>
          <DialogDescription>
            {t('dialogs:linearImport.description')}
          </DialogDescription>
        </DialogHeader>

        {/* Import Success Banner */}
        {importResult?.success && (
          <ImportSuccessBanner
            importResult={importResult}
            onClose={() => handleOpenChange(false)}
          />
        )}

        {/* Error Banner */}
        {error && <ErrorBanner error={error} />}

        {/* Main Content - Only show when not in success state */}
        {!importResult?.success && (
          <>
            {/* Team and Project Selection */}
            <TeamProjectSelector
              teams={teams}
              projects={projects}
              selectedTeamId={selectedTeamId}
              selectedProjectId={selectedProjectId}
              isLoadingTeams={isLoadingTeams}
              isLoadingProjects={isLoadingProjects}
              onTeamChange={setSelectedTeamId}
              onProjectChange={setSelectedProjectId}
            />

            {/* Search and Filter Bar */}
            <SearchAndFilterBar
              searchQuery={searchQuery}
              filterState={filterState}
              uniqueStateTypes={uniqueStateTypes}
              onSearchChange={setSearchQuery}
              onFilterChange={setFilterState}
            />

            {/* Selection Controls */}
            {issues.length > 0 && (
              <SelectionControls
                isAllSelected={selectionControls.isAllSelected}
                isSomeSelected={selectionControls.isSomeSelected}
                selectedCount={selectedIssueIds.size}
                filteredCount={issues.length}
                isLoadingIssues={isLoadingIssues}
                onSelectAll={selectionControls.selectAll}
                onDeselectAll={selectionControls.deselectAll}
                onRefresh={handleRefresh}
              />
            )}

            {/* Issue List */}
            <IssueList
              issues={issues}
              selectedIssueIds={selectedIssueIds}
              isLoadingIssues={isLoadingIssues}
              selectedTeamId={selectedTeamId}
              searchQuery={searchQuery}
              filterState={filterState}
              onToggleIssue={selectionControls.toggleIssue}
            />
          </>
        )}

        <DialogFooter className="shrink-0">
          <Button
            variant={importResult?.success ? 'default' : 'ghost'}
            size="sm"
            onClick={() => handleOpenChange(false)}
          >
            {importResult?.success ? t('dialogs:linearImport.done') : t('common:buttons.cancel')}
          </Button>
          {!importResult?.success && (
            <Button
              size="sm"
              onClick={handleImport}
              disabled={selectedIssueIds.size === 0 || isImporting}
            >
              {isImporting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('dialogs:linearImport.importing')}
                </>
              ) : (
                t('dialogs:linearImport.importCount', { count: selectedIssueIds.size })
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
