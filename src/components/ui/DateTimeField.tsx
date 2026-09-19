'use client';

import { useState } from 'react';
import { DateField } from './DateField';
import { dataCivile } from '@/i18n/config';
import { istanteDaLocale, oraCivile } from '@/lib/format/confini-giorno';

/**
 * ─── DATA + ORA: DUE CAMPI, UN ISTANTE ──────────────────────────────────────
 *
 * Una scadenza con l'ora è un ISTANTE, e un istante in questo prodotto si scrive
 * in una `timestamptz`. Questo componente è il ponte fra le cifre che una persona
 * legge sull'orologio a muro di Giugliano e quell'istante: fuori parla ISO, dentro
 * tiene i due pezzi civili italiani.
 *
 * ── PERCHÉ COMPONE `DateField` INVECE DI RISCRIVERLO ────────────────────────
 *
 * Perché il campo data mascherato esiste già, ed esiste per una ragione pagata:
 * `<input type="date">` mostra l'ordine dei campi deciso dall'OS — `mm/dd/yyyy` su
 * una macchina in inglese — e nessuna etichetta lo corregge, perché l'ordine non è
 * scritto nell'HTML. Un secondo campo data qui dentro sarebbe la seconda copia di
 * una difesa: la solita, quella che resta indietro.
 *
 * ── PERCHÉ L'ORA INVECE È UN `<input type="time">` NATIVO ───────────────────
 *
 * Perché il difetto del campo data era l'ORDINE, e l'ora un ordine ambiguo non ce
 * l'ha: il valore è sempre `HH:mm` a 24 ore per specifica, identico in ogni locale,
 * e quello che l'OS decide è solo come lo DISEGNA (la ruota nativa su WebView iOS,
 * che col pollice è meglio di qualunque cosa si possa scrivere qui). C'è già prior
 * art in casa: `TimeField` in `src/components/features/admin/settings/fields.tsx`.
 * Quel campo però rende la propria `<label>` dai `children`, vive in una *feature*
 * e importa le classi di quel pannello: non è riusabile dentro un `role="group"`
 * con descrizione condivisa, che è esattamente quello che serve qui.
 *
 * ── 🔴 LA TRAPPOLA CHE QUESTO COMPONENTE ESISTE PER CHIUDERE ────────────────
 *
 * `DateField` emette `onChange('')` A OGNI BATTUTA INTERMEDIA (`DateField.tsx:54-61`):
 * `12/10/202` non è una data, quindi l'ISO è vuoto. È il comportamento giusto per
 * lui. Ma se quel `''` risalisse al padre e tornasse giù come `value`, il padre
 * riscriverebbe i campi da un istante che non c'è — e quello che sparirebbe sotto
 * le dita NON è la data (`DateField` si difende da solo aggiornando il proprio
 * `lastValue` nell'handler) ma **l'ORA già scritta accanto**: si corregge una cifra
 * del giorno e le 18:00 si azzerano.
 *
 * Perciò, qui dentro:
 *   · lo stato è `{ ymd, hhmm }`, **mai** l'ISO — il testo a schermo non dipende
 *     più da un valore che si azzera;
 *   · `lastValue` tiene l'ISO in ingresso e i due pezzi si ricalcolano SOLO quando
 *     l'ISO cambia per una ragione che non è la digitazione in corso (stesso
 *     pattern «adjust state during render» di `DateField`, nessun setState in
 *     effect);
 *   · `onChange('')` risale al padre quando manca almeno uno dei due pezzi, e va
 *     bene che risalga: è un'informazione vera — «non è ancora un istante» — e non
 *     un lampeggio, perché nessun campo si ridisegna a partire da lei.
 *
 * Il lock che lo prova è `__tests__/components/DateTimeField.test.tsx`: digita
 * `1`, `12`, `12/1`, `12/10`, `12/10/2026` una battuta alla volta. È un difetto che
 * leggendo il codice non si vede — si vede digitando.
 *
 * ── LA MATEMATICA DEL FUSO NON È QUI ────────────────────────────────────────
 *
 * Composizione e scomposizione passano da `istanteDaLocale` / `dataCivile` /
 * `oraCivile` (`@/lib/format/confini-giorno`, `@/i18n/config`), che è il posto dove
 * l'offset di Roma vive — compresi i due giorni all'anno in cui cambia a metà
 * giornata. Una seconda copia sarebbe un secondo calendario nel repo, e se ne
 * correggerebbe uno.
 *
 * ── IL COMPONENTE NON CONTIENE TESTO ────────────────────────────────────────
 *
 * Nessuna chiamata a `useTranslations` qui dentro: le stringhe arrivano come prop
 * dal punto d'uso. È la regola che tiene onesto il lock sulle chiavi morte — una
 * chiave usata solo da una primitiva generica non si riesce più a legare alla
 * schermata che la mostra. (L'unica stringa che resta di `DateField` è il suo
 * segnaposto `gg/mm/aaaa`, che è suo e sta nel suo catalogo.)
 */

/** I due pezzi CIVILI italiani: `YYYY-MM-DD` e `HH:mm`. Mai l'ISO. */
interface Pezzi {
  ymd: string;
  hhmm: string;
}

const VUOTO: Pezzi = { ymd: '', hhmm: '' };

/**
 * L'ora che si scrive da sola alla prima data valida, quando l'ora è ancora vuota.
 *
 * Perché `23:59` e non «niente»: lo stato incompleto più frequente di un campo
 * data+ora è «la data c'è, l'ora no», e una scadenza senza ora non è una scadenza.
 * `23:59` è la fine del giorno scelto — cioè quello che intende chi scrive «entro
 * il 10» — è VISIBILE nel campo, è modificabile, e non viene mai riscritta dopo
 * (vedi `preriempita`). Decidere l'ora di nascosto al posto della segreteria
 * sarebbe un'altra cosa: qui la decisione resta scritta a schermo, dove si può
 * cambiare con un tocco.
 */
const ORA_DI_SERIE = '23:59';

/** Da un istante ISO ai due pezzi civili. `''`/illeggibile → entrambi vuoti. */
function scomponi(istante: string): Pezzi {
  if (!istante) return VUOTO;
  const d = new Date(istante);
  // `dataCivile` formatta un `Date`: su un Invalid Date `Intl` LANCIA. Un valore
  // illeggibile qui è un campo vuoto, non un errore in faccia alla segreteria.
  if (Number.isNaN(d.getTime())) return VUOTO;
  return { ymd: dataCivile(d), hhmm: oraCivile(istante) };
}

/** Dai due pezzi all'istante ISO. `''` finché manca un pezzo o la data non esiste. */
function componi({ ymd, hhmm }: Pezzi): string {
  if (!ymd || !hhmm) return '';
  return istanteDaLocale(`${ymd}T${hhmm}`) ?? '';
}

export interface DateTimeFieldProps {
  /** Istante ISO (`2026-06-01T16:00:00.000Z`), `''` se incompleto. */
  value: string;
  /** Chiamato con l'istante ISO, o `''` quando manca ancora un pezzo. */
  onChange: (iso: string) => void;
  /**
   * Gli id dei due controlli, dal `useId()` del CHIAMANTE e non da uno interno:
   * il punto d'uso deve poter puntare le proprie `<label>`, il proprio aiuto e il
   * proprio messaggio d'errore agli stessi id, e un `useId()` nascosto qui dentro
   * non sarebbe visibile da fuori.
   */
  idData: string;
  idOra: string;
  /** Id dell'intestazione che dà il nome al `role="group"`. */
  labelledBy: string;
  /** Id dell'aiuto (e dell'eventuale errore): va su ENTRAMBI i controlli. */
  'aria-describedby'?: string;
  required?: boolean;
  /** Testo delle due `<label>`. Il componente non ne scrive nessuna da sé. */
  etichettaData: string;
  etichettaOra: string;
  /**
   * Classi del singolo controllo: `DateTimeField` le passa IDENTICHE a entrambi
   * i campi, data e ora (diversamente da `Stepper`, dove la stessa prop veste il
   * solo `<input>` e non i due bottoni).
   */
  className?: string;
}

/**
 * `DateField` inoltra già `...rest` all'`<input>`, ma la sua interfaccia di prop
 * è CHIUSA e non elenca `style`: passarlo così com'è compila a runtime ma non
 * a `tsc` (eccesso di proprietà su un tipo senza indice). Si allarga il tipo
 * SOLO da questo punto di chiamata — mai `DateField.tsx`, che due cantieri
 * stanno consumando in questo momento.
 */
const DateFieldConStile = DateField as React.ComponentType<
  React.ComponentProps<typeof DateField> & { style?: React.CSSProperties }
>;

export function DateTimeField({
  value,
  onChange,
  idData,
  idOra,
  labelledBy,
  'aria-describedby': describedBy,
  required,
  etichettaData,
  etichettaOra,
  className,
}: DateTimeFieldProps) {
  const [pezzi, setPezzi] = useState<Pezzi>(() => scomponi(value));
  const [lastValue, setLastValue] = useState<string>(value);
  /**
   * Il preriempimento è UNA VOLTA SOLA per istanza. Senza questo flag, chi svuota
   * l'ora apposta e poi corregge una cifra della data se la vedrebbe ricomparire:
   * «mai sovrascritta dopo» sarebbe una frase, non un comportamento.
   */
  const [preriempita, setPreriempita] = useState(false);

  // L'ISO è cambiato DALL'ESTERNO (apertura in modifica, reset del modulo): i due
  // pezzi si ricalcolano. Durante la digitazione questo ramo non scatta, perché
  // `lastValue` viene aggiornato nello stesso gesto che emette il valore.
  if (value !== lastValue) {
    setLastValue(value);
    setPezzi(scomponi(value));
  }

  const applica = (prossimi: Pezzi) => {
    setPezzi(prossimi);
    const iso = componi(prossimi);
    setLastValue(iso);
    onChange(iso);
  };

  const cambiaData = (ymd: string) => {
    // Prima data valida e ora ancora vuota: l'ora si scrive da sola, una volta.
    const scriviOra = ymd !== '' && pezzi.hhmm === '' && !preriempita;
    if (scriviOra) setPreriempita(true);
    applica({ ymd, hhmm: scriviOra ? ORA_DI_SERIE : pezzi.hhmm });
  };

  const cambiaOra = (hhmm: string) => {
    // Toccata a mano: da qui in poi è dell'utente, qualunque cosa succeda alla data.
    setPreriempita(true);
    applica({ ymd: pezzi.ymd, hhmm });
  };

  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={idData} className="mb-1 block text-xs font-bold text-kidville-sub">
          {etichettaData}
        </label>
        <DateFieldConStile
          id={idData}
          value={pezzi.ymd}
          onChange={cambiaData}
          required={required}
          aria-describedby={describedBy}
          className={className}
          // ≥16px come il campo ora accanto: la coppia si difende INTERA o non si
          // difende. `DateField` non ha uno style proprio e il chiamante passa
          // `text-sm` (14px), quindi senza questa riga il giorno zooma e l'ora no.
          style={{ fontSize: '16px' }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <label htmlFor={idOra} className="mb-1 block text-xs font-bold text-kidville-sub">
          {etichettaOra}
        </label>
        <input
          id={idOra}
          type="time"
          value={pezzi.hhmm}
          onChange={(e) => cambiaOra(e.target.value)}
          required={required}
          aria-describedby={describedBy}
          // Nessun `placeholder`: per specifica HTML vale solo su
          // `text/search/url/tel/email/password/number`, quindi su `type="time"`
          // non fa NIENTE — e i due WebView di destinazione (WKWebView iOS,
          // Android WebView) supportano entrambi `type="time"`, perciò il caso
          // «degrada a testo» non esiste per questo prodotto. Se un giorno
          // servirà, si riaggiunge INSIEME al chiamante che la usa.
          // ≥16px: sotto questa soglia iOS ZOOMA sul campo al fuoco e la pagina
          // resta ingrandita. Inline e non in classe, perché è una misura
          // deliberata che non deve dipendere dalla cascata.
          style={{ fontSize: '16px' }}
          className={className}
        />
      </div>
    </div>
  );
}
