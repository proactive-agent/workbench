import { useContextStore, verifyMemory, pinMemory, deprecateMemory } from '../../stores/context-store';
import { useProjectContext, useMemorySearch } from './hooks';
import { MemoriesTab } from './MemoriesTab';

/**
 * The project's memory search and browser (shown on the Memory settings page).
 */
export function ProjectMemorySections({ projectId }: { projectId: string }) {
  const {
    recentMemories,
    memoriesLoading,
    searchResults,
    searchLoading
  } = useContextStore();

  useProjectContext(projectId);
  const handleSearch = useMemorySearch(projectId);

  return (
    <MemoriesTab
      recentMemories={recentMemories}
      memoriesLoading={memoriesLoading}
      searchResults={searchResults}
      searchLoading={searchLoading}
      onSearch={handleSearch}
      onVerify={async (memoryId) => { await verifyMemory(memoryId); }}
      onPin={async (memoryId, pinned) => { await pinMemory(memoryId, pinned); }}
      onDeprecate={async (memoryId) => { await deprecateMemory(memoryId); }}
    />
  );
}
