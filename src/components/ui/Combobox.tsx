'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown } from 'lucide-react';
import { cx } from '@/lib/ui/cx';

/**
 * ─── COMBOBOX — scelta con filtro, senza nessuna dipendenza nuova ────────────
 *
 * Questo repo non ha Radix né downshift, e non li aggiunge per un campo: il
 * pattern ARIA 1.2 «combobox with listbox popup» è scritto qui sotto per intero,
 * con `<input>` + un pannello `role="listbox"` e il fuoco che NON lascia mai
 * l'input (per questo esiste `aria-activedescendant`).
 *
 * IL CASO D'USO VERO, e perché niente virtualizzazione: l'elenco dei comuni
 * della provincia di Torino sono **484 voci**. Virtualizzare significherebbe
 * togliere dal DOM le voci fuori schermo — cioè togliere l'elemento a cui
 * `aria-activedescendant` punta, che è l'unico modo in cui uno screen reader sa
 * quale voce è evidenziata. 484 nodi in un pannello con `max-height` +
 * `overflow-y` non sono un problema; un `aria-activedescendant` che punta al
 * nulla sì.
 *
 * ── LE TRE INVARIANTI, in ordine di quanto costa sbagliarle ─────────────────
 *
 * 1. **Il filtro non cancella MAI la scelta.** `onChange` parte solo da Invio,
 *    Tab o da un clic su una voce. Si può digitare qualunque cosa, non trovare
 *    niente e chiudere: il valore resta quello di prima. Un campo che azzera la
 *    scelta mentre l'utente cerca fa perdere un dato senza dirlo.
 *
 * 2. **Il conteggio si annuncia.** Chi vede, vede il pannello passare da 484
 *    voci a 4. Chi non vede riceve quel numero solo da una regione
 *    `aria-live="polite"`, che deve esistere PRIMA che il contenuto cambi
 *    (una live-region creata insieme al testo non annuncia niente).
 *
 * 3. **La tastiera non è un ripensamento.** `↑ ↓ Home End Invio Esc Tab` sono
 *    l'unico modo di usare il componente senza mouse.
 *
 * ── COLORE E FUOCO ─────────────────────────────────────────────────────────
 * Nessun colore letterale: solo i token `kidville-*` di `globals.css`, così
 * `[data-contrast="high"]` continua a governarli. In particolare NON si usa
 * `focus:ring-kidville-*`: quella utility nasce da `@theme inline`, porta l'hex
 * INLINATO nel `box-shadow` e in Alto Contrasto resterebbe verde mentre tutto il
 * resto della pagina passa al giallo — è la lezione già pagata con
 * `.kv-fuoco-esito` (globals.css). Qui il fuoco è quello di sistema
 * (`:focus-visible`, 2px verdi / 3px gialli in HC): per questo **non c'è nessun
 * `outline-none`** sull'input, ed è il primo modo di rompere questo componente.
 *
 * ── LINGUA: il componente NON contiene testo ───────────────────────────────
 * I testi di servizio (conteggio, caricamento, elenco vuoto, nome del pulsante)
 * arrivano dalla prop OBBLIGATORIA `testi`: li traduce la pagina che monta il
 * campo, con le sue chiavi e la sua lingua. Non è un rimando a domani, è la
 * scelta giusta per due ragioni misurabili:
 *
 *  · il PLURALE del conteggio non si scrive con un ternario in TypeScript. In
 *    questo repo lo decide il catalogo, in ICU (`{count, plural, one{…} other{…}}`,
 *    lock `messaggi-plurali-e-glossario`, nato da un'interfaccia che scriveva
 *    «1 alunni» col gate verde). Per questo `testi.conteggio` è una FUNZIONE:
 *    la pagina ci mette dentro `t('risultatiDisponibili', { count: n })`;
 *  · `useTranslations` qui dentro renderebbe il collaudo cieco: il mock di
 *    next-intl in `test/setup.ts` restituisce la stringa GREZZA, quindi nessun
 *    unit test leggerebbe mai il testo che legge l'utente.
 *
 * Per il caricamento la chiave esiste già ed è identica byte per byte:
 * `shared.caricamentoInCorso` (`messages/it` → «Caricamento in corso…»,
 * `messages/en` → «Loading…»). Non c'era nessun catalogo da toccare.
 */

/**
 * I quattro testi di servizio. Nessun default: un default in italiano è
 * esattamente il modo in cui un campo «riusabile» finisce per parlare italiano
 * dentro la versione inglese, senza che nessun lock i18n possa accorgersene.
 */
export interface TestiCombobox {
  /** Detto quando il filtro non trova niente: nel pannello E nella regione live. */
  vuoto: string;
  /** Mentre le opzioni arrivano. In catalogo esiste già: `shared.caricamentoInCorso`. */
  caricamento: string;
  /** Il conteggio annunciato. È una funzione perché il plurale lo fa l'ICU del catalogo. */
  conteggio: (n: number) => string;
  /** Nome accessibile del pulsante che apre e chiude l'elenco. */
  commutaElenco: string;
}

export interface OpzioneCombobox {
  valore: string;
  etichetta: string;
  gruppo?: string;
  nota?: string;
  disabilitata?: boolean;
}

interface ComboboxProps {
  /** Id dell'input: da qui derivano gli id di elenco, voci e regione live. */
  id: string;
  /**
   * Il valore scelto: il campo è CONTROLLATO.
   *
   * ⚠️ DA QUI NON SI TORNA A VUOTO SVUOTANDO IL CAMPO, ed è voluto: cancellare il
   * testo FILTRA e basta, `onChange` non parte (invariante n.1 — il filtro non
   * cancella mai la scelta) e all'uscita il testo si riallinea all'etichetta di
   * `value`. Per un campo FACOLTATIVO, in cui la scelta dev'essere revocabile, la
   * pagina mette in `options` una voce con `valore: ''` (es. «Nessun comune»):
   * si sceglie con le stesse regole di tastiera di tutte le altre, `onChange`
   * riceve la stringa vuota e nel campo resta l'etichetta che la pagina le ha
   * dato — «nessuna scelta» va detto, non lasciato indovinare da un campo
   * bianco. Misurato in §5.
   */
  value: string;
  onChange: (valore: string, opzione: OpzioneCombobox | null) => void;
  options: readonly OpzioneCombobox[];
  /** Etichetta VISIBILE del campo (è anche il nome del pannello). */
  label: string;
  /** I testi di servizio, già nella lingua della pagina. Vedi `TestiCombobox`. */
  testi: TestiCombobox;
  placeholder?: string;
  disabled?: boolean;
  caricamento?: boolean;
  /**
   * Il campo è OBBLIGATORIO: asterisco nell'etichetta e `aria-required` sul
   * controllo.
   *
   * ⚠️ Non è una decorazione, ed è la ragione per cui esiste (12/08/2026).
   * MISURATO al passo «I tuoi dati» di `/anagrafica-personale`: su dieci campi
   * sette portavano l'asterisco e i due combobox no — di cui uno,
   * `codice_belfiore_nascita`, è dichiarato `required: true` nel template e
   * produce il messaggio dell'obbligo (`campoObbligatorio`) quando si preme
   * «Avanti» — la CHIAVE e non la frase: dal 25/08 quella frase è cambiata, e un
   * commento che la ricopia invecchia con lei. L'asterisco è
   * l'UNICA convenzione con cui questa pagina dice «questo è obbligatorio»:
   * dove non c'è, non c'è per nessuno — chi guarda e chi ascolta.
   * `aria-required` è il secondo segnale, quello che non dipende da un
   * carattere dentro l'etichetta.
   */
  richiesto?: boolean;
  invalido?: boolean;
  /** Id del messaggio d'errore/aiuto: dev'essere TESTO VISIBILE, non solo colore. */
  describedById?: string;
  className?: string;
}

const SEGNI_DIACRITICI = /[\u0300-\u036f]/g;
/** Apostrofo dritto, tipografico (iOS lo mette da solo), accenti gravi/acuti usati come apostrofo. */
const APOSTROFI = /[\u0027\u2018\u2019\u201A\u201B\u02BC\u0060\u00B4]/g;

/**
 * Il testo su cui si confronta: accenti sciolti con NFD e buttati via, apostrofi
 * ridotti a uno spazio, spazi collassati, minuscolo.
 *
 * L'apostrofo diventa SPAZIO e non sparisce: così «Sant'Agnello» si trova
 * digitando `sant'agnello`, `sant’agnello` e `sant agnello` — tre modi che a
 * seconda della tastiera arrivano tutti allo stesso posto — e in più
 * l'apostrofo continua a valere come confine di parola per il ranking.
 */
export function normalizzaTesto(testo: string): string {
  return testo
    .normalize('NFD')
    .replace(SEGNI_DIACRITICI, '')
    .replace(APOSTROFI, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const RANGO_PREFISSO = 0;
const RANGO_PAROLA = 1;
const RANGO_SOTTOSTRINGA = 2;

/**
 * Alfanumerico sul testo GIÀ normalizzato (minuscolo e senza accenti), quindi
 * `[a-z0-9]` basta e non serve `\p{L}` — che a `target: ES2017` TypeScript
 * rifiuterebbe (le property escape Unicode sono ES2018).
 */
function alfanumerico(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}

/**
 * Quanto bene `query` (normalizzata) descrive `etichetta` (normalizzata):
 * `0` inizio stringa · `1` inizio di una parola · `2` dentro una parola ·
 * `null` non c'è. Si tiene l'occorrenza MIGLIORE, non la prima: in «Rivarolo
 * Canavese» la query `canav` compare una volta sola, ma in nomi ripetuti la
 * prima occorrenza può essere quella peggiore.
 */
export function rangoDiMatch(etichetta: string, query: string): number | null {
  if (query === '') return RANGO_PREFISSO;
  let migliore: number | null = null;
  for (let i = etichetta.indexOf(query); i >= 0; i = etichetta.indexOf(query, i + 1)) {
    const r = i === 0
      ? RANGO_PREFISSO
      : alfanumerico(etichetta[i - 1])
        ? RANGO_SOTTOSTRINGA
        : RANGO_PAROLA;
    if (migliore === null || r < migliore) migliore = r;
    if (migliore === RANGO_PREFISSO) break;
  }
  return migliore;
}

interface Voce {
  opzione: OpzioneCombobox;
  /** Posizione PIATTA nell'elenco reso: è l'indice su cui si muove la tastiera. */
  indice: number;
}

interface Blocco {
  gruppo?: string;
  voci: Voce[];
}

export function Combobox({
  id,
  value,
  onChange,
  options,
  label,
  testi,
  placeholder,
  disabled = false,
  caricamento = false,
  richiesto = false,
  invalido = false,
  describedById,
  className,
}: ComboboxProps): React.ReactElement {
  const idElenco = `${id}-elenco`;
  const idStato = `${id}-stato`;
  const idVoce = (indice: number) => `${id}-opzione-${indice}`;

  const etichettaDelValore = useMemo(
    () => options.find((o) => o.valore === value)?.etichetta ?? '',
    [options, value],
  );

  const [aperto, setAperto] = useState(false);
  const [testo, setTesto] = useState(etichettaDelValore);
  /** Ha digitato DA QUANDO il pannello è aperto? Se no, il filtro è spento. */
  const [digitato, setDigitato] = useState(false);
  const [evidenziato, setEvidenziato] = useState(-1);
  const [ancora, setAncora] = useState({ valore: value, etichetta: etichettaDelValore });

  /**
   * Il `value` (o la sua etichetta: le opzioni possono arrivare dopo, in fondo a
   * una fetch) è cambiato dall'esterno → si riallinea il testo mostrato. È il
   * pattern React «adjust state during render» già in uso in `DateField`: niente
   * `useEffect`, niente doppio disegno, e la regola ESLint set-state-in-effect
   * resta soddisfatta. A pannello APERTO non si tocca niente: l'utente sta
   * digitando, e sovrascrivergli il campo sotto le dita è il difetto, non la cura.
   *
   * Misurato in §10 con quattro casi (opzioni che arrivano dopo · `value` cambiato da
   * fuori a pannello chiuso · `value` cambiato da fuori MENTRE si digita):
   * cancellando queste quattro righe la suite diventa rossa. Prima non lo era —
   * il banco di prova teneva il valore in `useState` e non rirendeva mai
   * dall'esterno, quindi il pezzo più delicato del file aveva copertura zero.
   */
  if (!aperto && (ancora.valore !== value || ancora.etichetta !== etichettaDelValore)) {
    setAncora({ valore: value, etichetta: etichettaDelValore });
    setTesto(etichettaDelValore);
    setDigitato(false);
  }

  const query = digitato ? normalizzaTesto(testo) : '';

  /**
   * Le voci filtrate, ordinate per RANGO e poi per ordine di partenza, e infine
   * raggruppate per `gruppo` nell'ordine in cui i gruppi compaiono. Il
   * raggruppamento avviene DOPO l'ordinamento e tiene insieme tutte le voci di
   * uno stesso gruppo: altrimenti lo stesso gruppo comparirebbe due volte nel
   * pannello, una per rango.
   */
  const blocchi = useMemo<Blocco[]>(() => {
    const conRango: { opzione: OpzioneCombobox; ordine: number; rango: number }[] = [];
    options.forEach((opzione, ordine) => {
      const rango = rangoDiMatch(normalizzaTesto(opzione.etichetta), query);
      if (rango !== null) conRango.push({ opzione, ordine, rango });
    });
    conRango.sort((a, b) => a.rango - b.rango || a.ordine - b.ordine);

    const ordineGruppi: (string | undefined)[] = [];
    const perGruppo = new Map<string | undefined, OpzioneCombobox[]>();
    for (const v of conRango) {
      const g = v.opzione.gruppo;
      let dentro = perGruppo.get(g);
      if (!dentro) {
        dentro = [];
        perGruppo.set(g, dentro);
        ordineGruppi.push(g);
      }
      dentro.push(v.opzione);
    }

    let indice = 0;
    return ordineGruppi.map((gruppo) => ({
      gruppo,
      voci: (perGruppo.get(gruppo) ?? []).map((opzione) => ({ opzione, indice: indice++ })),
    }));
  }, [options, query]);

  const piatte = useMemo<Voce[]>(() => blocchi.flatMap((b) => b.voci), [blocchi]);

  /**
   * L'evidenziato EFFETTIVO. L'elenco cambia sotto (si digita, arrivano altre
   * opzioni): un indice memorizzato può puntare fuori o su una voce disabilitata,
   * e `aria-activedescendant` finirebbe su un id che non esiste. Si ricalcola in
   * render invece di rincorrerlo con un effetto.
   */
  const corrente =
    evidenziato >= 0 && evidenziato < piatte.length && !piatte[evidenziato].opzione.disabilitata
      ? evidenziato
      : -1;

  const elencoRef = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!aperto || corrente < 0) return;
    const voce = elencoRef.current?.querySelector<HTMLElement>(`[data-indice="${corrente}"]`);
    // jsdom non implementa `scrollIntoView`: la guardia serve ai test, non al browser.
    if (voce && typeof voce.scrollIntoView === 'function') voce.scrollIntoView({ block: 'nearest' });
  }, [aperto, corrente]);

  /** La prima voce ABILITATA a partire da `da`, muovendosi di `passo`. */
  const cerca = (da: number, passo: number): number => {
    for (let i = da + passo; i >= 0 && i < piatte.length; i += passo) {
      if (!piatte[i].opzione.disabilitata) return i;
    }
    return corrente;
  };

  const chiudi = (ripristina: boolean) => {
    setAperto(false);
    setEvidenziato(-1);
    setDigitato(false);
    if (ripristina) setTesto(etichettaDelValore);
  };

  const apri = (indice: number) => {
    if (disabled) return;
    setAperto(true);
    setDigitato(false);
    setEvidenziato(indice);
  };

  const scegli = (opzione: OpzioneCombobox) => {
    if (opzione.disabilitata) return;
    setTesto(opzione.etichetta);
    chiudi(false);
    onChange(opzione.valore, opzione);
  };

  const suTasto = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!aperto) apri(piatte.findIndex((v) => !v.opzione.disabilitata));
        else setEvidenziato(cerca(corrente, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!aperto) {
          let ultima = -1;
          piatte.forEach((v, i) => {
            if (!v.opzione.disabilitata) ultima = i;
          });
          apri(ultima);
        } else {
          setEvidenziato(corrente < 0 ? cerca(piatte.length, -1) : cerca(corrente, -1));
        }
        return;
      case 'Home':
        if (!aperto) return;
        e.preventDefault();
        setEvidenziato(cerca(-1, 1));
        return;
      case 'End':
        if (!aperto) return;
        e.preventDefault();
        setEvidenziato(cerca(piatte.length, -1));
        return;
      case 'Enter':
        if (!aperto) return;
        // Solo a pannello aperto: a pannello chiuso Invio deve poter inviare la
        // modulistica in cui il campo è montato.
        e.preventDefault();
        if (corrente >= 0) scegli(piatte[corrente].opzione);
        else chiudi(true);
        return;
      case 'Escape':
        if (!aperto) return;
        e.preventDefault();
        // Se il campo vive dentro una modale, un solo Escape non deve chiuderla
        // anche: si annulla la ricerca, non il dialogo (stesso patto di `Drawer`).
        e.stopPropagation();
        chiudi(true);
        return;
      case 'Tab':
        // Niente `preventDefault`: il fuoco DEVE andarsene. Si conferma solo ciò
        // che era già evidenziato — Tab non sceglie mai «a caso» per conto altrui.
        if (!aperto) return;
        if (corrente >= 0) scegli(piatte[corrente].opzione);
        else chiudi(true);
        return;
      default:
    }
  };

  const annuncio = caricamento
    ? testi.caricamento
    : !aperto
      ? ''
      : piatte.length === 0
        ? testi.vuoto
        : testi.conteggio(piatte.length);

  return (
    <div className={cx('relative', className)}>
      {/* ── L'ETICHETTA È QUELLA DI OGNI ALTRO CAMPO (12/08/2026) ─────────────
          Era `font-barlow text-[12.5px] font-bold uppercase tracking-[0.04em]
          text-kidville-sub`: Barlow Condensed maiuscolo spaziato, grigio. Nella
          stessa colonna verticale i campi resi da `FieldRenderer` portano Maven
          Pro 14 px, peso 500, verde, con l'asterisco — MISURATO al passo «I tuoi
          dati» di `/anagrafica-personale`, dove le due tipografie stanno una
          sotto l'altra. Due sistemi di etichette nella stessa colonna non sono
          una scelta grafica: chi legge prende i combobox per INTESTAZIONI DI
          SEZIONE invece che per etichette di campo, e cerca il campo sotto.
          La classe è la stessa di `FieldRenderer` (riga 422) e i sei chiamanti
          di `LuogoNascitaFields` — pannelli admin compresi, che accanto scrivono
          `block text-sm font-bold text-kidville-green/80` — si allineano tutti
          nello stesso verso. Il `mb-1.5` resta: è la spaziatura di questo campo,
          non la sua tipografia. */}
      <label
        htmlFor={id}
        className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-kidville-green/80"
      >
        {label}
        {richiesto && <span className="text-kidville-green">*</span>}
      </label>

      <div className="relative">
        <input
          ref={campoRef}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          value={testo}
          aria-expanded={aperto}
          aria-controls={idElenco}
          aria-autocomplete="list"
          aria-activedescendant={aperto && corrente >= 0 ? idVoce(corrente) : undefined}
          aria-invalid={invalido || undefined}
          aria-required={richiesto || undefined}
          aria-describedby={describedById}
          aria-busy={caricamento || undefined}
          onChange={(e) => {
            setTesto(e.target.value);
            setDigitato(true);
            setAperto(true);
            // Nessuna voce evidenziata dopo una digitazione: con
            // `aria-autocomplete="list"` Invio non deve scegliere qualcosa che
            // l'utente non ha mai indicato. Si evidenzia con le frecce.
            setEvidenziato(-1);
          }}
          onClick={() => {
            // Apre e basta: NON commuta. A pannello aperto si sta digitando, e un
            // clic in mezzo al testo serve a spostare il cursore — chiudere lì
            // sarebbe un difetto, non una comodità. La commutazione sta sul
            // pulsante qui sotto, che è l'affordance che la promette.
            if (!aperto) apri(-1);
          }}
          onKeyDown={suTasto}
          onBlur={() => {
            if (aperto) chiudi(true);
          }}
          className={cx(
            // ⚠️ Nessun `outline-none`: l'anello di fuoco è quello di sistema
            // (`:focus-visible` in globals.css), che in Alto Contrasto diventa
            // giallo da solo. Toglierlo lascerebbe come unico segnale il cambio
            // di colore del bordo, cioè un segnale SOLO cromatico.
            'h-[46px] w-full rounded-input border-[1.5px] bg-kidville-white pl-4 pr-16 font-maven text-[15px] text-kidville-ink transition-colors',
            'placeholder:text-kidville-sub',
            'disabled:cursor-not-allowed disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub',
            invalido
              ? 'border-kidville-error'
              : 'border-kidville-line hover:border-kidville-green/50 focus:border-kidville-green',
          )}
        />

        {invalido && (
          // Il segno NON cromatico dell'errore: il bordo rosso da solo non è un
          // messaggio (WCAG 1.4.1). Il TESTO dell'errore sta fuori, ed è quello a
          // cui punta `describedById` — qui c'è l'indicatore di forma.
          <span
            data-kv-combobox-invalido="true"
            aria-hidden="true"
            className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 text-kidville-error-strong"
          >
            <AlertTriangle size={17} strokeWidth={2.2} />
          </span>
        )}

        {/* Il chevron è un PULSANTE vero, non un disegno. Un'icona che sembra un
            interruttore e apre soltanto è un comando dipinto: chi la clicca per
            richiudere non ottiene niente. Con `tabIndex={-1}` non aggiunge una
            tappa al giro di Tab (il fuoco del pattern combobox resta uno solo,
            l'input: APG), e `preventDefault` sul mousedown + `focus()` esplicito
            tengono il fuoco DOVE la tastiera lo cerca. */}
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label={testi.commutaElenco}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            campoRef.current?.focus();
            if (aperto) chiudi(true);
            else apri(-1);
          }}
          /* ── IL BERSAGLIO È 44×44, IL DISEGNO NON SI MUOVE (12/08/2026) ────
             Era `p-1.5` attorno a un'icona da 18 px: 30×30 px MISURATI a 360 px
             sul modulo pubblico del personale, dove ogni altro comando della
             stessa schermata sta a 44 (e il campo accanto a 328×46). 30 px
             passano il minimo di WCAG 2.5.8 (24×24) ma restano il bersaglio più
             piccolo di un modulo che si compila col pollice.
             Il riempimento cresce SOLO a sinistra e in verticale (`pl-5`
             + `py-[13px]` = 44×44) proprio perché il chevron resti dov'era: il
             margine destro è ancora `pr-1.5`, quindi l'icona non si sposta di un
             pixel. Il campo è alto 46 px e riserva `pr-16`: il bersaglio ci sta
             dentro e non copre nessun testo.
             ⚠️ La rotazione si è spostata sull'ICONA. Su un bottone con
             riempimento asimmetrico l'icona non sta nel centro geometrico, e
             `rotate-180` sul bottone la porterebbe dall'altra parte invece di
             capovolgerla. */
          className={cx(
            'absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full py-[13px] pl-5 pr-1.5',
            disabled ? 'cursor-not-allowed text-kidville-sub' : 'cursor-pointer text-kidville-green',
          )}
        >
          <ChevronDown
            size={18}
            strokeWidth={2.2}
            aria-hidden="true"
            className={cx('transition-transform', aperto && 'rotate-180')}
          />
        </button>

        {/* Il pannello resta SEMPRE nel DOM: `aria-controls` dell'input punta al
            suo elenco, e un riferimento che sparisce a pannello chiuso è un
            `aria-controls` rotto. `hidden` lo toglie dall'albero di accessibilità
            e dalla vista in un colpo solo.

            ⚠️ `preventDefault` sul mousedown sta QUI, sul contenitore, e non sulle
            voci. Un mousedown su un qualunque div non focalizzabile toglie il
            fuoco all'input → `onBlur` chiama `chiudi(true)` → il pannello si
            chiude e il testo digitato viene ripristinato. Le zone morte non erano
            solo le voci: il padding del pannello (`py-1.5`), le intestazioni di
            gruppo e soprattutto la BARRA DI SCORRIMENTO del listbox — cioè
            l'unico modo di percorrere 484 comuni col mouse, che è il caso d'uso
            scritto in cima a questo file. MISURATO in jsdom prima di spostarlo:
            `fireEvent.mouseDown` tornava `true` (non annullato) su listbox,
            pannello e intestazione, e `false` solo sulla voce.

            Sul contenitore l'evento risale e la difesa vive in un posto solo: le
            voci non lo ripetono (§4 continua a misurarlo dalla voce, che è dove
            l'utente clicca). Il chevron invece è FUORI dal pannello e tiene il
            proprio. */}
        <div
          hidden={!aperto}
          onMouseDown={(e) => e.preventDefault()}
          className={cx(
            'absolute left-0 right-0 top-[calc(100%+6px)] z-40 rounded-card border border-kidville-line bg-kidville-white py-1.5 shadow-xl',
            !aperto && 'hidden',
          )}
        >
          {caricamento && (
            <p className="px-3 py-2.5 font-maven text-sm text-kidville-sub">{testi.caricamento}</p>
          )}

          {/* `max-height` + `overflow-y`, e nessuna virtualizzazione: vedi il
              blocco in cima. Con 484 comuni il pannello scorre, e ogni voce
              resta un nodo vero a cui `aria-activedescendant` può puntare. */}
          <div
            ref={elencoRef}
            id={idElenco}
            role="listbox"
            aria-label={label}
            className="max-h-72 overflow-y-auto overscroll-contain"
          >
            {blocchi.map((blocco) =>
              blocco.gruppo === undefined ? (
                blocco.voci.map((voce) => (
                  <VoceElenco
                    key={voce.opzione.valore}
                    voce={voce}
                    id={idVoce(voce.indice)}
                    scelta={voce.opzione.valore === value}
                    evidenziata={voce.indice === corrente}
                    onScegli={scegli}
                    onEvidenzia={setEvidenziato}
                  />
                ))
              ) : (
                <div key={blocco.gruppo} role="group" aria-label={blocco.gruppo}>
                  <div className="px-3 pb-1 pt-2 font-barlow text-[11.5px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                    {blocco.gruppo}
                  </div>
                  {blocco.voci.map((voce) => (
                    <VoceElenco
                      key={voce.opzione.valore}
                      voce={voce}
                      id={idVoce(voce.indice)}
                      scelta={voce.opzione.valore === value}
                      evidenziata={voce.indice === corrente}
                      onScegli={scegli}
                      onEvidenzia={setEvidenziato}
                    />
                  ))}
                </div>
              ),
            )}
          </div>

          {!caricamento && piatte.length === 0 && (
            <p className="px-3 py-3 font-maven text-sm text-kidville-sub">{testi.vuoto}</p>
          )}
        </div>
      </div>

      {/* La regione live esiste da SUBITO e resta vuota a pannello chiuso: una
          live-region che nasce insieme al proprio testo non annuncia niente. */}
      <div id={idStato} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {annuncio}
      </div>
    </div>
  );
}

function VoceElenco({
  voce,
  id,
  scelta,
  evidenziata,
  onScegli,
  onEvidenzia,
}: {
  voce: Voce;
  id: string;
  scelta: boolean;
  evidenziata: boolean;
  onScegli: (opzione: OpzioneCombobox) => void;
  onEvidenzia: (indice: number) => void;
}) {
  const { opzione, indice } = voce;
  return (
    <div
      id={id}
      role="option"
      data-valore={opzione.valore}
      data-indice={indice}
      data-evidenziata={evidenziata ? 'true' : undefined}
      aria-selected={scelta}
      aria-disabled={opzione.disabilitata || undefined}
      // Niente `onMouseDown` qui: l'annullamento sta sul CONTENITORE del pannello
      // (l'evento risale) perché lì copre anche padding, intestazioni di gruppo e
      // barra di scorrimento — le zone morte che una difesa messa solo sulla voce
      // lasciava scoperte. Resta MISURATO dalla voce, che è dove l'utente clicca:
      // §4 «il clic vero» rifà la sequenza del browser (mousedown → fuoco → click)
      // invece del solo `fireEvent.click`, che non sposta mai il fuoco.
      onClick={() => onScegli(opzione)}
      onMouseMove={() => {
        if (!opzione.disabilitata) onEvidenzia(indice);
      }}
      className={cx(
        // Il bordo sinistro c'è sempre (trasparente a riposo): l'evidenziazione
        // cambia FORMA e non solo tinta, e la voce non si sposta di 3px quando la
        // si percorre con le frecce.
        'flex items-start gap-2 border-l-[3px] py-2 pl-[9px] pr-3 font-maven text-[14.5px] leading-tight',
        opzione.disabilitata
          ? 'cursor-not-allowed border-transparent text-kidville-sub'
          : evidenziata
            ? 'cursor-pointer border-kidville-green bg-kidville-green-soft text-kidville-green'
            : 'cursor-pointer border-transparent text-kidville-ink',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate', scelta && 'font-semibold')}>{opzione.etichetta}</span>
        {/* La nota FA PARTE del nome accessibile della voce, ed è voluto: dice
            perché quella voce è diversa dalle altre, e nasconderla lascerebbe chi
            non vede a scegliere fra opzioni apparentemente identiche.
            Lo spazio qui sotto NON è una svista di formattazione: senza, il nome
            calcolato è «NichelinoSede convenzionata» attaccato. Il separatore lo
            darebbe il `display:block` dei due span — cioè il CSS — e un nome
            accessibile che dipende dal foglio di stile è un nome fragile
            (MISURATO: in jsdom, senza CSS, esce senza spazio). Fra due riquadri di
            blocco lo spazio bianco si perde nel rendering: non si vede, si sente. */}
        {opzione.nota && ' '}
        {opzione.nota && (
          <span className="mt-0.5 block truncate text-[12.5px] text-kidville-sub">{opzione.nota}</span>
        )}
      </span>
      {scelta && (
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-kidville-green">
          <Check size={16} strokeWidth={2.4} />
        </span>
      )}
    </div>
  );
}
