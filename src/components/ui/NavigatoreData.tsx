'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { addGiorni, isoToIt, itToIso } from '@/lib/format/data';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';

/**
 * Navigatore di date riusabile: `‹` · campo `gg/mm/aaaa` · `›` · «Oggi».
 *
 * ─── PERCHÉ ESISTE: LA STRINGA VUOTA CHE ARRIVAVA IN QUERY ───────────────────
 *
 * `DateField` è un campo di TESTO mascherato, e mentre si digita emette
 * `onChange('')` a **ogni battuta intermedia** (`DateField.tsx:54-61`): finché
 * `itToIso` non riconosce una data completa e valida, l'ISO è vuoto. Chi
 * collegava quel campo direttamente allo stato di una schermata si ritrovava la
 * stringa vuota dentro la query — `?data=` — e l'API rispondeva 400, con il
 * banner rosso a video mentre l'utente stava ancora scrivendo la seconda cifra.
 *
 * Questo componente ASSORBE quella stringa vuota: verso l'esterno `onChange`
 * scatta **solo** con un ISO che è davvero un giorno del calendario. È la ragione
 * principale per cui esiste.
 *
 * ⚠️ E il campo non è l'unica via d'uscita. Anche le FRECCE possono propagare
 * spazzatura: `addGiorni` su una stringa che non ha la forma di una data la
 * restituisce **invariata** di proposito (`data.ts:63-71`), quindi con `value=''`
 * — o con un `'14/09/2026'` passato per sbaglio al posto dell'ISO — un click su
 * `›` rimetterebbe in circolo esattamente ciò che si stava assorbendo dall'altra
 * parte. Perciò le frecce sono **disabilitate** finché `value` non è un giorno
 * vero; «Oggi» resta attivo ed è la via d'uscita (con `value` vuoto `'' !== oggi`,
 * quindi si mostra già) — salvo quando oggi stesso cade fuori da `min`/`max`, e
 * allora non c'è nessuna via d'uscita da offrire (vedi il blocco sui limiti).
 *
 * ⚠️ E sorvegliare l'INGRESSO delle frecce non basta: si sorveglia anche la loro
 * USCITA, perché ai due estremi del calendario `addGiorni` risponde con una forma
 * che ISO non è — misurato, non temuto:
 *
 *     '0202-06-15' → '0202-06-16'   ✔ (l'anno lo riempie `data.ts`, vedi lì)
 *     '9999-12-31' → '10000-01-01'  ✘ cinque cifre d'anno
 *
 * e il primo dei due **si raggiunge dalla tastiera**: battendo `15060202` il campo
 * emette `'0202-06-15'`, che ha forma ISO valida e supera qualunque controllo del
 * chiamante. Perciò ogni freccia calcola il giorno successivo e lo lascia uscire
 * **solo se** è a sua volta un giorno vero: a 9999-12-31 la `›` non muove nulla.
 *
 * ⚠️ Assorbire la stringa vuota non basta da sola. `DateField` è controllato sul
 * suo `value`: se si ignorasse l'ISO vuoto senza tenere traccia di niente, il
 * `value` esterno — rimasto al giorno di prima — rientrerebbe al render
 * successivo e riallineerebbe il testo mostrato (`DateField.tsx:45-52`),
 * cancellando le cifre appena battute. Il campo diventerebbe indigitabile. Perciò
 * qui vive una **bozza** interna, e vive **solo** finché l'ISO è vuoto: mentre la
 * data è incompleta è lei a comandare il campo, e appena l'ISO è completo la
 * bozza si abbandona e torna a comandare `value`. Quest'ultima parte non è un
 * dettaglio: il chiamante può **rifiutare** una data fuori intervallo (vedi sotto)
 * senza cambiare `value`, e se la bozza sopravvivesse il campo continuerebbe a
 * mostrare un giorno che lo stato reale non ha. Abbandonandola, `DateField` vede
 * un `value` diverso dal proprio `lastValue` e si riallinea da solo alla verità.
 * La sincronizzazione usa il pattern React «adjust state during render», come
 * `DateField` stesso: nessun `setState` in `useEffect`.
 *
 * ─── PERCHÉ NON SI È RIUSATO IL `DateNavigator` DI `AppelloGiornaliero` ──────
 *
 * `AppelloGiornaliero.tsx` ha già un navigatore inline con lo stesso disegno, ma
 * al centro monta un `<input type="date">` NATIVO con `max={oggi}`: un'altra UX
 * (si tocca il selettore del sistema, non si digita) e un altro comportamento
 * (l'appello non si prende mai in un giorno futuro). Unificarli non sarebbe una
 * rifattorizzazione: cambierebbe il gesto principale della schermata dell'appello.
 * Restano due, ed è una scelta consapevole — non una svista di chi non ha cercato.
 *
 * ─── PERCHÉ `min`/`max` LI IMPONE QUESTO COMPONENTE E NON `DateField` ────────
 *
 * Un `<input type="date">` nativo ha `min`/`max` e il browser ci fa rispettare
 * i limiti da solo; un campo mascherato di testo no — il repo lo documenta già
 * in `src/app/(dashboard)/parent/attendance/page.tsx:399-403`, dove la scelta
 * opposta (restare sul nativo) è motivata proprio dal `min` che il mascherato non
 * può dare. Qui i limiti valgono quindi sui GESTI che questo componente controlla
 * per intero — le frecce **e** «Oggi» —, mentre una data fuori intervallo battuta
 * a mano resta possibile, ed è il chiamante a doverla rifiutare (e se la rifiuta
 * il campo si riallinea da solo, vedi la bozza qui sopra).
 *
 * «Oggi» non è un'eccezione, e per un po' lo è stato per svista: con
 * `max='2026-09-16'` e oggi 19/09 il pulsante compariva ed emetteva `2026-09-19`,
 * cioè un giorno che la freccia `›` — disabilitata — si rifiutava di raggiungere.
 * Due gesti dello stesso componente che rispondono in modo opposto allo stesso
 * limite sono un difetto, non una comodità: adesso, quando oggi cade fuori da
 * `[min, max]`, il pulsante **non si mostra**.
 *
 * ⚠️ E i limiti NON si credono sulla parola: passano dallo stesso
 * `giornoNavigabile` che sorveglia `value`, e un limite che non è un giorno viene
 * **ignorato**. L'asimmetria costava due guasti muti in direzioni opposte —
 * misurati: `max='19/09/2026'` (formato italiano per sbaglio) disabilitava `›`
 * **per sempre**, perché il confronto fra stringhe `'2026-09-14' >= '19/09/2026'`
 * è vero; `max='2026-9-5'` (ISO senza zeri) non mordeva mai. Una freccia morta è
 * indistinguibile da una configurazione corretta — e la diagnosi tocca poi a chi
 * guarda la schermata, non a chi ha scritto la prop. Ignorandoli, il limite
 * sbagliato si comporta come un limite assente: sbagliato uguale, ma visibile,
 * perché il navigatore continua a camminare oltre il punto che si voleva chiudere.
 *
 * ─── DIFETTO NOTO ED EREDITATO: IL CARET SALTA IN FONDO ──────────────────────
 *
 * Scrivendo IN MEZZO al campo il cursore salta alla fine e la maschera ricompone
 * da sinistra: su `14/09/2026` una cifra inserita in posizione 1 produce
 * `10/40/9202`. Non nasce qui: è di `maskItDate` (`src/lib/format/data.ts:74-78`),
 * che rigenera la stringa dalle sole cifre senza mai riposizionare la selezione,
 * e vale per **ogni** consumatore di `DateField`. Non si corregge da questo
 * componente — si toccherebbe il comportamento di tutti gli altri — ma si dichiara
 * qui, perché il navigatore lo porta con sé su ogni schermata che lo adotta.
 */

interface NavigatoreDataProps {
  /** Valore ISO 'yyyy-mm-dd'. */
  value: string;
  /**
   * Chiamato SOLO con un ISO che è un giorno del calendario: né la stringa vuota
   * delle battute intermedie né l'anno fuori forma dei due estremi (`'202-…'`,
   * `'10000-…'`) escono da qui. Vale per tutte e tre le vie: campo, frecce, «Oggi».
   */
  onChange: (iso: string) => void;
  /**
   * ISO: oltre questo giorno la freccia `›` è disabilitata, e «Oggi» sparisce se
   * cade oltre. ⚠️ Se non è un giorno del calendario viene **ignorato** (vedi il
   * blocco sui limiti qui sopra): meglio un limite assente di una freccia morta.
   */
  max?: string;
  /**
   * ISO: sotto questo giorno la freccia `‹` è disabilitata, e «Oggi» sparisce se
   * cade prima. Stessa regola del `max`: un limite non-giorno viene ignorato.
   */
  min?: string;
  /**
   * OBBLIGATORIO, e finisce sul CAMPO. Senza, la `textbox` resterebbe senza nome
   * accessibile: un campo di testo che uno screen reader annuncia come «modifica
   * testo, vuoto» e basta. Sul gruppo non si ripete di proposito — lo stesso nome
   * letto due volte (prima il contenitore, poi il campo) è rumore, non aiuto.
   */
  'aria-label': string;
  /**
   * Classi AGGIUNTIVE, non sostitutive: si sommano al layout di base. Un
   * `className="mb-4"` che rimpiazzasse le classi avrebbe tolto
   * `flex items-center gap-2` e impilato il navigatore in verticale, in silenzio.
   */
  className?: string;
}

const BOTTONE_FRECCIA =
  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-pill bg-white ' +
  'text-kidville-green shadow-sm disabled:cursor-not-allowed disabled:opacity-30';

const GRUPPO_BASE =
  'flex items-center gap-2 rounded-2xl border border-kidville-line bg-kidville-cream p-2';

/**
 * È un giorno su cui si può davvero camminare?
 *
 * Non basta la forma `\d{4}-\d{2}-\d{2}`: `2026-02-31` ce l'ha e non esiste, e
 * `addGiorni` lo restituirebbe invariato facendolo uscire. Il giro
 * ISO → italiano → ISO passa dal controllo di calendario di `itToIso`, che il 31
 * febbraio lo rifiuta. `isoToIt` rifiuta per primo tutto ciò che non ha quattro
 * cifre d'anno esatte: è la riga che ferma `'202-06-16'` e `'10000-01-01'`.
 *
 * Una sola funzione per TRE domande, di proposito: il `value` da cui si parte, il
 * giorno in cui si arriva, e i limiti `min`/`max`. Erano tre criteri diversi, e la
 * differenza fra loro era il difetto.
 */
function giornoNavigabile(iso: string): boolean {
  return itToIso(isoToIt(iso)) !== null;
}

export function NavigatoreData({
  value,
  onChange,
  max,
  min,
  'aria-label': ariaLabel,
  className,
}: NavigatoreDataProps) {
  const t = useTranslations('shared');

  // `null` = nessuna digitazione incompleta in corso, comanda il `value` esterno.
  // `''` = `DateField` sta emettendo l'ISO vuoto di una data ancora incompleta:
  // è la bozza che tiene vivo il testo battuto. Non ci finisce mai un ISO
  // completo — quello lo comanda `value`, anche quando il chiamante lo rifiuta.
  const [bozza, setBozza] = useState<'' | null>(null);
  const [ultimoValue, setUltimoValue] = useState<string>(value);

  // Il valore è cambiato da fuori: la bozza non vale più.
  if (value !== ultimoValue) {
    setUltimoValue(value);
    setBozza(null);
  }

  const daCampo = (iso: string) => {
    // 🔑 L'ASSORBIMENTO: l'ISO vuoto non esce, e la bozza tiene vivo il testo
    // battuto finché la data è incompleta.
    if (iso === '') {
      setBozza('');
      return;
    }
    // ISO completo: la bozza ha finito il suo lavoro, torna a comandare `value`.
    // Se il chiamante rifiuta la data, `value` non cambia e `DateField` si
    // riallinea da solo allo stato reale.
    setBozza(null);
    onChange(iso);
  };

  const daFreccia = (passo: 1 | -1) => {
    const prossimo = addGiorni(value, passo);
    // Due vie di rifiuto, un solo comportamento: come `daCampo`, anche la freccia
    // abbandona la bozza. Senza questa riga, dopo `1509` e una `›` rifiutata il
    // campo restava su «15/09» — un testo incompleto che non corrisponde a niente
    // e che fa sembrare la freccia rotta.
    setBozza(null);
    // 🔑 L'USCITA, non solo l'ingresso: ai due estremi del calendario `addGiorni`
    // risponde fuori forma (`'10000-01-01'`) e di lì non si torna più indietro.
    if (!giornoNavigabile(prossimo)) return;
    onChange(prossimo);
  };

  const oggi = oggiFiscaleISO();
  // Un limite che non è un giorno non vale: ignorarlo è l'unico esito che non
  // produce una freccia morta per sempre (vedi il blocco sui limiti in cima).
  const minVero = min !== undefined && giornoNavigabile(min) ? min : undefined;
  const maxVero = max !== undefined && giornoNavigabile(max) ? max : undefined;
  // Da un `value` che non è un giorno non si va da nessuna parte: `addGiorni` lo
  // restituirebbe invariato e le frecce lo propagherebbero.
  const navigabile = giornoNavigabile(value);
  const indietroBloccato = !navigabile || (minVero !== undefined && value <= minVero);
  const avantiBloccato = !navigabile || (maxVero !== undefined && value >= maxVero);
  // «Oggi» obbedisce agli stessi limiti delle frecce: se oggi è fuori intervallo
  // il pulsante non c'è, invece di offrire un salto che la `›` vieta.
  const oggiFuoriLimiti =
    (minVero !== undefined && oggi < minVero) || (maxVero !== undefined && oggi > maxVero);

  return (
    <div
      role="group"
      className={className === undefined ? GRUPPO_BASE : `${GRUPPO_BASE} ${className}`}
    >
      <button
        type="button"
        onClick={() => daFreccia(-1)}
        disabled={indietroBloccato}
        aria-label={t('navigatoreDataGiornoPrecedente')}
        className={BOTTONE_FRECCIA}
      >
        <ChevronLeft size={15} aria-hidden="true" />
      </button>

      <DateField
        value={bozza ?? value}
        onChange={daCampo}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 rounded-xl bg-white px-3 py-1.5 font-maven text-sm font-medium text-kidville-ink shadow-sm outline-none"
      />

      <button
        type="button"
        onClick={() => daFreccia(1)}
        disabled={avantiBloccato}
        aria-label={t('navigatoreDataGiornoSuccessivo')}
        className={BOTTONE_FRECCIA}
      >
        <ChevronRight size={15} aria-hidden="true" />
      </button>

      {value !== oggi && !oggiFuoriLimiti && (
        <button
          type="button"
          // Ricalcolato al click e non riusato da sopra: una schermata lasciata
          // aperta a cavallo della mezzanotte porterebbe a «oggi» il giorno prima.
          onClick={() => onChange(oggiFiscaleISO())}
          className="flex-shrink-0 rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-semibold text-kidville-yellow"
        >
          {t('navigatoreDataOggi')}
        </button>
      )}
    </div>
  );
}
