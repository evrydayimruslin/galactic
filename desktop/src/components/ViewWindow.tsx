// ViewWindow — pop-out shell for non-chat views (home, library, profile, wallet, settings).
// Loaded when main.tsx detects ?view= param (excluding 'chat' which uses ChatWindow).

import { useRef } from 'react';
import WebPanel from './WebPanel';
import HomeView from './HomeView';
import LibraryView from './LibraryView';
import { openViewWindow } from '../lib/multiWindow';

function parseViewFromParams(): string {
  return new URLSearchParams(window.location.search).get('view') || '';
}

export default function ViewWindow() {
  const viewKind = useRef(parseViewFromParams()).current;

  switch (viewKind) {
    case 'library':
      return <LibraryView />;
    case 'profile':
      return <WebPanel path='/my-profile' title='Profile' />;
    case 'wallet':
      return <WebPanel path='/wallet' title='Wallet' />;
    case 'settings':
      return <WebPanel path='/settings' title='Settings' />;
    case 'home':
      return (
        <HomeView
          onNavigateToAgent={(agentId, _initialMessage) => {
            // Open the agent chat in yet another window
            openViewWindow({ kind: 'chat', agentId, agentName: agentId.slice(0, 8) });
          }}
        />
      );
    default:
      return (
        <div className='flex items-center justify-center h-full bg-white'>
          <p className='text-body text-ul-text-muted'>Unknown view: {viewKind}</p>
        </div>
      );
  }
}
