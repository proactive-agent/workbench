import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import type { Project, GitStatus } from '../../shared/types';

interface GitSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  gitStatus: GitStatus | null;
  onGitInitialized: () => void;
  onSkip?: () => void;
}

export function GitSetupModal({
  open,
  onOpenChange,
  project,
  gitStatus,
  onGitInitialized,
  onSkip
}: GitSetupModalProps) {
  const { t } = useTranslation('dialogs');
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'info' | 'initializing' | 'success'>('info');

  const needsGitInit = gitStatus && !gitStatus.isGitRepo;
  const _needsCommit = gitStatus?.isGitRepo && !gitStatus.hasCommits;

  const handleInitializeGit = async () => {
    if (!project) return;

    setIsInitializing(true);
    setError(null);
    setStep('initializing');

    try {
      // Call the backend to initialize git
      const result = await window.electronAPI.initializeGit(project.path);

      if (result.success) {
        setStep('success');
        // Wait a moment to show success, then trigger callback
        setTimeout(() => {
          onGitInitialized();
          onOpenChange(false);
          setStep('info');
        }, 1500);
      } else {
        setError(result.error || 'Failed to initialize git');
        setStep('info');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize git');
      setStep('info');
    } finally {
      setIsInitializing(false);
    }
  };

  const handleSkip = () => {
    onSkip?.();
    onOpenChange(false);
  };

  const renderInfoStep = () => (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('gitSetup.title')}
        </DialogTitle>
        <DialogDescription>
          {t('gitSetup.description')}
        </DialogDescription>
      </DialogHeader>

      <div className="pt-4 space-y-4">
        {/* Status */}
        <div className="rounded-xl bg-segment-track px-4 py-3 text-sm space-y-1">
          <p className="text-foreground">
            {needsGitInit
              ? t('gitSetup.notGitRepo')
              : t('gitSetup.noCommits')}
          </p>
          <p className="text-muted-foreground">
            {needsGitInit
              ? t('gitSetup.needsInit')
              : t('gitSetup.needsCommit')}
          </p>
        </div>

        {/* What will happen */}
        <div className="text-sm">
          <p className="text-foreground mb-2">{t('gitSetup.willSetup')}</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            {needsGitInit && <li>{t('gitSetup.initRepo')}</li>}
            <li>{t('gitSetup.createCommit')}</li>
          </ul>
        </div>

        {/* Manual instructions for advanced users */}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {t('gitSetup.manual')}
          </summary>
          <div className="mt-3 rounded-xl bg-segment-track px-4 py-3 font-mono text-xs space-y-1">
            <p className="text-muted-foreground">{t('gitSetup.manualInstructions')}</p>
            {needsGitInit && <p>git init</p>}
            <p>git add .</p>
            <p>git commit -m "Initial commit"</p>
          </div>
        </details>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={handleSkip}>
          {t('gitSetup.skipForNow')}
        </Button>
        <Button size="sm" onClick={handleInitializeGit} disabled={isInitializing}>
          {t('gitSetup.initializeGit')}
        </Button>
      </DialogFooter>
    </>
  );

  const renderInitializingStep = () => (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('gitSetup.settingUp')}
        </DialogTitle>
      </DialogHeader>

      <div className="py-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('gitSetup.initializingRepo')}
      </div>
    </>
  );

  const renderSuccessStep = () => (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('gitSetup.success')}
        </DialogTitle>
      </DialogHeader>

      <div className="py-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Check className="h-4 w-4 text-success" />
        {t('gitSetup.readyToUse')}
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === 'info' && renderInfoStep()}
        {step === 'initializing' && renderInitializingStep()}
        {step === 'success' && renderSuccessStep()}
      </DialogContent>
    </Dialog>
  );
}
