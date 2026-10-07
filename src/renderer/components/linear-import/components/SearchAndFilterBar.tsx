/**
 * Search input and state filter dropdown
 */

import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';

interface SearchAndFilterBarProps {
  searchQuery: string;
  filterState: string;
  uniqueStateTypes: string[];
  onSearchChange: (query: string) => void;
  onFilterChange: (state: string) => void;
}

export function SearchAndFilterBar({
  searchQuery,
  filterState,
  uniqueStateTypes,
  onSearchChange,
  onFilterChange
}: SearchAndFilterBarProps) {
  const { t } = useTranslation('dialogs');
  return (
    <div className="flex gap-3 items-center shrink-0">
      <div className="flex-1 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('linearImport.searchPlaceholder')}
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      <Select value={filterState} onValueChange={onFilterChange}>
        <SelectTrigger className="w-[150px]" aria-label={t('linearImport.stateFilter')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('linearImport.allStates')}</SelectItem>
          {uniqueStateTypes.map(type => (
            <SelectItem key={type} value={type}>
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
