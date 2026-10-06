interface SettingsSectionProps {
  title: string;
  /** Optional supporting text, rendered as subtle muted copy under the heading */
  description?: string;
  children: React.ReactNode;
}

/**
 * Reusable wrapper component for settings sections.
 * Renders a compact section heading (claude.ai style) followed by its content.
 */
export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-[1.0625rem] font-semibold leading-6 text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
