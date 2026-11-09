import { NextResponse } from 'next/server'
import it from '../../../messages/it/shared.json'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { codiceDaMessaggio } from '@/lib/anno/tipi'

/**
 * `erroreAnno` — L'UNICO POSTO in cui i codici d'errore dei trigger dell'anno scolastico
 * (`ANNO_CHIUSO`, `SEZIONE_DI_ALTRO_ANNO`…) diventano risposte HTTP.
 *
 * Il database solleva l'eccezione con il codice come MESSAGGIO (`RAISE EXCEPTION 'ANNO_CHIUSO'`),
 * PostgREST la rende `{ code: 'P0001', message: 'ANNO_CHIUSO' }` (o col `code` della `ERRCODE`
 * scelta: `CALENDARIO_NON_CONTINUO` arriva come `23514`). Qui si legge il MESSAGGIO, non il
 * `code`: `P0001` è «qualunque eccezione di una funzione» e `23514` «qualunque CHECK».
 *
 * Restituisce `null` per ciò che non è dell'anno (un doppione, un permesso negato, un errore
 * sconosciuto): la route lo tratta come prima, con il suo `logErrore`. Un codice sconosciuto
 * non diventa MAI un 200.
 *
 * I codici sono LETTERALI in un `switch`, uno per uno: il lock `errori-con-codice` legge solo
 * ciò che trova scritto nel sorgente, e un `codice: variabile` lo renderebbe cieco. Ogni
 * codice è dichiarato in `CODICI_ERRORE` e tradotto nei due cataloghi.
 *
 * `error` è la prosa del catalogo ITALIANO (la stessa stringa che vede l'utente italiano,
 * come in `rifiutoSede`): rivolta alla segreteria, mai tecnica. Nessun dato della riga che
 * ha fatto scattare il trigger esce nella risposta o nel log (il `DETAIL` contiene uuid).
 *
 * Log: `ANNO_CHIUSO` e `PASSAGGIO_DA_FARE` sono un rifiuto atteso ma da vedere (una scrittura
 * su un anno protetto): `warn` con le sole chiavi `tipo`, `error_code`, `operazione`.
 * `GIORNO_SENZA_ANNO` è un guasto di configurazione (nessun anno copre il giorno): `logErrore`.
 */
const CATALOGO_IT = it as Record<string, string>

function frase(codice: keyof typeof CODICI_ERRORE): string {
  return CATALOGO_IT[CODICI_ERRORE[codice]]
}

/**
 * Il messaggio è il codice stesso. Dopo il codice si ammettono solo la fine del messaggio, uno spazio
 * o i due punti: `ANNO_CHIUSO_ALTRO`, `ANNO_CHIUSO-x` e `ANNO_CHIUSO.x` non sono codici.
 */
function codiceDa(error: { code?: string; message?: string } | null | undefined): string | null {
  return codiceDaMessaggio(error?.message)
}

function avvisaRifiuto(codice: string, operazione: string | undefined): void {
  // `error_code` e non `codice`: è la chiave in chiaro della lista bianca di `redact`, e il
  // logger la porta nella colonna `app_log.codice`. `codice` verrebbe redatta (può portare un CF).
  const campi: Record<string, string> = { tipo: 'anno-protetto', error_code: codice }
  if (operazione) campi.operazione = operazione
  logEvento('anno-scolastico', 'warn', campi)
}

/**
 * `dettagli` (opzionale): campi in più per il corpo della risposta, accanto a `error` e `codice`
 * (il motivo di `DATE_NON_VALIDE`, l'elenco di `PREREQUISITI_MANCANTI`, i conteggi di
 * `CONFINE_CON_RIGHE`). Li compone la route che ha letto il `DETAIL` (`impostazioni.ts`): qui non si
 * legge niente dal database. `error` e `codice` non si sovrascrivono mai.
 */
export function erroreAnno(
  error: { code?: string; message?: string } | null | undefined,
  operazione?: string,
  dettagli?: Record<string, unknown>,
): NextResponse | null {
  switch (codiceDa(error)) {
    case 'ANNO_CHIUSO':
      avvisaRifiuto('ANNO_CHIUSO', operazione)
      return NextResponse.json({ error: frase('ANNO_CHIUSO'), codice: 'ANNO_CHIUSO' }, { status: 409 })
    case 'PASSAGGIO_DA_FARE':
      avvisaRifiuto('PASSAGGIO_DA_FARE', operazione)
      return NextResponse.json(
        { error: frase('PASSAGGIO_DA_FARE'), codice: 'PASSAGGIO_DA_FARE' },
        { status: 409 },
      )
    case 'CONFINE_CON_RIGHE':
      // I conteggi per tabella (non le righe) li aggiunge `impostazioni.ts` in `dettagli`.
      return NextResponse.json(
        { ...dettagli, error: frase('CONFINE_CON_RIGHE'), codice: 'CONFINE_CON_RIGHE' },
        { status: 409 },
      )
    case 'SEZIONE_DI_ALTRO_ANNO':
      return NextResponse.json(
        { error: frase('SEZIONE_DI_ALTRO_ANNO'), codice: 'SEZIONE_DI_ALTRO_ANNO' },
        { status: 422 },
      )
    case 'SEZIONE_DI_ALTRA_SEDE':
      return NextResponse.json(
        { error: frase('SEZIONE_DI_ALTRA_SEDE'), codice: 'SEZIONE_DI_ALTRA_SEDE' },
        { status: 422 },
      )
    case 'ANNO_NON_COERENTE':
      return NextResponse.json(
        { error: frase('ANNO_NON_COERENTE'), codice: 'ANNO_NON_COERENTE' },
        { status: 422 },
      )
    case 'MODULO_NON_RICHIESTO':
      return NextResponse.json(
        { error: frase('MODULO_NON_RICHIESTO'), codice: 'MODULO_NON_RICHIESTO' },
        { status: 422 },
      )
    case 'CONFINE_NON_VALIDO':
      return NextResponse.json(
        { ...dettagli, error: frase('CONFINE_NON_VALIDO'), codice: 'CONFINE_NON_VALIDO' },
        { status: 422 },
      )
    case 'CALENDARIO_NON_CONTINUO':
      return NextResponse.json(
        { error: frase('CALENDARIO_NON_CONTINUO'), codice: 'CALENDARIO_NON_CONTINUO' },
        { status: 422 },
      )
    case 'ANNO_DA_SPECIFICARE':
      return NextResponse.json(
        { error: frase('ANNO_DA_SPECIFICARE'), codice: 'ANNO_DA_SPECIFICARE' },
        { status: 400 },
      )
    case 'ANNO_NON_DELLA_SEDE':
      return NextResponse.json(
        { error: frase('ANNO_NON_DELLA_SEDE'), codice: 'ANNO_NON_DELLA_SEDE' },
        { status: 400 },
      )
    case 'ANNO_NON_VISIBILE':
      // Un docente su un anno ancora in preparazione: lo logga chi decide (`resolveAnnoScrittura`).
      return NextResponse.json(
        { error: frase('ANNO_NON_VISIBILE'), codice: 'ANNO_NON_VISIBILE' },
        { status: 403 },
      )
    case 'ANNO_NON_ACCESSIBILE':
      // Cookie o anno dichiarato che la sede non ha (manomesso o stantio): lo logga `resolveAnnoLettura`.
      return NextResponse.json(
        { error: frase('ANNO_NON_ACCESSIBILE'), codice: 'ANNO_NON_ACCESSIBILE' },
        { status: 403 },
      )
    // ── Le impostazioni di sede (PR 4.2): le sollevano le funzioni di `anno_impostazioni_sede.sql`.
    case 'ANNO_NON_TROVATO':
      return NextResponse.json(
        { ...dettagli, error: frase('ANNO_NON_TROVATO'), codice: 'ANNO_NON_TROVATO' },
        { status: 404 },
      )
    case 'ANNO_IN_CHIUSURA':
      // L'ultimo giorno aperto di un anno in chiusura è passato: non si cambia più.
      return NextResponse.json(
        { ...dettagli, error: frase('ANNO_IN_CHIUSURA'), codice: 'ANNO_IN_CHIUSURA' },
        { status: 409 },
      )
    case 'DATE_NON_VALIDE':
      // Il motivo in codice (`fuori_periodo`, `ultimo_giorno_nel_passato`) arriva in `dettagli`.
      return NextResponse.json(
        { ...dettagli, error: frase('DATE_NON_VALIDE'), codice: 'DATE_NON_VALIDE' },
        { status: 422 },
      )
    case 'STATO_NON_AMMESSO':
      // La frase è quella del CRM («non è possibile nello stato attuale»): vale anche per un anno.
      return NextResponse.json(
        { ...dettagli, error: frase('STATO_NON_AMMESSO'), codice: 'STATO_NON_AMMESSO' },
        { status: 409 },
      )
    case 'PREREQUISITI_MANCANTI':
      // `dettagli.mancano`: l'elenco di ciò che manca, nell'ordine del database.
      return NextResponse.json(
        { ...dettagli, error: frase('PREREQUISITI_MANCANTI'), codice: 'PREREQUISITI_MANCANTI' },
        { status: 409 },
      )
    case 'PARAMETRO_MANCANTE':
      // Un valore NULL che la route avrebbe dovuto impedire (zod): qui è un errore di chi chiama.
      return NextResponse.json(
        { ...dettagli, error: frase('PARAMETRO_MANCANTE'), codice: 'PARAMETRO_MANCANTE' },
        { status: 400 },
      )
    // ── Preparare e aprire l'anno prossimo (PR 4.5): le sollevano le funzioni di M45c e M45d.
    case 'ANNO_NON_APERTO':
      // L'anno scelto non ha le iscrizioni aperte (né è quello in corso): non si registra niente.
      return NextResponse.json(
        { ...dettagli, error: frase('ANNO_NON_APERTO'), codice: 'ANNO_NON_APERTO' },
        { status: 409 },
      )
    case 'FREQUENZA_NON_VIVA':
      // La conferma parte da una frequenza che non è più viva (ritirato, già trasferito, anno chiuso).
      return NextResponse.json(
        { ...dettagli, error: frase('FREQUENZA_NON_VIVA'), codice: 'FREQUENZA_NON_VIVA' },
        { status: 409 },
      )
    case 'SEZIONE_OBBLIGATORIA':
      // Il bambino cambia grado (p_cambia_grado): senza continuazione la classe nuova va scelta.
      return NextResponse.json(
        { ...dettagli, error: frase('SEZIONE_OBBLIGATORIA'), codice: 'SEZIONE_OBBLIGATORIA' },
        { status: 422 },
      )
    case 'SEDE_DIVERSA':
      return NextResponse.json(
        { ...dettagli, error: frase('SEDE_DIVERSA'), codice: 'SEDE_DIVERSA' },
        { status: 422 },
      )
    case 'ANNO_NON_MODIFICABILE':
      return NextResponse.json(
        { ...dettagli, error: frase('ANNO_NON_MODIFICABILE'), codice: 'ANNO_NON_MODIFICABILE' },
        { status: 409 },
      )
    case 'ANNO_NON_OFFERTO':
      // L'anno non offre quel servizio o quella fascia (nessuna voce nel listino, nessun posto autorizzato).
      return NextResponse.json(
        { ...dettagli, error: frase('ANNO_NON_OFFERTO'), codice: 'ANNO_NON_OFFERTO' },
        { status: 422 },
      )
    case 'ISCRIZIONI_CHIUSE':
      return NextResponse.json(
        { ...dettagli, error: frase('ISCRIZIONI_CHIUSE'), codice: 'ISCRIZIONI_CHIUSE' },
        { status: 409 },
      )
    case 'IMPORTO_NON_VALIDO':
      return NextResponse.json(
        { ...dettagli, error: frase('IMPORTO_NON_VALIDO'), codice: 'IMPORTO_NON_VALIDO' },
        { status: 422 },
      )
    case 'MOTIVO_OBBLIGATORIO':
      // La correzione di un anno chiuso senza motivo. Il motivo è testo libero: non esce mai in un log.
      return NextResponse.json(
        { error: frase('MOTIVO_OBBLIGATORIO'), codice: 'MOTIVO_OBBLIGATORIO' },
        { status: 400 },
      )
    case 'GIORNO_SENZA_ANNO':
      // Nessun anno copre il giorno: non è un errore di chi scrive, è la configurazione della
      // sede. Il messaggio dell'eccezione è solo il codice: niente da redigere nel log.
      logErrore(
        { operazione: operazione ?? 'anno-scolastico', stato: 500 },
        new Error('GIORNO_SENZA_ANNO'),
      )
      return NextResponse.json(
        { error: frase('GIORNO_SENZA_ANNO'), codice: 'GIORNO_SENZA_ANNO' },
        { status: 500 },
      )
    default:
      return null
  }
}

/**
 * La risposta di una route a UN alunno quando, in fase B, la frequenza non è stata scritta (e quindi `alunni` non è stata
 * toccata): un codice dell'anno (`SEZIONE_DI_ALTRO_ANNO`, `ANNO_NON_COERENTE`…) → la risposta di `erroreAnno` (409/422);
 * il resto → 500 `FREQUENZA_NON_SCRITTA`. Il guasto è già nel log (`anno/fase-b:frequenza-non-scritta`): qui niente dati.
 */
export function rispostaFrequenzaNonScritta(codice: string, operazione?: string): NextResponse {
  if (codice === 'SCRITTURA_INCOMPLETA') return rispostaScritturaIncompleta()
  return (
    erroreAnno({ message: codice }, operazione) ??
    NextResponse.json({ error: frase('FREQUENZA_NON_SCRITTA'), codice: 'FREQUENZA_NON_SCRITTA' }, { status: 500 })
  )
}

/**
 * La risposta quando, in fase B, la frequenza è stata scritta e la scheda `alunni` no (`frequenzaGiaScritta` di
 * `scriviAlunnoEFrequenza`): 500 `SCRITTURA_INCOMPLETA`. Dice il vero — la frequenza è già aggiornata, la scheda no — e
 * invita a riprovare: se il guasto era passeggero il secondo tentativo completa il lavoro. (Il doppione del codice fiscale non arriva
 * qui: lo ferma un controllo prima della frequenza.) Il guasto è già nel log
 * (`anno/fase-b:alunni-non-scritto`): qui niente dati.
 */
export function rispostaScritturaIncompleta(): NextResponse {
  return NextResponse.json({ error: frase('SCRITTURA_INCOMPLETA'), codice: 'SCRITTURA_INCOMPLETA' }, { status: 500 })
}

/**
 * 409 quando il PATCH di una scheda porta un codice fiscale che un ALTRO alunno ha già (`alunni_codice_fiscale_key` è
 * UNIQUE su tutta la tabella). Si controlla PRIMA di scrivere la frequenza: senza, la retta passava in frequenza e
 * `alunni` falliva con 23505. La frase non nomina l'altro alunno né riporta il codice.
 */
export function rispostaCodiceFiscaleGiaUsato(): NextResponse {
  return NextResponse.json({ error: frase('CODICE_FISCALE_GIA_USATO'), codice: 'CODICE_FISCALE_GIA_USATO' }, { status: 409 })
}

/** 404 quando la frequenza nominata dall'URL non esiste (compito 4.5.10, la spunta dei moduli). Nessun dato nella risposta. */
export function rispostaFrequenzaNonTrovata(): NextResponse {
  return NextResponse.json({ error: frase('FREQUENZA_NON_TROVATA'), codice: 'FREQUENZA_NON_TROVATA' }, { status: 404 })
}

/** 409 su una scheda anonimizzata (diritto all'oblio): non si archivia e non riceve scritture. */
export function rispostaAlunnoAnonimizzato(): NextResponse {
  return NextResponse.json({ error: frase('ALUNNO_ANONIMIZZATO'), codice: 'ALUNNO_ANONIMIZZATO' }, { status: 409 })
}

/**
 * Codici che SOLO una migrazione o il riempimento sollevano: non arrivano mai a una route,
 * quindi `erroreAnno` non li traduce. Un codice nuovo nelle migrazioni dell'anno deve stare
 * in `erroreAnno` o qui: lo pretende `__tests__/lib/anno-errori.test.ts`.
 * A destra la migrazione da cui viene.
 */
export const CODICI_INTERNI = [
  'COPIA_ANNO_NON_VALIDA', // 20261107012110_anno_strumenti.sql
  'FASE_NON_VALIDA', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_A_CONTROLLI_RIGIDI', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_A_GUARDIA_ATTIVA', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_GALLERIA_SOPPRIMI', // 20261107012110_anno_strumenti.sql
  'RIEMPIMENTO_SENZA_SCHEMA_ANNO', // 20261107012110_anno_strumenti.sql
  'TABELLA_NON_NEL_RIEMPIMENTO', // 20261107012110_anno_strumenti.sql
  'ANNO_RIEMPIMENTO_INCOMPLETO', // 20261107023257_anno_vincoli_2.sql
  'OBLIO_NON_AMMESSO', // 20261107165503_anno_scrittura.sql (RPC dell'oblio: coppia fuori dall'allowlist; la 3.6 la tratta come errore di programma)
  'ANNI_TICK_OGGI_NON_AMMESSO', // 20261109035209_anno_tick.sql (`anni_tick` con un giorno di oggi per una sede che non è di prova né di simulazione: solo l'editor SQL, mai una route)
] as const
