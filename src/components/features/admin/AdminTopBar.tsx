'use client';

/**
 * TopBar del cockpit Direzione/Segreteria (desktop). Barra verde persistente:
 * logo · ricerca globale (reale, /api/admin/search — M7.2) · selettore sede
 * (reale, /api/admin/schools) · centro notifiche (reale, /api/notifiche —
 * M7.3) · avatar+ruolo. Mirror di DR `ds.css .kv-topbar`. Su mobile è
 * nascosta (`lg:flex`/`hidden`): sotto i 1024px c'è `AdminTopBarMobile` (barra
 * verde) e la navigazione è la bottom-nav — il vecchio drawer non esiste più.
 * La campanella riceve `attivoSu` così solo la topbar visibile fa fetch/poll
 * (entrambe restano nel DOM a ogni breakpoint: senza guardia raddoppierebbero).
 */
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Search } from 'lucide-react';
import { SedeSelector } from '@/components/ui/cockpit';
import { UserMenu } from '@/components/ui/UserMenu';
import { AdminSearchPanel } from './AdminSearchPanel';
import { AdminNotificationsPanel } from './AdminNotificationsPanel';
import { useAdminIdentity } from '@/lib/context/admin-identity';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Direzione',
  coordinator: 'Segreteria',
};

export function AdminTopBar() {
  // userId e ruolo dall'identità condivisa del cockpit (<AdminIdentityProvider>):
  // niente lettura duplicata; il markup della TopBar non dipende da userId
  // (usato solo come prop verso i pannelli), quindi nessun mismatch di hydration.
  const { userId, ruolo, withUser } = useAdminIdentity();
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const ruoloLabel = ROLE_LABEL[ruolo] ?? (ruolo ? 'Staff' : 'Segreteria');

  return (
    <header className="sticky top-0 z-40 hidden h-16 items-center gap-4 bg-kidville-green px-5 lg:flex">
        {/* brand — wordmark ufficiale (stessa metrica dell'AppBar genitore/docente) */}
        <div className="flex w-[214px] shrink-0 items-center">
          <Link href={withUser('/admin')} aria-label="Home Kidville" className="shrink-0">
            <Image
              src="/logo-light.png"
              alt="Kidville"
              width={620}
              height={209}
              priority
              style={{ height: 19, width: 'auto', display: 'block' }}
            />
          </Link>
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
            className="h-10 w-full rounded-full border-none bg-white/15 pl-10 pr-3.5 font-maven text-[13.5px] text-kidville-white transition-colors placeholder:text-kidville-white/60 focus-visible:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kidville-yellow/70"
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

        {/* centro notifiche (reale, /api/notifiche — M7.3); attiva fetch/poll
            solo quando questa topbar desktop è effettivamente visibile */}
        <AdminNotificationsPanel userId={userId} attivoSu="(min-width: 1024px)" />

        {/* avatar + ruolo (chip giallo, iniziale verde — mirror DR) + menu Esci */}
        <UserMenu ruoloLabel={ruoloLabel} />
    </header>
  );
}
