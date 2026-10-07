import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Check, ExternalLink } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { SettingsRow } from "./settings/SettingsRow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { AppUpdateAvailableEvent, AppUpdateProgress } from "../../shared/types";

const CLAUDE_CODE_CHANGELOG_URL =
  "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

// createSafeLink - factory function that creates a SafeLink component with i18n support
const createSafeLink = (opensInNewWindowText: string) => {
  return function SafeLink({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    // Validate URL - only allow http, https, and relative links
    const isValidUrl =
      href &&
      (href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("/") ||
        href.startsWith("#"));

    if (!isValidUrl) {
      // For invalid or potentially malicious URLs, render as plain text
      return <span className="text-muted-foreground">{children}</span>;
    }

    // External links get security attributes and accessibility indicator
    const isExternal = href?.startsWith("http://") || href?.startsWith("https://");

    return (
      <a
        href={href}
        {...props}
        {...(isExternal && {
          target: "_blank",
          rel: "noopener noreferrer",
        })}
        className="text-primary hover:underline"
      >
        {children}
        {isExternal && <span className="sr-only"> {opensInNewWindowText}</span>}
      </a>
    );
  };
};

/**
 * App Update Notification Dialog
 * Shows when a new app version is available and handles download/install workflow
 */
export function AppUpdateNotification() {
  const { t } = useTranslation(["dialogs", "common"]);
  const [isOpen, setIsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateAvailableEvent | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateProgress | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);

  // Create markdown components with translated accessibility text
  const markdownComponents: Components = useMemo(
    () => ({
      a: createSafeLink(t("common:accessibility.opensInNewWindow")),
    }),
    [t]
  );

  // Listen for update available event
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateAvailable((info) => {
      setUpdateInfo(info);
      setIsOpen(true);
      setIsDownloading(false);
      setIsDownloaded(false);
      setDownloadProgress(null);
      setDownloadError(null);
      setShowReadOnlyWarning(false);
    });

    return cleanup;
  }, []);

  // Listen for update downloaded event
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateDownloaded((_info) => {
      setIsDownloading(false);
      setIsDownloaded(true);
      setDownloadProgress(null);
      setDownloadError(null);
      setShowReadOnlyWarning(false);
    });

    return cleanup;
  }, []);

  // Listen for download progress
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateProgress((progress) => {
      setDownloadProgress(progress);
    });

    return cleanup;
  }, []);

  // Listen for update errors (e.g., install failures)
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateError((error) => {
      setDownloadError(error.message);
      setIsDownloading(false);
      setDownloadProgress(null);
    });

    return cleanup;
  }, []);

  // Listen for read-only volume warning (when trying to install from DMG on macOS)
  useEffect(() => {
    const cleanup = window.electronAPI.onAppUpdateReadOnlyVolume(() => {
      setShowReadOnlyWarning(true);
    });

    return cleanup;
  }, []);

  const handleDownload = async () => {
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const result = await window.electronAPI.downloadAppUpdate();
      if (!result.success) {
        setDownloadError(
          result.error || t("dialogs:appUpdate.downloadError", "Failed to download update")
        );
        setIsDownloading(false);
      }
    } catch (error) {
      console.error("Failed to download app update:", error);
      setDownloadError(t("dialogs:appUpdate.downloadError", "Failed to download update"));
      setIsDownloading(false);
    }
  };

  const handleInstall = () => {
    window.electronAPI.installAppUpdate();
  };

  const handleDismiss = () => {
    setIsOpen(false);
  };

  const handleSkipVersion = async () => {
    try {
      if (updateInfo) {
        await window.electronAPI.skipAppUpdate(updateInfo.version);
      }
    } catch {
      // Skip is best-effort; close the dialog regardless
    }
    setIsOpen(false);
  };

  const handleRemindLater = async () => {
    try {
      await window.electronAPI.snoozeAppUpdate();
    } catch {
      // Snooze is best-effort; close the dialog regardless
    }
    setIsOpen(false);
  };

  if (!updateInfo) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("dialogs:appUpdate.title", "App update available")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "dialogs:appUpdate.description",
              "A new version of Auto Claude is ready to download"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 mt-4 min-h-0 space-y-4 overflow-y-auto px-6">
          {/* Version Info */}
          <SettingsRow
            className="py-0"
            label={t("dialogs:appUpdate.newVersion", "New version")}
            description={
              updateInfo.releaseDate
                ? `${t("dialogs:appUpdate.released", "Released")} ${new Date(updateInfo.releaseDate).toLocaleDateString()}`
                : undefined
            }
          >
            <span className="flex items-center gap-1.5 text-sm text-foreground">
              {updateInfo.version}
              {isDownloaded ? (
                <Check className="h-4 w-4 text-success" />
              ) : isDownloading ? (
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </span>
          </SettingsRow>

          {/* Release Notes */}
          {updateInfo.releaseNotes && (
            <div className="max-h-64 overflow-y-auto rounded-xl border border-border px-4 py-3 text-sm">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, rehypeSanitize]}
                  components={markdownComponents}
                >
                  {updateInfo.releaseNotes}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {/* Claude Code Changelog Link */}
          <Button
            variant="link"
            size="sm"
            className="w-full text-xs text-muted-foreground gap-1"
            onClick={() => window.electronAPI.openExternal(CLAUDE_CODE_CHANGELOG_URL)}
            aria-label={t(
              "dialogs:appUpdate.claudeCodeChangelogAriaLabel",
              "View Claude Code changelog (opens in new window)"
            )}
          >
            {t("dialogs:appUpdate.claudeCodeChangelog", "View Claude Code changelog")}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Button>

          {/* Download Progress */}
          {isDownloading && downloadProgress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("dialogs:appUpdate.downloading", "Downloading...")}
                </span>
                <span className="text-foreground font-medium">
                  {Math.round(downloadProgress.percent)}%
                </span>
              </div>
              <Progress value={downloadProgress.percent} className="h-2" />
              <p className="text-xs text-muted-foreground text-right">
                {(downloadProgress.transferred / 1024 / 1024).toFixed(2)} MB /{" "}
                {(downloadProgress.total / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          )}

          {/* Download Error */}
          {downloadError && (
            <p className="text-sm text-destructive" role="alert">
              {downloadError}
            </p>
          )}

          {/* Read-Only Volume Warning (DMG install on macOS) */}
          {showReadOnlyWarning && (
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              <div className="space-y-1">
                <p className="text-foreground">
                  {t("dialogs:appUpdate.readOnlyVolumeTitle", "Cannot install from disk image")}
                </p>
                <p className="text-muted-foreground">
                  {t("dialogs:appUpdate.readOnlyVolumeDescription", "Please move Auto Claude to your Applications folder before updating.")}
                </p>
              </div>
            </div>
          )}

          {/* Downloaded Success */}
          {isDownloaded && !showReadOnlyWarning && (
            <div className="flex items-center gap-3 rounded-xl bg-segment-track px-4 py-3 text-sm">
              <Check className="h-4 w-4 shrink-0 text-success" />
              <span>
                {t(
                  "dialogs:appUpdate.updateDownloaded",
                  "Update downloaded successfully! Click Install to restart and apply the update."
                )}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isDownloading && (
            <Button variant="ghost" size="sm" onClick={handleSkipVersion} className="text-muted-foreground sm:mr-auto">
              {t("dialogs:appUpdate.skipThisVersion", "Skip this version")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={isDownloaded ? handleDismiss : handleRemindLater} disabled={isDownloading}>
            {isDownloaded
              ? t("dialogs:appUpdate.installLater", "Install later")
              : t("dialogs:appUpdate.remindMeLater", "Remind me later")}
          </Button>

          {isDownloaded ? (
            <Button size="sm" onClick={handleInstall} disabled={showReadOnlyWarning}>
              {t("dialogs:appUpdate.installAndRestart", "Install and restart")}
            </Button>
          ) : (
            <Button size="sm" onClick={handleDownload} disabled={isDownloading}>
              {isDownloading ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("dialogs:appUpdate.downloading", "Downloading...")}
                </>
              ) : (
                t("dialogs:appUpdate.downloadUpdate", "Download update")
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
