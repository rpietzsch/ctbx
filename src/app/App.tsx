import { NavLink, Navigate, Route, Routes } from 'react-router';
import { ChatPage } from './ChatPage';
import { ProvidersPage } from './ProvidersPage';
import { ServersPage } from './ServersPage';
import { DataPage } from './DataPage';
import { cx } from '@/ui/primitives';

const NAV = [
  { to: '/chat', label: 'Chat' },
  { to: '/settings/providers', label: 'Providers' },
  { to: '/settings/servers', label: 'MCP servers' },
  { to: '/settings/data', label: 'Data' },
];

export function App() {
  return (
    <div className="flex h-full flex-col">
      {/*
        `viewport-fit=cover` paints edge to edge, so the header has to hold
        itself clear of the status bar and Dynamic Island; the inset is zero on
        every device that reserves nothing, which leaves desktop untouched.
        Horizontal insets matter in landscape, where the notch takes a side.
      */}
      <header
        className={cx(
          'flex shrink-0 items-center gap-3 border-b border-border sm:gap-6',
          'pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]',
          'pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]'
        )}
      >
        <span className="flex shrink-0 flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">ctbx</span>
          {/*
            The build's revision. `leading-none` on the stack keeps this from
            adding a second line's worth of height to a header that has to fit
            a phone.
          */}
          <span
            className="mt-0.5 font-mono text-[0.6rem] text-fg-muted"
            title={`Build ${__APP_VERSION__}`}
          >
            {__APP_VERSION__}
          </span>
        </span>
        {/*
          The four labels do not fit across a phone. Scrolling the nav keeps
          every destination reachable at one tap rather than wrapping the header
          onto a second line and eating vertical space that the chat needs.
        */}
        <nav
          className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Main"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx(
                  'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                  isActive ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2'
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/*
        The scroll container for every route that does not manage its own.
        The body is `overflow: hidden` so the shell scrolls rather than the
        document — which means this element has to actually offer a scrollbar,
        or the settings pages simply get clipped. Chat sizes itself to `h-full`
        and scrolls its message list internally, so it never doubles up here.
      */}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings/providers" element={<ProvidersPage />} />
          <Route path="/settings/servers" element={<ServersPage />} />
          <Route path="/settings/data" element={<DataPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
    </div>
  );
}
