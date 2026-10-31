'use client';

import { useId } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { activeHref, gruppiVisibili, CODA_FATTURE_HREF, puoLeggereCodaFatture, type NavItem } from './admin-nav-config';
import { useGruppoAperto } from './use-gruppo-aperto';
import { useConteggioCodaFatture } from './use-conteggio-coda-fatture';
import { ContatoreCodaFatture } from './ContatoreCodaFatture';

// Voce "Esci" in fondo alla sidebar (il cockpit desktop ha il menu account nella
// TopBar; qui resta come scorciatoia). Sul telefono la nav è la bottom-nav +
// bottom-sheet «Menu» (AdminBottomNav/AdminMenuSheet), sul tablet il binario
// (AdminBinario, solo in verticale): questa sidebar c'è da 1024 px, cioè su ogni iPad in
// orizzontale. Con la PR 3 dell'iPad (PR n. 241, 18/10/2026) partiva da 1280, e un 11" in orizzontale
// (1180–1210 px) aveva il binario a icone: per il titolare era «il menu del telefono», non quello
// da computer. Corretto lo stesso giorno. `error-strong` e non `error`: «Esci»
// è testo, e il rosso `error` su bianco fa 4,23:1 (soglia 4,5).
const LOGOUT_ROW_CLS =
  'flex w-full items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm font-semibold text-kidville-error-strong transition-colors hover:bg-kidville-error-soft';

// Stessa riga del logout, in tinta neutra: l'alto contrasto non è un'azione distruttiva.

// Intestazione di un gruppo della fisarmonica: stessa altezza e stesso carattere delle voci, così
// i sette elementi di primo livello si leggono come una lista sola.
const INTESTAZIONE_CLS =
  'flex w-full items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm font-semibold transition-colors';

// Sidebar desktop UNICA del cockpit Direzione/Segreteria. La config a gruppi
// (NAV_GROUPS + activeHref + visibleItem) è condivisa con bottom-nav e sheet
// mobile (admin-nav-config.ts). Il `layoutId="admin-nav-active"` vive SOLO qui:
// la pillola animata è dedicata alla sidebar.
//
// MENU A FISARMONICA (2026-10-31). Sette voci di primo livello: Home e Anagrafica dirette, cinque
// gruppi che si aprono uno alla volta (`useGruppoAperto`). All'arrivo su una pagina è aperto il suo
// gruppo; a gruppo chiuso l'intestazione resta segnata (`data-contiene-pagina`, gancio anche
// dell'Alto Contrasto in globals.css) e porta il numero della Coda fatture, che altrimenti sparirebbe
// insieme alla voce. Le voci di un gruppo chiuso non sono nel DOM.
export function AdminSidebar() {
  const pathname = usePathname();
  // Etichette di nav localizzate (namespace `etichette`, chiavi nav_*/navgruppo_*).
  // Fallback all'IT del config se la chiave manca → nessuna rottura, mai la chiave.
  const te = useTranslations('etichette');
  // Coda fatture (nucleo §4): l'unica voce la cui etichetta non vive in `etichette`
  // ma in `adminContabilita.codaFatture.menu.codaFatture` — vedi la nota su
  // `CODA_FATTURE_HREF` in admin-nav-config.ts.
  const tc = useTranslations('adminContabilita');
  // userId (→ href ?userId=) e ruolo dall'identità condivisa del cockpit. Il
  // provider risolve userId in two-pass (null al primo render, come l'SSR) →
  // gli href della sidebar combaciano e non c'è hydration mismatch.
  const { userId, ruolo, withUser } = useAdminIdentity();
  // Contatore delle voci attive accanto a «Coda fatture» (nucleo §4): una lettura leggera
  // (`?solo=conteggi`) a ogni cambio di pagina, niente polling. Vedi l'hook.
  const vociCoda = useConteggioCodaFatture({
    attivo: puoLeggereCodaFatture(ruolo),
    userId,
    chiave: pathname ?? '',
  });

  const current = activeHref(pathname);
  const gruppi = gruppiVisibili(ruolo);
  const { aperto, alterna } = useGruppoAperto(pathname ?? '');
  // Id di intestazioni e pannelli: `useId`, perché sidebar e foglio «Menu» possono stare entrambi nel DOM.
  const idBase = useId();

  // La riga di una voce, identica per i link diretti e per le voci dentro un gruppo aperto.
  const rigaVoce = (item: NavItem) => {
    const active = item.href === current;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={withUser(item.href)}
        aria-current={active ? 'page' : undefined}
        className={`relative flex items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm transition-colors ${
          active
            ? 'text-white'
            : 'text-kidville-ink/70 hover:bg-kidville-green-soft hover:text-kidville-green'
        }`}
      >
        {active && (
          <motion.span
            layoutId="admin-nav-active"
            className="absolute inset-0 rounded-xl bg-kidville-green shadow-[0_6px_16px_-8px_rgba(0,84,75,0.55)]"
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          />
        )}
        <Icon
          size={20}
          strokeWidth={2.2}
          className={`relative z-10 shrink-0 ${active ? 'text-kidville-yellow' : ''}`}
        />
        <span className="relative z-10 font-semibold">
          {item.href === CODA_FATTURE_HREF
            ? tc('codaFatture.menu.codaFatture')
            : te.has(item.labelKey) ? te(item.labelKey) : item.label}
        </span>
        {item.href === CODA_FATTURE_HREF && <ContatoreCodaFatture n={vociCoda} attivo={active} />}
      </Link>
    );
  };

  return (
    // Sidebar desktop — sotto la TopBar (top-16, h calc), z-[105] sopra ai modali
    // (z-50/[60]/[100]): resta sempre visibile e cliccabile anche con un modal aperto.
    // Il brand vive nella TopBar → qui si parte dal menu.
    <aside data-kv-sidebar-admin className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] z-[105] border-r border-kidville-line bg-kidville-white overflow-y-auto pt-4">
      <nav className="kv-admin-nav flex flex-col gap-1 px-3 pb-6">
        {gruppi.map((group, gi) => {
          if (group.title === null) return <div key={gi}>{group.items.map(rigaVoce)}</div>;
          const chiave = group.titleKey ?? group.title;
          const isAperto = aperto === chiave;
          const contiene = group.items.some((i) => i.href === current);
          // «Sei qui» solo a gruppo chiuso: aperto, l'evidenza è già sulla voce.
          const segnato = !isAperto && contiene;
          const conCoda = group.items.some((i) => i.href === CODA_FATTURE_HREF);
          const Icon = group.icon;
          const idIntestazione = `${idBase}-${gi}-intestazione`;
          const idPannello = `${idBase}-${gi}-voci`;
          return (
            <div key={gi} className="flex flex-col gap-1">
              <button
                type="button"
                id={idIntestazione}
                onClick={() => alterna(chiave)}
                aria-expanded={isAperto}
                aria-controls={isAperto ? idPannello : undefined}
                data-contiene-pagina={segnato ? 'true' : undefined}
                className={`${INTESTAZIONE_CLS} ${
                  segnato
                    ? 'bg-kidville-green-soft text-kidville-green'
                    : 'text-kidville-ink/70 hover:bg-kidville-green-soft hover:text-kidville-green'
                }`}
              >
                {Icon && <Icon size={20} strokeWidth={2.2} className="shrink-0" />}
                <span className="min-w-0 flex-1 text-left">
                  {group.titleKey && te.has(group.titleKey) ? te(group.titleKey) : group.title}
                </span>
                {conCoda && !isAperto && <ContatoreCodaFatture n={vociCoda} />}
                <ChevronDown
                  size={16}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  className={`shrink-0 transition-transform duration-200 ${isAperto ? 'rotate-180' : ''}`}
                />
              </button>
              {isAperto && (
                // Voci rientrate, con un filo a sinistra: si vede a colpo d'occhio di chi sono figlie.
                <div
                  id={idPannello}
                  role="group"
                  aria-labelledby={idIntestazione}
                  className="ml-3 flex flex-col gap-1 border-l border-kidville-line pl-2"
                >
                  {group.items.map(rigaVoce)}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-kidville-line px-3 py-3">
        <LogoutMenuButton className={LOGOUT_ROW_CLS} />
      </div>
    </aside>
  );
}
