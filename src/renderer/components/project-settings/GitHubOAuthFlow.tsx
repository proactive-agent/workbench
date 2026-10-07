import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Github, Loader2, ExternalLink, Copy, Check } from 'lucide-react';
import { Button } from '../ui/button';

interface GitHubOAuthFlowProps {
  onSuccess: (token: string, username?: string) => void;
  onCancel?: () => void;
}

// Debug logging helper - logs when DEBUG env var is set or in development
const DEBUG = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true';

function debugLog(message: string, data?: unknown) {
  if (DEBUG) {
    if (data !== undefined) {
      console.warn(`[GitHubOAuth] ${message}`, data);
    } else {
      console.warn(`[GitHubOAuth] ${message}`);
    }
  }
}

// Authentication timeout in milliseconds (5 minutes)
// GitHub device codes typically expire after 15 minutes, but 5 minutes is a reasonable UX timeout
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * GitHub OAuth flow component using gh CLI
 * Guides users through authenticating with GitHub using the gh CLI
 */
export function GitHubOAuthFlow({ onSuccess, onCancel }: GitHubOAuthFlowProps) {
  const { t } = useTranslation(['dialogs', 'common']);
  const [status, setStatus] = useState<'checking' | 'need-install' | 'need-auth' | 'authenticating' | 'success' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [_cliInstalled, setCliInstalled] = useState(false);
  const [cliVersion, setCliVersion] = useState<string | undefined>();
  const [username, setUsername] = useState<string | undefined>();

  // Device flow state for displaying code and auth URL
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [browserOpened, setBrowserOpened] = useState<boolean>(false);
  const [codeCopied, setCodeCopied] = useState<boolean>(false);
  const [urlCopied, setUrlCopied] = useState<boolean>(false);
  const [isTimeout, setIsTimeout] = useState<boolean>(false);

  // Ref to track authentication timeout
  const authTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refs to track copy feedback timeouts
  const codeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check gh CLI installation and authentication status on mount
  // Use a ref to prevent double-execution in React Strict Mode
  const hasCheckedRef = useRef(false);

  // Clear the authentication timeout
  const clearAuthTimeout = useCallback(() => {
    if (authTimeoutRef.current) {
      debugLog('Clearing auth timeout');
      clearTimeout(authTimeoutRef.current);
      authTimeoutRef.current = null;
    }
  }, []);

  // Cleanup copy feedback timeouts on unmount
  useEffect(() => {
    return () => {
      if (codeCopyTimeoutRef.current) {
        clearTimeout(codeCopyTimeoutRef.current);
      }
      if (urlCopyTimeoutRef.current) {
        clearTimeout(urlCopyTimeoutRef.current);
      }
    };
  }, []);

  // Handle authentication timeout
  const handleAuthTimeout = useCallback(() => {
    debugLog('Authentication timeout triggered after 5 minutes');
    setIsTimeout(true);
    setError('Authentication timed out. The authentication window was open for too long. Please try again.');
    setStatus('error');
    authTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    if (hasCheckedRef.current) {
      debugLog('Skipping duplicate check (Strict Mode)');
      return;
    }
    hasCheckedRef.current = true;
    debugLog('Component mounted, checking GitHub status...');
    checkGitHubStatus();

    // Cleanup timeout on unmount
    return () => {
      clearAuthTimeout();
    };
  }, [clearAuthTimeout]);

  // Listen for device code events from the main process
  // This allows us to display the code IMMEDIATELY when extracted, not after the auth completes
  useEffect(() => {
    if (status !== 'authenticating') {
      return;
    }

    debugLog('Setting up device code event listener');

    // Listen for device code from main process (sent immediately when extracted)
    const cleanup = window.electronAPI.onGitHubAuthDeviceCode((data) => {
      debugLog('Received device code from main process:', {
        hasCode: !!data.deviceCode,
        authUrl: data.authUrl,
        browserOpened: data.browserOpened
      });

      if (data.deviceCode) {
        setDeviceCode(data.deviceCode);
      }
      if (data.authUrl) {
        setAuthUrl(data.authUrl);
      }
      setBrowserOpened(data.browserOpened);
    });

    return () => {
      debugLog('Cleaning up device code event listener');
      cleanup();
    };
  }, [status]);

  const checkGitHubStatus = async () => {
    debugLog('checkGitHubStatus() called');
    setStatus('checking');
    setError(null);

    try {
      // Check if gh CLI is installed
      debugLog('Calling checkGitHubCli...');
      const cliResult = await window.electronAPI.checkGitHubCli();
      debugLog('checkGitHubCli result:', cliResult);

      if (!cliResult.success) {
        debugLog('checkGitHubCli failed:', cliResult.error);
        setError(cliResult.error || 'Failed to check GitHub CLI');
        setStatus('error');
        return;
      }

      if (!cliResult.data?.installed) {
        debugLog('GitHub CLI not installed');
        setStatus('need-install');
        setCliInstalled(false);
        return;
      }

      setCliInstalled(true);
      setCliVersion(cliResult.data.version);
      debugLog('GitHub CLI installed, version:', cliResult.data.version);

      // Check if already authenticated
      debugLog('Calling checkGitHubAuth...');
      const authResult = await window.electronAPI.checkGitHubAuth();
      debugLog('checkGitHubAuth result:', authResult);

      if (authResult.success && authResult.data?.authenticated) {
        debugLog('Already authenticated as:', authResult.data.username);
        setUsername(authResult.data.username);
        // Get the token and notify parent
        await fetchAndNotifyToken();
      } else {
        debugLog('Not authenticated, showing auth prompt');
        setStatus('need-auth');
      }
    } catch (err) {
      debugLog('Error in checkGitHubStatus:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  const fetchAndNotifyToken = async () => {
    debugLog('fetchAndNotifyToken() called');
    try {
      debugLog('Calling getGitHubToken...');
      const tokenResult = await window.electronAPI.getGitHubToken();
      debugLog('getGitHubToken result:', {
        success: tokenResult.success,
        hasToken: !!tokenResult.data?.token,
        tokenLength: tokenResult.data?.token?.length,
        error: tokenResult.error
      });

      if (tokenResult.success && tokenResult.data?.token) {
        debugLog('Token retrieved successfully, calling onSuccess with username:', username);
        setStatus('success');
        onSuccess(tokenResult.data.token, username);
      } else {
        debugLog('Failed to get token:', tokenResult.error);
        setError(tokenResult.error || 'Failed to get token');
        setStatus('error');
      }
    } catch (err) {
      debugLog('Error in fetchAndNotifyToken:', err);
      setError(err instanceof Error ? err.message : 'Failed to get token');
      setStatus('error');
    }
  };

  const handleStartAuth = async () => {
    debugLog('handleStartAuth() called');
    setStatus('authenticating');
    setError(null);

    // Reset device flow state
    setDeviceCode(null);
    setAuthUrl(null);
    setBrowserOpened(false);
    setCodeCopied(false);
    setUrlCopied(false);
    setIsTimeout(false);

    // Clear any existing timeout and start a new one
    clearAuthTimeout();
    debugLog(`Starting auth timeout (${AUTH_TIMEOUT_MS / 1000 / 60} minutes)`);
    authTimeoutRef.current = setTimeout(handleAuthTimeout, AUTH_TIMEOUT_MS);

    try {
      debugLog('Calling startGitHubAuth...');
      const result = await window.electronAPI.startGitHubAuth();
      debugLog('startGitHubAuth result:', result);

      // Clear timeout since we got a response
      clearAuthTimeout();

      // Capture device flow info if available
      if (result.data?.deviceCode) {
        debugLog('Device code received:', result.data.deviceCode);
        setDeviceCode(result.data.deviceCode);
      }
      if (result.data?.authUrl) {
        debugLog('Auth URL received:', result.data.authUrl);
        setAuthUrl(result.data.authUrl);
      }
      if (result.data?.browserOpened !== undefined) {
        debugLog('Browser opened status:', result.data.browserOpened);
        setBrowserOpened(result.data.browserOpened);
      }

      if (result.success && result.data?.success) {
        debugLog('Auth successful, fetching token...');
        // Fetch the token and notify parent
        await fetchAndNotifyToken();
      } else {
        debugLog('Auth failed:', result.error);
        // Include fallback URL info in error message if available
        const errorMessage = result.error || 'Authentication failed';
        setError(errorMessage);
        // Keep authUrl from response for fallback display
        if (result.data?.fallbackUrl) {
          setAuthUrl(result.data.fallbackUrl);
        }
        setStatus('error');
      }
    } catch (err) {
      // Clear timeout on error
      clearAuthTimeout();
      debugLog('Error in handleStartAuth:', err);
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setStatus('error');
    }
  };

  const handleOpenGhInstall = () => {
    debugLog('Opening gh CLI install page');
    window.open('https://cli.github.com/', '_blank');
  };

  const handleRetry = () => {
    debugLog('Retry clicked');
    checkGitHubStatus();
  };

  const handleCopyDeviceCode = async () => {
    if (!deviceCode) return;
    debugLog('Copying device code to clipboard');
    try {
      await navigator.clipboard.writeText(deviceCode);
      setCodeCopied(true);
      // Clear any existing timeout before setting a new one
      if (codeCopyTimeoutRef.current) {
        clearTimeout(codeCopyTimeoutRef.current);
      }
      // Reset the copied state after 2 seconds
      codeCopyTimeoutRef.current = setTimeout(() => setCodeCopied(false), 2000);
    } catch (err) {
      debugLog('Failed to copy device code:', err);
    }
  };

  const handleOpenAuthUrl = () => {
    if (authUrl) {
      debugLog('Opening auth URL manually:', authUrl);
      window.open(authUrl, '_blank');
    }
  };

  debugLog('Rendering with status:', status);

  return (
    <div className="space-y-4">
      {/* Checking status */}
      {status === 'checking' && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Need to install gh CLI */}
      {status === 'need-install' && (
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">
              {t('githubOAuth.cliRequiredTitle')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('githubOAuth.cliRequiredDescription')}
            </p>
          </div>

          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm text-muted-foreground">
            <p className="text-foreground mb-2">{t('githubOAuth.installInstructions')}</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>macOS: <code className="font-mono text-xs text-foreground">brew install gh</code></li>
              <li>Windows: <code className="font-mono text-xs text-foreground">winget install GitHub.cli</code></li>
              <li>
                {t('githubOAuth.linuxVisit')}{' '}
                <a href="https://cli.github.com/" target="_blank" rel="noopener noreferrer" className="text-foreground underline-offset-2 hover:underline">cli.github.com</a>
              </li>
            </ul>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleRetry}>
              {t('githubOAuth.installedIt')}
            </Button>
            <Button size="sm" onClick={handleOpenGhInstall} className="gap-1.5">
              {t('githubOAuth.installCli')}
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Need authentication */}
      {status === 'need-auth' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
            <p className="text-muted-foreground">
              {t('githubOAuth.authDescription')}
            </p>
            {cliVersion && (
              <p className="mt-1 text-muted-foreground">
                {t('githubOAuth.usingCli', { version: cliVersion })}
              </p>
            )}
          </div>

          <div className="flex justify-center">
            <Button onClick={handleStartAuth} size="sm" className="gap-1.5">
              <Github className="h-3.5 w-3.5" />
              {t('githubOAuth.authenticate')}
            </Button>
          </div>
        </div>
      )}

      {/* Authenticating */}
      {status === 'authenticating' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl bg-segment-track px-4 py-3 text-sm">
            <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground shrink-0" />
            <div className="flex-1">
              <p className="text-foreground">{t('githubOAuth.authenticating')}</p>
              <p className="text-muted-foreground mt-0.5">
                {browserOpened ? t('githubOAuth.completeInBrowser') : t('githubOAuth.waitingForFlow')}
              </p>
            </div>
          </div>

          {/* Device Code Display */}
          {deviceCode && (
            <div className="text-center space-y-3 py-2">
              <p className="text-sm text-foreground">
                {t('githubOAuth.oneTimeCode')}
              </p>
              <div className="flex items-center justify-center gap-3">
                <code className="text-2xl font-mono font-semibold tracking-widest text-foreground px-4 py-2 rounded-xl bg-segment-track">
                  {deviceCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyDeviceCode}
                  className="shrink-0"
                >
                  {codeCopied ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1 text-success" />
                      {t('githubOAuth.copied')}
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 mr-1" />
                      {t('githubOAuth.copy')}
                    </>
                  )}
                </Button>
              </div>

              <div className="text-sm text-muted-foreground space-y-2">
                <p>
                  {browserOpened ? t('githubOAuth.enterCodeInBrowser') : t('githubOAuth.copyCodeThenOpen')}
                </p>
                {!browserOpened && authUrl && (
                  <Button
                    variant="link"
                    onClick={handleOpenAuthUrl}
                    className="text-foreground p-0 h-auto gap-1"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('githubOAuth.openUrl', { url: authUrl })}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Success */}
      {status === 'success' && (
        <div className="flex items-start gap-3 rounded-xl bg-segment-track px-4 py-3 text-sm">
          <Check className="h-4 w-4 mt-0.5 text-success shrink-0" />
          <div className="flex-1">
            <p className="text-foreground">{t('githubOAuth.connected')}</p>
            <p className="text-muted-foreground mt-0.5">
              {username ? t('githubOAuth.connectedAs', { username }) : t('githubOAuth.accountConnected')}
            </p>
          </div>
        </div>
      )}

      {/* Error */}
      {status === 'error' && error && (
        <div className="space-y-4">
          <div className="text-sm" role="alert">
            <p className="text-destructive">
              {isTimeout ? t('githubOAuth.timedOut') : t('githubOAuth.failed')}
            </p>
            <p className="text-muted-foreground mt-1">{error}</p>
          </div>

          {/* Fallback URL display when browser failed to open */}
          {authUrl && (
            <div className="space-y-3 rounded-xl bg-segment-track px-4 py-3 text-sm">
              <div>
                <p className="text-foreground">{t('githubOAuth.manualTitle')}</p>
                <p className="text-muted-foreground mt-0.5">{t('githubOAuth.manualDescription')}</p>
              </div>

              <div className="flex items-center gap-2">
                <code className="text-sm font-mono text-foreground flex-1 break-all">
                  {authUrl}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(authUrl);
                      setUrlCopied(true);
                      // Clear any existing timeout before setting a new one
                      if (urlCopyTimeoutRef.current) {
                        clearTimeout(urlCopyTimeoutRef.current);
                      }
                      urlCopyTimeoutRef.current = setTimeout(() => setUrlCopied(false), 2000);
                    } catch (err) {
                      debugLog('Failed to copy URL:', err);
                    }
                  }}
                  className="shrink-0"
                >
                  {urlCopied ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1 text-success" />
                      {t('githubOAuth.copied')}
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 mr-1" />
                      {t('githubOAuth.copy')}
                    </>
                  )}
                </Button>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenAuthUrl}
                className="gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('githubOAuth.openInBrowser')}
              </Button>

              {/* Device code reminder if available */}
              {deviceCode && (
                <p className="text-muted-foreground">
                  {t('githubOAuth.enterCodePrompt')}{' '}
                  <code className="font-mono font-semibold text-foreground">
                    {deviceCode}
                  </code>
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            {onCancel && (
              <Button onClick={onCancel} variant="ghost" size="sm">
                {t('common:buttons.cancel')}
              </Button>
            )}
            <Button onClick={handleStartAuth} variant="outline" size="sm">
              {t('common:buttons.retry')}
            </Button>
          </div>
        </div>
      )}

      {/* Cancel button for non-error states */}
      {status !== 'error' && status !== 'success' && onCancel && (
        <div className="flex justify-end pt-2">
          <Button onClick={onCancel} variant="ghost" size="sm">
            {t('common:buttons.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
