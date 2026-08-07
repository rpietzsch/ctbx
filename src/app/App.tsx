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
      <header className="flex shrink-0 items-center gap-6 border-b border-border px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">ctbx</span>
        <nav className="flex gap-1" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx(
                  'rounded-lg px-3 py-1.5 text-sm transition-colors',
                  isActive ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2'
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1">
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
