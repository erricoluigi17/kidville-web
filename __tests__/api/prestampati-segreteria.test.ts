import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * I PRESTAMPATI DELLO SPORTELLO — quello che deve valere sulle due route, non sulla logica
 * pura (che ha già i suoi test in `__tests__/lib/prestampati-*.test.ts`).
 *
 * Le cose che questo file esiste per tenere ferme, e perché ciascuna:
 *
 *  1. **un bambino di un'altra sede non si stampa** — è la falla che questo repo ha già
 *     pagato una volta (audit multi-sede del 30/07): con tre sedi il gate applicativo è
 *     l'unico presidio, perché il client è service-role e la RLS non c'è;
 *  2. **la sede si dichiara** — chi ha tre plessi e non dice quale sta usando riceve 400,
 *     non un documento protocollato nel registro del plesso sbagliato;
 *  3. **uno slug inventato non entra in archivio** — `document_type` finisce dentro
 *     `student_documents` e dentro il nome del file nel bucket;
 *  4. **un bambino archiviato non produce certificati** — uscirebbe con l'anno scolastico
 *     in corso addosso a chi quest'anno non frequenta;
 *  5. **il percorso felice produce byte PDF davvero**, protocollo consumato UNA volta e
 *     riga nel fascicolo — non un 200 con un corpo vuoto;
 *  6. **l'enumerato che oggi rifiuta i prestampati non fa sparire il PDF dal bucket** — è
 *     lo scenario che in produzione gira a OGNI generazione (vedi il caso `22P02`), e
 *     senza questo test l'unico stato provato sarebbe quello che la produzione non può
 *     raggiungere;
 *  7. **un'insegnante non apre un nulla osta** — il secondo giro di `requireDocente` con
 *     l'elenco ristretto è una difesa scritta apposta, e una difesa senza test è una
 *     promessa;
 *  8. **i recapiti delle famiglie si leggono solo per il foglio delle emergenze** — sulle
 *     altre due stampe `student_parents` e `parents` non vengono interrogate affatto;
 *  9. **ogni estrazione lascia la sua riga in `fascicolo_accessi_audit`** — `view` sul
 *     precompilato, `upload` sul documento archiviato, una riga `list` per ciascun
 *     bambino di una stampa di sezione (§49 punto 2 della specifica);
 * 10. **il foglio della cucina non legge le note mediche** — i suoi assi sono tre, non due:
 *     `note_mediche` non è fra le sue sette colonne, e leggerla farebbe attraversare l'art. 9
 *     di venticinque bambini a un foglio che non la stampa da nessuna parte;
 * 11. **destinatario e mezzo del protocollo descrivono lo STESSO atto** — sono le due metà
 *     di una frase su una riga di registro WORM, e per un po' si contraddicevano;
 * 12. **un documento a termine porta la sua scadenza**, con qualunque campo il modello la
 *     dichiari: un permesso archiviato senza `expiry_date` è un'autorizzazione permanente;
 * 13. **la stampa di sezione filtra per SEDE su tutte e OTTO le tabelle** che tocca, e
 *     quelle che una colonna di sede non ce l'hanno si agganciano SOLO agli id usciti da
 *     quella query. È il presidio che il lock di isolamento non può dare a questo codice —
 *     vedi `restringimentiDi` qui sotto — ed è l'incidente che il repo ha già pagato il
 *     30/07. Le tabelle erano quattro fino al 14/08: le altre quattro (`sections`,
 *     `utenti_sezioni`/`utenti`, `scuole`, `schools`) sono quelle da cui escono la carta
 *     intestata e la colonna «Insegnanti», cioè un foglio che dichiara di venire da un
 *     plesso e porta i nomi di un altro;
 * 14. **il bucket condiviso del fascicolo non lo crea questa route**: crearlo coi PROPRI
 *     tipi MIME significherebbe decidere, per il fascicolo di tutta la scuola, che le
 *     scansioni non si possono più caricare;
 * 15. **un rifiuto sulla SEZIONE non parla di un bambino**: il pannello mostra la frase del
 *     codice, e un codice sbagliato manda la segreteria a cercare la persona sbagliata;
 * 16. **«si firma altrove» e «non si firma da nessuna parte» sono due frasi diverse**: due
 *     dei diciassette non stanno in nessun flusso di firma, e indicarne uno manda
 *     l'educatrice del verbale d'infortunio in una schermata che quel foglio non ce l'ha.
 *     E la differenza deve arrivare A SCHERMO: il pannello mostra la frase del CODICE e
 *     butta via `error`, quindi il motivo viaggia in un campo suo, enumerato, che il
 *     pannello traduce nella lingua in cui sta lavorando;
 * 17. **una lacuna di schema si rifiuta per la colonna che manca DAVVERO**: la query chiede
 *     le tre colonne sanitarie insieme a quella dell'oblio, e su un ambiente dove manca
 *     solo la seconda il foglio della cucina non si generava affatto — con una riga di log
 *     che accusava una colonna esistente;
 * 18. **la verifica del bucket del fascicolo non si paga sulle archiviazioni riuscite**:
 *     serve a spiegare un upload fallito, quindi gira dopo, non prima;
 * 19. **la configurazione di sede senza legale rappresentante viene ESEGUITA**, perché è
 *     l'unica che la produzione abbia: cinque dei sei fogli generabili si chiudono con
 *     quella firma, e il rifiuto deve dire «completala nelle impostazioni della sede» —
 *     non «manca la firma», che manda a cercare un genitore. E il pulsante si spegne
 *     prima, invece di portare a un 422;
 * 20. **il numero che il pannello annuncia è quello che finisce sul foglio**: la lettura
 *     porta iscritti e sospesi, la stampa esclude i sospesi, e un numero solo per due cose
 *     diverse è un conteggio sbagliato appeso al muro;
 * 21. **le due date dello stesso foglio vengono da una lettura sola dell'orologio**: la
 *     riga «Luogo e data» e il piede nascono a distanza di query, e a cavallo della
 *     mezzanotte due letture separate stampano due giorni diversi.
 *
 * ⚠️ Nomi, sedi e uuid sono INVENTATI: il repository è pubblico, e un id vero nel repo è un
 * id vero.
 */

// ─── I doppi ────────────────────────────────────────────────────────────────────

const auth = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  getRequestUserId: vi.fn(),
  resolveIdentity: vi.fn(),
  loadAppUser: vi.fn(),
  messaggioNegatoStaff: vi.fn(() => 'Accesso negato'),
}))
vi.mock('@/lib/auth/require-staff', () => auth)

const famiglia = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => famiglia)

const h = vi.hoisted(() => {
  const state = {
    /** Risposte per tabella: l'ultima si RIPETE, così una tabella letta due volte non svuota. */
    risposte: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    usate: {} as Record<string, number>,
    filtri: [] as { tabella: string; metodo: string; args: unknown[] }[],
    inserimenti: [] as { tabella: string; valori: Record<string, unknown> }[],
    rpc: [] as { nome: string; args: unknown }[],
    caricamenti: [] as { path: string; byte: number }[],
    rimossi: [] as string[],
    /** I percorsi di storage per cui è stato chiesto un download, nell'ordine. */
    scaricati: [] as string[],
    /** I file che il bucket ha davvero: `percorso → byte`. Ciò che non c'è non si scarica. */
    fileScaricabili: {} as Record<string, Uint8Array>,
    /**
     * Il registro FEA: `tipo_documento → impronte registrate`. È l'unica cosa che distingue
     * l'originale sottoscritto dalla famiglia da una trascrizione della segreteria o da una
     * scansione, perché `student_documents` una colonna che lo dica non ce l'ha.
     */
    firmeFea: {} as Record<string, string[]>,
    /**
     * I bucket che lo storage ha davvero. Non è un dettaglio del doppio: `sensitive_documents`
     * è CONDIVISO col fascicolo (`primaria/fascicolo`), e la domanda che questo elenco
     * permette di porre è «cosa fa questa route quando il bucket non c'è ancora?».
     */
    bucketEsistenti: ['protocollo', 'sensitive_documents'] as string[],
    /** Ogni `createBucket()` arrivato allo storage, con le sue opzioni: vedi il test dedicato. */
    bucketCreati: [] as { nome: string; opzioni: unknown }[],
    /**
     * Quante volte è stato chiesto l'ELENCO dei bucket. Serve a una domanda sola, e non è
     * di stile: quella chiamata esiste per spiegare un upload fallito, quindi su
     * un'archiviazione riuscita non deve partire affatto.
     */
    bucketElencati: 0,
    numeroProtocollo: 123 as number | null,
    erroreRpc: null as unknown,
    erroreUpload: null as { message: string } | null,
    erroreInsert: {} as Record<string, { message: string; code?: string } | undefined>,
  }

  function take(tabella: string) {
    const coda = state.risposte[tabella] ?? []
    const i = state.usate[tabella] ?? 0
    state.usate[tabella] = i + 1
    if (coda.length === 0) return { data: null, error: null }
    return coda[Math.min(i, coda.length - 1)]
  }

  /**
   * IL REGISTRO FEA, RISOLTO DAVVERO SUI FILTRI DELLA QUERY.
   *
   * È l'unica tabella che questo doppio non serve da una coda di risposte preconfezionate, e
   * la ragione è che senza il confronto vero il test non proverebbe niente: la domanda che
   * la route pone è «l'impronta di QUESTI byte è registrata per questo tipo?», e un doppio
   * che rispondesse «sì» a qualunque impronta lascerebbe passare esattamente il difetto che
   * questi test esistono per bloccare — la consegna di un foglio che nessuno ha firmato.
   *
   * `state.risposte['firme_documenti']`, se il test lo imposta, vince: serve ai casi in cui
   * il registro NON risponde (tabella assente, colonna assente), che sono un fatto diverso
   * dall'assenza della firma.
   */
  function registroFea(filtri: { metodo: string; args: unknown[] }[]) {
    if (state.risposte['firme_documenti']) return take('firme_documenti')
    const tipo = filtri.find((f) => f.metodo === 'eq' && f.args[0] === 'tipo_documento')?.args[1]
    const cercate = (filtri.find((f) => f.metodo === 'in' && f.args[0] === 'impronta_digitale')
      ?.args[1] ?? []) as string[]
    const registrate = state.firmeFea[String(tipo)] ?? []
    const trovata = cercate.some((i) => registrate.includes(i))
    return { data: trovata ? [{ id: 'firma-fea-1' }] : [], error: null }
  }

  function makeClient() {
    return {
      from(tabella: string) {
        const qb: Record<string, unknown> = {}
        /** I filtri di QUESTA query, che `registroFea` legge per rispondere sul serio. */
        const miei: { metodo: string; args: unknown[] }[] = []
        for (const m of ['select', 'eq', 'in', 'is', 'or', 'order', 'limit']) {
          qb[m] = (...args: unknown[]) => {
            state.filtri.push({ tabella, metodo: m, args })
            miei.push({ metodo: m, args })
            return qb
          }
        }
        qb.insert = (valori: Record<string, unknown>) => {
          state.inserimenti.push({ tabella, valori })
          const errore = state.erroreInsert[tabella]
          const esito = errore
            ? { data: null, error: errore }
            : { data: { id: `${tabella}-1` }, error: null }
          const ib: Record<string, unknown> = {}
          ib.select = () => ib
          ib.single = () => Promise.resolve(esito)
          ib.maybeSingle = () => Promise.resolve(esito)
          ib.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(esito).then(res, rej)
          return ib
        }
        /**
         * ⚠️ IL `.limit` SI APPLICA DAVVERO, e non è pignoleria: finché questo doppio lo
         * registrava soltanto, una finestra di query troppo stretta era **invisibile ai
         * test**. È esattamente com'è passato il difetto del tetto unico sulla copia
         * firmata — `.limit(5)` sulla QUERY, cioè cinque righe più recenti bastavano a
         * rendere irraggiungibile la copia firmata vera — con tutto verde.
         */
        const risolvi = () => {
          const esito = tabella === 'firme_documenti' ? registroFea(miei) : take(tabella)
          const limite = miei.find((f) => f.metodo === 'limit')?.args[0]
          if (typeof limite === 'number' && Array.isArray(esito.data)) {
            return { ...esito, data: (esito.data as unknown[]).slice(0, limite) }
          }
          return esito
        }
        qb.single = () => Promise.resolve(risolvi())
        qb.maybeSingle = () => Promise.resolve(risolvi())
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(risolvi()).then(res, rej)
        return qb
      },
      rpc(nome: string, args: unknown) {
        state.rpc.push({ nome, args })
        const esito =
          nome === 'prossimo_numero_protocollo'
            ? { data: state.numeroProtocollo, error: state.erroreRpc }
            : { data: null, error: null }
        return Promise.resolve(esito)
      },
      storage: {
        listBuckets: () => {
          state.bucketElencati += 1
          return Promise.resolve({ data: state.bucketEsistenti.map((name) => ({ name })), error: null })
        },
        createBucket: (nome: string, opzioni: unknown) => {
          state.bucketCreati.push({ nome, opzioni })
          state.bucketEsistenti.push(nome)
          return Promise.resolve({ data: null, error: null })
        },
        // Il bucket lo GUARDA, invece di ignorarlo: su un bucket che non esiste lo storage
        // vero risponde «Bucket not found», ed è l'unico modo in cui questo doppio può
        // mostrare cosa succede a un'archiviazione quando nessuno ha creato il contenitore.
        from: (bucket: string) => ({
          upload: (path: string, bytes: Uint8Array) => {
            if (!state.bucketEsistenti.includes(bucket)) {
              return Promise.resolve({ data: null, error: { message: `Bucket not found: ${bucket}` } })
            }
            state.caricamenti.push({ path, byte: bytes.byteLength })
            return Promise.resolve({ data: null, error: state.erroreUpload })
          },
          remove: (paths: string[]) => {
            state.rimossi.push(...paths)
            return Promise.resolve({ data: null, error: null })
          },
          /**
           * Il download della copia firmata dal fascicolo.
           *
           * `scaricati` registra i percorsi CHIESTI, non quelli trovati: serve a provare che
           * la route va a prendere il file che la riga di `student_documents` indica, e non
           * uno che si è costruita da sé.
           */
          download: (path: string) => {
            state.scaricati.push(path)
            const byte = state.fileScaricabili[path]
            if (!byte) {
              return Promise.resolve({ data: null, error: { message: `Object not found: ${path}` } })
            }
            return Promise.resolve({
              data: { arrayBuffer: async () => byte.buffer.slice(byte.byteOffset, byte.byteOffset + byte.byteLength) },
              error: null,
            })
          },
        }),
      },
    }
  }

  return { state, makeClient }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.makeClient()),
}))

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GET } from '@/app/api/prestampati/route'
import { POST } from '@/app/api/prestampati/genera/route'
import {
  aiutoDaStampare,
  blocchiModuloVuoto,
  caricaSezione,
  cartaDelContesto,
  CHIAVI_AIUTO_SU_CARTA,
  componiPrestampato,
  dicituraModuloSuCarta,
  letturaPerStampa,
  scadenzaDaRisposte,
} from '@/app/api/prestampati/banco'
import { prestampato } from '@/lib/prestampati/registro'
import { modelloGenitore } from '@/lib/prestampati/modelli/genitore'
import { estraiTesto } from '@/lib/protocolli/estrai'
// Solo per il CONTROLLO NEGATIVO del lock sulle istruzioni orfane: serve a spostare la
// quota di partenza di un foglio e provare che il criterio sa vedere un caso NUOVO. Il
// motore non si modifica in questo lavoro, si misura.
import { buildPrestampatoPdf } from '@/lib/prestampati/impaginazione'
import type { BloccoPrestampato } from '@/lib/prestampati/tipi'

// ─── Un mondo inventato ─────────────────────────────────────────────────────────

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SEDE_ALTRUI = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const SEZIONE = 'cccccccc-3333-4333-8333-cccccccccccc'
const ALUNNO = 'dddddddd-4444-4444-8444-dddddddddddd'
const UTENTE = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const GENITORE = 'ffffffff-6666-4666-8666-ffffffffffff'
const ALUNNO_DUE = '11111111-7777-4777-8777-111111111111'

/** I ruoli dell'app che il registro ammette al banco della segreteria, in quest'ordine. */
const BANCO_SEGRETERIA = ['admin', 'coordinator', 'segreteria']

/** Le righe di `fascicolo_accessi_audit` scritte dalla richiesta appena servita. */
function accessiTracciati(): { alunno_id: unknown; azione: unknown; documento_id: unknown }[] {
  return h.state.inserimenti
    .filter((i) => i.tabella === 'fascicolo_accessi_audit')
    .map((i) => i.valori as { alunno_id: unknown; azione: unknown; documento_id: unknown })
}

/** Le colonne chieste in `select` su una tabella, concatenate: serve a provare cosa NON si legge. */
function colonneChieste(tabella: string): string {
  return h.state.filtri
    .filter((f) => f.tabella === tabella && f.metodo === 'select')
    .map((f) => String(f.args[0] ?? ''))
    .join(' | ')
}

/**
 * I RESTRINGIMENTI applicati a una tabella: `eq` e `in`, cioè i due modi con cui una query
 * di questo repo si tiene dentro una sede.
 *
 * Non è un'utilità di comodo: è il sostituto del lock di isolamento fra sedi, che questo
 * codice NON copre. `__tests__/architecture/isolamento-sede-coverage.test.ts` raccoglie i
 * file chiamati `route.ts` (`routeFiles`) e lo dice di sé stesso — «legge il codice di un
 * file `route.ts`, non il grafo dei moduli» — mentre tutte le query delle due route dei
 * prestampati vivono in `src/app/api/prestampati/banco.ts`, che quel nome non ce l'ha. La
 * prova che la differenza è operativa e non teorica l'ha data la route gemella della
 * famiglia: la sua query su `delegates`, identica e lasciata dentro `route.ts`, ha fatto
 * diventare rosso quel lock; la stessa query in `banco.ts` non l'ha guardata nessuno.
 */
function restringimentiDi(tabella: string): { tabella: string; metodo: string; args: unknown[] }[] {
  return h.state.filtri.filter(
    (f) => f.tabella === tabella && (f.metodo === 'eq' || f.metodo === 'in'),
  )
}

const CONFIG_SEDE = {
  anagrafica: {
    denominazione: 'Scuola Inventata',
    codice_meccanografico: 'NA1A00000X',
    cap: '80000',
    provincia: 'NA',
    // Numero INVENTATO. Sta qui perché il n. 49 lo stampa in due punti che si leggono nel
    // momento peggiore: «contattare la segreteria: …» in fondo al foglio della cucina e
    // «Numeri utili: 118 · …» in fondo a quello delle emergenze.
    telefono: '0810000000',
    piva_cf: '00000000000',
    legale_rappresentante: 'Carla Inventata',
  },
}

/**
 * ⚠️ `mockReset()` PRIMA, e non è pignoleria: `vi.clearAllMocks()` del `beforeEach` azzera le
 * CHIAMATE registrate ma NON la coda dei `mockResolvedValueOnce`. Più di un test qui dentro
 * ne accoda due — il gate generico, poi quello ristretto del modello — e il giorno in cui il
 * codice smette di chiamare il gate una seconda volta quel valore resta in coda e lo
 * raccoglie il test SUCCESSIVO, che diventa rosso per colpa del suo vicino. È successo
 * misurandolo: un solo difetto reintrodotto faceva cadere due test, uno dei quali non
 * parlava di quel difetto. Un test deve fallire per la cosa che verifica.
 */
function comeSegreteria(sede = SEDE) {
  auth.requireDocente.mockReset()
  auth.requireDocente.mockResolvedValue({
    user: { id: UTENTE, role: 'segreteria', nome: 'Anna', cognome: 'Inventata', scuola_id: sede },
  })
}

/** Un admin con DUE sedi: è il caso in cui la sede va dichiarata, o è 400. */
function comeAdminDueSedi() {
  auth.requireDocente.mockResolvedValue({
    user: { id: UTENTE, role: 'admin', nome: 'Dario', cognome: 'Inventato', scuola_id: SEDE },
  })
  h.state.risposte['utenti_scuole'] = [
    { data: [{ scuola_id: SEDE }, { scuola_id: SEDE_ALTRUI }], error: null },
  ]
}

function alunnoIn(sede = SEDE, stato = 'iscritto', extra: Record<string, unknown> = {}) {
  h.state.risposte['alunni'] = [
    {
      data: {
        id: ALUNNO,
        nome: 'Luca',
        cognome: 'Inventato',
        data_nascita: '2021-03-04',
        birth_city: 'Napoli',
        birth_province: 'NA',
        codice_fiscale: 'NVNLCU21C04F839P',
        classe_sezione: 'Coccinelle',
        section_id: SEZIONE,
        scuola_id: sede,
        stato,
        anonimizzato_il: null,
        genitori_separati: false,
        ...extra,
      },
      error: null,
    },
  ]
}

function sedeInArchivio(config: unknown = CONFIG_SEDE) {
  h.state.risposte['scuole'] = [
    {
      data: { nome: 'Scuola Inventata', citta: 'Napoli', indirizzo: 'Via Finta 1', config },
      error: null,
    },
  ]
  h.state.risposte['schools'] = [{ data: { nome: 'Scuola Inventata' }, error: null }]
}

/**
 * La stessa configurazione di sede, ma **senza la chiave** `legale_rappresentante`.
 *
 * ⚠️ QUI STAVA SCRITTO CHE ERA «l'unica configurazione che la produzione ha davvero»,
 * misurato il 2026-08-14: `SELECT count(*) FROM scuole` → 4, righe con
 * `config->'anagrafica' ? 'legale_rappresentante'` → **0**. Non lo è più: dal 2026-08-15 il
 * campo esiste in Impostazioni → Sede & Intestazione e i valori veri sono stati scritti. Un
 * commento che dichiara un conteggio dice il falso il giorno dopo, e questo l'ha detto in
 * ventiquattr'ore — chi lo leggesse oggi crederebbe rotto un percorso che funziona.
 *
 * Il caso resta ed è quello di una sede NUOVA, che nasce senza quel campo: cinque dei fogli
 * che lo sportello produce si chiudono con quella firma, e il rifiuto deve dire «completala
 * nelle impostazioni della sede» invece di mandare a cercare un genitore.
 *
 * La chiave si TOGLIE invece di metterla a `null` o a stringa vuota: è così che è in
 * archivio, ed è l'unica forma che prova anche la lettura (`stringaDaAnagrafica`) oltre al
 * rifiuto.
 */
function senzaLegaleRappresentante(): unknown {
  const anagrafica: Record<string, unknown> = { ...CONFIG_SEDE.anagrafica }
  delete anagrafica.legale_rappresentante
  return { anagrafica }
}

/**
 * I bambini della sezione, come li restituisce la `select` su `alunni`.
 *
 * Le tre colonne sanitarie stanno nel doppio SEMPRE — è ciò che il DB restituirebbe se
 * venissero chieste — così il test può provare la cosa che conta: che la route non le
 * CHIEDA quando non le stampa. Un doppio che le omette proverebbe solo sé stesso.
 *
 * ⚠️ `allergeni` è un ARRAY, e la forma qui dentro è quella che il database ha davvero:
 * `text[] DEFAULT '{}'` nel baseline, `pg_typeof` → `text[]` in produzione. Il doppio lo
 * dichiarava `null` con l'allergia in `allergies`, cioè la sola forma in cui il difetto non
 * si vedeva: la riga letta con `testo()` tornava `null`, il bambino spariva dal foglio della
 * cucina e il PDF stampava «Nessun bambino della sezione ha allergie…».
 */
function alunniDiSezione(
  ...righe: {
    id: string
    cognome: string
    /** `iscritto` (il caso normale) o `sospeso`: la query legge tutti e due, la stampa no. */
    stato?: string
    note_mediche?: string | null
    allergeni?: string[] | null
    allergies?: string | null
  }[]
) {
  h.state.risposte['alunni'] = [
    {
      data: righe.map((r) => ({
        id: r.id,
        nome: 'Luca',
        cognome: r.cognome,
        data_nascita: '2021-03-04',
        classe_sezione: 'Coccinelle',
        stato: r.stato ?? 'iscritto',
        allergies: r.allergies === undefined ? 'arachidi' : r.allergies,
        allergeni: r.allergeni ?? [],
        note_mediche: r.note_mediche ?? null,
      })),
      error: null,
    },
  ]
}

function sezioneInArchivio(sede = SEDE) {
  h.state.risposte['sections'] = [
    { data: { id: SEZIONE, name: 'Coccinelle', school_type: 'infanzia', scuola_id: sede }, error: null },
  ]
}

function req(qs = '') {
  return new NextRequest(`http://localhost/api/prestampati${qs}`, { headers: { 'x-user-id': UTENTE } })
}

function reqGenera(corpo: unknown) {
  return new NextRequest('http://localhost/api/prestampati/genera', {
    method: 'POST',
    headers: { 'x-user-id': UTENTE, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

const RISPOSTE_NULLA_OSTA = {
  istituto: 'Istituto Comprensivo Inventato',
  sede_istituto: 'Napoli (NA)',
  decorrenza: '2026-09-01',
  regolarita_confermata: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.risposte = {}
  h.state.usate = {}
  h.state.filtri = []
  h.state.inserimenti = []
  h.state.rpc = []
  h.state.caricamenti = []
  h.state.rimossi = []
  h.state.scaricati = []
  h.state.fileScaricabili = {}
  h.state.firmeFea = {}
  h.state.bucketEsistenti = ['protocollo', 'sensitive_documents']
  h.state.bucketCreati = []
  h.state.bucketElencati = 0
  h.state.numeroProtocollo = 123
  h.state.erroreRpc = null
  h.state.erroreUpload = null
  h.state.erroreInsert = {}
  famiglia.requireParentOfStudent.mockResolvedValue({
    user: { id: UTENTE, role: 'segreteria', scuola_id: SEDE },
  })
  comeSegreteria()
  sedeInArchivio()
  sezioneInArchivio()
})

// ─── GET ────────────────────────────────────────────────────────────────────────

describe('GET /api/prestampati — elenco e precompilato', () => {
  it('senza identità è 401, e non tocca il database', async () => {
    const { NextResponse } = await import('next/server')
    auth.requireDocente.mockResolvedValue({
      response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }),
    })

    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.state.filtri).toEqual([])
  })

  it("l'elenco dice anche quali NON si generano allo sportello, e perché", async () => {
    const res = await GET(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    const per = (slug: string) =>
      json.data.modelli.find((m: { slug: string }) => m.slug === slug)

    // La segreteria vede anche ciò che è dichiarato del genitore (regola di lettura del
    // registro), e da qui quel modulo NASCE: in una delle tre modalità, due delle quali non
    // dichiarano nessuna firma elettronica.
    expect(per('scheda_sanitaria')).toMatchObject({
      generabile: true,
      modalita: ['copia_firmata', 'copia_vuota', 'su_carta'],
    })
    // I due certificati stanno nello stesso banco ma li firma il legale rappresentante:
    // nascono già oggi allo sportello, e di modalità non ne hanno.
    expect(per('certificato_iscrizione_frequenza')).toMatchObject({ generabile: true })
    expect(per('certificato_iscrizione_frequenza').modalita).toBeUndefined()
    // Tre aspettano una fonte dati che non esiste ancora: il pulsante resta spento.
    expect(per('sollecito_pagamento')).toMatchObject({
      generabile: false,
      motivo: 'fonte_dati_assente',
    })
    // E questi due si generano davvero.
    expect(per('nulla_osta')).toMatchObject({ generabile: true, protocollo: 'uscita' })
    expect(per('stampe_sezione')).toMatchObject({ generabile: true, soggetto: 'sezione' })
  })

  it('«si firma qui, in una delle tre modalità» e «non si firma da nessuna parte» restano due cose diverse', async () => {
    // 🔴 Il motivo era uno solo e diceva a tutti «si genera dal flusso di firma della
    // famiglia»: falso per due dei diciassette. Il banco della famiglia si costruisce con
    // `prestampatiPerRuolo('genitore')`, che non contiene né il verbale di infortunio né il
    // documento di valutazione — quindi l'educatrice che apriva il pannello per il verbale
    // di un infortunio leggeva un'indicazione che la mandava in un flusso incapace di
    // produrlo, e nessuna strada nel prodotto lo produceva.
    //
    // Dal 2026-08-16 il primo dei due motivi è sparito del tutto: la delega al ritiro nasce
    // allo sportello. Il secondo resta, e su questi due soli — e resta VERO, che è la
    // ragione per cui il test si guarda ancora.
    const res = await GET(req())
    const json = await res.json()
    const per = (slug: string) => json.data.modelli.find((m: { slug: string }) => m.slug === slug)

    expect(per('delega_ritiro')).toMatchObject({ generabile: true })
    expect(per('verbale_infortunio')).toMatchObject({ generabile: false, motivo: 'firma_senza_flusso' })
    expect(per('valutazione_infanzia')).toMatchObject({ generabile: false, motivo: 'firma_senza_flusso' })
    // E i due che restano spenti non offrono modalità: offrirle vorrebbe dire un pulsante
    // che porta a un rifiuto, perché `componiPrestampato` non sa comporli.
    expect(per('verbale_infortunio').modalita).toBeUndefined()
    expect(per('valutazione_infanzia').modalita).toBeUndefined()
  })

  it('nessun modulo di famiglia resta nella lista dei non generabili', async () => {
    // È la misura del guasto che questo lavoro chiude: `elencoPerRuolo('segreteria')`
    // mostrava diciassette modelli e ne generava UNO, e sei dei sedici spenti cadevano per
    // una firma elettronica che lo sportello non poteva dichiarare. Il rimedio non è
    // dichiararla lo stesso: è ammettere che di fogli ce ne sono tre, e che due non la
    // dichiarano affatto.
    const res = await GET(req())
    const json = await res.json()
    const modelli = json.data.modelli as { slug: string; generabile: boolean; motivo?: string }[]

    const SEI = [
      'scheda_sanitaria',
      'autorizzazione_farmaci',
      'dieta_speciale',
      'delega_ritiro',
      'permesso_orario',
      'autorizzazione_uscita',
    ]
    for (const slug of SEI) {
      const voce = modelli.find((m) => m.slug === slug)
      expect(voce, slug).toMatchObject({ generabile: true })
      expect(voce?.motivo, slug).toBeUndefined()
    }
    // E il motivo non esiste più su NESSUNO dei diciassette: se ricomparisse, sarebbe
    // ricomparso anche il rifiuto.
    expect(modelli.map((m) => m.motivo)).not.toContain('firma_da_raccogliere')
  })

  it('il verbale di infortunio non rimanda a un flusso che non lo contiene', async () => {
    alunnoIn()

    const res = await GET(req(`?modello=verbale_infortunio&alunnoId=${ALUNNO}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.modello.generabile).toBe(false)
    // ⚠️ `motivo` PRIMA DI `spiegazione`, ed è l'ordine che conta su un'app bilingue:
    // l'enumerato è ciò che il pannello traduce con il catalogo della lingua in cui sta
    // lavorando, la `spiegazione` è la prosa del SERVER — che nasce dove il locale non
    // esiste, ed è quindi italiana per costruzione. Mostrare la seconda a un'interfaccia
    // inglese è il difetto che i codici d'errore hanno chiuso una volta (collaudo del 31/07).
    expect(json.data.motivo).toBe('firma_senza_flusso')
    // E la frase di ripiego non deve comunque nominare una schermata che quel foglio non
    // ce l'ha.
    expect(json.data.spiegazione).not.toContain('flusso di firma della famiglia')
    // E l'anagrafica del bambino non si apre per un foglio che non nasce: ciò che non si
    // legge non si può perdere.
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
    expect(accessiTracciati()).toEqual([])
  })

  it('un ruolo senza banco che chiede UN modello riceve un diniego, non un elenco vuoto', async () => {
    const { NextResponse } = await import('next/server')
    alunnoIn()
    // La cuoca non ha un banco (`ruoloRichiedente` → `null`): il registro non la nomina in
    // nessuno dei diciassette. Oggi `requireDocente` non la ammetterebbe comunque — il
    // primo giro è forzato apposta — ma il ramo esisteva per il giorno in cui un ruolo nuovo
    // entra da quella porta.
    auth.requireDocente
      .mockResolvedValueOnce({
        user: { id: UTENTE, role: 'cuoca', nome: 'Carla', cognome: 'Inventata', scuola_id: SEDE },
      })
      .mockResolvedValueOnce({
        response: NextResponse.json({ error: 'Accesso negato', codice: 'RUOLO_NON_ABILITATO' }, { status: 403 }),
      })

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))

    // 🔴 Prima erano `200 {"success":true,"data":{"modelli":[]}}` — cioè un sì con una lista
    // vuota a una domanda a cui la risposta è no. Nessun dato usciva, ma «non ti è
    // permesso» e «ecco, non c'è niente» mandano chi legge in due direzioni diverse.
    expect(res.status).toBe(403)
    expect(auth.requireDocente).toHaveBeenLastCalledWith(expect.anything(), BANCO_SEGRETERIA)
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it("lo stesso ruolo, alla domanda «cosa posso generare?», riceve l'elenco vuoto", async () => {
    // L'altra metà della regola: l'elenco vuoto è la risposta GIUSTA a questa domanda, e
    // resta. Il difetto era rispondere così anche all'altra.
    auth.requireDocente.mockResolvedValue({
      user: { id: UTENTE, role: 'cuoca', nome: 'Carla', cognome: 'Inventata', scuola_id: SEDE },
    })

    const res = await GET(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.modelli).toEqual([])
  })

  it('uno slug che non è fra i diciassette è 400, non un 500 e non un documento', async () => {
    const res = await GET(req('?modello=modulo_inventato&alunnoId=' + ALUNNO))
    expect(res.status).toBe(400)
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it('il modello che vuole un bambino e non lo riceve è 400, col campo indicato', async () => {
    const res = await GET(req('?modello=nulla_osta'))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.details.map((d: { path: string }) => d.path)).toContain('alunnoId')
  })

  it("un bambino di un'altra sede è 403, non 200 con i suoi dati", async () => {
    alunnoIn(SEDE_ALTRUI)

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(JSON.stringify(json)).not.toContain('Inventato')
  })

  it('sul modello buono restituisce il precompilato e i campi ancora da chiedere', async () => {
    alunnoIn()

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.prefill.dati.alunno.cognome).toBe('Inventato')
    expect(json.data.prefill.legaleRappresentante).toBe('Carla Inventata')
    // I campi che il form deve chiedere: quelli del modello, non quelli già noti.
    const campi = json.data.modello.campi.map((c: { nome: string }) => c.nome)
    expect(campi).toContain('istituto')
    expect(campi).not.toContain('cognome')

    // L'anagrafica di un bambino è stata letta, e resta scritto: `app_log` non è il
    // registro degli accessi al fascicolo (regola 5 di `docs/prestampati/README.md`).
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'view' }),
    ])
  })

  it("nemmeno il PRECOMPILATO di un nulla osta si apre da un'insegnante", async () => {
    const { NextResponse } = await import('next/server')
    alunnoIn()
    auth.requireDocente
      .mockResolvedValueOnce({
        user: { id: UTENTE, role: 'educator', nome: 'Maria', cognome: 'Inventata', scuola_id: SEDE },
      })
      .mockResolvedValueOnce({
        response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
      })

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))

    expect(res.status).toBe(403)
    expect(auth.requireDocente).toHaveBeenLastCalledWith(expect.anything(), BANCO_SEGRETERIA)
    // Il precompilato è la parte che LEGGE: il rifiuto arriva prima di aprire l'anagrafica.
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it("un bambino di un'altra sede non lascia nemmeno una riga nel registro degli accessi", async () => {
    alunnoIn(SEDE_ALTRUI)

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))

    expect(res.status).toBe(403)
    // Si registra un accesso AVVENUTO: una riga sopra un 403 racconterebbe una lettura
    // che non c'è stata, e il registro serve proprio a distinguere le due cose.
    expect(accessiTracciati()).toEqual([])
  })

  it('di una sezione torna il CONTEGGIO dei bambini, senza nemmeno leggere le loro diete', async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })

    const res = await GET(req(`?modello=stampe_sezione&sezioneId=${SEZIONE}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.prefill.alunni).toEqual({ iscritti: 1, sospesi: 0 })
    // L'allergia di un minore non esce da una rotta che serve a disegnare un form.
    expect(JSON.stringify(json)).not.toContain('arachidi')
    // E soprattutto non è stata nemmeno CHIESTA: per rispondere «1» non serve l'art. 9 di
    // venticinque bambini. Ciò che non si legge non si può perdere.
    expect(colonneChieste('alunni')).not.toContain('note_mediche')
    expect(colonneChieste('alunni')).not.toContain('allergies')
    // Un conteggio non è l'accesso al fascicolo di nessuno: le righe `list` le scrive la
    // generazione, dove i nomi escono davvero.
    expect(accessiTracciati()).toEqual([])
  })

  it('il conteggio annunciato è quello che finisce sul foglio: iscritti e sospesi separati', async () => {
    // 🔴 IL NUMERO DEL PANNELLO NON ERA QUELLO DELLA STAMPA. `caricaSezione` legge gli
    // iscritti E i sospesi — lo dichiara, «mai i ritirati» — mentre il modello esclude i
    // sospesi salvo richiesta esplicita (`includi_sospesi`, che nasce `false`). Con un
    // numero solo, su una sezione con due sospesi il pannello annunciava 25 e il foglio ne
    // stampava 23: due numeri che si contraddicono, di cui uno appeso al muro.
    alunniDiSezione(
      { id: ALUNNO, cognome: 'Inventato' },
      { id: ALUNNO_DUE, cognome: 'Sospesa', stato: 'sospeso' },
    )

    const res = await GET(req(`?modello=stampe_sezione&sezioneId=${SEZIONE}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    // Due numeri: il pannello ha così di che scrivere «1 iscritto, 1 sospeso (escluso salvo
    // richiesta)», che è la frase vera.
    expect(json.data.prefill.alunni).toEqual({ iscritti: 1, sospesi: 1 })

    // E la stampa lo conferma: senza `includi_sospesi` sul foglio ce n'è uno solo. È la
    // metà che rende l'asserzione qui sopra una misura e non una convenzione — se domani il
    // modello cambiasse criterio, i due numeri tornerebbero a divergere e questo test lo
    // direbbe.
    const stampa = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await stampa.arrayBuffer()))

    expect(stampa.status).toBe(201)
    expect(testo).toContain('Totale iscritti: 1')
    expect(testo).toContain('Inventato')
    expect(testo).not.toContain('Sospesa')
  })

  it("senza il legale rappresentante in configurazione il pulsante NON si accende", async () => {
    // 🔴 È lo stato che la produzione ha davvero (vedi `senzaLegaleRappresentante`), e il
    // pannello mostrava `generabile: true` su tutti e cinque i fogli che quella firma la
    // pretendono: un pulsante che porta a un rifiuto, che è il difetto che questo stesso
    // codice dichiara di non voler avere («un pulsante che porta a un 422 è peggio di un
    // pulsante spento», `banco.ts`).
    //
    // Il motivo si scopre solo QUI e non nell'elenco: sta nella configurazione della SEDE,
    // e la sede si sa quando si sa di quale bambino si parla.
    sedeInArchivio(senzaLegaleRappresentante())
    alunnoIn()

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.modello).toMatchObject({
      generabile: false,
      motivo: 'legale_rappresentante_assente',
    })
    expect(json.data.motivo).toBe('legale_rappresentante_assente')
    // La frase di ripiego dice DOVE si ripara, e non nomina la firma di un genitore: il
    // rimedio sono due minuti nelle impostazioni della sede. Dal 2026-08-15 nomina la
    // schermata per intero — prima diceva «nelle impostazioni della sede» e mandava in
    // un posto che non esisteva, perché quel campo non stava in nessun form.
    expect(json.data.spiegazione).toContain('Impostazioni → Sede & Intestazione')
    expect(json.data.spiegazione).not.toContain('firma elettronica del genitore')
    // Il precompilato resta: l'anagrafica è già stata letta — è il solo modo di scoprire
    // questo motivo — e nasconderla dopo non la rimette dov'era. Ciò che si spegne è il
    // pulsante, non il form.
    expect(json.data.prefill.alunnoId).toBe(ALUNNO)
    expect(json.data.prefill.legaleRappresentante).toBeNull()

    // E vale per TUTTI E CINQUE i fogli che quella firma la pretendono, non solo per il
    // nulla osta: due di loro arrivano dall'altro file dei modelli (i certificati della
    // famiglia, che allo sportello la segreteria genera per la regola di lettura
    // asimmetrica del registro), e un rimedio che ne coprisse solo tre lascerebbe accesi
    // proprio i due che vanno all'INPS.
    for (const slug of [
      'richiesta_disponibilita',
      'certificato_competenze',
      'certificato_iscrizione_frequenza',
      'certificato_bonus_nido',
    ]) {
      const altro = await GET(req(`?modello=${slug}&alunnoId=${ALUNNO}`))
      const jsonAltro = await altro.json()
      expect(altro.status, slug).toBe(200)
      expect(jsonAltro.data.modello, slug).toMatchObject({
        generabile: false,
        motivo: 'legale_rappresentante_assente',
      })
    }
  })

  it('con il legale rappresentante configurato lo stesso modello resta generabile', async () => {
    // L'altra metà: il motivo nuovo non deve spegnere niente dove il dato c'è. Senza questo,
    // un ripiego troppo largo — «in mancanza di informazioni, spegni» — passerebbe inosservato.
    alunnoIn()

    const res = await GET(req(`?modello=nulla_osta&alunnoId=${ALUNNO}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data.modello.generabile).toBe(true)
    expect(json.data.modello.motivo).toBeUndefined()
    expect(json.data.motivo).toBeUndefined()
  })

  it('un rifiuto sulla SEZIONE non manda a cercare un bambino', async () => {
    // 🔴 Il pannello mostra la frase del CODICE, non il campo `error` — è il principio che
    // `banco.ts` argomenta per esteso due volte — e questi due rifiuti rispondevano insieme
    // `ALUNNO_NON_APRIBILE`, la cui frase tradotta è «Questo bambino non è più nell'elenco di
    // questa postazione». Chi sta allo sportello leggeva una frase su un bambino mentre il
    // problema era la sezione.
    //
    // Le due letture di `sections` sono DUE (`assertSezioneInScope`, poi `caricaSezione`), e
    // la coda del doppio permette di rispondere diversamente alla seconda: è l'unico modo di
    // arrivare a questi due rami, perché il gate davanti li coprirebbe entrambi.
    const RIGA_BUONA = { id: SEZIONE, name: 'Coccinelle', school_type: 'infanzia', scuola_id: SEDE }

    // a. la riga è sparita fra le due letture: transitorio, «riprova» è l'istruzione giusta
    //    — il secondo tentativo incontra il 404 del gate.
    h.state.risposte['sections'] = [
      { data: RIGA_BUONA, error: null },
      { data: null, error: null },
    ]
    const sparita = await GET(req(`?modello=stampe_sezione&sezioneId=${SEZIONE}`))
    const jsonSparita = await sparita.json()
    expect(sparita.status).toBe(503)
    expect(jsonSparita.codice).toBe('PRESTAMPATI_ELENCO_NON_LETTO')
    expect(jsonSparita.codice).not.toBe('ALUNNO_NON_APRIBILE')

    // b. la sezione c'è ma non dice a quale plesso appartiene: non si aggiusta aspettando —
    //    la carta intestata si compone dalla sede — e il rimedio è completare l'anagrafica.
    h.state.usate = {}
    h.state.risposte['sections'] = [
      { data: RIGA_BUONA, error: null },
      { data: { ...RIGA_BUONA, scuola_id: null }, error: null },
    ]
    const senzaSede = await GET(req(`?modello=stampe_sezione&sezioneId=${SEZIONE}`))
    const jsonSenzaSede = await senzaSede.json()
    expect(senzaSede.status).toBe(422)
    expect(jsonSenzaSede.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect(jsonSenzaSede.codice).not.toBe('ALUNNO_NON_APRIBILE')
  })

  it('una sezione fuori dalla sede SELEZIONATA è 403, e i suoi bambini non si leggono', async () => {
    // Il plesso è fra i suoi — `assertSezioneInScope` la lascerebbe passare — ma nel
    // SedeSelector l'admin ha davanti l'altra sede. È lo stesso secondo strato che il ramo
    // dell'alunno ha sempre avuto (`resolveScuoleAttive`): senza, le due strade
    // rispondevano diversamente alla stessa domanda.
    comeAdminDueSedi()
    sezioneInArchivio(SEDE)
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })

    const res = await GET(
      new NextRequest(`http://localhost/api/prestampati?modello=stampe_sezione&sezioneId=${SEZIONE}`, {
        headers: { 'x-user-id': UTENTE, cookie: `sedi_attive=${SEDE_ALTRUI}` },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.codice).toBe('SEDE_NON_ACCESSIBILE')
    // Il rifiuto arriva PRIMA dell'elenco: nessuna riga di quei bambini è stata letta.
    expect(colonneChieste('alunni')).toBe('')
  })
})

// ─── POST ───────────────────────────────────────────────────────────────────────

describe('POST /api/prestampati/genera — i rifiuti', () => {
  it('senza identità è 401', async () => {
    const { NextResponse } = await import('next/server')
    auth.requireDocente.mockResolvedValue({
      response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }),
    })

    const res = await POST(reqGenera({ modello: 'nulla_osta', alunnoId: ALUNNO, risposte: {} }))
    expect(res.status).toBe(401)
    expect(h.state.inserimenti).toEqual([])
  })

  it('uno slug sconosciuto è 400 e non consuma numerazione', async () => {
    const res = await POST(
      reqGenera({ modello: 'certificato_inventato', alunnoId: ALUNNO, risposte: {} }),
    )
    expect(res.status).toBe(400)
    expect(h.state.rpc).toEqual([])
    expect(h.state.inserimenti).toEqual([])
  })

  it('con due sedi e nessuna dichiarata è 400: la sede si dichiara, non si indovina', async () => {
    comeAdminDueSedi()
    alunnoIn()

    const res = await POST(
      reqGenera({ modello: 'nulla_osta', alunnoId: ALUNNO, risposte: RISPOSTE_NULLA_OSTA }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.state.rpc).toEqual([])
  })

  it("la sede dichiarata dev'essere quella del bambino, o è 403", async () => {
    comeAdminDueSedi()
    alunnoIn(SEDE_ALTRUI)

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.state.rpc).toEqual([])
  })

  it('un bambino archiviato non produce certificati: 409, e niente numerazione', async () => {
    alunnoIn(SEDE, 'ritirato')

    const res = await POST(
      reqGenera({ modello: 'nulla_osta', alunnoId: ALUNNO, risposte: RISPOSTE_NULLA_OSTA }),
    )
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.codice).toBe('PRESTAMPATO_ALUNNO_NON_ISCRITTO')
    expect(h.state.rpc).toEqual([])
    expect(h.state.inserimenti).toEqual([])
  })

  it('un modulo di famiglia SENZA modalità è un 400 sul campo, e non legge l anagrafica', async () => {
    // 🔴 IL RIFIUTO ERA UN ALTRO, e la differenza è tutto questo lavoro: fino al 2026-08-16
    // la delega al ritiro rispondeva 409 «si genera dal flusso di firma della famiglia»,
    // cioè non nasceva affatto. Ora nasce, ma la modalità si DICHIARA: fra «la copia che il
    // genitore ha firmato» e «un modulo vuoto da firmare a penna» non c'è un valore
    // predefinito ragionevole, e sceglierne uno al posto di chi sta allo sportello
    // metterebbe nel fascicolo di un minore un foglio che dice un'altra cosa.
    alunnoIn()

    const res = await POST(
      reqGenera({ modello: 'delega_ritiro', alunnoId: ALUNNO, risposte: {} }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.details?.map((d: { path?: string }) => d.path)).toContain('modalita')
    // Il rifiuto arriva PRIMA della lettura: nessun dato del bambino è stato toccato.
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it('un modello senza modalità che ne riceve una è un 400: non si ignora in silenzio', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        modalita: 'copia_vuota',
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.details?.map((d: { path?: string }) => d.path)).toContain('modalita')
    // E nessun numero di protocollo è stato bruciato per una richiesta malformata.
    expect(h.state.rpc).toEqual([])
  })

  it('«non si firma da nessuna parte» resta un rifiuto suo, col suo motivo', async () => {
    // 🔴 LA DISTINZIONE NON ARRIVAVA A SCHERMO. `messaggioDaCorpo` mostra il testo di
    // CATALOGO del `codice` e butta via `error` (tranne per i codici dichiarati in
    // `CODICI_CON_DETTAGLIO`, che oggi è il solo `CLASSI_FUORI_SEDE`): con un codice solo
    // sui due motivi, il pannello mostrava a tutti e due «La firma non risulta raccolta o
    // non è valida…». L'educatrice del verbale d'infortunio leggeva la stessa frase della
    // delega al ritiro — che invece una schermata di firma ce l'ha.
    //
    // Dei due motivi ne è rimasto uno: la delega al ritiro ora nasce allo sportello. Il
    // verbale di infortunio no, e il suo rifiuto deve continuare a dirlo con il proprio
    // motivo enumerato — non con la frase generica del codice.
    alunnoIn()

    const daNessunaParte = await POST(
      reqGenera({ modello: 'verbale_infortunio', alunnoId: ALUNNO, risposte: {} }),
    )
    const jsonDaNessunaParte = await daNessunaParte.json()
    expect(daNessunaParte.status).toBe(409)
    expect(jsonDaNessunaParte).toMatchObject({
      codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
      motivo: 'firma_senza_flusso',
    })
    // Il rifiuto arriva PRIMA della lettura: nessun dato del bambino è stato toccato.
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it('anche il rifiuto dei tre senza fonte dati porta il suo motivo', async () => {
    // `PRESTAMPATO_DATI_MANCANTI` è un codice largo — lo usano anche la sezione senza sede
    // e le colonne sanitarie assenti — e la sua frase di catalogo dice «completali in
    // anagrafica e riprova»: per il sollecito di pagamento, la cui fonte dati non esiste
    // affatto, è un'istruzione impossibile da eseguire.
    alunnoIn()

    const res = await POST(
      reqGenera({ modello: 'sollecito_pagamento', alunnoId: ALUNNO, risposte: {} }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json).toMatchObject({
      codice: 'PRESTAMPATO_DATI_MANCANTI',
      motivo: 'fonte_dati_assente',
    })
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it('senza il legale rappresentante in configurazione è 422 col suo motivo, non un 409 sulla firma', async () => {
    // 🔴 IL RAMO CHE IN PRODUZIONE SCATTA IL 100% DELLE VOLTE, e non aveva nessun test.
    // Misurato in sola lettura il 2026-08-14: `SELECT count(*) FROM scuole` → 4, righe con
    // `config->'anagrafica' ? 'legale_rappresentante'` → 0. Cinque dei sei fogli generabili
    // si chiudono con quella firma, quindi ogni nulla osta e ogni certificato emesso dallo
    // sportello finiva in `componiFirma` (`render.ts`), che rifiuta con
    // `PRESTAMPATO_FIRMA_NON_VALIDA` — la cui frase di catalogo è «La firma non risulta
    // raccolta o non è valida: il documento non si genera prima della firma»
    // (`messages/it/shared.json`). La segreteria andava a cercare la firma di un GENITORE
    // mentre mancava un campo nelle impostazioni della sede.
    sedeInArchivio(senzaLegaleRappresentante())
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const json = await res.json()

    // 422 e non 409, e il codice è quello la cui frase dice «completali in anagrafica e
    // riprova»: l'unica istruzione eseguibile delle due.
    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect(json.codice).not.toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    // Il motivo enumerato è ciò che il pannello traduce nella lingua in cui sta lavorando:
    // `error` è la prosa del server, ed è il ripiego, non il canale principale.
    expect(json.motivo).toBe('legale_rappresentante_assente')
    expect(json.error).toContain('Impostazioni → Sede & Intestazione')

    // E nessun numero di protocollo consumato, nessuna riga di registro. ⚠️ Questa parte
    // NON è ciò che il rifiuto ha riparato — misurato togliendo il ramo: la risposta
    // diventava 409, e la numerazione restava intatta lo stesso, perché la prova a vuoto di
    // `protocollaEComponi` compone prima di chiedere il numero. Resta come lock: su un
    // registro WORM i buchi non si richiudono, e questo ramo scatta a ogni clic.
    expect(h.state.rpc).toEqual([])
    expect(h.state.inserimenti.map((i) => i.tabella)).not.toContain('protocolli')
    expect(h.state.inserimenti.map((i) => i.tabella)).not.toContain('student_documents')
    expect(h.state.caricamenti).toEqual([])

    // L'anagrafica del bambino è stata letta per arrivare fin qui — la configurazione di
    // sede si legge con lei — e la riga del registro degli accessi resta: è la stessa
    // distinzione fra «letto» e «uscito» che vale sul 400 di un campo sbagliato.
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'view' }),
    ])
  })

  it('la stampa di sezione non la ferma il legale rappresentante mancante: quel foglio non si firma', async () => {
    // Il contorno del test qui sopra. `stampe_sezione` ha `firma: 'nessuna'` e il motivo
    // nuovo non lo riguarda: un rifiuto che guardasse solo la configurazione di sede — e non
    // anche il blocco di firma del modello — spegnerebbe l'unico foglio che oggi le
    // insegnanti stampano davvero, in tutte e tre le sedi.
    sedeInArchivio(senzaLegaleRappresentante())
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it("un'insegnante non apre un nulla osta: il diniego lo emette il gate con l'elenco ristretto", async () => {
    const { NextResponse } = await import('next/server')
    alunnoIn()
    // Primo giro: il gate generico dei quattro ruoli, che un'insegnante supera. Secondo
    // giro: lo stesso gate con i ruoli che il MODELLO dichiara, che non la ammette.
    auth.requireDocente
      .mockResolvedValueOnce({
        user: { id: UTENTE, role: 'educator', nome: 'Maria', cognome: 'Inventata', scuola_id: SEDE },
      })
      .mockResolvedValueOnce({
        response: NextResponse.json(
          { error: 'Accesso negato', codice: 'RUOLO_NON_ABILITATO' },
          { status: 403 },
        ),
      })

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )

    expect(res.status).toBe(403)
    // Il cancello dei ruoli del modello non si legge dal 403 — un 403 lo dà anche la sede
    // sbagliata — ma dall'ELENCO con cui il gate è stato richiamato: se un giorno qualcuno
    // lo allargasse a tutti i ruoli, questa riga diventerebbe rossa.
    expect(auth.requireDocente).toHaveBeenLastCalledWith(expect.anything(), BANCO_SEGRETERIA)
    // Il rifiuto arriva PRIMA di leggere l'anagrafica del bambino e prima della numerazione.
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
    expect(h.state.rpc).toEqual([])
    expect(h.state.inserimenti).toEqual([])
  })

  it("la stampa di sezione, invece, un'insegnante la genera: il gate non viene ristretto", async () => {
    auth.requireDocente.mockResolvedValue({
      user: { id: UTENTE, role: 'educator', nome: 'Maria', cognome: 'Inventata', scuola_id: SEDE },
    })
    // Un'insegnante vede le SUE sezioni, non tutte: senza questa riga il rifiuto
    // arriverebbe da `assertSezioneInScope`, e il test proverebbe un'altra cosa.
    h.state.risposte['utenti_sezioni'] = [{ data: [{ section_id: SEZIONE }], error: null }]
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )

    expect(res.status).toBe(201)
    // Un solo giro di gate: il modello ammette anche il banco delle insegnanti, quindi non
    // c'è nessun elenco ristretto da imporre.
    expect(auth.requireDocente).toHaveBeenCalledTimes(1)
    expect(auth.requireDocente).toHaveBeenLastCalledWith(expect.anything())
  })

  it('una risposta mancante è un 400 sul CAMPO, e non brucia un numero di protocollo', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        risposte: { ...RISPOSTE_NULLA_OSTA, istituto: '' },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.details.map((d: { path: string }) => d.path)).toContain('istituto')
    expect(h.state.rpc).toEqual([])
    // Niente numerazione e niente archivio: un refuso in un campo non deve lasciare traccia
    // né nel registro protocolli né nel fascicolo.
    expect(h.state.inserimenti.map((i) => i.tabella)).not.toContain('protocolli')
    expect(h.state.inserimenti.map((i) => i.tabella)).not.toContain('student_documents')
    // La riga del registro degli accessi, invece, RESTA: il foglio non è uscito, ma
    // l'anagrafica del bambino per comporlo è stata letta lo stesso. È la stessa distinzione
    // che il GET dichiara sul precompilato.
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'view' }),
    ])
  })
})

describe('POST /api/prestampati/genera — il percorso felice', () => {
  it('la stampa di sezione esce come PDF e NON si archivia nel fascicolo di nessuno', async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' }, { id: ALUNNO_DUE, cognome: 'Fantasia' })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )
    const byte = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(byte.subarray(0, 4).toString()).toBe('%PDF')
    expect(res.headers.get('x-prestampato-archiviato')).toBe('non-previsto')
    // `student_documents` è il fascicolo di UN bambino: un elenco di sezione non è di nessuno.
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
    expect(h.state.rpc).toEqual([])

    // Ma l'estrazione si registra, UNA RIGA PER BAMBINO (§49, «Le regole comuni ai tre»,
    // punto 2): un foglio con i nomi di venti bambini è un'estrazione di dati personali
    // anche quando serve a lavorare, e il registro è per alunno.
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'list' }),
      expect.objectContaining({ alunno_id: ALUNNO_DUE, azione: 'list' }),
    ])
    // L'elenco non stampa né diete né telefoni, e infatti non li chiede a nessuna tabella.
    expect(colonneChieste('alunni')).not.toContain('note_mediche')
    expect(h.state.filtri.some((f) => f.tabella === 'student_parents')).toBe(false)
    expect(h.state.filtri.some((f) => f.tabella === 'parents')).toBe(false)
  })

  it('OTTO tabelle, un perimetro solo: la stampa di sezione non esce dalla sede da nessuna delle otto', async () => {
    // 🔴 QUESTO TEST STA AL POSTO DEL LOCK. `isolamento-sede-coverage` non legge
    // `banco.ts` — raccoglie i file che si chiamano `route.ts` — quindi chi domani toglie
    // `.eq('scuola_id', …)` da `leggiAlunniDiSezione` avrebbe la suite intera verde, lock
    // compreso, e l'elenco della sezione «2 ANNI» tornerebbe i bambini di due sedi. È
    // testualmente l'incidente dell'audit multi-sede del 30/07: da quando le sedi sono tre,
    // il nome di una classe non è più una chiave univoca e un `section_id` che arriva dal
    // client non basta a dire di chi sono quei bambini.
    //
    // ⚠️ LE TABELLE SONO OTTO, e per un giro questo presidio ne guardava quattro — mentre
    // il lock era stato alzato di due handler come se le coprisse tutte. Le altre quattro
    // (`sections`, `utenti_sezioni`/`utenti`, `scuole`, `schools`) non erano meno
    // pericolose: sono quelle da cui esce la CARTA INTESTATA e la colonna «Insegnanti»,
    // cioè un foglio che dichiara di venire da un plesso e porta i nomi di un altro.
    // Nessuna richiesta le tocca tutte insieme — i recapiti sono del foglio delle
    // emergenze, le insegnanti dell'elenco — quindi le prove sono tre, in fila.
    const DOCENTE = '22222222-8888-4888-8888-222222222222'
    const IDS_DELLA_SEZIONE = [ALUNNO, ALUNNO_DUE]

    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' }, { id: ALUNNO_DUE, cognome: 'Fantasia' })
    h.state.risposte['student_parents'] = [
      { data: [{ student_id: ALUNNO, parent_id: GENITORE }], error: null },
    ]
    h.state.risposte['parents'] = [
      { data: [{ id: GENITORE, first_name: 'Rosa', last_name: 'Recapito', phone_numbers: ['3400000001'] }], error: null },
    ]
    h.state.risposte['delegates'] = [
      { data: [{ student_id: ALUNNO, first_name: 'Rosa', last_name: 'Delegata', relation: 'nonna' }], error: null },
    ]

    // ── a. il foglio delle EMERGENZE: le tre tabelle della famiglia ────────────
    // È quello che tocca tutte e tre le tabelle senza colonna di sede: se il perimetro
    // tiene qui, tiene sulle altre due stampe, che leggono di meno.
    const emergenze = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'emergenze' },
      }),
    )
    expect(emergenze.status).toBe(201)

    // 1. `sections` si legge per ID, e la sede della riga letta è quella che decide: il
    //    rifiuto quando non coincide ha il suo test («una sezione fuori dalla sede
    //    SELEZIONATA è 403»), qui si tiene fermo che l'id non venga allargato a un filtro
    //    più largo — un `.in('scuola_id', …)` al posto dell'`.eq('id', …)`.
    //    Le letture sono DUE, ed è la duplicazione che le due route dichiarano accanto alla
    //    chiamata: `assertSezioneInScope` guarda `scuola_id`, `caricaSezione` ha bisogno
    //    anche di `name` e `school_type`. Si chiude quando il gate restituirà la riga letta.
    expect(restringimentiDi('sections')).toEqual([
      { tabella: 'sections', metodo: 'eq', args: ['id', SEZIONE] },
      { tabella: 'sections', metodo: 'eq', args: ['id', SEZIONE] },
    ])

    // 2. I bambini si prendono per SEZIONE **e** per SEDE, nella stessa query.
    expect(restringimentiDi('alunni')).toEqual(
      expect.arrayContaining([
        { tabella: 'alunni', metodo: 'eq', args: ['section_id', SEZIONE] },
        { tabella: 'alunni', metodo: 'eq', args: ['scuola_id', SEDE] },
      ]),
    )

    // 3. `student_parents` e `delegates` una colonna di sede non ce l'hanno: l'unico modo
    //    di tenerle dentro il perimetro è agganciarle agli id usciti dalla query qui sopra.
    //    L'asserzione è di UGUAGLIANZA, non di contenimento: un secondo restringimento
    //    aggiunto domani — su un id che arriva dal client, per esempio — la fa diventare
    //    rossa, ed è esattamente ciò che deve succedere.
    for (const tabella of ['student_parents', 'delegates']) {
      expect(restringimentiDi(tabella), tabella).toEqual([
        { tabella, metodo: 'in', args: ['student_id', IDS_DELLA_SEZIONE] },
      ])
    }

    // 4. E `parents` si aggancia agli id dei genitori usciti da `student_parents`, non a
    //    un elenco costruito altrove.
    expect(restringimentiDi('parents')).toEqual([
      { tabella: 'parents', metodo: 'in', args: ['id', [GENITORE]] },
    ])

    // 5. La carta intestata viene dalla sede della SEZIONE, letta per id: è la riga che
    //    dice da quale plesso viene il foglio.
    expect(restringimentiDi('scuole')).toEqual([
      { tabella: 'scuole', metodo: 'eq', args: ['id', SEDE] },
    ])

    // ── b. l'ELENCO: la colonna «Insegnanti» ──────────────────────────────────
    h.state.filtri = []
    h.state.usate = {}
    h.state.risposte['utenti_sezioni'] = [{ data: [{ utente_id: DOCENTE }], error: null }]
    h.state.risposte['utenti'] = [
      { data: [{ id: DOCENTE, attivo: true, cognome: 'Maestra', nome: 'Inventata' }], error: null },
    ]

    const elenco = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )
    expect(elenco.status).toBe(201)

    // 6. Il legame docente↔sezione si chiede per la SEZIONE già dentro il perimetro…
    expect(restringimentiDi('utenti_sezioni')).toEqual([
      { tabella: 'utenti_sezioni', metodo: 'eq', args: ['section_id', SEZIONE] },
    ])
    // 7. …e i nomi solo per gli id usciti da lì: `utenti` è la tabella di TUTTO il
    //    personale delle tre sedi, e una lettura senza aggancio metterebbe in fondo a un
    //    elenco di sezione le maestre di un altro plesso.
    expect(restringimentiDi('utenti')).toEqual([
      { tabella: 'utenti', metodo: 'in', args: ['id', [DOCENTE]] },
      { tabella: 'utenti', metodo: 'in', args: ['id', [DOCENTE]] },
    ])

    // ── c. il RIPIEGO su `schools`, la tabella di prima del multi-sede ─────────
    h.state.filtri = []
    h.state.usate = {}
    h.state.risposte['scuole'] = [{ data: null, error: null }]

    const conRipiego = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )
    expect(conRipiego.status).toBe(201)

    // 8. Anche il ripiego legge UNA riga, quella della sede della sezione. È la tabella
    //    più vecchia delle otto ed è l'unica che nessuna delle due strade filtra due
    //    volte: se domani qualcuno la leggesse per `citta` o per nome, due sedi omonime
    //    basterebbero a intestare il foglio al plesso sbagliato.
    expect(restringimentiDi('schools')).toEqual([
      { tabella: 'schools', metodo: 'eq', args: ['id', SEDE] },
    ])
  })

  it("le due date del foglio vengono dalla STESSA lettura dell'orologio, anche a mezzanotte", async () => {
    // 🔴 ERANO DUE LETTURE. La riga «Luogo e data» nasce in `caricaSezione`, il piede
    // «Riservato — dati di minori · … · …» nasceva in `componiPrestampato` da una seconda
    // chiamata a `isoDiOggi()`: fra le due passano le query dei bambini, dei genitori e dei
    // delegati, e a cavallo della mezzanotte lo stesso foglio esce con due date diverse. Sul
    // foglio della cucina la data è il dato che conta più di tutti («il rischio non è che
    // manchi: è che sia vecchio», n. 49), e due date discordi si leggono a caso.
    //
    // C'era anche un parametro `oggi` per cucire le due letture, e non lo passava nessuno:
    // una cucitura che funziona solo per chi si ricorda di usarla. È stato tolto, e la data
    // si legge una volta sola e viaggia nel contesto della sezione.
    //
    // ⚠️ SOLO `Date` È FINTO (`toFake`), non i timer: con i timer finti le `await` di questo
    // percorso — unpdf compreso — resterebbero appese.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // 22:30 UTC del 14 = 00:30 del 15 a Roma. È anche la prova che la data è quella
      // CIVILE italiana e non quella UTC del processo, che su Vercel è l'unica che c'è.
      vi.setSystemTime(new Date('2026-08-14T22:30:00.000Z'))
      alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })

      const res = await POST(
        reqGenera({
          modello: 'stampe_sezione',
          sezioneId: SEZIONE,
          scuolaId: SEDE,
          risposte: { stampa: 'elenco' },
        }),
      )
      const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

      expect(res.status).toBe(201)
      // Le due date ci sono e sono la stessa: la riga «Luogo e data» in fondo al testo e il
      // piede di pagina. Si contano invece di cercarle una per una, perché il piede si
      // ripete su ogni pagina e legare il test alla loro POSIZIONE lo farebbe diventare
      // rosso al primo bambino in più.
      expect(testo.split('15/08/2026').length - 1).toBeGreaterThanOrEqual(2)
      // E il giorno prima non compare da nessuna parte: né la carta né il piede sono
      // rimasti indietro.
      expect(testo).not.toContain('14/08/2026')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fra la lettura della sezione e la composizione può passare la mezzanotte: la data resta una', async () => {
    // ⚠️ IL TEST QUI SOPRA NON BASTA, e va detto invece di lasciarlo credere: con
    // l'orologio FERMO due letture separate danno lo stesso valore, quindi quel test
    // proverebbe verde anche con la seconda lettura rimessa dentro `componiPrestampato`.
    // Ciò che distingue «una lettura» da «due» è solo il tempo che passa in mezzo — e in
    // mezzo, sul percorso vero, ci stanno le query dei bambini, dei genitori e dei
    // delegati.
    //
    // Perciò qui le due metà si chiamano SEPARATE, con la mezzanotte spostata fra l'una e
    // l'altra: è l'unico modo di far divergere le due date, ed è la misura che oggi non
    // possono. Se qualcuno rimettesse `isoDiOggi()` dentro la composizione, il piede
    // direbbe 15 e la carta 14, e questa riga diventerebbe rossa.
    const voce = prestampato('stampe_sezione')
    if (!voce) throw new Error('il registro non conosce `stampe_sezione`')

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // 20:00 UTC = 22:00 del 14 a Roma: la sezione si legge il 14.
      vi.setSystemTime(new Date('2026-08-14T20:00:00.000Z'))
      alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })
      const supabase = h.makeClient() as unknown as SupabaseClient

      const caricata = await caricaSezione(supabase, SEZIONE, letturaPerStampa({ stampa: 'elenco' }))
      if (caricata.response) throw new Error('la sezione non si è caricata')
      const contesto = { soggetto: 'sezione' as const, sezione: caricata.sezione }

      // 23:30 UTC = 01:30 del 15 a Roma: fra la lettura e la stampa è passato un giorno.
      vi.setSystemTime(new Date('2026-08-14T23:30:00.000Z'))

      const reso = componiPrestampato(
        voce,
        contesto,
        { stampa: 'elenco' },
        { carta: cartaDelContesto(contesto) },
        'Inventata Anna',
      )
      if (!reso.ok) throw new Error('il foglio non si è composto')
      const testo = await estraiTesto(reso.pdf)

      // Tutte e due le date sono quelle della LETTURA, non della composizione: la riga
      // «Luogo e data» e il piede raccontano lo stesso giorno.
      expect(testo.split('14/08/2026').length - 1).toBeGreaterThanOrEqual(2)
      expect(testo).not.toContain('15/08/2026')
    } finally {
      vi.useRealTimers()
    }
  })

  it("il foglio delle emergenze stampa i recapiti — ed è l'unico che li legge", async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato', note_mediche: 'terapia salvavita' })
    h.state.risposte['student_parents'] = [
      { data: [{ student_id: ALUNNO, parent_id: GENITORE }], error: null },
    ]
    h.state.risposte['parents'] = [
      {
        data: [
          { id: GENITORE, first_name: 'Rosa', last_name: 'Recapito', phone_numbers: ['3401234567'] },
        ],
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'emergenze' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // Il numero della famiglia finisce sul foglio: è il foglio che si chiama al bisogno,
    // e un elenco d'emergenza senza numeri è indistinguibile da uno mai compilato.
    expect(testo).toContain('3401234567')
    expect(testo).toContain('Recapito')
    // Le due tabelle della famiglia SONO state interrogate, e solo qui.
    expect(h.state.filtri.some((f) => f.tabella === 'student_parents')).toBe(true)
    expect(h.state.filtri.some((f) => f.tabella === 'parents')).toBe(true)
    // Qui le note sanitarie servono davvero: questa stampa le chiede, l'elenco no.
    expect(colonneChieste('alunni')).toContain('note_mediche')
  })

  it('«in ordine di chiamata» è una promessa stampata: i genitori si ordinano per `is_primary`', async () => {
    // 🔴 L'intestazione di quella colonna dice «Genitori (in ordine di chiamata)» (§49.c), e
    // per un po' i genitori finivano nella cella nell'ordine arbitrario in cui PostgREST li
    // restituisce: un'affermazione di priorità che i dati non portavano, su un foglio che si
    // legge mentre un bambino sta male. La colonna che l'ordine lo esprime c'è dal baseline
    // (`student_parents.is_primary`).
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })
    h.state.risposte['student_parents'] = [
      {
        // Nell'ordine in cui il database li restituirebbe CON quell'`order`: il referente
        // per primo. Il doppio non riordina niente — non è un database — quindi le due metà
        // della garanzia si provano separate: che la query lo CHIEDA (l'asserzione sui
        // filtri) e che la composizione non lo PERDA (l'ordine nel PDF).
        data: [
          { student_id: ALUNNO, parent_id: GENITORE },
          { student_id: ALUNNO, parent_id: ALUNNO_DUE },
        ],
        error: null,
      },
    ]
    h.state.risposte['parents'] = [
      {
        data: [
          { id: GENITORE, first_name: 'Rosa', last_name: 'Primachiamata', phone_numbers: ['3400000001'] },
          { id: ALUNNO_DUE, first_name: 'Mario', last_name: 'Secondachiamata', phone_numbers: ['3400000002'] },
        ],
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'emergenze' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // La query DICHIARA l'ordine: senza questo, la cella lo prenderebbe da quello che capita.
    //
    // ⚠️ `nullsFirst: false` FA PARTE DELL'ASSERZIONE, e non è pignoleria di sintassi:
    // `is_primary` è nullable e in Postgres il `DESC` mette i NULL PER PRIMI. Senza quella
    // opzione una riga col legame nullo — un import a metà — precederebbe il genitore, cioè
    // l'unico caso in cui questa clausola serve sarebbe anche l'unico in cui sbaglia.
    expect(h.state.filtri.filter((f) => f.tabella === 'student_parents' && f.metodo === 'order')).toEqual([
      {
        tabella: 'student_parents',
        metodo: 'order',
        args: ['is_primary', { ascending: false, nullsFirst: false }],
      },
    ])
    // E la composizione lo CONSERVA fino alla cella: `perAlunno` accumula nell'ordine delle
    // righe lette, e il foglio le ripercorre in quell'ordine.
    expect(testo.indexOf('Primachiamata')).toBeGreaterThanOrEqual(0)
    expect(testo.indexOf('Primachiamata')).toBeLessThan(testo.indexOf('Secondachiamata'))
  })

  it('il foglio della cucina legge le diete ma NON i telefoni né le note mediche: gli assi sono tre', async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato', note_mediche: 'terapia salvavita' })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'allergie' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    expect(colonneChieste('alunni')).toContain('allergies')
    expect(h.state.filtri.some((f) => f.tabella === 'student_parents')).toBe(false)

    // 🔴 `note_mediche` NON SI CHIEDE. Il foglio 49.b ha sette colonne — nome, sezione,
    // allergie, alimenti, sostituzioni, motivo, documento — e l'anamnesi non è nessuna di
    // quelle: il modello non la stampa e `haDieta()` non la guarda. Con un interruttore
    // sanitario solo, l'art. 9 di venticinque bambini attraversava query, mappatura e render
    // per finire nel nulla — costo intero, beneficio zero.
    expect(colonneChieste('alunni')).not.toContain('note_mediche')
    expect(testo).not.toContain('terapia salvavita')
    // E nemmeno i delegati: sono un contorno della stampa delle emergenze.
    expect(h.state.filtri.some((f) => f.tabella === 'delegates')).toBe(false)
  })

  it("l'elenco della sezione porta le sue insegnanti, che sono l'unica cosa in più che stampa", async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })
    h.state.risposte['utenti_sezioni'] = [{ data: [{ utente_id: UTENTE }], error: null }]
    h.state.risposte['utenti'] = [
      { data: [{ id: UTENTE, cognome: 'Fantasia', nome: 'Rita', attivo: true }], error: null },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // La colonna «Insegnanti» del 49.a esisteva nell'intestazione e restava bianca su ogni
    // riga: una colonna vuota per l'archivio invece che per il codice. La fonte è
    // `utenti_sezioni`, la stessa che decide quali sezioni un docente può aprire.
    expect(testo).toContain('Fantasia Rita')
    expect(h.state.filtri.some((f) => f.tabella === 'utenti_sezioni')).toBe(true)
    // Ma resta una stampa di NOMI: né diete, né recapiti, né persone autorizzate al ritiro.
    expect(colonneChieste('alunni')).not.toContain('allergies')
    expect(h.state.filtri.some((f) => f.tabella === 'delegates')).toBe(false)
  })

  it('il foglio delle emergenze dice anche CHI può portare via il bambino', async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato' })
    h.state.risposte['delegates'] = [
      {
        data: [
          {
            student_id: ALUNNO,
            first_name: 'Rosa',
            last_name: 'Delegata',
            relation: 'nonna',
            // Il doppio lo restituisce perché il DB lo restituirebbe: il test prova che la
            // route NON lo chieda.
            document_number: 'XX0000000',
          },
        ],
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'emergenze' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // Le due parti si asseriscono separate perché la cella della tabella manda a capo:
    // «Delegata Rosa» sta su una riga e «(nonna)» sulla successiva. Cercare la stringa
    // intera legherebbe questo test alla larghezza di una colonna.
    expect(testo).toContain('Delegata Rosa')
    expect(testo).toContain('(nonna)')
    // Il numero del documento d'identità su questo foglio non serve a niente, e questo
    // foglio per costruzione finisce appeso: non si chiede.
    expect(colonneChieste('delegates')).not.toContain('document_number')
    expect(testo).not.toContain('XX0000000')
  })

  it("il bambino la cui allergia è SOLO nell'array `allergeni` finisce sul foglio della cucina", async () => {
    // 🔴 È il caso che la produzione ha davvero: `alunni.allergeni` è `text[]`, non testo.
    // Letto come stringa tornava vuoto, il bambino non aveva «dieta» e — se nessun altro
    // aveva `allergies` in testo libero — la cucina si ritrovava appesa un foglio che
    // NEGAVA per iscritto l'esistenza di allergie in sezione.
    alunniDiSezione({
      id: ALUNNO,
      cognome: 'Inventato',
      allergeni: ['arachidi'],
      allergies: null,
    })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'allergie' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // L'etichetta è quella del catalogo condiviso (`@/lib/mensa/allergeni`), la stessa che
    // usano le route della mensa sulle stesse due colonne: la chiave grezza no.
    expect(testo).toContain('Arachidi')
    expect(testo).toContain('Bambini con dieta speciale: 1 su 1')
    // La frase che non deve comparire: è una negazione, e una negazione mai verificata su
    // un foglio appeso in cucina è peggio di un foglio mancante.
    expect(testo).not.toContain('Nessun bambino della sezione ha allergie')
    // E il numero della segreteria chiude il foglio: «in caso di dubbio non somministrare
    // e contattare la segreteria: …» senza numero è mezza istruzione.
    expect(testo).toContain('0810000000')
  })

  it('il testo libero non si perde dietro le chiavi: le due registrazioni si sommano', async () => {
    // «fragole» fra i 14 allergeni dell'allegato II non c'è, quindi nessuna regola che
    // scelga UNA delle due colonne può stamparla. Da un elenco di cucina non deve sparire
    // niente: le due fonti si sommano.
    alunniDiSezione({
      id: ALUNNO,
      cognome: 'Inventato',
      allergeni: ['latte'],
      allergies: 'fragole',
    })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'allergie' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    expect(testo).toContain('Latte')
    expect(testo).toContain('fragole')
  })

  it("il foglio delle emergenze porta i numeri utili della sede, non solo il 118", async () => {
    alunniDiSezione({ id: ALUNNO, cognome: 'Inventato', note_mediche: 'terapia salvavita' })

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'emergenze' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // `{{sede.telefono}}` sta nella specifica del n. 49 e il dato sta in archivio
    // (`scuole.config.anagrafica.telefono`): se la route non lo legge, il foglio chiude con
    // «Numeri utili: 118» e basta — e non è un degrado, è un dato mai chiesto.
    expect(testo).toContain('Numeri utili: 118')
    expect(testo).toContain('0810000000')
  })

  it('se le colonne sanitarie non esistono, la cucina NON riceve un foglio che nega — e non le si dice «riprova»', async () => {
    // In produzione le tre colonne ci sono (baseline). Questo è il DB della CI, che è un
    // progetto separato e non migrato: ripiegare sulla lettura senza colonne sanitarie
    // farebbe uscire la stessa negazione mai verificata del caso qui sopra — stavolta senza
    // nemmeno aver guardato l'archivio.
    h.state.risposte['alunni'] = [
      { data: null, error: { code: '42703', message: 'column alunni.allergeni does not exist' } },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'allergie' },
      }),
    )
    const json = await res.json()

    // 🔴 NON è il 503 di `PRESTAMPATI_ELENCO_NON_LETTO`, e la differenza è tutta per chi sta
    // allo sportello: quel codice si traduce in «Riprova fra qualche minuto»
    // (`messages/it/shared.json`), mentre una colonna che non esiste non esisterà nemmeno
    // domani. Il pannello mostra la frase del CODICE, non il campo `error`: asserire sulla
    // prosa — come faceva questo test — significava misurare una stringa che nessun utente
    // vedrà mai.
    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
  })

  it('se a mancare è la sola colonna dell’oblio, la cucina riceve il suo foglio — con le diete lette davvero', async () => {
    // 🔴 IL RIFIUTO ACCUSAVA UNA COLONNA CHE C'ERA. La query chiede `anonimizzato_il`
    // INSIEME alle colonne della stampa, e il ramo del rifiuto guardava solo il `code`
    // (`42703`, «lo schema non regge») senza chiedersi QUALE colonna: su un ambiente dove
    // manca soltanto quella — cioè il DB E2E della CI, il caso per cui questi rami
    // esistono — il foglio della cucina riceveva 422 «i dati sanitari non sono disponibili
    // su questo ambiente» mentre `allergies` e `allergeni` c'erano entrambe. E la riga di
    // `app_log` diceva `colonne-diete-assenti`, mandando chi indaga a cercare la migrazione
    // sbagliata.
    //
    // Il nome vero si legge dal `message` di PostgREST, che è l'unica fonte che lo sa.
    h.state.risposte['alunni'] = [
      { data: null, error: { code: '42703', message: 'column alunni.anonimizzato_il does not exist' } },
      {
        data: [
          {
            id: ALUNNO,
            nome: 'Luca',
            cognome: 'Inventato',
            data_nascita: '2021-03-04',
            classe_sezione: 'Coccinelle',
            stato: 'iscritto',
            allergies: null,
            allergeni: ['arachidi'],
            note_mediche: null,
          },
        ],
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'allergie' },
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    // E il foglio non è quello che NEGA: l'allergia del bambino ci sta sopra, perché la
    // seconda lettura chiede ancora le due colonne della dieta — cade solo il filtro
    // dell'oblio, che senza quella colonna non ha niente da filtrare.
    expect(testo).toContain('Arachidi')
    expect(colonneChieste('alunni')).toContain('allergeni')
    expect(testo).not.toContain('Nessun bambino della sezione')
  })

  it("l'elenco dei nomi, invece, esce lo stesso: non è la stampa che dipende da quelle colonne", async () => {
    // La stessa lacuna di schema, ma su una stampa che le colonne sanitarie non le chiede:
    // qui il ripiego (senza filtro dell'oblio) è quello giusto, e il foglio esce.
    h.state.risposte['alunni'] = [
      { data: null, error: { code: '42703', message: 'column alunni.anonimizzato_il does not exist' } },
      { data: [], error: null },
    ]

    const res = await POST(
      reqGenera({
        modello: 'stampe_sezione',
        sezioneId: SEZIONE,
        scuolaId: SEDE,
        risposte: { stampa: 'elenco' },
      }),
    )

    expect(res.status).toBe(201)
  })

  it('il nulla osta consuma UN numero, scrive il registro e archivia nel fascicolo', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const byte = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(201)
    expect(byte.subarray(0, 4).toString()).toBe('%PDF')

    // UNA sola volta: il numero stampato sul foglio e quello del registro sono lo stesso.
    const numerazioni = h.state.rpc.filter((r) => r.nome === 'prossimo_numero_protocollo')
    expect(numerazioni).toHaveLength(1)
    expect(numerazioni[0].args).toMatchObject({ p_scuola: SEDE })
    expect(res.headers.get('x-prestampato-protocollo')).toMatch(/^0000123\/\d{4}$/)

    // 🔴 L'IMPRONTA REGISTRATA È QUELLA DEI BYTE CONSEGNATI, e questo test è l'unica cosa
    // che lo tiene. Sul foglio è STAMPATA la frase «l'impronta SHA-256 di questo documento
    // è registrata nel registro di protocollo», e quel foglio va all'INPS e al datore di
    // lavoro: se il registro conservasse l'impronta di un file diverso da quello scaricato
    // — per esempio quella dei byte PRIMA della carta e della segnatura, come faceva la
    // route sorella e come due commenti hanno continuato a dichiarare fino al 2026-08-16 —
    // chi la verifica troverebbe due valori diversi e la frase sarebbe falsa.
    //
    // Su carta intestata non c'è più un «dopo»: `applicaCartaIntestata(pdf, { segnatura })`
    // stende carta e segnatura in una passata sola, quindi consegnato, archiviato e
    // registrato sono lo stesso file. Chi spostasse il calcolo dell'impronta prima della
    // carta romperebbe QUESTA riga, che è il punto.
    const protocollo = h.state.inserimenti.find((i) => i.tabella === 'protocolli')
    expect(protocollo?.valori).toMatchObject({ scuola_id: SEDE, numero: 123, tipo: 'uscita' })
    expect(String(protocollo?.valori.impronta_sha256)).toMatch(/^SHA256-[0-9A-F]{64}$/)
    const { createHash } = await import('node:crypto')
    expect(protocollo?.valori.impronta_sha256).toBe(
      `SHA256-${createHash('sha256').update(byte).digest('hex').toUpperCase()}`
    )
    // 🔴 DESTINATARIO E MEZZO DEVONO DESCRIVERE LO STESSO ATTO. Il nulla osta ha il campo
    // «Istituto di destinazione», ma quell'istituto è l'OGGETTO del documento, non chi lo
    // riceve: il foglio lo prende la famiglia, che lo porta alla scuola nuova (§«Dopo la
    // generazione» del n. 30). Prima il destinatario diceva «Istituto Comprensivo …» e il
    // mezzo «Consegna a mano», cioè un atto consegnato a mano a una scuola di un altro
    // comune — su una riga di registro WORM, che nessuno rettificherà.
    expect(protocollo?.valori.destinatario).toBe("Famiglia dell'alunno/a Inventato Luca")
    expect(protocollo?.valori.mezzo).toBe('Consegna a mano')

    // Due file nel bucket del protocollo (originale + timbrato) e uno nel fascicolo.
    expect(h.state.caricamenti).toHaveLength(3)
    // ⚠️ UN SOLO `listBuckets()`, e non è quello del fascicolo: è `ensureBucket` del
    // registro protocolli (`src/lib/protocolli/store.ts`), che quel bucket lo possiede
    // davvero e lo crea se manca. La verifica del bucket del FASCICOLO — che questa route
    // non possiede e non crea — girava anche lei prima di ogni upload, una andata e ritorno
    // in più su ogni foglio generato, per produrre nel caso buono esattamente niente.
    // Adesso parte solo dopo un upload fallito, dove serve davvero: il test qui sotto conta
    // due chiamate, che sono queste una più quella.
    expect(h.state.bucketElencati).toBe(1)

    const documento = h.state.inserimenti.find((i) => i.tabella === 'student_documents')
    expect(documento?.valori).toMatchObject({
      student_id: ALUNNO,
      section_id: SEZIONE,
      document_type: 'nulla_osta',
      // Scadenza solo dove ha senso: un nulla osta non scade.
      expiry_date: null,
    })
    expect(String(documento?.valori.descrizione)).toContain('Prot. n. 0000123/')
    expect(res.headers.get('x-prestampato-archiviato')).toBe('archiviato')

    // DUE righe nel registro degli accessi, e sono due fatti diversi: l'anagrafica del
    // bambino è stata letta per comporre il foglio (`view`), e il documento è entrato nel
    // suo fascicolo (`upload`, col documento a cui si riferisce — come fa
    // `primaria/fascicolo:POST` sul suo INSERT).
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'view' }),
      expect.objectContaining({
        alunno_id: ALUNNO,
        azione: 'upload',
        documento_id: 'student_documents-1',
      }),
    ])
  })

  it('il foglio che esce senza il suo tagliando lo DICHIARA, invece di dirsi completo', async () => {
    alunnoIn()

    // Il n. 31 va a un istituto terzo con un tagliando da ritagliare e rispedire, e il
    // motore quel tagliando non lo stampa: finirebbe sotto la firma del legale
    // rappresentante, e chi ritaglia si porterebbe via la firma. `render.ts` lo dichiara
    // («foglio incompleto, non sbagliato») e chiede a chi lo riceve di non tacerlo.
    const res = await POST(
      reqGenera({
        modello: 'richiesta_disponibilita',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: {
          istituto: 'Istituto Comprensivo Inventato',
          indirizzo_istituto: 'Via Finta 1, Napoli',
          decorrenza: '2026-09-01',
        },
      }),
    )
    const byte = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(201)
    expect(byte.subarray(0, 4).toString()).toBe('%PDF')
    // Quanti blocchi siano è affare del modello — oggi otto, e contarli qui renderebbe
    // questo test rosso al primo campo aggiunto al tagliando. Ciò che deve restare fermo è
    // che siano più di zero e che la route lo dica.
    expect(Number(res.headers.get('x-prestampato-incompleto'))).toBeGreaterThan(0)
    // Corrispondenza fra istituti: sta nel registro protocolli, non nel fascicolo del
    // bambino — quindi nessuna riga in `student_documents`.
    expect(res.headers.get('x-prestampato-archiviato')).toBe('non-previsto')
    expect(h.state.inserimenti.some((i) => i.tabella === 'protocolli')).toBe(true)

    // Ma l'accesso al fascicolo VA TRACCIATO LO STESSO, ed è il foglio che ne ha più
    // bisogno: nome, data di nascita e sezione di un bambino escono dalla scuola verso un
    // istituto terzo. Legare l'audit all'archiviazione — che qui non avviene mai — lasciava
    // proprio questo caso senza nessuna riga.
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'view' }),
    ])

    // Il mezzo di trasmissione NON si inventa: questa è una lettera che aspetta «riscontro
    // scritto, anche a mezzo email/PEC», e la route non spedisce niente. Il registro è WORM:
    // «Consegna a mano» sarebbe una dichiarazione che nessuno ha scelto e che resta per
    // sempre.
    const protocollo = h.state.inserimenti.find((i) => i.tabella === 'protocolli')
    expect(protocollo?.valori.mezzo).toBeNull()
    expect(protocollo?.valori.destinatario).toBe('Istituto Comprensivo Inventato')
  })

  it("l'enumerato che non conosce i prestampati non fa sparire il PDF dal bucket", async () => {
    alunnoIn()
    // 🔴 Non è un caso di scuola: è ciò che la produzione risponde OGGI. Misurato il
    // 2026-08-14 in sola lettura, `document_type_enum` ha quattro valori — `diagnosi`,
    // `pei`, `104`, `pdp` — e nessuno dei diciassette slug ci sta dentro.
    h.state.erroreInsert['student_documents'] = {
      message: 'invalid input value for enum document_type_enum: "nulla_osta"',
      code: '22P02',
    }

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const byte = Buffer.from(await res.arrayBuffer())

    // Il documento esce lo stesso — è già protocollato, e rispondere 500 butterebbe via un
    // atto — e dichiara di non essere in archivio.
    expect(res.status).toBe(201)
    expect(byte.subarray(0, 4).toString()).toBe('%PDF')
    expect(res.headers.get('x-prestampato-archiviato')).toBe('fallita')

    // IL PUNTO DI QUESTO TEST: il PDF resta nel bucket. Riprovare darebbe lo stesso
    // errore domani, quindi il file è l'unica copia recuperabile il giorno in cui
    // l'enumerato si allarga — e toglierlo renderebbe quel giorno inutile.
    const caricato = h.state.caricamenti.find((c) => c.path.startsWith(`${ALUNNO}/prestampati/`))
    expect(caricato).toBeDefined()
    expect(h.state.rimossi).not.toContain(caricato?.path)

    // E l'anagrafica letta resta registrata anche qui. È lo scenario che oggi in produzione
    // gira a OGNI generazione: se l'audit dipendesse dall'INSERT riuscito, i quattro modelli
    // archiviabili non lascerebbero MAI una riga — cioè zero tracce, tutte le volte.
    expect(accessiTracciati()).toEqual([
      expect.objectContaining({ alunno_id: ALUNNO, azione: 'view' }),
    ])
  })

  it('il bucket condiviso del fascicolo NON lo crea questa route: se manca, lo dice e basta', async () => {
    // 🔴 `sensitive_documents` è del FASCICOLO (`primaria/fascicolo`), che lo crea con
    // quattro tipi MIME — PDF e tre formati immagine — perché il contenuto principale di un
    // fascicolo sono le scansioni. Questa route lo creava con `['application/pdf']` e basta,
    // e vince chi arriva primo: in un ambiente dove il bucket non c'è ancora (il progetto
    // E2E della CI, un progetto ripristinato, una sede nuova) bastava generare un
    // prestampato prima del primo caricamento nel fascicolo perché ogni carta d'identità e
    // ogni referto in `image/jpeg` venisse poi rifiutato dallo storage — con un errore che
    // parla di MIME e non nomina mai chi ha creato il bucket.
    alunnoIn()
    h.state.bucketEsistenti = ['protocollo']

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const byte = Buffer.from(await res.arrayBuffer())

    // IL PUNTO: nessun bucket condiviso creato da qui. Il rimedio è crearlo dov'è di casa.
    expect(h.state.bucketCreati.map((b) => b.nome)).not.toContain('sensitive_documents')
    // E l'elenco dei bucket si chiede ADESSO, che è quando serve: è la riga che aggiunge il
    // PERCHÉ a un «Bucket not found» altrimenti muto. Due chiamate — quella di
    // `ensureBucket` sul bucket del protocollo, che c'è sempre, più questa — contro l'UNA
    // del percorso felice qui sopra: è la misura che la verifica del fascicolo non gira più
    // sulle archiviazioni riuscite.
    expect(h.state.bucketElencati).toBe(2)

    // Il documento esce lo stesso — è già protocollato — e dichiara di non essere in
    // archivio: l'upload fallisce col PROPRIO corpo d'errore, che è il rimedio che c'era già.
    expect(res.status).toBe(201)
    expect(byte.subarray(0, 4).toString()).toBe('%PDF')
    expect(res.headers.get('x-prestampato-archiviato')).toBe('fallita')
    // E nessuna riga nel fascicolo: senza il file, un record che lo nomina è un elenco che
    // mostra un documento scaricabile che non esiste.
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
  })

  it('se il registro non accetta la riga, il documento NON esce e i file caricati si tolgono', async () => {
    alunnoIn()
    h.state.erroreInsert['protocolli'] = { message: 'permission denied for table protocolli', code: '42501' }

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json.codice).toBe('PRESTAMPATO_NON_GENERATO')
    // Rollback: niente file orfani nel bucket del protocollo…
    expect(h.state.rimossi).toHaveLength(2)
    // …e nessuna riga nel fascicolo del bambino.
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
  })

  it("l'archiviazione fallita non nasconde il documento: esce lo stesso, e lo dichiara", async () => {
    alunnoIn()
    h.state.erroreInsert['student_documents'] = { message: 'null value in column "student_id"', code: '23502' }

    const res = await POST(
      reqGenera({
        modello: 'nulla_osta',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: RISPOSTE_NULLA_OSTA,
      }),
    )
    const byte = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(201)
    expect(byte.subarray(0, 4).toString()).toBe('%PDF')
    expect(res.headers.get('x-prestampato-archiviato')).toBe('fallita')
    // Il file caricato nel fascicolo si toglie: un documento che nessun elenco mostrerà.
    expect(h.state.rimossi.some((p) => p.startsWith(`${ALUNNO}/prestampati/`))).toBe(true)
  })
})

// ─── La scadenza dei documenti a termine ────────────────────────────────────────

/**
 * `scadenzaDaRisposte` è l'UNICA sorgente di `student_documents.expiry_date` per tutti e
 * otto i modelli della famiglia — la route della segreteria la usa sui suoi, e quella della
 * firma del genitore (`parent/prestampati/firma`) la importa da qui — quindi si prova a
 * unità: attraverso le route non ci si arriva, perché i modelli a scadenza sono proprio
 * quelli che lo sportello rifiuta con `PRESTAMPATO_FIRMA_NON_VALIDA`.
 *
 * Il campo che dichiara la scadenza NON si chiama allo stesso modo su tutti, ed è il difetto
 * che questo blocco esiste per tenere chiuso: leggendo solo `al` ogni permesso del n. 09
 * finiva in archivio con `expiry_date: null`, cioè valido per sempre, e il cron
 * `notifiche/scadenze-documenti` non avrebbe avvisato mai nessuno.
 */
describe('scadenzaDaRisposte — chi scade, e con quale campo lo dice', () => {
  it('06 farmaci e 08 delega dichiarano la fine con `al`', () => {
    expect(scadenzaDaRisposte({ dal: '2026-09-01', al: '2026-09-30' })).toBe('2026-09-30')
  })

  it('09 permesso ricorrente scade a fine ricorrenza, non con un campo `al` che non ha', () => {
    // I campi veri del n. 09: `giorno, tipo, oraArrivo, oraUscita, motivo, accompagnatore,
    // ricorrenzaGiorni, ricorrenzaFino`. Nessun `al`.
    expect(
      scadenzaDaRisposte({
        giorno: '2026-09-15',
        tipo: 'uscita_anticipata',
        oraUscita: '15:30',
        ricorrenzaGiorni: ['martedi'],
        ricorrenzaFino: '2026-11-30',
      }),
    ).toBe('2026-11-30')
  })

  it('09 permesso di un giorno solo scade quel giorno', () => {
    expect(scadenzaDaRisposte({ giorno: '2026-09-15', tipo: 'entrata_posticipata', oraArrivo: '10:00' })).toBe(
      '2026-09-15',
    )
  })

  it('07 dieta speciale resta senza scadenza: la sua «validità» è testo libero, non una data', () => {
    // `validita: z.string().trim().max(120)`. Sul certificato del medico c'è scritto «per
    // l'anno scolastico in corso» tanto quanto una data: inventare una scadenza farebbe
    // sparire la dieta dalla cucina un giorno scelto da questo codice.
    expect(scadenzaDaRisposte({ motivo: 'allergia_alimentare', validita: "per l'anno scolastico in corso" })).toBeNull()
    expect(scadenzaDaRisposte({ motivo: 'religioso' })).toBeNull()
  })

  it('una data malformata non diventa una scadenza', () => {
    // Le risposte arrivano già validate dallo schema del modello, ma il vaglio della forma
    // resta: `expiry_date` è una colonna `date`, e una stringa qualunque la farebbe
    // rifiutare dall'INSERT — cioè niente riga nel fascicolo, per un refuso.
    expect(scadenzaDaRisposte({ al: '30/09/2026' })).toBeNull()
    expect(scadenzaDaRisposte({ ricorrenzaFino: '' })).toBeNull()
    expect(scadenzaDaRisposte(null)).toBeNull()
    expect(scadenzaDaRisposte('2026-09-30')).toBeNull()
  })
})

// ─── Le tre modalità sui moduli di famiglia ─────────────────────────────────────

/**
 * 🔴 IL VINCOLO CHE QUESTO BLOCCO ESISTE PER TENERE: **un foglio non deve MAI dichiarare una
 * firma elettronica che non è avvenuta.**
 *
 * Dei tre modi di lavorare su un modulo di famiglia, uno solo porta il riquadro «Firmato da
 * …, codice OTP verificato, riferimento …» — la copia che il genitore ha davvero
 * sottoscritto, ripresa dal fascicolo tale e quale. Gli altri due stampano un foglio nuovo,
 * e su quel foglio la firma non c'è: la copia vuota porta la RIGA da firmare a penna, il
 * modulo tornato di carta porta la dicitura che rimanda all'originale agli atti.
 *
 * I test che seguono leggono il TESTO del PDF, non la configurazione che l'ha prodotto: è
 * l'unica prova che regge, perché `eslint`, `tsc` e un test sulle opzioni resterebbero tutti
 * verdi anche se il riquadro tornasse — nessuno di loro sa cosa c'è stampato sul foglio.
 */
describe('POST /api/prestampati/genera — le tre modalità dei moduli di famiglia', () => {
  /** Il n. 09 compilato: entrata posticipata, che è il ramo senza cancelli di contesto. */
  const RISPOSTE_PERMESSO = { giorno: '2026-09-15', tipo: 'entrata_posticipata', oraArrivo: '09:30' }

  /**
   * Il testo del PDF **pagina per pagina**, che `estraiTesto` non dà: quella funzione
   * concatena tutto, e la domanda che serve qui è cosa c'è sull'ULTIMA pagina.
   */
  async function testoPerPagina(buf: Uint8Array): Promise<string[]> {
    const { getDocumentProxy } = await import('unpdf')
    // COPIA difensiva: PDF.js «trasferisce» (detacha) l'ArrayBuffer che riceve.
    const doc = await getDocumentProxy(buf.slice())
    const pagine: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const contenuto = await (await doc.getPage(i)).getTextContent()
      let riga = ''
      let ultimaY: number | null = null
      for (const item of contenuto.items as Array<{ str?: string; transform?: number[] }>) {
        if (typeof item.str !== 'string' || item.str.length === 0) continue
        const y = item.transform?.[5]
        if (ultimaY !== null && typeof y === 'number' && Math.abs(y - ultimaY) > 2) riga += '\n'
        else if (riga && !riga.endsWith('\n')) riga += ' '
        riga += item.str
        if (typeof y === 'number') ultimaY = y
      }
      pagine.push(riga)
    }
    return pagine
  }

  /**
   * IL BLOCCO DI FIRMA, cioè l'unica cosa che una pagina orfana contiene.
   *
   * Sono le quattro stringhe che `disegnaFirma` e la riga da firmare a penna mettono sul
   * foglio. `Napoli, lì` è la riga `luogoData`, che il motore stampa sempre sotto l'etichetta
   * grigia.
   */
  const BLOCCO_DI_FIRMA = ['Luogo e data', 'Napoli, lì', 'Data della firma', 'Firma del genitore/tutore']

  /**
   * Le righe di MODULO che stanno sull'ultima pagina — zero significa pagina orfana.
   *
   * ⚠️ LA TESTATA NON SI ELENCA A MANO, e la differenza è tutta qui: la prima versione di
   * questo controllo la elencava (`Scuola Inventata`, `Napoli`, il titolo) e si è dimostrata
   * BUCATA — dimenticava `Cod. Mecc. NA1A00000X`, che si ripete su ogni pagina, e con quella
   * riga sopravvissuta al filtro una pagina con la sola firma risultava «piena». Il lock non
   * poteva più fallire: verificato riapplicando di proposito il difetto, restava verde.
   *
   * Qui la testata si DEDUCE: è ciò che compare su TUTTE le pagine. Non c'è niente da tenere
   * aggiornato, e una riga di testata aggiunta domani non riapre il buco.
   *
   * ⚠️ La carta intestata non entra nel conto: l'asset è tutto vettoriale e non ha nemmeno un
   * carattere estraibile — misurato con `pdftotext` su `src/lib/carta/asset/carta-intestata.pdf`,
   * che restituisce zero righe. Tutto ciò che si legge su queste pagine lo ha scritto l'app.
   */
  function moduloSullUltimaPagina(pagine: string[]): string[] {
    const righeDi = (p: string) =>
      p.split('\n').map((r) => normalizza(r)).filter((r) => r.length > 0)
    const tutte = pagine.map(righeDi)
    const ultima = tutte[tutte.length - 1] ?? []
    // Con una pagina sola la domanda non si pone: il modulo è lì, non c'è nessun orfano.
    if (tutte.length < 2) return ultima
    const testata = ultima.filter((r) => tutte.every((p) => p.includes(r)))
    return ultima.filter(
      (r) =>
        !testata.includes(r) &&
        !/^Pagina \d+ di \d+$/.test(r) &&
        !BLOCCO_DI_FIRMA.some((s) => r.includes(normalizza(s))),
    )
  }

  /** Accenti e apostrofi tipografici resi confrontabili: il PDF non usa gli stessi glifi. */
  function normalizza(s: string): string {
    return s.replace(/[’‘`´]/g, "'").replace(/[«»“”]/g, '"').replace(/\s+/g, ' ').trim()
  }

  /** Il precompilato con cui si compone un modulo vuoto fuori dalla rotta. */
  const DATI_PER_MODULO_VUOTO = {
    alunno: {
      nome: 'Luca',
      cognome: 'Inventato',
      dataNascita: '2021-03-04',
      luogoNascita: 'Napoli',
      codiceFiscale: 'NVNLCU21C04F839P',
      sezione: 'Coccinelle',
    },
    genitori: [],
    sede: { scuola_nome: 'Scuola Inventata', scuola_citta: 'Napoli' },
    scuola: {},
    annoScolastico: '2026/2027',
    dataOggi: '2026-08-16',
  }

  /** I sei moduli di famiglia, cioè quelli che `modalitaDelModello` accende. */
  const SEI_MODULI = [
    'scheda_sanitaria',
    'autorizzazione_farmaci',
    'dieta_speciale',
    'delega_ritiro',
    'permesso_orario',
    'autorizzazione_uscita',
  ] as const

  /** I byte inventati della copia firmata: il test prova che tornano IDENTICI, non che siano un PDF. */
  const BYTE_COPIA_FIRMATA = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

  /**
   * L'impronta che `firme_documenti` porta per quei byte, nella forma che la PRODUZIONE ha.
   *
   * ⚠️ MINUSCOLA, e non è indifferente: `parent/prestampati/firma` scrive
   * `SHA256-` + `createHash(…).digest('hex')`, mentre `sha256Impronta` — la funzione con cui
   * la route ricalcola — restituisce lo stesso hex in maiuscolo. Misurato in produzione il
   * 2026-08-16: tutte le righe esistenti sono in minuscolo. Il doppio usa la forma vera, così
   * il test cade davvero il giorno in cui la route cercasse una forma sola.
   */
  function improntaFea(byte: Uint8Array): string {
    return `SHA256-${createHash('sha256').update(byte).digest('hex')}`
  }

  /**
   * La riga di `student_documents` che tiene la copia firmata, il file nel bucket **e la
   * riga di `firme_documenti` che la rende una copia firmata.**
   *
   * La terza non è scenografia: senza, quei byte sono un foglio qualunque archiviato con quel
   * tipo di documento — cioè esattamente ciò che la route deve rifiutare.
   */
  function copiaFirmataInArchivio(
    slug = 'permesso_orario',
    percorso = `${ALUNNO}/prestampati/${slug}-1.pdf`,
  ) {
    h.state.risposte['student_documents'] = [
      {
        data: [{ id: 'doc-firmato-1', file_name: 'Permesso_firmato.pdf', storage_path: percorso }],
        error: null,
      },
    ]
    h.state.fileScaricabili[percorso] = BYTE_COPIA_FIRMATA
    h.state.firmeFea[slug] = [improntaFea(BYTE_COPIA_FIRMATA)]
    return percorso
  }

  /** Una riga di fascicolo che NESSUNO ha firmato elettronicamente: trascrizione o scansione. */
  function nelFascicoloSenzaFirma(
    id: string,
    slug = 'permesso_orario',
    byte = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
  ) {
    const percorso = `${ALUNNO}/prestampati/${slug}-${id}.pdf`
    h.state.fileScaricabili[percorso] = byte
    return { id, file_name: 'Permesso.pdf', storage_path: percorso }
  }

  it('copia vuota: nessun riquadro di firma elettronica, e la riga da firmare a penna al suo posto', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'scheda_sanitaria',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_vuota',
        // Nessuna risposta, ed è il punto: la scheda sanitaria ne pretende otto, e su questo
        // foglio non ne serve nessuna — le scriverà la famiglia a penna.
        risposte: {},
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    expect(res.headers.get('X-Prestampato-Modalita')).toBe('copia_vuota')
    // 🔴 IL VINCOLO: niente riquadro FEA. Le tre righe che `componiAttestazione` scrive
    // cominciano tutte da qui.
    expect(testo).not.toContain('Firmato da')
    expect(testo).not.toContain('Riferimento firma')
    // E al suo posto la riga da firmare a penna.
    expect(testo).toContain('Firma del genitore/tutore')
    // I dati del bambino ci sono già: è la metà del lavoro che questo foglio fa risparmiare.
    expect(testo).toContain('Inventato')
    // Le domande del modulo ci sono, vuote: senza, sarebbe un foglio intestato e basta.
    expect(testo).toContain('Pediatra')
  })

  it('copia vuota: non entra nel fascicolo del bambino', async () => {
    // Una scheda sanitaria con tutte le risposte in bianco, archiviata, sarebbe
    // indistinguibile da quella vera nell'elenco che la famiglia e la segreteria leggono.
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'scheda_sanitaria',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_vuota',
        risposte: {},
      }),
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('X-Prestampato-Archiviato')).toBe('non-previsto')
    expect(h.state.inserimenti.filter((i) => i.tabella === 'student_documents')).toEqual([])
    expect(h.state.caricamenti).toEqual([])
  })

  it('copia vuota: nessuno dei SEI moduli di famiglia stampa il riquadro della firma elettronica', async () => {
    // Uno per uno, e non a campione: il difetto peggiore di questa catena è un foglio che
    // attesta una firma che non c'è, e basta che scappi su UNO dei sei perché finisca nel
    // fascicolo di un minore.
    for (const slug of SEI_MODULI) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      expect(res.status, slug).toBe(201)
      const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))
      expect(testo, slug).not.toContain('Firmato da')
      expect(testo, slug).not.toContain('Riferimento firma')
      expect(testo, slug).toContain('Firma del genitore/tutore')
    }
  })

  it('modulo tornato su carta: la dicitura è quella, parola per parola, e la firma elettronica non c’è', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'su_carta',
        consegnatoIl: '2026-08-10',
        risposte: RISPOSTE_PERMESSO,
      }),
    )
    const testo = await estraiTesto(new Uint8Array(await res.arrayBuffer()))

    expect(res.status).toBe(201)
    expect(res.headers.get('X-Prestampato-Modalita')).toBe('su_carta')
    // La dicitura dettata dal titolare, senza una parola in più o in meno.
    expect(testo).toContain('Modulo consegnato su carta il 10/08/2026, firmato in originale agli atti')
    // 🔴 E niente riquadro FEA: l'originale firmato è di carta e sta agli atti.
    expect(testo).not.toContain('Firmato da')
    expect(testo).not.toContain('Riferimento firma')
    // Le risposte trascritte ci sono davvero: è la trascrizione di un modulo compilato.
    expect(testo).toContain('15/09/2026')
  })

  it('modulo tornato su carta: entra nel fascicolo, con il tipo di documento del modello', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'su_carta',
        consegnatoIl: '2026-08-10',
        risposte: RISPOSTE_PERMESSO,
      }),
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('X-Prestampato-Archiviato')).toBe('archiviato')
    const riga = h.state.inserimenti.find((i) => i.tabella === 'student_documents')
    expect(riga?.valori).toMatchObject({
      student_id: ALUNNO,
      document_type: 'permesso_orario',
      // Il permesso di un giorno scade quel giorno: un permesso che non scade è
      // un'autorizzazione permanente firmata per un pomeriggio.
      expiry_date: '2026-09-15',
    })
  })

  it('modulo tornato su carta senza la data di consegna: 400 sul campo, e niente PDF', async () => {
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'su_carta',
        risposte: RISPOSTE_PERMESSO,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.details?.map((d: { path?: string }) => d.path)).toContain('consegnatoIl')
    expect(h.state.inserimenti.filter((i) => i.tabella === 'student_documents')).toEqual([])
  })

  it('modulo tornato su carta con una data nel futuro: 400 sul campo', async () => {
    // Una consegna nel futuro finisce STAMPATA su un documento che entra nel fascicolo di un
    // minore e dichiara che un originale firmato esiste già.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T09:00:00Z'))
    try {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: 'permesso_orario',
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'su_carta',
          consegnatoIl: '2026-08-17',
          risposte: RISPOSTE_PERMESSO,
        }),
      )
      const json = await res.json()

      expect(res.status).toBe(400)
      expect(json.details?.map((d: { path?: string }) => d.path)).toContain('consegnatoIl')
    } finally {
      vi.useRealTimers()
    }
  })

  it('copia firmata: restituisce i byte ARCHIVIATI, non un foglio nuovo', async () => {
    // 🔴 Rigenerarla darebbe stesse parole e byte diversi — cioè un file di cui la ricevuta
    // FEA non è più la ricevuta, su un documento che attesta una firma.
    alunnoIn()
    const percorso = copiaFirmataInArchivio()

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )
    const byte = new Uint8Array(await res.arrayBuffer())

    // 200 e non 201: non è stato creato niente.
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Prestampato-Modalita')).toBe('copia_firmata')
    expect(res.headers.get('X-Prestampato-Documento')).toBe('doc-firmato-1')
    // I byte sono quelli del bucket, presi dal percorso che la riga di archivio indica.
    expect(h.state.scaricati).toEqual([percorso])
    expect([...byte]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    // Nessun documento nuovo: niente riga in archivio, niente file caricato.
    expect(h.state.inserimenti.filter((i) => i.tabella === 'student_documents')).toEqual([])
    expect(h.state.caricamenti).toEqual([])
  })

  it('copia firmata: la lettura del fascicolo si registra come `download`, non come `view` e basta', async () => {
    alunnoIn()
    copiaFirmataInArchivio()

    await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    const azioni = accessiTracciati().map((r) => r.azione)
    // Due fatti diversi: «ho aperto l'anagrafica» e «mi sono portato via il documento
    // firmato». Il giorno in cui una famiglia chiede chi ha toccato il fascicolo di suo
    // figlio, i due si leggono in modo diverso.
    expect(azioni).toContain('view')
    expect(azioni).toContain('download')
    expect(accessiTracciati().find((r) => r.azione === 'download')?.documento_id).toBe('doc-firmato-1')
  })

  it('copia firmata assente: 422 col suo motivo, e nessun tentativo di scaricare niente', async () => {
    alunnoIn()
    h.state.risposte['student_documents'] = [{ data: [], error: null }]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    // Il MOTIVO viaggia in un campo suo perché il pannello mostra la frase del CODICE e
    // butta via `error`: senza, la segreteria leggerebbe «completali in anagrafica».
    expect(json).toMatchObject({ codice: 'PRESTAMPATO_DATI_MANCANTI', motivo: 'copia_firmata_assente' })
    expect(h.state.scaricati).toEqual([])
  })

  it('copia firmata su un database senza l’enumerato: degrada pulito, non esplode', async () => {
    // Il DB E2E della CI è un progetto separato e non è migrato: `document_type` non conosce
    // gli slug dei prestampati, quindi il confronto risponde `22P02`. La risposta deve essere
    // la stessa che si dà quando la copia non c'è — perché davvero non c'è.
    alunnoIn()
    h.state.risposte['student_documents'] = [
      { data: null, error: { code: '22P02', message: 'invalid input value for enum document_type_enum' } },
    ]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.motivo).toBe('copia_firmata_assente')
    expect(h.state.scaricati).toEqual([])
  })

  it('🔴 la ROTTA stende la carta intestata: i due fogli nuovi non escono nudi', async () => {
    // È il difetto più grave possibile su questo ramo, e non lo vede nessun test sul motore:
    // «il motore è perfetto e nessuna rotta lo chiama, e il documento vero esce PEGGIO di
    // prima». `impaginazione.ts` non disegna più né banda né logo né piede — ce li ha la
    // carta vera — quindi un foglio a cui la rotta non la stende è un foglio bianco con del
    // testo sopra.
    //
    // La misura non è un numero cablato: è il CONFRONTO fra ciò che la rotta restituisce e
    // lo stesso documento composto senza carta. L'asset pesa circa un megabyte e il foglio
    // nudo qualche decina di chilobyte, quindi il rapporto è di un ordine di grandezza —
    // ma il test non ha bisogno di sapere quanto: misura tutte e due le cose.
    alunnoIn()

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'su_carta',
        consegnatoIl: '2026-08-10',
        risposte: RISPOSTE_PERMESSO,
      }),
    )
    const daRotta = new Uint8Array(await res.arrayBuffer())

    const voce = prestampato('permesso_orario')!
    const contesto = {
      soggetto: 'alunno' as const,
      prefill: {
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        sezioneId: SEZIONE,
        legaleRappresentante: null,
        dati: {
          alunno: { nome: 'Luca', cognome: 'Inventato', dataNascita: '2021-03-04', sezione: 'Coccinelle' },
          genitori: [],
          sede: { scuola_nome: 'Scuola Inventata', scuola_citta: 'Napoli' },
          scuola: {},
          annoScolastico: '2026/2027',
          dataOggi: '2026-08-16',
        },
      },
    }
    const nudo = componiPrestampato(
      voce,
      contesto,
      RISPOSTE_PERMESSO,
      { carta: cartaDelContesto(contesto) },
      'Inventata Anna',
      { modalita: 'su_carta', consegnatoIl: '2026-08-10' },
    )
    expect(nudo.ok).toBe(true)
    if (!nudo.ok) return

    expect(res.status).toBe(201)
    expect(daRotta.byteLength).toBeGreaterThan(nudo.pdf.byteLength * 10)
  })

  it('nessuna delle tre modalità consuma un numero di protocollo', async () => {
    // Tutti e sei hanno `protocollo: 'nessuno'` nel registro, ed è la premessa su cui
    // `componiModuloDiFamiglia` si permette di non passare da `assembla()`: se un giorno uno
    // di loro uscisse dalla scuola, questo test diventerebbe rosso prima del foglio.
    alunnoIn()
    copiaFirmataInArchivio()

    for (const corpo of [
      { modalita: 'copia_firmata', risposte: {} },
      { modalita: 'copia_vuota', risposte: {} },
      { modalita: 'su_carta', consegnatoIl: '2026-08-10', risposte: RISPOSTE_PERMESSO },
    ]) {
      await POST(
        reqGenera({ modello: 'permesso_orario', alunnoId: ALUNNO, scuolaId: SEDE, ...corpo }),
      )
    }

    expect(h.state.rpc).toEqual([])
  })

  // ─── 🔴 «Copia firmata» consegna SOLO ciò che risulta firmato ──────────────────
  //
  // Il difetto che questi test bloccano è il vincolo di tutto il ramo alla rovescia: la
  // segretaria chiede «la copia firmata», il pannello le dice che il foglio porta il
  // riquadro della firma elettronica, e la route le consegna «l'ultima riga di quel tipo» —
  // che dopo una trascrizione `su_carta` è la trascrizione. Il foglio finisce a un ente come
  // se fosse l'originale sottoscritto.
  //
  // `student_documents` non ha nessuna colonna che distingua l'originale firmato dalla
  // famiglia da una trascrizione o da una scansione. Quella colonna sta in `firme_documenti`
  // ed è `impronta_digitale`: lo SHA-256 dei byte che il genitore ha davvero sottoscritto.

  it('🔴 copia firmata: dopo una trascrizione su carta NON consegna il foglio della segreteria', async () => {
    alunnoIn()
    h.state.risposte['student_documents'] = [
      { data: [nelFascicoloSenzaFirma('doc-trascritto')], error: null },
    ]
    // Nessuna riga in `firme_documenti`: quei byte non li ha sottoscritti nessuno.

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    // Un motivo suo, e non `copia_firmata_assente`: «non c'è niente» e «c'è qualcosa che
    // nessuno ha firmato elettronicamente» mandano la segreteria in due direzioni diverse.
    expect(json).toMatchObject({
      codice: 'PRESTAMPATO_DATI_MANCANTI',
      motivo: 'copia_firmata_non_elettronica',
    })
    // E soprattutto: nessun byte è uscito.
    expect(res.headers.get('X-Prestampato-Modalita')).toBeNull()
  })

  it('copia firmata: l’impronta del file si confronta col registro FEA, non col tipo di documento', async () => {
    alunnoIn()
    const percorso = copiaFirmataInArchivio()

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    expect(res.status).toBe(200)
    expect(h.state.scaricati).toEqual([percorso])
    // La domanda posta al registro: quel tipo, e l'impronta di QUEI byte — nelle due forme,
    // perché le due mani che scrivono quel campo non concordano sul maiuscolo.
    const cercate = h.state.filtri.find(
      (f) => f.tabella === 'firme_documenti' && f.metodo === 'in' && f.args[0] === 'impronta_digitale',
    )?.args[1] as string[] | undefined
    expect(cercate).toContain(improntaFea(BYTE_COPIA_FIRMATA))
    expect(cercate).toContain(improntaFea(BYTE_COPIA_FIRMATA).toUpperCase())
  })

  it('copia firmata: la firma VERA esce anche quando la trascrizione su carta è più recente', async () => {
    // La sequenza naturale di questo ramo: la famiglia firma nell'app, poi consegna a mano un
    // secondo foglio e la segreteria lo trascrive. Le due righe hanno lo stesso
    // `document_type` e la trascrizione è più recente: «l'ultima di quel tipo» sarebbe sempre
    // lei, e la copia firmata vera non uscirebbe mai.
    alunnoIn()
    const percorsoFirmato = `${ALUNNO}/prestampati/permesso_orario-firmato.pdf`
    h.state.fileScaricabili[percorsoFirmato] = BYTE_COPIA_FIRMATA
    h.state.firmeFea['permesso_orario'] = [improntaFea(BYTE_COPIA_FIRMATA)]
    h.state.risposte['student_documents'] = [
      {
        data: [
          nelFascicoloSenzaFirma('doc-trascritto'),
          { id: 'doc-firmato-1', file_name: 'Permesso_firmato.pdf', storage_path: percorsoFirmato },
        ],
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )
    const byte = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Prestampato-Documento')).toBe('doc-firmato-1')
    expect([...byte]).toEqual([...BYTE_COPIA_FIRMATA])
    // La riga di audit nomina il documento CONSEGNATO, non quello letto e scartato.
    expect(accessiTracciati().find((r) => r.azione === 'download')?.documento_id).toBe('doc-firmato-1')
  })

  it('copia firmata: registro FEA illeggibile → 503, e nessun foglio esce lo stesso', async () => {
    // «Non ho potuto verificare» non è «è firmato». Il DB E2E della CI è un progetto separato
    // e non è migrato: qui la tabella potrebbe non esserci affatto (`42P01`).
    alunnoIn()
    copiaFirmataInArchivio()
    h.state.risposte['firme_documenti'] = [
      { data: null, error: { code: '42P01', message: 'relation "firme_documenti" does not exist' } },
    ]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    expect(res.status).toBe(503)
    expect(res.headers.get('X-Prestampato-Modalita')).toBeNull()
    // E l'audit non registra un download che non è avvenuto.
    expect(accessiTracciati().filter((r) => r.azione === 'download')).toEqual([])
  })

  // ─── Il tetto che limitava la correttezza, non il costo ───────────────────────

  /** Una riga marcata come trascrizione, cioè con la `descrizione` che questa route stessa scrive. */
  function trascrizioneSuCarta(id: string, slug = 'permesso_orario') {
    return { ...nelFascicoloSenzaFirma(id, slug), descrizione: `Permesso — modulo consegnato su carta` }
  }

  it('🔴 copia firmata: la finestra letta è più larga del tetto sugli scaricamenti', async () => {
    // ⚠️ FINO AL 2026-08-16 UN NUMERO SOLO governava le due cose, e il `.limit(5)` stava
    // sulla QUERY: ma leggere i metadati di una riga non costa un download, e cinque righe
    // più recenti bastavano a rendere la copia firmata vera irraggiungibile per sempre.
    alunnoIn()
    copiaFirmataInArchivio()

    await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    const limite = h.state.filtri.find(
      (f) => f.tabella === 'student_documents' && f.metodo === 'limit',
    )?.args[0] as number | undefined
    expect(limite, 'nessun .limit su student_documents').toBeTypeOf('number')
    // Il numero esatto non è il punto e non si incide qui: il punto è che la finestra dei
    // metadati non sia la stessa cosa del budget di scaricamenti.
    expect(limite!).toBeGreaterThan(5)
    // E il caso normale continua a costare UN download solo.
    expect(h.state.scaricati.length).toBe(1)
  })

  it('🔴 copia firmata: la copia vera esce anche da dietro sei trascrizioni su carta', async () => {
    // Il caso che il tetto unico rendeva impossibile: `permesso_orario` e `delega_ritiro` si
    // firmano più volte in un anno, e sei trascrizioni `su_carta` successive nascondevano la
    // copia firmata vera oltre la sesta riga. Col vecchio `.limit(5)` questa riga non veniva
    // nemmeno letta, e la risposta era un 422 che suonava come una constatazione.
    alunnoIn()
    const percorsoFirmato = `${ALUNNO}/prestampati/permesso_orario-firmato.pdf`
    h.state.fileScaricabili[percorsoFirmato] = BYTE_COPIA_FIRMATA
    h.state.firmeFea['permesso_orario'] = [improntaFea(BYTE_COPIA_FIRMATA)]
    h.state.risposte['student_documents'] = [
      {
        data: [
          ...Array.from({ length: 6 }, (_, i) => trascrizioneSuCarta(`doc-carta-${i}`)),
          { id: 'doc-firmato-1', file_name: 'Permesso_firmato.pdf', storage_path: percorsoFirmato },
        ],
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Prestampato-Documento')).toBe('doc-firmato-1')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...BYTE_COPIA_FIRMATA])
    // E non è costato sette download: le trascrizioni riconoscibili vanno in coda, quindi il
    // primo candidato scaricato è già quello giusto.
    expect(h.state.scaricati).toEqual([percorsoFirmato])
  })

  it('🔴 copia firmata: il marchio delle trascrizioni è QUELLO che la route stessa scrive', async () => {
    // La messa in coda delle trascrizioni si regge su una stringa condivisa fra due punti del
    // file: `descrizioneArchivio`, che la scrive, e `MARCHIO_SU_CARTA`, che la riconosce.
    // Due copie della stessa stringa divergono alla prima modifica, e la divergenza non
    // romperebbe niente in modo visibile: le trascrizioni tornerebbero in testa alla coda e si
    // mangerebbero il budget, in silenzio.
    //
    // Qui la `descrizione` non si scrive a mano: si fa archiviare un modulo su carta dalla
    // ROTTA e si riusa quella che ha scritto lei.
    alunnoIn()
    await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'su_carta',
        consegnatoIl: '2026-08-10',
        risposte: RISPOSTE_PERMESSO,
      }),
    )
    const descrizioneVera = String(
      h.state.inserimenti.find((i) => i.tabella === 'student_documents')?.valori.descrizione ?? '',
    )
    expect(descrizioneVera, 'la rotta non ha archiviato niente').not.toBe('')

    const percorsoFirmato = `${ALUNNO}/prestampati/permesso_orario-firmato.pdf`
    h.state.fileScaricabili[percorsoFirmato] = BYTE_COPIA_FIRMATA
    h.state.firmeFea['permesso_orario'] = [improntaFea(BYTE_COPIA_FIRMATA)]
    h.state.risposte['student_documents'] = [
      {
        data: [
          ...Array.from({ length: 6 }, (_, i) => ({
            ...nelFascicoloSenzaFirma(`doc-vero-carta-${i}`),
            descrizione: descrizioneVera,
          })),
          { id: 'doc-firmato-1', file_name: 'Permesso_firmato.pdf', storage_path: percorsoFirmato },
        ],
        error: null,
      },
    ]
    h.state.scaricati.length = 0

    alunnoIn()
    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Prestampato-Documento')).toBe('doc-firmato-1')
    // UN download solo: le sei trascrizioni sono state riconosciute e spostate in coda.
    expect(h.state.scaricati).toEqual([percorsoFirmato])
  })

  it('🔴 copia firmata: se il budget finisce prima delle righe, il rifiuto NON dice «nessuno di essi»', async () => {
    // «Non li ho guardati tutti» non è «nessuno è firmato». È lo stesso ragionamento che la
    // route applica al registro FEA illeggibile, e vale qui per lo stesso motivo: senza, il
    // pannello dichiarerebbe alla segreteria un fatto che il server non ha misurato.
    //
    // Nessuna riga porta il marchio delle trascrizioni: sono scansioni caricate a mano, cioè
    // il caso in cui l'ordinamento non può aiutare e il budget si esaurisce davvero.
    alunnoIn()
    h.state.risposte['student_documents'] = [
      {
        data: Array.from({ length: 9 }, (_, i) => nelFascicoloSenzaFirma(`doc-scansione-${i}`)),
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )
    const json = (await res.json()) as { motivo?: string; error?: string }

    expect(res.status).toBe(422)
    expect(json.motivo).toBe('copia_firmata_non_esaminata')
    // La frase dice «fra quelli esaminati», non «nessuno di essi».
    expect(json.error).toContain('fra quelli esaminati')
    // Il budget è stato speso tutto e non di più: cinque scaricamenti, non nove.
    expect(h.state.scaricati.length).toBe(5)
    // E nessun foglio è uscito lo stesso.
    expect(res.headers.get('X-Prestampato-Modalita')).toBeNull()
  })

  it('copia firmata: esaminate TUTTE le righe, il rifiuto torna a essere «nessuno di essi»', async () => {
    // Il caso simmetrico, senza il quale il test qui sopra non proverebbe niente: quando le
    // righe stanno dentro il budget, «nessuno di essi risulta firmato» è una constatazione
    // vera e il motivo deve restare quello di prima.
    alunnoIn()
    h.state.risposte['student_documents'] = [
      {
        data: Array.from({ length: 3 }, (_, i) => nelFascicoloSenzaFirma(`doc-scansione-${i}`)),
        error: null,
      },
    ]

    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_firmata',
        risposte: {},
      }),
    )

    expect(res.status).toBe(422)
    expect((await res.json()).motivo).toBe('copia_firmata_non_elettronica')
    expect(h.state.scaricati.length).toBe(3)
  })

  // ─── Il foglio di carta: cosa ci finisce sopra, e su quante pagine ─────────────

  it('🔴 copia vuota: l’ultima pagina porta contenuto del modulo, non la sola firma sospesa nel vuoto', async () => {
    // LA PROVA VISIVA, MESSA IN UN TEST. `eslint`, `tsc` e i test sulle opzioni restano tutti
    // verdi anche quando il foglio esce con una PAGINA ORFANA: l'ultima con «Data della firma
    // ___ / Firma del genitore/tutore ___» in cima, «Luogo e data» sospeso a metà foglio e un
    // terzo di pagina di bianco sotto. Misurato il 2026-08-16 sui PDF veri: capitava su 4 dei
    // 6 moduli di famiglia.
    //
    // L'invariante non è «una pagina sola» — un modulo lungo può legittimamente farne due —
    // ma «l'ultima pagina porta anche il MODULO». Il giorno in cui un modulo cresce fino a
    // spezzarsi di nuovo, questo test diventa rosso e chiede la riparazione vera: una
    // variante `{tipo:'penna'}` di `FirmaPrestampato` che faccia disegnare la riga da firmare
    // a `disegnaFirma` insieme a «Luogo e data», come blocco unico e misurato.
    /** Slug → righe di MODULO trovate sull'ultima pagina. Zero = pagina orfana. */
    const ultimaPagina: Record<string, string[]> = {}

    for (const slug of SEI_MODULI) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      expect(res.status, slug).toBe(201)
      const pagine = await testoPerPagina(new Uint8Array(await res.arrayBuffer()))
      ultimaPagina[slug] = moduloSullUltimaPagina(pagine)
    }

    // Tutti e sei in un colpo solo, e non uno alla volta: un `expect` dentro il ciclo si
    // ferma al primo, e i moduli che si spezzano non sono mai i primi dell'elenco.
    const orfani = Object.entries(ultimaPagina)
      .filter(([, righe]) => righe.length === 0)
      .map(([slug]) => slug)
    expect(orfani, `pagina orfana su: ${orfani.join(', ')}`).toEqual([])
  })

  it('🔴 copia vuota: la riga da firmare a penna sta accanto a «Luogo e data», su una riga sola', async () => {
    // Le due metà della stessa firma erano impaginate da due meccanismi diversi — la riga da
    // firmare scorreva col testo, «Luogo e data» stava ancorato fra y=150 e y=240 — e appena
    // il contenuto arrivava in fondo si spezzavano su due pagine. Ora sono una cosa sola.
    //
    // Il test non guarda il codice ma il FOGLIO: la riga della firma e quella del luogo
    // devono essere la stessa riga estratta dal PDF. E deve starci: la stringa è più lunga
    // di quella normale e, se sfondasse i 166 mm fra i margini, `doc.text` NON manda a capo
    // — la scriverebbe fin dentro il margine destro, e nessun test sulle opzioni lo vedrebbe.
    for (const slug of SEI_MODULI) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      const pagine = await testoPerPagina(new Uint8Array(await res.arrayBuffer()))
      const righe = (pagine[pagine.length - 1] ?? '').split('\n').map((r) => normalizza(r))

      const conFirma = righe.filter((r) => r.includes('Firma del genitore/tutore'))
      expect(conFirma.length, `${slug} — righe con la firma: ${JSON.stringify(conFirma)}`).toBe(1)
      // La stessa riga porta anche il luogo: è ciò che prova che non si sono separate.
      expect(conFirma[0], slug).toContain('lì')
      // E non è andata a capo dentro il margine: la riga successiva non è una coda di
      // trattini bassi orfani.
      expect(righe.some((r) => /^_+$/.test(r)), slug).toBe(false)
    }
  })

  it('🔴 copia vuota: l’ULTIMA pagina porta qualcosa da COMPILARE, non solo da leggere', async () => {
    // ⚠️ QUESTO DIFETTO L'HA TROVATO LA PROVA VISIVA, non i test: rimettere le istruzioni ha
    // portato `dieta_speciale` da una pagina a due, e la seconda conteneva SOLO «Una data di
    // scadenza, oppure la dicitura riportata sul certificato…» — cioè la nota di un campo che
    // era rimasto sull'altro foglio, sopra due terzi di pagina bianca.
    //
    // Il lock precedente — «l'ultima pagina porta contenuto del modulo» — restava VERDE:
    // un'istruzione è contenuto. Qui si chiede di più, cioè che sull'ultima pagina ci sia
    // qualcosa da COMPILARE.
    //
    // ⚠️ E IL NOME DI QUESTO TEST È STATO CORRETTO. Si chiamava «nessuna istruzione resta
    // ORFANA su una pagina senza la sua domanda» e non poteva accorgersene: guarda l'ULTIMA
    // pagina, quindi una nota rimasta sola in fondo a una pagina INTERMEDIA gli è invisibile
    // per costruzione — ed è esattamente il difetto che il foglio aveva mentre lui era
    // verde. Quel controllo esiste adesso davvero, ed è il test qui sotto.
    for (const slug of SEI_MODULI) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      const pagine = await testoPerPagina(new Uint8Array(await res.arrayBuffer()))
      if (pagine.length < 2) continue

      const istruzioni = (modelloGenitore(slug)?.campi ?? [])
        .map((c) => aiutoDaStampare(c, slug))
        .filter((a): a is string => !!a)
        .map((a) => normalizza(a))
      const daCompilare = moduloSullUltimaPagina(pagine).filter(
        (riga) => !istruzioni.some((i) => i.includes(riga) || riga.includes(i)),
      )
      expect(
        daCompilare,
        `${slug} — l'ultima pagina porta solo istruzioni, nessun campo da compilare`,
      ).not.toEqual([])
    }
  })

  it('🔴 copia vuota: nessuna istruzione resta ORFANA su una pagina senza la sua domanda', async () => {
    // IL CONTROLLO CHE IL NOME PROMETTE, e che per due giorni non è stato fatto: **su OGNI
    // pagina**, non solo sull'ultima. Per ciascuna istruzione stampata si guarda la pagina
    // che la contiene e ci si chiede se contiene anche l'ETICHETTA del campo a cui
    // appartiene. Una nota separata dalla domanda che spiega non spiega più niente, e non
    // conta se il salto cade sull'ultima pagina o su una intermedia: su `dieta_speciale` il
    // difetto è stato prima sulla seconda pagina, poi — «riparato» — in fondo alla prima.
    //
    // ─── LA CAUSA, MISURATA E NON DEDOTTA ──────────────────────────────────────────
    //
    // `buildPrestampatoPdf` dà all'ULTIMO blocco di contenuto un limite più stretto che a
    // tutti gli altri (`limitePerUltimoBlocco`, per riservare il posto alla firma). Nota e
    // campo sono DUE blocchi: quello che capita per ultimo viene misurato contro un limite
    // diverso dal suo compagno, e la coppia si spacca **per costruzione** ogni volta che il
    // foglio arriva pieno fin lì. Provato in laboratorio sui blocchi veri di
    // `dieta_speciale`: con un blocco qualunque aggiunto in coda — cioè col campo che non è
    // più l'ultimo — nota e campo restano insieme; fondendo i due in UN SOLO blocco si
    // spostano insieme sulla pagina nuova, che così porta anche qualcosa da compilare.
    // Invertire l'ordine non serve: si sposta di lato lo stesso difetto.
    //
    // ⚠️ LA RIPARAZIONE VERA È QUINDI UN BLOCCO `{ tipo: 'gruppo', blocchi: [...] }` in
    // `src/lib/prestampati/tipi.ts` + `preferisciBloccoIntero` sull'insieme in
    // `src/lib/prestampati/impaginazione.ts` — il motore, che non appartiene a questo
    // workstream. Finché non c'è, il residuo MISURATO sta scritto qui sotto invece che
    // dichiarato riparato: l'elenco è esatto, quindi questo test diventa rosso sia se
    // l'orfana si moltiplica sia il giorno in cui il `gruppo` arriva e la lista va svuotata.
    const ATTESE_ORFANE = ['dieta_speciale.validita']

    const orfane: string[] = []
    let controllate = 0
    for (const slug of SEI_MODULI) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      expect(res.status, slug).toBe(201)
      const pagine = (await testoPerPagina(new Uint8Array(await res.arrayBuffer()))).map((p) =>
        normalizza(p),
      )

      for (const campo of modelloGenitore(slug)?.campi ?? []) {
        const istruzione = aiutoDaStampare(campo, slug)
        if (!istruzione) continue
        // I primi 40 caratteri: bastano a riconoscerla e non dipendono da come
        // l'impaginatore manda a capo (il testo di pagina è già normalizzato).
        const ago = normalizza(istruzione).slice(0, 40)
        const conNota = pagine.filter((p) => p.includes(ago))
        expect(conNota.length, `${slug}.${campo.nome} — istruzione non stampata`).toBeGreaterThan(0)
        controllate += 1
        // L'etichetta esce sempre coi due punti, che il modello li scriva o no
        // (`preparaCella`): si cerca la sola etichetta, che è il pezzo stabile.
        const domanda = normalizza(campo.etichetta.trim().replace(/:+$/, ''))
        if (!conNota.every((p) => p.includes(domanda))) orfane.push(`${slug}.${campo.nome}`)
      }
    }

    // Senza questo, il giorno in cui gli aiuti sparissero dai modelli il ciclo girerebbe a
    // vuoto e l'elenco vuoto sembrerebbe una vittoria.
    expect(controllate, 'nessuna istruzione controllata').toBeGreaterThanOrEqual(14)
    expect(orfane.sort(), 'istruzioni separate dalla loro domanda da un salto pagina').toEqual(
      ATTESE_ORFANE,
    )

    // ─── CONTROLLO NEGATIVO ────────────────────────────────────────────────────────
    //
    // Un criterio che non trova mai niente è indistinguibile da un foglio sano, ed è il modo
    // in cui il lock precedente è rimasto verde su un difetto vero. Qui si prova che sa
    // vedere un caso NUOVO: si sposta in basso la quota di partenza della delega — come
    // farebbe un'intestazione di sede più alta, un nome di scuola che va a capo, un campo in
    // più — e si pretende che l'orfana salti fuori. Vale anche come misura di quanto il
    // difetto sia LATENTE: non è un incidente di `dieta_speciale`, è la coppia nota/campo che
    // si spacca ovunque il foglio arrivi pieno al confine.
    const modelloDelega = modelloGenitore('delega_ritiro')!
    const trovateSpostando: string[] = []
    for (const mm of [12, 18, 24, 30, 36]) {
      const base = blocchiModuloVuoto(modelloDelega, DATI_PER_MODULO_VUOTO)
      const spostati: BloccoPrestampato[] = [base[0]!, { tipo: 'spazio', mm }, ...base.slice(1)]
      const pdf = buildPrestampatoPdf({
        intestazione: ['Scuola Inventata', 'Napoli'],
        titolo: modelloDelega.titolo,
        protocollo: null,
        blocchi: spostati,
        luogoData: 'Napoli, lì ____________  Firma del genitore/tutore ____________________',
        firma: { tipo: 'nessuna' },
        verifica: null,
      })
      const pg = (await testoPerPagina(pdf)).map((p) => normalizza(p))
      for (const campo of modelloDelega.campi) {
        const istruzione = aiutoDaStampare(campo, 'delega_ritiro')
        if (!istruzione) continue
        const conNota = pg.filter((p) => p.includes(normalizza(istruzione).slice(0, 40)))
        const domanda = normalizza(campo.etichetta.trim().replace(/:+$/, ''))
        if (conNota.length > 0 && !conNota.every((p) => p.includes(domanda))) {
          trovateSpostando.push(`${mm}mm:${campo.nome}`)
        }
      }
    }
    expect(
      trovateSpostando,
      'il criterio non ha trovato NESSUNA orfana nemmeno spostando il foglio: non può fallire',
    ).not.toEqual([])
  })

  it('🔴 copia vuota: la nota di una domanda di una riga sta IMMEDIATAMENTE SOPRA di lei', () => {
    // 🔴 SULLO STESSO FOGLIO LA NOTA STAVA SOPRA PER UN CAMPO E SOTTO PER UN ALTRO, benché i
    // due si disegnino identici — etichetta e filetto sulla stessa riga. Su
    // `permesso_orario`, «Il giorno a cui il permesso si riferisce…» stava sopra «Giorno del
    // permesso», mentre «Solo il genitore o una persona già delegata…» stava SOTTO «Chi
    // accompagna o ritira il bambino/a» e finiva incollata alla domanda successiva
    // («Permesso ricorrente — giorni»), di cui sembrava la didascalia. Il ramo dimenticato
    // era quello dei campi a elenco CHIUSO rimasti senza voci — cioè, sul foglio, proprio le
    // righe che dicono chi può portare via un minore.
    //
    // Si misura sull'ALBERO DEI BLOCCHI e non sul PDF: sul foglio «sopra» e «sotto» sono due
    // quote, e a cavallo di un salto pagina la nota di sopra finisce sotto tutto. L'indice
    // dei blocchi è la stessa regola senza l'ambiguità.
    let controllati = 0
    for (const slug of SEI_MODULI) {
      const modello = modelloGenitore(slug)!
      const blocchi = blocchiModuloVuoto(modello, DATI_PER_MODULO_VUOTO)

      for (const campo of modello.campi) {
        const istruzione = aiutoDaStampare(campo, slug)
        if (!istruzione) continue
        const etichetta = campo.etichetta.trim()
        // «Si disegna come una riga sola» = c'è un blocco `campi` che porta questa etichetta.
        // Le domande a caselle, le tabelle e gli allegati hanno altre forme e altre regole.
        const iCampo = blocchi.findIndex(
          (b) => b.tipo === 'campi' && b.campi.some((c) => c.etichetta.trim() === etichetta),
        )
        if (iCampo < 0) continue
        const iNota = blocchi.findIndex((b) => b.tipo === 'paragrafo' && b.testo === istruzione)

        expect(iNota, `${slug}.${campo.nome} — la nota non è un blocco a sé`).toBeGreaterThanOrEqual(0)
        expect(
          iCampo,
          `${slug}.${campo.nome} — la nota è all'indice ${iNota}, la domanda al ${iCampo}: ` +
            'sotto il filetto si legge come didascalia della domanda che segue',
        ).toBe(iNota + 1)
        controllati += 1
      }
    }
    // Cinque campi di una riga portano una nota sui sei moduli (misurato, non dichiarato):
    // sotto questa soglia il ciclo ha girato a vuoto e il test non ha provato niente.
    expect(controllati, 'nessun campo di una riga con nota').toBeGreaterThanOrEqual(5)
  })

  it('🔴 copia vuota: OGNI istruzione di compilazione arriva sul foglio', async () => {
    // ⚠️ IL DIFETTO CHE QUESTO TEST ESISTE PER NON FAR RIPETERE: il 2026-08-16 le istruzioni
    // sono state tolte TUTTE per ripararne poche. Il foglio stampa tutti i campi
    // condizionali, quindi `dieta_speciale` finiva per dire «Certificato medico: da allegare
    // al modulo.» senza il suo unico qualificatore — «Obbligatorio quando la dieta ha natura
    // sanitaria» — a una madre che chiede una dieta vegetariana. Sono fogli su farmaci,
    // diete e chi può portare via un bambino, compilati a casa senza nessuno a cui chiedere.
    //
    // Il test conta gli aiuti dai MODELLI e li cerca sul PDF: così il numero (oggi 14) vive
    // nella misura e non in un commento che invecchia.
    let controllate = 0
    for (const slug of SEI_MODULI) {
      const modello = modelloGenitore(slug)
      expect(modello, slug).toBeTruthy()
      const istruzioni = (modello?.campi ?? [])
        .map((c) => aiutoDaStampare(c, slug))
        .filter((a): a is string => !!a)
      // Senza questo, il giorno in cui un modello perdesse tutti gli aiuti il ciclo qui sotto
      // girerebbe a vuoto e il test passerebbe senza aver provato niente.
      expect(istruzioni.length, `${slug} — nessuna istruzione da controllare`).toBeGreaterThan(0)

      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      const testo = normalizza(await estraiTesto(new Uint8Array(await res.arrayBuffer())))

      for (const istruzione of istruzioni) {
        // I primi 40 caratteri bastano e non dipendono da come l'impaginatore manda a capo.
        expect(testo, `${slug} — «${istruzione.slice(0, 40)}…»`).toContain(
          normalizza(istruzione).slice(0, 40),
        )
        controllate += 1
      }
    }
    // I sei moduli di famiglia portano più di una decina di istruzioni: se domani ne
    // restassero due, il conto lo dice invece di lasciarlo credere.
    expect(controllate).toBeGreaterThanOrEqual(14)
  })

  it('🔴 copia vuota: le frasi che parlano dell’APP restano fuori dal foglio', async () => {
    // L'altra metà della stessa regola. «Sul cartaceo si dava per scontato "oggi": in app va
    // detto…» stampata su un modulo di carta si contraddice da sola; «È il motivo per cui
    // questa scheda esiste» è una giustificazione interna di progetto. Il foglio non le porta
    // perché `AIUTO_SU_CARTA` le riscrive — e questo test è ciò che tiene ferme le
    // riscritture: toglierne una fa tornare la frase dell'app sulla carta.
    //
    // ⚠️ LA PRIMA VERSIONE DI QUESTO TEST NON POTEVA FALLIRE, ed è stato scoperto rompendo il
    // codice apposta: cercava le frasi dell'app **solo sui campi che la tabella riscrive**,
    // quindi togliere una riscrittura toglieva anche il controllo su quel campo e il test
    // restava verde. Il criterio ora è INDIPENDENTE dalla tabella: un elenco di frammenti che
    // sullo schermo hanno senso e sulla carta no, cercati su tutto il foglio.
    //
    // I frammenti sono copiati alla lettera da `modelli/genitore.ts`, e il primo blocco
    // verifica che ognuno esista ancora là dentro: il giorno in cui il modello riscrivesse un
    // aiuto, un frammento diventerebbe irraggiungibile e questo elenco marcirebbe in silenzio.
    // ⚠️ E LA SECONDA VERSIONE NON POTEVA TROVARE UN CASO **NUOVO**: i sei frammenti erano
    // presi tutti dalle sei riscritture già fatte, quindi l'elenco copriva esattamente ciò
    // che era già riparato e nient'altro. Quattro frasi dell'app arrivavano intatte sul
    // foglio col test verde — fra cui «Governa il resto del modulo», che descrive la
    // visibilità condizionale di un form davanti a una madre con un foglio stampato per
    // intero, e «Chi non risponde entro il termine non è nell'elenco dei partecipanti», che
    // rimanda a una scadenza e a un elenco che sul foglio non esistono.
    //
    // I frammenti sotto la riga sono il criterio INDIPENDENTE dalla tabella: parole che
    // nominano una schermata, uno stato interno o una scadenza che il foglio non porta.
    // Sono stati scelti guardando gli aiuti che NON erano riscritti, non quelli che lo
    // erano, ed è questa la differenza fra un elenco che accompagna una riparazione e un
    // elenco che ne trova una nuova.
    const FRAMMENTI_DELL_APP = [
      'in app va detto',
      'sparisce dalla sezione',
      'È il motivo per cui questa scheda esiste',
      'I delegati diventano attivi',
      'si disattivano da soli',
      'non sulle risposte',
      // ─── il criterio indipendente dalla tabella ───
      /** Descrive la visibilità condizionale del form: sulla carta non governa niente. */
      'Governa il resto del modulo',
      /** Un elenco di partecipanti e un termine che sul foglio non sono scritti da nessuna parte. */
      'elenco dei partecipanti',
      'entro il termine',
      /** «bloccante» è il vocabolario di un campo di form, non di un modulo di carta. */
      'è bloccante',
      /** «attivo» è lo stato che l'app tiene sui delegati: sul foglio esiste la delega firmata. */
      'delegato attivo',
      /** La riga del fascicolo dentro l'app: il foglio una scadenza propria non ce l'ha. */
      'scadenza del documento',
    ]
    const TUTTI_GLI_AIUTI = normalizza(
      SEI_MODULI.flatMap((s) =>
        (modelloGenitore(s)?.campi ?? []).map((c) => (c as { aiuto?: string }).aiuto ?? ''),
      ).join(' | '),
    )
    for (const frammento of FRAMMENTI_DELL_APP) {
      expect(
        TUTTI_GLI_AIUTI,
        `«${frammento}» non è più in modelli/genitore.ts: l'elenco va aggiornato`,
      ).toContain(normalizza(frammento))
    }

    for (const slug of SEI_MODULI) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      const foglio = normalizza(await estraiTesto(new Uint8Array(await res.arrayBuffer())))
      for (const frammento of FRAMMENTI_DELL_APP) {
        expect(foglio, `${slug} — «${frammento}» è finito sul foglio`).not.toContain(
          normalizza(frammento),
        )
      }
    }
    /**
     * Il pezzo che la riscrittura ha buttato via: tutto ciò che segue il prefisso in comune
     * fra la frase dello schermo e quella della carta.
     *
     * Non si cerca l'intera frase originale, e il perché è un difetto che questo test ha
     * avuto per davvero: quasi tutte le riscritture sono TRONCAMENTI, quindi la frase della
     * carta è un prefisso di quella dello schermo — cercare l'originale «dai primi 40
     * caratteri» trovava il prefisso legittimo e falliva sempre. Il pezzo scartato, invece,
     * è esattamente ciò che non deve arrivare sul foglio.
     */
    function codaScartata(originale: string, suCarta: string): string {
      let i = 0
      while (i < originale.length && i < suCarta.length && originale[i] === suCarta[i]) i += 1
      return originale.slice(i).replace(/^[\s.,;:—-]+/, '').trim()
    }

    let riscritte = 0
    for (const slug of SEI_MODULI) {
      const modello = modelloGenitore(slug)!
      const daRiscrivere = modello.campi.filter((c) => {
        const originale = (c as { aiuto?: string }).aiuto?.trim()
        return !!originale && aiutoDaStampare(c, slug) !== originale
      })
      if (daRiscrivere.length === 0) continue

      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      const testo = normalizza(await estraiTesto(new Uint8Array(await res.arrayBuffer())))

      for (const campo of daRiscrivere) {
        const originale = normalizza((campo as { aiuto?: string }).aiuto!.trim())
        const coda = codaScartata(originale, normalizza(aiutoDaStampare(campo, slug)!))
        // Una coda vuota vorrebbe dire «riscrittura che non toglie niente»: il test non
        // avrebbe niente da cercare e passerebbe a vuoto.
        expect(coda.length, `${slug}.${campo.nome} — la riscrittura non toglie niente`).toBeGreaterThan(10)
        expect(testo, `${slug}.${campo.nome} — «${coda.slice(0, 50)}…»`).not.toContain(coda)
        riscritte += 1
      }
    }
    expect(riscritte, 'nessuna riscrittura verificata').toBeGreaterThan(0)
  })

  it('🔴 AIUTO_SU_CARTA non ha voci morte: ogni riscrittura punta a un campo che esiste', () => {
    // Una chiave orfana — il modello rinomina il campo, la riscrittura resta lì — non
    // romperebbe niente: farebbe tornare in silenzio sul foglio la frase dell'app che quella
    // riscrittura serviva a togliere.
    expect(CHIAVI_AIUTO_SU_CARTA.length, 'la tabella è vuota').toBeGreaterThan(0)
    for (const chiave of CHIAVI_AIUTO_SU_CARTA) {
      const [slug, nome] = chiave.split('.')
      const modello = modelloGenitore(slug!)
      expect(modello, `${chiave} — modello inesistente`).toBeTruthy()
      const campo = modello!.campi.find((c) => c.nome === nome)
      expect(campo, `${chiave} — campo inesistente`).toBeTruthy()
      // E deve avere un aiuto da riscrivere: riscrivere il nulla è una voce morta anche
      // quando il campo esiste.
      expect((campo as { aiuto?: string }).aiuto?.trim(), `${chiave} — nessun aiuto`).toBeTruthy()
      expect(aiutoDaStampare(campo!, slug!), `${chiave} — riscrittura identica`).not.toBe(
        (campo as { aiuto?: string }).aiuto!.trim(),
      )
    }
  })

  it('🔴 copia vuota: l’istruzione non è in GRASSETTO, e il grassetto resta alle domande', () => {
    // ⚠️ IL NOME DI QUESTO TEST DICEVA UNA COSA E L'ASSERZIONE NE FACEVA UN'ALTRA. Si
    // chiamava «l'istruzione è SUBORDINATA alla domanda, non più nera di lei» e verificava
    // soltanto `stile !== 'grassetto'`: cioè la FACCIA del carattere, non il corpo e non il
    // colore. La subordinazione non la misurava nessuno — e infatti non c'è: la misura vera
    // sta nel test qui sotto, che legge corpo e colore dal PDF. Qui resta ciò che questo
    // controllo sa davvero fare, col nome che lo dice.
    //
    // ⚠️ IL TEST NASCE DA UNA MISURA SBAGLIATA, e il modo in cui è stata sbagliata conta più
    // del risultato. Una costante `STILE_NON_RESO = 'corsivo'` vietava il corsivo «perché la
    // pagina non lo rende, mentre il grassetto arriva». Rimisurato con DUE rasterizzatori
    // sullo stesso PDF: sotto `pdftoppm -r 300` (poppler) le quattro varianti di Helvetica
    // escono IDENTICHE — nemmeno il grassetto arriva — e sotto `qlmanage -t` (CoreGraphics:
    // Anteprima, Quick Look, la stampa di macOS) il corsivo esce inclinato e il grassetto
    // nero. La premessa descriveva un rasterizzatore, non il documento.
    //
    // Il rimpiazzo aveva quindi reso l'introduzione e le righe degli allegati il testo più
    // pesante del foglio: cioè l'errore che il commento condannava due paragrafi più su.
    let domandeInGrassetto = 0
    let istruzioniViste = 0
    for (const slug of SEI_MODULI) {
      const modello = modelloGenitore(slug)!
      const blocchi = blocchiModuloVuoto(modello, DATI_PER_MODULO_VUOTO)
      const paragrafi = blocchi.filter(
        (b): b is Extract<typeof b, { tipo: 'paragrafo' }> => b.tipo === 'paragrafo',
      )

      // L'introduzione — «Modulo da compilare e firmare a penna…» — è un'istruzione di
      // servizio: in grassetto sarebbe più vistosa dei titoli di sezione.
      const intro = paragrafi[0]
      expect(intro?.testo, slug).toContain('Modulo da compilare e firmare a penna')
      expect(intro?.stile, `${slug} — l'introduzione non può essere il testo più nero`).toBe(
        'corsivo',
      )

      // Le righe degli allegati sono istruzioni, non domande a cui si risponde sul foglio.
      for (const p of paragrafi.filter((p) => p.testo.includes('da allegare al modulo'))) {
        expect(p.stile, `${slug} — «${p.testo}»`).toBe('corsivo')
      }

      // E ogni istruzione stampata è subordinata: mai in grassetto.
      const istruzioni = new Set(
        modello.campi.map((c) => aiutoDaStampare(c, slug)).filter((a): a is string => !!a),
      )
      expect(istruzioni.size, `${slug} — nessuna istruzione sul foglio`).toBeGreaterThan(0)
      const inGrassetto = paragrafi.filter((p) => p.stile === 'grassetto' && istruzioni.has(p.testo))
      expect(inGrassetto, `${slug} — istruzioni in grassetto`).toEqual([])
      istruzioniViste += paragrafi.filter((p) => istruzioni.has(p.testo)).length

      domandeInGrassetto += paragrafi.filter(
        (p) => p.stile === 'grassetto' && p.testo.endsWith(':'),
      ).length
    }

    // I due presidi simmetrici, senza i quali il test non potrebbe diventare rosso: le
    // istruzioni arrivano davvero sui blocchi (non è passato a vuoto su un foglio che non ne
    // ha), e il grassetto NON è sparito dal modulo — le domande lo portano ancora. Il conto è
    // sui sei moduli insieme perché `autorizzazione_farmaci` non ha nessuna domanda a
    // caselle: è tutto date, testo e allegati.
    expect(istruzioniViste, 'nessuna istruzione stampata sui sei moduli').toBeGreaterThan(0)
    expect(domandeInGrassetto, 'il grassetto è sparito dalle domande').toBeGreaterThan(0)
  })

  it('🔴 copia vuota: l’istruzione esce PIÙ GRANDE e PIÙ NERA della domanda — gerarchia capovolta', async () => {
    // LA MISURA CHE MANCAVA, e che il nome del test qui sopra prometteva senza farla. Corpo e
    // colore si leggono dal PDF vero della rotta, dagli operatori di disegno: `setFont` porta
    // il corpo in punti, `setFillRGBColor` il colore con cui la riga successiva viene scritta.
    // Non è una lettura del codice che l'ha prodotto — quella resterebbe verde anche se il
    // foglio uscisse diverso.
    //
    // ⚠️ QUESTO TEST PINNA UN DIFETTO, NON UNA RIPARAZIONE. `BloccoPrestampato` ammette tre
    // stili — `normale`, `corsivo`, `grassetto` — e tutti e tre escono a 12 pt in `INCHIOSTRO`
    // (`disegnaParagrafo`), mentre l'etichetta di una domanda di una riga esce a 10 pt in
    // `GRIGIO` (`disegnaCella`). Passare da `grassetto` a `corsivo` cambia la faccia e basta:
    // l'occhio di chi compila cade sulla nota prima che sulla domanda, che è l'opposto di
    // ciò che serve su un modulo di dieta compilato a casa.
    //
    // La leva vera è uno `stile: 'nota'` a 10 pt `GRIGIO` in
    // `src/lib/prestampati/impaginazione.ts` — il motore, che non appartiene a questo
    // workstream. Finché non c'è, la gerarchia capovolta sta scritta qui come misura invece
    // che dichiarata riparata: il giorno in cui la nota diventa più piccola e più chiara
    // della domanda questo test diventa rosso e va riscritto al contrario, che è esattamente
    // ciò che deve succedere.
    alunnoIn()
    const res = await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'copia_vuota',
        risposte: {},
      }),
    )
    expect(res.status).toBe(201)

    const { getDocumentProxy } = await import('unpdf')
    const { OPS } = await import('unpdf/pdfjs')
    const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()).slice())
    const operatori = await (await doc.getPage(1)).getOperatorList()
    const nomeOp: Record<number, string> = {}
    for (const [k, v] of Object.entries(OPS as Record<string, number>)) nomeOp[v] = k

    /** Ogni stringa disegnata sulla pagina, col corpo e il colore con cui è stata scritta. */
    const scritte: { testo: string; corpo: number; colore: string }[] = []
    let colore = ''
    let corpo = 0
    operatori.fnArray.forEach((fn: number, i: number) => {
      const op = nomeOp[fn]
      const args = operatori.argsArray[i] as unknown[]
      if (op === 'setFillRGBColor') colore = String(args[0]).toLowerCase()
      if (op === 'setFont') corpo = Number(args[1])
      if (op === 'showText') {
        const glifi = (args[0] ?? []) as { unicode?: string }[]
        scritte.push({ testo: normalizza(glifi.map((g) => g.unicode ?? '').join('')), corpo, colore })
      }
    })
    expect(scritte.length, 'nessuna scritta letta dal PDF').toBeGreaterThan(20)

    const cerca = (inizio: string) => {
      const trovata = scritte.find((s) => s.testo.startsWith(normalizza(inizio)))
      expect(trovata, `«${inizio}» non è sulla prima pagina`).toBeTruthy()
      return trovata!
    }
    // Le due righe stanno una sopra l'altra sul foglio, e sono la coppia nota/domanda del
    // primo campo del permesso.
    const nota = cerca('Il giorno a cui il permesso si riferisce')
    const domanda = cerca('Giorno del permesso:')

    // La misura, oggi: la nota è più grande e più scura della domanda che spiega.
    expect(nota.corpo, 'corpo della nota').toBe(12)
    expect(domanda.corpo, 'corpo della domanda').toBe(10)
    expect(nota.corpo, 'la nota non è più grande della domanda: la gerarchia è cambiata').toBeGreaterThan(
      domanda.corpo,
    )
    expect(nota.colore, 'colore della nota (INCHIOSTRO)').toBe('#2d2d2d')
    expect(domanda.colore, 'colore della domanda (GRIGIO)').toBe('#646464')
    expect(nota.colore, 'nota e domanda hanno lo stesso colore: la gerarchia è cambiata').not.toBe(
      domanda.colore,
    )
  })

  it('🔴 copia vuota: dieta e farmaci non ORDINANO un allegato senza dire quando serve', async () => {
    // I due casi concreti, scritti a mano perché sono quelli che fanno danno a una famiglia.
    // Sul foglio della dieta i campi condizionali si stampano tutti: senza il qualificatore,
    // «Certificato medico: da allegare al modulo.» è un ordine rivolto anche a chi chiede una
    // dieta vegetariana o etico-religiosa, cioè un'affermazione falsa su un foglio sanitario.
    //
    // ⚠️ LE FRASI QUI SOTTO SONO QUELLE DELLA CARTA, non quelle dello schermo, e due sono
    // cambiate il 2026-08-16. Prima questo test PRETENDEVA sul foglio «Governa il resto del
    // modulo: …» e «l'allegato è bloccante»: la prima descrive la visibilità condizionale di
    // un form davanti a chi ha in mano il modulo stampato per intero, la seconda è il
    // vocabolario di un campo. Erano il difetto scritto dentro il suo stesso lock — che così
    // impediva la riparazione invece di chiederla. Restano scritte a mano, e non lette da
    // `aiutoDaStampare`: sono i due casi che fanno danno a una famiglia, e un test che le
    // rileggesse dalla stessa tabella che le produce non proverebbe niente.
    const casi = [
      {
        slug: 'dieta_speciale',
        allegato: 'Certificato medico: da allegare al modulo.',
        condizione: 'Obbligatorio quando la dieta ha natura sanitaria.',
        governo: 'Solo un motivo sanitario richiede il certificato medico.',
      },
      {
        slug: 'autorizzazione_farmaci',
        allegato: 'Prescrizione medica / piano terapeutico del pediatra: da allegare al modulo.',
        condizione:
          "Senza la prescrizione nessuno può somministrare nulla: senza l'allegato il modulo non si può accettare.",
        governo: null,
      },
    ] as const

    for (const caso of casi) {
      alunnoIn()
      const res = await POST(
        reqGenera({
          modello: caso.slug,
          alunnoId: ALUNNO,
          scuolaId: SEDE,
          modalita: 'copia_vuota',
          risposte: {},
        }),
      )
      const testo = normalizza(await estraiTesto(new Uint8Array(await res.arrayBuffer())))
      expect(testo, `${caso.slug} — la riga dell'allegato`).toContain(normalizza(caso.allegato))
      expect(testo, `${caso.slug} — la condizione dell'allegato`).toContain(
        normalizza(caso.condizione),
      )
      if (caso.governo) expect(testo, `${caso.slug} — il campo che governa`).toContain(normalizza(caso.governo))
    }
  })

  it('la dicitura del modulo su carta si chiama col suo nome, e la frase è quella dettata', async () => {
    // Il simbolo esportato si chiamava `diciturModuloSuCarta`: un identificatore pubblico
    // scritto male, in un repository pubblico e in un progetto la cui prima regola è che si
    // scrive in italiano. Un nome sbagliato si propaga a ogni chiamante.
    expect(dicituraModuloSuCarta('10/08/2026')).toBe(
      'Modulo consegnato su carta il 10/08/2026, firmato in originale agli atti',
    )
  })

  it('🔴 modulo su carta: il fascicolo dice che di quel foglio esiste un originale di carta', async () => {
    // Il suffisso è ciò che, fra sei mesi, distingue nell'elenco del fascicolo una
    // trascrizione della segreteria da un modulo firmato dalla famiglia nell'app: stesso
    // titolo, stesso `document_type`. Era difeso da un commento di sei righe e da nessun
    // test.
    alunnoIn()
    await POST(
      reqGenera({
        modello: 'permesso_orario',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        modalita: 'su_carta',
        consegnatoIl: '2026-08-10',
        risposte: RISPOSTE_PERMESSO,
      }),
    )

    const riga = h.state.inserimenti.find((i) => i.tabella === 'student_documents')
    expect(String(riga?.valori.descrizione)).toContain('modulo consegnato su carta')
  })

  it('il suffisso «su carta» NON compare su un documento che su carta non è tornato', async () => {
    // Il caso simmetrico, senza il quale il test qui sopra non potrebbe diventare rosso: un
    // suffisso appiccicato a tutto non distinguerebbe niente.
    alunnoIn()
    sedeInArchivio()

    await POST(
      reqGenera({
        modello: 'certificato_iscrizione_frequenza',
        alunnoId: ALUNNO,
        scuolaId: SEDE,
        risposte: {},
      }),
    )

    const riga = h.state.inserimenti.find((i) => i.tabella === 'student_documents')
    expect(riga, 'il certificato deve entrare nel fascicolo').toBeTruthy()
    expect(String(riga?.valori.descrizione)).not.toContain('modulo consegnato su carta')
  })
})
