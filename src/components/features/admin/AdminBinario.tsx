'use client';

/**
 * IL BINARIO DEL COCKPIT SU TABLET (744–1279 px).
 *
 * Fino al 18/10/2026 la segreteria su iPad aveva due forme, entrambe sbagliate:
 *  - sotto i 1024 px (iPad mini e 11" in verticale) la versione telefono, con la pillola in basso
 *    e il foglio «Menu», intorno a pagine che da 768 px mostrano già tabelle da scrivania;
 *  - da 1024 px la sidebar piena da 256 px, che su un 11" in orizzontale (1194 px) lasciava 938 px
 *    a un registro transazioni largo almeno 820, più i margini.
 *
 * Il binario prende 88 px: i quattro tab della barra in basso (`TAB_ADMIN`, la stessa lista),
 * Anagrafica, che nel foglio del telefono sta in evidenza in cima, e «Menu». «Menu» apre lo stesso
 * contenuto del foglio (`AdminMenuSheet`) in un pannello accanto al binario. Da 1280 px torna la
 * sidebar piena (`AdminSidebar`, `xl:`).
 *
 * Geometria identica alla sidebar: `sticky top-16`, alta `100vh - 4rem`, `z-[105]` sopra gli
 * overlay del contenuto, che da 744 px partono a `--kv-rail-w` (globals.css). La topbar da 64 px
 * (`AdminTopBar`) c'è da 744 px proprio per questo.
 *
 * Una voce accesa sola, come nella barra in basso: col pannello aperto si accende «Menu», e a
 * pannello chiuso «Menu» resta acceso quando la pagina è una voce del menu (`aria-current="true"`,
 * gancio dell'Alto Contrasto insieme a `bg-kidville-green` e `text-kidville-yellow`).
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LayoutGrid, Users } from 'lucide-react';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { activeHref, visibleItem, NAV_GROUPS, type NavItem } from './admin-nav-config';
import { AdminMenuSheet } from './AdminMenuSheet';
import { TAB_ADMIN } from './tab-admin';

const FLAT: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
const ANAGRAFICA_HREF = '/admin/students';

const VOCE = 'flex flex-col items-center gap-1 rounded-xl py-2.5 active:bg-kidville-cream';
const PILLOLA = 'flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-200';
const PILLOLA_ACCESA = 'bg-kidville-green';
const ICONA_ACCESA = 'text-kidville-yellow';
const ICONA_SPENTA = 'text-kidville-sub';
const ETICHETTA = 'font-barlow text-[10px] font-bold uppercase tracking-wider text-center leading-tight';
const ETICHETTA_ACCESA = 'text-kidville-green';
const ETICHETTA_SPENTA = 'text-kidville-sub';

export function AdminBinario() {
  const pathname = usePathname();
  const t = useTranslations('adminNav');
  const { userId, ruolo, withUser } = useAdminIdentity();
  const [aperto, setAperto] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);

  // Il pannello si chiude quando la rotta è cambiata: aggiustamento di stato in render (non un
  // `useEffect`), come nella `BarraLaterale` di genitori e docenti. Le voci del pannello lo
  // chiudono anche al clic; questo copre la navigazione che arriva da altrove (Indietro).
  const [rottaVista, setRottaVista] = useState(pathname);
  if (rottaVista !== pathname) {
    setRottaVista(pathname);
    setAperto(false);
  }

  const current = activeHref(pathname);
  const voci = [
    ...TAB_ADMIN.map((tab) => ({ href: tab.href, label: t(tab.labelKey), icon: tab.icon, attiva: tab.isActive(current) })),
    { href: ANAGRAFICA_HREF, label: t('anagrafica'), icon: Users, attiva: current === ANAGRAFICA_HREF },
  ].filter((v) => {
    const cfg = FLAT.find((i) => i.href === v.href);
    return !cfg || visibleItem(cfg, ruolo);
  });
  const unaVoceAccesa = voci.some((v) => v.attiva);
  const menuAcceso = aperto || (!unaVoceAccesa && FLAT.some((i) => i.href === current));

  return (
    <aside
      data-kv-binario-admin
      className="hidden tablet:flex xl:hidden tablet:w-[88px] tablet:shrink-0 tablet:flex-col tablet:sticky tablet:top-16 tablet:h-[calc(100vh-4rem)] z-[105] overflow-y-auto border-r border-kidville-line bg-kidville-white"
    >
      <nav aria-label={t('navAria')} className="kv-admin-bottomnav flex flex-col items-stretch gap-1 px-2 py-3">
        {voci.map((v) => {
          const accesa = v.attiva && !aperto;
          const Icon = v.icon;
          return (
            <Link
              key={v.href}
              href={withUser(v.href)}
              aria-current={accesa ? 'page' : undefined}
              className={VOCE}
            >
              <span className={`${PILLOLA} ${accesa ? PILLOLA_ACCESA : ''}`}>
                <Icon size={20} strokeWidth={2} className={accesa ? ICONA_ACCESA : ICONA_SPENTA} />
              </span>
              <span className={`${ETICHETTA} ${accesa ? ETICHETTA_ACCESA : ETICHETTA_SPENTA}`}>{v.label}</span>
            </Link>
          );
        })}

        <button
          ref={menuRef}
          type="button"
          onClick={() => setAperto((x) => !x)}
          aria-haspopup="dialog"
          aria-expanded={aperto}
          aria-current={menuAcceso && !aperto ? 'true' : undefined}
          aria-label={t('menuAria')}
          className={VOCE}
        >
          <span className={`${PILLOLA} ${menuAcceso ? PILLOLA_ACCESA : ''}`}>
            <LayoutGrid size={20} strokeWidth={2} className={menuAcceso ? ICONA_ACCESA : ICONA_SPENTA} />
          </span>
          <span className={`${ETICHETTA} ${menuAcceso ? ETICHETTA_ACCESA : ETICHETTA_SPENTA}`}>{t('tabMenu')}</span>
        </button>
      </nav>

      <AdminMenuSheet
        open={aperto}
        onClose={() => setAperto(false)}
        withUser={withUser}
        ruolo={ruolo}
        userId={userId}
        returnFocusRef={menuRef}
        variante="pannello"
      />
    </aside>
  );
}
