'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { BERSAGLIO_TOCCO } from '@/components/ui/FoglioFiltri';

/**
 * ─── SCELTA MULTIPLA DELLA CONTABILITÀ — parte generica ─────────────────────
 *
 *   ETICHETTA
 *   [ riepilogo della scelta      ▾ ]      ← comando
 *   ┌───────────────────────────────┐
 *   │ (TESTO TUTTE)                 │     ← azzera; premuto se `tutteAttiva`
 *   │ TITOLO GRUPPO                 │     ← un gruppo per `fieldset`/`legend`
 *   │ (VOCE) (VOCE)                 │
 *   └───────────────────────────────┘
 *
 * Estratto da `FiltroClassiContabilita` perché lo stesso controllo serva a
 * classi, categorie e mesi. È CONTROLLATO e senza testi propri: ogni stringa
 * (etichetta, riepilogo, voci, nome del pannello, legenda di ripiego) arriva dal
 * chiamante, che sa in che lingua e per che dominio parla.
 *
 * Accessibilità (invariata rispetto al filtro delle classi): comando a
 * disclosure con `aria-expanded` + `aria-controls`, pannello sempre nel DOM con
 * `hidden`, pastiglie `aria-pressed` in un `fieldset`/`legend`, Escape e clic
 * fuori chiudono, il fuoco torna al comando. Sotto `sm` il pannello scende nel
 * flusso a piena larghezza e i bersagli sono da 44px.
 */

// Geometria e pastiglie: le stesse di `ui/BarraFiltri` (niente `outline-none`,
// vedi la nota sul fuoco in quel file). Ricopiate e non importate perché là
// sono costanti interne al modulo.
const GEOMETRIA =
  'h-[42px] rounded-input border-[1.5px] border-kidville-line bg-kidville-white font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';
const ETICHETTA =
  'mb-1 block font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-sub';
// Bersaglio di tocco: la costante del design system (`BERSAGLIO_TOCCO`),
// applicata mobile-first e annullata da `sm` in su. Non `max-sm:${BERSAGLIO_TOCCO}`:
// Tailwind legge le classi dal sorgente come testo, e una classe composta a
// runtime non genererebbe CSS.
const PASTIGLIA = cx(
  'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-barlow text-[13px] font-extrabold uppercase tracking-[0.02em] transition-colors',
  BERSAGLIO_TOCCO,
  'sm:min-h-0 max-sm:px-4',
);
const PASTIGLIA_ON = 'bg-kidville-green text-kidville-white';
const PASTIGLIA_OFF =
  'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50';

export interface VoceSceltaMultipla {
  /**
   * Identificatore della voce. Deve essere UNICO fra TUTTI i gruppi, non solo
   * dentro il suo: `attive` è un insieme piatto di id, e due voci con lo stesso
   * id in gruppi diversi risulterebbero premute insieme.
   */
  id: string;
  /** Testo visibile della pastiglia. */
  testo: string;
  /** Nome accessibile, se deve dire più del testo visibile (deve cominciare col testo, WCAG 2.5.3). */
  nomeAccessibile?: string;
}

export interface GruppoSceltaMultipla {
  chiave: string;
  /** Intestazione del gruppo; assente = si usa `legendaPredefinita`. */
  titolo?: string | null;
  voci: VoceSceltaMultipla[];
}

export interface SceltaMultiplaContabilitaProps {
  /** Etichetta visibile sopra il comando. */
  etichetta: string;
  /** Testo del comando: sintesi della scelta corrente. */
  riepilogo: string;
  /** Testo della pastiglia che azzera la scelta. */
  testoTutte: string;
  /** La pastiglia «tutte» è premuta (niente è scelto). */
  tutteAttiva: boolean;
  /** Nome accessibile del pannello (`role="group"`). */
  etichettaPannello: string;
  /** Legenda dei gruppi senza titolo. */
  legendaPredefinita: string;
  gruppi: GruppoSceltaMultipla[];
  /** Gli id delle voci attive (`aria-pressed`). */
  attive: ReadonlySet<string>;
  onCommuta: (id: string) => void;
  onTutte: () => void;
  className?: string;
}

export function SceltaMultiplaContabilita({
  etichetta,
  riepilogo,
  testoTutte,
  tutteAttiva,
  etichettaPannello,
  legendaPredefinita,
  gruppi,
  attive,
  onCommuta,
  onTutte,
  className,
}: SceltaMultiplaContabilitaProps) {
  const idBase = useId();
  const idEtichetta = `${idBase}-etichetta`;
  const idRiepilogo = `${idBase}-riepilogo`;
  const idPannello = `${idBase}-pannello`;
  const [aperto, setAperto] = useState(false);
  const comandoRef = useRef<HTMLButtonElement>(null);
  const contenitoreRef = useRef<HTMLDivElement>(null);

  // Escape e clic fuori chiudono. `setState` sta dentro un ASCOLTATORE, non nel
  // corpo dell'effetto (`react-hooks/set-state-in-effect`): stesso schema di
  // `BarraFiltri`.
  useEffect(() => {
    if (!aperto) return;
    const suTasto = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAperto(false);
      // WCAG 2.4.3: il fuoco torna al comando, non cade sul `<body>`.
      comandoRef.current?.focus();
    };
    const suClic = (e: MouseEvent) => {
      if (contenitoreRef.current && !contenitoreRef.current.contains(e.target as Node)) setAperto(false);
    };
    // Con più controlli affiancati (Classi, Categorie, Mesi) da tastiera si
    // potevano aprire due pannelli insieme: il pannello si chiude anche quando
    // il FUOCO esce dal contenitore. Qui il fuoco NON si riporta al comando: è
    // andato altrove per scelta dell'utente.
    const suFuoco = (e: FocusEvent) => {
      if (contenitoreRef.current && e.target instanceof Node && !contenitoreRef.current.contains(e.target)) {
        setAperto(false);
      }
    };
    document.addEventListener('keydown', suTasto);
    document.addEventListener('mousedown', suClic);
    document.addEventListener('focusin', suFuoco);
    return () => {
      document.removeEventListener('keydown', suTasto);
      document.removeEventListener('mousedown', suClic);
      document.removeEventListener('focusin', suFuoco);
    };
  }, [aperto]);

  const pastiglia = (attiva: boolean) => cx(PASTIGLIA, attiva ? PASTIGLIA_ON : PASTIGLIA_OFF);

  return (
    <div ref={contenitoreRef} className={cx('relative min-w-0', className)}>
      <span id={idEtichetta} className={ETICHETTA}>
        {etichetta}
      </span>
      <button
        ref={comandoRef}
        type="button"
        aria-labelledby={`${idEtichetta} ${idRiepilogo}`}
        aria-expanded={aperto}
        aria-controls={idPannello}
        onClick={() => setAperto((v) => !v)}
        className={cx(
          GEOMETRIA,
          // `max-sm:h-[44px]`: sul telefono anche il comando è un bersaglio da
          // 44px, come il campo di `BarraFiltri` nel modo `tocco`.
          'inline-flex w-full min-w-[200px] cursor-pointer items-center justify-between gap-2 px-3 text-left hover:border-kidville-green/50 max-sm:h-[44px] sm:w-auto',
        )}
      >
        <span id={idRiepilogo} className="min-w-0 truncate">
          {riepilogo}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cx('shrink-0 text-kidville-sub transition-transform', aperto && 'rotate-180')}
        />
      </button>

      {/* Sempre nel DOM: `aria-controls` punta qui, e un riferimento che sparisce
          a pannello chiuso è un `aria-controls` rotto. Niente `role="menu"`: un
          menu ARIA promette la navigazione con le frecce, che qui non c'è. */}
      <div
        id={idPannello}
        hidden={!aperto}
        role="group"
        aria-label={etichettaPannello}
        className={cx(
          'z-40 mt-2 w-full rounded-card border border-kidville-line bg-kidville-white p-4 shadow-xl',
          'sm:absolute sm:left-0 sm:top-full sm:w-[360px] sm:max-w-[92vw]',
          'max-h-[60vh] overflow-y-auto',
        )}
      >
        <div className="flex flex-col gap-4">
          <div>
            <button type="button" aria-pressed={tutteAttiva} onClick={onTutte} className={pastiglia(tutteAttiva)}>
              {testoTutte}
            </button>
          </div>

          {gruppi.map((g) => (
            // `fieldset`/`legend`: le pastiglie sono un GRUPPO di interruttori.
            // Non `role="radiogroup"`: la scelta è multipla e revocabile.
            <fieldset key={g.chiave} className="min-w-0 border-0 p-0">
              <legend className={ETICHETTA}>{g.titolo || legendaPredefinita}</legend>
              <div className="flex flex-wrap items-center gap-2">
                {g.voci.map((v) => {
                  const attiva = attive.has(v.id);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={attiva}
                      // `aria-label` e non uno `span.sr-only` col separatore: lo
                      // spazio in testa a un nodo figlio viene tagliato da alcuni
                      // motori di calcolo del nome (jsdom).
                      aria-label={v.nomeAccessibile}
                      onClick={() => onCommuta(v.id)}
                      className={pastiglia(attiva)}
                    >
                      {v.testo}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
    </div>
  );
}
