// ViewWindow — pop-out shell for non-chat views (home, library, marketplace,
// tool-detail, profile, wallet, settings).
// Loaded when main.tsx detects ?view= param (excluding 'chat' which uses ChatWindow).

import { useRef } from 'react';
import WebPanel from './WebPanel';
import CommandHomescreen from './CommandHomescreen';
import LibraryView from './LibraryView';
import MarketplaceView from './MarketplaceView';
import ProfileView from './ProfileView';
import ToolDetailView from './ToolDetailView';
import { openViewWindow } from '../lib/multiWindow';

interface PoppedParams {
  view: string;
  appId: string;
  appName: string;
}

function parseParams(): PoppedParams {
  const sp = new URLSearchParams(window.location.search);
  return {
    view: sp.get('view') ?? '',
    appId: sp.get('appId') ?? '',
    appName: sp.get('appName') ?? '',
  };
}

// In a popout window we can't push to the main window's view stack, so
// "open a tool" means: spawn another popout for that tool. The main
// window's deep-link / nav patterns still work for the canonical case.
function openToolPopout(appId: string, appName: string): void {
  void openViewWindow({ kind: 'tool-detail', appId, appName });
}

export default function ViewWindow() {
  const params = useRef(parseParams()).current;

  switch (params.view) {
    case 'library':
      return <LibraryView onOpenTool={openToolPopout} />;
    case 'marketplace':
      return <MarketplaceView onOpenTool={openToolPopout} />;
    case 'tool-detail':
      return <ToolDetailView appId={params.appId} fallbackName={params.appName || undefined} />;
    case 'profile':
      return <ProfileView />;
    case 'wallet':
      return <WebPanel path='/wallet' title='Wallet' />;
    case 'settings':
      return <WebPanel path='/settings' title='Settings' />;
    case 'home':
      return <CommandHomescreen />;
    default:
      return (
        <div className='flex items-center justify-center h-full bg-white'>
          <p className='text-body text-ul-text-muted'>Unknown view: {params.view}</p>
        </div>
      );
  }
}
