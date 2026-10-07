import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Textarea } from '../../ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog';

interface CreateMergeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  defaultSourceBranch?: string;
  defaultTargetBranch?: string;
  onSuccess?: (mrIid: number) => void;
}

export function CreateMergeRequestDialog({
  open,
  onOpenChange,
  projectId,
  defaultSourceBranch = '',
  defaultTargetBranch = 'main',
  onSuccess
}: CreateMergeRequestDialogProps) {
  const { t } = useTranslation(['gitlab', 'common']);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sourceBranch, setSourceBranch] = useState(defaultSourceBranch);
  const [targetBranch, setTargetBranch] = useState(defaultTargetBranch);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim() || !sourceBranch.trim() || !targetBranch.trim()) {
      setError(t('gitlab:mergeRequests.create.requiredError'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const result = await window.electronAPI.createGitLabMergeRequest(projectId, {
        sourceBranch: sourceBranch.trim(),
        targetBranch: targetBranch.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
      });

      if (result.success && result.data) {
        onSuccess?.(result.data.iid);
        onOpenChange(false);
        // Reset form
        setTitle('');
        setDescription('');
        setSourceBranch(defaultSourceBranch);
        setTargetBranch(defaultTargetBranch);
      } else {
        setError(result.error || t('gitlab:mergeRequests.create.failed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gitlab:mergeRequests.create.failed'));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {t('gitlab:mergeRequests.create.title')}
          </DialogTitle>
          <DialogDescription>
            {t('gitlab:mergeRequests.create.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="title">{t('gitlab:mergeRequests.create.titleLabel')}</Label>
            <Input
              id="title"
              placeholder={t('gitlab:mergeRequests.create.titlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="source">{t('gitlab:mergeRequests.create.sourceBranch')}</Label>
              <Input
                id="source"
                placeholder="feature/my-feature"
                value={sourceBranch}
                onChange={(e) => setSourceBranch(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="target">{t('gitlab:mergeRequests.create.targetBranch')}</Label>
              <Input
                id="target"
                placeholder="main"
                value={targetBranch}
                onChange={(e) => setTargetBranch(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t('gitlab:mergeRequests.create.descriptionLabel')}</Label>
            <Textarea
              id="description"
              placeholder={t('gitlab:mergeRequests.create.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:buttons.cancel')}
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('gitlab:mergeRequests.create.creating')}
              </>
            ) : (
              t('gitlab:mergeRequests.create.submit')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
