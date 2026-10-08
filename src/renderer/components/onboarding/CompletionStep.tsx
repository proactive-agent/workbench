import { FileText, BookOpen } from 'lucide-react';
import { SettingsIcon as Settings } from '../icons/app-icons';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { SettingsRows } from '../settings/SettingsRow';

interface CompletionStepProps {
  onFinish: () => void;
  onOpenTaskCreator?: () => void;
  onOpenSettings?: () => void;
}

interface NextStepCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: () => void;
  actionLabel?: string;
}

function NextStepCard({ icon, title, description, action, actionLabel }: NextStepCardProps) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="shrink-0 text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm text-foreground">{title}</h3>
        <p className="mt-0.5 text-sm text-(--nav-label-color)">{description}</p>
      </div>
      {action && actionLabel && (
        <Button variant="outline" size="sm" onClick={action} className="shrink-0">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Completion step component for the onboarding wizard.
 * Displays a success message with suggestions for next steps
 * and a prominent "Finish" button to complete the wizard.
 */
export function CompletionStep({
  onFinish,
  onOpenTaskCreator,
  onOpenSettings
}: CompletionStepProps) {
  const { t } = useTranslation('onboarding');

  const nextSteps = [
    {
      icon: <FileText className="h-4 w-4" strokeWidth={1.75} />,
      title: t('completion.createTask.title'),
      description: t('completion.createTask.description'),
      action: onOpenTaskCreator,
      actionLabel: t('completion.createTask.action')
    },
    {
      icon: <Settings className="h-4 w-4" />,
      title: t('completion.customizeSettings.title'),
      description: t('completion.customizeSettings.description'),
      action: onOpenSettings,
      actionLabel: t('completion.customizeSettings.action')
    },
    {
      icon: <BookOpen className="h-4 w-4" strokeWidth={1.75} />,
      title: t('completion.exploreDocs.title'),
      description: t('completion.exploreDocs.description')
    }
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-6">
      <div className="w-full max-w-2xl">
        {/* Success hero */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">
            {t('completion.title')}
          </h1>
          <p className="mt-3 text-muted-foreground">
            {t('completion.subtitle')}
          </p>
        </div>

        {/* Completion message */}
        <div className="flex items-start gap-3 rounded-xl bg-segment-track px-4 py-3 text-sm mb-8">
          <div className="flex-1">
            <p className="text-foreground">
              {t('completion.setupComplete')}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {t('completion.setupCompleteDescription')}
            </p>
          </div>
        </div>

        {/* Next steps */}
        <div className="mb-10">
          <h2 className="text-[15px] font-semibold text-foreground">
            {t('completion.whatsNext')}
          </h2>
          <SettingsRows className="mt-1">
            {nextSteps.map((step, index) => (
              <NextStepCard
                key={index}
                icon={step.icon}
                title={step.title}
                description={step.description}
                action={step.action}
                actionLabel={step.actionLabel}
              />
            ))}
          </SettingsRows>
        </div>

        {/* Finish button */}
        <div className="flex flex-col items-center gap-3">
          <Button onClick={onFinish} className="px-8">
            {t('completion.finish')}
          </Button>
          <p className="text-sm text-muted-foreground text-center">
            {t('completion.rerunHint')}
          </p>
        </div>
      </div>
    </div>
  );
}
