import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Eye, EyeOff, LogOut, Menu, X } from 'lucide-react';
import { useClerk } from '@clerk/clerk-react';
import { cn } from '@/lib/utils';
import { NAV_GROUPS } from './nav';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { Button } from './ui/button';

function SignOutAction({ mode }: { mode: Me['authMode'] }) {
  if (mode !== 'clerk') return null;
  return <ClerkSignOut />;
}

function ClerkSignOut() {
  const { signOut } = useClerk();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void signOut()}
      className="w-full justify-start gap-2"
    >
      <LogOut className="h-4 w-4" aria-hidden /> Sign out
    </Button>
  );
}

function NavContent({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const location = useLocation();
  const groups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((i) => can(me, i.permission)),
      })).filter((g) => g.items.length > 0),
    [me],
  );
  return (
    <nav aria-label="Primary" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="mb-1 flex items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
            <group.icon className="h-3.5 w-3.5" aria-hidden />
            {group.label}
          </div>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active =
                item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    className={cn(
                      'block rounded-md px-2 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )}
                  >
                    {item.label}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const appName = me.company?.applicationName ?? me.company?.displayName ?? 'Company Books';

  return (
    <div className={cn('flex min-h-full', privacy && 'privacy-mode')}>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
          <span className="truncate text-sm font-semibold text-white">{appName}</span>
        </div>
        <NavContent me={me} />
        <div className="border-t border-sidebar-border p-3 text-sidebar-foreground">
          <p className="truncate px-2 text-xs">{me.user?.email}</p>
          <p className="truncate px-2 text-[11px] text-sidebar-foreground/60">{me.org?.roleName}</p>
          <div className="mt-2">
            <SignOutAction mode={me.authMode} />
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-sidebar shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
              <span className="truncate text-sm font-semibold text-white">{appName}</span>
              <button
                aria-label="Close menu"
                className="rounded-md p-1 text-sidebar-foreground hover:bg-sidebar-accent"
                onClick={() => setMobileOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavContent me={me} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card px-4">
          <button
            aria-label="Open navigation"
            className="rounded-md p-1.5 hover:bg-muted lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium lg:hidden">{appName}</div>
          <div className="hidden flex-1 lg:block" />
          <Button
            variant="ghost"
            size="icon"
            aria-label={privacy ? 'Show amounts' : 'Hide amounts (privacy mode)'}
            aria-pressed={privacy}
            onClick={() => setPrivacy((p) => !p)}
          >
            {privacy ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
