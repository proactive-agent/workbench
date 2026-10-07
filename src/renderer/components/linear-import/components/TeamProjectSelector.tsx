/**
 * Team and project selection dropdowns
 */

import { useTranslation } from 'react-i18next';
import { Label } from '../../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';
import type { LinearTeam, LinearProject } from '../types';

interface TeamProjectSelectorProps {
  teams: LinearTeam[];
  projects: LinearProject[];
  selectedTeamId: string;
  selectedProjectId: string;
  isLoadingTeams: boolean;
  isLoadingProjects: boolean;
  onTeamChange: (teamId: string) => void;
  onProjectChange: (projectId: string) => void;
}

export function TeamProjectSelector({
  teams,
  projects,
  selectedTeamId,
  selectedProjectId,
  isLoadingTeams,
  isLoadingProjects,
  onTeamChange,
  onProjectChange
}: TeamProjectSelectorProps) {
  const { t } = useTranslation('dialogs');
  return (
    <div className="flex gap-4 shrink-0">
      <div className="flex-1 space-y-2">
        <Label>{t('linearImport.team')}</Label>
        <Select
          value={selectedTeamId}
          onValueChange={onTeamChange}
          disabled={isLoadingTeams}
        >
          <SelectTrigger>
            <SelectValue placeholder={isLoadingTeams ? t('linearImport.loading') : t('linearImport.selectTeam')} />
          </SelectTrigger>
          <SelectContent>
            {teams.map(team => (
              <SelectItem key={team.id} value={team.id}>
                {team.name} ({team.key})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 space-y-2">
        <Label>{t('linearImport.project')}</Label>
        <Select
          value={selectedProjectId || '__all__'}
          onValueChange={(value) => onProjectChange(value === '__all__' ? '' : value)}
          disabled={isLoadingProjects || !selectedTeamId}
        >
          <SelectTrigger>
            <SelectValue placeholder={isLoadingProjects ? t('linearImport.loading') : t('linearImport.allProjects')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('linearImport.allProjects')}</SelectItem>
            {projects.map(project => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
