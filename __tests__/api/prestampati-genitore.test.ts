// @vitest-environment node
//
// `node` e non il `jsdom` predefinito della suite: qui il PDF si legge davvero, e
// unpdf/PDF.js sotto jsdom restituisce stringa vuota — cioè la prova sulla riservatezza
// del foglio sarebbe stata verde senza guardare un byte. È la stessa dichiarazione che
// porta in testa `__tests__/lib/prestampati-impaginazione.test.ts`.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { estraiTesto } from '@/lib/protocolli/estrai'
import { redact, redactInput } from '@/lib/logging/redact'
import { codeHash } from '@/lib/auth/otp-ticket'
import {
  BUCKET_CERTIFICATI,
  BUCKET_FASCICOLO,
  componiDescrizioneUscita,
  datiUscitaDaEvento,
  fineAnnoScolastico,
  ilFileRestaNelBucket,
  magazziniAmmessi,
  motivoMancatoArchivioDa,
  SCHEMA_NON_PRONTO,
  SEMPRE_FIRMABILI_PREDEFINITI,
  sempreFirmabiliDa,
  titoloUscita,
} from '@/app/api/parent/prestampati/banco-famiglia'

/**
 * LE DUE ROTTE DEL GENITORE SUI PRESTAMPATI — collaudate dove il danno sarebbe vero.
 *
 * Non si verifica che il PDF sia bello: quello ha già i suoi test in
 * `__tests__/lib/prestampati-impaginazione.test.ts`. Qui si verifica ciò che solo la
 * rotta può sbagliare, e che nessun test di libreria vedrebbe:
 *
 *  · **chi firma** — senza identità non si entra, e il ticket OTP non è un lasciapassare
 *    per il bambino di un'altra famiglia;
 *  · **quando si genera** — un codice sbagliato non deve produrre NIENTE, e un codice
 *    già speso non deve produrlo due volte;
 *  · **che cosa finisce sul foglio** — nel PDF che la famiglia stampa e consegna non
 *    entrano l'hash dell'OTP né l'indirizzo IP: quelli vivono nel log di firma, che è un
 *    altro documento e si scarica a parte (§3a di `docs/prestampati/00-impaginazione.md`);
 *  · **che cosa finisce nei LOG** — da questa rotta passano la scheda sanitaria, i
 *    farmaci e la dieta di un minore, e un allergene in `app_log` è un incidente
 *    (AGENTS.md §8). Non si prende sulla fiducia: c'è un percorso completo sul n. 05 con
 *    un allergene inventato, e si controlla ogni singola chiamata al logger;
 *  · **che cosa RESTA in giro** — quando la riga d'archivio non nasce, nel bucket privato
 *    non deve rimanere un PDF che nessuna query nomina e nessun oblio raggiunge.
 *
 * ⚠️ IL PDF SI GENERA DAVVERO. `@/lib/prestampati/render` e l'impaginatore NON sono
 * mockati: il foglio che questi test leggono è lo stesso che riceve la famiglia. Mockarli
 * avrebbe reso verde la prova sulla riservatezza senza guardare un solo byte del
 * documento — cioè proprio la forma di test finto che il repo sta togliendo di mezzo.
 *
 * Nomi, email, indirizzi IP, allergeni, farmaci e uuid sono INVENTATI: il repository è
 * pubblico, e in produzione questi moduli portano dati sanitari di minori veri.
 */

// ─── I doppioni ─────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const state = {
    /** Risposte in coda per tabella, consumate in ordine. */
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    /**
     * Risposte SEMPRE VALIDE per tabella, quando la coda è finita.
     *
     * Serve alle letture che una stessa prova fa più volte: l'email autorevole del
     * genitore si legge nel POST (per spedire il codice) e di nuovo nel PATCH (per
     * ricalcolare l'HMAC). Con la sola coda, la seconda lettura tornava vuota e ogni
     * prova sulla firma finiva su «email non trovata» — un test verde o rosso per un
     * motivo che non c'entrava niente con quello che stava misurando.
     */
    fissi: {} as Record<string, { data: unknown; error: unknown }>,
    used: {} as Record<string, number>,
    inserimenti: [] as { tabella: string; righe: unknown }[],
    upload: [] as { percorso: string; byte: Uint8Array }[],
    rimossi: [] as string[],
    /**
     * I jti davvero finiti nello store dell'uso singolo.
     *
     * È l'unico pezzo di questo doppione ad avere MEMORIA, ed è deliberato: dopo
     * `consumeTicket` la rotta RILEGGE il jti, perché la dipendenza su un errore DB
     * inatteso fallisce aperto (dice sì senza aver scritto). Con un doppione senza
     * memoria quella rilettura avrebbe risposto «assente» anche sul percorso felice e
     * ogni firma sarebbe finita in 500: il test avrebbe misurato il doppione invece
     * della rotta.
     */
    jti: new Set<string>(),
    /** L'elenco dei bucket, e l'esito della creazione: entrambi `{ data, error }`. */
    bucketElenco: { data: [] as { name: string }[] | null, error: null as unknown },
    bucketCreazione: { data: null as unknown, error: null as unknown },
    bucketCreati: [] as { nome: string; opzioni: unknown }[],
    /**
     * Quante volte `listBuckets()` è stata chiamata in una richiesta.
     *
     * Si conta perché `garantisciBucket` serviva due punti — il controllo degli allegati e
     * l'upload — e li serviva con due chiamate: due giri di rete per ogni firma con
     * allegato, per una domanda la cui risposta non cambia dentro la stessa richiesta.
     */
    bucketElencati: 0,
    /**
     * I file che nel bucket ci sono DAVVERO — è ciò che `list()` risponde.
     *
     * Serve alla verifica degli allegati: il n. 06 dichiara una prescrizione medica e il n.
     * 08 la scansione del documento di ogni delegato, e finché la route non guardava se
     * quel file esistesse bastava una stringa qualunque per far spuntare sul PDF la casella
     * «Si allega prescrizione medica». Un insieme e non un booleano: la differenza fra
     * «caricato» e «non caricato» dev'essere per PERCORSO, o la prova non distinguerebbe
     * l'allegato giusto da uno qualsiasi.
     */
    oggetti: new Set<string>(),
    /** L'esito di `list()` quando lo storage non risponde: `{ data, error }`, come tutto il resto. */
    elencoOggetti: { errore: null as unknown },
    /**
     * I certificati medici DAVVERO caricati dalla famiglia, come `alunno_id|file_path`.
     *
     * È il secondo magazzino degli allegati, ed è quello che la specifica nomina per la
     * prescrizione del n. 06 e per il certificato del n. 07 (`certificati-medici`, l'unico
     * dei due che l'oblio raggiunge). Lì l'allegato non si verifica guardando lo storage: si
     * verifica sulla RIGA, `alunno_id` e `file_path` insieme — ed è per questo che la chiave
     * di questo insieme li contiene tutti e due. Un doppione che rispondesse «c'è» a
     * qualunque percorso avrebbe reso verde anche l'allegato di un altro bambino.
     */
    certificati: new Set<string>(),
    /**
     * I delegati al ritiro che il bambino ha DAVVERO, riga per riga.
     *
     * Serve al n. 09: chi ritira il bambino è un id scelto dal client, e la rotta lo risolve
     * in un nome con una query filtrata per `student_id` **e** `id`. Un doppione che
     * rispondesse la stessa riga a qualunque filtro avrebbe reso verde anche il delegato di
     * un'altra famiglia — cioè proprio la cosa che quella query esiste per impedire.
     */
    delegati: [] as {
      id: string
      student_id: string
      first_name: string | null
      last_name: string | null
      relation?: string | null
      document_number?: string | null
    }[],
    /** Le letture fatte, con i loro filtri: è così che si prova CHE COSA è stato filtrato. */
    letture: [] as { tabella: string; filtri: Record<string, unknown> }[],
    /**
     * Le chiamate a `prossimo_numero_protocollo`, e il numero che restituisce.
     *
     * Si CONTANO, e il conto è il punto: il registro di protocollo è WORM, e la regola del
     * riscarico dice che riprendere un certificato già emesso non deve consumare un secondo
     * numero. «Zero chiamate» è l'unica prova che quel numero non è stato bruciato — la
     * riga di `protocolli` mancante direbbe solo che non è stata scritta.
     */
    rpc: [] as { funzione: string; parametri: unknown }[],
    prossimoProtocollo: { data: 41 as unknown, error: null as unknown },
  }
  function prendi(tabella: string) {
    const q = state.queues[tabella] ?? []
    const i = state.used[tabella] ?? 0
    state.used[tabella] = i + 1
    return q[i] ?? state.fissi[tabella] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      rpc(funzione: string, parametri: unknown) {
        state.rpc.push({ funzione, parametri })
        return Promise.resolve(state.prossimoProtocollo)
      },
      from(tabella: string) {
        const qb: Record<string, unknown> = {}
        const filtri: Record<string, unknown> = {}
        let inserita: Record<string, unknown> | null = null
        for (const m of ['select', 'order', 'in', 'is', 'or', 'limit', 'match', 'filter']) {
          qb[m] = () => qb
        }
        // `eq` tiene il filtro: senza, la rilettura del jti non saprebbe QUALE riga cerca.
        qb.eq = (colonna: string, valore: unknown) => {
          filtri[colonna] = valore
          return qb
        }
        // I confronti d'ordine tengono il filtro come `eq`, con il verso nel nome: è così
        // che si prova che l'uscita si cerca «da oggi in avanti» e non a ritroso. Devono
        // esserci TUTTI e quattro: un metodo mancante nel doppione non fa fallire
        // l'asserzione — fa esplodere la route dentro il suo `try`, e il test misura un
        // 503 del doppione credendolo un 503 del prodotto (successo il 2026-08-16 con
        // `gte`).
        for (const m of ['gte', 'lte', 'gt', 'lt'] as const) {
          qb[m] = (colonna: string, valore: unknown) => {
            filtri[`${m}:${colonna}`] = valore
            return qb
          }
        }
        qb.insert = (righe: unknown) => {
          state.inserimenti.push({ tabella, righe })
          inserita = righe as Record<string, unknown>
          return qb
        }
        qb.update = () => qb
        /**
         * L'esito, con lo store dei jti che si comporta come una tabella vera: l'INSERT
         * registra il jti SOLO se la coda non gli ha imposto un errore, e la SELECT
         * risponde ciò che c'è davvero. La coda resta sopra a tutto — è così che si
         * simulano il replay (23505), lo store assente (42P01) e il guasto inatteso.
         */
        const risolvi = (forma: 'una' | 'elenco') => {
          const esito = prendi(tabella)
          if (!inserita) state.letture.push({ tabella, filtri: { ...filtri } })
          // La tabella dei certificati medici si comporta come una tabella vera: la coda può
          // imporre un errore (è così che si prova il 503 «non verificabile»), altrimenti
          // risponde ciò che c'è davvero PER QUEL BAMBINO.
          if (tabella === 'certificati_medici' && !inserita) {
            if (esito.error) return esito
            const chiave = `${String(filtri.alunno_id ?? '')}|${String(filtri.file_path ?? '')}`
            return { data: state.certificati.has(chiave) ? { id: 'certificato' } : null, error: null }
          }
          // Idem per i delegati, e per la stessa ragione: la coda resta sopra a tutto (è così
          // che si simulano la lettura fallita e l'elenco imposto dal GET), ma quando non dice
          // niente si risponde applicando DAVVERO i filtri della query.
          if (tabella === 'delegates' && !inserita) {
            if (esito.error || esito.data !== null) return esito
            const righe = state.delegati.filter((d) =>
              Object.entries(filtri).every(
                ([colonna, valore]) => (d as unknown as Record<string, unknown>)[colonna] === valore,
              ),
            )
            return { data: forma === 'una' ? (righe[0] ?? null) : righe, error: null }
          }
          if (tabella !== 'otp_ticket_consumati') return esito
          if (inserita) {
            if (!esito.error) state.jti.add(String(inserita.jti))
            return esito
          }
          if (esito.error) return esito
          const jti = String(filtri.jti ?? '')
          return { data: state.jti.has(jti) ? { jti } : null, error: null }
        }
        qb.single = () => Promise.resolve(risolvi('una'))
        qb.maybeSingle = () => Promise.resolve(risolvi('una'))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(risolvi('elenco')).then(res, rej)
        return qb
      },
      storage: {
        listBuckets: () => {
          state.bucketElencati += 1
          return Promise.resolve(state.bucketElenco)
        },
        createBucket: (nome: string, opzioni: unknown) => {
          state.bucketCreati.push({ nome, opzioni })
          return Promise.resolve(state.bucketCreazione)
        },
        from: () => ({
          upload: (percorso: string, byte: Uint8Array) => {
            // COPIA, e non il `Buffer` che la rotta ha passato: `Buffer.from()` alloca
            // dentro il pool di Node, e PDF.js — che «trasferisce» (detacha) l'ArrayBuffer
            // che riceve — su una memoria condivisa fallisce. `estraiTesto` inghiotte
            // l'errore e torna stringa vuota: la prova sulla riservatezza del foglio
            // sarebbe passata senza leggere un byte.
            state.upload.push({ percorso, byte: Uint8Array.from(byte) })
            return Promise.resolve({ data: { path: percorso }, error: null })
          },
          remove: (percorsi: string[]) => {
            state.rimossi.push(...percorsi)
            return Promise.resolve({ data: percorsi.map((p) => ({ name: p })), error: null })
          },
          /**
           * `list(cartella, { search })` come lo storage vero: elenca i figli DIRETTI della
           * cartella e filtra per sottostringa. Un elenco vuoto è un fatto — «il file non
           * c'è» — ed è la ragione per cui la route usa questa API invece di leggere il
           * messaggio d'errore di `createSignedUrl` per indovinare se «Object not found»
           * volesse dire «manca» o «storage in avaria».
           */
          list: (cartella: string, opzioni?: { search?: string }) => {
            if (state.elencoOggetti.errore) {
              return Promise.resolve({ data: null, error: state.elencoOggetti.errore })
            }
            const prefisso = cartella ? `${cartella}/` : ''
            const dentro = [...state.oggetti]
              .filter((p) => p.startsWith(prefisso) && !p.slice(prefisso.length).includes('/'))
              .map((p) => ({ name: p.slice(prefisso.length) }))
              .filter((o) => !opzioni?.search || o.name.includes(opzioni.search))
            return Promise.resolve({ data: dentro, error: null })
          },
          createSignedUrl: () =>
            Promise.resolve({ data: { signedUrl: 'https://firmato/prestampato' }, error: null }),
        }),
      },
    }
  }
  return { state, makeClient }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.makeClient()),
}))

/**
 * IL LOGGER SI REGISTRA, non si spegne — ed è il solo modo di provare la regola 8.
 *
 * `logOk`/`logErrore`/`logEvento` sono sostituiti da spie che tengono tutti gli argomenti;
 * tutto il resto del modulo resta VERO (`importOriginal`), perché `withRoute` e la
 * redazione ci passano dentro. Così «l'allergene non finisce nei log» si misura sulle
 * chiamate davvero fatte, invece di fidarsi del fatto che nessuno le abbia scritte.
 */
const spie = vi.hoisted(() => ({ chiamate: [] as unknown[][] }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  const spia =
    (nome: string) =>
    (...args: unknown[]) => {
      spie.chiamate.push([nome, ...args])
    }
  return { ...vero, logOk: spia('logOk'), logErrore: spia('logErrore'), logEvento: spia('logEvento') }
})

/**
 * IL CONTESTO DI `withRoute` SI REGISTRA, perché è il canale da cui i dati sanitari
 * uscivano davvero.
 *
 * `parseBody` deposita il corpo GREZZO della richiesta nello slot `body` PRIMA di zod, e
 * ogni riga persistita se lo porta in `app_log` dentro `contestoExtra.payload`. Il vero
 * modulo resta (`importOriginal`): qui si tiene solo l'elenco dei depositi, in ordine, così
 * la prova può leggere l'ULTIMO valore dello slot — quello che finirebbe in tabella — invece
 * di fidarsi di ciò che la route dice di aver fatto.
 */
const contestoSpia = vi.hoisted(() => ({ depositi: [] as { dove: string; valore: unknown }[] }))
vi.mock('@/lib/logging/context', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/context')>()
  return {
    ...vero,
    impostaPayload: (dove: string, valore: unknown) => {
      contestoSpia.depositi.push({ dove, valore })
      vero.impostaPayload(dove, valore)
    },
    impostaPayloadEsito: (dove: string, esito: string) => {
      contestoSpia.depositi.push({ dove, valore: { esito } })
      vero.impostaPayloadEsito(dove, esito)
    },
  }
})

const auth = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  requireParent: vi.fn(),
  loadAppUser: vi.fn(),
  resolveIdentity: vi.fn(),
  getRequestUserId: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => auth)

const portata = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => portata)

const sospensione = vi.hoisted(() => ({
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn(),
}))
vi.mock('@/lib/pagamenti/sospensione', () => sospensione)

const tetti = vi.hoisted(() => ({ limitaInvioOtp: vi.fn(), limitaVerificaOtp: vi.fn() }))
vi.mock('@/lib/security/otp-rate-limit', () => tetti)

const posta = vi.hoisted(() => ({ sendEmail: vi.fn(), sendEmailDetailed: vi.fn() }))
vi.mock('@/lib/email/send', () => posta)

/**
 * Il precompilato è dell'altra mano (`@/lib/prestampati/prefill`) e ha i suoi test: qui si
 * sostituisce con dati inventati, così le prove parlano della ROTTA e non delle otto query
 * di anagrafica che il precompilato fa per conto suo.
 *
 * ⚠️ È ANCHE IL GATE DELLA FAMIGLIA: `caricaPrefillAlunno` chiude la portata con
 * `requireParentOfStudent` al proprio interno, ed è per questo che negarlo qui è il modo
 * giusto di simulare «questo bambino non è suo» sul GET e sul PATCH. Sul POST il gate è
 * esplicito, perché là il precompilato non si carica affatto.
 */
const prefillMod = vi.hoisted(() => ({ caricaPrefillAlunno: vi.fn(), nucleoAlunno: vi.fn() }))
vi.mock('@/lib/prestampati/prefill', () => prefillMod)

/**
 * ⚠️ IN QUESTO FILE NON C'È NESSUN INTERRUTTORE, E LA SUA ASSENZA È UNA CORREZIONE.
 *
 * Per un ciclo qui viveva un `vi.mock` del banco che annullava il verdetto
 * `allegato-non-caricabile`, cioè spegneva una regola che il prodotto applica sempre, per far
 * arrivare sei prove fino alla scrittura dei delegati del n. 08. Quelle righe non erano
 * raggiungibili da nessuna richiesta — il n. 08 si rifiuta prima, perché la scansione del
 * documento di un terzo non ha nessuna porta da cui entrare — e un test che disattiva una
 * guardia per collaudare codice morto misura sé stesso.
 *
 * La scrittura in `delegates` è uscita dalla rotta e nascerà insieme alla porta che la rende
 * raggiungibile, con prove che gireranno sul prodotto vero. Ciò che resta qui misura il
 * rifiuto di OGGI, che è ciò che le famiglie incontrano.
 */

import { GET, POST as CHIEDI_DOCUMENTO } from '@/app/api/parent/prestampati/route'
import { POST, PATCH } from '@/app/api/parent/prestampati/firma/route'

// ─── Dati inventati (repository pubblico) ───────────────────────────────────────

const GENITORE = '11111111-1111-4111-8111-111111111111'
const ALUNNO = '22222222-2222-4222-8222-222222222222'
const ALTRUI = '33333333-3333-4333-8333-333333333333'
const SCUOLA = '44444444-4444-4444-8444-444444444444'
const SEZIONE = '55555555-5555-4555-8555-555555555555'
const DOCUMENTO = '66666666-6666-4666-8666-666666666666'
/** Due delegati al ritiro: uno di questo bambino, uno di un'altra famiglia. */
const DELEGATO = '77777777-7777-4777-8777-777777777777'
const DELEGATO_ALTRUI = '88888888-8888-4888-8888-888888888888'

const EMAIL = 'firmataria.inventata@esempio.test'
/** TEST-NET-3 (RFC 5737): un indirizzo che non è di nessuno. */
const IP = '203.0.113.7'

/**
 * Un allergene e un farmaco che NON ESISTONO — e la ragione per cui sono una parola sola.
 *
 * Devono ricomparire nel PDF per provare che il dato è passato davvero di qui (senza,
 * «non è nei log» sarebbe vero anche se il campo non fosse mai arrivato); e il testo
 * estratto da un PDF va a capo dove va a capo la riga, quindi una parola sola è l'unica
 * che si può cercare senza inseguire l'impaginazione.
 */
const ALLERGENE = 'Ginestrolo'
const FARMACO = 'Inventamolo'

const DATI = {
  alunno: {
    nome: 'Luca',
    cognome: 'Bianchi',
    dataNascita: '2021-03-04',
    luogoNascita: 'Cittàfinta (XX)',
    codiceFiscale: null,
    sezione: 'Farfalle',
    livello: 'infanzia' as const,
  },
  genitori: [
    { nomeCompleto: 'Verdi Anna', ruolo: 'madre' as const, telefono: '0000000000', email: EMAIL },
  ],
  richiedente: { nomeCompleto: 'Verdi Anna', ruolo: 'madre' as const, email: EMAIL },
  sede: {
    scuola_nome: 'Scuola di Prova',
    scuola_indirizzo: 'Via Inventata 1',
    scuola_cap: '80000',
    scuola_citta: 'Cittàfinta',
    scuola_provincia: 'XX',
    scuola_codice_meccanografico: null,
  },
  scuola: { ragioneSociale: 'Cooperativa di Prova', piva: null, sedeLegale: null, legaleRappresentante: null },
  annoScolastico: '2026/2027',
  dataOggi: '2026-08-14',
}

const PREFILL = {
  alunnoId: ALUNNO,
  scuolaId: SCUOLA,
  sezioneId: SEZIONE,
  dati: DATI,
  legaleRappresentante: null,
}

/**
 * La sede che ha compilato le proprie impostazioni: c'è chi firma per la Scuola.
 *
 * Non è un dettaglio del banco di prova: misurato in produzione il 2026-08-14, su 4 righe
 * di `scuole` **nessuna** aveva `legale_rappresentante`, e senza quel nome il render
 * rifiuta i sei fogli che escono dalla scuola. Le prove che generano davvero partono da una
 * sede a posto; quella incompleta ha la sua prova, separata.
 */
const PREFILL_CON_FIRMA = { ...PREFILL, legaleRappresentante: 'Cesario Inventato' }

/** Lo stesso bambino iscritto al NIDO, con l'autorizzazione al funzionamento configurata. */
const PREFILL_NIDO = {
  ...PREFILL_CON_FIRMA,
  dati: {
    ...DATI,
    alunno: { ...DATI.alunno, livello: 'nido' as const },
    sede: {
      ...DATI.sede,
      // L'ente per intero, come sui tre provvedimenti veri: il codice stampa il
      // valore e non ci antepone «Comune di».
      autorizzazioneNido: { numero: '000/2020', data: '2020-01-15', ente: 'Ambito Socio-Sanitario Inventato' },
    },
  },
}

/** Lo stesso bambino con DUE tutori in anagrafica: è ciò che fa scattare la doppia firma dell'08. */
const PREFILL_DUE_TUTORI = {
  ...PREFILL,
  dati: {
    ...DATI,
    genitori: [
      ...DATI.genitori,
      { nomeCompleto: 'Bianchi Marco', ruolo: 'padre' as const, telefono: '0000000001', email: null },
    ],
  },
}

/** Un permesso di sola entrata posticipata: valido per lo schema del n. 09. */
const RISPOSTE_VALIDE = { giorno: '2026-09-15', tipo: 'entrata_posticipata', oraArrivo: '09:30' }

/** Il n. 05 compilato: un allergene, un farmaco e un contatto d'emergenza, tutti inventati. */
const RISPOSTE_SANITARIA = {
  pediatraNome: 'Rossi Dottoressa Inventata',
  pediatraTelefono: '0810000000',
  allergie: true,
  allergieDettaglio: `Allergia al ${ALLERGENE}, reazione cutanea`,
  intolleranze: false,
  patologie: false,
  terapie: true,
  terapieDettaglio: `${FARMACO} 5 ml la sera`,
  vaccinazioni: true,
  ausili: false,
  contattiEmergenza: [
    { ordine: 1, nomeCompleto: 'Nonna Inventata', relazione: 'nonna', telefono: '0000000002' },
  ],
}

/**
 * Il n. 07 con un motivo NON sanitario: senza certificato medico, senza nome del medico e
 * senza dati dell'art. 9. `validita` è testo libero, ed è il punto della prova che lo usa.
 */
const RISPOSTE_DIETA = {
  motivo: 'scelta_alimentare',
  alimenti: [{ alimento: 'Radicchio inventato', sostituzione: 'Zucchina inventata' }],
  validita: 'fino alla fine dell’anno scolastico',
}

/**
 * LA GITA, come `teacher/uscite:POST` la scrive in `eventi_agenda`.
 *
 * Non è una riga inventata a mano: la descrizione la compone `componiDescrizioneUscita`,
 * cioè **la stessa funzione che la route dell'insegnante chiama**. Scriverla a mano qui
 * avrebbe reso verde il test anche il giorno in cui le due parti smettono di parlarsi —
 * che è precisamente il guasto contro cui il codec esiste.
 */
const USCITA_CORPO = {
  tipo_attivita: 'gita' as const,
  destinazione: 'Città della Scienza inventata',
  data: '2026-09-20',
  ora_partenza: '08:30',
  ora_rientro: '16:00',
  mezzo: 'pullman_privato' as const,
  attivita_in_acqua: false,
}
const USCITA_RIGA = {
  titolo: titoloUscita(USCITA_CORPO.tipo_attivita, USCITA_CORPO.destinazione),
  descrizione: componiDescrizioneUscita(USCITA_CORPO),
  data: USCITA_CORPO.data,
  orario_inizio: '08:30:00',
  orario_fine: '16:00:00',
}

/** Il n. 10 compilato: autorizzo, con un recapito reperibile inventato. */
const RISPOSTE_USCITA = { autorizzo: true, recapito: '0000000003' }

/** Mette in coda la gita per la sezione del bambino, su tutte le letture di `eventi_agenda`. */
function conUscitaPubblicata(riga: Record<string, unknown> = USCITA_RIGA) {
  h.state.fissi['eventi_agenda'] = { data: [riga], error: null }
}

/** La scansione del documento del delegato: il n. 08 la pretende, e la route la verifica. */
const SCANSIONE_DELEGATO = `${ALUNNO}/delegati/documento.pdf`

/** Il n. 08 con un periodo: `al` è la chiave da cui nasce `expiry_date`. */
const RISPOSTE_DELEGA = {
  delegati: [
    {
      nomeCompleto: 'Nonna Inventata',
      relazione: 'nonna',
      documento: 'CI XX0000000',
      documentoPath: SCANSIONE_DELEGATO,
    },
  ],
  validita: 'periodo',
  dal: '2026-09-01',
  al: '2026-12-31',
}

/** Lo stesso delegato con delega PERMANENTE: è l'unica validità che scrive in `delegates`. */
const RISPOSTE_DELEGA_PERMANENTE = {
  delegati: RISPOSTE_DELEGA.delegati,
  validita: 'permanente',
}

/**
 * Il n. 06: l'autorizzazione ai farmaci, che pretende la prescrizione del pediatra.
 *
 * ⚠️ IL RIFERIMENTO NOMINA IL MAGAZZINO, ed è la forma che la specifica indica:
 * `06-autorizzazione-farmaci.md:75` — «la prescrizione allegata segue lo stesso bucket con
 * oblio del certificato medico», cioè `certificati-medici`, dove la famiglia carica da sé con
 * `POST /api/parent/medical-certificates` e da dove l'oblio porta via davvero file e riga.
 * La chiave è `<alunnoId>/<uuid>.pdf`, che è la forma che quella porta scrive.
 */
const CERTIFICATO_CHIAVE = `${ALUNNO}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`
const PRESCRIZIONE = `certificati-medici:${CERTIFICATO_CHIAVE}`
/**
 * La stessa prescrizione depositata nel bucket del FASCICOLO, con la forma senza magazzino.
 *
 * È ciò che scrive `primaria/fascicolo:POST`, ed è la forma storica: una chiave nuda vale per
 * quel bucket. Serve a provare che l'aggancio nuovo non ha rotto il vecchio.
 */
const PRESCRIZIONE_FASCICOLO = `${ALUNNO}/prescrizioni/piano-terapeutico.pdf`
const RISPOSTE_FARMACI = {
  farmaco: FARMACO,
  dosaggio: '5 ml',
  modalita: 'orale',
  orario: 'ore 13:00',
  dal: '2026-09-01',
  al: '2026-09-30',
  prescrizionePath: PRESCRIZIONE,
}

function reqGet(qs: string) {
  return new NextRequest(`http://localhost/api/parent/prestampati${qs}`, {
    headers: { 'x-user-id': GENITORE },
  })
}

/** La richiesta di un documento al POST dell'elenco: certificato o riscarico. */
function reqDocumento(corpo: unknown) {
  return new NextRequest('http://localhost/api/parent/prestampati', {
    method: 'POST',
    headers: { 'x-user-id': GENITORE, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

/**
 * Un documento di quel tipo GIÀ nel fascicolo del bambino: è ciò che il riscarico ritrova.
 *
 * Si scrive nella CODA e non fra i valori fissi: la coda ha la precedenza, e la stessa
 * tabella qui serve due domande diverse — la prima lettura dice «che cosa c'è già», l'INSERT
 * che segue risponde con la riga creata. Un valore fisso avrebbe risposto la stessa cosa a
 * tutt'e due, e la prova avrebbe misurato il doppione.
 */
function conDocumentoInArchivio(slug: string, id = DOCUMENTO) {
  h.state.queues['student_documents'] = [
    {
      data: [
        {
          id,
          document_type: slug,
          storage_path: `${ALUNNO}/prestampati/${slug}-gia-emesso.pdf`,
          descrizione: 'Documento già emesso',
          created_at: '2026-08-15T09:00:00.000Z',
        },
      ],
      error: null,
    },
    // Il secondo posto serve al ramo «Generane uno nuovo», che dopo la lettura archivia.
    { data: { id: 'd0000000-0000-4000-8000-00000000000d' }, error: null },
  ]
  h.state.used['student_documents'] = 0
}

function reqFirma(metodo: 'POST' | 'PATCH', corpo: unknown) {
  return new NextRequest('http://localhost/api/parent/prestampati/firma', {
    method: metodo,
    headers: {
      'x-user-id': GENITORE,
      'content-type': 'application/json',
      'x-forwarded-for': IP,
      'user-agent': 'collaudo/1.0',
    },
    body: JSON.stringify(corpo),
  })
}

/** Il genitore autenticato, con nome e cognome: è ciò che finisce sotto «Firmato da». */
function comeGenitore() {
  auth.requireUser.mockResolvedValue({
    user: { id: GENITORE, role: 'genitore', nome: 'Anna', cognome: 'Verdi', scuola_id: SCUOLA },
  })
}

/**
 * Il gate della famiglia dice di no.
 *
 * Si nega da tutte e due le porte da cui il rifiuto può arrivare — il gate della route e
 * il precompilato, che lo rifà per conto suo — perché la prova non deve dipendere da quale
 * dei due parla per primo: il comportamento visibile è lo stesso 403.
 */
function negaLaPortata() {
  const rifiuto = () => ({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })
  portata.requireParentOfStudent.mockResolvedValue(rifiuto())
  prefillMod.caricaPrefillAlunno.mockResolvedValue(rifiuto())
}

/**
 * Nessuna sessione.
 *
 * Vale su tutte e due le porte perché `requireParentOfStudent` chiama `requireUser` al
 * proprio interno e ne inoltra il 401: è così che il GET e il PATCH — che non chiamano
 * `requireUser` per conto loro — rispondono a chi non è autenticato.
 */
function senzaIdentita() {
  const rifiuto = () => ({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
  auth.requireUser.mockResolvedValue(rifiuto())
  portata.requireParentOfStudent.mockResolvedValue(rifiuto())
}

/** Chiede il codice e restituisce ticket, scadenza e codice in chiaro (solo fuori produzione). */
async function chiediCodice(slug = 'permesso_orario') {
  const res = await POST(reqFirma('POST', { slug, alunnoId: ALUNNO }))
  const json = await res.json()
  expect(res.status, JSON.stringify(json)).toBe(200)
  return json as { ticket: string; expiry: number; devCode: string }
}

/** Firma per davvero: chiede il codice e lo spende sul modello indicato. */
async function firma(slug: string, risposte: unknown) {
  const codice = await chiediCodice(slug)
  const res = await PATCH(
    reqFirma('PATCH', {
      slug,
      alunnoId: ALUNNO,
      code: codice.devCode,
      expiry: codice.expiry,
      ticket: codice.ticket,
      risposte,
    }),
  )
  return { res, json: (await res.json()) as Record<string, unknown>, codice }
}

/**
 * L'ULTIMO valore depositato nello slot `body` del contesto — cioè quello che una riga
 * persistita si porterebbe in `app_log`.
 *
 * `parseBody` ne deposita uno (il corpo grezzo) e la route lo RISCRIVE subito dopo: leggere
 * l'ultimo è leggere ciò che resta, che è la sola cosa che conti.
 */
function ultimoBodyDepositato(): unknown {
  return [...contestoSpia.depositi].reverse().find((d) => d.dove === 'body')?.valore
}

/** I `campi` dell'evento di dominio con quell'esito, come la rotta li ha passati al logger. */
function campiEvento(esito: string): Record<string, unknown> | undefined {
  const riga = spie.chiamate.find(
    (c) => c[0] === 'logEvento' && (c[3] as { esito?: string } | undefined)?.esito === esito,
  )
  return riga?.[3] as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.fissi = {
    utenti: { data: { email: EMAIL }, error: null },
    // La riga dell'alunno come la legge il POST della firma quando il precompilato non
    // serve: sede E sezione. La sezione è ciò che lega il bambino all'uscita — senza, il
    // n. 10 non avrebbe una gita a cui appartenere e ogni prova su quel modulo misurerebbe
    // il doppione invece della rotta.
    alunni: { data: { scuola_id: SCUOLA, section_id: SEZIONE }, error: null },
  }
  h.state.used = {}
  h.state.inserimenti = []
  h.state.upload = []
  h.state.rimossi = []
  h.state.jti = new Set()
  h.state.rpc = []
  h.state.prossimoProtocollo = { data: 41, error: null }
  h.state.bucketElenco = { data: [{ name: 'sensitive_documents' }], error: null }
  h.state.bucketCreazione = { data: null, error: null }
  h.state.bucketCreati = []
  h.state.bucketElencati = 0
  // Gli allegati che i moduli dichiarano CI SONO: è il caso normale, e le prove che
  // misurano il contrario li tolgono di mezzo una alla volta. Due magazzini, due insiemi:
  // nel bucket del fascicolo la prescrizione in forma storica, fra i certificati medici la
  // prescrizione dove la specifica la vuole.
  h.state.oggetti = new Set([PRESCRIZIONE_FASCICOLO])
  h.state.certificati = new Set([`${ALUNNO}|${CERTIFICATO_CHIAVE}`])
  h.state.elencoOggetti = { errore: null }
  h.state.delegati = []
  h.state.letture = []
  spie.chiamate = []
  contestoSpia.depositi = []
  comeGenitore()
  portata.requireParentOfStudent.mockResolvedValue({
    user: { id: GENITORE, role: 'genitore', nome: 'Anna', cognome: 'Verdi' },
  })
  sospensione.assertGenitoreNonSospesoSalvoEssenziale.mockResolvedValue(null)
  tetti.limitaInvioOtp.mockResolvedValue(null)
  tetti.limitaVerificaOtp.mockResolvedValue(null)
  posta.sendEmail.mockResolvedValue(true)
  // Dal 2026-08-15 `sendOtp` passa da `sendEmailDetailed`, che ritorna un
  // ESITO e non un booleano: senza questo default il mock restituisce
  // `undefined` e la route esplode leggendone `.ok`.
  posta.sendEmailDetailed.mockResolvedValue({ ok: true, error: null })
  prefillMod.caricaPrefillAlunno.mockResolvedValue({
    user: { id: GENITORE, role: 'genitore' },
    prefill: PREFILL,
  })
  prefillMod.nucleoAlunno.mockReturnValue({
    cognome: DATI.alunno.cognome,
    nome: DATI.alunno.nome,
    dataNascita: DATI.alunno.dataNascita,
    luogoNascita: DATI.alunno.luogoNascita,
    codiceFiscale: null,
    sezione: DATI.alunno.sezione,
  })
})

// ─── GET ────────────────────────────────────────────────────────────────────────

describe('GET /api/parent/prestampati — chi entra e che cosa vede', () => {
  it('senza identità non si entra', async () => {
    senzaIdentita()
    const res = await GET(reqGet(`?alunnoId=${ALUNNO}`))
    expect(res.status).toBe(401)
    // E il precompilato non deve nemmeno essere stato chiesto.
    expect(prefillMod.caricaPrefillAlunno).not.toHaveBeenCalled()
  })

  it('chi non è un genitore non passa da questa porta, anche se ha una sessione valida', async () => {
    portata.requireParentOfStudent.mockResolvedValue({
      user: { id: 'u-segreteria', role: 'segreteria', nome: 'Mara', cognome: 'Rossi' },
    })
    const res = await GET(reqGet(`?alunnoId=${ALUNNO}`))
    const json = await res.json()
    expect(res.status).toBe(403)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(prefillMod.caricaPrefillAlunno).not.toHaveBeenCalled()
  })

  it('l’identità si risolve UNA volta sola: il ruolo esce dal gate della famiglia', async () => {
    negaLaPortata()
    const res = await GET(reqGet(`?alunnoId=${ALTRUI}&slug=permesso_orario`))
    expect(res.status).toBe(403)
    // Il gate c'è, ed è uno: `requireUser` a parte sarebbe la seconda risoluzione della
    // stessa identità nella stessa richiesta (la terza la fa già il precompilato).
    expect(portata.requireParentOfStudent).toHaveBeenCalledTimes(1)
    expect(auth.requireUser).not.toHaveBeenCalled()
  })

  it('elenca solo i modelli del banco «genitore», coi campi da chiedere', async () => {
    const res = await GET(reqGet(`?alunnoId=${ALUNNO}&slug=permesso_orario`))
    const json = await res.json()

    expect(res.status).toBe(200)
    const slug = json.modelli.map((m: { slug: string }) => m.slug)
    expect(slug).toContain('scheda_sanitaria')
    expect(slug).toContain('permesso_orario')
    // I nove della segreteria e delle insegnanti non compaiono in un elenco di famiglia.
    expect(slug).not.toContain('verbale_infortunio')
    expect(slug).not.toContain('certificato_servizio')

    expect(json.modello.slug).toBe('permesso_orario')
    const campi = json.modello.campi.map((c: { nome: string }) => c.nome)
    expect(campi).toContain('giorno')
    expect(campi).toContain('tipo')
  })

  it('«firmabileOra» dice ciò che la firma pretende davvero, non solo chi sottoscrive', async () => {
    const json = await (await GET(reqGet(`?alunnoId=${ALUNNO}`))).json()
    const per = (slug: string) =>
      json.modelli.find((m: { slug: string }) => m.slug === slug) as {
        firmabileOra: boolean
        motivoNonFirmabile: string | null
      }

    // 1. I due certificati: li sottoscrive il legale rappresentante, e il PATCH li respinge.
    expect(per('certificato_iscrizione_frequenza').firmabileOra).toBe(false)
    expect(per('certificato_bonus_nido').motivoNonFirmabile).toBe('firma-della-scuola')

    // 2. IL N. 10 NON C'È AFFATTO, e questa è la parte cambiata il 2026-08-16. Prima usciva
    // ACCESO e non si generava mai; poi è stato spento con un lucchetto e un motivo
    // (`uscita-non-creata`) — e restava spento **anche quando la gita esisteva davvero**,
    // perché le uscite vivono in `eventi_agenda` e nessuno costruiva `DatiUscita`. Ora la
    // regola è: niente uscita pubblicata per la sezione di quel bambino ⇒ la voce non compare
    // nell'elenco. Un lucchetto su una gita che non esiste è una promessa a chi non ha niente
    // da firmare.
    expect(json.modelli.map((m: { slug: string }) => m.slug)).not.toContain('autorizzazione_uscita')

    // 3. IL N. 08, che pretende la scansione del documento di ogni delegato e non ha nessuna
    // porta da cui caricarla: il documento d'identità di un TERZO non è un certificato
    // medico del bambino, e `primaria/fascicolo` al ruolo `genitore` risponde `negato`. Con
    // la voce accesa la famiglia compilava, chiedeva il codice — bruciando un invio dello
    // stesso budget da 5 ogni dieci minuti — e prendeva un 422 su un campo che non poteva
    // riempire. Il n. 06 e il n. 07 invece restano ACCESI, e non per indulgenza: per loro la
    // porta esiste davvero (`POST /api/parent/medical-certificates`).
    expect(per('delega_ritiro').firmabileOra).toBe(false)
    expect(per('delega_ritiro').motivoNonFirmabile).toBe('allegato-non-caricabile')

    // 4. Gli altri quattro, con UN solo tutore in anagrafica: si firmano.
    for (const slug of [
      'scheda_sanitaria',
      'autorizzazione_farmaci',
      'dieta_speciale',
      'permesso_orario',
    ]) {
      expect(per(slug).firmabileOra, slug).toBe(true)
      expect(per(slug).motivoNonFirmabile, slug).toBeNull()
    }
  })

  it('con due tutori in anagrafica la delega al ritiro esce SPENTA: la seconda firma non si raccoglie', async () => {
    // `richiedeDueFirme` è vera con due tutori (10 bambini su 33 in produzione) o con
    // `genitori_separati`: il n. 08 pretende due sottoscrizioni e questa strada ne raccoglie
    // una sola. Finché la seconda firma non ha un posto dove essere raccolta, la voce va
    // spenta — o la famiglia compila una delega che non potrà mai firmare.
    prefillMod.caricaPrefillAlunno.mockResolvedValue({
      user: { id: GENITORE, role: 'genitore' },
      prefill: PREFILL_DUE_TUTORI,
    })
    const json = await (await GET(reqGet(`?alunnoId=${ALUNNO}`))).json()
    const per = (slug: string) =>
      json.modelli.find((m: { slug: string }) => m.slug === slug) as {
        firmabileOra: boolean
        motivoNonFirmabile: string | null
      }

    // ⚠️ L'ORDINE FRA I DUE VERDETTI, ed è la parte che si può rompere senza accorgersene.
    // Sul n. 08 valgono tutti e due — la seconda firma non si raccoglie E la scansione non si
    // può caricare — ma il primo dipende da QUESTA famiglia e il secondo è uguale per tutti.
    // Dando l'allegato per primo (per esempio mettendolo nel verdetto «immediato», che non
    // legge l'anagrafica), «seconda firma mancante» non comparirebbe più da nessuna parte e
    // nessun test lo direbbe: sono due lacune diverse con due rimedi diversi, e la schermata
    // deve poter dire quale delle due sta guardando.
    expect(per('delega_ritiro').firmabileOra).toBe(false)
    expect(per('delega_ritiro').motivoNonFirmabile).toBe('seconda-firma-mancante')
    // E il resto dell'elenco non si spegne con lei: la doppia firma riguarda il solo n. 08.
    expect(per('permesso_orario').firmabileOra).toBe(true)
    expect(per('scheda_sanitaria').firmabileOra).toBe(true)
  })

  it('uno slug che il banco della famiglia non ha è un 404, non un elenco filtrato male', async () => {
    const res = await GET(reqGet(`?alunnoId=${ALUNNO}&slug=verbale_infortunio`))
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.codice).toBe('PRESTAMPATO_SCONOSCIUTO')
  })

  it('i recapiti dell’altro tutore non escono nella risposta JSON', async () => {
    const res = await GET(reqGet(`?alunnoId=${ALUNNO}`))
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain(EMAIL)
    expect(corpo).not.toContain('0000000000')
  })

  it('i delegati si leggono SOLO per i modelli che li usano', async () => {
    const senza = await (await GET(reqGet(`?alunnoId=${ALUNNO}&slug=scheda_sanitaria`))).json()
    expect(senza.delegati).toBeNull()
    expect(senza.delegatiNonLetti).toBe(false)

    h.state.queues['delegates'] = [
      { data: [{ id: 'd1', first_name: 'Nonna', last_name: 'Inventata', relation: 'nonna', document_number: 'XX0000000' }], error: null },
    ]
    h.state.used['delegates'] = 0
    const con = await (await GET(reqGet(`?alunnoId=${ALUNNO}&slug=permesso_orario`))).json()
    expect(con.delegati).toHaveLength(1)
    expect(con.delegati[0].nomeCompleto).toBe('Inventata Nonna')
  })

  it('ogni lettura del fascicolo lascia la sua riga in `fascicolo_accessi_audit`', async () => {
    // Regola 5 di `docs/prestampati/README.md`, e la stessa riga che scrive la strada gemella
    // dello sportello. Senza, a chi chiede «chi ha aperto il fascicolo di mio figlio» si
    // risponde con metà degli eventi: la scheda sanitaria preparata allo sportello lascia
    // traccia, quella preparata da casa no.
    const res = await GET(reqGet(`?alunnoId=${ALUNNO}&slug=scheda_sanitaria`))
    expect(res.status).toBe(200)

    const audit = h.state.inserimenti.filter((i) => i.tabella === 'fascicolo_accessi_audit')
    expect(audit).toHaveLength(1)
    expect(audit[0].righe).toMatchObject({
      alunno_id: ALUNNO,
      utente_id: GENITORE,
      azione: 'view',
      finalita: 'Precompilato prestampato scheda_sanitaria (famiglia)',
    })
  })

  it('la riga d’audit si scrive DOPO i gate: su un bambino non proprio non ne resta nessuna', async () => {
    // Una riga scritta sopra un 403 racconterebbe un accesso che non c'è stato — e il
    // registro degli accessi al fascicolo esiste per dire il vero, non per contare i
    // tentativi.
    negaLaPortata()
    const res = await GET(reqGet(`?alunnoId=${ALTRUI}&slug=scheda_sanitaria`))
    expect(res.status).toBe(403)
    expect(h.state.inserimenti.some((i) => i.tabella === 'fascicolo_accessi_audit')).toBe(false)
  })

  it('un elenco di delegati NON LETTO non si confonde con «questo bambino non ne ha»', async () => {
    // A schermo un elenco vuoto e un elenco non letto sono identici, e il n. 09 pretende
    // l'id di un delegato per chi non ritira di persona: con la lettura fallita il genitore
    // non vede la nonna, sceglie «io stesso» o abbandona, e nessuno saprebbe perché. La riga
    // di log non basta — il fatto deve arrivare al client.
    h.state.queues['delegates'] = [
      { data: null, error: { code: '42P01', message: 'relation "delegates" does not exist' } },
    ]
    h.state.used['delegates'] = 0
    const rotto = await (await GET(reqGet(`?alunnoId=${ALUNNO}&slug=permesso_orario`))).json()
    expect(rotto.delegati).toBeNull()
    expect(rotto.delegatiNonLetti).toBe(true)
    // Il modulo si prepara lo stesso: fermare tutta la modulistica per un elenco accessorio
    // sarebbe un rimedio più grande del guasto.
    expect(rotto.modello.slug).toBe('permesso_orario')
    const riga = spie.chiamate.find(
      (c) => c[0] === 'logEvento' && (c[3] as { esito?: string })?.esito === 'delegati-non-letti',
    )
    expect(riga?.[2]).toBe('warn')
    expect((riga?.[3] as { error_code?: string })?.error_code).toBe('42P01')

    // IL CONTRASTO, che è ciò che rende la prova una prova: letto e vuoto è un'altra cosa.
    h.state.queues['delegates'] = [{ data: [], error: null }]
    h.state.used['delegates'] = 0
    const vuoto = await (await GET(reqGet(`?alunnoId=${ALUNNO}&slug=permesso_orario`))).json()
    expect(vuoto.delegati).toEqual([])
    expect(vuoto.delegatiNonLetti).toBe(false)
  })
})

// ─── POST /api/parent/prestampati: il certificato che la famiglia si prende da sé ──

describe('il certificato del genitore: dal motore vero, protocollato, e sempre lo stesso', () => {
  beforeEach(() => {
    comeGenitore()
    prefillMod.caricaPrefillAlunno.mockResolvedValue({
      user: { id: GENITORE, role: 'genitore' },
      prefill: PREFILL_CON_FIRMA,
    })
    // L'INSERT in `student_documents` risponde con la riga creata: è il ramo felice.
    h.state.queues['student_documents'] = [
      { data: null, error: null },
      { data: { id: DOCUMENTO }, error: null },
    ]
    h.state.used['student_documents'] = 0
  })

  it('non è del genitore ⇒ non esce: né dal ruolo sbagliato né dal bambino sbagliato', async () => {
    auth.requireUser.mockResolvedValue({ user: { id: 'u-segreteria', role: 'segreteria' } })
    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }),
    )
    expect(res.status).toBe(403)
    expect(h.state.rpc).toHaveLength(0)

    comeGenitore()
    negaLaPortata()
    const altrui = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALTRUI, slug: 'certificato_iscrizione_frequenza' }),
    )
    expect(altrui.status).toBe(403)
    // Nessun numero consumato, nessun file caricato: il registro è WORM e chi sonda id
    // altrui non deve poterlo far avanzare di uno.
    expect(h.state.rpc).toHaveLength(0)
    expect(h.state.upload).toHaveLength(0)
  })

  it('genera il 26·27 dal motore vero: carta intestata, protocollo in uscita, fascicolo', async () => {
    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }),
    )
    const json = await res.json()
    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(json.riuso).toBe(false)
    expect(json.protocollo).toMatch(/^\d{7}\/\d{4}$/)

    // Il numero si chiede UNA volta sola, e per la sede del bambino.
    expect(h.state.rpc).toHaveLength(1)
    expect(h.state.rpc[0].funzione).toBe('prossimo_numero_protocollo')
    expect(h.state.rpc[0].parametri).toMatchObject({ p_scuola: SCUOLA })

    // La riga di registro c'è, e porta l'impronta del file consegnato.
    const registro = h.state.inserimenti.find((i) => i.tabella === 'protocolli')
    expect(registro?.righe).toMatchObject({ scuola_id: SCUOLA, numero: 41, tipo: 'uscita' })
    expect(String((registro?.righe as { impronta_sha256: string }).impronta_sha256)).toMatch(/^SHA256-/)

    // E il fascicolo del bambino: è la copia che si riscarica.
    const archivio = h.state.inserimenti.find((i) => i.tabella === 'student_documents')
    expect(archivio?.righe).toMatchObject({
      student_id: ALUNNO,
      document_type: 'certificato_iscrizione_frequenza',
      section_id: SEZIONE,
    })
  })

  it('sul foglio non c’è più «Il Dirigente Scolastico», e c’è chi firma davvero', async () => {
    // ⚠️ È IL DIFETTO DA CUI NASCE TUTTO IL LAVORO, e si misura sul PDF vero: il generatore
    // vecchio stampava una banda verde con «KIDVILLE SCHOOLS» in giallo e chiudeva con «Il
    // Dirigente Scolastico» — una figura che in una società cooperativa NON ESISTE e che
    // comunque non è chi firma. Il PDF qui si genera per davvero: si legge quello che
    // riceve la famiglia.
    await CHIEDI_DOCUMENTO(reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }))
    const caricato = h.state.upload.find((u) => u.percorso.includes('/prestampati/'))
    expect(caricato).toBeDefined()
    const testo = await estraiTesto((caricato as { byte: Uint8Array }).byte)

    expect(testo).not.toMatch(/Dirigente Scolastico/i)
    expect(testo).not.toMatch(/KIDVILLE SCHOOLS/i)
    expect(testo).toMatch(/LEGALE RAPPRESENTANTE/i)
    expect(testo).toContain('Cesario Inventato')
    // La segnatura di protocollo è sul foglio: è ciò che lo rende spendibile davanti a un ente.
    expect(testo).toMatch(/0000041/)
  })

  it('riscaricandolo torna LO STESSO file: stesso protocollo, nessun numero bruciato', async () => {
    // La regola, testuale dal titolare: «una volta che il genitore ha scaricato il suo
    // certificato, quel certificato resta salvato, e quando lo va a riprendere riscarica
    // sempre lo stesso». Il registro è WORM: un numero consumato non torna indietro, e
    // rigenerare a ogni download vorrebbe dire bruciarne uno per ogni clic.
    conDocumentoInArchivio('certificato_iscrizione_frequenza')

    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.riuso).toBe(true)
    expect(json.documentoId).toBe(DOCUMENTO)
    expect(json.url).toBeTruthy()
    // LE TRE PROVE CHE CONTANO: nessun numero chiesto, nessuna riga nel registro, nessun
    // file nuovo. Da sola, «nessuna riga in `protocolli`» direbbe solo che non è stata
    // scritta — il numero poteva essere già stato consumato dalla RPC.
    expect(h.state.rpc).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'protocolli')).toBe(false)
    expect(h.state.upload).toHaveLength(0)
  })

  it('«Generane uno nuovo» emette data e protocollo nuovi, e il precedente resta', async () => {
    // ⚠️ CON `nuovo: true` LA LETTURA DELL'ARCHIVIO NON SI FA AFFATTO — è il gesto esplicito
    // «voglio un altro certificato», e chiedere che cosa c'è già non cambierebbe la
    // risposta. Quindi la prima cosa che la rotta consuma è l'INSERT, non la SELECT.
    h.state.queues['student_documents'] = [
      { data: { id: 'd0000000-0000-4000-8000-00000000000d' }, error: null },
    ]
    h.state.used['student_documents'] = 0
    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza', nuovo: true }),
    )
    const json = await res.json()

    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(json.riuso).toBe(false)
    expect(h.state.rpc).toHaveLength(1)
    expect(h.state.inserimenti.some((i) => i.tabella === 'protocolli')).toBe(true)
    // Il precedente non si tocca: nessuna cancellazione, nessuna sovrascrittura.
    expect(h.state.rimossi).toEqual([])
  })

  it('il corpo senza `nuovo` vale RISCARICO, non emissione', async () => {
    // La direzione in cui si sbaglia si sceglie: un client che dimentica il campo deve
    // ottenere il file di prima, non un numero di protocollo bruciato.
    conDocumentoInArchivio('certificato_iscrizione_frequenza')
    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }),
    )
    expect((await res.json()).riuso).toBe(true)
    expect(h.state.rpc).toHaveLength(0)
  })

  it('il Bonus Nido senza autorizzazione è un 422 leggibile, MAI un 500 e MAI un numero', async () => {
    prefillMod.caricaPrefillAlunno.mockResolvedValue({
      user: { id: GENITORE, role: 'genitore' },
      prefill: {
        ...PREFILL_NIDO,
        dati: { ...PREFILL_NIDO.dati, sede: { ...DATI.sede, autorizzazioneNido: null } },
      },
    })
    const res = await CHIEDI_DOCUMENTO(reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_bonus_nido' }))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    // Enumerato e non prosa: l'app è bilingue e il server no.
    expect(json.motivo).toBe('autorizzazione-nido-mancante')
    // Un certificato con «N. ______ del ______» l'INPS lo rifiuta: meglio non emetterlo. E
    // il numero non si consuma per un motivo che si conosceva prima di comporre.
    expect(h.state.rpc).toHaveLength(0)
    // Configurazione mancante = `error`, mai `info` (AGENTS.md §4).
    const riga = spie.chiamate.find(
      (c) =>
        c[0] === 'logEvento' &&
        (c[3] as { esito?: string })?.esito === 'autorizzazione-nido-non-configurata',
    )
    expect(riga?.[2]).toBe('error')
  })

  it('il Bonus Nido a un bambino che il nido non lo frequenta non si emette', async () => {
    // `dati.alunno.livello` è `infanzia` nel precompilato predefinito: il Bonus Asilo Nido
    // spetta a un servizio 0-3, e un certificato emesso per un altro livello è una
    // dichiarazione falsa a un ente pubblico.
    const res = await CHIEDI_DOCUMENTO(reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_bonus_nido' }))
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.motivo).toBe('livello-non-nido')
    expect(h.state.rpc).toHaveLength(0)
  })

  it('senza il nome di chi firma il certificato non esce, e lo dice con un motivo suo', async () => {
    prefillMod.caricaPrefillAlunno.mockResolvedValue({
      user: { id: GENITORE, role: 'genitore' },
      prefill: PREFILL,
    })
    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }),
    )
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.motivo).toBe('legale-rappresentante-assente')
    expect(h.state.rpc).toHaveLength(0)
  })

  it('i moduli firmati si riscaricano SEMPRE, e quelli non firmati non si generano da qui', async () => {
    // 🔴 IL DIFETTO CHE CHIUDE: il PDF della scheda sanitaria firmata viveva solo dentro la
    // risposta 201 della firma. Chi chiudeva la pagina lo perdeva, e nessun elenco lo
    // nominava più.
    conDocumentoInArchivio('scheda_sanitaria')
    const riscarico = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'scheda_sanitaria' }),
    )
    const json = await riscarico.json()
    expect(riscarico.status).toBe(200)
    expect(json.riuso).toBe(true)
    expect(json.url).toBeTruthy()
    // Un riscarico è una lettura del fascicolo, e lascia la sua riga d'audit.
    const audit = h.state.inserimenti.filter((i) => i.tabella === 'fascicolo_accessi_audit')
    expect(audit).toHaveLength(1)
    expect(audit[0].righe).toMatchObject({ azione: 'download', alunno_id: ALUNNO })

    // E se non è firmato non si genera da qui: la firma è l'altra porta, e la frase di
    // catalogo di `PRESTAMPATO_FIRMA_NON_VALIDA` dice esattamente questo. Fascicolo vuoto:
    // la coda si azzera, e la lettura torna il `null` predefinito.
    h.state.queues['student_documents'] = []
    h.state.used['student_documents'] = 0
    const senza = await CHIEDI_DOCUMENTO(reqDocumento({ alunnoId: ALUNNO, slug: 'scheda_sanitaria' }))
    expect(senza.status).toBe(409)
    expect((await senza.json()).codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(h.state.rpc).toHaveLength(0)
  })

  it('l’archivio non letto NON diventa «non ce n’è»: non si emette un secondo numero al buio', async () => {
    // «Non so se ce n'è già uno» + «genero» = un secondo numero di protocollo bruciato su
    // un registro WORM per un guasto di lettura. Meglio un 503 che si ritenta.
    h.state.queues['student_documents'] = [
      { data: null, error: { code: '42703', message: 'column does not exist' } },
    ]
    h.state.used['student_documents'] = 0
    const res = await CHIEDI_DOCUMENTO(
      reqDocumento({ alunnoId: ALUNNO, slug: 'certificato_iscrizione_frequenza' }),
    )
    expect(res.status).toBe(503)
    expect(h.state.rpc).toHaveLength(0)
  })

  it('l’elenco dice quali documenti sono già nel fascicolo', async () => {
    conDocumentoInArchivio('scheda_sanitaria')
    const json = await (await GET(reqGet(`?alunnoId=${ALUNNO}`))).json()
    const per = (slug: string) =>
      json.modelli.find((m: { slug: string }) => m.slug === slug) as {
        documentoArchiviatoId: string | null
      }
    expect(per('scheda_sanitaria').documentoArchiviatoId).toBe(DOCUMENTO)
    // Gli altri no: il documento è per TIPO, non per bambino.
    expect(per('permesso_orario').documentoArchiviatoId).toBeNull()
  })
})

// ─── Il n. 10 e l'uscita che lo accende ─────────────────────────────────────────

describe('l’autorizzazione all’uscita esiste solo se esiste la gita', () => {
  /**
   * IL ROUND-TRIP È IL LOCK, ed è l'unica cosa che tiene insieme le due metà.
   *
   * `eventi_agenda` non ha una colonna `jsonb`: i dati della gita viaggiano dentro il TESTO
   * della descrizione, scritto da `teacher/uscite:POST` e riletto dalle due porte della
   * famiglia. Se le etichette divergono il modulo esce lo stesso, con la destinazione
   * vuota, e nessun errore lo segnala — è il modo silenzioso in cui questo formato si
   * rompe. Questa prova compone e rilegge, e confronta con l'input.
   */
  /**
   * ⚠️ IL LOCK VERO È QUESTO, E IL ROUND-TRIP DA SOLO NON BASTAVA.
   *
   * Misurato il 2026-08-16: rinominando `RIGA_DESTINAZIONE` da `'Destinazione'` a `'Meta'`
   * la suite restava **verde**, perché chi scrive e chi legge usano la stessa costante e il
   * round-trip è coerente per costruzione. Ma in `eventi_agenda` ci sono già righe scritte
   * con le etichette di oggi: rinominarne una le rende illeggibili, cioè **spegne il modulo
   * n. 10 per le gite già annunciate alle famiglie**, in silenzio.
   *
   * Perciò qui la descrizione è una STRINGA LETTERALE, copiata dal formato che la route
   * dell'insegnante scrive da quando esiste, e il titolo è `null`: ogni campo deve uscire
   * dalla descrizione, senza appoggiarsi al titolo. Se un'etichetta cambia, questa prova
   * diventa rossa — ed è l'unico posto in cui può farlo.
   */
  it('il formato già scritto in produzione resta leggibile, etichetta per etichetta', () => {
    const letto = datiUscitaDaEvento({
      titolo: null,
      descrizione: [
        'Tipo di attività: Corso di piscina/nuoto',
        'Destinazione: Piscina comunale inventata',
        'Data: 20/09/2026 · Partenza: 08:30 · Rientro previsto: 16:00',
        'Mezzo di trasporto: Scuolabus',
        'Attività in acqua: Sì',
        'Accompagnatori: due maestre',
        'Quota di partecipazione: € 12,00',
        'Si ricorda di segnalare eventuali informazioni sanitarie rilevanti già indicate nella scheda sanitaria dell’alunno/a.',
      ].join('\n'),
      data: '2026-09-20',
      orario_inizio: '08:30:00',
      orario_fine: '16:00:00',
    })
    expect(letto).toEqual({
      tipo: 'piscina',
      destinazione: 'Piscina comunale inventata',
      data: '2026-09-20',
      oraPartenza: '08:30',
      oraRientro: '16:00',
      mezzo: 'scuolabus',
      attivitaInAcqua: true,
    })
  })

  it('ciò che l’insegnante scrive in agenda è ciò che il modulo rilegge', () => {
    const letto = datiUscitaDaEvento(USCITA_RIGA)
    expect(letto).toEqual({
      // `gita` di qua, `gita` di là: il tipo dell'agenda si traduce in quello del modello.
      tipo: 'gita',
      destinazione: USCITA_CORPO.destinazione,
      data: USCITA_CORPO.data,
      // I secondi della `time` di Postgres non arrivano sul foglio.
      oraPartenza: '08:30',
      oraRientro: '16:00',
      mezzo: 'pullman_privato',
      attivitaInAcqua: false,
    })
  })

  it('«corso di piscina» diventa «piscina», e l’attività in acqua sopravvive alla scrittura', () => {
    // I due elenchi hanno cinque voci identiche e UN nome diverso per la stessa cosa
    // (`corso_piscina` in agenda, `piscina` nel modello): senza la traduzione il foglio
    // stamperebbe «Altro» su un corso di nuoto. E `attivitaInAcqua` è il dato che decide se
    // il modulo chiede «sa nuotare»: prima del 2026-08-16 non veniva scritto affatto.
    const riga = {
      titolo: titoloUscita('corso_piscina', 'Piscina inventata'),
      descrizione: componiDescrizioneUscita({
        ...USCITA_CORPO,
        tipo_attivita: 'corso_piscina',
        destinazione: 'Piscina inventata',
        mezzo: 'a_piedi',
        attivita_in_acqua: true,
      }),
      data: USCITA_CORPO.data,
      orario_inizio: '08:30:00',
      orario_fine: '16:00:00',
    }
    const letto = datiUscitaDaEvento(riga)
    expect(letto?.tipo).toBe('piscina')
    expect(letto?.mezzo).toBe('a_piedi')
    expect(letto?.attivitaInAcqua).toBe(true)
  })

  it('una riga senza destinazione, senza data o senza orari NON è un’uscita da autorizzare', () => {
    // Le tre condizioni sono quelle che il foglio dichiara e che un ente leggerebbe: dove
    // si va, quando si parte, quando si torna. Senza una qualunque delle tre il documento
    // autorizzerebbe la partecipazione a un'attività che non dice dove va né quando.
    expect(datiUscitaDaEvento(null)).toBeNull()
    expect(datiUscitaDaEvento({ ...USCITA_RIGA, data: null })).toBeNull()
    expect(datiUscitaDaEvento({ ...USCITA_RIGA, data: '20/09/2026' })).toBeNull()
    expect(datiUscitaDaEvento({ ...USCITA_RIGA, orario_inizio: null })).toBeNull()
    expect(datiUscitaDaEvento({ ...USCITA_RIGA, orario_fine: '   ' })).toBeNull()
    // Descrizione libera E titolo senza due punti: la destinazione non si inventa.
    expect(
      datiUscitaDaEvento({ ...USCITA_RIGA, descrizione: 'Andiamo in gita', titolo: 'Gita' }),
    ).toBeNull()
  })

  it('un’uscita nata dall’agenda generica si legge dal titolo, e il tipo ignoto vale «altro»', () => {
    // `eventi_agenda` accetta `tipo='uscita'` anche da `POST /api/agenda`, dove la
    // descrizione è testo libero: là il titolo è l'unica cosa che ha una forma.
    const letto = datiUscitaDaEvento({
      titolo: 'Passeggiata: Parco inventato',
      descrizione: 'Ci vediamo davanti al cancello.',
      data: '2026-10-01',
      orario_inizio: '09:00:00',
      orario_fine: '11:30:00',
    })
    expect(letto?.destinazione).toBe('Parco inventato')
    expect(letto?.tipo).toBe('altro')
    expect(letto?.mezzo).toBeNull()
  })

  it('con la gita pubblicata il n. 10 COMPARE, acceso e con destinazione, data e orari veri', async () => {
    conUscitaPubblicata()
    const json = await (await GET(reqGet(`?alunnoId=${ALUNNO}`))).json()
    const dieci = json.modelli.find((m: { slug: string }) => m.slug === 'autorizzazione_uscita')
    expect(dieci).toBeDefined()
    expect(dieci.firmabileOra).toBe(true)
    expect(dieci.motivoNonFirmabile).toBeNull()
    // E la gita esce accanto all'elenco: il genitore deve sapere che cosa sta autorizzando
    // PRIMA di aprire il modulo.
    expect(json.uscita).toEqual({
      destinazione: USCITA_CORPO.destinazione,
      data: USCITA_CORPO.data,
      oraPartenza: '08:30',
      oraRientro: '16:00',
    })
  })

  it('l’uscita si cerca nella SEZIONE e nella SEDE del bambino, e solo da oggi in avanti', async () => {
    conUscitaPubblicata()
    await GET(reqGet(`?alunnoId=${ALUNNO}`))
    const lettura = h.state.letture.find((l) => l.tabella === 'eventi_agenda')
    expect(lettura?.filtri).toMatchObject({
      section_id: SEZIONE,
      scuola_id: SCUOLA,
      tipo: 'uscita',
      visibile_genitori: true,
      // «Da oggi in avanti»: un'autorizzazione si firma PRIMA di partire, e la gita di
      // marzo scorso non si autorizza più. La data è quella CIVILE italiana che il
      // precompilato ha già calcolato, non `new Date()` del processo (su Vercel è UTC).
      'gte:data': DATI.dataOggi,
    })
  })

  it('un’uscita NON LETTA non diventa «non c’è nessuna gita»', async () => {
    // Togliere la voce per un guasto di lettura vorrebbe dire dire alla famiglia «non c'è
    // nessuna gita» quando la risposta vera è «non lo so» — e il giorno della partenza
    // nessuno collegherebbe le due cose.
    h.state.fissi['eventi_agenda'] = {
      data: null,
      error: { code: '42P01', message: 'relation "eventi_agenda" does not exist' },
    }
    const json = await (await GET(reqGet(`?alunnoId=${ALUNNO}`))).json()
    expect(json.modelli.map((m: { slug: string }) => m.slug)).toContain('autorizzazione_uscita')
    const riga = spie.chiamate.find(
      (c) => c[0] === 'logEvento' && (c[3] as { esito?: string })?.esito === 'uscita-non-letta',
    )
    expect(riga?.[2]).toBe('warn')
    expect((riga?.[3] as { error_code?: string })?.error_code).toBe('42P01')
  })

  it('senza gita il codice di firma NON parte: il budget OTP non si brucia su un modulo che non c’è', async () => {
    // `LIMITE_OTP_INVIO` è di 5 invii per finestra di dieci minuti ed è CONDIVISO fra tutte
    // le porte OTP: cinque tentativi su una gita inesistente lascerebbero il genitore senza
    // modo di firmare l'autorizzazione a un farmaco.
    const res = await POST(reqFirma('POST', { slug: 'autorizzazione_uscita', alunnoId: ALUNNO }))
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.codice).toBe('PRESTAMPATO_SCONOSCIUTO')
    expect(posta.sendEmail).not.toHaveBeenCalled()
  })

  it('con la gita pubblicata il n. 10 si firma davvero, e destinazione e orari finiscono SUL FOGLIO', async () => {
    conUscitaPubblicata()
    const { res, json } = await firma('autorizzazione_uscita', RISPOSTE_USCITA)
    expect(res.status, JSON.stringify(json)).toBe(201)

    // Il PDF si genera per davvero in questi test: si legge quello che riceve la famiglia.
    expect(h.state.upload).toHaveLength(1)
    const testo = await estraiTesto(h.state.upload[0].byte)
    expect(testo).toContain(USCITA_CORPO.destinazione)
    expect(testo).toContain('20/09/2026')
    expect(testo).toContain('08:30')
    expect(testo).toContain('16:00')
  })

  it('se la gita sparisce fra la richiesta del codice e la firma, il documento non nasce', async () => {
    // Fra il POST e il PATCH passano minuti: un'uscita annullata nel frattempo non deve
    // produrre un'autorizzazione. È il motivo per cui la lettura si rifà nel PATCH invece
    // di fidarsi di quella del POST.
    conUscitaPubblicata()
    const codice = await chiediCodice('autorizzazione_uscita')
    h.state.fissi['eventi_agenda'] = { data: [], error: null }

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'autorizzazione_uscita',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_USCITA,
      }),
    )
    expect(res.status).toBe(404)
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
  })
})

// ─── POST: l'invio del codice ───────────────────────────────────────────────────

describe('POST /api/parent/prestampati/firma — l’invio del codice', () => {
  it('senza identità non si entra e nessuna email parte', async () => {
    senzaIdentita()
    const res = await POST(reqFirma('POST', { slug: 'permesso_orario', alunnoId: ALUNNO }))
    expect(res.status).toBe(401)
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('su un bambino che non è suo risponde 403 e NON spedisce niente', async () => {
    negaLaPortata()
    const res = await POST(reqFirma('POST', { slug: 'permesso_orario', alunnoId: ALTRUI }))
    expect(res.status).toBe(403)
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('il tetto di frequenza vale PRIMA di qualunque invio', async () => {
    tetti.limitaInvioOtp.mockResolvedValue(
      NextResponse.json({ error: 'Troppe richieste', codice: 'TROPPE_RICHIESTE' }, { status: 429 }),
    )
    const res = await POST(reqFirma('POST', { slug: 'permesso_orario', alunnoId: ALUNNO }))
    expect(res.status).toBe(429)
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
    expect(portata.requireParentOfStudent).not.toHaveBeenCalled()
  })

  it('manda il codice all’email autorevole, con oggetto in italiano', async () => {
    const json = await chiediCodice()
    expect(json.ticket).toBeTruthy()
    expect(json.devCode).toMatch(/^\d{6}$/)

    const inviata = posta.sendEmailDetailed.mock.calls[0][0]
    expect(inviata.to).toBe(EMAIL)
    // L'oggetto è UNO SOLO per tutti i codici di verifica dal 2026-08-15: prima
    // ce n'erano sei, uno per occasione. QUALE modulo si sta firmando non si è
    // però perso — sta nella prima riga del corpo e nel preheader, cioè proprio
    // dove chi legge lo cerca: nell'anteprima della notifica, senza aprire.
    expect(inviata.subject).toBe('Il tuo codice di verifica — Kidville')
    expect(inviata.text).toContain('Permesso entrata posticipata / uscita anticipata')
    expect(inviata.html).toContain('Permesso entrata posticipata / uscita anticipata')
  })

  it('senza un indirizzo in anagrafica è un 422 con codice, non un 500', async () => {
    // La casella del genitore è l'unico canale della firma: se non c'è, va detto a chi
    // sta compilando — non lasciato cadere in un errore generico.
    h.state.fissi['utenti'] = { data: null, error: null }
    const res = await POST(reqFirma('POST', { slug: 'permesso_orario', alunnoId: ALUNNO }))
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('i due certificati non si firmano con l’OTP del genitore', async () => {
    const res = await POST(reqFirma('POST', { slug: 'certificato_bonus_nido', alunnoId: ALUNNO }))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(json.motivoNonFirmabile).toBe('firma-della-scuola')
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('l’autorizzazione all’uscita non fa partire nessun codice se la gita non è pubblicata', async () => {
    // Il n. 10 pretende `DatiUscita` — tipo, destinazione, data, mezzo — che nasce dalla gita
    // in `eventi_agenda`. Senza quella riga il PATCH rifiuterebbe il 100% delle volte, e
    // spedire il codice qui non sarebbe solo un giro a vuoto: cinque tentativi bruciano il
    // budget OTP, che è UNO per tutte le porte, e il genitore resta senza modo di firmare
    // l'autorizzazione a un farmaco.
    //
    // ⚠️ 404 e non 409: da quando l'uscita governa la visibilità, per QUESTO bambino e in
    // QUESTO momento quel modulo non è nell'elenco — e la frase di `PRESTAMPATO_SCONOSCIUTO`
    // («non è fra i prestampati disponibili alla famiglia») dice esattamente questo. Un
    // `motivoNonFirmabile` servirebbe a spiegare un pulsante spento, e nessun pulsante è
    // acceso.
    const res = await POST(reqFirma('POST', { slug: 'autorizzazione_uscita', alunnoId: ALUNNO }))
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.codice).toBe('PRESTAMPATO_SCONOSCIUTO')
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('con due tutori in anagrafica la delega al ritiro si ferma PRIMA dell’email', async () => {
    prefillMod.caricaPrefillAlunno.mockResolvedValue({
      user: { id: GENITORE, role: 'genitore' },
      prefill: PREFILL_DUE_TUTORI,
    })

    const res = await POST(reqFirma('POST', { slug: 'delega_ritiro', alunnoId: ALUNNO }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.motivoNonFirmabile).toBe('seconda-firma-mancante')
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
    // Il verdetto dipende dall'anagrafica, quindi il precompilato QUI si legge — ed è il
    // solo modulo per cui si legge.
    expect(prefillMod.caricaPrefillAlunno).toHaveBeenCalledTimes(1)
    // Si conta: è la misura che dice se la raccolta della seconda firma vale la pena.
    expect(campiEvento('firma-non-disponibile')?.azione).toBe('seconda-firma-mancante')
  })

  it('con un solo tutore la delega si ferma comunque, e per l’altro motivo: nessun codice parte', async () => {
    // Con un tutore solo la doppia firma non c'entra, e prima di questa correzione il codice
    // partiva davvero: la famiglia compilava tutto e si vedeva rifiutare `documentoPath` —
    // un campo che NON PUÒ riempire, perché la scansione del documento di un terzo non ha
    // nessuna porta da cui entrare. Un invio bruciato ogni volta, su un budget da 5 per dieci
    // minuti condiviso con la firma dell'autorizzazione a un farmaco.
    const res = await POST(reqFirma('POST', { slug: 'delega_ritiro', alunnoId: ALUNNO }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(json.motivoNonFirmabile).toBe('allegato-non-caricabile')
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
    // Si conta, come gli altri rifiuti: è la misura che dice quanto vale la porta mancante.
    expect(campiEvento('firma-non-disponibile')?.azione).toBe('allegato-non-caricabile')
  })

  it('il n. 06 e il n. 07 restano accesi: per loro la porta di caricamento esiste', async () => {
    // Il contrasto della prova qui sopra, ed è la ragione per cui il rifiuto è un insieme di
    // slug e non «ogni modello con un campo file obbligatorio»: la prescrizione del n. 06 e
    // il certificato del n. 07 la famiglia li carica da sé con
    // `POST /api/parent/medical-certificates`, che è anche il bucket con oblio che la
    // specifica nomina. Spegnere anche loro avrebbe tolto due strade che funzionano — e una
    // è l'autorizzazione a somministrare un farmaco a un bambino.
    await chiediCodice('autorizzazione_farmaci')
    await chiediCodice('dieta_speciale')
    expect(posta.sendEmailDetailed).toHaveBeenCalledTimes(2)
  })

  it('un genitore sospeso può comunque autorizzare un farmaco (modulo essenziale)', async () => {
    await chiediCodice('autorizzazione_farmaci')
    expect(sospensione.assertGenitoreNonSospesoSalvoEssenziale).toHaveBeenCalledWith(
      expect.anything(),
      GENITORE,
      { sempreFirmabile: true },
    )
  })

  it('l’eccezione alla morosità la decide la SEDE, e la rotta va a leggerla', async () => {
    // ⚠️ È UNA REGOLA DI CREDITO, e prima era un insieme scritto dentro questo file: il codice
    // stabiliva per conto proprio quali moduli una famiglia in ritardo con la retta può
    // firmare comunque. Ora si legge da `admin_settings.modulistica_config`, che il pannello
    // impostazioni già mostra — cambiarla non è un rilascio.
    //
    // La sede si prende dal BAMBINO e non dalla sessione: un genitore può avere due figli in
    // due plessi diversi.
    h.state.fissi['alunni'] = { data: { scuola_id: SCUOLA }, error: null }
    h.state.fissi['admin_settings'] = {
      data: { modulistica_config: { prestampati_sempre_firmabili: ['dieta_speciale'] } },
      error: null,
    }

    await chiediCodice('scheda_sanitaria')

    expect(h.state.letture.some((l) => l.tabella === 'alunni' && l.filtri.id === ALUNNO)).toBe(true)
    expect(h.state.letture.some((l) => l.tabella === 'admin_settings' && l.filtri.scuola_id === SCUOLA)).toBe(true)
    // La sede ha detto «solo la dieta»: la scheda sanitaria torna a essere bloccabile.
    expect(sospensione.assertGenitoreNonSospesoSalvoEssenziale).toHaveBeenLastCalledWith(
      expect.anything(),
      GENITORE,
      { sempreFirmabile: false },
    )

    // E il contrasto, sullo stesso modulo: senza configurazione vale il predefinito.
    delete h.state.fissi['admin_settings']
    h.state.used = {}
    await chiediCodice('scheda_sanitaria')
    expect(sospensione.assertGenitoreNonSospesoSalvoEssenziale).toHaveBeenLastCalledWith(
      expect.anything(),
      GENITORE,
      { sempreFirmabile: true },
    )
  })

  it('dalla sessione della segreteria non parte nessun codice di firma', async () => {
    // È la porta che SPEDISCE, e il controllo del ruolo esiste per una ragione precisa: il
    // riquadro di firma stampa il nome della sessione che ha risposto al codice, e dallo
    // sportello quel nome sarebbe quello della segretaria sotto una dichiarazione che
    // comincia con «il/la sottoscritto/a».
    auth.requireUser.mockResolvedValue({
      user: { id: 'u-segreteria', role: 'segreteria', nome: 'Mara', cognome: 'Rossi' },
    })

    const res = await POST(reqFirma('POST', { slug: 'permesso_orario', alunnoId: ALUNNO }))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(posta.sendEmailDetailed).not.toHaveBeenCalled()
    // E si ferma prima di tutto il resto: nessun tetto speso, nessuna anagrafica letta.
    expect(tetti.limitaInvioOtp).not.toHaveBeenCalled()
    expect(portata.requireParentOfStudent).not.toHaveBeenCalled()
  })
})

// ─── PATCH: la firma vera ───────────────────────────────────────────────────────

describe('PATCH /api/parent/prestampati/firma — verifica, generazione, archiviazione', () => {
  it('senza identità non si entra', async () => {
    const codice = await chiediCodice()
    senzaIdentita()
    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    expect(res.status).toBe(401)
    expect(h.state.upload).toHaveLength(0)
    expect(prefillMod.caricaPrefillAlunno).not.toHaveBeenCalled()
  })

  it('il tetto sui tentativi ferma la verifica prima di ogni lavoro', async () => {
    const codice = await chiediCodice()
    // Il POST ha già usato il gate per conto suo: si azzera il contatore, così ciò che si
    // misura qui sotto è quello che fa il PATCH e non quello che ha fatto la richiesta prima.
    portata.requireParentOfStudent.mockClear()
    tetti.limitaVerificaOtp.mockResolvedValue(
      NextResponse.json({ error: 'Troppi tentativi', codice: 'TROPPE_RICHIESTE' }, { status: 429 }),
    )

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )

    expect(res.status).toBe(429)
    // Davanti al tetto c'è solo la risoluzione dell'identità — serve a sapere CHI limitare
    // — e nient'altro: né la portata sulla famiglia, né le otto query del precompilato, né
    // la verifica del codice, né il PDF, né una riga scritta.
    expect(portata.requireParentOfStudent).not.toHaveBeenCalled()
    expect(prefillMod.caricaPrefillAlunno).not.toHaveBeenCalled()
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti).toEqual([])
  })

  it('il ticket NON è un lasciapassare per il bambino di un’altra famiglia', async () => {
    const codice = await chiediCodice()
    negaLaPortata()

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALTRUI,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    expect(res.status).toBe(403)
    // Nessun documento generato, nessuna riga d'archivio, nessuna firma registrata.
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti).toEqual([])
  })

  it('un codice sbagliato non genera niente', async () => {
    const codice = await chiediCodice()
    const sbagliato = codice.devCode === '000000' ? '111111' : '000000'

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: sbagliato,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    // E il ticket non si è consumato: un codice sbagliato non brucia la firma.
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
  })

  it('senza un indirizzo in anagrafica la verifica si ferma prima dell’HMAC', async () => {
    const codice = await chiediCodice()
    // L'email è l'ingrediente dell'HMAC: senza, il confronto non si può nemmeno fare, e la
    // risposta onesta è «manca un dato», non «codice non valido».
    h.state.fissi['utenti'] = { data: null, error: null }

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
  })

  it('se lo store dei jti non registra il consumo, NON si producono atti firmati', async () => {
    // `consumeTicket` su un errore DB inatteso è fail-open dichiarato: risponde «ok» senza
    // aver scritto niente, e la ragione scritta là — «il vincolo unique su
    // `forms_submissions` impedisce comunque la firma duplicata» — su questa strada non
    // vale: `firme_documenti`, il bucket e `student_documents` hanno la chiave primaria su
    // un `id` generato, e niente lega due righe allo stesso ticket. Senza la rilettura, lo
    // stesso codice avrebbe prodotto due PDF, due righe FEA e due documenti d'archivio.
    const codice = await chiediCodice()
    h.state.queues['otp_ticket_consumati'] = [
      { data: null, error: { code: '08006', message: 'connection failure' } },
    ]
    h.state.used['otp_ticket_consumati'] = 0

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.codice).toBe('PRESTAMPATO_NON_GENERATO')
    // Niente di niente: né il file, né la traccia FEA, né la riga d'archivio.
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.rimossi).toEqual([])
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
    // E il guasto si vede: `error`, non `warn`, perché è ciò che separa un codice da due atti.
    expect(campiEvento('consumo-non-registrato')).toBeDefined()
  })

  it('sull’ambiente non migrato la firma passa lo stesso: lo store assente degrada, non blocca', async () => {
    // Il DB E2E della CI è un progetto separato e non è migrato: `otp_ticket_consumati` non
    // esiste, l'INSERT prende `42P01` e la RILETTURA pure. Fermarsi lì renderebbe infirmabile
    // ogni prestampato in CI — il degrado è lo stesso che `consumeTicket` sceglie, e il
    // rischio residuo (su quell'ambiente l'uso singolo non è garantito) è dichiarato in
    // testata invece che promesso.
    const assente = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    h.state.queues['otp_ticket_consumati'] = [assente, assente]
    h.state.used['otp_ticket_consumati'] = 0
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const codice = await chiediCodice()
    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )

    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
    expect(h.state.upload).toHaveLength(1)
    expect(campiEvento('consumo-non-riletto')?.error_code).toBe('42P01')
    expect(campiEvento('consumo-non-registrato')).toBeUndefined()
  })

  it('un ticket già consumato non genera il documento una seconda volta', async () => {
    const codice = await chiediCodice()
    // La chiave primaria dello store dei jti respinge il replay: 23505.
    h.state.queues['otp_ticket_consumati'] = [{ data: null, error: { code: '23505' } }]
    h.state.used['otp_ticket_consumati'] = 0

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.motivo).toBe('gia-usato')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
  })

  it('un modulo incompleto è un 422 e NON spende il codice', async () => {
    const codice = await chiediCodice()

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        // Manca `oraArrivo`, che per l'entrata posticipata è obbligatorio.
        risposte: { giorno: '2026-09-15', tipo: 'entrata_posticipata' },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect(json.errori.map((e: { campo: string }) => e.campo)).toContain('oraArrivo')
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    expect(h.state.upload).toHaveLength(0)
  })

  it('il ticket non è legato al modello: la delega a due tutori si ferma comunque, e non spende il codice', async () => {
    // Il n. 08 è l'unico che pretende due sottoscrizioni: una delega firmata da un genitore
    // solo autorizza un terzo a portare via un bambino col consenso di metà famiglia.
    //
    // Il codice si chiede per un ALTRO modello e si spende su questo, che è ciò che un client
    // vecchio farebbe: il ticket firma `email:code:expiry` e non nomina nessun modulo. Serve
    // a provare che il rifiuto del PATCH regge da solo, senza contare sul POST che ora
    // rifiuta prima.
    const codice = await chiediCodice('permesso_orario')
    prefillMod.caricaPrefillAlunno.mockResolvedValue({
      user: { id: GENITORE, role: 'genitore' },
      prefill: PREFILL_DUE_TUTORI,
    })
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'delega_ritiro',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_DELEGA,
      }),
    )
    const json = await res.json()

    // 409 e non il 422 «campo mancante» del render: il modulo è compilato bene, è la seconda
    // firma a non avere ancora un posto dove essere raccolta. Mandare la famiglia a
    // correggere un campo sarebbe mandarla a cercare un bottone che non esiste.
    expect(res.status).toBe(409)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(json.motivoNonFirmabile).toBe('seconda-firma-mancante')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    // E il codice resta spendibile: il rifiuto arriva prima della verifica.
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
  })

  it('con un solo tutore la delega si ferma sull’allegato, e il codice resta spendibile', async () => {
    // L'altro verdetto del n. 08, quello che vale per tutte le famiglie: la scansione del
    // documento del delegato non ha nessuna porta da cui entrare. Prima di questa correzione
    // il PATCH arrivava fino al controllo degli allegati e rispondeva 422 su `documentoPath`
    // — un campo che la famiglia NON PUÒ riempire — dopo che il POST aveva già speso un invio.
    const codice = await chiediCodice('permesso_orario')

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'delega_ritiro',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_DELEGA_PERMANENTE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.motivoNonFirmabile).toBe('allegato-non-caricabile')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'delegates')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
  })

  it('l’autorizzazione all’uscita si ferma prima della firma quando la gita non c’è', async () => {
    // Un client vecchio (o una scheda lasciata aperta) può insistere su un modulo che
    // l'elenco non mostra più: qui il rifiuto arriva PRIMA che il ticket si consumi, quindi
    // la famiglia non perde il codice.
    const codice = await chiediCodice('permesso_orario')

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'autorizzazione_uscita',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_USCITA,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.codice).toBe('PRESTAMPATO_SCONOSCIUTO')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
  })

  it('firma, archivia e NON scrive l’hash dell’OTP, l’email o l’IP sul foglio che gira', async () => {
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]
    h.state.used['student_documents'] = 0

    const { res, json, codice } = await firma('permesso_orario', RISPOSTE_VALIDE)
    expect(res.status, JSON.stringify(json)).toBe(201)

    // 1. il PDF è finito nel bucket privato, sotto la cartella del bambino
    expect(h.state.upload).toHaveLength(1)
    expect(h.state.upload[0].percorso.startsWith(`${ALUNNO}/prestampati/permesso_orario-`)).toBe(true)
    expect(h.state.rimossi).toEqual([])

    // 2. la riga d'archivio porta il `document_type` del modello
    const archivio = h.state.inserimenti.find((i) => i.tabella === 'student_documents')
    expect(archivio).toBeDefined()
    expect(archivio?.righe).toMatchObject({
      student_id: ALUNNO,
      section_id: SEZIONE,
      document_type: 'permesso_orario',
      storage_path: h.state.upload[0].percorso,
      caricato_da: GENITORE,
    })
    expect(json.archiviato).toBe(true)
    expect(json.documentoId).toBe(DOCUMENTO)

    // 3. la traccia di firma, con l'impronta SHA-256 del documento
    const firmaRiga = h.state.inserimenti.find((i) => i.tabella === 'firme_documenti')
    expect(firmaRiga?.righe).toMatchObject({
      utente_id: GENITORE,
      tipo_documento: 'permesso_orario',
      indirizzo_ip: IP,
      user_agent: 'collaudo/1.0',
    })
    expect((firmaRiga?.righe as { impronta_digitale: string }).impronta_digitale).toMatch(
      /^SHA256-[0-9a-f]{64}$/,
    )
    expect((firmaRiga?.righe as { id: string }).id).toBe(json.riferimentoFirma)

    // 4. IL FOGLIO. Attesta la firma e non porta né email né indirizzo IP.
    const testo = await estraiTesto(h.state.upload[0].byte)
    // Il firmatario è scritto UNA volta e in UN ordine: quello dell'anagrafica, lo stesso
    // che il corpo del documento usa. «Anna Verdi» qui e «Verdi Anna» tre righe più su
    // erano due grafie della stessa persona sullo stesso foglio.
    expect(testo).toContain('Firmato da Verdi Anna')
    expect(testo).not.toContain('Firmato da Anna Verdi')
    expect(testo).toContain('Riferimento firma')
    expect(testo).not.toContain(EMAIL)
    expect(testo).not.toContain('esempio.test')
    expect(testo).not.toContain(IP)
    // L'hash dell'OTP vive nel log di firma, non sul foglio. Si cerca il VALORE vero —
    // `codeHash()` ricalcolato qui — e non il prefisso «SHA256-», che sul foglio non
    // sarebbe comparso comunque: quella asserzione sarebbe restata verde anche il giorno in
    // cui il render avesse cominciato a stampare l'hash con un altro prefisso.
    const hashOtp = codeHash(EMAIL, codice.devCode, codice.expiry)
    expect(hashOtp).toContain('SHA256-')
    expect(testo).not.toContain(hashOtp)
    expect(testo).not.toContain(hashOtp.replace('SHA256-', ''))
    // Nel `signature_log`, che è l'altro documento, quell'hash c'è: è il confronto che
    // rende la prova qui sopra una prova e non una coincidenza.
    expect((json.signature_log as { hash: string }).hash).toBe(hashOtp)
  })

  it('dalla scheda sanitaria l’allergene esce SUL FOGLIO e non entra in nessun log', async () => {
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('scheda_sanitaria', RISPOSTE_SANITARIA)
    expect(res.status, JSON.stringify(json)).toBe(201)

    // 1. IL CONTROLLO POSITIVO: il dato è passato davvero di qui. Senza, «non è nei log»
    // sarebbe vero anche per un campo che non è mai arrivato alla rotta.
    const testo = await estraiTesto(h.state.upload[0].byte)
    expect(testo).toContain(ALLERGENE)
    expect(testo).toContain(FARMACO)

    // 2. E NON È IN NESSUNA CHIAMATA AL LOGGER — né in un campo, né dentro un errore, né
    // in un messaggio. Sono dati dell'art. 9 di un minore: in `app_log` non ci vanno,
    // nemmeno «solo il nome del farmaco» (AGENTS.md §8).
    const tuttiILog = JSON.stringify(spie.chiamate)
    expect(tuttiILog).not.toContain(ALLERGENE)
    expect(tuttiILog).not.toContain(FARMACO)
    expect(tuttiILog).not.toContain('Nonna Inventata')
    // Lo slug sì: è un enumerato, ed è ciò che permette di contare quante schede sono
    // state firmate senza sapere che cosa dicano.
    expect(tuttiILog).toContain('scheda_sanitaria')

    // 3. IL CANALE CHE NON PASSA DAI `campi`: il corpo GREZZO della richiesta, che
    // `parseBody` deposita nel contesto PRIMA di zod e che ogni riga persistita si porta in
    // `app_log` dentro `contestoExtra.payload`.
    //
    // ⚠️ QUI PRIMA C'ERA UNA PROVA CHE NON PROVAVA NIENTE, e va detto perché non ci ritorni
    // nessuno: cercava due STRINGHE inventate dentro `redact(RISPOSTE_SANITARIA)`. Sbagliava
    // tre cose insieme — `redact` è la variante FIDATA, che sul corpo di una richiesta non
    // gira mai (là gira `redactInput`); l'oggetto non era il corpo (senza `alunnoId`, cioè
    // senza ciò che rende identificabile il bambino); e due stringhe sarebbero state redatte
    // comunque, perché fuori dalla lista bianca lo è ogni stringa. Il canale vero sono i
    // BOOLEANI: misurato con `redactInput()` sul corpo completo (script in scratchpad, `npx
    // tsx`, 2026-08-14), `terapie: true`, `vaccinazioni: false` e `ausili: true` escono IN
    // CHIARO accanto ad `alunnoId` — «questo minore è in terapia, non è vaccinato, usa
    // ausili» — perché `RADICI_TESTO_LIBERO` ha `terapia` e non `terapi`, e non ha nulla per
    // `vaccin` né per `ausil`.
    //
    // Perciò la difesa di questa rotta non è la redazione: è che lo slot venga RISCRITTO.
    // Si misura sul valore finale, e si pretende che dei campi sanitari non resti niente —
    // né un valore, né una chiave, né un booleano.
    const restato = redactInput(ultimoBodyDepositato())
    expect(restato).toEqual({ alunnoId: ALUNNO })
    const scritto = JSON.stringify(restato)
    expect(scritto).not.toContain('terapie')
    expect(scritto).not.toContain('vaccinazioni')
    expect(scritto).not.toContain('ausili')
    expect(scritto).not.toMatch(/true|false/)
  })

  it('anche il 409 di replay non porta in `app_log` un solo booleano della scheda sanitaria', async () => {
    // È il percorso che PERSISTE davvero, ed è banale da produrre: due tocchi su «Firma».
    // 409 è in `ANOMALIE_4XX` (`with-route.ts`), quindi diventa `warn`, e `vaPersistito()`
    // manda in tabella ogni `warn`: la riga finisce in `app_log` per trenta giorni, con
    // dentro il payload. Se lo slot non fosse riscritto, quella riga direbbe in SQL che cosa
    // ha dichiarato la famiglia sulla salute di suo figlio.
    const codice = await chiediCodice('scheda_sanitaria')
    h.state.queues['otp_ticket_consumati'] = [{ data: null, error: { code: '23505' } }]
    h.state.used['otp_ticket_consumati'] = 0

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'scheda_sanitaria',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_SANITARIA,
      }),
    )
    expect(res.status).toBe(409)

    const restato = redactInput(ultimoBodyDepositato())
    expect(restato).toEqual({ alunnoId: ALUNNO })
    // E il contrasto che rende la prova una prova: sul corpo INTERO, la sola redazione
    // avrebbe lasciato passare qualcosa. Non si asserisce QUALE — la lista bianca di
    // `redact.ts` va ristretta, ed è segnalato — ma che il corpo grezzo non sia innocuo:
    // qui dentro ci sono chiavi che nominano lo stato di salute di un minore.
    const corpoIntero = redactInput({ slug: 'scheda_sanitaria', alunnoId: ALUNNO, risposte: RISPOSTE_SANITARIA })
    expect(Object.keys((corpoIntero as { risposte: Record<string, unknown> }).risposte)).toContain('terapie')
  })

  it('le chiavi della riga di successo sopravvivono a `redact()` — non si prendono sulla fiducia', async () => {
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]
    const { json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    const campi = campiEvento('prestampato-firmato')
    expect(campi).toBeDefined()

    // `firma_id` e `firma_registrata` uscivano ENTRAMBI `[redatto]`: `redact` redige per
    // RADICE — `firma` è fra le `RADICI_SEGRETE` — e la politica per nome sta sopra il ramo
    // per tipo, quindi spariva anche il booleano. La riga di successo non diceva più quale
    // firma fosse stata apposta. Qui non si controlla il NOME scelto: si legge l'uscita di
    // `redact()`, che è ciò che finisce davvero in `app_log`.
    const visto = redact(campi) as Record<string, unknown>
    expect(visto.riferimento).toBe(json.riferimentoFirma)
    expect(visto.documento_id).toBe(DOCUMENTO)
    expect(visto.alunno_id).toBe(ALUNNO)
    expect(visto.scuola_id).toBe(SCUOLA)
    expect(visto.tipo).toBe('permesso_orario')
    expect(visto.esito).toBe('prestampato-firmato')
    expect(JSON.stringify(visto)).not.toContain('[redatto]')
  })

  it('la scadenza dell’archivio è quella che decide la regola condivisa, non una copia locale', async () => {
    // ⚠️ LA REGOLA È UNA SOLA E VIVE IN `prestampati/banco.ts` (la strada della segreteria):
    // questa rotta la IMPORTA, non la ricopia. Queste prove misurano che il valore arrivi
    // davvero in `expiry_date` — con due scadenze calcolate in due punti, lo stesso permesso
    // archiviato dalla famiglia scadeva e archiviato dalla segreteria no, e il cron
    // `notifiche/scadenze-documenti` avvisava in un caso solo.
    //
    // 🕐 E la prova serve anche a questo: la regola condivisa È CAMBIATA durante il lavoro —
    // il n. 09 ricorrente prima si archiviava senza scadenza, ora scade alla fine della
    // ricorrenza, «perché un permesso di uscita anticipata che non scade è un'autorizzazione
    // permanente firmata per un pomeriggio». Se questo test avesse ripetuto la regola invece
    // di misurare il collegamento, sarebbe diventato rosso su una correzione giusta di
    // un'altra mano.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]
    await firma('permesso_orario', {
      ...RISPOSTE_VALIDE,
      ricorrenzaGiorni: ['lunedi'],
      ricorrenzaFino: '2026-12-31',
    })
    expect(
      h.state.inserimenti.find((i) => i.tabella === 'student_documents')?.righe,
    ).toMatchObject({ document_type: 'permesso_orario', expiry_date: '2026-12-31' })
  })

  it('la scheda sanitaria scade a fine anno scolastico: la §05 la vuole riconfermata ogni anno', async () => {
    // 🔴 IL DIFETTO CHE QUESTA PROVA CHIUDE, e non lo vedeva nessuno. `05-scheda-sanitaria.md`
    // §Dopo la firma: «`expiry_date` = fine anno scolastico (va riconfermata ogni anno)». La
    // rotta però passava da `scadenzaDaRisposte`, che legge `al`, `ricorrenzaFino` e `giorno`
    // — e nello schema del n. 05 non c'è nessuno dei tre. Il valore era `null` SEMPRE: una
    // scheda sanitaria di un minore archiviata come se non scadesse mai, e il cron
    // `notifiche/scadenze-documenti` che non avrebbe mai chiesto la riconferma. Non era una
    // deviazione dichiarata come quella del n. 07: era un calcolo che nessuno faceva.
    //
    // La data si misura sul PRECOMPILATO e non si ricopia: `annoScolastico` è `2026/2027` e
    // il confine dell'anno scolastico lo fissa `annoScolasticoCorrente()`, che passa all'anno
    // nuovo il 1° agosto.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('scheda_sanitaria', RISPOSTE_SANITARIA)

    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(
      h.state.inserimenti.find((i) => i.tabella === 'student_documents')?.righe,
    ).toMatchObject({
      document_type: 'scheda_sanitaria',
      expiry_date: fineAnnoScolastico(DATI.annoScolastico),
    })
    // E il valore atteso è quello, non «una data qualunque»: l'ultimo giorno prima del
    // ricambio dell'anno scolastico.
    expect(fineAnnoScolastico('2026/2027')).toBe('2027-07-31')
    // Una stringa che non descrive un anno scolastico non produce una scadenza inventata.
    expect(fineAnnoScolastico('2026/2029')).toBeNull()
    expect(fineAnnoScolastico(null)).toBeNull()
  })

  it('la dieta speciale si archivia SENZA scadenza, e la decisione è dichiarata', async () => {
    // 🔴 Il contratto dei modelli promette che `expiry_date` nasca anche «dalla `validita`
    // del 07», ma quella `validita` è TESTO LIBERO (`z.string().max(120)`): «fino alla fine
    // dell'anno scolastico» non è una data, e ricavarla indovinando la ricaverebbe solo su
    // questa strada — la stessa richiesta emessa dalla segreteria resterebbe senza. Perciò
    // oggi il n. 07 non scade e il cron non avvisa: è una lacuna dichiarata, non un caso
    // dimenticato, e il rimedio è un campo `data` sul modello.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('dieta_speciale', RISPOSTE_DIETA)
    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(
      h.state.inserimenti.find((i) => i.tabella === 'student_documents')?.righe,
    ).toMatchObject({ document_type: 'dieta_speciale', expiry_date: null })
  })

  it('l’enumerato che rifiuta lo slug non fa perdere la firma, e il PDF resta dov’è', async () => {
    // 🔴 In produzione `document_type_enum` ha quattro valori e nessuno è un prestampato
    // (misurato il 2026-08-14): l'INSERT viene rifiutato, ed è il 100% delle firme.
    //
    // ⚠️ QUESTA PROVA MISURAVA IL CONTRARIO, e il contrario era il difetto. La rotta toglieva
    // il file proprio qui — sul caso deterministico — mentre la gemella dello sportello
    // (`prestampati/genera`) lo TIENE: stesso documento, stesso `document_type`, stesso
    // bucket, e due sorti opposte a seconda di chi lo genera. Riprovare domani darà lo stesso
    // errore, e quel PDF è l'unica copia agganciabile il giorno in cui l'enumerato si allarga:
    // buttarlo via voleva dire che quel giorno non c'è più niente da agganciare.
    //
    // Il prezzo è dichiarato e non è piccolo — un orfano dell'art. 9 in un bucket che l'oblio
    // non raggiunge — ed è la ragione per cui la voce mancante in `REGISTRO_BUCKET_OBLIO` è
    // segnalata come bloccante e non come nota.
    h.state.queues['student_documents'] = [
      { data: null, error: { code: '22P02', message: 'invalid input value for enum' } },
    ]
    h.state.used['student_documents'] = 0

    const { res, json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(res.status).toBe(201)
    expect(json.archiviato).toBe(false)
    expect(json.documentoId).toBeNull()
    expect(json.motivoMancatoArchivio).toBe('tipo-documento-non-ammesso')
    expect(json.url).toBeNull()
    // La firma resta: è un atto raccolto, e il riferimento stampato sul foglio la ritrova.
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(true)
    expect(json.riferimentoFirma).toBeTruthy()
    // Il file è stato caricato e NON è stato tolto.
    expect(h.state.upload).toHaveLength(1)
    expect(h.state.rimossi).toEqual([])
    // La riga di log ne ricostruisce il percorso: `alunno_id`, `tipo` e `riferimento` SONO il
    // percorso, ed è così che un essere umano ritrova il file rimasto.
    const riga = spie.chiamate.find(
      (c) =>
        c[0] === 'logEvento' &&
        (c[3] as { esito?: string })?.esito === 'prestampato-firmato-non-archiviato',
    )
    expect(riga, JSON.stringify(spie.chiamate.map((c) => c[3]))).toBeDefined()
    expect(riga?.[2]).toBe('error')
    const campi = riga?.[3] as Record<string, unknown>
    expect(`${campi.alunno_id}/prestampati/${campi.tipo}-${campi.riferimento}.pdf`).toBe(
      h.state.upload[0].percorso,
    )
    // E il foglio arriva lo stesso a chi l'ha firmato.
    const pdf = Buffer.from(String(json.pdfBase64), 'base64')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(await estraiTesto(Uint8Array.from(pdf))).toContain('Riferimento firma')
  })

  it('lo schema non ancora migrato non si racconta come «tipo di documento non ammesso»', async () => {
    // L'enumerato era CABLATO su qualunque fallimento dell'INSERT, mentre il codice vero era
    // già in mano — viene letto due righe sopra per la riga di log. Sul DB della CI, che non
    // è migrato, `student_documents` risponde `PGRST204` o `PGRST205`, e la famiglia si
    // sentiva dire una frase falsa. Anche qui il file resta: è lo schema di quell'ambiente a
    // non reggere, non un guasto, e domani su un ambiente migrato quella riga nasce.
    //
    // `PGRST205` è il codice che MANCAVA dalla mappa — la gemella ce l'ha, e
    // `consumeTicket` lo tratta già come «schema non pronto»: senza, cadeva fra gli ignoti e
    // il PDF veniva distrutto sul database della CI.
    for (const code of ['PGRST204', 'PGRST205', '42703', '42P01']) {
      h.state.inserimenti = []
      h.state.upload = []
      h.state.rimossi = []
      h.state.used = {}
      h.state.jti = new Set()
      h.state.queues['student_documents'] = [{ data: null, error: { code, message: 'schema' } }]

      const { res, json } = await firma('permesso_orario', RISPOSTE_VALIDE)

      expect(res.status, JSON.stringify(json)).toBe(201)
      expect(json.motivoMancatoArchivio, code).toBe('schema-non-pronto')
      expect(json.archiviato).toBe(false)
      expect(h.state.rimossi, code).toEqual([])
    }
  })

  it('un singhiozzo del database non lascia in giro un PDF che nessuno riprenderà', async () => {
    // ⚠️ IL CONTRASTO CHE TIENE FERMA LA MAPPA, e anche questo era all'incontrario. Su una
    // connessione caduta il tentativo dopo è un tentativo nuovo, che caricherà un file nuovo:
    // questo resterebbe orfano per niente, in un bucket che l'oblio non raggiunge. Si toglie —
    // ed è ciò che fa la gemella dello sportello — e il foglio si consegna comunque, perché
    // la firma è stata raccolta e il codice è speso.
    h.state.queues['student_documents'] = [
      { data: null, error: { code: '08006', message: 'connection failure' } },
    ]
    h.state.used['student_documents'] = 0

    const { res, json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(json.motivoMancatoArchivio).toBe('archivio-non-scritto')
    expect(json.archiviato).toBe(false)
    expect(h.state.upload).toHaveLength(1)
    expect(h.state.rimossi).toEqual([h.state.upload[0].percorso])
    // E il foglio arriva comunque a chi l'ha firmato: è l'unica copia che resta.
    expect(Buffer.from(String(json.pdfBase64), 'base64').subarray(0, 5).toString()).toBe('%PDF-')

    const riga = spie.chiamate.find(
      (c) =>
        c[0] === 'logEvento' &&
        (c[3] as { esito?: string })?.esito === 'archivio-non-scritto-file-rimosso',
    )
    expect(riga, JSON.stringify(spie.chiamate.map((c) => c[3]))).toBeDefined()
    expect(riga?.[2]).toBe('error')
  })

  it('un `check` violato non si spaccia per il tipo di documento: cade fra gli ignoti', async () => {
    // `23514` stava fra i «tipo di documento non ammesso», e non è fra i cinque codici della
    // gemella: chiamarlo così manda chi legge ad aspettare una migrazione dell'enumerato per
    // un vincolo che potrebbe essere tutt'altro. «Non lo so» ha un gruppo suo, ed è quello che
    // non promette niente.
    h.state.queues['student_documents'] = [
      { data: null, error: { code: '23514', message: 'violates check constraint' } },
    ]
    h.state.used['student_documents'] = 0

    const { json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(json.motivoMancatoArchivio).toBe('archivio-non-scritto')
    expect(h.state.rimossi).toEqual([h.state.upload[0].percorso])
  })

  it('la regola sul destino del PDF è la STESSA della rotta gemella', async () => {
    // ⚠️ LA COPIA C'È, E QUESTO LOCK È IL PREZZO. La decisione dovrebbe vivere in un posto
    // solo — `src/app/api/prestampati/banco.ts`, da cui questa strada importa già
    // `scadenzaDaRisposte` — ma quel modulo è di un'altra mano e si sta scrivendo in
    // parallelo, quindi l'insieme è duplicato in `banco-famiglia.ts`. Duplicato e SORVEGLIATO:
    // finché i due non coincidono alla lettera, lo stesso documento generato allo sportello e
    // firmato da casa avrà due sorti diverse — che è esattamente il difetto da cui si viene.
    //
    // ─── PRIMA L'IMPORT, POI (E SOLO POI) IL SORGENTE ──────────────────────────────
    //
    // La versione precedente leggeva il file della gemella con una regex stretta
    // (`new Set\(\[([^\]]*)\]\)`) e falliva se l'altra mano scriveva l'array su più righe, con
    // le virgolette doppie o con un commento che contenesse una parentesi quadra: un rosso che
    // non c'entra niente con questa rotta, in un albero di lavoro dove le due mani scrivono
    // nello stesso momento. Perciò:
    //
    //  1. se la gemella ESPORTA l'insieme, si confronta quello — è il lock vero, e non dipende
    //     da come è formattato niente. È **una riga di `export`** in `banco.ts`, dichiarata
    //     all'orchestratore;
    //  2. altrimenti si guarda il sorgente con un riconoscitore tollerante (più righe,
    //     entrambe le virgolette, nome cercato in tutti e due i file della corsia);
    //  3. se nemmeno quello trova la dichiarazione, il confronto incrociato **non si può
    //     fare**: non si finge un verde né si dipinge di rosso la formattazione altrui — si
    //     verifica ciò che è NOSTRO e resta vero comunque, cioè i cinque codici e il
    //     comportamento che ne discende.
    const nostri = [...SCHEMA_NON_PRONTO].sort()

    const gemella = (await import('@/app/api/prestampati/banco')) as unknown as Record<string, unknown>
    const esportato = gemella.SCHEMA_NON_PRONTO
    const dallExport =
      esportato instanceof Set ? [...(esportato as Set<string>)].sort() : null

    const dalSorgente = dallExport
      ? null
      : ['src/app/api/prestampati/banco.ts', 'src/app/api/prestampati/genera/route.ts']
          .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
          .map((src) => /SCHEMA_NON_PRONTO[^=]*=\s*new Set\(\s*\[([\s\S]*?)\]/.exec(src))
          .flatMap((m) =>
            m ? [[...m[1].matchAll(/['"]([A-Z0-9]+)['"]/g)].map((q) => q[1]).sort()] : [],
          )[0] ?? null

    const dellaGemella = dallExport ?? dalSorgente
    if (dellaGemella) {
      // Se questo confronto diventa rosso, non si allinea il numero: si guarda che cosa è
      // cambiato di là e si decide per tutti e due.
      expect(dellaGemella).toEqual(nostri)
    } else {
      // Il confronto incrociato è indisponibile: lo si dice qui e si misura il resto.
      expect(nostri).toEqual(['22P02', '42P01', '42703', 'PGRST204', 'PGRST205'])
    }

    // E il comportamento che ne discende, che è ciò per cui l'insieme esiste: sui codici dello
    // schema il PDF resta, su tutto il resto se ne va. Questo non dipende da nessuno.
    for (const code of nostri) {
      expect(ilFileRestaNelBucket(motivoMancatoArchivioDa(code)), code).toBe(true)
    }
    expect(ilFileRestaNelBucket(motivoMancatoArchivioDa('08006'))).toBe(false)
    expect(ilFileRestaNelBucket(motivoMancatoArchivioDa(null))).toBe(false)
  })

  it('se la traccia di firma non si scrive, non esce niente: nessun file, nessun riferimento cieco', async () => {
    // Il foglio stampa «Riferimento firma: <uuid>» prima di sapere se la riga nascerà: un
    // riferimento che non risolve è peggio di nessun riferimento. Registrandola PRIMA del
    // bucket, quando fallisce non c'è ancora niente da ritirare.
    h.state.queues['firme_documenti'] = [
      { data: null, error: { code: '23503', message: 'violates foreign key constraint' } },
    ]
    h.state.used['firme_documenti'] = 0

    const { res, json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(res.status).toBe(500)
    expect(json.codice).toBe('PRESTAMPATO_NON_GENERATO')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.rimossi).toEqual([])
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
  })

  it('il bucket condiviso, se manca, nasce coi parametri di TUTTI e non con i propri', async () => {
    // `sensitive_documents` lo usa anche il fascicolo della primaria, che carica documenti
    // d'identità in JPEG/PNG/WebP fino a 15 MB. Chi crea il bucket per primo fissa i
    // parametri per tutti: crearlo `application/pdf` e basta avrebbe fatto rispondere 500 a
    // una rotta di un'altra parte dell'app.
    h.state.bucketElenco = { data: [], error: null }
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(h.state.bucketCreati).toHaveLength(1)
    expect(h.state.bucketCreati[0].nome).toBe('sensitive_documents')
    expect(h.state.bucketCreati[0].opzioni).toMatchObject({
      public: false,
      allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
      fileSizeLimit: 15 * 1024 * 1024,
    })
  })

  it('l’errore dell’API storage si LEGGE dal valore di ritorno, non si aspetta un’eccezione', async () => {
    // `listBuckets()` ritorna `{ data, error }` e non lancia, come PostgREST: il `catch`
    // non sarebbe mai scattato, e la causa che spiega i caricamenti falliti — col corpo
    // dell'errore del provider — sarebbe andata persa (AGENTS.md §3).
    h.state.bucketElenco = { data: null, error: { message: 'storage non raggiungibile' } }
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    await firma('permesso_orario', RISPOSTE_VALIDE)

    const riga = spie.chiamate.find(
      (c) => c[0] === 'logEvento' && (c[3] as { esito?: string })?.esito === 'bucket-non-elencato',
    )
    expect(riga, JSON.stringify(spie.chiamate.map((c) => c[3]))).toBeDefined()
    expect(riga?.[2]).toBe('error')
    // Il corpo dell'errore viaggia come quarto argomento: è quello che `descriviErrore`
    // scrive per esteso nella riga persistita.
    expect(JSON.stringify(riga?.[4])).toContain('storage non raggiungibile')
    // E non si prova a crearlo alla cieca dopo un elenco che non è arrivato.
    expect(h.state.bucketCreati).toHaveLength(0)
  })

  it('dalla sessione della segreteria non si firma, e non resta niente', async () => {
    // L'altra porta che SCRIVE. Il gate del ruolo c'è su tutte e tre, ma solo il GET lo
    // aveva coperto da una prova: qui il danno sarebbe un atto firmato «il/la sottoscritto/a»
    // con il nome di chi sta allo sportello.
    const codice = await chiediCodice()
    auth.requireUser.mockResolvedValue({
      user: { id: 'u-segreteria', role: 'segreteria', nome: 'Mara', cognome: 'Rossi' },
    })

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.codice).toBe('PRESTAMPATO_FIRMA_NON_VALIDA')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
    // Il codice resta spendibile: il rifiuto arriva prima di ogni verifica.
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    expect(tetti.limitaVerificaOtp).not.toHaveBeenCalled()
  })

  it('un codice SCADUTO si riconosce da un fatto, non dalla frase della dipendenza', async () => {
    // `motivo` decideva con `/scadut/i.test(check.error)`: `verifyTicket` restituisce tre
    // messaggi italiani e nessun codice, e il giorno in cui quella frase viene riscritta il
    // campo comincia a dire `non-valido` a un codice scaduto senza che niente diventi rosso.
    // Ora si legge `expiry`, che è la stessa soglia che la dipendenza confronta.
    const codice = await chiediCodice()
    const scaduto = Date.now() - 1000

    const res = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode,
        expiry: scaduto,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.motivo).toBe('scaduto')
    expect(h.state.upload).toHaveLength(0)

    // IL CONTRASTO: con una scadenza buona e un codice sbagliato, il motivo è l'altro. Senza
    // questa metà, un `motivo: 'scaduto'` cablato passerebbe la prova qui sopra.
    const altro = await PATCH(
      reqFirma('PATCH', {
        slug: 'permesso_orario',
        alunnoId: ALUNNO,
        code: codice.devCode === '000000' ? '111111' : '000000',
        expiry: codice.expiry,
        ticket: codice.ticket,
        risposte: RISPOSTE_VALIDE,
      }),
    )
    expect((await altro.json()).motivo).toBe('non-valido')
  })

  it('l’allegato dichiarato dev’ESISTERE: senza, il farmaco non si autorizza e il codice non si spende', async () => {
    // Il n. 06 stampa la casella «Si allega prescrizione medica / piano terapeutico del
    // pediatra» per il solo fatto che la stringa non è vuota. Senza questo controllo, nel
    // fascicolo restava un'autorizzazione firmata a somministrare un farmaco a un minore che
    // dichiara allegata una prescrizione che nessuno può più recuperare.
    h.state.certificati.clear()
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('autorizzazione_farmaci', RISPOSTE_FARMACI)

    expect(res.status).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect((json.errori as { campo: string }[]).map((e) => e.campo)).toEqual(['prescrizionePath'])
    // Niente di niente, e soprattutto il codice resta spendibile: un allegato mancante è un
    // modulo da correggere, non una firma da bruciare.
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    expect(campiEvento('allegato-mancante')?.n).toBe(1)
    // E il nome del farmaco non è finito nella riga di log del rifiuto (art. 9).
    expect(JSON.stringify(spie.chiamate)).not.toContain(FARMACO)
  })

  it('l’autorizzazione al farmaco si firma ma NON entra nel fascicolo: la aspetta la Direzione', async () => {
    // 🔴 LA REGOLA DI SICUREZZA CHE MANCAVA. `docs/prestampati/README.md:27` dichiara la firma
    // del n. 06 «OTP + accettazione direzione», e `06-autorizzazione-farmaci.md:69-72` è
    // testuale: «un'autorizzazione firmata dal solo genitore non abilita nessuno a
    // somministrare niente. **All'accettazione** → PDF in `student_documents`,
    // `expiry_date = AL`».
    //
    // ⚠️ E LA PRIMA CORREZIONE NON BASTAVA. La rotta ha archiviato per un ciclo senza scadenza
    // e con la `descrizione` che diceva «in attesa di accettazione della Direzione»: ma la
    // `descrizione` è testo libero, e nessun consumatore di `student_documents` — gli elenchi
    // del fascicolo, le esportazioni, il cron — può distinguere un'autorizzazione valida da
    // una che non autorizza niente senza analizzare una frase italiana. Nel fascicolo di un
    // minore compariva un'«autorizzazione somministrazione farmaci» che non autorizza nessuno.
    //
    // Finché lo stato non esiste (è una migrazione, vietata qui), il n. 06 non si archivia. La
    // firma NON si perde: resta la riga di `firme_documenti` con l'impronta, e il foglio arriva
    // alla famiglia dentro la risposta.
    //
    // ⚠️ E NEMMENO NEL BUCKET, che è la conseguenza della riga qui sopra e non una dimenticanza.
    // Se `student_documents` non si scrive, NESSUNA riga durevole nominerebbe quel percorso:
    // `firme_documenti` non ha una colonna di percorso e `app_log` si cancella dopo trenta
    // giorni. Passati quelli, un PDF con farmaco, dosaggio e prescrizione di un minore (art. 9)
    // resterebbe nel bucket del fascicolo irraggiungibile **e** incancellabile — l'oblio non
    // arriva a ciò che non sa di esistere. Non è il caso raro: è il 100% delle firme del n. 06.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('autorizzazione_farmaci', RISPOSTE_FARMACI)

    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(json.inAttesaAccettazione).toBe(true)
    expect(json.archiviato).toBe(false)
    expect(json.documentoId).toBeNull()
    // NIENTE nel fascicolo: né la riga d'archivio né quella del registro degli accessi, che
    // racconterebbe un deposito mai avvenuto.
    expect(h.state.inserimenti.some((i) => i.tabella === 'student_documents')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'fascicolo_accessi_audit')).toBe(false)
    // E non è un fallimento: non si racconta con l'enumerato di chi ci ha provato e non ce
    // l'ha fatta.
    expect(json.motivoMancatoArchivio).toBeNull()
    // La firma resta e il foglio arriva a chi l'ha firmato — ma nel bucket non è salito niente,
    // e non c'è niente da rimuovere perché non c'è niente di orfano.
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(true)
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.rimossi).toEqual([])
    const pdf = Buffer.from(String(json.pdfBase64), 'base64')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    // La riga di log dice quante autorizzazioni sono ferme in attesa, e la si vuole persistita:
    // `modulistica` sta in `EVENTI_PERSISTITI`, quindi `info` finisce in tabella esattamente
    // come ci finirebbe `warn`. Il livello resta `info` perché `warn` è il canale in cui si
    // cercano i guasti, e un'autorizzazione che aspetta un passo di prodotto non lo è: alzarla
    // riempirebbe di esiti normali l'unico posto in cui si guarda quando qualcosa si è rotto.
    const riga = spie.chiamate.find(
      (c) =>
        c[0] === 'logEvento' &&
        (c[3] as { esito?: string })?.esito === 'prestampato-firmato-in-attesa-accettazione',
    )
    expect(riga, JSON.stringify(spie.chiamate.map((c) => c[3]))).toBeDefined()
    expect(riga?.[2]).toBe('info')
    // E il nome del farmaco non è finito in nessuna riga di log (art. 9).
    expect(JSON.stringify(spie.chiamate)).not.toContain(FARMACO)
  })

  it('gli altri modelli la scadenza la prendono dalle risposte: l’attesa riguarda il solo n. 06', async () => {
    // Il contrasto della prova qui sopra: togliere la scadenza a tutti avrebbe spento il cron
    // `notifiche/scadenze-documenti` su permessi e deleghe, che invece scadono davvero.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(res.status, JSON.stringify(json)).toBe(201)
    expect(json.inAttesaAccettazione).toBe(false)
    expect(
      h.state.inserimenti.find((i) => i.tabella === 'student_documents')?.righe,
    ).toMatchObject({ expiry_date: '2026-09-15' })
  })

  it('la prescrizione si cerca dove la specifica dice: nella RIGA dei certificati medici', async () => {
    // 🔴 IL DIFETTO CHE QUESTA PROVA CHIUDE. L'allegato si cercava SOLO in
    // `sensitive_documents`, mentre `06-autorizzazione-farmaci.md:75` dice «la prescrizione
    // allegata segue lo stesso bucket con oblio del certificato medico» — cioè
    // `certificati-medici`, dove la famiglia carica già da sé con
    // `POST /api/parent/medical-certificates`. Una prescrizione caricata per la strada che la
    // specifica indica risultava «non caricata»: 422 sull'unica strada percorribile.
    //
    // E la verifica non è sullo storage ma sulla RIGA (`alunno_id` + `file_path`): è la stessa
    // riga che `obliaCertificatiMediciAlunno` cancella, quindi passa solo un allegato che il
    // giorno dell'oblio se ne andrà davvero.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('autorizzazione_farmaci', RISPOSTE_FARMACI)
    expect(res.status, JSON.stringify(json)).toBe(201)

    // Nello storage del fascicolo non si è nemmeno guardato: quel file lì non c'è mai stato.
    expect(h.state.oggetti.has(CERTIFICATO_CHIAVE)).toBe(false)

    // E il contrasto: la STESSA chiave, ma senza la riga che la lega a questo bambino, non
    // passa. È ciò che distingue «l'ha caricata» da «ha scritto un percorso».
    h.state.inserimenti = []
    h.state.upload = []
    h.state.used = {}
    h.state.jti = new Set()
    h.state.certificati.clear()
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const senza = await firma('autorizzazione_farmaci', RISPOSTE_FARMACI)
    expect(senza.res.status).toBe(422)
    expect((senza.json.errori as { campo: string }[]).map((e) => e.campo)).toEqual([
      'prescrizionePath',
    ])
  })

  it('la forma senza magazzino continua a valere per il bucket del fascicolo', async () => {
    // Una chiave nuda è ciò che scrive `primaria/fascicolo:POST`, ed è la forma con cui
    // l'allegato arrivava prima che il riferimento nominasse il proprio bucket: l'aggancio
    // nuovo non doveva romperla, e questa prova è la ragione per cui non la rompe.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('autorizzazione_farmaci', {
      ...RISPOSTE_FARMACI,
      prescrizionePath: PRESCRIZIONE_FASCICOLO,
    })

    expect(res.status, JSON.stringify(json)).toBe(201)
    // Il n. 06 aspetta la Direzione e non entra in archivio (vedi la prova dedicata): ciò che
    // questa misura è che l'allegato in forma storica sia stato ACCETTATO, cioè che la firma
    // sia arrivata in fondo.
    expect(json.inAttesaAccettazione).toBe(true)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(true)
    // Zero e non uno: il n. 06 non sale nel bucket finché la Direzione non lo accetta (la prova
    // dedicata spiega perché). Qui si misura che l'allegato in forma storica sia stato accettato,
    // non dove finisce il foglio.
    expect(h.state.upload).toHaveLength(0)
  })

  it('un magazzino che il server non conosce non si va nemmeno a leggere', async () => {
    // La stringa la sceglie il client, e con essa sceglierebbe DOVE far leggere il
    // service-role. I magazzini ammessi sono due e li decide il server; per il n. 08 quel
    // valore finirebbe anche in `delegates.document_url`, cioè in un campo che altre
    // schermate mostrano.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('autorizzazione_farmaci', {
      ...RISPOSTE_FARMACI,
      prescrizionePath: `fatture:${ALUNNO}/qualcosa.pdf`,
    })

    expect(res.status, JSON.stringify(json)).toBe(422)
    expect((json.errori as { campo: string }[]).map((e) => e.campo)).toEqual(['prescrizionePath'])
    expect(campiEvento('allegato-fuori-perimetro')?.n).toBe(1)
    expect(h.state.upload).toHaveLength(0)
  })

  it('se la tabella dei certificati non risponde, l’allegato non si dà né per presente né per assente', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Senza controllarlo, «non ho potuto leggere»
    // sarebbe diventato «non l'hai caricato» — un rifiuto detto a chi il file l'ha caricato
    // davvero, su un'autorizzazione a somministrare un farmaco.
    h.state.queues['certificati_medici'] = [
      { data: null, error: { code: '08006', message: 'connection failure' } },
    ]
    h.state.used['certificati_medici'] = 0

    const { res, json } = await firma('autorizzazione_farmaci', RISPOSTE_FARMACI)

    expect(res.status, JSON.stringify(json)).toBe(503)
    expect(json.codice).toBe('PRESTAMPATO_NON_GENERATO')
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    const riga = spie.chiamate.find(
      (c) => c[0] === 'logEvento' && (c[3] as { esito?: string })?.esito === 'allegato-non-verificato',
    )
    expect(riga?.[2]).toBe('error')
    expect((riga?.[3] as Record<string, unknown>)?.error_code).toBe('08006')
  })

  it('l’allegato di un ALTRO bambino non passa, nemmeno quando nel bucket esiste davvero', async () => {
    // 🔴 LA CHIAVE DELL'OGGETTO LA SCEGLIE IL CLIENT. `zAllegato` è una stringa qualunque, e
    // la verifica guardava solo se il file ESISTE: bastava dichiarare un percorso di
    // `sensitive_documents` che non è tuo — la scheda sanitaria di un altro bambino — per
    // firmarci sopra un modulo, e per il n. 08 quella stringa finiva persino in
    // `delegates.document_url`, che una schermata della segreteria mostra. Qui il file
    // ESISTE DAVVERO nel bucket, ed è il punto: il rifiuto non è «non l'hai caricato», è
    // «non è di questo bambino» — e vale anche come oracolo, perché altrimenti la differenza
    // fra 422 e 201 direbbe a chi prova se quel percorso esiste.
    const ALTRUI_PRESCRIZIONE = `${ALTRUI}/prescrizioni/piano-terapeutico.pdf`
    h.state.oggetti.add(ALTRUI_PRESCRIZIONE)
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('autorizzazione_farmaci', {
      ...RISPOSTE_FARMACI,
      prescrizionePath: ALTRUI_PRESCRIZIONE,
    })

    expect(res.status, JSON.stringify(json)).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect((json.errori as { campo: string }[]).map((e) => e.campo)).toEqual(['prescrizionePath'])
    // Niente firma, niente file, e il codice resta spendibile.
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    expect(campiEvento('allegato-fuori-perimetro')?.n).toBe(1)
    // L'uuid dell'altro bambino è un dato personale di un terzo: nella riga di log ci va il
    // conteggio, non il percorso.
    expect(JSON.stringify(spie.chiamate)).not.toContain(ALTRUI)
  })

  it('il bucket si garantisce UNA volta per richiesta, non una per ogni punto che ne ha bisogno', async () => {
    // Ne servivano due — il controllo degli allegati e l'upload — e ognuno chiamava la sua:
    // due `listBuckets()` per ogni firma con allegato, per una domanda la cui risposta non
    // cambia dentro la stessa richiesta.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res } = await firma('autorizzazione_farmaci', RISPOSTE_FARMACI)

    expect(res.status).toBe(201)
    expect(h.state.bucketElencati).toBe(1)
  })

  it('se lo storage non risponde, l’allegato non si dà né per presente né per assente', async () => {
    // 503 e non 422: «non sono riuscito a controllare» non può diventare «non l'hai
    // caricato» — sarebbe una bugia detta a chi il file l'ha caricato davvero — né un sì.
    // Qui l'allegato è quello nel bucket del fascicolo, che è il ramo che passa da `list()`.
    h.state.elencoOggetti = { errore: { message: 'storage non raggiungibile' } }

    const { res, json } = await firma('autorizzazione_farmaci', {
      ...RISPOSTE_FARMACI,
      prescrizionePath: PRESCRIZIONE_FASCICOLO,
    })

    expect(res.status).toBe(503)
    expect(json.codice).toBe('PRESTAMPATO_NON_GENERATO')
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    const riga = spie.chiamate.find(
      (c) => c[0] === 'logEvento' && (c[3] as { esito?: string })?.esito === 'allegato-non-verificato',
    )
    expect(riga?.[2]).toBe('error')
    expect(JSON.stringify(riga?.[4])).toContain('storage non raggiungibile')
  })

  it('la firma deposita il documento nel fascicolo E lo scrive nel registro degli accessi', async () => {
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    await firma('scheda_sanitaria', RISPOSTE_SANITARIA)

    const audit = h.state.inserimenti.filter((i) => i.tabella === 'fascicolo_accessi_audit')
    expect(audit).toHaveLength(1)
    expect(audit[0].righe).toMatchObject({
      alunno_id: ALUNNO,
      utente_id: GENITORE,
      azione: 'upload',
      documento_id: DOCUMENTO,
    })
    // `finalita` nomina lo slug e nient'altro: è testo che finisce in un registro, non un
    // posto dove mettere quello che la famiglia ha dichiarato.
    expect(String((audit[0].righe as { finalita: string }).finalita)).not.toContain(ALLERGENE)
  })

  it('quando la riga d’archivio non nasce, nel registro degli accessi non si scrive un deposito che non c’è stato', async () => {
    h.state.queues['student_documents'] = [
      { data: null, error: { code: '22P02', message: 'invalid input value for enum' } },
    ]
    h.state.used['student_documents'] = 0

    const { json } = await firma('permesso_orario', RISPOSTE_VALIDE)

    expect(json.archiviato).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'fascicolo_accessi_audit')).toBe(false)
  })
})

// ─── Chi ritira il bambino (n. 09) ──────────────────────────────────────────────

/**
 * IL RAMO CHE NESSUNA PROVA TOCCAVA, ed è l'unica query su `delegates` del PATCH.
 *
 * Su di essa poggia tutta la giustificazione del gate ripetuto in questo handler — «il
 * permesso di leggere il delegato al ritiro si deve vedere accanto alla query che ne
 * approfitta», ed è la forma che il lock `isolamento-sede-coverage` riconosce — e finora era
 * esercitata da zero test: le risposte usate per il n. 09 erano tutte
 * `tipo: 'entrata_posticipata'`, che in quel ramo non entra mai.
 *
 * Qui si misura quello che solo la ROTTA può sbagliare: che il nome giusto finisca sul foglio,
 * che l'id di un delegato altrui non si risolva, e che una lettura fallita non diventi
 * un'accusa falsa alla famiglia.
 */
describe('PATCH — il delegato che ritira il bambino, risolto in un nome', () => {
  /** Quante volte una stringa compare nel testo estratto dal PDF. */
  function conta(testo: string, ago: string): number {
    return testo.split(ago).length - 1
  }

  /** Un permesso di uscita anticipata: è il solo che chiede chi ritira il bambino. */
  function uscitaCon(accompagnatore: string) {
    return { giorno: '2026-09-15', tipo: 'uscita_anticipata', oraUscita: '12:30', accompagnatore }
  }

  async function testoDelFoglio(json: Record<string, unknown>): Promise<string> {
    const percorso = h.state.upload[0]?.percorso
    expect(percorso, JSON.stringify(json)).toBeTruthy()
    return estraiTesto(h.state.upload[0].byte)
  }

  it('«io stesso» mette sul foglio il nome del richiedente, e un delegato mette il suo', async () => {
    // Le due metà della stessa regola, misurate una CONTRO l'altra: con «io stesso» il nome
    // del richiedente compare una volta in più che con un delegato — quella volta in più è la
    // riga «Persona che accompagna/ritira». Contarle è l'unico modo di distinguere il valore
    // dell'accompagnatore dal nome che il blocco firma stampa comunque.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]
    const ioStesso = await firma('permesso_orario', uscitaCon('io_stesso'))
    expect(ioStesso.res.status, JSON.stringify(ioStesso.json)).toBe(201)
    const testoIoStesso = await testoDelFoglio(ioStesso.json)

    h.state.inserimenti = []
    h.state.upload = []
    h.state.used = {}
    h.state.jti = new Set()
    h.state.letture = []
    h.state.delegati = [
      {
        id: DELEGATO,
        student_id: ALUNNO,
        first_name: 'Rosa',
        last_name: 'Delegata',
        relation: 'nonna',
        document_number: 'CI XX0000000',
      },
    ]
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const conDelegato = await firma('permesso_orario', uscitaCon(DELEGATO))
    expect(conDelegato.res.status, JSON.stringify(conDelegato.json)).toBe(201)
    const testoConDelegato = await testoDelFoglio(conDelegato.json)

    // Il delegato compare col suo nome, composto «cognome nome» come ovunque nel repo.
    expect(testoConDelegato).toContain('Delegata Rosa')
    // E il richiedente compare una volta in meno: la riga dell'accompagnatore adesso è sua.
    expect(conta(testoIoStesso, 'Verdi Anna')).toBe(conta(testoConDelegato, 'Verdi Anna') + 1)

    // ⚠️ LA QUERY È FILTRATA PER `student_id`, e questa riga è ciò che impedisce che
    // qualcuno tolga quel filtro senza che niente diventi rosso.
    const lettura = h.state.letture.find((l) => l.tabella === 'delegates')
    expect(lettura?.filtri).toEqual({ student_id: ALUNNO, id: DELEGATO })
  })

  it('il delegato di un ALTRO bambino non si risolve, e il permesso viene rifiutato', async () => {
    // L'id lo sceglie il client. Senza il filtro per `student_id` questa richiesta stamperebbe
    // sul permesso di un bambino il nome di una persona delegata da un'altra famiglia — e
    // quel foglio è ciò che l'educatrice guarda prima di far uscire il bambino.
    h.state.delegati = [
      {
        id: DELEGATO_ALTRUI,
        student_id: ALTRUI,
        first_name: 'Estranea',
        last_name: 'Sconosciuta',
        relation: 'zia',
        document_number: 'CI YY0000000',
      },
    ]
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('permesso_orario', uscitaCon(DELEGATO_ALTRUI))

    expect(res.status, JSON.stringify(json)).toBe(422)
    expect(json.codice).toBe('PRESTAMPATO_DATI_MANCANTI')
    expect((json.errori as { campo: string }[]).map((e) => e.campo)).toEqual(['accompagnatore'])
    // Nessun foglio, nessuna firma, e il codice resta spendibile: è un modulo da correggere.
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    // E il nome della persona di un'altra famiglia non è comparso da nessuna parte.
    expect(JSON.stringify(json)).not.toContain('Sconosciuta')
  })

  it('una scelta che non è nemmeno un id non va a interrogare il registro dei delegati', async () => {
    // `accompagnatore` è `z.string().max(120)` e `delegates.id` è un `uuid`: passare a
    // Postgres una scelta che uuid non è produce un `22P02`, cioè un ERRORE di lettura per un
    // dato che è semplicemente sbagliato — e con la correzione qui sotto quell'errore vale un
    // 503. Guardare la forma prima di chiedere è ciò che tiene distinte le due cose.
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('permesso_orario', uscitaCon('la nonna'))

    expect(res.status, JSON.stringify(json)).toBe(422)
    expect((json.errori as { campo: string }[]).map((e) => e.campo)).toEqual(['accompagnatore'])
    expect(h.state.letture.some((l) => l.tabella === 'delegates')).toBe(false)
  })

  it('un registro dei delegati NON LETTO non diventa «quella persona non è delegata»', async () => {
    // 🔴 IL DIFETTO CHE QUESTA PROVA CHIUDE. PostgREST non lancia: ritorna `{ error }`. Su una
    // lettura fallita la rotta lasciava `accompagnatore = null` e il modello rifiutava con
    // «Il delegato indicato non risulta fra i delegati attivi» — un'affermazione FALSA, detta
    // alla famiglia sul foglio che dice chi porta via il bambino da scuola.
    //
    // È la stessa situazione degli allegati, e ha la stessa risposta: 503, «non sono riuscito
    // a controllare». Il ticket non è ancora consumato, quindi non si perde niente.
    h.state.queues['delegates'] = [
      { data: null, error: { code: '08006', message: 'connection failure' } },
    ]
    h.state.used['delegates'] = 0
    h.state.queues['student_documents'] = [{ data: { id: DOCUMENTO }, error: null }]

    const { res, json } = await firma('permesso_orario', uscitaCon(DELEGATO))

    expect(res.status, JSON.stringify(json)).toBe(503)
    expect(json.codice).toBe('PRESTAMPATO_NON_GENERATO')
    expect(String(json.error)).toContain('non è stato utilizzato')
    expect(h.state.upload).toHaveLength(0)
    expect(h.state.inserimenti.some((i) => i.tabella === 'firme_documenti')).toBe(false)
    expect(h.state.inserimenti.some((i) => i.tabella === 'otp_ticket_consumati')).toBe(false)
    const riga = spie.chiamate.find(
      (c) => c[0] === 'logEvento' && (c[3] as { esito?: string })?.esito === 'delegato-non-letto',
    )
    expect(riga, JSON.stringify(spie.chiamate.map((c) => c[3]))).toBeDefined()
    expect(riga?.[2]).toBe('error')
    expect((riga?.[3] as Record<string, unknown>)?.error_code).toBe('08006')
  })
})

// ─── Le due regole che non hanno bisogno di una richiesta ───────────────────────

describe('banco-famiglia — le regole pure che le due porte condividono', () => {
  it('l’archivio dei certificati sanitari del bambino lo nominano SOLO i certificati sanitari', async () => {
    // 🔴 LA CONTRADDIZIONE CHE QUESTA REGOLA CHIUDE. Il banco spegne il n. 08 dicendo che la
    // scansione del documento di un delegato «non ha una porta»; la verifica degli allegati,
    // però, accettava `certificati-medici` per QUALUNQUE campo `file` — cioè la porta dei
    // certificati medici valeva anche per la carta d'identità della nonna. O il rifiuto era
    // ingiustificato, o quel magazzino stava per diventare un deposito generico: si è deciso
    // il secondo, perché `certificati-medici` e la riga di `certificati_medici` sono
    // l'archivio sanitario DEL BAMBINO e l'oblio li tratta come tali.
    expect(magazziniAmmessi('prescrizionePath')).toContain(BUCKET_CERTIFICATI)
    expect(magazziniAmmessi('certificatoPath')).toContain(BUCKET_CERTIFICATI)
    // Il documento d'identità di un terzo, no.
    expect(magazziniAmmessi('documentoPath')).not.toContain(BUCKET_CERTIFICATI)
    // Tutti possono nominare il bucket del fascicolo, che è la forma storica.
    for (const campo of ['prescrizionePath', 'certificatoPath', 'documentoPath', 'qualsiasi']) {
      expect(magazziniAmmessi(campo), campo).toContain(BUCKET_FASCICOLO)
    }
  })

  it('quali moduli la morosità non blocca lo dice la configurazione della sede, non la rotta', async () => {
    // ⚠️ È UNA REGOLA DI CREDITO, NON DI CODICE: l'elenco scritto dentro una rotta la mette in
    // mano a chi rilascia invece che al titolare. Si legge da
    // `admin_settings.modulistica_config.prestampati_sempre_firmabili`, che il pannello
    // impostazioni già mostra: cambiarlo non è un rilascio.
    expect([...sempreFirmabiliDa({ prestampati_sempre_firmabili: ['dieta_speciale'] })]).toEqual([
      'dieta_speciale',
    ])
    // L'elenco VUOTO è una risposta legittima — «questa sede non fa eccezioni» — e non ricade
    // sul predefinito: se ricadesse, il titolare non avrebbe modo di dire «nessuna».
    expect(sempreFirmabiliDa({ prestampati_sempre_firmabili: [] }).size).toBe(0)
    // Solo l'ASSENZA (o un valore che non è un elenco di stringhe) vale il predefinito.
    for (const config of [{}, null, { prestampati_sempre_firmabili: 'scheda_sanitaria' }]) {
      expect([...sempreFirmabiliDa(config)].sort()).toEqual([...SEMPRE_FIRMABILI_PREDEFINITI].sort())
    }
  })
})
