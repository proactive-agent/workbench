import { Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { readSettingsFile } from './settings-utils';
import { DEFAULT_APP_SETTINGS } from '../shared/constants';
import type { NotificationSettings } from '../shared/types';

export type NotificationType = 'task-complete' | 'task-failed' | 'review-needed';

interface NotificationOptions {
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
}

/**
 * Service for sending system notifications with optional sound
 */
class NotificationService {
  private mainWindow: (() => BrowserWindow | null) | null = null;

  /**
   * Initialize the notification service with the main window getter
   */
  initialize(getMainWindow: () => BrowserWindow | null): void {
    this.mainWindow = getMainWindow;
  }

  /**
   * Send a notification for task completion
   */
  notifyTaskComplete(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-complete', {
      title: 'Task Complete',
      body: `"${taskTitle}" has completed and is ready for review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for task failure
   */
  notifyTaskFailed(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-failed', {
      title: 'Task Failed',
      body: `"${taskTitle}" encountered an error`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for review needed
   */
  notifyReviewNeeded(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('review-needed', {
      title: 'Review Needed',
      body: `"${taskTitle}" is ready for your review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a system notification with optional sound
   */
  private sendNotification(type: NotificationType, options: NotificationOptions): void {
    // Get notification settings
    const settings = this.getNotificationSettings();

    // Check if this notification type is enabled
    if (!this.isNotificationEnabled(type, settings)) {
      return;
    }

    // Create and show the notification
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: !settings.sound // Let the OS handle sound if enabled
      });

      // Focus window when notification is clicked
      notification.on('click', () => {
        const window = this.mainWindow?.();
        if (window) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.focus();
        }
      });

      notification.show();
    }

    // Play sound if enabled (system beep)
    if (settings.sound) {
      this.playNotificationSound();
    }
  }

  /**
   * Play a notification sound
   */
  private playNotificationSound(): void {
    // Use system beep - works across all platforms
    shell.beep();
  }

  /**
   * Get the app-wide notification settings (Settings > General > Notifications),
   * falling back to the defaults for any missing value
   */
  private getNotificationSettings(): {
    onTaskComplete: boolean;
    onTaskFailed: boolean;
    onReviewNeeded: boolean;
    sound: boolean;
  } {
    const saved = readSettingsFile()?.notifications as Partial<NotificationSettings> | undefined;
    return { ...DEFAULT_APP_SETTINGS.notifications, ...saved };
  }

  /**
   * Check if a notification type is enabled in settings
   */
  private isNotificationEnabled(
    type: NotificationType,
    settings: {
      onTaskComplete: boolean;
      onTaskFailed: boolean;
      onReviewNeeded: boolean;
      sound: boolean;
    }
  ): boolean {
    switch (type) {
      case 'task-complete':
        return settings.onTaskComplete;
      case 'task-failed':
        return settings.onTaskFailed;
      case 'review-needed':
        return settings.onReviewNeeded;
      default:
        return false;
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
