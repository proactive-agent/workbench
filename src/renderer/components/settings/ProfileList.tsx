/**
 * ProfileList - API profiles (Accounts page)
 *
 * Anthropic-compatible endpoints (base URL + API key) that Claude Code can use instead of a
 * Claude subscription. The profile in use takes over from Claude accounts until switched back.
 */
import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '../ui/button';
import { useSettingsStore } from '../../stores/settings-store';
import { ProfileEditDialog } from './ProfileEditDialog';
import { SettingsRow } from './SettingsRow';
import { maskApiKey } from '../../lib/profile-utils';
import type { APIProfile } from '@shared/types/profile';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog';

interface ProfileListProps {
  /** Optional callback when a profile is saved */
  onProfileSaved?: () => void;
}

const getHostFromUrl = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ProfileList({ onProfileSaved }: ProfileListProps) {
  const { t } = useTranslation();
  const {
    profiles,
    activeProfileId,
    deleteProfile,
    setActiveProfile,
    profilesError
  } = useSettingsStore();


  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editProfile, setEditProfile] = useState<APIProfile | null>(null);
  const [deleteConfirmProfile, setDeleteConfirmProfile] = useState<APIProfile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSettingActive, setIsSettingActive] = useState(false);
  // Failures shown where they happened: switching in the profile's row, deleting in the dialog
  const [switchError, setSwitchError] = useState<{ id: string | null; message: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteProfile = async () => {
    if (!deleteConfirmProfile) return;

    setIsDeleting(true);
    setDeleteError(null);
    const success = await deleteProfile(deleteConfirmProfile.id);
    setIsDeleting(false);

    if (success) {
      setDeleteConfirmProfile(null);
      onProfileSaved?.();
    } else {
      setDeleteError(profilesError || t('settings:apiProfiles.toast.delete.errorFallback'));
    }
  };

  /**
   * Use a profile, or go back to Claude accounts (null)
   */
  const handleSetActiveProfile = async (profileId: string | null) => {
    if (profileId !== null && profileId === activeProfileId) return;

    // The row being switched from (null: going back to Claude accounts) shows a failure
    const rowId = profileId ?? activeProfileId ?? null;
    setIsSettingActive(true);
    setSwitchError(null);
    const success = await setActiveProfile(profileId);
    setIsSettingActive(false);

    if (success) {
      onProfileSaved?.();
    } else {
      setSwitchError({ id: rowId, message: profilesError || t('settings:apiProfiles.toast.switch.errorFallback') });
    }
  };

  return (
    <>
      {profiles.map((profile) => {
        const isActive = activeProfileId === profile.id;
        const customModels = profile.models ? Object.keys(profile.models).filter((k) => profile.models?.[k as keyof typeof profile.models]) : [];
        return (
          <SettingsRow
            key={profile.id}
            className="group"
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{profile.name}</span>
                {isActive && (
                  <span className="shrink-0 text-(--nav-label-color)">{t('settings:apiProfiles.activeBadge')}</span>
                )}
              </span>
            }
            description={
              switchError?.id === profile.id ? (
                <span role="alert" className="text-destructive">{switchError.message}</span>
              ) : (
              <span className="block truncate" title={profile.baseUrl}>
                {[
                  getHostFromUrl(profile.baseUrl),
                  profile.apiKey ? maskApiKey(profile.apiKey) : null,
                  customModels.length > 0
                    ? t('settings:apiProfiles.customModels', { models: customModels.join(', ') })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              )
            }
          >
            <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setEditProfile(profile)}
                className="h-8 w-8 text-muted-foreground"
                title={t('settings:apiProfiles.tooltips.edit')}
                aria-label={t('settings:apiProfiles.tooltips.edit')}
              >
                <Pencil className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteConfirmProfile(profile)}
                disabled={isActive}
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                data-testid={`profile-delete-button-${profile.id}`}
                title={
                  isActive
                    ? t('settings:apiProfiles.tooltips.deleteActive')
                    : t('settings:apiProfiles.tooltips.deleteInactive')
                }
                aria-label={t('settings:apiProfiles.deleteAriaLabel', { name: profile.name })}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
            {isActive ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSetActiveProfile(null)}
                disabled={isSettingActive}
              >
                {isSettingActive
                  ? t('settings:apiProfiles.switchToOauth.loading')
                  : t('settings:apiProfiles.switchToOauth.label')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSetActiveProfile(profile.id)}
                disabled={isSettingActive}
              >
                {isSettingActive
                  ? t('settings:apiProfiles.setActive.loading')
                  : t('settings:apiProfiles.setActive.label')}
              </Button>
            )}
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={t('settings:apiProfiles.addButton')}
        description={profiles.length === 0 ? t('settings:apiProfiles.empty.description') : t('settings:apiProfiles.description')}
      >
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setIsAddDialogOpen(true)}>
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t('settings:apiProfiles.add')}
        </Button>
      </SettingsRow>

      {/* Add/Edit Dialog */}
      <ProfileEditDialog
        open={isAddDialogOpen || editProfile !== null}
        onOpenChange={(open) => {
          if (!open) {
            setIsAddDialogOpen(false);
            setEditProfile(null);
          }
        }}
        onSaved={() => {
          setIsAddDialogOpen(false);
          setEditProfile(null);
          onProfileSaved?.();
        }}
        profile={editProfile ?? undefined}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteConfirmProfile !== null}
        onOpenChange={() => {
          setDeleteConfirmProfile(null);
          setDeleteError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings:apiProfiles.dialog.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings:apiProfiles.dialog.deleteDescription', {
                name: deleteConfirmProfile?.name ?? ''
              })}
            </AlertDialogDescription>
            {deleteError && (
              <p role="alert" className="text-sm text-destructive">{deleteError}</p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('settings:apiProfiles.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Stay open until the delete finishes, so a failure can be shown here
                e.preventDefault();
                void handleDeleteProfile();
              }}
              disabled={isDeleting}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {isDeleting
                ? t('settings:apiProfiles.dialog.deleting')
                : t('settings:apiProfiles.dialog.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
