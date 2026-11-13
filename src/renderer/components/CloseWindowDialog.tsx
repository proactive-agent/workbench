/**
 * The window's close button while other project windows are open and Workbench can keep running
 * in the background (tray): asks whether to keep this window running there or close its project.
 * The main process asks (index.ts; the only window just hides) and acts on the answer
 * (window-handlers.ts).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WindowCloseChoice } from '../../shared/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

export function CloseWindowDialog() {
  const { t } = useTranslation('dialogs');
  const [asked, setAsked] = useState(false);

  useEffect(() => window.electronAPI.onWindowCloseRequested(() => setAsked(true)), []);

  const choose = (choice: WindowCloseChoice) => {
    setAsked(false);
    void window.electronAPI.chooseWindowClose(choice);
  };

  return (
    <Dialog open={asked} onOpenChange={(open) => !open && setAsked(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('closeWindow.title')}</DialogTitle>
          <DialogDescription>{t('closeWindow.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => choose('quit')}>
            {t('closeWindow.closeProject')}
          </Button>
          <Button size="sm" autoFocus onClick={() => choose('background')}>
            {t('closeWindow.keepRunning')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
