'use client';

import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { CambiaProfiloMenuButton } from '@/components/ui/CambiaProfiloMenuButton';

/**
 * IL MENU RAGGRUPPATO di genitori e docenti — le carte dei gruppi, il cambio di profilo, l'uscita.
 *
 * Era scritto due volte, identico, dentro il foglio dal basso di `parent/BottomNav` e di
 * `teacher/TeacherBottomNav`. Con il tablet serve una terza volta, nel pannello che il binario
 * apre accanto a sé: tre copie di un elenco sono tre posti in cui domani una voce cambia in uno
 * solo. Le VOCI restano nei due file delle barre (le leggono i lock delle tinte e dei selettori
 * Maestro); qui c'è soltanto come si disegnano.
 *
 * Le uniche differenze fra le due aree arrivano come prop: `hrefDi` (il docente propaga
 * `?userId=` su ogni link) e il testo del badge «In arrivo», che ha una chiave per catalogo.
 */

export interface VoceMenu {
  id: string;
  label: string;
  sub: string;
  icon: LucideIcon;
  /** null = funzione non ancora navigabile (nessuna rotta reale). */
  href: string | null;
  tint: string;
  soon?: boolean;
}

export interface GruppoMenu {
  label: string;
  items: VoceMenu[];
}

interface Props {
  gruppi: GruppoMenu[];
  pathname: string;
  hrefDi: (href: string) => string;
  /**
   * Chiude il contenitore SOLO al tocco della voce della rotta in cui si è già: lì nessuna
   * navigazione avviene, quindi il cambio di `pathname` che chiude il foglio non arriverebbe mai.
   * Altrove il foglio NON si chiude nel click: smonterebbe il `<Link>` mentre Next porta la
   * navigazione in una transizione React, e la navigazione si perderebbe (traccia della run
   * 30920578641; lock `__tests__/ui/bottom-nav-menu-navigazione.test.tsx`).
   */
  onChiudi: () => void;
  etichettaInArrivo: string;
}

export function ElencoGruppiMenu({ gruppi, pathname, hrefDi, onChiudi, etichettaInArrivo }: Props) {
  return (
    <div className="flex flex-col gap-[18px]">
      {gruppi.map((g) => (
        <div key={g.label}>
          <p className="font-barlow font-extrabold text-[11px] uppercase tracking-[0.06em] text-kidville-sub mb-2 pl-1">
            {g.label}
          </p>
          <div
            className="bg-white rounded-card overflow-hidden"
            style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}
          >
            {g.items.map((it, i) => {
              const Icon = it.icon;
              const active = it.href ? pathname.startsWith(it.href) : false;
              const borderCls = i < g.items.length - 1 ? 'border-b border-kidville-line' : '';

              const inner = (
                <>
                  <span
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
                    style={{ background: it.tint + '18', color: it.tint }}
                  >
                    <Icon size={21} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-barlow font-extrabold text-base uppercase leading-none text-kidville-green truncate">
                        {it.label}
                      </span>
                      {it.soon && (
                        <span className="font-barlow font-bold text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded-pill bg-kidville-neutral-soft text-kidville-sub">
                          {etichettaInArrivo}
                        </span>
                      )}
                    </span>
                    <span className="block font-maven text-xs text-kidville-sub mt-0.5">{it.sub}</span>
                  </span>
                  {it.href && <ChevronRight size={16} className="text-kidville-sub/60 flex-shrink-0" strokeWidth={2} />}
                </>
              );

              if (!it.href) {
                return (
                  <div
                    key={it.id}
                    aria-disabled="true"
                    className={`flex items-center gap-[13px] px-3 py-[11px] opacity-60 ${borderCls}`}
                  >
                    {inner}
                  </div>
                );
              }
              return (
                <Link
                  key={it.id}
                  href={hrefDi(it.href)}
                  onClick={active ? onChiudi : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-[13px] px-3 py-[11px] active:bg-kidville-cream ${borderCls}`}
                >
                  {inner}
                </Link>
              );
            })}
          </div>
        </div>
      ))}

      {/* Cambio di veste — visibile SOLO a chi ha davvero due profili (le insegnanti che sono
          anche genitori). Per tutti gli altri il componente non renderizza niente: un'affordance
          morta in un menu che si apre ogni giorno è rumore. Sta lontano da «Esci», che è
          distruttivo. */}
      <CambiaProfiloMenuButton
        iconSize={21}
        className="flex w-full items-center justify-center gap-2.5 rounded-card bg-white px-3 py-[13px] font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green shadow-[0_1px_2px_rgba(0,84,75,.04),0_8px_24px_-18px_rgba(0,84,75,.28)] active:bg-kidville-green-soft disabled:opacity-60"
      />

      <LogoutMenuButton
        iconSize={21}
        className="flex w-full items-center justify-center gap-2.5 rounded-card bg-white px-3 py-[13px] font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-error shadow-[0_1px_2px_rgba(0,84,75,.04),0_8px_24px_-18px_rgba(0,84,75,.28)] active:bg-kidville-error-soft disabled:opacity-60"
      />
    </div>
  );
}
