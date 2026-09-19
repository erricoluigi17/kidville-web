'use client';

import { Minus, Plus } from 'lucide-react';
import { cx } from '@/lib/ui/cx';

/**
 * ─── CONTATORE ± CON CLAMP, PER IL POLLICE ──────────────────────────────────
 *
 * Un numero con un minimo, un massimo e la possibilità di non essere indicato
 * affatto. Nasce per i partecipanti di un avviso (minimo, massimo, posti), dove
 * sulla stessa schermata di contatori ce ne sono sei.
 *
 * ── 1. PERCHÉ NON SI RIUSA `NumberField` ────────────────────────────────────
 *
 * `NumberField` (`src/components/features/admin/settings/fields.tsx:27`) non è
 * riusabile qui, e non per gusto:
 *   · vive in una *feature* e importa le classi di quel pannello (`./ui`);
 *   · rende la propria `<label>` dai `children`, quindi non sta dentro un
 *     `role="group"` con una descrizione condivisa fra più campi;
 *   · **non clampa**: su campo svuotato emette `Number('') === 0` — che con un
 *     minimo di 1 è un valore che il modulo non dovrebbe poter produrre — e su
 *     testo `NaN`, che poi viaggia fino a `zod` o, peggio, a una colonna.
 *
 * ── 2. PERCHÉ NON BASTANO LE FRECCE NATIVE ──────────────────────────────────
 *
 * Le spin button di `<input type="number">` sono alte ~10 px: col pollice, in
 * WebView, sono inusabili — e su iOS non esistono proprio. Il repo l'aveva già
 * imparato in `teacher/locker/LoadStockModal.tsx:176`, che le nasconde, forza
 * `inputMode="numeric"` e mette un `font-size` inline ≥16 px contro l'auto-zoom di
 * Safari. Ripetere quelle tre accortezze SEI VOLTE nella stessa schermata è il
 * punto in cui una primitiva si ripaga nel lavoro stesso in cui nasce.
 *
 * ── 3. 🔴 PERIMETRO DICHIARATO: LE QUATTRO COPIE INLINE NON SI TOCCANO ──────
 *
 * Questa primitiva nasce DOPO di loro e non è un rifiuto della loro esistenza:
 *   · `admin/merchandise/page.tsx:339`
 *   · `teacher/locker/LoadStockModal.tsx:176`
 *   · `teacher/diary/DiaryEventEditor.tsx:851`
 *   · `admin/forms/rankings/RankingAdjustModal.tsx:255`
 * Restano come sono. Migrarle è un intervento con il suo collaudo — quattro
 * schermate vere, con i loro numeri e i loro bordi — e farlo di straforo dentro un
 * altro lavoro è il modo in cui si rompono cose che nessuno stava guardando. Chi
 * verrà dopo sappia che il posto dove migrarle è questo file, e che il giorno in
 * cui lo farà questa riga va riscritta.
 *
 * ── 4. AI BORDI SI USA `aria-disabled`, MAI `disabled` ──────────────────────
 *
 * È la stessa lezione già scritta sul bottone d'invio del modulo avvisi: un
 * `disabled` nativo esce dal giro del Tab e Chrome **scarica il fuoco su `<body>`**,
 * cioè all'inizio della pagina. Qui pesa di più che altrove, perché al bordo
 * dell'intervallo ci si arriva proprio premendo ± ripetutamente — cioè con il fuoco
 * SOPRA il bottone che sta per spegnersi. Il comando resta quindi raggiungibile,
 * si dichiara `aria-disabled` (uno screen reader lo annuncia «non disponibile») e
 * la guardia sta nell'handler, che al bordo non fa niente.
 *
 * ⚠️ La prop `disabled` di questo componente è un'ALTRA cosa: lì è tutto il
 * controllo a essere spento (modulo in invio, permesso mancante), non un estremo
 * raggiunto contando, e il `disabled` nativo è la dichiarazione giusta.
 *
 * ── 5. IL CAMPO CENTRALE RESTA `type="number"` ──────────────────────────────
 *
 * Con le spin button nascoste sembrerebbe più semplice un `type="text"` con
 * `inputMode="numeric"`. Non lo è: `type="number"` porta il ruolo `spinbutton`
 * implicito, e con lui `aria-valuenow`/`aria-valuemin`/`aria-valuemax` presi da
 * `value`/`min`/`max` senza un solo attributo ARIA scritto a mano — cioè uno
 * screen reader che annuncia «3, minimo 1, massimo 40» invece di «3».
 *
 * ── 6. IL CLAMP ALLA DIGITAZIONE, E IL SUO COMPROMESSO DICHIARATO ───────────
 *
 * Il valore digitato viene clampato subito. Con un `min` maggiore di 1 questo
 * rende scomoda la digitazione di un numero che *passa* sotto il minimo (con
 * `min={10}`, battere «1» mostra subito «10»): è il compromesso noto di questa
 * scelta, accettato perché i minimi di questo prodotto sono 0 o 1 e perché
 * l'alternativa — lasciare uscire un valore fuori intervallo e correggerlo al
 * blur — è quella che ha prodotto `Number('') === 0` in `NumberField`. Se un
 * giorno servirà un `min` alto, la correzione è clampare al blur e non qui: si
 * cambia in un posto solo.
 *
 * Il componente NON contiene testo: le etichette dei due comandi e il segnaposto
 * arrivano come prop dal punto d'uso.
 */

export interface StepperProps {
  /** `null` = «non indicato», che è diverso da zero. */
  value: number | null;
  onChange: (n: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Se vero, il campo svuotato torna `null` invece del minimo. */
  consentiVuoto?: boolean;
  id?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
  /** Nomi accessibili dei due comandi: sono bottoni a sola icona. */
  etichettaDiminuisci: string;
  etichettaAumenta: string;
  segnaposto?: string;
  /**
   * Classi del SOLO campo centrale: i due bottoni ± non le ricevono mai, perché
   * la loro misura minima 44×44 è la primitiva stessa e non si veste da fuori.
   * (In `DateTimeField` la stessa prop si comporta diversamente — lì i due campi
   * la condividono.)
   */
  className?: string;
}

/**
 * Dentro l'intervallo, sempre. `NaN`/`Infinity` non escono di qui: tornano `null`,
 * e chi la chiama non propaga niente.
 *
 * ⚠️ ESPORTATA PER ESSERE PROVATA, e la ragione è misurata: in jsdom un
 * `input[type="number"]` a cui si assegna `'1e999'` sanifica il valore a `''`
 * **prima** che l'handler lo veda, mentre Chrome lo tiene (`valueAsNumber` =
 * `Infinity`). Dal DOM, sotto test, quel ramo non è raggiungibile: provarlo
 * «passando dal campo» darebbe un verde che non dimostra niente. Lock:
 * `__tests__/components/Stepper.test.tsx`.
 */
export function clamp(n: number, min?: number, max?: number): number | null {
  if (!Number.isFinite(n)) return null;
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  consentiVuoto = false,
  id,
  'aria-describedby': describedBy,
  disabled = false,
  etichettaDiminuisci,
  etichettaAumenta,
  segnaposto,
  className,
}: StepperProps) {
  const alMinimo = value !== null && min !== undefined && value <= min;
  const alMassimo = value !== null && max !== undefined && value >= max;

  /**
   * Il valore da cui contare quando non c'è ancora niente: il primo ammesso.
   * Da «non indicato» il primo tocco — in una direzione o nell'altra — porta lì,
   * e da lì si conta. Inventare `min + step` sul `+` sarebbe una seconda regola
   * da spiegare a chi legge, per guadagnare un tocco.
   */
  const primoAmmesso = min ?? 0;

  const passo = (verso: 1 | -1) => {
    if (disabled) return;
    if (verso === 1 && alMassimo) return; // no-op al bordo: vedi §4
    if (verso === -1 && alMinimo) return;
    if (value === null) {
      onChange(clamp(primoAmmesso, min, max));
      return;
    }
    onChange(clamp(value + verso * step, min, max));
  };

  const digita = (grezzo: string) => {
    if (grezzo === '') {
      // Il ripiego passa da `clamp` come gli altri due percorsi: era l'UNICA via
      // verso `onChange` che lo saltava, e con un `max` e nessun `min` emetteva la
      // costante 1 — sopra il massimo. Il ripiego è `primoAmmesso`, non un numero.
      onChange(consentiVuoto ? null : clamp(primoAmmesso, min, max));
      return;
    }
    const n = Number(grezzo);
    // Non finito (`1e999`, e il `NaN` che un `type="number"` non sanificato
    // potrebbe produrre): non si propaga NIENTE. Il valore resta quello di prima.
    const dentro = clamp(n, min, max);
    if (dentro === null) return;
    onChange(dentro);
  };

  const bottone =
    'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border-2 ' +
    'border-kidville-line text-kidville-green transition-transform active:scale-95 ' +
    'hover:border-kidville-green aria-disabled:border-kidville-neutral ' +
    'aria-disabled:text-kidville-sub disabled:border-kidville-neutral disabled:text-kidville-sub';

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={etichettaDiminuisci}
        aria-disabled={alMinimo || undefined}
        disabled={disabled}
        onClick={() => passo(-1)}
        className={bottone}
      >
        <Minus size={18} aria-hidden="true" />
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value === null ? '' : value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={segnaposto}
        aria-describedby={describedBy}
        onChange={(e) => digita(e.target.value)}
        // ≥16px: sotto questa soglia iOS ZOOMA sul campo al fuoco e la pagina resta
        // ingrandita. Inline perché è una misura deliberata, indipendente dalla cascata.
        style={{ fontSize: '17px' }}
        className={cx(
          'w-20 rounded-xl border-2 border-kidville-line py-1 text-center font-bold tabular-nums',
          'text-kidville-ink outline-none focus:border-kidville-green',
          // Le frecce native sparite: qui il gesto è ±, e due comandi per la stessa
          // cosa sullo stesso controllo si toccano per sbaglio.
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          className,
        )}
      />
      <button
        type="button"
        aria-label={etichettaAumenta}
        aria-disabled={alMassimo || undefined}
        disabled={disabled}
        onClick={() => passo(1)}
        className={bottone}
      >
        <Plus size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
