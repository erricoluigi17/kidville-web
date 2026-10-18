'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, type LucideIcon } from 'lucide-react';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { CambiaProfiloMenuButton } from '@/components/ui/CambiaProfiloMenuButton';
import type { PezziBadgeChatNonLetti } from '@/components/features/chat/BadgeChatNonLetti';
import { ElencoGruppiMenu, type GruppoMenu } from './ElencoGruppiMenu';

/**
 * LA NAVIGAZIONE DI GENITORI E DOCENTI SUL TABLET — al posto della barra in basso.
 *
 * Due formati, scelti da `useFormatoGuscio` (mai dal CSS: nel DOM c'è sempre UNA navigazione
 * sola, vedi l'hook):
 *
 *   · `binario` (744–1023 px, iPad mini/11" in verticale): una colonna da 88 px con gli stessi
 *     cinque tab della barra del telefono. «Menu» apre il menu raggruppato in un pannello accanto
 *     al binario, invece che in un foglio dal basso.
 *   · `sidebar` (da 1024 px: iPad 13" in verticale, ogni iPad in orizzontale, i PC): tutte le
 *     voci in vista, raggruppate come nel menu, senza un tocco in più per arrivarci.
 *
 * Le voci NON vivono qui: arrivano da `useVociGenitore` / `useVociDocente`, cioè dalle stesse
 * liste della barra in basso. Qui c'è soltanto come si disegnano.
 *
 * Lo spazio che il contenuto deve lasciare è `--kv-rail-w` (`globals.css`, sul guscio
 * `[data-kv-guscio-tablet]`): la barra lo legge per la propria larghezza, i layout per il loro
 * margine. Una misura, due lettori, nessun numero copiato.
 *
 * `z-40`: sotto i modali delle pagine (`z-50`) e sotto il visore dei media, che deve coprire
 * TUTTO il chrome fisso (lock `visore-media-sopra-la-bottom-nav`).
 */

export interface TabPrincipale {
  id: string;
  label: string;
  icon: LucideIcon;
  /** null = il tab «Menu», che apre il pannello invece di navigare. */
  href: string | null;
}

interface Testi {
  ariaMenu: string;
  eyebrow: string;
  titolo: string;
  chiudi: string;
  inArrivo: string;
}

interface Props {
  formato: 'binario' | 'sidebar';
  /** «Navigazione principale», dal catalogo dell'area: lo stesso nome della barra in basso. */
  ariaNav: string;
  tab: readonly TabPrincipale[];
  gruppi: GruppoMenu[];
  pathname: string;
  isActive: (href: string) => boolean;
  /** Il tab «Menu» è acceso: si è su una voce del menu che non ha un tab suo. */
  menuAcceso: boolean;
  hrefDi: (href: string) => string;
  /** L'id della voce che porta il badge dei messaggi non letti: `chat` (genitore), `messaggi` (docente). */
  idBadge: string;
  nonLetti: PezziBadgeChatNonLetti;
  testi: Testi;
}

/** La voce attiva della sidebar: quella col percorso PIÙ LUNGO che contiene la rotta corrente. */
export function voceAttiva(pathname: string, hrefs: readonly { id: string; href: string | null }[], radice: string): string | null {
  let migliore: { id: string; lunghezza: number } | null = null;
  for (const v of hrefs) {
    if (!v.href) continue;
    const combacia =
      v.href === radice ? pathname === radice : pathname === v.href || pathname.startsWith(`${v.href}/`);
    if (combacia && (!migliore || v.href.length > migliore.lunghezza)) migliore = { id: v.id, lunghezza: v.href.length };
  }
  return migliore?.id ?? null;
}

const RIGA_SIDEBAR =
  'relative flex items-center gap-3 rounded-xl px-4 py-2.5 font-maven text-sm font-semibold transition-colors';
const RIGA_ATTIVA = 'bg-kidville-green text-white';
const RIGA_INATTIVA = 'text-kidville-sub hover:bg-kidville-green-soft hover:text-kidville-green';

export function BarraLaterale(props: Props) {
  return (
    <aside
      data-kv-barra-laterale
      data-formato={props.formato}
      className="kv-barra-laterale fixed left-0 bottom-0 z-40 flex flex-col overflow-y-auto border-r border-kidville-line bg-kidville-white"
      style={{ top: 'var(--kv-appbar-h)', width: 'var(--kv-rail-w)' }}
    >
      {props.formato === 'binario' ? <Binario {...props} /> : <Sidebar {...props} />}
    </aside>
  );
}

// ── BINARIO ─────────────────────────────────────────────────────────────────

function Binario({ ariaNav, tab, gruppi, pathname, isActive, menuAcceso, hrefDi, idBadge, nonLetti, testi }: Props) {
  const [aperto, setAperto] = useState(false);
  const idTitolo = useId();
  const chiudiRef = useRef<HTMLButtonElement>(null);
  const riduci = useReducedMotion();

  // Il pannello si chiude QUANDO la rotta è cambiata, non nel click della voce: la stessa regola
  // del foglio della barra in basso, per la stessa ragione (`ElencoGruppiMenu`). Aggiustamento di
  // stato in render, non `useEffect`: nessuna finestra in cui il pannello resta aperto sulla
  // pagina nuova.
  const [rottaVista, setRottaVista] = useState(pathname);
  if (rottaVista !== pathname) {
    setRottaVista(pathname);
    setAperto(false);
  }

  // Il fuoco entra nel pannello all'apertura: chi naviga da tastiera non deve ripercorrere il
  // binario per arrivarci. Spostare il fuoco non è uno stato di React.
  useEffect(() => {
    if (aperto) chiudiRef.current?.focus();
  }, [aperto]);

  return (
    <>
      <nav aria-label={ariaNav} className="flex flex-col items-stretch gap-1 px-2 py-3">
        {tab.map((voce) => {
          const Icon = voce.icon;
          const attivo = voce.href ? isActive(voce.href) : menuAcceso || aperto;
          const pillola = `relative flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-200 ${
            attivo ? 'bg-kidville-green' : ''
          }`;
          const icona = `h-5 w-5 transition-colors duration-200 ${attivo ? 'text-kidville-yellow' : 'text-kidville-sub'}`;
          const etichetta = `font-barlow text-[10px] font-bold uppercase tracking-wider ${
            attivo ? 'text-kidville-green' : 'text-kidville-sub'
          }`;
          const classeVoce = 'flex flex-col items-center gap-1 rounded-xl py-2.5 active:bg-kidville-cream';

          if (!voce.href) {
            return (
              <button
                key={voce.id}
                type="button"
                onClick={() => setAperto((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={aperto}
                aria-label={testi.ariaMenu}
                className={classeVoce}
              >
                <span className={pillola}>
                  <Icon className={icona} strokeWidth={2} />
                </span>
                <span className={etichetta}>{voce.label}</span>
              </button>
            );
          }

          // Badge e descrizione: PRIMO figlio della pillola e PRIMO figlio del link, come nella
          // barra in basso (l'ordine conta: vedi `useBadgeChatNonLetti`).
          const conBadge = voce.id === idBadge;
          return (
            <Link
              key={voce.id}
              href={hrefDi(voce.href)}
              aria-current={attivo ? 'page' : undefined}
              aria-describedby={conBadge ? nonLetti.descrittoDa : undefined}
              className={classeVoce}
            >
              {conBadge && nonLetti.descrizione}
              <span className={pillola}>
                {conBadge && nonLetti.badge}
                <Icon className={icona} strokeWidth={2} />
              </span>
              <span className={etichetta}>{voce.label}</span>
            </Link>
          );
        })}
      </nav>

      <AnimatePresence>
        {aperto && (
          <>
            <motion.div
              key="velo"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: riduci ? 0 : 0.2 }}
              className="fixed inset-0 z-40 bg-kidville-green/30 backdrop-blur-[2px]"
              onClick={() => setAperto(false)}
            />
            <motion.div
              key="pannello"
              role="dialog"
              aria-modal="true"
              aria-labelledby={idTitolo}
              initial={riduci ? false : { x: -16, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={riduci ? { opacity: 0 } : { x: -16, opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 380 }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAperto(false);
                }
              }}
              className="fixed bottom-0 z-50 w-[360px] max-w-[calc(100vw-var(--kv-rail-w))] overflow-y-auto border-r border-black/5 bg-kidville-cream p-4 shadow-2xl"
              style={{ top: 'var(--kv-appbar-h)', left: 'var(--kv-rail-w)' }}
            >
              <div className="mb-3 flex items-center justify-between px-1">
                <div>
                  <p className="font-barlow text-[10px] font-bold uppercase tracking-[0.14em] text-kidville-yellow-dark">
                    {testi.eyebrow}
                  </p>
                  <h3
                    id={idTitolo}
                    className="font-barlow text-xl font-black uppercase leading-none tracking-wide text-kidville-green"
                  >
                    {testi.titolo}
                  </h3>
                </div>
                <button
                  ref={chiudiRef}
                  type="button"
                  onClick={() => setAperto(false)}
                  aria-label={testi.chiudi}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-kidville-cream-dark text-kidville-green"
                >
                  <X className="h-4 w-4" strokeWidth={2.4} />
                </button>
              </div>
              <ElencoGruppiMenu
                gruppi={gruppi}
                pathname={pathname}
                hrefDi={hrefDi}
                onChiudi={() => setAperto(false)}
                etichettaInArrivo={testi.inArrivo}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

// ── SIDEBAR ─────────────────────────────────────────────────────────────────

function Sidebar({ ariaNav, tab, gruppi, pathname, hrefDi, idBadge, nonLetti, testi }: Props) {
  // La prima voce dei tab è la home dell'area (`/parent`, `/teacher`): sta in cima. Gli altri tab
  // (Diario, Avvisi, Chat, Foto…) sono già voci dei gruppi, e ripeterli farebbe due righe uguali.
  const home = tab[0];
  const voci = [home, ...gruppi.flatMap((g) => g.items)];
  const attiva = voceAttiva(pathname, voci, home.href ?? '');

  const riga = (v: { id: string; label: string; icon: LucideIcon; href: string | null; tint?: string; soon?: boolean }): ReactNode => {
    const Icon = v.icon;
    const attivo = v.id === attiva;
    if (!v.href) {
      return (
        <div key={v.id} aria-disabled="true" className={`${RIGA_SIDEBAR} ${RIGA_INATTIVA} opacity-60`}>
          <Icon size={20} strokeWidth={2.2} className="shrink-0" style={v.tint ? { color: v.tint } : undefined} />
          <span className="min-w-0 flex-1 truncate">{v.label}</span>
          {v.soon && (
            <span className="rounded-pill bg-kidville-neutral-soft px-1.5 py-0.5 font-barlow text-[9.5px] font-bold uppercase tracking-wide text-kidville-sub">
              {testi.inArrivo}
            </span>
          )}
        </div>
      );
    }
    const conBadge = v.id === idBadge;
    return (
      <Link
        key={v.id}
        href={hrefDi(v.href)}
        aria-current={attivo ? 'page' : undefined}
        aria-describedby={conBadge ? nonLetti.descrittoDa : undefined}
        className={`${RIGA_SIDEBAR} ${attivo ? RIGA_ATTIVA : RIGA_INATTIVA}`}
      >
        {conBadge && nonLetti.descrizione}
        <span className="relative flex shrink-0">
          {conBadge && nonLetti.badge}
          <Icon
            size={20}
            strokeWidth={2.2}
            className={attivo ? 'text-kidville-yellow' : ''}
            style={!attivo && v.tint ? { color: v.tint } : undefined}
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{v.label}</span>
      </Link>
    );
  };

  return (
    <>
      <nav aria-label={ariaNav} className="flex flex-col gap-1 px-3 pb-4 pt-4">
        {riga(home)}
        {gruppi.map((g) => (
          <div key={g.label} className="flex flex-col gap-0.5">
            <p className="px-4 pb-1 pt-3 font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-sub">
              {g.label}
            </p>
            {g.items.map((v) => riga(v))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1 border-t border-kidville-line px-3 py-3">
        <CambiaProfiloMenuButton
          iconSize={20}
          className={`${RIGA_SIDEBAR} w-full text-kidville-green hover:bg-kidville-green-soft disabled:opacity-60`}
        />
        <LogoutMenuButton
          iconSize={20}
          className={`${RIGA_SIDEBAR} w-full text-kidville-error hover:bg-kidville-error-soft disabled:opacity-60`}
        />
      </div>
    </>
  );
}
