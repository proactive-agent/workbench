import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '../settings/SettingsRow';
import { useContextStore } from '../../stores/context-store';
import { verifyMemory, pinMemory, deprecateMemory } from '../../stores/context-store';
import { useProjectContext, useRefreshIndex, useMemorySearch } from './hooks';
import { ProjectIndexTab } from './ProjectIndexTab';
import { MemoriesTab } from './MemoriesTab';
import type { ContextProps } from './types';

export function Context({ projectId }: ContextProps) {
  const { t } = useTranslation(['common', 'settings']);
  const {
    projectIndex,
    indexLoading,
    indexError,
    memoryStatus,
    memoryState,
    recentMemories,
    memoriesLoading,
    searchResults,
    searchLoading
  } = useContextStore();

  const [activeTab, setActiveTab] = useState<'index' | 'memories'>('index');

  // Custom hooks
  useProjectContext(projectId);
  const handleRefreshIndex = useRefreshIndex(projectId);
  const handleSearch = useMemorySearch(projectId);

  const handleVerify = async (memoryId: string) => {
    await verifyMemory(memoryId);
  };

  const handlePin = async (memoryId: string, pinned: boolean) => {
    await pinMemory(memoryId, pinned);
  };

  const handleDeprecate = async (memoryId: string) => {
    await deprecateMemory(memoryId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-[832px] shrink-0 px-7 pb-6 pt-4">
        <SegmentedControl
          value={activeTab}
          onValueChange={setActiveTab}
          ariaLabel={t('settings:projectSections.context.title')}
          options={[
            { value: 'index', label: t('context.tabs.projectIndex') },
            { value: 'memories', label: t('context.tabs.memories') }
          ]}
        />
      </div>

      <div className="min-h-0 flex-1">
        {activeTab === 'index' ? (
          <ProjectIndexTab
            projectIndex={projectIndex}
            indexLoading={indexLoading}
            indexError={indexError}
            onRefresh={handleRefreshIndex}
          />
        ) : (
          <MemoriesTab
            memoryStatus={memoryStatus}
            memoryState={memoryState}
            recentMemories={recentMemories}
            memoriesLoading={memoriesLoading}
            searchResults={searchResults}
            searchLoading={searchLoading}
            onSearch={handleSearch}
            onVerify={handleVerify}
            onPin={handlePin}
            onDeprecate={handleDeprecate}
          />
        )}
      </div>
    </div>
  );
}
