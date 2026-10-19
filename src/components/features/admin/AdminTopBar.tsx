'use client';

/**
 * TopBar del cockpit Direzione/Segreteria (desktop). Barra verde persistente:
 * logo · ricerca globale (reale, /api/admin/search — M7.2) · selettore sede
 * (reale, /api/admin/schools) · centro notifiche (reale, /api/notifiche —
 * M7.3) · avatar+ruolo. Mirror di DR `ds.css .kv-topbar`. Sul telefono è
 * nascosta (`tablet:flex`/`hidden`): sotto i 744 px c'è `AdminTopBarMobile` (barra
 * verde) e la navigazione è la bottom-nav. Da 744 px c'è questa, alta 64 px: il
 * binario del tablet e la sidebar si appoggiano sotto (`top-16`).
 * La campanella riceve `attivoSu` così solo la topbar visibile fa fetch/poll
 * (entrambe restano nel DOM a ogni breakpoint: senza guardia raddoppierebbero).
 */
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { SedeSelector } from '@/components/ui/cockpit';
import { UserMenu } from '@/components/ui/UserMenu';
import { AdminSearchPanel } from './AdminSearchPanel';
import { AdminNotificationsPanel } from './AdminNotificationsPanel';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { useFormatoGuscio } from '@/lib/ui/use-formato-guscio';

// Mappa ruolo → chiave i18n della label (namespace adminNav). Sono le etichette
// UI del cockpit, locali a questa TopBar (non provengono dalla lib `labelRuolo`).
const ROLE_LABEL_KEY: Record<string, string> = {
  admin: 'ruoloDirezione',
  coordinator: 'ruoloSegreteria',
};

export function AdminTopBar() {
  // userId e ruolo dall'identità condivisa del cockpit (<AdminIdentityProvider>):
  // niente lettura duplicata; il markup della TopBar non dipende da userId
  // (usato solo come prop verso i pannelli), quindi nessun mismatch di hydration.
  const t = useTranslations('adminNav');
  const { userId, ruolo, withUser } = useAdminIdentity();
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // Le stesse soglie del guscio (lock `menu-desktop-in-orizzontale`): da 1024 px c'è la sidebar
  // e la ricerca ha spazio per il testo d'esempio intero. Server e primo render dicono `telefono`.
  const formato = useFormatoGuscio();

  const ruoloLabel = t(ROLE_LABEL_KEY[ruolo] ?? (ruolo ? 'ruoloStaff' : 'ruoloSegreteria'));

  return (
    <header data-kv-topbar-admin className="sticky top-0 z-40 hidden h-16 items-center gap-4 bg-kidville-green px-5 tablet:flex">
        {/* brand — wordmark ufficiale (stessa metrica dell'AppBar genitore/docente).
            Largo 214 px solo con la sidebar piena (≥1024), per allinearsi a lei: col
            binario del tablet in verticale quei 214 px sarebbero tolti alla ricerca. */}
        <div className="flex w-auto shrink-0 items-center lg:w-[214px]">
          <Link href={withUser('/admin')} aria-label={t('homeAria')} className="shrink-0">
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

        {/* ricerca globale (reale, /api/admin/search — M7.2). Prende TUTTO lo spazio libero,
            fino a 460 px: fino al 2026-10-18 lo divideva a metà con uno spaziatore `flex-1`, e
            su un iPad 11" in orizzontale il testo d'esempio si fermava a «…codice fiscale.»,
            in verticale a «Cerca alı».
            Sull'iPad in verticale (sotto i 1024 px, col binario) il testo d'esempio è quello
            corto, «…CF…»: il campo resta largo ~310 px, e il testo intero ne chiede 284 di soli
            caratteri, più l'icona e i margini. Lo spazio lo decide il nome della sede accanto:
            con «KIDVILLE E2E» mancavano 28 px, con «KIDVILLE GIUGLIANO» ne mancherebbero ~75, quindi
            stringere i margini non bastava. `text-ellipsis` resta come rete: un nome di sede
            ancora più lungo fa finire il testo coi puntini, non a metà lettera. */}
        <div className="relative min-w-0 max-w-[460px] flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-kidville-white/60"><Search size={17} /></span>
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); e.currentTarget.blur(); } }}
            placeholder={t(formato === 'sidebar' ? 'ricercaPlaceholder' : 'ricercaPlaceholderBreve')}
            aria-label={t('ricercaAria')}
            className="h-10 w-full text-ellipsis rounded-full border-none bg-white/15 pl-10 pr-3.5 font-maven text-[13.5px] text-kidville-white transition-colors placeholder:text-kidville-white/60 focus-visible:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kidville-yellow/70"
          />
          {searchOpen && (
            <AdminSearchPanel
              query={search}
              userId={userId}
              onNavigate={() => { setSearchOpen(false); setSearch(''); }}
            />
          )}
        </div>

        {/* Il gruppo di destra si spinge in fondo da solo (`ml-auto`), senza rubare spazio alla
            ricerca. */}
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {/* selettore sede (reale) */}
          <SedeSelector userId={userId} />

          {/* centro notifiche (reale, /api/notifiche — M7.3); attiva fetch/poll
              solo quando questa topbar desktop è effettivamente visibile */}
          <AdminNotificationsPanel userId={userId} attivoSu="(min-width: 744px)" />

          {/* avatar + ruolo (chip giallo, iniziale verde — mirror DR) + menu Esci */}
          <UserMenu ruoloLabel={ruoloLabel} />
        </div>
    </header>
  );
}
