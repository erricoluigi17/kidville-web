'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { Badge } from '@/components/ui/Badge';
import { DateField } from '@/components/ui/DateField';
import { BERSAGLIO_TOCCO, FoglioFiltri } from '@/components/ui/FoglioFiltri';
import type { StatoFiltri } from '@/lib/ui/filtri/use-filtri';
import type {
  CampoFiltro,
  Periodo,
  TestiBarraFiltri,
  Traduttore,
  ValoreFiltro,
  ValoriFiltri,
} from '@/lib/ui/filtri/tipi';

// Ri-esportati per chi monta la barra: il componente e la forma dei suoi testi
// si importano dallo stesso posto, senza dover conoscere `lib/ui/filtri/tipi`.
export type { TestiBarraFiltri, Traduttore } from '@/lib/ui/filtri/tipi';

/**
 * ─── LA BARRA FILTRI ─────────────────────────────────────────────────────────
 *
 * Desktop (`variante="cockpit"`) — è una CARD, non una riga nuda:
 *
 *   riga 1  [⌕ ricerca            ✕] [Stato ▾] [Sede ▾]        [⚙ Filtri ③]
 *   riga 2  (solo se attivi) chip removibili          ✕ Pulisci filtri
 *   riga 3  «12 risultati su 387»            ← role="status", aria-live="polite"
 *
 * Telefono (`variante="compatta"`) — ricerca a piena larghezza, una pillola
 * «Filtri ③» che apre il FOGLIO dal basso, e le pastiglie di stato che scorrono
 * in orizzontale.
 *
 * ── LA REGOLA CROMATICA, che è metà del lavoro ──────────────────────────────
 * Il chip di uno stato usa **lo stesso tono** del badge di quello stato
 * nell'elenco: il chip *è* un `Badge`, con il `tono` che l'opzione porta con sé.
 * Non si risceglie a occhio, e non si riscrive la mappa dei toni: altrimenti «In
 * attesa» filtro e «In attesa» riga diventano due arancioni diversi nella stessa
 * schermata, e il colore smette di voler dire qualcosa.
 *
 * La pastiglia del conteggio su «Filtri» è `bg-kidville-yellow text-kidville-ink`.
 * **Mai giallo su verde**: `kidville-yellow` su `kidville-green` vale 4,05:1,
 * sotto AA per il testo normale — misurato e scritto in `globals.css` (blocco
 * «Inchiostri di BRAND»), e un conteggio è testo piccolo. Niente hex letterali
 * nemmeno nei commenti: `design-tokens-admin` li cerca riga per riga, e il
 * giorno in cui il suo perimetro comprenderà anche `components/ui` questo file
 * non deve essere il motivo per cui non ci entra.
 *
 * ── IL FUOCO ───────────────────────────────────────────────────────────────
 * La geometria dei controlli è quella della `Toolbar` del cockpit
 * (`cockpit.tsx`): `h-[42px]`, `rounded-input`, `border-[1.5px]
 * border-kidville-line`, anello `focus:ring-2 focus:ring-kidville-green/15`.
 * ⚠️ Con UNA differenza voluta: qui NON c'è `outline-none`. L'anello
 * `ring-kidville-*` nasce da `@theme inline` e porta l'hex INLINATO nel
 * `box-shadow`: in Alto Contrasto resta verde mentre tutto il resto passa al
 * giallo. Togliendo `outline-none` l'anello di sistema (`:focus-visible`, 2px
 * verdi / 3px gialli in HC) resta sopra — stessa geometria, un difetto in meno.
 * È la lezione già scritta in `Combobox.tsx` e in `.kv-fuoco-esito`.
 *
 * ── LINGUA: il componente NON contiene testo ───────────────────────────────
 * I testi arrivano risolti dalla prop `testi` (vedi `TestiBarraFiltri`), e le
 * etichette dei campi dalla definizione dei campi. Il ponte col catalogo è
 * `testiBarraFiltri(t)` qui sotto, dove ogni chiave è scritta per esteso: mai
 * una chiave costruita da un dato.
 */

/**
 * I testi generici della barra, presi dal catalogo `shared`.
 *
 * Ogni chiave è scritta PER ESTESO, e non è un dettaglio di stile: il lock
 * `messaggi-chiavi-orfane` riconosce una chiave morta solo se il codice la
 * nomina, e una chiave costruita da un dato (`t(campo.chiave)`) renderebbe
 * cieco quel controllo su tutto il namespace.
 */
export function testiBarraFiltri(t: Traduttore): TestiBarraFiltri {
  return {
    ricerca: t('filtriRicercaEtichetta'),
    ricercaSegnaposto: t('cerca'),
    pulisciRicerca: t('galleryPulisciRicerca'),
    filtri: t('filtriTitolo'),
    filtriAttivi: t('filtriAttivi'),
    rimuoviFiltro: (filtro: string) => t('filtriRimuovi', { filtro }),
    pulisci: t('filtriPulisci'),
    pulisciBreve: t('filtriPulisciBreve'),
    tutti: t('filtriTutti'),
    dal: t('filtriDal'),
    al: t('filtriAl'),
    risultati: (mostrati: number, totale: number) => t('filtriRisultati', { mostrati, totale }),
    mostraRisultati: (n: number) => t('filtriMostraRisultati', { n }),
    chiudi: t('chiudi'),
  };
}

// ── Geometria: la stessa della `Toolbar` del cockpit, senza `outline-none` ────
const GEOMETRIA =
  'h-[42px] rounded-input border-[1.5px] border-kidville-line bg-kidville-white font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';
const ETICHETTA =
  'mb-1 block font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-sub';
const PASTIGLIA =
  'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-barlow text-[13px] font-extrabold uppercase tracking-[0.02em] transition-colors';
const PASTIGLIA_ON = 'bg-kidville-green text-kidville-white';
const PASTIGLIA_OFF =
  'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50';

/** Un campo che non ha (più) niente da scegliere non si disegna. */
function daNascondere<R>(campo: CampoFiltro<R>): boolean {
  return Boolean(campo.nascondiSeVuoto && 'opzioni' in campo && campo.opzioni.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Il controllo di UN campo — lo stesso nella prima riga, nel pannello e nel foglio
// ─────────────────────────────────────────────────────────────────────────────

interface ControlloProps<R> {
  campo: CampoFiltro<R>;
  valori: ValoriFiltri;
  onImposta: (chiave: string, valore: ValoreFiltro) => void;
  testi: TestiBarraFiltri;
  idBase: string;
  /** Nel foglio si tocca col pollice: bersagli ≥44px. */
  tocco?: boolean;
  /**
   * Il controllo vive dentro una fila che SCORRE in orizzontale (telefono): le
   * pastiglie non devono andare a capo, o la fila diventa un blocco alto tre
   * righe invece di una striscia da scorrere.
   */
  inFila?: boolean;
}

function ControlloFiltro<R>({ campo, valori, onImposta, testi, idBase, tocco, inFila }: ControlloProps<R>) {
  const id = `${idBase}-${campo.chiave}`;
  const pastiglia = (attiva: boolean) =>
    cx(PASTIGLIA, attiva ? PASTIGLIA_ON : PASTIGLIA_OFF, tocco && `${BERSAGLIO_TOCCO} px-4`);

  if (campo.tipo === 'scelta') {
    const valore = typeof valori[campo.chiave] === 'string' ? (valori[campo.chiave] as string) : '';
    return (
      <div className={cx('min-w-0', tocco && 'mb-4')}>
        <label htmlFor={id} className={ETICHETTA}>
          {campo.etichetta}
        </label>
        <select
          id={id}
          value={valore}
          onChange={(e) => onImposta(campo.chiave, e.target.value)}
          className={cx(GEOMETRIA, 'w-full cursor-pointer px-3 hover:border-kidville-green/50', tocco && 'h-[44px]')}
        >
          {/* La voce «nessun filtro» c'è solo dove il filtro si può togliere: su
              un campo obbligatorio non esiste il «tutti», e offrirla vorrebbe
              dire offrire uno stato in cui la richiesta non può stare. */}
          {!campo.obbligatorio && <option value="">{testi.tutti}</option>}
          {campo.opzioni.map((o) => (
            <option key={o.valore} value={o.valore}>
              {o.conteggio === undefined ? o.etichetta : `${o.etichetta} (${o.conteggio})`}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (campo.tipo === 'chip' || campo.tipo === 'multi') {
    const scelti =
      campo.tipo === 'multi'
        ? new Set(Array.isArray(valori[campo.chiave]) ? (valori[campo.chiave] as string[]) : [])
        : new Set(typeof valori[campo.chiave] === 'string' && valori[campo.chiave] !== '' ? [valori[campo.chiave] as string] : []);
    const commuta = (valore: string) => {
      if (campo.tipo === 'multi') {
        const dentro = Array.isArray(valori[campo.chiave]) ? (valori[campo.chiave] as string[]) : [];
        onImposta(campo.chiave, dentro.includes(valore) ? dentro.filter((v) => v !== valore) : [...dentro, valore]);
        return;
      }
      onImposta(campo.chiave, scelti.has(valore) ? '' : valore);
    };
    return (
      // `fieldset`/`legend`: le pastiglie sono un GRUPPO di interruttori, e senza
      // il nome del gruppo uno screen reader legge «In attesa, premuto» senza
      // dire di che cosa. Non `role="radiogroup"` nemmeno per il tipo `chip`: la
      // scelta si può REVOCARE (ripremendo), e «radio» prometterebbe il contrario.
      <fieldset className={cx('min-w-0 border-0 p-0', tocco && 'mb-4')}>
        <legend className={ETICHETTA}>{campo.etichetta}</legend>
        <div className={cx('flex items-center gap-2', inFila ? 'flex-nowrap' : 'flex-wrap')}>
          {campo.opzioni.map((o) => {
            const attiva = scelti.has(o.valore);
            return (
              <button
                key={o.valore}
                type="button"
                aria-pressed={attiva}
                onClick={() => commuta(o.valore)}
                className={pastiglia(attiva)}
              >
                {o.etichetta}
                {o.conteggio !== undefined && (
                  <span
                    className={cx(
                      'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill px-1.5 font-barlow text-[11px] font-extrabold',
                      attiva ? 'bg-kidville-white/25 text-kidville-white' : 'bg-kidville-neutral-soft text-kidville-neutral',
                    )}
                  >
                    {o.conteggio}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (campo.tipo === 'periodo') {
    const periodo: Periodo =
      valori[campo.chiave] && typeof valori[campo.chiave] === 'object' && !Array.isArray(valori[campo.chiave])
        ? (valori[campo.chiave] as Periodo)
        : { da: '', a: '' };
    const campoData = cx(GEOMETRIA, 'w-full px-3', tocco && 'h-[44px]');
    return (
      <fieldset className={cx('min-w-0 border-0 p-0', tocco && 'mb-4')}>
        <legend className={ETICHETTA}>{campo.etichetta}</legend>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}-da`} className="sr-only">
              {testi.dal}
            </label>
            <DateField
              id={`${id}-da`}
              value={periodo.da}
              onChange={(iso) => onImposta(campo.chiave, { ...periodo, da: iso })}
              className={campoData}
            />
          </div>
          <span aria-hidden="true" className="font-maven text-sm text-kidville-sub">
            →
          </span>
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}-a`} className="sr-only">
              {testi.al}
            </label>
            <DateField
              id={`${id}-a`}
              value={periodo.a}
              onChange={(iso) => onImposta(campo.chiave, { ...periodo, a: iso })}
              className={campoData}
            />
          </div>
        </div>
      </fieldset>
    );
  }

  if (campo.tipo === 'interruttore') {
    const acceso = valori[campo.chiave] === true;
    return (
      <div className={cx('min-w-0', tocco && 'mb-4')}>
        <button
          type="button"
          role="switch"
          aria-checked={acceso}
          onClick={() => onImposta(campo.chiave, !acceso)}
          className={cx(
            'inline-flex items-center gap-2.5 rounded-pill px-3 py-2 font-maven text-sm text-kidville-ink transition-colors',
            tocco && `${BERSAGLIO_TOCCO} px-4`,
          )}
        >
          <span
            className={cx(
              'relative h-[26px] w-[44px] shrink-0 rounded-pill transition-colors',
              acceso ? 'bg-kidville-green' : 'bg-kidville-neutral-soft',
            )}
          >
            <span
              className={cx(
                'absolute top-[3px] h-5 w-5 rounded-pill bg-kidville-white shadow transition-transform',
                acceso ? 'translate-x-[21px]' : 'translate-x-[3px]',
              )}
            />
          </span>
          {campo.etichetta}
        </button>
      </div>
    );
  }

  // `ricerca`: il campo vive nella prima riga della barra, non qui.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// La barra
// ─────────────────────────────────────────────────────────────────────────────

interface BarraFiltriProps<R> {
  campi: readonly CampoFiltro<R>[];
  /** Lo stato restituito da `useFiltri` con GLI STESSI campi. */
  stato: StatoFiltri<R>;
  testi: TestiBarraFiltri;
  /** Quante righe esistono in questa linguetta SENZA filtri. */
  totale: number;
  /** Quante se ne vedono adesso. */
  mostrati: number;
  variante?: 'cockpit' | 'compatta';
  className?: string;
}

export function BarraFiltri<R>({
  campi,
  stato,
  testi,
  totale,
  mostrati,
  variante = 'cockpit',
  className,
}: BarraFiltriProps<R>) {
  const idBase = useId();
  const idPannello = `${idBase}-pannello`;
  const idFoglio = `${idBase}-foglio`;
  const [pannelloAperto, setPannelloAperto] = useState(false);
  const [foglioAperto, setFoglioAperto] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Il campo di ricerca lo possiede la barra, non l'hook — e il fuoco con lui.
   *
   * ⚠️ Il ref DEVE nascere qui e non arrivare da `stato`: `react-hooks/refs`
   * marca come ref qualunque valore finisca in un `ref={…}` e fa risalire la
   * marcatura all'oggetto di provenienza. Con `ref={stato.qualcosa}` ogni
   * `stato.nAttivi`/`stato.attivi` letto qui sotto diventa un errore di gate
   * (misurato: otto). Vedi la nota in `use-filtri.ts`.
   */
  const ricercaRef = useRef<HTMLInputElement>(null);
  const contenitoreRef = useRef<HTMLDivElement>(null);
  const compatta = variante === 'compatta';

  const visibili = campi.filter((c) => !daNascondere(c));
  const ricerca = visibili.find((c) => c.tipo === 'ricerca');
  const altri = visibili.filter((c) => c.tipo !== 'ricerca');
  // Desktop: i primari in riga, gli altri nel pannello.
  // Telefono: in riga restano solo le pastiglie, tutto il resto scende nel foglio.
  const inRiga = compatta ? altri.filter((c) => c.tipo === 'chip') : altri.filter((c) => c.primario);
  const nascosti = altri.filter((c) => !inRiga.includes(c));

  // Escape e clic fuori chiudono il pannello del desktop. `setState` qui sta
  // dentro un ASCOLTATORE, non nel corpo dell'effetto: la regola
  // `react-hooks/set-state-in-effect` (errore nel gate) resta soddisfatta.
  useEffect(() => {
    if (!pannelloAperto) return;
    const suTasto = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPannelloAperto(false);
      // WCAG 2.4.3: chiudendo da tastiera il fuoco torna al comando che ha
      // aperto, non sul `<body>`.
      triggerRef.current?.focus();
    };
    const suClic = (e: MouseEvent) => {
      if (contenitoreRef.current && !contenitoreRef.current.contains(e.target as Node)) setPannelloAperto(false);
    };
    document.addEventListener('keydown', suTasto);
    document.addEventListener('mousedown', suClic);
    return () => {
      document.removeEventListener('keydown', suTasto);
      document.removeEventListener('mousedown', suClic);
    };
  }, [pannelloAperto]);

  const controllo = (campo: CampoFiltro<R>, opzioni?: { tocco?: boolean; inFila?: boolean }) => (
    <ControlloFiltro
      key={campo.chiave}
      campo={campo}
      valori={stato.valori}
      onImposta={stato.imposta}
      testi={testi}
      // Id diversi fra la barra e il foglio: gli stessi campi possono essere resi
      // due volte nello stesso documento, e due `<label for>` che puntano allo
      // stesso id fanno finire il fuoco sul primo dei due — cioè su un controllo
      // che magari è nascosto.
      idBase={opzioni?.tocco ? `${idBase}-foglio` : idBase}
      tocco={opzioni?.tocco}
      inFila={opzioni?.inFila}
    />
  );

  const testoRicerca =
    ricerca && typeof stato.valori[ricerca.chiave] === 'string' ? (stato.valori[ricerca.chiave] as string) : '';

  return (
    <div className={cx('rounded-card bg-kidville-white p-3 shadow-sm sm:p-4', className)}>
      <div
        ref={contenitoreRef}
        className={cx('flex gap-3', compatta ? 'flex-col' : 'flex-wrap items-end')}
      >
        {ricerca && (
          <div className={cx('min-w-0', compatta ? 'w-full' : 'min-w-[220px] flex-1')}>
            <label htmlFor={`${idBase}-${ricerca.chiave}`} className={ETICHETTA}>
              {ricerca.etichetta || testi.ricerca}
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-kidville-neutral">
                <Search size={17} aria-hidden="true" />
              </span>
              <input
                ref={ricercaRef}
                id={`${idBase}-${ricerca.chiave}`}
                type="search"
                value={testoRicerca}
                onChange={(e) => stato.imposta(ricerca.chiave, e.target.value)}
                placeholder={('segnaposto' in ricerca ? ricerca.segnaposto : undefined) ?? testi.ricercaSegnaposto}
                className={cx(GEOMETRIA, 'w-full pl-10 pr-10')}
              />
              {testoRicerca !== '' && (
                <button
                  type="button"
                  onClick={() => {
                    stato.rimuovi(ricerca.chiave);
                    // Il ✕ sparisce insieme al testo: senza questa riga il fuoco
                    // cadrebbe sul `<body>` (WCAG 2.4.3).
                    ricercaRef.current?.focus();
                  }}
                  aria-label={testi.pulisciRicerca}
                  className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-kidville-sub hover:text-kidville-green"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )}

        <div className={cx('flex items-end gap-3', compatta ? 'min-w-0' : 'flex-wrap')}>
          {/* Su telefono le pastiglie SCORRONO in orizzontale invece di andare a
              capo tre volte e mangiarsi mezzo schermo — ma il comando «Filtri»
              resta FUORI dalla striscia che scorre: dentro, scivolerebbe via al
              primo gesto e l'unico modo di riaprirlo sarebbe scorrere indietro.
              `scrollbar-none` esiste davvero in Tailwind v4 (`scrollbar-width:
              none`): verificato nel CSS COSTRUITO, non dato per buono. */}
          <div
            className={cx(
              'flex items-end gap-3',
              compatta ? 'min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto scrollbar-none pb-1' : 'flex-wrap',
            )}
          >
            {inRiga.map((campo) => (
              <div key={campo.chiave} className={cx('min-w-0', compatta && 'shrink-0 snap-start')}>
                {controllo(campo, { inFila: compatta })}
              </div>
            ))}
          </div>

          {nascosti.length > 0 && (
            <div className={cx('relative', compatta && 'shrink-0')}>
              <button
                ref={triggerRef}
                type="button"
                aria-expanded={compatta ? foglioAperto : pannelloAperto}
                aria-controls={compatta ? (foglioAperto ? idFoglio : undefined) : idPannello}
                onClick={() => (compatta ? setFoglioAperto(true) : setPannelloAperto((v) => !v))}
                className={cx(
                  GEOMETRIA,
                  'inline-flex items-center gap-2 px-3.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:border-kidville-green/50',
                )}
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
                {testi.filtri}
                {stato.nAttivi > 0 && (
                  // Giallo su INCHIOSTRO, mai giallo su verde: quella coppia sta a
                  // 4,05:1, sotto AA, e un conteggio è testo piccolo.
                  <span
                    data-testid="conteggio-filtri"
                    className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-pill bg-kidville-yellow px-1.5 font-barlow text-[12px] font-extrabold text-kidville-ink"
                  >
                    {stato.nAttivi}
                  </span>
                )}
              </button>

              {/* Il pannello resta SEMPRE nel DOM: `aria-controls` punta qui, e un
                  riferimento che sparisce a pannello chiuso è un `aria-controls`
                  rotto. `hidden` lo toglie dalla vista e dall'albero di
                  accessibilità in un colpo solo.
                  NIENTE `role="menu"` e niente `aria-haspopup`: un menu ARIA
                  promette la navigazione con le frecce, che qui non c'è — la
                  relazione la dichiarano `aria-expanded` + `aria-controls`.
                  (Stessa motivazione già scritta per il `SedeSelector`.) */}
              {!compatta && (
                <div
                  id={idPannello}
                  hidden={!pannelloAperto}
                  role="group"
                  aria-label={testi.filtri}
                  className="absolute right-0 top-[calc(100%+8px)] z-40 w-[320px] max-w-[92vw] rounded-card border border-kidville-line bg-kidville-white p-4 shadow-xl"
                >
                  <div className="flex flex-col gap-4">{nascosti.map((campo) => controllo(campo))}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {stato.attivi.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <ul
            aria-label={testi.filtriAttivi}
            className={cx(
              'flex min-w-0 flex-1 items-center gap-2',
              compatta ? 'snap-x overflow-x-auto scrollbar-none pb-1' : 'flex-wrap',
            )}
          >
            {stato.attivi.map((attivo) => (
              <li key={`${attivo.chiave}:${attivo.valore ?? ''}`} className={cx(compatta && 'shrink-0 snap-start')}>
                <Badge
                  tone={attivo.tono ?? 'neutral'}
                  data-testid={`chip-${attivo.chiave}-${attivo.valore ?? ''}`}
                  className="gap-1 pr-1"
                >
                  {attivo.testo}
                  <button
                    type="button"
                    onClick={() => stato.rimuovi(attivo.chiave, attivo.valore)}
                    aria-label={testi.rimuoviFiltro(`${attivo.etichetta}: ${attivo.testo}`)}
                    className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-kidville-ink/10"
                  >
                    <X size={13} aria-hidden="true" strokeWidth={2.6} />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              stato.pulisci();
              // «Pulisci filtri» sparisce insieme ai filtri: il fuoco resterebbe
              // sul `<body>` e chi naviga da tastiera ricomincerebbe dalla cima
              // della pagina (WCAG 2.4.3). Il campo di ricerca è dove si
              // ricomincia a cercare.
              ricercaRef.current?.focus();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 font-maven text-xs font-semibold text-kidville-ink/80 transition-colors hover:border-kidville-green"
          >
            <X size={13} aria-hidden="true" />
            {testi.pulisci}
          </button>
        </div>
      )}

      {/* Il conteggio si ANNUNCIA: chi vede legge l'elenco accorciarsi, chi non
          vede riceve quel numero solo da qui. La regione esiste da sempre (non
          nasce insieme al proprio testo), altrimenti non annuncerebbe niente. */}
      <p
        data-testid="conteggio-risultati"
        role="status"
        aria-live="polite"
        className="mt-2 font-maven text-[12.5px] text-kidville-sub"
      >
        {testi.risultati(mostrati, totale)}
      </p>

      {compatta && (
        <FoglioFiltri
          id={idFoglio}
          aperto={foglioAperto}
          onChiudi={() => setFoglioAperto(false)}
          testi={testi}
          mostrati={mostrati}
          nAttivi={stato.nAttivi}
          onPulisci={() => stato.pulisci()}
          ritornoFuocoRef={triggerRef}
        >
          {nascosti.map((campo) => controllo(campo, { tocco: true }))}
        </FoglioFiltri>
      )}
    </div>
  );
}
