import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// POST /api/iscrizione/insegnanti — la porta pubblica di «Lavora con noi».
//
// È la rotta con la platea più larga e meno assistita dell'applicazione: si
// compila dal telefono, senza login, e chi la usa non ha nessuno a cui chiedere
// cosa voglia dire quello che ha appena letto. Le proprietà provate qui sono le
// cinque che, se cedono, non fanno rumore:
//
//  1. il TETTO per IP è tre l'ora, non cinque ogni dieci minuti come l'iscrizione;
//  2. la ri-validazione dei campi avviene sul SERVER — un invio fuori dal wizard
//     non esegue una riga di codice del client;
//  3. il CONSENSO obbligatorio è verificato qui, per la stessa ragione;
//  4. il DOPPIO INVIO risponde 201 come il primo, e non 409: un 409 direbbe a
//     chiunque, digitando l'email di una maestra, se quella persona ha una
//     candidatura aperta presso questa scuola;
//  5. sul database della CI — che non è migrato e la tabella non ce l'ha — la
//     risposta è 503 con un codice, MAI un 201 bugiardo.
//
// Dal 2026-08-15 se n'è aggiunta una sesta, ed è la sola che riguarda un valore
// che il client non manda più:
//
//  6. `gradi` non è più un campo del modulo. Il modulo chiede le POSIZIONI —
//     sette, di cui tre docenti — e la route le fasce le DERIVA. Un `gradi`
//     inviato da fuori non deve poter scrivere niente in quella colonna: è la
//     colonna che all'approvazione diventa `utenti.gradi`, e da lì dipende se
//     nasce un account che legge l'anagrafica dei bambini.
// =============================================================================

const h = vi.hoisted(() => ({
  /** Gli argomenti di ogni chiamata a `inviaCopiaAllaSede`. */
  copieAllaSede: [] as unknown[][],
  /** Le righe scritte in `candidature_sedi`, tenute SEPARATE da `h.inserts`. */
  righeDiSede: [] as Record<string, unknown>[],
  /** L'errore che l'INSERT sulle righe di sede deve restituire (o `null`). */
  erroreRigheDiSede: null as { code?: string; message?: string } | null,
  /** L'errore della LETTURA «quali sedi ha già» nel ramo del doppio invio. */
  erroreSediEsistenti: null as { code?: string; message?: string } | null,
  /** Colpi per chiave del rate-limit, e le opzioni con cui la route lo chiama. */
  colpi: new Map<string, number>(),
  opzioni: [] as { chiave: string; limit: number; windowMs: number }[],
  /** Le righe passate a `.insert()` su `candidature_insegnanti`. */
  inserts: [] as Record<string, unknown>[],
  /**
   * L'errore che l'INSERT deve restituire (PostgREST NON lancia: ritorna `{error}`).
   *
   * `details` e `hint` non sono decorazione: su questa tabella gli indici unici
   * sono DUE e la route li distingue per NOME cercandolo nei tre campi insieme
   * (`violaIndiceCv`), perché PostgREST non garantisce quale dei tre lo porti.
   * Un finto che sapesse riempire solo `message` non potrebbe mai provarlo.
   */
  erroreInsert: null as { code?: string; message?: string; details?: string; hint?: string } | null,
  /** Errori successivi, per provare il RITENTO senza la colonna caduta. */
  erroriSuccessivi: [] as ({ code?: string; message?: string; details?: string } | null)[],
  /**
   * La riga «già viva» che la lettura per email deve restituire sul 23505, con
   * l'email CON CUI È IN TABELLA, il suo `stato` e la SUA sede.
   *
   * L'email sta qui e non è un dettaglio del finto: l'indice che genera il
   * `23505` è `unique (lower(email))`, quindi la riga si trova solo se il
   * predicato della rilettura è lo stesso dell'indice. Un mock che ignorasse il
   * filtro restituirebbe la riga comunque, e il ramo resterebbe non collaudato.
   *
   * `stato` e `scuola_id` sono qui per la stessa ragione, e sono arrivati dopo:
   * l'indice unico è GLOBALE (vale per l'intera cooperativa) mentre l'avviso è
   * PER SEDE, quindi la riga viva può benissimo stare in un altro plesso — ed è
   * il caso in cui, prima del 2026-08-10, non veniva avvisato nessuno.
   */
  vivaPerEmail: null as { id: string; email: string; stato: string; scuola_id: string } | null,
  /** L'errore che la RILETTURA della riga viva deve restituire (PostgREST non lancia). */
  erroreRilettura: null as { code?: string; message?: string } | null,
  /** I filtri `.eq(...)` visti dal finto: colonna e valore, in ordine. */
  filtri: [] as { colonna: string; valore: unknown }[],
  /** I filtri `.in(...)` visti dal finto: colonna e valori ammessi, in ordine. */
  filtriIn: [] as { colonna: string; valori: unknown[] }[],
  /** Gli argomenti con cui `staffScuola` è stata chiamata: sede e ruoli. */
  destinatariChiesti: [] as { scuolaId: unknown; ruoli: unknown }[],
  /** Le sedi che `sediReali` deve vedere (`schools`). */
  sedi: [] as { id: string; nome: string }[],
  /** Il registro `scuole`: id → `attiva`. Assente ⇒ la sede è attiva. */
  attive: new Map<string, boolean>(),
  /** L'errore che la lettura del registro `scuole` deve restituire (fail-open). */
  erroreRegistroScuole: null as { code?: string; message?: string } | null,
  /** Ogni `logEvento` emesso durante la richiesta. */
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  /** Le notifiche accodate alla segreteria. */
  notifiche: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/security/rate-limit', () => ({
  // Un limitatore VERO in memoria, non uno stub che dice sempre sì: così il test
  // misura il tetto che la ROUTE dichiara (3/ora), non quello del finto.
  rateLimit: async (chiave: string, opts: { limit: number; windowMs: number }) => {
    h.opzioni.push({ chiave, ...opts })
    const n = (h.colpi.get(chiave) ?? 0) + 1
    h.colpi.set(chiave, n)
    return n <= opts.limit
      ? { ok: true, remaining: opts.limit - n, retryAfterMs: 0 }
      : { ok: false, remaining: 0, retryAfterMs: opts.windowMs }
  },
  clientIp: () => '203.0.113.7',
}))

vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      // `schools`: l'elenco grezzo. `scuole`: il registro del flag `attiva`, che
      // `sediReali` legge a parte per scartare le sedi soft-deleted. Due tabelle
      // diverse, due rami diversi: fusi in uno solo non si potrebbe mai provare
      // una sede disattivata, che è metà della differenza fra `tutte` e `reali`.
      if (tabella === 'schools') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.sedi.map((s) => ({ id: s.id, nome: s.nome })), error: null }).then(res)
        return b
      }
      if (tabella === 'scuole') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve(
            h.erroreRegistroScuole
              ? { data: null, error: h.erroreRegistroScuole }
              : {
                  data: h.sedi.map((s) => ({ id: s.id, attiva: h.attive.get(s.id) ?? true })),
                  error: null,
                },
          ).then(res)
        return b
      }
      // ── `candidature_sedi`: LE RIGHE DI SEDE, UN RAMO SUO ─────────────────
      // ⚠️ Non condivide `h.inserts` con `candidature_insegnanti`, ed è la
      // correzione di un difetto del FINTO: finché tutti gli insert finivano in
      // un elenco solo, `expect(h.inserts).toHaveLength(1)` misurava «quante
      // scritture in tutto» credendo di misurare «quante candidature». Il giorno
      // in cui la route ha cominciato a scrivere anche le sedi, cinque test sono
      // diventati rossi senza che la candidatura fosse cambiata di una virgola.
      // Un finto che confonde due tabelle fa dire ai test cose che non stanno
      // guardando.
      if (tabella === 'candidature_sedi') {
        const s2: Record<string, unknown> = {}
        let filtroCand: unknown = undefined
        s2.insert = (righe: Record<string, unknown>[]) => {
          const elenco = Array.isArray(righe) ? righe : [righe]
          if (!h.erroreRigheDiSede) h.righeDiSede.push(...elenco)
          return Promise.resolve({ data: null, error: h.erroreRigheDiSede })
        }
        // ⚠️ Dal 2026-08-20 la rotta LEGGE anche questa tabella: nel ramo del
        // doppio invio chiede quali sedi la candidatura viva abbia già, per
        // agganciarle solo quelle nuove. Un finto che sapesse solo inserire
        // faceva morire quel ramo con un 500 — cioè trasformava la riparazione
        // in un guasto peggiore di quello che riparava.
        s2.select = () => s2
        s2.eq = (col: string, val: unknown) => {
          if (col === 'candidatura_id') filtroCand = val
          return s2
        }
        s2.then = (res: (v: unknown) => unknown) =>
          Promise.resolve(
            h.erroreSediEsistenti
              ? { data: null, error: h.erroreSediEsistenti }
              : {
                  data: h.righeDiSede.filter((r) => r.candidatura_id === filtroCand),
                  error: null,
                },
          ).then(res)
        return s2
      }
      // `candidature_insegnanti`: INSERT (con eventuale ritento) e lettura della
      // riga già viva per email sul 23505.
      const b: Record<string, unknown> = {}
      let scrittura = false
      b.insert = (row: Record<string, unknown>) => {
        scrittura = true
        h.inserts.push(row)
        return b
      }
      b.select = () => b
      // Il filtro si MEMORIZZA, non si ignora: un `eq` no-op restituirebbe la
      // riga viva qualunque cosa la route chiedesse, e il ramo del doppio invio
      // resterebbe verde anche con un predicato sbagliato.
      b.eq = (colonna: string, valore: unknown) => {
        h.filtri.push({ colonna, valore })
        return b
      }
      // ANCHE `.in` SI MEMORIZZA, e per la stessa ragione di `.eq`.
      //
      // La rilettura del doppione filtra sugli STATI VIVI
      // (`stato in ('pending','in_approvazione')`), ed è quel filtro a distinguere
      // «duplicata e tracciata» da una riga già rifiutata che non deve più
      // contare. Finché il finto ignorava `.in`, toglierlo dalla route non
      // faceva rosso nessun test: metà del predicato era decorativa.
      b.in = (colonna: string, valori: unknown[]) => {
        h.filtriIn.push({ colonna, valori })
        return b
      }
      b.order = () => b
      b.limit = () => b
      b.single = async () => {
        const errore = h.inserts.length === 1 ? h.erroreInsert : (h.erroriSuccessivi.shift() ?? null)
        return errore ? { data: null, error: errore } : { data: { id: 'cand-nuova' }, error: null }
      }
      b.maybeSingle = async () => {
        if (scrittura) return { data: { id: 'cand-nuova' }, error: null }
        // PostgREST NON LANCIA: ritorna `{ error }`. Il finto sa farlo, così il
        // ramo che controlla `erroreViva` ha un caso che lo esercita — senza,
        // spegnere quel controllo non fa rosso niente.
        if (h.erroreRilettura) return { data: null, error: h.erroreRilettura }
        // `.eq` È SENSIBILE ALLE MAIUSCOLE, e qui si comporta come tale: il
        // confronto è ESATTO contro l'email che la riga viva ha IN TABELLA.
        //
        // La distinzione è tutto il punto di questo finto. Il `23505` lo decide
        // l'indice, che confronta `lower(email)`; la rilettura la decide `eq`,
        // che confronta i byte. Se il mock ammorbidisse `eq` in un confronto
        // insensibile, coprirebbe proprio il disallineamento fra i due — cioè
        // renderebbe verde il difetto che questo file esiste per vedere.
        const chiesta = h.filtri.find((f) => f.colonna === 'email')?.valore
        const viva = h.vivaPerEmail
        // Il filtro sugli stati si applica SE la route lo dichiara, come farebbe
        // il database: senza `.in` una tabella vera restituirebbe la riga
        // qualunque sia il suo stato. È quel comportamento fedele a rendere rosso
        // il caso della riga «rifiutata» quando il filtro sparisce dalla route.
        const statiChiesti = h.filtriIn.find((f) => f.colonna === 'stato')?.valori as
          | string[]
          | undefined
        const combacia =
          viva !== null &&
          chiesta === viva.email &&
          (statiChiesti === undefined || statiChiesti.includes(viva.stato))
        return {
          data: combacia ? { id: viva.id, scuola_id: viva.scuola_id } : null,
          error: null,
        }
      }
      return b
    },
  }),
}))

vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: vi.fn(async (_s: unknown, p: Record<string, unknown>) => {
    h.notifiche.push(p)
  }),
}))
// ⚠️ SI FINGE L'ORCHESTRATORE, NON `sendEmailDetailed`.
// La copia alla sede è una funzione sola con un contratto suo — «non lancia mai,
// e ogni esito è a log» — ed è collaudata per intero in
// `__tests__/lib/candidature/copia-alla-sede.test.ts`. Qui interessa solo la
// domanda che riguarda LA ROTTA: parte, con quale sede, e in quali rami no.
// Fingere il livello sotto rifarebbe quel collaudo una seconda volta e legherebbe
// questi test alla forma dell'email invece che al comportamento della rotta.
vi.mock('@/lib/candidature/copia-alla-sede', () => ({
  inviaCopiaAllaSede: (...a: unknown[]) => h.copieAllaSede.push(a) && Promise.resolve({ ok: true, rinviabile: false }),
}))

vi.mock('@/lib/notifiche/destinatari', () => ({
  // GLI ARGOMENTI SI MEMORIZZANO. Il payload di `notificaEvento` dice a CHI è
  // indirizzato l'avviso; `staffScuola` decide CHI lo riceve, ed è la seconda
  // cosa a poter sbagliare sede senza che la prima se ne accorga. In un repo con
  // tre plessi e un audit di isolamento, è il pezzo da fissare.
  staffScuola: vi.fn(async (_s: unknown, scuolaId: unknown, ruoli: unknown) => {
    h.destinatariChiesti.push({ scuolaId, ruoli })
    return ['utente-segreteria']
  }),
}))

import { POST } from '@/app/api/iscrizione/insegnanti/route'
import {
  CONSENSI_INSEGNANTI_FIELDS,
  CONSENSI_INSEGNANTI_VERSIONE,
  INSEGNANTE_FIELDS,
} from '@/lib/forms/insegnanti-template'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'

/**
 * LE COLONNE CHE L'INSERT PUÒ TOCCARE, derivate dal TEMPLATE e non ribattute.
 *
 * `costruisciRiga` costruisce la riga campo per campo dal template e la route ci
 * aggiunge `scuola_id` e `consents_log`: sono queste, e nessun'altra. Derivarle
 * invece di elencarle è la sola forma che regge — un elenco a mano qui dentro
 * resterebbe indietro il giorno in cui il template guadagna un campo, e il test
 * diventerebbe rosso per la ragione sbagliata.
 *
 * ⚠️ `gradi` È L'UNICA COLONNA SCRITTA A MANO, e l'unica che il template non
 * contiene. Dal 2026-08-15 non è più un campo del modulo — è uscita da
 * `INSEGNANTE_FIELDS` — ma la route la scrive lo stesso, perché la DERIVA dalle
 * posizioni (`gradiDallePosizioni`). È l'unica colonna dell'INSERT il cui valore
 * non arriva da un campo: senza questa riga l'uguaglianza qui sotto diventerebbe
 * rossa su una colonna che la route ha il compito di scrivere.
 */
const COLONNE_AMMESSE = [
  ...INSEGNANTE_FIELDS.map((f) => f.id),
  'gradi',
  'scuola_id',
  'consents_log',
].sort()

/**
 * I TRE AVVISI SI DISTINGUONO DAL TESTO, e qui si guarda un FRAMMENTO.
 *
 * Il conteggio, il `tipo`, la sede e il link erano già fissati; il CORPO no — ed
 * è l'unica parte che dice alla segreteria *quale dei tre fatti* è successo.
 * Misurato: con questi frammenti assenti dal collaudo, sostituire il corpo del
 * ramo «altrove» con quello «stessa sede» lasciava la suite verde, e svuotare il
 * corpo del primo invio pure.
 *
 * Si confronta un frammento e non la frase intera di proposito: un test che
 * ricopia il glossario diventa rosso per un apostrofo tipografico cambiato, e in
 * questo repo è già successo. Il frammento è la parte SEMANTICA — quella che non
 * si può togliere senza cambiare il fatto raccontato.
 */
const FRAMMENTO_AVVISO = {
  /** Primo invio: la parola che dice «riga nuova, di questa sede». */
  nuova: 'candidatura spontanea',
  /** Doppio invio con la riga viva QUI: la parola che dice «di nuovo». */
  duplicataQui: 'inviato di nuovo',
  /** Doppio invio con la riga viva ALTROVE: la parola che dice «non è qui». */
  duplicataAltrove: 'per la cooperativa',
} as const

/**
 * Il corpo dell'avviso è QUELLO dei tre, e non uno degli altri due.
 *
 * L'asserzione negativa non è pignoleria: senza, scambiare due corpi fra i rami
 * resterebbe verde finché il corpo scambiato contiene per caso il frammento
 * atteso. È lo scambio, non la mancanza, il difetto che si è misurato.
 */
function attendiCorpo(corpo: unknown, quale: keyof typeof FRAMMENTO_AVVISO): void {
  const testo = String(corpo ?? '')
  expect(testo, 'la segreteria ha ricevuto un avviso SENZA testo').not.toBe('')
  expect(testo, `l’avviso non è quello di «${quale}»`).toContain(FRAMMENTO_AVVISO[quale])
  for (const [nome, frammento] of Object.entries(FRAMMENTO_AVVISO)) {
    if (nome === quale) continue
    expect(testo, `l’avviso di «${quale}» porta il testo di «${nome}»`).not.toContain(frammento)
  }
}

/** Una candidatura valida e completa: da qui si toglie o si sposta un pezzo per volta. */
const candidatura = (extra: Record<string, unknown> = {}) => ({
  nome: 'Ines',
  cognome: 'Prova',
  email: 'ines.prova@example.invalid',
  telefono: '+39 333 0000000',
  residence_city: 'Comune di Prova',
  residence_province: 'NA',
  titolo_studio: 'laurea_triennale',
  anni_esperienza: 3,
  // ⚠️ `posizioni`, NON PIÙ `gradi`. Dal 2026-08-15 «per quali fasce ti proponi»
  // non è più una domanda del modulo: le fasce stanno dentro le tre posizioni
  // docenti («Insegnante — Nido (0-3)») e la route le deriva. Un corpo che
  // mandasse ancora `gradi` prende 400 dallo zod, che pretende `posizioni`.
  posizioni: ['insegnante_nido', 'insegnante_infanzia'],
  disponibilita: 'tempo_pieno',
  note: 'Mi presento in poche righe.',
  presa_visione_informativa: true,
  ...extra,
})

const invia = (corpo: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione/insegnanti', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(corpo),
    }),
  )

const inviaValida = (dati: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  invia({ scuole_ids: [SEDE_A], data: candidatura(dati), ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  h.colpi.clear()
  h.opzioni = []
  h.inserts = []
  h.erroreInsert = null
  h.erroriSuccessivi = []
  h.vivaPerEmail = null
  h.erroreRilettura = null
  h.filtri = []
  h.filtriIn = []
  h.destinatariChiesti = []
  h.attive = new Map()
  h.erroreRegistroScuole = null
  h.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ]
  h.eventi = []
  h.notifiche = []
  h.copieAllaSede = []
  h.righeDiSede = []
  h.erroreRigheDiSede = null
  h.erroreSediEsistenti = null
})

describe('POST /api/iscrizione/insegnanti · il percorso felice', () => {
  it('201 con l’id, la riga scritta e il successo LOGGATO', async () => {
    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'cand-nuova' })

    expect(h.inserts).toHaveLength(1)
    const riga = h.inserts[0]
    // LE CHIAVI SONO ESATTAMENTE QUELLE, e si guardano tutte insieme.
    //
    // Un elenco di `toHaveProperty` prova che ci sono le colonne attese; non
    // prova che NON ce ne siano altre — che è la proprietà portante di questa
    // rotta. Misurato: con il solo elenco positivo, sostituire la costruzione
    // della riga con `{ ...normalizzati, ...costruisciRiga(…), … }` lasciava
    // verdi tutti e quattro i file di collaudo di questa corsia.
    expect(Object.keys(riga).sort(), 'l’INSERT tocca colonne che nessuno gli ha dato').toEqual(
      COLONNE_AMMESSE,
    )
    // La sede si DICHIARA: un INSERT che di plesso non parla archivia nel default.
    expect(riga.scuola_id).toBe(SEDE_A)
    expect(riga.nome).toBe('Ines')
    expect(riga.email).toBe('ines.prova@example.invalid')
    // `posizioni` è SEMPRE esplicito e mai vuoto. Il CHECK in tabella è
    // `cardinality(posizioni) >= 1` (migrazione `20260814225302`), che su un
    // array vuoto vale FALSO — a differenza di `array_length`, che vale NULL, e
    // un CHECK che vale NULL PASSA: è il difetto che `gradi` ha avuto per mesi.
    expect(riga.posizioni).toEqual(['insegnante_nido', 'insegnante_infanzia'])
    // `gradi` non è più un campo del modulo: qui c'è quello che la route ha
    // DERIVATO dalle due posizioni docenti spuntate sopra.
    expect(riga.gradi).toEqual(['nido', 'infanzia'])

    // La prova del consenso, con la versione dalla COSTANTE SERVER.
    const prova = riga.consents_log as Record<string, unknown>
    expect(prova.versione_informativa).toBe(VERSIONE_PRIVACY)
    const blocchi = prova.blocchi as { field_id: string; accepted: boolean }[]
    expect(blocchi.map((b) => b.field_id).sort()).toEqual(
      CONSENSI_INSEGNANTI_FIELDS.map((f) => f.id).sort(),
    )
    expect(blocchi.find((b) => b.field_id === 'presa_visione_informativa')?.accepted).toBe(true)

    // Il successo si logga: senza, «nessun log» non distingue «non si candida
    // nessuno» da «il modulo non è mai partito».
    const felice = h.eventi.find(
      (e) => e.evento === 'candidatura' && e.campi.esito === 'candidatura-ricevuta',
    )
    expect(felice?.livello).toBe('info')
    expect(felice?.campi.operazione).toBe('iscrizione/insegnanti:POST')
    // `scuola_id` e non `sede_id`: è il nome della COLONNA, ed è quello che
    // `src/lib/ui/esito-fetch.ts` prescrive per questi log. Due nomi per la
    // stessa cosa nella stessa funzionalità costringono chi interroga `app_log`
    // a conoscerli entrambi — e a scoprire il secondo quando la query torna vuota.
    expect(felice?.campi.scuola_id).toBe(SEDE_A)
    expect(felice?.campi.n_posizioni).toBe(2)
  })

  // ===========================================================================
  // IL LOG DEL SUCCESSO CONTA, NON NOMINA
  //
  // I tre campi rispondono alle tre domande che si fanno a `app_log` su questa
  // rotta: quante posizioni sono state spuntate (il modulo raccoglie?), se
  // all'approvazione nascerà un account docente — l'unico bivio pesante di
  // questa funzionalità, perché quell'account legge l'anagrafica dei bambini —
  // e se il curriculum è arrivato, che dal 2026-08-15 è la misura di una
  // funzione appena aperta.
  //
  // ⚠️ E NIENT'ALTRO. `redact()` lascia passare numeri e booleani per TIPO,
  // quindi qualunque «quali» aggiunto qui uscirebbe in chiaro insieme a loro:
  // le posizioni dicono che lavoro sta cercando una persona, il percorso è la
  // chiave con cui si firma il suo curriculum. `n_gradi`, che stava qui prima,
  // per una cuoca varrebbe zero — e zero si legge «candidatura senza fasce»,
  // cioè il difetto che quel numero serviva a scoprire.
  // ===========================================================================
  it('il log del successo porta `n_posizioni`, `docente` e `con_cv`, e nessun «quale»', async () => {
    const res = await inviaValida({
      posizioni: ['insegnante_nido', 'cuoca'],
      cv_path: 'candidature/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-cv.pdf',
    })
    expect(res.status).toBe(201)

    const felice = h.eventi.find((e) => e.campi.esito === 'candidatura-ricevuta')
    expect(felice?.campi.n_posizioni).toBe(2)
    expect(felice?.campi.docente, 'una posizione docente non è stata contata').toBe(true)
    expect(felice?.campi.con_cv).toBe(true)
    const scritto = JSON.stringify(felice?.campi)
    expect(scritto, 'le posizioni scelte sono uscite nel log').not.toContain('cuoca')
    expect(scritto).not.toContain('insegnante_nido')
    expect(scritto, 'il percorso del curriculum è uscito nel log').not.toContain('candidature/')

    // E il verso opposto, che è quello nuovo: una candidatura NON docente e
    // senza curriculum. `docente: false` è ciò che distingue in SQL le
    // candidature che faranno nascere un account da quelle che non ne faranno
    // nessuno — senza, quel bivio non è contabile.
    h.eventi = []
    await inviaValida({ posizioni: ['segreteria'] })
    const seconda = h.eventi.find((e) => e.campi.esito === 'candidatura-ricevuta')
    expect(seconda?.campi.n_posizioni).toBe(1)
    expect(seconda?.campi.docente, 'una candidatura di segreteria è contata come docente').toBe(false)
    expect(seconda?.campi.con_cv).toBe(false)
  })

  // ===========================================================================
  // LE COLONNE DI STATO NON SI SCRIVONO DA FUORI
  //
  // `data` è `.loose()` per non perdere le chiavi del wizard, e la stessa tabella
  // dichiara `stato` (con `check … 'approvata'`), `utente_id`, `evasa_da`,
  // `evasa_il` e `motivo_rifiuto` (`20260810094610_candidature_insegnanti.sql`).
  // Se la riga si costruisse spargendo `data`, un POST SENZA LOGIN scriverebbe
  // una candidatura già approvata e già collegata a un account — sulla rotta con
  // la platea più larga dell'applicazione.
  //
  // Il codice è corretto (`costruisciRiga` non fa lo spread e lo dichiara in
  // testata); quello che mancava era il lucchetto che lo tiene fermo.
  // ===========================================================================
  it('le colonne di STATO inviate da un ANONIMO non entrano nell’INSERT', async () => {
    const res = await inviaValida({
      stato: 'approvata',
      utente_id: '00000000-0000-4000-8000-000000000001',
      evasa_da: '00000000-0000-4000-8000-000000000002',
      evasa_il: '1999-01-01T00:00:00.000Z',
      motivo_rifiuto: 'nessuno',
      creata_il: '1999-01-01T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000003',
    })
    // Le chiavi in più non fanno 400: `data` è `.loose()` per progetto. Vengono
    // semplicemente IGNORATE — ed è questa la differenza da provare.
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(1)
    for (const colonna of [
      'stato',
      'utente_id',
      'evasa_da',
      'evasa_il',
      'motivo_rifiuto',
      'creata_il',
      'id',
    ]) {
      expect(
        h.inserts[0],
        `«${colonna}» è entrata nell’INSERT da una richiesta senza login`,
      ).not.toHaveProperty(colonna)
    }
    // E la riga resta esattamente quella di sempre: né una colonna in più, né una in meno.
    expect(Object.keys(h.inserts[0]).sort()).toEqual(COLONNE_AMMESSE)
  })

  it('la versione dei consensi NON arriva dal client', async () => {
    // ⚠️ IL VALORE AVVELENATO VA DENTRO `data`, ED È L'UNICO POSTO CHE CONTA.
    //
    // Prima stava al primo livello del corpo (`{ scuola_id, data, versione }`),
    // e lì non provava niente: `postBodySchema` è uno `z.object` semplice, non
    // `.loose()`, quindi zod SCARTA la chiave prima che la route la veda.
    // Misurato: con quella forma, sostituire nella route `versione_informativa:
    // VERSIONE_PRIVACY` con `(dati.versione as string) ?? VERSIONE_PRIVACY` —
    // cioè fare esattamente la cosa che il test dichiara di impedire — lasciava
    // la suite verde. Il vettore vero è `data`, che è `.loose()` e conserva
    // tutto quello che il client ci mette.
    //
    // Non è un cavillo: `consents_log.versione_informativa` è la PROVA di quale
    // informativa la persona ha accettato, congelata per anni, su dati di chi
    // cerca lavoro. Se la dettasse il client, varrebbe zero.
    await inviaValida({
      versione: '1999-01-01',
      versione_informativa: '1999-01-01',
      versione_consensi: '1999-01-01',
      accettato_il: '1999-01-01',
    })
    const prova = h.inserts[0].consents_log as Record<string, unknown>
    expect(prova.versione_informativa).toBe(VERSIONE_PRIVACY)
    expect(prova.versione_consensi).toBe(CONSENSI_INSEGNANTI_VERSIONE)
    expect(JSON.stringify(prova)).not.toContain('1999-01-01')
  })

  it('avvisa la segreteria della sede, con il link al cockpit', async () => {
    await inviaValida()
    expect(h.notifiche).toHaveLength(1)
    expect(h.notifiche[0].tipo).toBe('candidatura_ricevuta')
    expect(h.notifiche[0].scuolaId).toBe(SEDE_A)
    expect(h.notifiche[0].link).toBe('/admin/modulistica?tab=candidature')
    // IL CORPO DICE QUALE DEI TRE FATTI È SUCCESSO, e nessun'altra asserzione lo
    // teneva fermo: svuotarlo lasciava la suite verde, cioè la segreteria poteva
    // ricevere una notifica senza testo senza un rosso.
    attendiCorpo(h.notifiche[0].corpo, 'nuova')
  })

  it('i DESTINATARI si chiedono alla sede della candidatura, non a un’altra', async () => {
    // Il `scuolaId` del payload dice a chi è INDIRIZZATO l'avviso; `staffScuola`
    // decide chi lo RICEVE. Sono due cose, e finché il collaudo guardava solo la
    // prima, sostituire la sede nella seconda restava verde: l'avviso di
    // Giugliano sarebbe arrivato alla segreteria di Aversa senza un rosso.
    await inviaValida()
    expect(h.destinatariChiesti).toHaveLength(1)
    expect(h.destinatariChiesti[0].scuolaId, 'i destinatari sono di un’altra sede').toBe(SEDE_A)
    // I tre ruoli che in segreteria leggono le candidature: toglierne uno
    // significa una scrivania che non riceve più niente, in silenzio.
    expect(h.destinatariChiesti[0].ruoli).toEqual(['admin', 'coordinator', 'segreteria'])
  })
})

// =============================================================================
// IL PERCORSO DEL CURRICULUM — un campo anonimo che è la CHIAVE DI UN GATE
//
// `cv_path` arriva da una richiesta senza login e finisce in tabella. Il campo
// del template è `type: 'file'` e dichiara `accept` e `max_size_mb`, che valgono
// per il selettore del BROWSER: `validateField` su quel tipo non ha né `pattern`
// né `max_length`, quindi senza una difesa qui chiunque scrive nella colonna la
// stringa che vuole.
//
// Il problema non è la colonna: è che quella colonna È la chiave con cui il
// cockpit autorizza la firma di un oggetto dello Storage
// (`assertCurriculumInScope` in `admin/candidature-insegnanti/route.ts`: «esiste
// una candidatura di una MIA sede con quel `cv_path`» ⇒ URL firmato). Il bucket
// è `form_attachments`, lo stesso dei documenti d'iscrizione dei MINORI. Chi
// conosce il percorso di un oggetto — un URL firmato lo contiene in chiaro,
// quindi basta un link inoltrato — potrebbe candidarsi indicando quel percorso e
// far firmare alla segreteria un documento che non è un curriculum.
// =============================================================================
describe('POST /api/iscrizione/insegnanti · il percorso del curriculum', () => {
  /**
   * La forma che la rotta di caricamento produce — `candidature/<uuid>-cv.<est>`.
   *
   * ⚠️ IL NOME DEL FILE NON C'È PIÙ, e non è un dettaglio di scrittura: fino al
   * 2026-08-15 qui c'era `-curriculum.pdf`, cioè una forma che ammetteva un nome
   * arbitrario dopo l'uuid. `costruisciPercorsoCv` non conserva più niente di
   * quello che manda il browser (su questa porta il file si chiama
   * `cv-<cognome>.pdf`), e `CV_FORMA` pretende la stringa fissa `-cv`: un
   * percorso finisce in una colonna, dentro un URL firmato che lo porta in
   * chiaro e — se qualcuno si distrae — dentro un log.
   */
  const CV_BUONO = 'candidature/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-cv.pdf'

  it('un percorso NELLA FORMA della rotta di caricamento passa e finisce in tabella', async () => {
    const res = await inviaValida({ cv_path: CV_BUONO })
    expect(res.status).toBe(201)
    expect(h.inserts[0].cv_path).toBe(CV_BUONO)
  })

  it('il percorso di un DOCUMENTO D’ISCRIZIONE è respinto: è il bucket dei minori', async () => {
    // Il prefisso `iscrizioni/` è quello che produce `iscrizione/upload:POST`
    // nello STESSO bucket. Accettarlo qui vorrebbe dire che la segreteria, con un
    // clic su «Curriculum», ottiene un URL firmato per la carta d'identità di un
    // bambino — e il gate cross-sede dell'altra corsia sarebbe aggirato dalla
    // porta pubblica, non forzato.
    const res = await inviaValida({
      cv_path: 'iscrizioni/generico/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-carta-identita.pdf',
    })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(Object.keys(j.campi), 'il campo respinto va NOMINATO').toContain('cv_path')
    expect(h.inserts, 'un percorso arbitrario è entrato in tabella').toHaveLength(0)
  })

  it('una stringa arbitraria è respinta, e il percorso NON finisce nei log', async () => {
    const res = await inviaValida({ cv_path: '../../secret/chiavi.env' })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    const avviso = h.eventi.find((e) => e.campi.esito === 'cv-path-non-ammesso')
    expect(avviso?.livello).toBe('warn')
    // Il percorso contiene il NOME DEL FILE, che su questa porta è quasi sempre
    // il nome di una persona: si logga che è stato respinto, non che cosa era.
    expect(JSON.stringify(avviso?.campi)).not.toContain('secret')
  })

  it('un’estensione fuori dall’allowlist del bucket è respinta', async () => {
    // `form_attachments` ammette cinque tipi e `.exe` non è fra quelli: un
    // riferimento che il bucket non potrebbe contenere non è un curriculum.
    //
    // Il percorso è per il resto QUELLO BUONO (`-cv.`) di proposito: con un nome
    // qualunque davanti all'estensione il rifiuto arriverebbe dalla FORMA, e
    // questo caso misurerebbe la regex invece dell'allowlist — cioè resterebbe
    // verde anche togliendo del tutto il controllo sull'estensione.
    const res = await inviaValida({
      cv_path: 'candidature/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-cv.exe',
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('un percorso SMISURATO è respinto: la colonna non è un campo di testo libero', async () => {
    // È il tetto (`CV_MAX_LUNGHEZZA`) a rifiutarlo, non la forma: `percorsoCvAmmesso`
    // guarda la lunghezza PRIMA della regex, proprio perché questa stringa arriva
    // da fuori e può essere enorme — una da 10.000 caratteri non deve nemmeno
    // arrivare al motore delle espressioni regolari.
    const res = await inviaValida({
      cv_path: `candidature/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-${'a'.repeat(500)}.pdf`,
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('senza curriculum non cambia niente: il campo è FACOLTATIVO', async () => {
    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(h.inserts[0].cv_path).toBeNull()
  })

  // ===========================================================================
  // I DUE `23505` DI QUESTA TABELLA NON SONO LO STESSO FATTO
  //
  // Dal 2026-08-15 gli indici unici sono due — `candidature_insegnanti_email_viva`
  // e `candidature_insegnanti_cv_unico` — e la traduzione è OPPOSTA:
  //  · l'email è il doppio invio della stessa persona ⇒ 201, perché un 409 su un
  //    modulo anonimo direbbe a chiunque se una maestra si è candidata qui;
  //  · il curriculum è un percorso GIÀ dichiarato da un'altra candidatura ⇒ 400
  //    sul campo. Qui non c'è nessun oracolo da chiudere (l'uuid del percorso lo
  //    genera il server) e un 201 sarebbe la bugia più cara che questa rotta
  //    possa dire: «ricevuta» su una riga che non è stata scritta da nessuna
  //    parte, letta da una persona che quindi non riprova.
  //
  // I due si distinguono SOLO per il nome del vincolo, ed è per questo che il
  // caso qui sotto lo mette in `details` e non in `message`: PostgREST non
  // garantisce quale dei tre campi lo porti, e `violaIndiceCv` li guarda insieme.
  // Cercandolo in uno solo, la distinzione smetterebbe di funzionare senza che
  // niente diventi rosso.
  // ===========================================================================
  it('23505 dell’indice `…_cv_unico` ⇒ 400 con il campo NOMINATO, mai il 201 del doppione', async () => {
    h.erroreInsert = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (cv_path)=(…) already exists. candidature_insegnanti_cv_unico',
    }

    const res = await inviaValida({ cv_path: CV_BUONO })
    expect(res.status, 'un 23505 del curriculum ha risposto «ricevuta»').toBe(400)
    expect(res.status).not.toBe(201)
    expect(Object.keys((await res.json()).campi)).toContain('cv_path')

    // Nessuna rilettura della riga viva e nessun avviso: non c'è nessun doppio
    // invio da raccontare alla segreteria, c'è un allegato da riattaccare.
    expect(h.filtri.some((f) => f.colonna === 'email')).toBe(false)
    expect(h.notifiche).toHaveLength(0)

    const avviso = h.eventi.find((e) => e.campi.esito === 'cv-path-gia-dichiarato')
    expect(avviso?.livello).toBe('warn')
    expect(avviso?.campi.scuola_id).toBe(SEDE_A)
    // Il percorso resta fuori dal log: è la chiave con cui il cockpit fa firmare
    // il curriculum di una persona.
    expect(JSON.stringify(avviso?.campi)).not.toContain('candidature/')
  })

  it('23505 dell’EMAIL con un `cv_path` valido resta il doppio invio: 201', async () => {
    // La faccia opposta, e serve a dire che la distinzione non è «c'è un
    // curriculum ⇒ è il curriculum»: il nome del vincolo è l'unica cosa che
    // decide. Senza questo caso, `violaIndiceCv` potrebbe rispondere sempre `true`
    // e il file resterebbe verde.
    h.erroreInsert = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"',
    }
    h.vivaPerEmail = {
      id: 'cand-gia-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }

    const res = await inviaValida({ cv_path: CV_BUONO })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'cand-gia-viva' })
  })
})

describe('POST /api/iscrizione/insegnanti · il tetto per IP', () => {
  it('tre l’ora: il QUARTO invio prende 429 con Retry-After', async () => {
    for (let i = 0; i < 3; i++) expect((await inviaValida()).status).toBe(201)

    const res = await inviaValida()
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    // Il quarto invio non ha scritto niente.
    expect(h.inserts).toHaveLength(3)
  })

  it('il tetto è 3 in un’ora, su una chiave dedicata alle candidature', () => {
    expect(h.opzioni).toHaveLength(0)
    return inviaValida().then(() => {
      expect(h.opzioni[0].limit).toBe(3)
      expect(h.opzioni[0].windowMs).toBe(60 * 60 * 1000)
      expect(h.opzioni[0].chiave).toContain('candidature-insegnanti:')
    })
  })

  it('il tetto scatta PRIMA di leggere il corpo: anche un body malformato lo consuma', async () => {
    for (let i = 0; i < 3; i++) await inviaValida()
    const res = await POST(
      new NextRequest('http://localhost/api/iscrizione/insegnanti', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'non-json',
      }),
    )
    expect(res.status).toBe(429)
  })
})

describe('POST /api/iscrizione/insegnanti · zod sull’ingresso', () => {
  it('senza `scuole_ids` di uuid: 400, e niente è stato scritto', async () => {
    expect((await invia({ data: candidatura() })).status).toBe(400)
    expect((await invia({ scuole_ids: ['non-un-uuid'], data: candidatura() })).status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('`posizioni: []` è 400: una candidatura senza posizione non si sa a chi smistarla', async () => {
    // Il `.min(1)` dello zod e il `CHECK cardinality(posizioni) >= 1` dicono la
    // stessa cosa, e stavolta la dicono davvero tutti e due: il CHECK di `gradi`
    // era scritto con `array_length`, che su un array vuoto vale NULL — e un
    // CHECK che vale NULL passa. Qui il rifiuto arriva prima, sotto il campo.
    const res = await inviaValida({ posizioni: [] })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('una posizione FUORI elenco è 400 qui, non un 23514 opaco all’INSERT', async () => {
    // `validateField` sulla checkbox controlla soltanto il VUOTO, non
    // l'appartenenza: senza lo `z.enum` costruito su `POSIZIONI_AMMESSE` il
    // valore arriverebbe all'INSERT e prenderebbe il `23514` del CHECK di
    // appartenenza — cioè un 500 opaco davanti a chi si sta candidando.
    const res = await inviaValida({ posizioni: ['marziano'] })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('una posizione buona INSIEME a una inventata è 400: non se ne scarta una', async () => {
    // Filtrare in silenzio sarebbe peggio del rifiuto: la candidatura entrerebbe
    // con meno posizioni di quelle spuntate, e nessuno — né chi compila né la
    // segreteria — avrebbe modo di accorgersene.
    const res = await inviaValida({ posizioni: ['insegnante_nido', 'marziano'] })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})

// =============================================================================
// LE POSIZIONI, E LE FASCE CHE NON SI CHIEDONO PIÙ
//
// Dal 2026-08-15 il modulo non domanda più «per quali fasce ti proponi»: domanda
// per quali POSIZIONI, e le tre voci docenti la fascia ce l'hanno nel nome
// («Insegnante — Nido (0-3)»). La colonna `gradi` resta, ed è quella che
// `admin/candidature-insegnanti:PATCH` travasa in `utenti.gradi` all'approvazione
// — ma la scrive la route, derivandola.
//
// Quello che cambia, e che questi casi tengono fermo, è CHI decide quel valore.
// Prima arrivava dal client; adesso no, e un client che continuasse a mandarlo
// non deve poter scrivere niente lì dentro. È la stessa proprietà delle colonne
// di stato, su un campo che fino a ieri era legittimo: `data` è `.loose()`, e una
// chiave che ieri veniva letta non smette di arrivare solo perché il template
// non la dichiara più.
// =============================================================================
describe('POST /api/iscrizione/insegnanti · le posizioni e le fasce derivate', () => {
  it('`gradi` mandato dal CLIENT è IGNORATO: in tabella entra quello DERIVATO', async () => {
    // Una cuoca non ha fasce d'età, e questo corpo ne dichiara una. Se la riga
    // tornasse a leggere `dati.gradi` — o se qualcuno rimettesse lo spread di
    // `data` nell'INSERT — la candidatura entrerebbe in tabella come docente, e
    // all'approvazione nascerebbe un account `educator` che legge l'anagrafica
    // dei bambini. La colonna è la stessa di prima; la mano che la riempie no.
    const res = await inviaValida({ posizioni: ['cuoca'], gradi: ['primaria'] })
    expect(res.status).toBe(201)
    expect(h.inserts[0].posizioni).toEqual(['cuoca'])
    expect(h.inserts[0].gradi, 'il `gradi` del client è finito in tabella').toEqual([])
    // Un array VUOTO è legittimo, e non è una svista del CHECK: una cuoca non ha
    // una fascia. Il presidio «almeno una» si è spostato su `posizioni`.
    expect(Object.keys(h.inserts[0]).sort()).toEqual(COLONNE_AMMESSE)
  })

  it('le fasce derivate sono in ORDINE DI TEMPLATE, non in ordine di clic', async () => {
    // Due candidature identiche devono produrre lo stesso array: con l'ordine di
    // spunta, `utenti.gradi` — e ogni conteggio su quella colonna — dipenderebbe
    // da come una persona ha mosso il dito.
    const res = await inviaValida({
      posizioni: ['insegnante_primaria', 'insegnante_nido', 'cuoca'],
    })
    expect(res.status).toBe(201)
    expect(h.inserts[0].gradi).toEqual(['nido', 'primaria'])
    // E le posizioni si riordinano allo stesso modo, per la stessa ragione: la
    // route filtra `POSIZIONI_AMMESSE` invece di ricopiare l'array ricevuto.
    expect(h.inserts[0].posizioni).toEqual(['insegnante_nido', 'insegnante_primaria', 'cuoca'])
  })

  it('nessuna posizione docente ⇒ `gradi` vuoto, e la candidatura passa lo stesso', async () => {
    const res = await inviaValida({ posizioni: ['collaboratrice', 'segreteria'] })
    expect(res.status).toBe(201)
    expect(h.inserts[0].gradi).toEqual([])
  })

  // ===========================================================================
  // `posizione_altro`: LA PRIMA LOGICA CONDIZIONALE DI QUESTO MODULO
  //
  // Il campo è `required: true` con `condition: posizioni contains 'altro'`, e le
  // due cose insieme vogliono dire «obbligatorio quando è visibile». Chi valida
  // deve perciò passare i campi VISIBILI: il server usa `campiVisibili` dallo
  // stesso motore del wizard, e i due casi qui sotto sono i due versi di quella
  // riga. Col template intero, il secondo sarebbe rosso — cioè la rotta
  // rifiuterebbe «Campo obbligatorio» a quasi tutte le candidature, per un campo
  // che chi compila non ha nemmeno visto.
  // ===========================================================================
  it('«Altro» spuntato SENZA il dettaglio è 400, e il campo si NOMINA', async () => {
    const res = await inviaValida({ posizioni: ['altro'] })
    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).campi)).toContain('posizione_altro')
    expect(h.inserts).toHaveLength(0)
  })

  it('senza «Altro» il dettaglio non serve: 201 anche se manca del tutto', async () => {
    const res = await inviaValida({ posizioni: ['collaboratrice'] })
    expect(res.status).toBe(201)
    expect(h.inserts[0].posizione_altro).toBeNull()
  })

  it('«Altro» con il dettaglio: il mestiere scritto a mano entra in tabella', async () => {
    const res = await inviaValida({ posizioni: ['altro'], posizione_altro: 'psicomotricista' })
    expect(res.status).toBe(201)
    expect(h.inserts[0].posizione_altro).toBe('psicomotricista')
  })

  it('il dettaglio mandato SENZA «Altro» NON entra: la colonna resta `null`', async () => {
    // È il caso di chi spunta «Altro», scrive un mestiere e poi cambia idea. Il
    // valore resta nel corpo (il wizard non ripulisce ciò che il browser ha già
    // in memoria) e senza il `null` esplicito finirebbe in tabella una posizione
    // che nessuno ha dichiarato — respinta dal CHECK di coerenza
    // `('altro' = any(posizioni)) = (posizione_altro is not null)`, cioè un 500
    // opaco sull'ultimo tocco di un modulo compilato per intero.
    const res = await inviaValida({ posizioni: ['cuoca'], posizione_altro: 'psicomotricista' })
    expect(res.status).toBe(201)
    expect(h.inserts[0].posizione_altro, 'un campo nascosto ha scritto il suo valore').toBeNull()
    expect(JSON.stringify(h.inserts[0])).not.toContain('psicomotricista')
  })
})

describe('POST /api/iscrizione/insegnanti · la ri-validazione SERVER dei campi', () => {
  it('«Napoli» per esteso viene NORMALIZZATA a «NA» e la candidatura passa', async () => {
    const res = await inviaValida({ residence_province: 'Napoli' })
    expect(res.status).toBe(201)
    // La colonna è `varchar(2)`: quello che entra è la sigla, non il nome.
    expect(h.inserts[0].residence_province).toBe('NA')
  })

  it('una sigla INESISTENTE è respinta con il campo nominato, in forma piatta', async () => {
    const res = await inviaValida({ residence_province: 'XY' })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.codice).toBeTruthy()
    expect(Object.keys(j.campi)).toContain('residence_province')
    expect(typeof j.campi.residence_province).toBe('string')
    expect(h.inserts).toHaveLength(0)
  })

  it('un campo obbligatorio vuoto è 400, non un INSERT che il DB rifiuta dopo', async () => {
    const res = await inviaValida({ nome: '' })
    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).campi)).toContain('nome')
    expect(h.inserts).toHaveLength(0)
  })

  it('un’email malformata è 400', async () => {
    const res = await inviaValida({ email: 'non-una-email' })
    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).campi)).toContain('email')
  })
})

describe('POST /api/iscrizione/insegnanti · consensi e honeypot', () => {
  it('senza la presa visione dell’informativa: 400, e NIENTE viene scritto', async () => {
    const res = await inviaValida({ presa_visione_informativa: undefined })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.codice).toBeTruthy()
    expect(j.consensi).toContain('presa_visione_informativa')
    expect(h.inserts).toHaveLength(0)
  })

  it('`false` non vale come accettazione', async () => {
    const res = await inviaValida({ presa_visione_informativa: false })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('il consenso FACOLTATIVO non spuntato non blocca nulla, e resta a false nella prova', async () => {
    const res = await inviaValida()
    expect(res.status).toBe(201)
    const blocchi = (h.inserts[0].consents_log as { blocchi: { field_id: string; accepted: boolean }[] }).blocchi
    expect(blocchi.find((b) => b.field_id === 'consenso_conservazione_candidatura')?.accepted).toBe(false)
  })

  // I DUE NOMI DELL'ESCA, provati ENTRAMBI.
  //
  // Lo schema accetta `sito_web` e `honeypot` come sinonimi, e la ragione scritta
  // accanto è che «un modulo e una route che non si accordano sul nome sono
  // un'esca che non scatta mai». Finché il collaudo ne inviava uno solo, quella
  // ragione non era provata: togliendo dalla route il ramo del secondo nome la
  // suite restava verde, cioè metà della difesa era decorativa. La pagina
  // `/lavora-con-noi` non esiste ancora (misurato il 2026-08-10), quindi quale
  // dei due nomi il modulo spedirà davvero non lo sa nessuno: è precisamente il
  // motivo per cui devono rendere tutti e due.
  for (const campo of ['sito_web', 'honeypot'] as const) {
    it(`esca compilata sotto «${campo}»: 400 con codice, un \`warn\` nei log e NESSUNA riga`, async () => {
      const res = await invia({ scuole_ids: [SEDE_A], data: candidatura(), [campo]: 'http://spam.invalid' })
      // Un 201 finto sarebbe una bugia scritta in grande: la riga non c'è.
      expect(res.status).toBe(400)
      expect((await res.json()).codice).toBeTruthy()
      expect(h.inserts).toHaveLength(0)
      const trappola = h.eventi.find((e) => e.evento === 'candidatura' && e.campi.esito === 'honeypot')
      expect(trappola?.livello, `«${campo}» non fa scattare l’esca`).toBe('warn')
    })
  }
})

describe('POST /api/iscrizione/insegnanti · la sede', () => {
  it('una sede SCONOSCIUTA è 400: nessun default silenzioso', async () => {
    const res = await invia({ scuole_ids: ['99999999-0000-4000-8000-000000000099'], data: candidatura() })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.inserts).toHaveLength(0)
  })

  it('con due sedi reali NON si indovina: la sede richiesta deve combaciare', async () => {
    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(SEDE_A)
  })

  it('la sede FITTIZIA del seed E2E è RIFIUTATA: in produzione esiste davvero', async () => {
    // MISURATO il 2026-08-10 sul database di produzione:
    //   select id, nome from public.schools where id::text like 'e2e%'
    //   → e2e00000-0000-4000-8000-000000000001 / «Kidville E2E», 4 utenti
    //     collegati, di cui uno con `ruolo = 'admin'`.
    // La rotta prima validava su `tutte` (E2E incluse) motivandolo con «quella
    // sede in produzione non esiste»: la query dice il contrario. Su una
    // SCRITTURA ANONIMA quella sede non deve essere raggiungibile — AGENTS.md
    // la esclude da ogni elenco pubblico, e il selettore del wizard
    // (`iscrizione/sedi:GET`, che usa `reali`) non la mostra: accettarla
    // significherebbe scrivere in un plesso che nessuno ha potuto scegliere.
    h.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ]
    const res = await invia({ scuole_ids: [SEDE_E2E], data: candidatura() })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.inserts, 'una candidatura è finita nella sede di collaudo').toHaveLength(0)
  })

  it('una sede DISATTIVATA (`scuole.attiva = false`) è rifiutata come una sconosciuta', async () => {
    // È la seconda metà della differenza fra `tutte` e `reali`, e taceva: `tutte`
    // non applica il flag, quindi la rotta accettava candidature su plessi
    // soft-deleted che il wizard pubblico non mostra e non mostrerà mai.
    h.attive.set(SEDE_B, false)
    const res = await invia({ scuole_ids: [SEDE_B], data: candidatura() })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.inserts).toHaveLength(0)
  })

  it('se il registro `scuole` non risponde la sede resta accettata (fail-open dichiarato)', async () => {
    // `sediReali` degrada FAIL-OPEN sul registro `scuole` — la colonna manca sul
    // DB della CI, che non è migrato (`42703`). Il verso in cui si sbaglia è «una
    // sede in più», non «nessuna sede»: col verso opposto il modulo pubblico si
    // spegnerebbe del tutto per un errore transitorio, e chi si candida vedrebbe
    // «indicare la sede» su un elenco vuoto.
    //
    // Il rifiuto della sede E2E NON dipende da questo ramo: `isScuolaE2E` guarda
    // l'id e il nome, che arrivano da `schools`. Anche col registro muto la sede
    // fittizia resta fuori — ed è la riga qui sotto a dirlo.
    h.erroreRegistroScuole = { code: '42703', message: 'column "attiva" does not exist' }
    h.sedi = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ]
    expect((await inviaValida()).status).toBe(201)
    expect((await invia({ scuole_ids: [SEDE_E2E], data: candidatura() })).status).toBe(400)
  })
})

describe('POST /api/iscrizione/insegnanti · come si traducono gli errori del database', () => {
  it('l’email si scrive in MINUSCOLO: è la forma su cui l’indice unico è costruito', async () => {
    // `unique index … on candidature_insegnanti (lower(email))`. Se la colonna
    // conserva le maiuscole digitate, il dato in tabella e la chiave che lo rende
    // unico sono due cose diverse — e ogni rilettura per email deve indovinare
    // quale delle due sta guardando. Normalizzando alla scrittura, sono la stessa.
    const res = await inviaValida({ email: 'Ines.Prova@Example.Invalid' })
    expect(res.status).toBe(201)
    expect(h.inserts[0].email).toBe('ines.prova@example.invalid')
  })

  it('23505 (email già candidata) ⇒ 201 come al primo invio, MAI 409', async () => {
    h.erroreInsert = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"',
    }
    h.vivaPerEmail = {
      id: 'cand-gia-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }

    const res = await inviaValida()
    // Un 409 «l'abbiamo già ricevuta» direbbe a chiunque, digitando l'indirizzo
    // di una maestra, se quella persona è in valutazione presso questa scuola.
    expect(res.status).toBe(201)
    expect(res.status).not.toBe(409)
    // La risposta è INDISTINGUIBILE dal primo invio: stessa forma, stesso id vivo.
    expect(await res.json()).toEqual({ id: 'cand-gia-viva' })

    const duplicata = h.eventi.find(
      (e) => e.evento === 'candidatura' && e.campi.esito === 'duplicata',
    )
    expect(duplicata, 'il doppione deve lasciare una riga: è l’unico posto in cui si vede').toBeTruthy()
    expect(duplicata?.campi.error_code).toBe('23505')
    expect(duplicata?.campi.scuola_id).toBe(SEDE_A)
    expect(duplicata?.campi.entita_id, 'senza l’uuid della riga viva il warn non serve a nessuno').toBe(
      'cand-gia-viva',
    )
    // Il corpo della risposta non nomina nessun codice d'errore utente.
    expect(JSON.stringify(await inviaValida().then((r) => r.json()))).not.toContain('CANDIDATURA_GIA_INVIATA')
  })

  it('STESSA email con MAIUSCOLE diverse ⇒ 201 con l’id della riga viva, non `null`', async () => {
    // IL CASO CHE IL COLLAUDO NON VEDEVA, e il difetto che nascondeva.
    //
    // L'indice è su `lower(email)`: «Ines.Prova@…» e «ines.prova@…» sono la
    // STESSA candidatura per il database, che risponde `23505`. Ma la rilettura
    // della riga viva usa `.eq('email', …)`, che confronta i byte: cercando il
    // valore così com'è stato digitato non si trova niente, `maybeSingle()`
    // torna `null`, e la risposta diventa `{"id": null}`.
    //
    // Due cose si rompono insieme, ed è la seconda quella che pesa:
    //  (a) la risposta cambia FORMA rispetto al primo invio — cioè torna a essere
    //      l'oracolo di enumerazione che rispondere 201 serviva a togliere;
    //  (b) si perde il puntatore alla riga viva, che è l'unica cosa da avere in
    //      mano quando la segreteria di un'altra sede chiede «è arrivata?».
    //
    // La riparazione è a monte: l'email si normalizza PRIMA dell'INSERT, quindi
    // in tabella e nella rilettura c'è lo stesso valore per costruzione.
    h.erroreInsert = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"',
    }
    // La riga già viva è stata scritta da questa stessa rotta, quindi in tabella
    // l'email è minuscola.
    h.vivaPerEmail = {
      id: 'cand-gia-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }

    const res = await inviaValida({ email: 'Ines.Prova@Example.Invalid' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'cand-gia-viva' })

    // La rilettura ha chiesto il valore NORMALIZZATO, non quello digitato.
    expect(h.filtri.find((f) => f.colonna === 'email')?.valore).toBe('ines.prova@example.invalid')

    const duplicata = h.eventi.find((e) => e.evento === 'candidatura' && e.campi.esito === 'duplicata')
    expect(duplicata?.campi.entita_id).toBe('cand-gia-viva')
  })

  it('23505 con la riga viva IRREPERIBILE: il buco si LOGGA, non si nasconde', async () => {
    // Resta un caso in cui la riga viva non si trova pur avendo preso `23505`:
    // fra l'INSERT e la rilettura la candidatura è stata approvata o rifiutata,
    // e il filtro `stato in (pending, in_approvazione)` non la vede più. È raro
    // ma vero, e non si inventa un uuid per farlo sembrare regolare: si risponde
    // 201 (la candidatura ESISTE davvero) e si lascia una riga con un esito
    // DIVERSO, così chi legge i log distingue «duplicata e tracciata» da
    // «duplicata e persa di vista» invece di vedere due `entita_id: null` uguali.
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.vivaPerEmail = null

    const res = await inviaValida()
    expect(res.status).toBe(201)
    const persa = h.eventi.find(
      (e) => e.evento === 'candidatura' && e.campi.esito === 'duplicata-riga-viva-non-trovata',
    )
    expect(persa?.livello).toBe('warn')
    expect(persa?.campi.scuola_id).toBe(SEDE_A)
  })

  it('PGRST205 / 42P01 (tabella assente, come sul DB della CI) ⇒ 503, MAI 201', async () => {
    for (const code of ['PGRST205', '42P01']) {
      h.inserts = []
      h.eventi = []
      h.erroreInsert = { code, message: 'relation "public.candidature_insegnanti" does not exist' }
      const res = await inviaValida()
      expect(res.status, `${code} deve dare 503`).toBe(503)
      expect(res.status).not.toBe(201)
      expect((await res.json()).codice).toBe('CANDIDATURE_NON_DISPONIBILI')
      const avviso = h.eventi.find((e) => e.evento === 'candidatura' && e.livello === 'warn')
      expect(avviso?.campi.error_code).toBe(code)
    }
  })

  it('PGRST204 / 42703 (colonna assente) ⇒ si RITENTA senza, con un warn che la NOMINA', async () => {
    h.erroreInsert = {
      code: 'PGRST204',
      message: "Could not find the 'consents_log' column of 'candidature_insegnanti' in the schema cache",
    }
    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(2)
    // Il secondo tentativo è lo stesso record SENZA la colonna caduta.
    expect(h.inserts[0]).toHaveProperty('consents_log')
    expect(h.inserts[1]).not.toHaveProperty('consents_log')
    expect(h.inserts[1].scuola_id).toBe(SEDE_A)

    const avviso = h.eventi.find(
      (e) => e.evento === 'candidatura' && String(e.campi.esito ?? '').startsWith('colonna-assente'),
    )
    expect(avviso?.livello).toBe('warn')
    expect(String(avviso?.campi.esito), 'il warn deve NOMINARE la colonna caduta').toContain('consents_log')
  })

  it('🔴 DUE colonne assenti ⇒ si ritenta finché non passa, e il 201 arriva lo stesso', async () => {
    // ⚠️ NATO DA UN ROSSO VERO IN CI, il 2026-08-15. Fino a quel giorno il degrado
    // era UN SOLO ritento: bastava perché una sola colonna poteva mancare. Nate
    // `posizioni` e `posizione_altro`, il database della CI — che ha la tabella
    // ma non le colonne nuove — le nominava una per volta, il primo ritento
    // cadeva sulla seconda e la rotta rispondeva 500. L'E2E
    // `public-candidatura-insegnante.spec.ts`, che su `main` era verde, aspettava
    // 201 e ne prendeva un altro.
    //
    // Il caso non si poteva vedere con un errore solo: è la SEQUENZA a essere il
    // difetto. Perciò qui gli errori sono due, uno per giro.
    h.erroreInsert = {
      code: 'PGRST204',
      message: "Could not find the 'posizioni' column of 'candidature_insegnanti' in the schema cache",
    }
    h.erroriSuccessivi = [
      {
        code: 'PGRST204',
        message:
          "Could not find the 'posizione_altro' column of 'candidature_insegnanti' in the schema cache",
      },
    ]

    const res = await inviaValida({ posizioni: ['insegnante_nido', 'altro'], posizione_altro: 'bidella' })
    expect(res.status, 'con DUE colonne assenti la candidatura deve entrare lo stesso').toBe(201)
    expect(h.inserts).toHaveLength(3)
    // Ogni giro toglie UNA colonna, e le toglie in aggiunta — non ricomincia.
    expect(h.inserts[0]).toHaveProperty('posizioni')
    expect(h.inserts[1]).not.toHaveProperty('posizioni')
    expect(h.inserts[1]).toHaveProperty('posizione_altro')
    expect(h.inserts[2]).not.toHaveProperty('posizioni')
    expect(h.inserts[2]).not.toHaveProperty('posizione_altro')
    // …e ciò che NON è caduto resta: un degrado che perde per strada la sede
    // sarebbe una candidatura archiviata nel plesso sbagliato.
    expect(h.inserts[2].scuola_id).toBe(SEDE_A)
    expect(h.inserts[2]).toHaveProperty('consents_log')

    // Le due colonne sono NOMINATE, una per riga: «si è degradato» senza dire che
    // cosa è caduto è un log che non serve a nessuno.
    const nominate = h.eventi
      .filter((e) => String(e.campi.esito ?? '').startsWith('colonna-assente'))
      .map((e) => String(e.campi.esito))
    expect(nominate).toEqual(['colonna-assente-posizioni', 'colonna-assente-posizione_altro'])
  })

  it('il degrado ha un TETTO: un `PGRST204` che si ripete non fa girare l’INSERT all’infinito', async () => {
    // La colonna nominata non è fra quelle che si stanno scrivendo: senza
    // l'uscita, il ciclo ritenterebbe lo STESSO record fino al tetto.
    h.erroreInsert = {
      code: 'PGRST204',
      message: "Could not find the 'colonna_che_non_scriviamo' column of 'candidature_insegnanti'",
    }
    h.erroriSuccessivi = Array.from({ length: 10 }, () => ({
      code: 'PGRST204',
      message: "Could not find the 'colonna_che_non_scriviamo' column of 'candidature_insegnanti'",
    }))

    const res = await inviaValida()
    // Non si finge un successo: il record non è entrato.
    expect(res.status).toBe(500)
    // ⚠️ Il numero che conta: DUE tentativi, non undici. Il primo, e un solo
    // ritento — perché `colonnaMancante` ripiega su `consents_log`, che c'è, e al
    // giro dopo la colonna nominata non è più nel record.
    expect(h.inserts.length, 'l’INSERT è stato ritentato troppe volte').toBeLessThanOrEqual(6)
  })

  it('un errore qualunque ⇒ 500 con codice, e il messaggio grezzo NON esce', async () => {
    h.erroreInsert = {
      code: '42501',
      message: 'permission denied for table candidature_insegnanti (dettaglio interno)',
    }
    const res = await inviaValida()
    expect(res.status).toBe(500)
    const corpo = await res.text()
    expect(corpo).toContain('CANDIDATURA_NON_INVIATA')
    expect(corpo).not.toContain('permission denied')
    expect(corpo).not.toContain('dettaglio interno')
  })

  it('se anche il RITENTO fallisce, è 500: non si finge un 201', async () => {
    h.erroreInsert = { code: '42703', message: 'column "disponibilita" of relation "x" does not exist' }
    h.erroriSuccessivi = [{ code: '42501', message: 'permission denied' }]
    const res = await inviaValida()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CANDIDATURA_NON_INVIATA')
  })
})

// =============================================================================
// IL DOPPIO INVIO E LA CONSEGNA — che cosa succede DIETRO il 201
//
// Le due affermazioni non si accordavano, ed è la crepa da cui usciva un
// percorso utente intero:
//  · l'indice unico è GLOBALE — `unique (lower(email)) where stato in
//    ('pending','in_approvazione')`, migrazione `20260810094610`: una candidatura
//    viva vale per l'intera cooperativa;
//  · l'avviso è PER SEDE — `staffScuola(supabase, scuolaId, …)`.
//
// Conseguenza misurata sul codice: una maestra con una candidatura viva su una
// sede si candida su un'altra; il database rifiuta l'INSERT, la route risponde
// «ricevuta» (201, forma identica al primo invio), e alla seconda segreteria non
// arriva NIENTE. Candidarsi a più plessi della stessa cooperativa è il
// comportamento normale di chi cerca lavoro, non un caso limite. E vale anche il
// verso ostile: chi invia per primo con l'email di un'altra persona ne blocca in
// silenzio la candidatura vera, che riceverà comunque «ricevuta».
//
// Il 201 verso il chiamante anonimo resta: toglierlo rimetterebbe l'oracolo di
// enumerazione. Quello che non può restare è il silenzio dietro.
// =============================================================================
describe('POST /api/iscrizione/insegnanti · il doppio invio non è un no-op', () => {
  const doppione = () => {
    h.erroreInsert = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"',
    }
  }

  it('riga viva in UN’ALTRA sede: la segreteria della sede RICHIESTA viene avvisata', async () => {
    doppione()
    h.vivaPerEmail = {
      id: 'cand-di-altra-sede',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_B,
    }

    const res = await inviaValida()
    expect(res.status).toBe(201)

    // L'avviso esiste, ed è indirizzato E consegnato alla sede richiesta.
    expect(h.notifiche, 'nessuno alla sede richiesta ha saputo della candidatura').toHaveLength(1)
    expect(h.notifiche[0].scuolaId).toBe(SEDE_A)
    expect(h.destinatariChiesti[0].scuolaId).toBe(SEDE_A)

    // ⚠️ L'`entita_id` ADESSO ESCE, e la riga è cambiata il 2026-08-20.
    //
    // Fino a ieri restava `null`, e la ragione era buona: quella riga viveva in
    // un'altra sede, questa segreteria non aveva titolo per aprirla, e un link
    // che porta a un 403 è peggio di nessun link. Con la multi-sede la premessa
    // cade: la sede richiesta viene AGGANCIATA alla candidatura viva
    // (`candidature_sedi`), quindi da questo istante ha titolo di aprirla — e
    // tenerle nascosto l'uuid le lascerebbe un avviso su una scheda che ha nel
    // proprio cockpit e non sa raggiungere.
    //
    // Il presidio non è sparito, si è spostato: l'uuid esce solo per le sedi che
    // ADESSO hanno una riga. Il test qui sotto lo prova nel caso in cui
    // l'aggancio non riesce.
    expect(h.notifiche[0].entitaId, 'la sede agganciata non riceve l’uuid che può aprire').toBe(
      'cand-di-altra-sede',
    )
    expect(h.righeDiSede, 'la sede richiesta non è stata agganciata alla candidatura viva').toEqual([
      { candidatura_id: 'cand-di-altra-sede', scuola_id: SEDE_A },
    ])

    // E IL TESTO DICE CHE LA SCHEDA NON È QUI. È l'unica cosa che questa
    // segreteria può leggere: l'avviso non porta nessun uuid (per progetto), e
    // col corpo dell'altro ramo direbbe «la scheda collegata a questo avviso»
    // indicando un avviso che non ne ha nessuna. Misurato: fissando il corpo su
    // `duplicataQui` la suite restava verde.
    attendiCorpo(h.notifiche[0].corpo, 'duplicataAltrove')

    const duplicata = h.eventi.find((e) => e.campi.esito === 'duplicata')
    expect(duplicata?.campi.stessa_sede).toBe(false)
  })

  it('riga viva nella STESSA sede: l’avviso porta l’uuid, che qui è legittimo', async () => {
    doppione()
    h.vivaPerEmail = {
      id: 'cand-gia-viva',
      email: 'ines.prova@example.invalid',
      stato: 'pending',
      scuola_id: SEDE_A,
    }

    expect((await inviaValida()).status).toBe(201)
    expect(h.notifiche).toHaveLength(1)
    expect(h.notifiche[0].scuolaId).toBe(SEDE_A)
    expect(h.notifiche[0].entitaId).toBe('cand-gia-viva')
    // Qui, e SOLO qui, il testo può dire «la scheda collegata a questo avviso»:
    // l'uuid c'è davvero ed è di questa sede.
    attendiCorpo(h.notifiche[0].corpo, 'duplicataQui')
    expect(h.eventi.find((e) => e.campi.esito === 'duplicata')?.campi.stessa_sede).toBe(true)
  })

  it('riga viva IRREPERIBILE: si avvisa lo stesso, senza inventare un uuid', async () => {
    doppione()
    h.vivaPerEmail = null

    expect((await inviaValida()).status).toBe(201)
    expect(h.notifiche).toHaveLength(1)
    expect(h.notifiche[0].scuolaId).toBe(SEDE_A)
    expect(h.notifiche[0].entitaId).toBeNull()
    // Senza uuid il corpo non può rimandare a nessuna scheda: è lo stesso testo
    // del caso «altrove», ed è giusto che lo sia — quello che la segreteria sa è
    // che una candidatura è arrivata e che la scheda non è raggiungibile da qui.
    attendiCorpo(h.notifiche[0].corpo, 'duplicataAltrove')
  })

  it('la rilettura guarda SOLO gli stati vivi: una riga già rifiutata non conta', async () => {
    // Il filtro `stato in ('pending','in_approvazione')` è quello che distingue
    // «duplicata e tracciata» da una riga che il cockpit ha già evaso. Senza,
    // l'avviso si aggancerebbe a una candidatura chiusa e la risposta
    // restituirebbe il suo uuid come se fosse in valutazione.
    doppione()
    h.vivaPerEmail = {
      id: 'cand-gia-rifiutata',
      email: 'ines.prova@example.invalid',
      stato: 'rifiutata',
      scuola_id: SEDE_A,
    }

    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(await res.json(), 'una riga già evasa è stata spacciata per viva').toEqual({ id: null })

    // Il filtro è stato dichiarato al database, non solo sperato.
    const stati = h.filtriIn.find((f) => f.colonna === 'stato')?.valori
    expect(stati).toEqual(['pending', 'in_approvazione'])

    const persa = h.eventi.find((e) => e.campi.esito === 'duplicata-riga-viva-non-trovata')
    expect(persa?.livello).toBe('warn')
  })

  it('se la RILETTURA fallisce (PostgREST ritorna `{error}`) il buco si logga', async () => {
    // PostgREST non lancia: un `try/catch` attorno non scatterebbe mai, e senza
    // il controllo sul valore di ritorno questo ramo sarebbe muto. Il caso
    // esisteva nel codice ma non nel collaudo: spegnere `if (erroreViva)`
    // lasciava la suite verde.
    doppione()
    h.erroreRilettura = { code: '57014', message: 'canceling statement due to statement timeout' }

    const res = await inviaValida()
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: null })

    const muto = h.eventi.find((e) => e.campi.esito === 'duplicata-riga-viva-non-letta')
    expect(muto, 'una rilettura fallita non ha lasciato traccia').toBeTruthy()
    expect(muto?.livello).toBe('warn')
    expect(muto?.campi.scuola_id).toBe(SEDE_A)

    // Anche qui la segreteria della sede richiesta viene avvisata: non sapere se
    // esiste una riga viva non è una ragione per non dire che qualcuno si è
    // candidato.
    expect(h.notifiche).toHaveLength(1)
    expect(h.notifiche[0].entitaId).toBeNull()
  })
})

describe('POST /api/iscrizione/insegnanti · la copia che arriva alla sede', () => {
  /** Il secondo argomento di `inviaCopiaAllaSede`: i dati della copia. */
  const copie = () => h.copieAllaSede.map((a) => a[1] as Record<string, unknown>)
  /** La forma di percorso che `percorsoCvAmmesso` ammette: uuid + nome. */
  const CV = 'candidature/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-cv.pdf'

  it('a candidatura registrata parte ANCHE la copia alla sede, non solo la conferma a chi si candida', async () => {
    expect((await inviaValida()).status).toBe(201)
    expect(copie()).toHaveLength(1)
    expect(copie()[0].scuolaId).toBe(SEDE_A)
  })

  it('la copia porta il NOME del plesso, non il suo uuid: quell’email la legge una persona', async () => {
    await inviaValida()
    expect(copie()[0].sediScelte).toEqual([NOME_SEDE_A])
  })

  it('porta il curriculum quando c’è — con la forma di percorso che il gate ammette', async () => {
    // Un percorso della forma giusta e non uno inventato: `percorsoCvAmmesso` pretende la
    // forma esatta, e un percorso finto qui non arriverebbe mai all'inserimento.
    // (Provato: con un percorso arbitrario la route risponde 400, ed è giusto.)
    await inviaValida({ cv_path: CV })
    expect(copie()[0].cvPath).toBe(CV)
  })

  it('i consensi NON spuntati viaggiano come `false`, non spariscono', async () => {
    // «Non gliel'ho chiesto» e «ha detto no» non sono la stessa cosa: nella copia
    // la sede deve leggere «No», non trovare la riga assente.
    await inviaValida()
    expect(copie()[0].consensi).toMatchObject({
      presa_visione_informativa: true,
      consenso_conservazione_candidatura: false,
    })
  })

  it('doppio invio sulla STESSA sede: nessuna copia, perché per quella sede non è successo niente', async () => {
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"' }
    h.vivaPerEmail = { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', stato: 'pending', scuola_id: SEDE_A, email: 'ines.prova@example.invalid' }
    h.righeDiSede.push({ candidatura_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', scuola_id: SEDE_A })
    expect((await inviaValida()).status).toBe(201)
    // Una seconda copia identica nella stessa casella si legge come una seconda
    // candidatura, e non lo è: la persona è una e la pratica pure.
    expect(h.copieAllaSede).toHaveLength(0)
  })

  it('🔴 doppio invio verso una sede NUOVA: la sede viene agganciata, avvisata E riceve la copia', async () => {
    // È il buco che il collaudo del 2026-08-20 ha misurato: chi ha una
    // candidatura viva su un plesso e ne spunta altri due riceveva
    // «Candidatura inviata!» mentre quei due plessi non ne sapevano niente —
    // nessuna scheda nel cockpit, nessun curriculum, nessun avviso.
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"' }
    h.vivaPerEmail = { id: 'viva-su-A', stato: 'pending', scuola_id: SEDE_A, email: 'ines.prova@example.invalid' }
    h.righeDiSede.push({ candidatura_id: 'viva-su-A', scuola_id: SEDE_A })

    const res = await invia({ scuole_ids: [SEDE_A, SEDE_B], data: candidatura() })
    expect(res.status).toBe(201)

    // Solo la sede NUOVA si aggancia: quella che l'aveva già non si duplica.
    expect(h.righeDiSede).toEqual([
      { candidatura_id: 'viva-su-A', scuola_id: SEDE_A },
      { candidatura_id: 'viva-su-A', scuola_id: SEDE_B },
    ])
    // Entrambe le segreterie sanno; l'uuid esce a entrambe, perché entrambe
    // possono aprire la scheda.
    expect(h.notifiche.map((n) => n.scuolaId).sort()).toEqual([SEDE_A, SEDE_B].sort())
    // La copia col curriculum va SOLO alla sede nuova: l'altra non ha niente di
    // nuovo da sapere.
    expect(h.copieAllaSede.map((a) => (a[1] as Record<string, unknown>).scuolaId)).toEqual([SEDE_B])
  })

  it('se l’aggancio della sede nuova FALLISCE, l’uuid non esce e la copia non parte', async () => {
    // Il presidio di ieri non è sparito, si è spostato: un link che porta a un
    // diniego resta peggio di nessun link.
    h.erroreInsert = { code: '23505', message: 'duplicate key value violates unique constraint "candidature_insegnanti_email_viva"' }
    h.vivaPerEmail = { id: 'viva-su-A', stato: 'pending', scuola_id: SEDE_A, email: 'ines.prova@example.invalid' }
    h.righeDiSede.push({ candidatura_id: 'viva-su-A', scuola_id: SEDE_A })
    h.erroreRigheDiSede = { code: '42501', message: 'permission denied' }

    await invia({ scuole_ids: [SEDE_B], data: candidatura() })
    const perB = h.notifiche.find((n) => n.scuolaId === SEDE_B)
    expect(perB?.entitaId, 'l’uuid è uscito verso una sede che non può aprirlo').toBeNull()
    expect(h.copieAllaSede).toHaveLength(0)
  })

  it('la copia NON parte se l’inserimento è fallito: non si annuncia ciò che non è stato registrato', async () => {
    h.erroreInsert = { code: '42501', message: 'permission denied' }
    await inviaValida()
    expect(h.copieAllaSede).toHaveLength(0)
  })
})

describe('POST /api/iscrizione/insegnanti · più sedi con un invio solo', () => {
  const copie = () => h.copieAllaSede.map((a) => a[1] as Record<string, unknown>)

  it('accetta un elenco di sedi e scrive una riga di sede per ciascuna', async () => {
    const res = await invia({ scuole_ids: [SEDE_A, SEDE_B], data: candidatura() })
    expect(res.status).toBe(201)
    expect(h.righeDiSede).toEqual([
      { candidatura_id: 'cand-nuova', scuola_id: SEDE_A },
      { candidatura_id: 'cand-nuova', scuola_id: SEDE_B },
    ])
  })

  it('la candidatura porta come `scuola_id` la PRIMA dell’elenco: è la sede di primo arrivo', async () => {
    await invia({ scuole_ids: [SEDE_B, SEDE_A], data: candidatura() })
    expect(h.inserts[0].scuola_id).toBe(SEDE_B)
  })

  it('un elenco di UNA sede è un elenco: nessun ramo speciale, ed è il caso di ?sede=', async () => {
    const res = await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    expect(res.status).toBe(201)
    expect(h.righeDiSede).toHaveLength(1)
  })

  it('OGNI sede si verifica contro sediReali, non solo la prima', async () => {
    // La seconda è un uuid che non appartiene a nessun plesso. Se la route
    // controllasse solo la prima, la riga di sede finirebbe su una FK inesistente.
    const res = await invia({
      scuole_ids: [SEDE_A, '99999999-0000-4000-8000-000000000099'],
      data: candidatura(),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(h.inserts).toHaveLength(0)
  })

  it('la sede di collaudo E2E resta esclusa anche dentro un elenco', async () => {
    const res = await invia({ scuole_ids: [SEDE_A, SEDE_E2E], data: candidatura() })
    expect(res.status).toBe(400)
  })

  it('un elenco VUOTO è un rifiuto: senza sede non si archivia niente', async () => {
    expect((await invia({ scuole_ids: [], data: candidatura() })).status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('le sedi ripetute si contano una volta: la stessa casella non riceve due copie', async () => {
    await invia({ scuole_ids: [SEDE_A, SEDE_A], data: candidatura() })
    expect(h.righeDiSede).toHaveLength(1)
    expect(h.copieAllaSede).toHaveLength(1)
  })

  it('parte UNA copia per ogni sede scelta, ognuna con la propria sede', async () => {
    await invia({ scuole_ids: [SEDE_A, SEDE_B], data: candidatura() })
    expect(copie().map((c) => c.scuolaId)).toEqual([SEDE_A, SEDE_B])
  })

  it('ogni copia dichiara TUTTE le sedi scelte: chi valuta deve sapere del resto', async () => {
    // Senza, due segreterie istruiscono la stessa pratica senza sapere l'una
    // dell'altra, e la persona riceve due convocazioni scoordinate.
    await invia({ scuole_ids: [SEDE_A, SEDE_B], data: candidatura() })
    for (const c of copie()) expect(c.sediScelte).toEqual([NOME_SEDE_A, NOME_SEDE_B])
  })

  it('la segreteria di OGNI sede viene avvisata, non solo quella di primo arrivo', async () => {
    await invia({ scuole_ids: [SEDE_A, SEDE_B], data: candidatura() })
    const sediAvvisate = h.notifiche.map((n) => n.scuola_id ?? n.scuolaId)
    expect(sediAvvisate).toContain(SEDE_A)
    expect(sediAvvisate).toContain(SEDE_B)
  })

  it('DEGRADO · se candidature_sedi non esiste (DB della CI) la candidatura si registra lo stesso', async () => {
    h.erroreRigheDiSede = { code: 'PGRST205', message: "Could not find the table 'public.candidature_sedi'" }
    const res = await invia({ scuole_ids: [SEDE_A, SEDE_B], data: candidatura() })
    expect(res.status).toBe(201)
    const riga = h.eventi.find((e) => e.campi?.esito === 'sedi-multiple-non-registrate')
    expect(riga, 'il degrado deve lasciare una riga').toBeTruthy()
    // `warn` e non `error`: la tabella assente è una migrazione mancante, non un guasto.
    expect(riga?.livello).toBe('warn')
  })

  it('DEGRADO · un errore DIVERSO da «tabella assente» è un guasto vero: livello error', async () => {
    // La candidatura esiste ma nessuna sede la vedrà: è la definizione di un
    // incidente, non di un ambiente non migrato.
    h.erroreRigheDiSede = { code: '42501', message: 'permission denied for table candidature_sedi' }
    const res = await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    expect(res.status).toBe(201)
    expect(h.eventi.find((e) => e.campi?.esito === 'sedi-multiple-non-registrate')?.livello).toBe('error')
  })

  it('più di tre sedi: rifiutato dallo schema, prima di toccare il database', async () => {
    const res = await invia({
      scuole_ids: [SEDE_A, SEDE_B, SEDE_A, SEDE_B, '99999999-0000-4000-8000-000000000099'],
      data: candidatura(),
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})
