// ViewWindow — pop-out shell for non-chat views (home, library, profile, wallet, settings).
// Loaded when main.tsx detects ?view= param (excluding 'chat' which uses ChatWindow).

import { useRef } from 'react';
import WebPanel from './WebPanel';
import CommandHomescreen from './CommandHomescreen';
import LibraryView from './LibraryView';
import MarketplaceView from './MarketplaceView';
import ProfileView from './ProfileView';

function parseViewFromParams(): string {
  return new URLSearchParams(window.location.search).get('view') || '';
}

export default function ViewWindow() {
  const viewKind = useRef(parseViewFromParams()).current;

  switch (viewKind) {
    case 'library':
      return <LibraryView />;
    case 'marketplace':
      return <MarketplaceView onOpenTool={() => { /* TODO(popout): wire tool detail in popout */ }} />;
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
          <p className='text-body text-ul-text-muted'>Unknown view: {viewKind}</p>
        </div>
      );
  }
}
