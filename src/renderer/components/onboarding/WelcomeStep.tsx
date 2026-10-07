import { Sparkles, Zap, Brain, FileCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';

interface WelcomeStepProps {
  onGetStarted: () => void;
  onSkip: () => void;
}

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="mt-0.5 shrink-0 text-muted-foreground">{icon}</div>
      <div>
        <h3 className="text-sm text-foreground">{title}</h3>
        <p className="mt-0.5 text-sm text-(--nav-label-color)">{description}</p>
      </div>
    </div>
  );
}

/**
 * Welcome step component for the onboarding wizard.
 * Displays a welcome message with a feature overview and actions to get started or skip.
 */
export function WelcomeStep({ onGetStarted, onSkip }: WelcomeStepProps) {
  const { t } = useTranslation('onboarding');

  const features = [
    {
      icon: <Sparkles className="h-4 w-4" strokeWidth={1.75} />,
      title: t('welcome.features.aiPowered.title'),
      description: t('welcome.features.aiPowered.description')
    },
    {
      icon: <FileCode className="h-4 w-4" strokeWidth={1.75} />,
      title: t('welcome.features.specDriven.title'),
      description: t('welcome.features.specDriven.description')
    },
    {
      icon: <Brain className="h-4 w-4" strokeWidth={1.75} />,
      title: t('welcome.features.memory.title'),
      description: t('welcome.features.memory.description')
    },
    {
      icon: <Zap className="h-4 w-4" strokeWidth={1.75} />,
      title: t('welcome.features.parallel.title'),
      description: t('welcome.features.parallel.description')
    }
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-6">
      <div className="w-full max-w-2xl">
        {/* Hero Section */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">
            {t('welcome.title')}
          </h1>
          <p className="mt-3 text-muted-foreground">
            {t('welcome.subtitle')}
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 mb-10">
          {features.map((feature, index) => (
            <FeatureCard
              key={index}
              icon={feature.icon}
              title={feature.title}
              description={feature.description}
            />
          ))}
        </div>

        {/* Description */}
        <div className="text-center mb-8">
          <p className="text-sm text-muted-foreground">
            {t('wizard.helpText')}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <Button
            onClick={onGetStarted}
            className="px-6"
          >
            {t('welcome.getStarted')}
          </Button>
          <Button
            variant="ghost"
            onClick={onSkip}
          >
            {t('welcome.skip')}
          </Button>
        </div>
      </div>
    </div>
  );
}
