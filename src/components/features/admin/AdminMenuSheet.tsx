'use client';

/**
 * Bottom-sheet «Menu» del cockpit Direzione/Segreteria (<lg).
 *
 * È la seconda metà della navigazione mobile: la bottom-nav (`AdminBottomNav`)
 * tiene i 4 tab ad alta frequenza (Home · Avvisi · Contabilità · Mensa), qui
 * vivono TUTTE le altre sezioni. La sorgente è la config condivisa
 * (`admin-nav-config.ts`): stessi gruppi, stesso `visibleItem` (gating per
 * ruolo) della sidebar desktop — nessuna nav morta, nessuna logica nuova.
 *
 * A differenza del vecchio drawer laterale (che NON era un modale: nessun
 * focus-trap, nessun Esc — warning del ciclo precedente), questo sheet nasce
 * ACCESSIBILE:
 *  - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`;
 *  - focus iniziale sul bottone «Chiudi», focus-trap ciclico (Tab/Shift+Tab),
 *    Esc chiude, e alla chiusura il focus TORNA al bottone «Menu» che l'ha aperto;
 *  - overlay che chiude al click, `max-h-[70vh]` scrollabile, safe-area in fondo.
 *
 * Colori SOLO via token (`bg-kidville-*`/`text-kidville-*`) — mai hex letterali:
 * il lock `design-tokens-admin` scansiona `features/admin/**`, e le regole Alto
 * Contrasto di `.kv-admin-sheet` (globals.css) si agganciano a quelle classi.
 */

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { X, Users, ChevronRight } from 'lucide-react';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';
import { NAV_GROUPS, visibleItem } from './admin-nav-config';

// Elementi che possono ricevere focus dentro lo sheet — per il focus-trap.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface AdminMenuSheetProps {
  open: boolean;
  onClose: () => void;
  /** userId per gli href (?userId=) — via withUser di useAdminIdentity. */
  withUser: (href: string) => string;
  /** Ruolo corrente per il gating `visibleItem` delle voci. */
  ruolo: string;
  /** Bottone «Menu» a cui restituire il focus alla chiusura. */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}

// Gli href dei 4 tab già in bottom-nav: NON si ripetono nello sheet. Anagrafica
// (/admin/students) è mostrata in evidenza in cima → esclusa anch'essa dai gruppi.
const TAB_HREFS = new Set(['/admin', '/admin/avvisi', '/admin/pagamenti', '/admin/mensa']);
const ANAGRAFICA_HREF = '/admin/students';
const ESCLUSI = new Set<string>([...TAB_HREFS, ANAGRAFICA_HREF]);

// Riga di uno stesso stile per Anagrafica-in-evidenza e per le voci di gruppo:
// altezza ≥44px (touch), tap-target pieno, chevron a destra.
const ROW_CLS =
  'flex items-center gap-3 min-h-[44px] px-3 py-2.5 rounded-xl font-maven text-sm text-kidville-ink transition-colors hover:bg-kidville-green-soft active:bg-kidville-green-soft';

const FOOTER_BTN_CLS =
  'flex w-full items-center gap-3 min-h-[44px] px-3 py-2.5 rounded-xl font-maven text-sm font-semibold transition-colors';

export function AdminMenuSheet({ open, onClose, withUser, ruolo, returnFocusRef }: AdminMenuSheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus iniziale sul «Chiudi» all'apertura; alla chiusura (unmount dello sheet)
  // il focus torna al bottone «Menu». `open` guida il mount → il cleanup coincide
  // con la chiusura, quindi qui vive tutto il ciclo di vita del focus.
  useEffect(() => {
    if (!open) return;
    const previous = returnFocusRef.current;
    // Scroll-lock del body mentre lo sheet modale è aperto: il contenuto dietro
    // non deve scorrere (WCAG / comportamento da dialog vero). Ripristinato nel
    // cleanup PRIMA di restituire il focus al bottone «Menu».
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Il render è già avvenuto: il bottone Chiudi esiste.
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      previous?.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  // Gruppi filtrati per ruolo, senza gli href già coperti dai tab / da Anagrafica.
  const gruppi = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => visibleItem(i, ruolo) && !ESCLUSI.has(i.href)),
  })).filter((g) => g.items.length > 0);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="lg:hidden fixed inset-0 z-[110]" onKeyDown={onKeyDown}>
      {/* Overlay: chiude al click. Sotto lo sheet, sopra il resto. */}
      <div
        className="absolute inset-0 bg-kidville-green/30 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-menu-sheet-title"
        className="kv-admin-sheet absolute left-1/2 bottom-0 -translate-x-1/2 w-full max-w-[520px] max-h-[70vh] overflow-y-auto rounded-t-[26px] bg-kidville-white shadow-[0_-8px_40px_rgba(0,0,0,0.18)] px-4 pt-4"
        style={{ paddingBottom: 'max(20px, calc(env(safe-area-inset-bottom) + 16px))' }}
      >
        <div className="flex items-center justify-between mb-3 px-1">
          <div>
            <p className="font-barlow font-bold text-[10px] uppercase tracking-[0.14em] text-kidville-sub">
              Tutte le sezioni
            </p>
            <h2
              id="admin-menu-sheet-title"
              className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide leading-none"
            >
              Menu
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Chiudi"
            className="w-11 h-11 rounded-full bg-kidville-cream-dark flex items-center justify-center text-kidville-green"
          >
            <X className="w-4 h-4" strokeWidth={2.4} />
          </button>
        </div>

        {/* Anagrafica in evidenza — la sezione di consultazione più frequente da
            telefono (decisione utente), fuori dai gruppi e ben visibile. */}
        <Link href={withUser(ANAGRAFICA_HREF)} onClick={onClose} className={`${ROW_CLS} bg-kidville-green-soft mb-4`}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-kidville-green">
            <Users size={18} strokeWidth={2} className="text-kidville-yellow" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-barlow font-extrabold text-base uppercase leading-none text-kidville-green">
              Anagrafica
            </span>
            <span className="block font-maven text-xs text-kidville-muted mt-0.5">
              Alunni, famiglie e personale
            </span>
          </span>
          <ChevronRight size={16} className="text-kidville-muted shrink-0" strokeWidth={2} />
        </Link>

        <div className="flex flex-col gap-4">
          {gruppi.map((g, gi) => (
            <div key={gi} className="flex flex-col gap-1">
              {g.title && (
                <p className="px-1 pb-1 font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-muted">
                  {g.title}
                </p>
              )}
              {g.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={withUser(item.href)} onClick={onClose} className={ROW_CLS}>
                    <Icon size={20} strokeWidth={2} className="shrink-0 text-kidville-green" />
                    <span className="min-w-0 flex-1 font-semibold">{item.label}</span>
                    <ChevronRight size={16} className="text-kidville-muted shrink-0" strokeWidth={2} />
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Accessibilità + uscita, in fondo come nel BottomNav genitore/docente. */}
        <div className="mt-4 border-t border-kidville-line pt-3 flex flex-col gap-1">
          <ContrastMenuButton className={`${FOOTER_BTN_CLS} text-kidville-ink hover:bg-kidville-green-soft`} />
          <LogoutMenuButton className={`${FOOTER_BTN_CLS} text-kidville-error hover:bg-kidville-error-soft disabled:opacity-60`} />
        </div>
      </div>
    </div>
  );
}
