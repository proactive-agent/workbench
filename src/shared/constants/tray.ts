/**
 * System tray (background mode) constants.
 * Labels are keyed by app language (main-process menus can't use react-i18next).
 */

export interface TrayMenuLabels {
  tooltip: string;
  showApp: string;
  /** e.g. "Max plan"; `{{plan}}` is the capitalized subscription type */
  plan: string;
  /** Current 5-hour session usage */
  usage: string;
  quit: string;
}

export const TRAY_MENU_LABELS: Record<string, TrayMenuLabels> = {
  en: {
    tooltip: 'Auto Claude',
    showApp: 'Show App',
    plan: '{{plan}} plan',
    usage: 'Usage: {{percent}}%',
    quit: 'Quit'
  }
};
