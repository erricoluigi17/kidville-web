'use client';

/**
 * TopBar del cockpit Direzione/Segreteria (desktop). Barra verde persistente:
 * logo · ricerca globale (reale, /api/admin/search — M7.2) · selettore sede
 * (reale, /api/admin/schools) · campanella (placeholder) · avatar+ruolo.
 * Mirror di DR `ds.css .kv-topbar`. Su mobile è nascosta: la topbar/drawer
 * mobile vive già in AdminSidebar.
 */
import { useEffect, useState } from 'react';
import { Search, Bell } from 'lucide-react';
import { SedeSelector } from '@/components/ui/cockpit';
import { AdminSearchPanel } from './AdminSearchPanel';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Direzione',
  coordinator: 'Segreteria',
};

export function AdminTopBar() {
  // Legge ?userId= LATO CLIENT senza useSearchParams (la shell non deve
  // sospendere, vedi commento in admin/layout.tsx): lazy initializer, così
  // niente setState sincrono nell'effect (react-hooks 7). In SSR è null e il
  // markup non dipende da userId → nessun mismatch di hydration.
  const [userId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('userId')
  );
  const [ruolo, setRuolo] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (!userId) return;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuolo(d.data.ruolo || ''); })
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const ruoloLabel = ROLE_LABEL[ruolo] ?? (ruolo ? 'Staff' : 'Segreteria');

  return (
    <>
      <header className="sticky top-0 z-40 hidden h-16 items-center gap-4 bg-kidville-green px-5 lg:flex">
        {/* brand */}
        <div className="flex w-[214px] shrink-0 items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-kidville-yellow font-barlow text-xl font-black text-kidville-green">K</div>
          <span className="font-barlow text-[21px] font-black uppercase tracking-[0.02em] text-kidville-white">Kidville</span>
        </div>

        {/* ricerca globale (reale, /api/admin/search — M7.2) */}
        <div className="relative min-w-0 max-w-[460px] flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-kidville-white/60"><Search size={17} /></span>
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); e.currentTarget.blur(); } }}
            placeholder="Cerca alunno, genitore, codice fiscale…"
            aria-label="Ricerca globale"
            className="h-10 w-full rounded-[11px] border-none bg-kidville-white/[0.14] pl-10 pr-3.5 font-maven text-[13.5px] text-kidville-white outline-none placeholder:text-kidville-white/60"
          />
          {searchOpen && (
            <AdminSearchPanel
              query={search}
              userId={userId}
              onNavigate={() => { setSearchOpen(false); setSearch(''); }}
            />
          )}
        </div>

        <div className="flex-1" />

        {/* selettore sede (reale) */}
        <SedeSelector userId={userId} />

        {/* notifiche (placeholder) */}
        <button
          type="button"
          onClick={() => setToast('Centro notifiche in arrivo')}
          aria-label="Notifiche (in arrivo)"
          className="relative flex h-10 w-10 items-center justify-center rounded-[11px] bg-kidville-white/[0.12] text-kidville-white"
        >
          <Bell size={19} />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-pill bg-kidville-yellow ring-2 ring-kidville-green" />
        </button>

        {/* avatar + ruolo (chip giallo, iniziale verde — mirror DR) */}
        <div className="flex items-center gap-2.5 pl-1.5">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-kidville-yellow font-barlow text-[15px] font-extrabold uppercase text-kidville-green">
            {ruoloLabel[0] ?? 'S'}
          </span>
          <div className="leading-[1.15]">
            <div className="font-barlow text-sm font-extrabold uppercase text-kidville-white">{ruoloLabel}</div>
            <div className="font-maven text-[11px] text-kidville-yellow">Kidville</div>
          </div>
        </div>
      </header>

      {/* toast placeholder (desktop) */}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[130] hidden -translate-x-1/2 lg:block">
          <div className="rounded-[14px] bg-kidville-green px-4 py-3 font-maven text-sm font-semibold text-kidville-white shadow-lg">{toast}</div>
        </div>
      )}
    </>
  );
}
