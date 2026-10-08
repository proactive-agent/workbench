import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Loader2,
  Download,
  RefreshCw
} from "lucide-react";
import { ExternalLink } from "../ui/external-link";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { cn } from "../../lib/utils";
import { SettingsSection } from "./SettingsSection";
import { SettingsRow, SettingsRows } from "./SettingsRow";
import type { ClaudeCodeVersionInfo } from "../../../shared/types/cli";

type StatusType = "loading" | "installed" | "outdated" | "not-found" | "error";

/** True when version a is newer than version b (numeric dot-separated comparison, "v" prefix ignored) */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Check every 24 hours
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Delay before re-checking version after install/update
const VERSION_RECHECK_DELAY_MS = 5000;

/**
 * Claude Code CLI settings: installation status, install/update and version switching.
 */
export function ClaudeCodeSettings() {
  const { t } = useTranslation(["common", "navigation"]);
  const [status, setStatus] = useState<StatusType>("loading");
  const [versionInfo, setVersionInfo] = useState<ClaudeCodeVersionInfo | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [showUpdateWarning, setShowUpdateWarning] = useState(false);

  // Version rollback state
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  // npm release channels (latest, next, stable) → version
  const [distTags, setDistTags] = useState<Record<string, string>>({});
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [showRollbackWarning, setShowRollbackWarning] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Check Claude Code version
  const checkVersion = useCallback(async (forceRefresh = false) => {
    try {
      if (!window.electronAPI?.checkClaudeCodeVersion) {
        setStatus("error");
        return;
      }

      const result = await window.electronAPI.checkClaudeCodeVersion(forceRefresh);

      if (result.success && result.data) {
        setVersionInfo(result.data);
        setLastChecked(new Date());

        if (!result.data.installed) {
          setStatus("not-found");
        } else if (result.data.isOutdated) {
          setStatus("outdated");
        } else {
          setStatus("installed");
        }
      } else {
        setStatus("error");
      }
    } catch (err) {
      console.error("Failed to check Claude Code version:", err);
      setStatus("error");
    }
  }, []);

  // Fetch available versions
  const fetchVersions = useCallback(async () => {
    if (!window.electronAPI?.getClaudeCodeVersions) {
      return;
    }

    setIsLoadingVersions(true);
    setVersionsError(null);

    try {
      const result = await window.electronAPI.getClaudeCodeVersions();
      if (result.success && result.data) {
        setAvailableVersions(result.data.versions);
        setDistTags(result.data.distTags ?? {});
      } else {
        setVersionsError(result.error || "Failed to load versions");
      }
    } catch (err) {
      console.error("Failed to fetch versions:", err);
      setVersionsError("Failed to load versions");
    } finally {
      setIsLoadingVersions(false);
    }
  }, []);

  // Initial check and periodic re-check
  useEffect(() => {
    checkVersion();

    // Set up periodic check
    const interval = setInterval(() => {
      checkVersion();
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [checkVersion]);

  // Load the version list once Claude Code is known to be installed
  useEffect(() => {
    if (versionInfo?.installed && availableVersions.length === 0) {
      fetchVersions();
    }
  }, [versionInfo?.installed, availableVersions.length, fetchVersions]);

  // Perform the actual install/update
  const performInstall = async () => {
    setIsInstalling(true);
    setShowUpdateWarning(false);
    setInstallError(null);
    try {
      if (!window.electronAPI?.installClaudeCode) {
        setInstallError("Installation not available");
        setIsInstalling(false);
        return;
      }

      const result = await window.electronAPI.installClaudeCode();

      if (result.success) {
        // Re-check after a delay
        setTimeout(() => {
          checkVersion();
        }, VERSION_RECHECK_DELAY_MS);
      } else {
        setInstallError(result.error || "Installation failed");
      }
    } catch (err) {
      console.error("Failed to install Claude Code:", err);
      setInstallError(err instanceof Error ? err.message : "Installation failed");
    } finally {
      setIsInstalling(false);
    }
  };

  // Perform version rollback/switch
  const performVersionSwitch = async () => {
    if (!selectedVersion) return;

    setIsInstalling(true);
    setShowRollbackWarning(false);
    setInstallError(null);

    try {
      if (!window.electronAPI?.installClaudeCodeVersion) {
        setInstallError("Version switching not available");
        return;
      }

      const result = await window.electronAPI.installClaudeCodeVersion(selectedVersion);

      if (result.success) {
        // Re-check after a delay
        setTimeout(() => {
          checkVersion();
        }, VERSION_RECHECK_DELAY_MS);
      } else {
        setInstallError(result.error || "Failed to switch version");
      }
    } catch (err) {
      console.error("Failed to switch Claude Code version:", err);
      setInstallError(err instanceof Error ? err.message : "Failed to switch version");
    } finally {
      setIsInstalling(false);
      setSelectedVersion(null);
    }
  };

  // Handle install/update button click
  const handleInstall = () => {
    if (status === "outdated") {
      // Show warning for updates since it will close running Claude sessions
      setShowUpdateWarning(true);
    } else {
      // Fresh install - no warning needed
      performInstall();
    }
  };


  // Normalize version string by removing 'v' prefix for comparison
  const normalizeVersion = (v: string) => v.replace(/^v/, '');

  // Handle version selection
  const handleVersionSelect = (version: string) => {
    // Don't do anything if it's the currently installed version (normalize both for comparison)
    const normalizedSelected = normalizeVersion(version);
    const normalizedInstalled = versionInfo?.installed ? normalizeVersion(versionInfo.installed) : '';
    if (normalizedSelected === normalizedInstalled) {
      return;
    }
    setInstallError(null);
    setSelectedVersion(version);
    setShowRollbackWarning(true);
  };

  // A pre-release ("next" channel) newer than the installed version: "up to date" refers to the
  // latest release, so mention the pre-release instead of implying nothing newer exists
  const newerPrerelease =
    distTags.next && versionInfo?.installed && isNewerVersion(distTags.next, versionInfo.installed)
      ? normalizeVersion(distTags.next)
      : null;

  // Channel labels for the version list (e.g. "Next" for the current pre-release)
  const channelLabels = (version: string): string[] =>
    (["latest", "next", "stable"] as const)
      .filter((channel) => distTags[channel] && normalizeVersion(distTags[channel]) === normalizeVersion(version))
      .map((channel) => t(`navigation:claudeCode.channels.${channel}`));

  const statusText = {
    loading: t("navigation:claudeCode.checking"),
    installed: newerPrerelease
      ? t("navigation:claudeCode.upToDateWithPrerelease", { version: newerPrerelease })
      : t("navigation:claudeCode.upToDate"),
    outdated: t("navigation:claudeCode.updateAvailable"),
    "not-found": t("navigation:claudeCode.notInstalled"),
    error: t("navigation:claudeCode.error"),
  }[status];

  // The version list entry matching the installed version (entries may carry a "v" prefix)
  const currentVersionOption = versionInfo?.installed
    ? availableVersions.find((v) => normalizeVersion(v) === normalizeVersion(versionInfo.installed || "")) ?? versionInfo.installed
    : "";

  return (
    <SettingsSection
      title={t("navigation:claudeCode.title")}
      description={t("navigation:claudeCode.description")}
    >
      <SettingsRows>
        {/* Status + install/update/refresh */}
        <SettingsRow
          label={t("navigation:claudeCode.status")}
          description={statusText}
        >
          {(status === "not-found" || status === "outdated") && (
            <Button size="sm" className="gap-1.5" onClick={handleInstall} disabled={isInstalling}>
              {isInstalling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {status === "outdated" ? t("navigation:claudeCode.update") : t("navigation:claudeCode.install")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => checkVersion(true)}
            disabled={status === "loading"}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", status === "loading" && "animate-spin")} />
            {t("navigation:claudeCode.refresh")}
          </Button>
        </SettingsRow>

        {/* Installed version + switching */}
        {versionInfo?.installed && (
          <SettingsRow
            label={t("navigation:claudeCode.version")}
            description={
              <span>
                {[
                  versionInfo.latest && versionInfo.latest !== "unknown"
                    ? `${t("navigation:claudeCode.latest")} ${versionInfo.latest}`
                    : null,
                  lastChecked ? `${t("navigation:claudeCode.lastChecked")} ${lastChecked.toLocaleTimeString()}` : null,
                  versionsError ? t("navigation:claudeCode.failedToLoadVersions") : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            }
          >
            {/* Shows the installed version; picking another one asks for confirmation before switching */}
            <Select
              value={selectedVersion ?? currentVersionOption}
              onValueChange={handleVersionSelect}
              disabled={isLoadingVersions || isInstalling}
            >
              <SelectTrigger className="w-48" aria-label={t("navigation:claudeCode.switchVersion")}>
                <SelectValue>
                  <span className="font-mono">{selectedVersion ?? versionInfo.installed}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {availableVersions.map((version) => {
                  const isCurrentVersion = normalizeVersion(version) === normalizeVersion(versionInfo.installed || "");
                  const labels = [
                    ...(isCurrentVersion ? [t("navigation:claudeCode.currentVersion")] : []),
                    ...channelLabels(version),
                  ];
                  return (
                    <SelectItem key={version} value={version}>
                      <span className="font-mono">{version}</span>
                      {labels.length > 0 && (
                        <span className="ml-2 text-muted-foreground">({labels.join(" · ")})</span>
                      )}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}

        {/* Changelog */}
        <SettingsRow label={t("navigation:claudeCode.changelog")}>
          <ExternalLink
            href="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md"
            aria-label={t("navigation:claudeCode.viewChangelogAriaLabel")}
          >
            {t("navigation:claudeCode.viewChangelog")}
          </ExternalLink>
        </SettingsRow>
      </SettingsRows>

      {/* Install/Update error display */}
      {installError && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-segment-track px-4 py-3 text-sm text-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--error)]" strokeWidth={1.75} />
          <span>{installError}</span>
        </div>
      )}

      {/* Update warning dialog */}
      <AlertDialog open={showUpdateWarning} onOpenChange={setShowUpdateWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("navigation:claudeCode.updateWarningTitle", "Update Claude Code?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "navigation:claudeCode.updateWarningDescription",
                "Updating will close all running Claude Code sessions. Any unsaved work in those sessions may be lost. Make sure to save your work before proceeding."
              )}
              <span className="block mt-2 font-semibold text-foreground">
                {t(
                  "navigation:claudeCode.updateWarningTerminalNote",
                  "A terminal window will open to run the installation command. Please wait for the installation to complete before continuing."
                )}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:buttons.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={performInstall}>
              {t("navigation:claudeCode.updateAnyway", "Open Terminal & Update")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Version rollback warning dialog */}
      <AlertDialog open={showRollbackWarning} onOpenChange={setShowRollbackWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("navigation:claudeCode.rollbackWarningTitle", "Switch to version {{version}}?", {
                version: selectedVersion,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "navigation:claudeCode.rollbackWarningDescription",
                "Switching versions will close all running Claude Code sessions. Any unsaved work in those sessions may be lost. Make sure to save your work before proceeding."
              )}
              <span className="block mt-2 font-semibold text-foreground">
                {t(
                  "navigation:claudeCode.rollbackWarningTerminalNote",
                  "A terminal window will open to run the installation command. Please wait for the installation to complete before continuing."
                )}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedVersion(null)}>
              {t("common:buttons.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={performVersionSwitch}>
              {t("navigation:claudeCode.switchAnyway", "Open Terminal & Switch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </SettingsSection>
  );
}
