/**
 * The window's close button while Workbench can keep running in the background (tray): asks
 * whether to keep it running there or quit (this window when others are open, else Workbench).
 * The main process asks (index.ts) and acts on the answer (window-handlers.ts).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WindowCloseChoice, WindowCloseRequest } from '../../shared/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

export function CloseWindowDialog() {
  const { t } = useTranslation('dialogs');
  const [request, setRequest] = useState<WindowCloseRequest | null>(null);

  useEffect(() => window.electronAPI.onWindowCloseRequested(setRequest), []);

  const choose = (choice: WindowCloseChoice) => {
    setRequest(null);
    void window.electronAPI.chooseWindowClose(choice);
  };

  const otherWindows = request?.otherWindows === true;
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(otherWindows ? 'closeWindow.titleWindow' : 'closeWindow.title')}</DialogTitle>
          <DialogDescription>{t('closeWindow.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => choose('quit')}>
            {t(otherWindows ? 'closeWindow.closeWindow' : 'closeWindow.quit')}
          </Button>
          <Button size="sm" autoFocus onClick={() => choose('background')}>
            {t('closeWindow.keepRunning')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
