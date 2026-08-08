'use client';

import { CalendarX2 } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';

/**
 * Una riga di «Assenze già comunicate», con il comando che la ritira.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Perché la stessa funzione era stata scritta DUE VOLTE, nello stesso commit,
 * in due file che non si importano a vicenda: la schermata dedicata del
 * genitore (`/parent/attendance`, nido e infanzia) e la card montata in
 * `/parent/primaria/assenze`. Misurate dal collaudo del 2026-08-07, le due
 * versioni erano diverse in tutto ciò che il genitore vede per primo:
 *
 *   riga     · raggio 12px con bordo      VS  raggio 16px senza bordo
 *   comando  · `danger` (rosso)           VS  `ghost` (verde) con una X
 *   giorno   · «12/08/2026»               VS  «mercoledì 19 agosto», senza anno
 *
 * Due colori OPPOSTI per la stessa azione distruttiva, e un formato di data che
 * in una delle due l'anno non lo dice affatto — proprio il dato che permette di
 * accorgersi di aver avvisato la maestra per il giorno sbagliato. Un genitore
 * con due figli di grado diverso le vede tutte e due, ogni giorno.
 *
 * Allineare le classi a mano avrebbe chiuso il sintomo e lasciato la causa: due
 * copie che ricominciano a divergere al primo ritocco. Qui la riga è UNA, e le
 * schermate le passano solo i testi — che vengono da due cataloghi diversi
 * (`parentServizi` e `parentPrimaria`) e per questo non possono vivere dentro.
 * Lock: `__tests__/components/assenze-due-schermate-coerenti.test.tsx`.
 *
 * ─── IL TELEFONO PICCOLO (320px) ────────────────────────────────────────────
 * A 320px CSS l'ultima cifra dell'anno finiva FISICAMENTE sotto la pillola
 * «Annulla»: «12/08/2026» si leggeva «12/08/202», senza nemmeno un'ellissi che
 * lo segnalasse. Il conto, con i padding veri:
 *   320 − 32 (px-4 della pagina) − 48 (p-6 della card) − 26 (p-3 + bordo del
 *   `li`) = 214px di contenuto; meno l'icona (36), i due `gap-3` (24) e la
 *   pillola (≈85, e `Btn` porta `whitespace-nowrap`: non si restringe MAI)
 *   → restano 69px per una data che ne misura 91.
 * Il rimedio è in due tempi: la riga VA A CAPO (`flex-wrap` sul `li` +
 * `basis-24`, cioè una larghezza ipotetica NON nulla, sulla colonna centrale —
 * `flex-1` è `flex: 1 1 0%` e con quella la riga non va a capo mai, si limita a
 * schiacciare la colonna); e `truncate` resta la RETE, così un giorno più lungo
 * degrada con l'ellissi invece di nascondersi sotto un controllo opaco.
 * Quel lavoro era stato fatto su UNA sola delle due copie: ora vale per
 * entrambe, che è metà della ragione per cui questo file esiste.
 */

interface Props {
  /** Il giorno GIÀ formattato per chi legge (es. «12/08/2026»). */
  giorno: string;
  /** Il motivo scritto dal genitore, se ne ha messo uno. */
  motivo?: string | null;
  /**
   * Nome accessibile del comando. Un «Annulla» nudo, ripetuto per ogni riga, per
   * chi usa uno screen reader è la stessa voce N volte: l'etichetta deve dire
   * QUALE assenza si sta per ritirare (WCAG 4.1.2).
   */
  etichettaAnnulla: string;
  /** Etichetta visibile del comando. */
  testoAnnulla: string;
  /** Etichetta mentre la chiamata di QUESTA riga è in volo. */
  testoAnnullamento: string;
  /** È questa la riga in corso di annullamento. */
  inCorso: boolean;
  /**
   * Un annullamento qualunque è in volo. Anche i comandi delle ALTRE righe si
   * bloccano: due DELETE sovrapposte tornerebbero in ordine qualunque, e
   * l'ultima rilettura vincerebbe sulla prima.
   */
  bloccato: boolean;
  onAnnulla: () => void;
}

export function RigaAssenzaComunicata({
  giorno,
  motivo,
  etichettaAnnulla,
  testoAnnulla,
  testoAnnullamento,
  inCorso,
  bloccato,
  onAnnulla,
}: Props) {
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-xl border border-kidville-line bg-kidville-cream p-3">
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[12px] bg-kidville-error-soft text-kidville-error-strong">
        <CalendarX2 size={16} aria-hidden="true" />
      </span>
      {/* `grow basis-24` e NON `flex-1`: vedi il commento in testa al file. Le tre
          proprietà sono scritte per esteso apposta, così nessuna scorciatoia le
          sovrascrive a vicenda. */}
      <div className="min-w-0 grow basis-24">
        <p className="truncate font-maven font-semibold text-kidville-green">{giorno}</p>
        {motivo && (
          <p className="mt-0.5 break-words font-maven text-xs text-kidville-sub">{motivo}</p>
        )}
      </div>
      <Btn
        variant="danger"
        size="sm"
        aria-label={etichettaAnnulla}
        // I DUE SIGNIFICATI, separati (2026-08-08).
        //
        // La riga CHE STA PARTENDO (`inCorso`) non si marca `disabled`: Chrome
        // sfoca l'elemento che React marca `disabled`, quindi chi ha premuto da
        // tastiera si ritrova il fuoco su `<body>` — all'inizio della pagina —
        // proprio durante l'attesa, e l'etichetta «Annullamento…» — l'unico
        // segnale visivo che il gesto è partito — si sbiadiva con lui.
        // `aria-disabled` lo dichiara inoperante senza toglierlo dal fuoco; il
        // doppio invio lo impedisce la guardia del gestore (`if (annullando)
        // return`), che c'è ed è la difesa vera.
        //
        // Le ALTRE righe restano `disabled`: quelle sì che sono inoperanti nel
        // senso dell'eccezione WCAG, e da quando `Btn` dipinge lo stato spento
        // invece di sbiadirlo (5,75:1) restano comunque leggibili.
        disabled={bloccato && !inCorso}
        aria-disabled={inCorso || undefined}
        onClick={onAnnulla}
        // `ml-auto` serve alla riga ANDATA A CAPO: lì la pillola è sola sulla sua
        // linea, e senza resterebbe a sinistra sotto l'icona, come se ci fosse
        // finita per sbaglio.
        className="ml-auto shrink-0"
      >
        {inCorso ? testoAnnullamento : testoAnnulla}
      </Btn>
    </li>
  );
}
