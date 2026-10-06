'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Pencil } from 'lucide-react';
import { DOC_EXPIRY_MINIMO, PERSONALE_FIELDS, TIPI_DOCUMENTO } from '@/lib/forms/personale-template';
import { messaggioSoloCatalogo } from '@/lib/ui/esito-fetch';
import { logClient } from '@/lib/logging/client';

/**
 * AGGIORNARE I DATI DEL DOCUMENTO RINNOVATO — tipo, numero, scadenza.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 * Il 06/10/2026 l'admin ha provato a rinnovare il documento di un dipendente — il cron dei
 * 60 giorni lo aveva avvisato alle 05:47 — e «non mi fa modificare le date». Era vero:
 * la scheda dichiarava «da qui non si corregge nessun dato anagrafico» e rimandava al
 * «cruscotto delle scadenze», che fa solo `GET`; e `admin/anagrafica-personale:PATCH` — la
 * correzione allo sportello, con gate di sede, audit e il trigger che azzera il promemoria
 * quando la scadenza cambia — non la chiamava nessun componente. L'unica strada era far
 * ricompilare alla persona TUTTO il modulo pubblico e approvare la pratica.
 *
 * ─── PERCHÉ NON È «UN SECONDO MODULO DI RACCOLTA» ──────────────────────────────
 * La testata di `StaffDetailPanel` rifiuta venti `<input>` sull'anagrafica per una ragione
 * vera: sarebbero una seconda validazione da tenere allineata a `PERSONALE_FIELDS`, e una
 * strada per infilare un codice fiscale che nessuno ha verificato. Qui i campi sono TRE,
 * non toccano il codice fiscale, e la validazione NON è riscritta: il tipo viene da
 * `TIPI_DOCUMENTO` (la fonte del `refine` della PATCH), il limite della data da
 * `DOC_EXPIRY_MINIMO` (la copia del CHECK di tabella, confrontata da un test con la
 * migrazione). La route resta l'autorità: questo modulo anticipa solo i rifiuti che sa già.
 *
 * ─── LE REGOLE CHE QUI SI CONSERVANO ──────────────────────────────────────────
 *  · SI SPEDISCE SOLO CIÒ CHE È CAMBIATO. Un campo non toccato non si riscrive: la PATCH
 *    è una correzione, e il suo audit dice quali campi sono stati toccati.
 *  · LA SCADENZA È OBBLIGATORIA. Svuotarla spegnerebbe il promemoria in silenzio — è la
 *    colonna che il cron dell'allarme legge — cioè il guasto che nessuno si accorge di aver
 *    causato.
 *  · UNA RICHIESTA PER VOLTA, NEL GESTORE e non su `disabled`: disabilitare un controllo
 *    che ha il fuoco lo fa cadere su `<body>`. L'etichetta del comando NON cambia mentre
 *    lavora (un nome accessibile che cambia sotto le dita di chi usa lo screen reader è
 *    peggio di una rotellina): lo dicono `aria-busy` e l'icona.
 *  · IL RIFIUTO SI LEGGE DAL CATALOGO (`messaggioSoloCatalogo`), mai nella prosa del server:
 *    quella è italiana per costruzione e può nominare una colonna.
 *  · NEL LOG ENTRA LO STATO, MAI I VALORI: un numero di documento è la chiave con cui si
 *    impersona qualcuno a uno sportello.
 *  · DOPO IL SALVATAGGIO SI RILEGGE IL FASCICOLO (`onSalvato`): è lui la fonte di verità,
 *    questa sezione non indovina lo stato.
 *  · IL FUOCO TORNA SUL COMANDO quando il modulo si smonta, invece di cadere su `<body>`.
 */

const API_ANAGRAFICA = '/api/admin/anagrafica-personale';

/** I tre dati, come stringhe: `''` = non indicato. È la forma del fascicolo e dei campi. */
export interface DatiDocumento {
  tipo: string;
  numero: string;
  scadenza: string;
}

/**
 * Gli stili arrivano dal chiamante e NON si importano da `StaffDetailPanel`: quel file
 * importa questo, e un import circolare funzionerebbe finché qualcuno non usa una di quelle
 * costanti a livello di modulo. Sono le stesse stringhe dei comandi della scheda (44 px,
 * lock «i comandi nuovi arrivano a 44px»), non una copia che diverge.
 */
export interface StiliScheda {
  primario: string;
  secondario: string;
  campo: string;
}

interface Props {
  utenteId: string;
  userId?: string | null;
  iniziale: DatiDocumento;
  /** Rilegge il fascicolo: la scheda non indovina lo stato dopo una scrittura. */
  onSalvato: () => Promise<void>;
  rotta: string;
  stili: StiliScheda;
}

/** Il primo giorno che il CHECK ammette: `>` stretto, quindi il giorno DOPO il limite. */
function giornoDopo(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
// ⚠️ NON si chiama `SCADENZA_…`: il lock sui tempi (`logging-tetto.test.ts`) legge ogni
// costante con quella parola nel nome come un tetto in millisecondi, e questa è una data.
const PRIMO_GIORNO_AMMESSO = giornoDopo(DOC_EXPIRY_MINIMO);

export function DatiDocumentoSezione({ utenteId, userId, iniziale, onSalvato, rotta, stili }: Props) {
  const t = useTranslations('adminStudents');
  const [aperto, setAperto] = useState(false);
  const [esito, setEsito] = useState<string | null>(null);
  const comando = useRef<HTMLButtonElement>(null);
  const ricoverare = useRef(false);

  // Il modulo si smonta con il fuoco dentro («Salva»/«Annulla» spariscono con lui):
  // senza questo il fuoco cade su `<body>` e chi lavora da tastiera riparte dall'inizio
  // della scheda (WCAG 2.4.3). Non scrive stato: sposta soltanto il fuoco.
  useEffect(() => {
    if (!ricoverare.current) return;
    ricoverare.current = false;
    comando.current?.focus();
  }, [aperto]);

  const chiudi = (testo: string | null) => {
    ricoverare.current = true;
    setEsito(testo);
    setAperto(false);
  };

  return (
    <section className="rounded-card border border-kidville-line p-4">
      <h3 className="font-barlow text-sm font-extrabold uppercase tracking-[0.02em] text-kidville-green">
        {t('staffDocDatiTitolo')}
      </h3>
      <p className="mt-1 max-w-[25rem] font-maven text-xs leading-relaxed text-kidville-sub">{t('staffDocDatiHint')}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          ref={comando}
          type="button"
          aria-expanded={aperto}
          onClick={() => {
            setEsito(null);
            setAperto((a) => !a);
          }}
          className={stili.secondario}
        >
          <Pencil size={15} aria-hidden="true" /> {t('staffDocDatiApri')}
        </button>
        {esito && (
          <p role="status" className="font-maven text-xs text-kidville-success-strong">
            {esito}
          </p>
        )}
      </div>

      {aperto && (
        <FormDati
          utenteId={utenteId}
          userId={userId}
          iniziale={iniziale}
          rotta={rotta}
          stili={stili}
          onSalvato={onSalvato}
          onChiudi={chiudi}
        />
      )}
    </section>
  );
}

function FormDati({
  utenteId, userId, iniziale, rotta, stili, onSalvato, onChiudi,
}: Omit<Props, 'onSalvato'> & {
  onSalvato: () => Promise<void>;
  onChiudi: (esito: string | null) => void;
}) {
  const t = useTranslations('adminStudents');
  const te = useTranslations('etichette');
  const idTipo = useId();
  const idNumero = useId();
  const idScadenza = useId();
  const idErroreNumero = useId();
  const idErroreScadenza = useId();

  const [tipo, setTipo] = useState(iniziale.tipo);
  const [numero, setNumero] = useState(iniziale.numero);
  const [scadenza, setScadenza] = useState(iniziale.scadenza);
  const [errNumero, setErrNumero] = useState<string | null>(null);
  const [errScadenza, setErrScadenza] = useState<string | null>(null);
  const [errServer, setErrServer] = useState<string | null>(null);
  const [nessunaModifica, setNessunaModifica] = useState(false);
  const [inVolo, setInVolo] = useState(false);
  // Il ref e non lo stato: due click nello stesso tick vedono lo stesso `inVolo` stantio.
  const inVoloRef = useRef(false);

  /** Le etichette vengono dal catalogo condiviso, con il ripiego italiano del modulo. */
  const etichetta = (id: string): string => {
    const chiave = `campoPersonale_${id}`;
    return te.has(chiave) ? te(chiave) : (PERSONALE_FIELDS.find((c) => c.id === id)?.label ?? id);
  };
  const etichettaTipo = (valore: string, ripiego: string): string => {
    const chiave = `opzPersonale_document_type_${valore}`;
    return te.has(chiave) ? te(chiave) : ripiego;
  };

  const salva = async (e: FormEvent) => {
    e.preventDefault();
    if (inVoloRef.current) return;

    setErrServer(null);
    setNessunaModifica(false);
    const numeroPulito = numero.trim();
    // Prima si dicono TUTTI i campi sbagliati, non uno per invio.
    const eNumero = numeroPulito === '' && iniziale.numero !== '' ? t('staffDocDatiNumeroObbligatorio') : null;
    const eScadenza =
      scadenza === ''
        ? t('staffDocDatiScadenzaObbligatoria')
        : !(scadenza > DOC_EXPIRY_MINIMO)
          ? t('staffDocDatiScadenzaTroppoVecchia')
          : null;
    setErrNumero(eNumero);
    setErrScadenza(eScadenza);
    if (eNumero || eScadenza) return;

    // SOLO ciò che è cambiato.
    const corpo: Record<string, string> = { utenteId };
    if (tipo !== iniziale.tipo) corpo.document_type = tipo;
    if (numeroPulito !== iniziale.numero) corpo.document_number = numeroPulito;
    if (scadenza !== iniziale.scadenza) corpo.document_expiry = scadenza;
    if (Object.keys(corpo).length === 1) {
      setNessunaModifica(true);
      return;
    }

    inVoloRef.current = true;
    setInVolo(true);
    try {
      const res = await fetch(API_ANAGRAFICA, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify(corpo),
      }).catch(() => null);
      if (!res || !res.ok) {
        // Lo STATO, mai i valori: né il numero né la data entrano in `app_log`.
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: 'anagrafica-personale-documento-non-corretto',
          route: rotta,
          stato: res?.status,
        });
        setErrServer(res ? await messaggioSoloCatalogo(res, t('staffDocDatiErrore')) : t('staffDocDatiErrore'));
        return;
      }
      await onSalvato();
      onChiudi(t('staffDocDatiAggiornati'));
    } finally {
      inVoloRef.current = false;
      setInVolo(false);
    }
  };

  const classeCampo = `${stili.campo} aria-[invalid=true]:border-kidville-error-strong`;
  const classeErrore = 'mt-1 font-maven text-xs text-kidville-error-strong';

  return (
    <form noValidate onSubmit={(e) => void salva(e)} className="mt-3 grid gap-3 sm:grid-cols-2">
      <div className="min-w-0">
        <label htmlFor={idTipo} className="mb-1 block font-maven text-xs text-kidville-sub">
          {etichetta('document_type')}
        </label>
        <select id={idTipo} value={tipo} onChange={(e) => setTipo(e.target.value)} className={classeCampo}>
          {/* Un fascicolo senza tipo ha il valore `''`: l'opzione c'è solo allora, e non
              si può SCEGLIERE di nuovo dopo aver scelto un tipo vero. */}
          {iniziale.tipo === '' && <option value="">{t('staffAnaNonIndicato')}</option>}
          {TIPI_DOCUMENTO.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {etichettaTipo(String(o.value), o.label)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-0">
        <label htmlFor={idNumero} className="mb-1 block font-maven text-xs text-kidville-sub">
          {etichetta('document_number')}
        </label>
        <input
          id={idNumero}
          type="text"
          value={numero}
          maxLength={50}
          autoComplete="off"
          onChange={(e) => setNumero(e.target.value)}
          aria-invalid={errNumero ? true : undefined}
          aria-describedby={errNumero ? idErroreNumero : undefined}
          className={classeCampo}
        />
        {errNumero && (
          <p id={idErroreNumero} className={classeErrore}>
            {errNumero}
          </p>
        )}
      </div>

      <div className="min-w-0">
        <label htmlFor={idScadenza} className="mb-1 block font-maven text-xs text-kidville-sub">
          {etichetta('document_expiry')}
        </label>
        <input
          id={idScadenza}
          type="date"
          value={scadenza}
          min={PRIMO_GIORNO_AMMESSO}
          required
          onChange={(e) => setScadenza(e.target.value)}
          aria-invalid={errScadenza ? true : undefined}
          aria-describedby={errScadenza ? idErroreScadenza : undefined}
          className={classeCampo}
        />
        {errScadenza && (
          <p id={idErroreScadenza} className={classeErrore}>
            {errScadenza}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" aria-busy={inVolo || undefined} className={stili.primario}>
          {inVolo && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          {t('staffDocDatiSalva')}
        </button>
        <button type="button" onClick={() => onChiudi(null)} className={stili.secondario}>
          {t('annulla')}
        </button>
      </div>

      {/* L'ERRORE si annuncia da solo (`alert`): dopo un guasto il fuoco resta sul
          comando e senza `alert` il messaggio sarebbe muto. */}
      {errServer && (
        <p role="alert" className={`sm:col-span-2 ${classeErrore}`}>
          {errServer}
        </p>
      )}
      {nessunaModifica && (
        <p role="status" className="font-maven text-xs text-kidville-sub sm:col-span-2">
          {t('staffDocDatiNessunaModifica')}
        </p>
      )}
    </form>
  );
}
