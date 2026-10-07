import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface WizardStep {
  id: string;
  label: string;
  completed: boolean;
}

interface WizardProgressProps {
  currentStep: number;
  steps: WizardStep[];
}

/**
 * Step progress indicator component for the onboarding wizard.
 * Small neutral step markers connected by hairlines: completed steps show a check,
 * the current step is filled, upcoming steps are outlined.
 */
export function WizardProgress({ currentStep, steps }: WizardProgressProps) {
  return (
    <div className="flex items-center justify-center">
      {steps.map((step, index) => {
        const isCompleted = step.completed;
        const isCurrent = index === currentStep;
        const isUpcoming = index > currentStep;

        return (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-xs transition-colors duration-200',
                  isCompleted && 'bg-nav-active text-foreground',
                  isCurrent && !isCompleted && 'bg-foreground text-background',
                  isUpcoming && !isCompleted && 'border border-border text-muted-foreground'
                )}
              >
                {isCompleted ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={2} />
                ) : (
                  <span>{index + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  'mt-2 max-w-[88px] truncate text-center text-xs',
                  isCurrent ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {step.label}
              </span>
            </div>

            {/* Connecting line (not after last step) */}
            {index < steps.length - 1 && (
              <div className="mx-2 mb-6 h-px w-12 bg-settings-divider" />
            )}
          </div>
        );
      })}
    </div>
  );
}
