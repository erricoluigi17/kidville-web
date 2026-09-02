import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CANDIDATURA_LIMITI, CONSENSI_INSEGNANTI_FIELDS } from '@/lib/forms/insegnanti-template'

// =============================================================================
// LA CONSERVAZIONE DELLE CANDIDATURE — e le quattro cose che il gemello delle
// iscrizioni (`retention-iscrizioni`) ha già pagato al posto nostro.
//
// 1. PRIMA I FILE, POI LE RIGHE. Al contrario, un errore a metà lascerebbe i
//    curriculum nell'archivio senza più nessuna riga che li nomini: invisibili,
//    non cancellati — il modo peggiore di conservare il dato di una persona.
//    E la rinuncia è PER CANDIDATURA: un curriculum che non esce riguarda la
//    SUA riga, non le altre.
// 2. IL CONTEGGIO SI LOGGA SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
//    FALLIRE. Nella versione SQL delle iscrizioni l'`INSERT` in `app_log` stava
//    DOPO la `DELETE`: l'eccezione lo saltava, e la difesa che doveva accorgersi
//    del guasto era a valle del guasto. Qui il battito si scrive in un `finally`.
// 3. RIGHE TRATTENUTE ⇒ 500. Un 200 direbbe «fatto» a chi sorveglia il lavoro
//    notturno, e quella conservazione resterebbe scoperta senza che si sappia.
// 4. IL TERMINE PROMESSO E IL TERMINE APPLICATO SONO LO STESSO NUMERO. I 24 mesi
//    del consenso (`CANDIDATURA_LIMITI.mesiConservazione`, interpolati nel testo
//    che la persona legge e firma) e i 24 mesi del cron non possono divergere:
//    è la dichiarazione su cui è stato prestato il consenso, art. 13 §2 lett. a.
//
// E una quinta, che è di questo dominio e non del gemello: **il nome del file
// del curriculum è un dato personale**. Si chiama `cv-<cognome>.pdf`: un log che
// lo riportasse pubblicherebbe il cognome di chi si è candidato dentro una
// tabella interrogabile in SQL per 30 giorni.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-candidature-non-usato-altrove'

const h = vi.hoisted(() => ({
  /** La sequenza REALE delle operazioni: è l'ordine la cosa da provare. */
  sequenza: [] as { tipo: 'remove' | 'delete'; valore: unknown }[],
  /** Le colonne chieste a ogni `select()`: il ripiego su colonna assente si misura qui. */
  select: [] as string[],
  /**
   * GLI ARGOMENTI DELLE CLAUSOLE, e perché non registrarli è stato un difetto.
   *
   * Fino al 2026-08-10 questo mock rimpiazzava `lt`/`in`/`eq`/`order`/`limit` con
   * `() => qb`, buttando via i parametri: la clausola WHERE era INVISIBILE alla
   * suite. Misurato con due mutazioni, entrambe sopravvissute con 27 test verdi:
   *   (1) `piuMesi(adesso, -MESI_SENZA_CONSENSO)` → `-MESI_CON_CONSENSO`
   *   (2) rimozione completa di `.lt('creata_il', …)`
   * La (1) è il guasto silenzioso peggiore possibile qui: con la soglia a 24 mesi
   * nessuna candidatura fra i 12 e i 24 verrebbe MAI letta, quindi mai cancellata,
   * e il battito continuerebbe a scrivere `esito: 'ok', n_candidature: 0` — un
   * giro a vuoto che si dichiara riuscito, cioè l'ambiguità che questo file dice
   * di esistere per impedire. Ora gli argomenti si registrano e si asseriscono.
   */
  clausole: [] as { metodo: string; argomenti: unknown[] }[],
  /** Le risposte della lettura, in ordine. Vuota ⇒ si usa `righe`/`erroreLettura`. */
  letture: [] as { data: unknown; error: unknown }[],
  righe: [] as Record<string, unknown>[],
  erroreLettura: null as unknown,
  erroreDelete: null as unknown,
  /** Cosa risponde `storage.remove()`. */
  removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
  /** Il `count` che PostgREST restituisce sulla `delete`. `undefined` ⇒ quante ne sono state nominate. */
  countDelete: undefined as number | undefined,
  /** `true` ⇒ PostgREST il conteggio NON lo restituisce, anche se richiesto. */
  countAssente: false,
  /** Cosa fa esplodere `createAdminClient`, per provare il ramo dell'eccezione. */
  eccezioneClient: null as unknown,
  /** I percorsi che, INTERROGANDO lo Storage, risultano ANCORA nel bucket. */
  ancoraNelBucket: new Set<string>(),
  /** Le verifiche PER FILE (`list` con `search`): una per percorso non uscito. */
  verifiche: [] as string[],
  erroreVerifica: null as unknown,
  // ── LA SPAZZATA DEGLI ORFANI ──
  // `list()` senza `search`, cioè l'elenco del PREFISSO. Fino al 2026-08-15 questo
  // doppio non la prevedeva: la chiamata cadeva sul ramo della verifica per file e
  // veniva contata fra le `verifiche` — è il motivo per cui «un curriculum già
  // assente» misurava 2 verifiche invece di 1 dopo che la spazzata è entrata in
  // coda al percorso felice.
  /** Gli oggetti che lo Storage elenca sotto il prefisso dei curriculum. */
  elenco: [] as { name?: string | null; id?: string | null; created_at?: string | null }[],
  /** Le elencazioni del prefisso: cartella e opzioni, come le riceve la Storage API. */
  elencazioni: [] as { cartella: string; opzioni: unknown }[],
  /** Cosa risponde `list()` sul prefisso, quando fallisce. */
  erroreElenco: null as unknown,
  /** I `cv_path` che il database dichiara reclamati da una riga viva. */
  reclamati: [] as string[],
  /** L'errore della `select('cv_path')` della spazzata: è il caso fail-closed. */
  erroreReclamati: null as unknown,
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  staffNegato: null as unknown,
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () =>
    h.staffNegato
      ? { user: null, response: h.staffNegato }
      : { user: { id: '00000000-0000-4000-8000-000000000001' }, response: null },
  ),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.eccezioneClient) throw h.eccezioneClient
    return {
    from: () => {
      const qb: Record<string, unknown> = {}
      qb.select = (colonne: string) => {
        qb.__colonne = colonne
        h.select.push(colonne)
        return qb
      }
      for (const m of ['lt', 'in', 'eq', 'order', 'limit']) {
        qb[m] = (...argomenti: unknown[]) => {
          h.clausole.push({ metodo: m, argomenti })
          // Il lotto dell'`IN`: la risposta contiene solo i percorsi CHIESTI, come
          // fa PostgREST. Un doppio che restituisse tutti i reclamati a ogni lotto
          // renderebbe verde una route che sbaglia a spezzare i lotti.
          if (m === 'in') qb.__lotto = argomenti[1]
          return qb
        }
      }
      qb.delete = (opzioni?: { count?: string }) => ({
        in: (_c: string, ids: unknown) => {
          h.sequenza.push({ tipo: 'delete', valore: ids })
          // Il `count` arriva SOLO se la route l'ha chiesto: un mock che lo
          // restituisse sempre certificherebbe una route che non lo chiede.
          const count =
            opzioni?.count === 'exact' && !h.countAssente
              ? (h.countDelete ?? (ids as string[]).length)
              : undefined
          return Promise.resolve({ error: h.erroreDelete, count })
        },
      })
      qb.then = (res: (v: unknown) => unknown) => {
        // DUE letture diverse passano di qui, e vanno tenute separate: quella delle
        // candidature scadute (tutte le colonne) e quella della spazzata, che chiede
        // la SOLA `cv_path` per sapere quali curriculum una riga nomina ancora. Con
        // una coda sola la seconda consumerebbe le risposte preparate per la prima.
        if (qb.__colonne === 'cv_path') {
          const lotto = new Set((qb.__lotto as string[] | undefined) ?? [])
          return Promise.resolve(
            h.erroreReclamati
              ? { data: null, error: h.erroreReclamati }
              : { data: h.reclamati.filter((p) => lotto.has(p)).map((cv_path) => ({ cv_path })), error: null },
          ).then(res)
        }
        return Promise.resolve(
          h.letture.shift() ?? { data: h.righe, error: h.erroreLettura },
        ).then(res)
      }
      return qb
    },
    storage: {
      from: () => ({
        remove: (percorsi: string[]) => {
          h.sequenza.push({ tipo: 'remove', valore: percorsi })
          return Promise.resolve(
            h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
          )
        },
        // ⚠️ `list()` serve DUE scopi opposti, e confonderli è ciò che ha reso rosso
        // questo file quando la spazzata degli orfani è entrata in coda al percorso
        // felice: `rimuoviEVerifica` chiede di UN percorso passando `search`, la
        // spazzata ELENCA il prefisso e `search` non lo passa. Il doppio li distingue
        // sullo stesso parametro su cui li distingue la Storage API.
        list: (cartella: string, opzioni?: { search?: string }) => {
          if (typeof opzioni?.search !== 'string') {
            h.elencazioni.push({ cartella, opzioni })
            if (h.erroreElenco) return Promise.resolve({ data: null, error: h.erroreElenco })
            return Promise.resolve({ data: h.elenco, error: null })
          }
          const nome = opzioni.search
          h.verifiche.push(`${cartella}|${nome}`)
          if (h.erroreVerifica) return Promise.resolve({ data: null, error: h.erroreVerifica })
          const completo = cartella ? `${cartella}/${nome}` : nome
          return Promise.resolve({
            data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [],
            error: null,
          })
        },
      }),
    },
    }
  },
}))

import { POST } from '@/app/api/gdpr/retention-candidature/route'

const SORGENTE_ROUTE = readFileSync(
  join(process.cwd(), 'src/app/api/gdpr/retention-candidature/route.ts'),
  'utf8',
)
const INFORMATIVA = readFileSync(join(process.cwd(), 'src/app/privacy/page.tsx'), 'utf8')

const chiama = (headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) =>
  POST(
    new Request('http://localhost/api/gdpr/retention-candidature', {
      method: 'POST',
      headers,
    }) as never,
  )

/** Una data di `n` mesi fa, calcolata come la calcola la route. */
function meseFa(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toISOString()
}

/**
 * Una candidatura, col `cv_path` NELLA FORMA CHE IL PRODOTTO PRODUCE DAVVERO.
 *
 * ⚠️ Fino al 2026-08-15 questo helper scriveva `candidature/<id>/cv-rossi.pdf`, con
 * una barra dopo il prefisso e il cognome dentro il nome del file. Era la forma che
 * si immaginava quando nessuna rotta di caricamento esisteva; da quando esiste, il
 * percorso è `candidature/<uuid>-cv.<ext>` e il nome scelto dal browser non
 * sopravvive alla richiesta — `percorsoCvAmmesso` (src/lib/candidature/percorso-cv.ts)
 * RIFIUTA la forma vecchia. Un fixture che usa una forma che il prodotto non genera
 * più mette alla prova un caso che non può accadere, e smette di mettere alla prova
 * quello che accade.
 *
 * Il cognome resta fuori dal percorso perché il prodotto lo tiene fuori: la prova che
 * «il nome del file non finisce nei log» si è spostata dove nasce, cioè nel collaudo
 * della rotta di caricamento (`__tests__/api/candidature-upload.test.ts`). Qui si
 * prova che nei log non finisce il PERCORSO, che è la chiave con cui si firma un
 * oggetto di un bucket privato.
 */
const candidatura = (
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  stato: 'pending',
  creata_il: meseFa(18),
  evasa_il: null,
  cv_path: `candidature/${id}-cv.pdf`,
  consents_log: null,
  ...extra,
})

/**
 * Le costanti della spazzata, LETTE dalla route invece che ribattute: se il giorno
 * in cui la soglia delle 24 ore si sposta questi test restassero verdi con il numero
 * vecchio, misurerebbero una regola che non è più quella applicata.
 */
const ORE_ORFANO = Number(SORGENTE_ROUTE.match(/ORE_CURRICULUM_ORFANO\s*=\s*(\d+)/)![1])
const TETTO_ELENCO = Number(SORGENTE_ROUTE.match(/TETTO_ELENCO_ORFANI\s*=\s*(\d+)/)![1])
const LOTTO_VERIFICA = Number(SORGENTE_ROUTE.match(/LOTTO_VERIFICA_ORFANI\s*=\s*(\d+)/)![1])

/** Una data di `n` ore fa. */
const oreFa = (n: number): string => new Date(Date.now() - n * 60 * 60 * 1000).toISOString()

type OggettoStorage = { name?: string | null; id?: string | null; created_at?: string | null }

/**
 * Un oggetto come lo elenca la Storage API sotto il prefisso: nome RELATIVO alla
 * cartella, `id` valorizzato (le voci-cartella ce l'hanno `null`) e `created_at`.
 * Nasce già vecchio — un'ora oltre la soglia — perché il caso da provare è quello.
 */
const oggetto = (nome: string, extra: OggettoStorage = {}): OggettoStorage => ({
  name: nome,
  id: `og-${nome}`,
  created_at: oreFa(ORE_ORFANO + 1),
  ...extra,
})

/**
 * Due nomi nella forma che `costruisciPercorsoCv` produce: uuid, `-cv`, estensione.
 * Il cognome lì dentro non c'è per costruzione — ma il percorso resta la chiave con
 * cui si firma il curriculum di una persona, e nei log non deve comparire lo stesso.
 */
const CV_ORFANO = '11111111-1111-4111-8111-111111111111-cv.pdf'
const CV_RECLAMATO = '22222222-2222-4222-8222-222222222222-cv.pdf'
/** Il percorso pieno, come lo ricompone la route dal nome relativo. */
const sotto = (nome: string) => `candidature/${nome}`

/** Il consenso alla conservazione, nella forma con cui `estraiConsensi` lo archivia. */
const conConsenso = (accettato: boolean) => [
  { field_id: 'presa_visione_informativa', label: 'Informativa', accepted: true },
  { field_id: 'consenso_conservazione_candidatura', label: 'Conservazione', accepted: accettato },
]

const soloDelete = () => h.sequenza.filter((c) => c.tipo === 'delete')
const soloRemove = () => h.sequenza.filter((c) => c.tipo === 'remove')
const idsCancellati = () => soloDelete().flatMap((c) => c.valore as string[])
const eventiDi = (livello: string) => h.eventi.filter((e) => e.livello === livello)
/** Il battito che `controlloBattitoCron` sa leggere: `cron` · `info` · con i conteggi. */
const battiti = () =>
  h.eventi.filter((e) => e.evento === 'cron' && e.livello === 'info' && 'n_candidature' in e.campi)
const clausoleDi = (metodo: string) => h.clausole.filter((c) => c.metodo === metodo)

/** Quanti mesi indietro sta `iso` rispetto a ora, arrotondato al mese intero. */
function mesiIndietro(iso: string): number {
  const adesso = new Date()
  const d = new Date(iso)
  return (
    (adesso.getFullYear() - d.getFullYear()) * 12 +
    (adesso.getMonth() - d.getMonth()) -
    (adesso.getDate() < d.getDate() ? 1 : 0)
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sequenza = []
  h.select = []
  h.clausole = []
  h.countDelete = undefined
  h.countAssente = false
  h.eccezioneClient = null
  h.letture = []
  h.righe = []
  h.erroreLettura = null
  h.erroreDelete = null
  h.removeRisposta = null
  h.ancoraNelBucket = new Set()
  h.verifiche = []
  h.erroreVerifica = null
  h.elenco = []
  h.elencazioni = []
  h.erroreElenco = null
  h.reclamati = []
  h.erroreReclamati = null
  h.eventi = []
  h.staffNegato = null
  process.env.CRON_SECRET = CRON_SECRET
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — prima i file, poi le righe', () => {
  it('CONTROLLO POSITIVO: con tutto a posto toglie il CV E la riga, in quest’ordine', async () => {
    // Senza questo, l'intero file certificherebbe una route che non cancella mai
    // niente — cioè una conservazione che non conserva e non cancella.
    h.righe = [candidatura('c1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, candidature: 1, file: 1 })
    expect(h.sequenza.map((c) => c.tipo), 'prima remove, poi delete').toEqual(['remove', 'delete'])
    expect(idsCancellati()).toEqual(['c1'])
  })

  it('🔴 un curriculum che NON esce trattiene solo la SUA riga, e la risposta è 500', async () => {
    // La conservazione è un obbligo per riga, non per lotto: il curriculum di c1
    // non ha niente a che vedere con la candidatura di c2. E il lotto lavorato a
    // metà si DICHIARA guasto: un 200 direbbe «fatto» a chi sorveglia.
    h.righe = [candidatura('c1'), candidatura('c2')]
    h.removeRisposta = { data: [{ name: 'candidature/c2-cv.pdf' }], error: null }
    h.ancoraNelBucket = new Set(['candidature/c1-cv.pdf'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'allegati-non-rimossi',
      candidature: 1,
      candidature_trattenute: 1,
    })
    expect(idsCancellati(), 'c2 non è trattenuta dal file di c1').toEqual(['c2'])
  })

  it('🔴 se `remove()` fallisce del tutto, NESSUNA riga si tocca', async () => {
    h.righe = [candidatura('c1')]
    h.removeRisposta = { data: null, error: { message: 'storage giù' } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDelete(), 'un curriculum irraggiungibile non è un curriculum cancellato').toHaveLength(0)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'allegati-non-rimossi' })
  })

  it('un curriculum GIÀ ASSENTE non blocca niente: l’esito voluto è raggiunto', async () => {
    // Il difetto che si sarebbe auto-bloccato per sempre: un file mancante non
    // torna, e contarlo come guasto avrebbe fermato ogni cancellazione futura.
    h.righe = [candidatura('c1')]
    h.removeRisposta = { data: [], error: null }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(idsCancellati()).toEqual(['c1'])
    expect(h.verifiche.length, 'il percorso non uscito si verifica').toBe(1)
    // Da quando la spazzata degli orfani gira in coda al percorso felice, questo
    // conteggio è stato misurato a 2: la spazzata chiama `list()` a sua volta, ma
    // sul PREFISSO e senza `search`. Sono due domande diverse allo stesso metodo —
    // «questo file c'è ancora?» e «cosa c'è là sotto?» — e il doppio le tiene
    // separate come le tiene separate la Storage API.
    expect(h.elencazioni, 'l’elenco del prefisso non è una verifica per file').toHaveLength(1)
  })

  it('una candidatura SENZA curriculum non fa partire nessuna chiamata allo Storage', async () => {
    h.righe = [candidatura('c1', { cv_path: null })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloRemove(), 'niente da togliere, niente da chiedere').toHaveLength(0)
    expect(idsCancellati()).toEqual(['c1'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — il battito, che si scrive SEMPRE', () => {
  it('🔴 il conteggio c’è ANCHE A ZERO: «nessuna riga» non può voler dire due cose', async () => {
    // Con i soli errori, «nessun log» non distingue «tutto a posto» da «non è mai
    // partito niente» — l'ambiguità che ha nascosto il guasto delle email.
    h.righe = []
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({ n_candidature: 0, esito: 'ok' })
  })

  it('🔴 il conteggio c’è anche quando la LETTURA fallisce: sta fuori dal ramo che può fallire', async () => {
    h.erroreLettura = { code: '08006', message: 'connessione persa' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'lettura-fallita' })
    expect(battiti(), 'il battito non può stare dentro la transazione che sorveglia').toHaveLength(1)
    expect(eventiDi('error').some((e) => e.campi.esito === 'lettura-fallita')).toBe(true)
  })

  it('il battito è quello che `controlloBattitoCron` sa leggere: cron · info · esito ok · operazione', async () => {
    // `esito` risponde a «è andata bene?», non a «di che cosa si occupa»: un
    // battito con l'esito sbagliato non viene contato da nessuno, e il lavoro può
    // smettere di girare senza che nulla lo dica.
    h.righe = [candidatura('c1')]
    await chiama()
    expect(battiti()[0].campi).toMatchObject({
      operazione: 'candidature-retention',
      esito: 'ok',
      n_candidature: 1,
    })
  })

  it('🔴 il conteggio c’è anche sull’ECCEZIONE, e l’eccezione non viene inghiottita', async () => {
    // Il `finally` è la ragione d'essere di questo file, e finora nessun test lo
    // aveva provato sul caso per cui esiste: un guasto che non è un `{ error }`
    // di PostgREST ma un lancio vero. Se il battito stesse nel ramo felice, qui
    // non ci sarebbe — e «nessun log» tornerebbe a voler dire due cose insieme.
    h.eccezioneClient = new Error('createAdminClient: connessione rifiutata')
    await expect(chiama(), 'un’eccezione si logga e si RILANCIA, non si maschera').rejects.toThrow(
      'connessione rifiutata',
    )
    expect(battiti(), 'il battito sopravvive all’eccezione').toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({ esito: 'eccezione', n_candidature: 0 })
    expect(eventiDi('error').some((e) => e.campi.esito === 'eccezione')).toBe(true)
  })

  it('e quando qualcosa resta indietro il battito NON dice `ok`', async () => {
    h.righe = [candidatura('c1')]
    h.removeRisposta = { data: [], error: null }
    h.ancoraNelBucket = new Set(['candidature/c1-cv.pdf'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(battiti()).toHaveLength(1)
    expect(
      battiti()[0].campi.esito,
      'un giro che non ha finito il lavoro non è un giro riuscito',
    ).not.toBe('ok')
    expect(battiti()[0].campi).toMatchObject({ n_candidature_trattenute: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — i termini', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // I TRE CASI, UNO PER UNO — e il difetto che questi test hanno sostituito.
  //
  // Fino al 2026-08-10 la route applicava ai 24 mesi anche la candidatura
  // ACCOLTA SENZA CONSENSO, facendoli per giunta decorrere da `evasa_il`: fino a
  // ~24 mesi oltre il termine dichiarato all'interessata (art. 13 §2 lett. a).
  // I due test che stavano qui certificavano quella regola invece di misurarla
  // contro ciò che è stato promesso. Le tre fonti dicevano tutte un'altra cosa:
  // l'informativa («dodici mesi dalla ricezione, o dalla decisione se la
  // candidatura NON è accolta»), il testo del consenso («24 mesi anche se la
  // valutazione dovesse avere esito NEGATIVO» — il consenso è la sola leva che
  // allunga) e la docstring della costante importata («candidatura NON accolta,
  // se acconsentito»).
  //
  // Le due leve, separate apposta perché un test le possa separare:
  //   il RIFIUTO sposta il giorno d'inizio · il CONSENSO allunga la durata.
  // ───────────────────────────────────────────────────────────────────────────

  it('🔴 ACCOLTA senza consenso: dodici mesi dalla RICEZIONE, non dalla decisione', async () => {
    // Il caso che valeva 24 mesi da `evasa_il` e non doveva: a 14 mesi dalla
    // ricezione la candidatura accolta è scaduta come ogni altra, e il giorno in
    // cui la Direzione ha deciso non sposta niente. Se questo test torna verde
    // con `evasa_il` fra gli stati che spostano la decorrenza, `assunta-vecchia`
    // sopravvive: è la differenza che si misura.
    h.righe = [
      candidatura('assunta-fresca', { stato: 'approvata', creata_il: meseFa(6), evasa_il: meseFa(5) }),
      candidatura('assunta-vecchia', { stato: 'approvata', creata_il: meseFa(14), evasa_il: meseFa(2) }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      idsCancellati(),
      'la decisione della Direzione non è il giorno d’inizio di una candidatura ACCOLTA',
    ).toEqual(['assunta-vecchia'])
  })

  it('🔴 ACCOLTA con consenso: ventiquattro mesi, e sempre dalla RICEZIONE', async () => {
    // Il consenso allunga la DURATA. Non sposta la decorrenza: quella la sposta
    // solo il rifiuto. Due leve, e questo test le tiene separate.
    h.righe = [
      candidatura('assunta-14', {
        stato: 'approvata',
        creata_il: meseFa(14),
        evasa_il: meseFa(2),
        consents_log: conConsenso(true),
      }),
      candidatura('assunta-26', {
        stato: 'approvata',
        creata_il: meseFa(26),
        evasa_il: meseFa(2),
        consents_log: conConsenso(true),
      }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual(['assunta-26'])
  })

  it('🔴 i 24 mesi NON si applicano mai senza consenso, qualunque sia lo stato', async () => {
    // La costante che la route importa dichiara di sé «candidatura NON accolta,
    // SE ACCONSENTITO»: nessuno stato, da solo, può attivarla. Se qualcuno
    // rimettesse `stato === 'approvata'` fra le condizioni dei 24 mesi, la prima
    // riga sopravvivrebbe e questo test cadrebbe.
    for (const stato of ['approvata', 'rifiutata', 'pending', 'in_approvazione']) {
      h.sequenza = []
      h.righe = [
        candidatura(`s-${stato}`, {
          stato,
          creata_il: meseFa(14),
          // `evasa_il` a 13 mesi: anche spostando la decorrenza sulla decisione,
          // 13 mesi restano oltre i 12. È lo STATO a non poter allungare.
          evasa_il: meseFa(13),
          consents_log: conConsenso(false),
        }),
      ]
      await chiama()
      expect(idsCancellati(), `«${stato}» senza consenso vale dodici mesi, non ventiquattro`).toEqual([
        `s-${stato}`,
      ])
    }
  })

  it('🔴 il consenso alla conservazione sposta il termine da 12 a 24', async () => {
    // Stessa riga, stessa data, due esiti: il consenso è l'unica differenza.
    h.righe = [
      candidatura('senza', { creata_il: meseFa(14), consents_log: conConsenso(false) }),
      candidatura('con', { creata_il: meseFa(14), consents_log: conConsenso(true) }),
    ]
    await chiama()
    expect(idsCancellati(), 'chi ha acconsentito resta fino ai 24 mesi').toEqual(['senza'])
  })

  it('… e col consenso si cancella comunque, passati i 24 mesi', async () => {
    h.righe = [candidatura('con', { creata_il: meseFa(26), consents_log: conConsenso(true) })]
    await chiama()
    expect(idsCancellati()).toEqual(['con'])
  })

  it('una candidatura RIFIUTATA scade dodici mesi dopo la DECISIONE, non dopo la ricezione', async () => {
    // È ciò che l'informativa promette: «dodici mesi dalla ricezione, o dalla
    // decisione se la candidatura non è accolta».
    h.righe = [
      candidatura('respinta', { stato: 'rifiutata', creata_il: meseFa(20), evasa_il: meseFa(3) }),
      candidatura('vecchia', { stato: 'rifiutata', creata_il: meseFa(30), evasa_il: meseFa(14) }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual(['vecchia'])
  })

  it('🔴 una data ILLEGGIBILE non si cancella: «non verificabile» non è «permesso»', async () => {
    // `creata_il` nullo o non parsabile non è un via libera: su un'operazione
    // irreversibile un dato che manca vale «non toccare». Senza questo test la
    // riga `if (!riferimento) return false` poteva diventare `return true` e
    // nessuno se ne sarebbe accorto — cancellerebbe tutto ciò che non sa datare.
    h.righe = [
      candidatura('senza-data', { creata_il: null }),
      candidatura('data-rotta', { creata_il: 'non-una-data' }),
      candidatura('rifiutata-senza-date', { stato: 'rifiutata', creata_il: null, evasa_il: null }),
      candidatura('buona', { creata_il: meseFa(14) }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(idsCancellati(), 'si cancella solo ciò che si sa datare').toEqual(['buona'])
  })

  it('una candidatura MAI VALUTATA scade dodici mesi dopo la ricezione', async () => {
    h.righe = [
      candidatura('fresca', { creata_il: meseFa(6) }),
      candidatura('scaduta', { creata_il: meseFa(14) }),
      candidatura('in_corso', { stato: 'in_approvazione', creata_il: meseFa(14) }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual(['scaduta', 'in_corso'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — il taglio grossolano, che nessuno guardava', () => {
  // Questi tre test esistono per due mutazioni MISURATE il 2026-08-10, sopravvissute
  // entrambe con 27 test verdi perché il mock buttava via gli argomenti delle
  // clausole. Un lock che non guarda la clausola WHERE non sorveglia una query:
  // sorveglia il fatto che una query sia stata scritta.

  it('🔴 la soglia è il termine PIÙ BREVE (12 mesi), non il più lungo', async () => {
    // LA MUTAZIONE CHE SOPRAVVIVEVA: `-MESI_SENZA_CONSENSO` → `-MESI_CON_CONSENSO`.
    // Con la soglia a 24 mesi nessuna candidatura fra i 12 e i 24 verrebbe mai
    // LETTA, quindi mai cancellata — e il battito continuerebbe a dire
    // `esito: 'ok', n_candidature: 0`. Un giro a vuoto che si dichiara riuscito è
    // esattamente il guasto che questo file dice di esistere per impedire.
    h.righe = []
    await chiama()
    const lt = clausoleDi('lt')
    expect(lt, 'la lettura non filtra più per data: legge tutta la tabella').toHaveLength(1)
    expect(lt[0].argomenti[0], 'il taglio si fa sulla data di RICEZIONE').toBe('creata_il')
    const soglia = String(lt[0].argomenti[1])
    const mesi = Number(SORGENTE_ROUTE.match(/MESI_SENZA_CONSENSO\s*=\s*(\d+)/)![1])
    expect(
      mesiIndietro(soglia),
      `la soglia deve stare ${mesi} mesi indietro — il termine PIÙ BREVE. Con il più lungo, ` +
        'nessuna candidatura fra i due termini verrebbe mai letta né cancellata, e il battito ' +
        'direbbe «ok, zero» ogni notte',
    ).toBe(mesi)
  })

  it('la lettura ha un TETTO e legge le più vecchie per prime', async () => {
    // Senza `.limit()` il taglio lo decide `db-max-rows` di PostgREST, e lo decide
    // in silenzio; senza `.order()` il lotto tagliato è arbitrario, e le
    // candidature più in ritardo potrebbero non uscire mai.
    h.righe = []
    await chiama()
    const limit = clausoleDi('limit')
    expect(limit, 'la lettura non ha nessun tetto esplicito').toHaveLength(1)
    expect(Number(limit[0].argomenti[0])).toBeGreaterThan(0)
    const order = clausoleDi('order')
    expect(order, 'senza ordine, un lotto tagliato è un lotto arbitrario').toHaveLength(1)
    expect(order[0].argomenti[0]).toBe('creata_il')
    expect(order[0].argomenti[1]).toMatchObject({ ascending: true })
  })

  it('🔴 un lotto al tetto si DICHIARA: «ok» su un lotto tagliato è un mezzo lavoro travestito', async () => {
    const tetto = Number(SORGENTE_ROUTE.match(/TETTO_LOTTO\s*=\s*(\d+)/)![1])
    h.righe = Array.from({ length: tetto }, (_v, i) =>
      candidatura(`c${i}`, { cv_path: null, creata_il: meseFa(14) }),
    )
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, lotto_pieno: true })
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'lotto-pieno'),
      'il taglio del lotto deve lasciare una traccia leggibile in app_log',
    ).toBe(true)
    expect(battiti()[0].campi).toMatchObject({ lotto_pieno: true })
  })

  it('e un lotto NON pieno lo dice altrettanto chiaramente', async () => {
    h.righe = [candidatura('c1', { cv_path: null })]
    const res = await chiama()
    expect(await res.json()).toMatchObject({ lotto_pieno: false })
    expect(eventiDi('warn').some((e) => e.campi.esito === 'lotto-pieno')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — il numero dichiarato è quello VERO', () => {
  it('🔴 la `delete` chiede il conteggio esatto, e si dichiara quello, non l’intenzione', async () => {
    // `nCancellate = chiudibili.length` era il numero delle righe che si INTENDEVA
    // cancellare. Il file predica «si verifica lo STATO, non il conteggio» per i
    // file, e sulle righe dava per buona la propria intenzione.
    h.righe = [candidatura('c1'), candidatura('c2')]
    h.countDelete = 1 // una era già stata tolta dal cockpit
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(
      await res.json(),
      'due righe nominate, una davvero cancellata: si dichiara una',
    ).toMatchObject({ ok: true, candidature: 1 })
    expect(battiti()[0].campi).toMatchObject({ n_candidature: 1, conteggio_verificato: true })
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde'),
      'lo scarto si dichiara: non è un guasto, ma non è nemmeno niente',
    ).toBe(true)
  })

  it('… e se PostgREST il conteggio non lo dà, non si finge di averlo misurato', async () => {
    // `conteggio_verificato: false` non vuol dire «sbagliato»: vuol dire che il
    // numero accanto è l'intenzione. Distinguere le due cose è tutto il punto.
    h.righe = [candidatura('c1')]
    h.countAssente = true
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()[0].campi).toMatchObject({ n_candidature: 1, conteggio_verificato: false })
    expect(
      eventiDi('warn').some((e) => e.campi.esito === 'conteggio-discorde'),
      'un conteggio che non c’è non è un conteggio discorde',
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — l’autenticazione', () => {
  it('🔴 il segreto SBAGLIATO è loggato come errore', async () => {
    // Un cron che bussa con la chiave sbagliata è il guasto invisibile: non
    // cancella più niente e non lo dice a nessuno.
    const res = await chiama({ 'x-cron-secret': 'chiave-che-non-torna' })
    expect(res.status).toBe(200) // lo staff finto del mock passa: conta il LOG
    const errore = eventiDi('error').find((e) => e.campi.esito === 'secret-errato')
    expect(errore, 'l’header c’è e non torna: va gridato').toBeTruthy()
    expect(errore?.evento).toBe('cron')
  })

  it('senza header è lo staff a rispondere del giro (lancio manuale)', async () => {
    h.righe = []
    const res = await chiama({})
    expect(res.status).toBe(200)
    expect(
      eventiDi('error').some((e) => e.campi.esito === 'secret-errato'),
      'un header assente non è un header sbagliato',
    ).toBe(false)
    expect(battiti()[0].campi.canale).toBe('manuale')
  })

  it('e se lo staff non passa, non si cancella niente — e il battito lo DICE', async () => {
    h.staffNegato = new Response(JSON.stringify({ error: 'no' }), { status: 403 })
    h.righe = [candidatura('c1')]
    const res = await chiama({})
    expect(res.status).toBe(403)
    expect(h.sequenza, 'gate prima, lavoro poi').toHaveLength(0)
    // Il 403 lo vede solo chi ha fatto la chiamata. Chi legge `app_log` la notte
    // dopo vede un battito senza cancellazioni: se dicesse `ok` sembrerebbe un
    // giro riuscito a vuoto, che è la cosa che questo file non deve mai produrre.
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({ esito: 'non-autorizzato', n_candidature: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — il DB della CI non è migrato', () => {
  it('🔴 tabella assente ⇒ 503 con il codice, MAI un 200 bugiardo', async () => {
    h.letture = [{ data: null, error: { code: 'PGRST205', message: 'relation not found' } }]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'tabella-assente' })
    const riga = h.eventi.find((e) => e.campi.esito === 'tabella-assente')
    expect(riga?.campi.error_code, 'il codice va detto, è ciò che distingue i due guasti').toBe(
      'PGRST205',
    )
  })

  it('🔴 colonna assente ⇒ si ritenta senza, con un warn che la NOMINA', async () => {
    h.letture = [
      { data: null, error: { code: '42703', message: 'column candidature_insegnanti.consents_log does not exist' } },
      { data: [candidatura('c1', { creata_il: meseFa(14) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.select.length, 'una lettura, poi la seconda senza la colonna').toBe(2)
    expect(h.select[0]).toContain('consents_log')
    expect(h.select[1], 'la colonna assente esce dalla select').not.toContain('consents_log')
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'colonna-assente')
    expect(avviso, 'un ripiego taciuto è un ripiego che nessuno scopre').toBeTruthy()
    expect(String(avviso?.campi.msg)).toContain('consents_log')
  })

  it('🔴 senza `cv_path` NON si cancella niente: righe tolte e curriculum lasciati è il caso peggiore', async () => {
    // Il difetto vero, non ipotetico: senza `cv_path` la seconda `select` la
    // esclude, `percorsi` resta vuoto, nessuna `remove()` parte — e le righe si
    // cancellavano lo stesso. I curriculum sarebbero rimasti nel bucket senza più
    // nessuna riga che li nomini: invisibili, non cancellati, che è testualmente
    // «il modo peggiore di conservare un dato personale» scritto in testa alla
    // route. Il verso giusto è quello che CONSERVA.
    h.letture = [
      { data: null, error: { code: '42703', message: 'column candidature_insegnanti.cv_path does not exist' } },
      { data: [candidatura('c1', { creata_il: meseFa(30), cv_path: undefined })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'cv-path-ignoto', candidature: 0 })
    expect(soloDelete(), 'non si sa quali file la riga nomini: la riga non si tocca').toHaveLength(0)
    expect(soloRemove()).toHaveLength(0)
    expect(battiti()[0].campi).toMatchObject({ esito: 'cv-path-ignoto', cv_path_ignoto: true })
  })

  it('🔴 e un `42703` che non NOMINA nessuna colonna nota cade dalla stessa parte', async () => {
    // Il ripiego di `colonneMancanti` rinuncia a tutte e tre le colonne quando non
    // riconosce nessun nome: quindi qualunque errore di colonna illeggibile
    // arriva qui — e qui non si cancella. Prima di oggi arrivava alla `delete`.
    h.letture = [
      { data: null, error: { code: 'PGRST204', message: 'schema cache: something entirely unknown' } },
      { data: [candidatura('c1', { creata_il: meseFa(30) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(503)
    expect(soloDelete()).toHaveLength(0)
  })

  it('🔴 senza `consents_log` il consenso è IGNOTO, e ignoto vale 24 mesi (non 12)', async () => {
    // Non si cancella prima del termine più lungo che si potrebbe aver promesso:
    // «non lo so» non autorizza a distruggere.
    h.letture = [
      { data: null, error: { code: 'PGRST204', message: 'column consents_log does not exist' } },
      { data: [candidatura('c1', { creata_il: meseFa(14), consents_log: undefined })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(soloDelete(), 'a 14 mesi, con il consenso ignoto, non si tocca').toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — cosa NON finisce nei log', () => {
  it('🔴 il nome del file del curriculum non compare in nessun log', async () => {
    // `cv-<cognome>.pdf`: il nome del file È il cognome di chi si è candidato.
    h.righe = [candidatura('c1'), candidatura('c2')]
    h.removeRisposta = { data: [], error: null }
    h.ancoraNelBucket = new Set(['candidature/c1-cv.pdf'])
    await chiama()
    const tutto = JSON.stringify(h.eventi)
    for (const proibito of ['cv-rossi', '.pdf', 'candidature/c1']) {
      expect(tutto.includes(proibito), `«${proibito}» non deve stare in un log`).toBe(false)
    }
    expect(h.eventi.length, 'e comunque i log ci sono: conteggi, non nomi').toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — i curriculum ORFANI del prefisso', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // COSA MISURA QUESTO BLOCCO, e perché non lo misurava niente.
  //
  // Tutto ciò che sta sopra parte dalle RIGHE: guarda solo i curriculum che una
  // candidatura nomina. Ma il curriculum si carica PRIMA che la candidatura
  // esista — la rotta di caricamento scrive nel bucket e restituisce il percorso,
  // l'invio del modulo viene dopo — e fra i due gesti c'è una persona che può
  // chiudere la pagina. Quel file resta nell'archivio senza nessuna riga che lo
  // nomini: invisibile, non cancellato, e nemmeno identificabile per cancellarlo
  // se quella persona lo chiedesse. È testualmente «il modo peggiore di conservare
  // un dato personale» scritto in testa alla route, ed è il caso NORMALE, non
  // l'abuso.
  //
  // La spazzata è entrata il 2026-08-15 e questo file non la vedeva: la sola
  // traccia che ne aveva era un conteggio di verifiche salito da 1 a 2, cioè un
  // test rosso che diceva «qualcosa chiama lo Storage» e nient'altro.
  //
  // Le quattro prudenze, una per test: solo ciò che è vecchio · prima si chiede al
  // database e poi si cancella · il troncamento si dichiara · un guasto della
  // pulizia non diventa un giro di conservazione fallito.
  // ───────────────────────────────────────────────────────────────────────────

  it('🔴 un curriculum vecchio che NESSUNA riga nomina esce dall’archivio', async () => {
    // Il controllo positivo del blocco: senza, tutto il resto certificherebbe una
    // spazzata che non spazza — cioè la condizione da cui è nata.
    h.righe = []
    h.elenco = [oggetto(CV_ORFANO)]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      orfani_esaminati: 1,
      orfani_rimossi: 1,
      orfani_esito: 'ok',
    })
    expect(soloRemove().map((c) => c.valore)).toEqual([[sotto(CV_ORFANO)]])
    expect(
      eventiDi('info').some((e) => e.campi.esito === 'orfani-rimossi'),
      'questa pulizia non ha nessuna schermata che si riempie a vista: il successo si logga',
    ).toBe(true)
  })

  it('🔴 un curriculum caricato DA POCO non si tocca: è di chi sta ancora compilando', async () => {
    // Chi carica il curriculum e finisce di compilare il modulo mezz'ora dopo non
    // deve trovarselo portato via da sotto le mani. La soglia è la stessa costante
    // che la route dichiara, letta da lì.
    h.righe = []
    h.elenco = [oggetto(CV_ORFANO, { created_at: oreFa(ORE_ORFANO - 1) })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ orfani_esaminati: 0, orfani_rimossi: 0 })
    expect(soloRemove()).toHaveLength(0)
    expect(
      clausoleDi('in'),
      'e al database non si chiede nemmeno: non c’è niente su cui chiedere',
    ).toHaveLength(0)
  })

  it('🔴 un curriculum vecchio ma NOMINATO da una candidatura viva non si tocca', async () => {
    // «Sotto il prefisso» non è «orfano»: la differenza la fa il database, e la si
    // chiede prima di cancellare, non dopo.
    h.righe = []
    h.elenco = [oggetto(CV_RECLAMATO)]
    h.reclamati = [sotto(CV_RECLAMATO)]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      orfani_esaminati: 1,
      orfani_rimossi: 0,
      orfani_esito: 'ok',
    })
    expect(soloRemove()).toHaveLength(0)
    expect(clausoleDi('in')[0]?.argomenti, 'si chiede esattamente dei percorsi guardati').toEqual([
      'cv_path',
      [sotto(CV_RECLAMATO)],
    ])
  })

  it('🔴 se non si sa quali curriculum siano reclamati, NON si rimuove niente', async () => {
    // FAIL-CLOSED, ed è il verso di tutto il file: «non so quali file una riga
    // nomini» vale «li nomina tutti». La rinuncia è dell'INTERA spazzata e non del
    // solo lotto — con una parte dei reclami sconosciuta, gli orfani calcolati sui
    // lotti riusciti comprenderebbero file che una riga nomina davvero.
    h.righe = []
    h.elenco = [oggetto(CV_ORFANO)]
    h.erroreReclamati = { code: '42703', message: 'column cv_path does not exist' }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      orfani_esaminati: 1,
      orfani_rimossi: 0,
      orfani_esito: 'verifica-non-riuscita',
    })
    expect(soloRemove(), 'una lettura che non riesce non autorizza a distruggere').toHaveLength(0)
    const errore = eventiDi('error').find((e) => e.campi.esito === 'orfani-verifica-non-riuscita')
    expect(errore, 'una rinuncia taciuta è una rinuncia che nessuno scopre').toBeTruthy()
    expect(errore?.campi.error_code, 'il codice va detto: distingue i guasti fra loro').toBe('42703')
  })

  it('🔴 se l’ELENCO non si legge, la conservazione NON fallisce per questo', async () => {
    // Le due cose sono indipendenti, e la prima risponde a una promessa scritta nel
    // consenso: un guasto della manutenzione non può far dichiarare guasto il giro
    // che ha cancellato ciò che doveva. L'esito della spazzata resta però scritto,
    // ed è l'unico modo di sapere in SQL che quella pulizia non è partita.
    h.righe = [candidatura('c1')]
    h.erroreElenco = { message: 'storage non risponde' }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      candidature: 1,
      orfani_esito: 'elenco-non-letto',
    })
    expect(idsCancellati(), 'la riga scaduta si cancella lo stesso').toEqual(['c1'])
    expect(eventiDi('error').some((e) => e.campi.esito === 'orfani-elenco-non-letto')).toBe(true)
    expect(battiti()[0].campi).toMatchObject({ esito: 'ok', orfani_esito: 'elenco-non-letto' })
  })

  it('🔴 le voci-CARTELLA e il segnaposto non sono oggetti: si saltano', async () => {
    // Una voce-cartella ha `id === null` e non si può cancellare; trattarla come un
    // percorso farebbe cercare al database righe che non esistono.
    // `.emptyFolderPlaceholder` lo crea lo Storage da sé quando una cartella resta
    // vuota: toglierlo farebbe sparire la cartella.
    h.righe = []
    h.elenco = [
      { name: 'una-sottocartella', id: null, created_at: oreFa(ORE_ORFANO + 1) },
      oggetto('.emptyFolderPlaceholder'),
      oggetto(CV_ORFANO),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ orfani_esaminati: 1, orfani_rimossi: 1 })
    expect(soloRemove().map((c) => c.valore)).toEqual([[sotto(CV_ORFANO)]])
  })

  it('🔴 una data di caricamento ILLEGGIBILE vale «non toccare»', async () => {
    // Stessa regola del taglio fine sulle righe: su un'operazione irreversibile un
    // dato che manca non è un permesso.
    h.righe = []
    h.elenco = [
      oggetto(CV_RECLAMATO, { created_at: 'non-una-data' }),
      oggetto(CV_ORFANO, { created_at: null }),
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ orfani_esaminati: 0, orfani_rimossi: 0 })
    expect(soloRemove()).toHaveLength(0)
  })

  it('🔴 una pagina PIENA è un elenco TRONCATO, e si dichiara', async () => {
    // Una pagina piena significa oggetti che nessuno ha nemmeno guardato: un elenco
    // tagliato in silenzio racconta una pulizia completa che non c'è stata.
    // Tutti recenti apposta: qui si misura il troncamento, non la rimozione.
    h.righe = []
    h.elenco = Array.from({ length: TETTO_ELENCO }, (_v, i) =>
      oggetto(`${i}-cv.pdf`, { created_at: oreFa(1) }),
    )
    const res = await chiama()
    expect(res.status).toBe(200)
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'orfani-elenco-troncato')
    expect(avviso, 'il taglio deve lasciare una traccia leggibile in app_log').toBeTruthy()
    expect(avviso?.campi.n_file).toBe(TETTO_ELENCO)
    expect(battiti()[0].campi).toMatchObject({ orfani_elenco_troncato: true })
    // ⚠️ MISURATO: `orfani_elenco_troncato` sta nel battito e NON nel corpo della
    // risposta, a differenza di `lotto_pieno` — che è la stessa nozione sulle righe
    // ed è esposta a chi lancia il giro a mano proprio «per sapere se richiamarlo».
    // Non lo si asserisce qui: bloccare l'assenza sarebbe fissarla. Riferito.
    expect(
      h.elencazioni[0].opzioni,
      'i più vecchi per primi: se la pagina taglia, deve tagliare i meno in ritardo',
    ).toMatchObject({ limit: TETTO_ELENCO, sortBy: { column: 'created_at', order: 'asc' } })
  })

  it('e un elenco NON pieno non lascia nessun avviso', async () => {
    h.righe = []
    h.elenco = [oggetto(CV_ORFANO)]
    await chiama()
    expect(eventiDi('warn').some((e) => e.campi.esito === 'orfani-elenco-troncato')).toBe(false)
    expect(battiti()[0].campi).toMatchObject({ orfani_elenco_troncato: false })
  })

  it('🔴 la domanda al database si spezza in lotti, e ogni lotto risponde per sé', async () => {
    // `.in()` finisce nella query string di PostgREST: una `IN` con mille valori
    // produce un URL che nessuno garantisce venga accettato per intero. Il doppio
    // risponde SOLO dei percorsi chiesti — se i lotti fossero spezzati male, il
    // curriculum reclamato che sta nel secondo lotto risulterebbe orfano e uscirebbe
    // dall'archivio mentre una candidatura viva lo nomina ancora.
    const nomi = Array.from({ length: LOTTO_VERIFICA + 1 }, (_v, i) => `${i}-cv.pdf`)
    h.righe = []
    h.elenco = nomi.map((n) => oggetto(n))
    h.reclamati = [sotto(nomi[LOTTO_VERIFICA])] // l'ultimo: cade nel secondo lotto
    const res = await chiama()
    expect(res.status).toBe(200)
    const chieste = clausoleDi('in')
    expect(chieste.map((c) => (c.argomenti[1] as string[]).length)).toEqual([LOTTO_VERIFICA, 1])
    expect(await res.json()).toMatchObject({
      orfani_esaminati: LOTTO_VERIFICA + 1,
      orfani_rimossi: LOTTO_VERIFICA,
    })
    const rimossi = soloRemove().flatMap((c) => c.valore as string[])
    expect(rimossi, 'il reclamato del secondo lotto resta').not.toContain(sotto(nomi[LOTTO_VERIFICA]))
  })

  it('🔴 nei log della spazzata non compare NESSUN percorso', async () => {
    // Il nome del file non porta più il cognome (lo butta via la rotta di
    // caricamento), ma il percorso resta la chiave con cui si firma il curriculum di
    // una persona, e `redact()` non lo ha in lista bianca. `app_log` si interroga in
    // SQL per 30 giorni.
    h.righe = []
    h.elenco = [oggetto(CV_ORFANO), oggetto(CV_RECLAMATO)]
    h.reclamati = [sotto(CV_RECLAMATO)]
    await chiama()
    const tutto = JSON.stringify(h.eventi)
    for (const proibito of [CV_ORFANO, CV_RECLAMATO, 'candidature/', '.pdf']) {
      expect(tutto.includes(proibito), `«${proibito}» non deve stare in un log`).toBe(false)
    }
    expect(h.eventi.length, 'e comunque i log ci sono: conteggi, non percorsi').toBeGreaterThan(0)
  })

  it('🔴 il battito porta i conteggi della spazzata: senza, «nessun log» direbbe due cose', async () => {
    // Se la pulizia non lasciasse una riga anche quando non trova niente, «nessun
    // log» non distinguerebbe «non ci sono curriculum abbandonati» da «la pulizia
    // non parte più» — l'ambiguità contro cui è scritto l'intero file.
    h.righe = []
    h.elenco = [oggetto(CV_ORFANO), oggetto(CV_RECLAMATO)]
    h.reclamati = [sotto(CV_RECLAMATO)]
    await chiama()
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({
      n_orfani_esaminati: 2,
      n_orfani: 1,
      n_orfani_rimossi: 1,
      orfani_esito: 'ok',
      orfani_elenco_troncato: false,
    })
  })

  it('se il lotto principale TRATTIENE qualcosa, la spazzata salta il giro', async () => {
    // Sta in coda al percorso felice e non prima: la conservazione delle candidature
    // scadute è una promessa scritta nel consenso, la spazzata è manutenzione. Gira
    // ogni notte, e ciò che oggi è orfano lo sarà anche domani.
    h.righe = [candidatura('c1')]
    h.removeRisposta = { data: [], error: null }
    h.ancoraNelBucket = new Set(['candidature/c1-cv.pdf'])
    h.elenco = [oggetto(CV_ORFANO)]
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(h.elencazioni, 'il prefisso non si elenca nemmeno').toHaveLength(0)
    // ⚠️ MISURATO: in questo caso il battito scrive `orfani_esito: 'ok'` con zero
    // esaminati, che è la stessa riga di un giro in cui la pulizia ha guardato e non
    // ha trovato niente. A distinguerli resta l'`esito` generale, che qui non è `ok`.
    expect(battiti()[0].campi).toMatchObject({ esito: 'candidature-trattenute', n_orfani: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('lock · il termine promesso e il termine applicato sono LO STESSO numero', () => {
  it('🔴 i 24 mesi del codice sono `CANDIDATURA_LIMITI.mesiConservazione`, IMPORTATI', () => {
    // Due costanti indipendenti per lo stesso termine divergono in silenzio, e a
    // divergere sarebbe il termine dichiarato alla persona (art. 13 §2 lett. a).
    expect(
      /MESI_CON_CONSENSO\s*=\s*CANDIDATURA_LIMITI\.mesiConservazione/.test(SORGENTE_ROUTE),
      'la route ribatte il numero invece di importarlo da `insegnanti-template`',
    ).toBe(true)
    expect(CANDIDATURA_LIMITI.mesiConservazione).toBe(24)
  })

  it('e il TESTO del consenso promette esattamente quel numero', () => {
    const consenso = CONSENSI_INSEGNANTI_FIELDS.find(
      (f) => f.id === 'consenso_conservazione_candidatura',
    )
    expect(consenso, 'l’id del consenso su cui la route si basa non esiste più').toBeTruthy()
    expect(consenso!.required, 'il consenso alla conservazione è facoltativo, o non è libero').toBe(
      false,
    )
    expect(consenso!.text).toContain(`${CANDIDATURA_LIMITI.mesiConservazione} mesi`)
  })

  it('l’id del consenso che la route cerca è quello che il modulo scrive', () => {
    const m = SORGENTE_ROUTE.match(/ID_CONSENSO_CONSERVAZIONE\s*=\s*'([^']+)'/)
    expect(m, '`ID_CONSENSO_CONSERVAZIONE` non si trova più nella route').not.toBeNull()
    expect(
      CONSENSI_INSEGNANTI_FIELDS.some((f) => f.id === m![1]),
      `la route cerca il consenso «${m?.[1]}», che nel modulo non esiste: cercherebbe per sempre ` +
        'un campo che non c’è, e ogni candidatura verrebbe cancellata a dodici mesi come se ' +
        'nessuno avesse mai acconsentito',
    ).toBe(true)
  })

  it('🔴 e l’INFORMATIVA dichiara gli stessi due termini, in lettere', () => {
    // Promettere dodici mesi in un posto e ventiquattro nell'altro è il difetto
    // che la riga sull'informativa esiste per impedire.
    const dal = INFORMATIVA.indexOf('Conservazione dei dati')
    const al = INFORMATIVA.indexOf('</section>', dal)
    const sezione = INFORMATIVA.slice(dal, al === -1 ? undefined : al).replace(/\s+/g, ' ')
    const voce = sezione
      .split('<li>')
      .slice(1)
      .map((v) => v.split('</li>')[0])
      .find((v) => /Lavora con noi|Candidature spontanee/i.test(v))
    expect(
      voce,
      'la sezione «Conservazione dei dati» non dice per quanto si conserva la candidatura di chi ' +
        'risponde a «Lavora con noi» — mentre il codice la cancella a scadenza, curriculum compreso',
    ).toBeTruthy()
    const mesiSenza = Number(SORGENTE_ROUTE.match(/MESI_SENZA_CONSENSO\s*=\s*(\d+)/)![1])
    const inLettere: Record<number, string> = { 12: 'dodici', 24: 'ventiquattro' }
    for (const mesi of [mesiSenza, CANDIDATURA_LIMITI.mesiConservazione]) {
      expect(
        new RegExp(`${mesi}\\s*mesi|${inLettere[mesi]}\\s*mesi`, 'i').test(voce!),
        `l’informativa non dichiara i ${mesi} mesi che il codice applica`,
      ).toBe(true)
    }
    expect(/curriculum/i.test(voce!), 'e non dice che il curriculum se ne va con la candidatura').toBe(
      true,
    )

    // ⚠️ CONTARE DUE PAROLE NON BASTA, ed è il difetto che questo blocco ripara.
    // Prima del 2026-08-10 questo test cercava «dodici mesi», «ventiquattro mesi»
    // e «curriculum»: restava verde su QUALUNQUE regola quelle parole
    // descrivessero — ed è rimasto verde mentre la route applicava 24 mesi da
    // `evasa_il` alla candidatura accolta senza consenso, cioè fino a ~24 mesi
    // oltre il termine qui dichiarato. Le due leve vanno nominate una per una.
    expect(
      /dalla ricezione/i.test(voce!),
      'l’informativa non dice DA QUANDO decorrono i dodici mesi: un termine senza decorrenza ' +
        'non è un termine dichiarato (art. 13 §2 lett. a)',
    ).toBe(true)
    expect(
      /dalla decisione se la candidatura non (è|e’|e) accolta/i.test(voce!),
      'l’informativa non dice che la decorrenza si sposta sulla DECISIONE soltanto quando la ' +
        'candidatura NON è accolta — che è la sola condizione per cui la route la sposta',
    ).toBe(true)
    expect(
      /consenso/i.test(voce!),
      'l’informativa non lega i ventiquattro mesi al CONSENSO: nel codice sono l’unica leva che ' +
        'allunga la durata, e nel testo del modulo sono l’unica cosa che la persona ha spuntato',
    ).toBe(true)

    /*
     * ── E I DUE NUMERI SONO SCRITTI IN DUE POSTI, DAL 2026-08-25 ───────────────
     *
     * «Natura del conferimento» dice ora, sul consenso facoltativo alla
     * conservazione, che il rifiuto «comporta soltanto la cancellazione della
     * candidatura dopo DODICI mesi anziché VENTIQUATTRO». Prima diceva «al più
     * breve dei termini indicati più avanti»: nessun numero, quindi niente da far
     * divergere — e niente da capire, per chi in quel momento sta decidendo se
     * spuntare la casella.
     *
     * Scritti i numeri, la copia va sorvegliata come l'originale. Senza queste
     * righe si potrebbe cambiare `CANDIDATURA_LIMITI.mesiConservazione` e vedere
     * rosso sulla voce di «Conservazione dei dati» mentre questo capoverso continua
     * a promettere il vecchio termine — cioè esattamente il difetto che il blocco
     * qui sopra esiste per impedire, spostato di trecento righe.
     *
     * Il capoverso si isola per SOGGETTO («Lavora con noi») dentro la sua sezione,
     * come la voce d'elenco qui sopra si isola dentro la sua.
     */
    const dalNatura = INFORMATIVA.indexOf('Natura del conferimento')
    const alNatura = INFORMATIVA.indexOf('</section>', dalNatura)
    const capoverso = INFORMATIVA.slice(dalNatura, alNatura === -1 ? undefined : alNatura)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // fuori i commenti JSX: là i numeri si citano
      .replace(/\s+/g, ' ')
      .split('<p ')
      .find((c) => /Lavora con noi/i.test(c))
    expect(
      capoverso,
      'la sezione «Natura del conferimento» non parla più del modulo «Lavora con noi»: senza ' +
        'quel capoverso l’art. 13 §2 lett. e non è coperto per il curriculum obbligatorio',
    ).toBeTruthy()
    for (const mesi of [mesiSenza, CANDIDATURA_LIMITI.mesiConservazione]) {
      expect(
        new RegExp(`${mesi}\\s*mesi|${inLettere[mesi]}`, 'i').test(capoverso!),
        `il capoverso «Lavora con noi» non dichiara i ${mesi} mesi che il codice applica: ` +
          'è la seconda copia dei due termini, e deve dire quello che dice la prima',
      ).toBe(true)
    }
  })

  it('🔴 e la route non allunga MAI il termine per uno stato: le due leve restano due', () => {
    // La costante importata dichiara di sé «candidatura NON accolta, SE
    // ACCONSENTITO». La prima stesura la usava per il caso opposto — accolta,
    // senza consenso — e ci spostava pure la decorrenza. Questo lock guarda la
    // SORGENTE perché il difetto è una condizione in più, non un numero: un test
    // di comportamento la coglie solo se qualcuno pensa a scrivere il caso.
    const scelta = SORGENTE_ROUTE.match(
      /const mesi\s*=([\s\S]*?)MESI_SENZA_CONSENSO/,
    )
    expect(scelta, 'la scelta dei mesi non si trova più nella route: aggiorna questo lock').not.toBeNull()
    expect(
      /stato\s*===/.test(scelta![1]),
      'la durata del termine dipende di nuovo dallo STATO della candidatura. Solo il consenso la ' +
        'allunga: lo dicono il testo del modulo («24 mesi anche se la valutazione dovesse avere ' +
        'esito negativo»), la docstring di `CANDIDATURA_LIMITI.mesiConservazione` («candidatura ' +
        'NON accolta, se acconsentito») e l’informativa. Se serve un termine proprio per la ' +
        'candidatura ACCOLTA, prima si dichiara in /privacy e poi lo si applica qui.',
    ).toBe(false)
    const stati = SORGENTE_ROUTE.match(/STATI_NON_ACCOLTE\s*=\s*new Set\(\[([^\]]*)\]\)/)
    expect(stati, '`STATI_NON_ACCOLTE` non si trova più nella route').not.toBeNull()
    expect(
      stati![1].replace(/['\s]/g, '').split(',').filter(Boolean),
      'gli stati che spostano la decorrenza sulla decisione non sono più il solo rifiuto: ' +
        'l’informativa promette la decorrenza dalla RICEZIONE per ogni altro caso',
    ).toEqual(['rifiutata'])
  })

  it('il lavoro è SORVEGLIATO: se smette di girare, /api/health se ne accorge', async () => {
    const { JOB_CRON } = await import('@/lib/health/controlli')
    const m = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)
    expect(m, '`JOB` non si trova più nella route').not.toBeNull()
    const voce = JOB_CRON.find((j) => j.nome === m![1])
    expect(
      voce,
      `\`${m?.[1]}\` non è in \`JOB_CRON\`: non comparirebbe né fra i job vivi né fra i muti di ` +
        '/api/health, cioè sarebbe invisibile — e una promessa mantenuta da un lavoro che nessuno ' +
        'guarda è una promessa a scadenza.',
    ).toBeTruthy()
    expect(voce!.finestraMs).toBeGreaterThan(24 * 60 * 60 * 1000)
  })

  it('🔴 e l’AUTOMA esiste davvero: `cron.schedule` in una migrazione, GIORNALIERO', () => {
    // IL DIFETTO CHE QUESTO TEST CHIUDE, ed è quello che rendeva tutto il resto
    // una scenografia: fino al 2026-08-10 la voce in `JOB_CRON` e la voce
    // nell'informativa esistevano, e il `cron.schedule` no. Nessuno chiamava
    // questa route: era codice morto, mentre /privacy dichiarava pubblicamente
    // un termine che nessuno applicava — «il documento che descrive una
    // protezione che non c'è» di CLAUDE.md, su dati di persone adulte.
    //
    // In più la voce in `JOB_CRON` mandava /api/health in `degradato` DAL PRIMO
    // DEPLOY: `controlloBattitoCron` considera muto anche il job con
    // `t === undefined`, cioè quello che non ha MAI battuto. Un allarme che suona
    // da solo viene spento, e allora non protegge più niente.
    const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const file = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    const forma = new RegExp(`cron\\.schedule\\(\\s*'${nome}'\\s*,\\s*'([^']+)'`)
    const trovate = file
      .map((f) => ({ f, m: readFileSync(join(dir, f), 'utf8').match(forma) }))
      .filter((x) => x.m)
    expect(
      trovate.length,
      `In supabase/migrations/ non c'è nessun \`cron.schedule('${nome}', …)\`. Questa route non ` +
        `la chiama nessuno: è codice morto, mentre /privacy dichiara un termine di conservazione ` +
        `e \`JOB_CRON\` fa dire a /api/health «job senza battito: ${nome}» per sempre, dal primo ` +
        `deploy. Le due strade, e nessuna terza: (a) scrivere e APPLICARE la migrazione; ` +
        `(b) togliere INSIEME la voce da JOB_CRON e la voce dall'informativa.`,
    ).toBeGreaterThan(0)
    for (const { f, m } of trovate) {
      const giorno = m![1].split(/\s+/)[2]
      expect(
        giorno,
        `\`${nome}\` è schedulato «${m![1]}» in ${f}, e non è giornaliero. Un lavoro MENSILE non è ` +
          `sorvegliabile da \`JOB_CRON\`: \`app_log\` conserva 30 giorni e la finestra necessaria ` +
          `ne vorrebbe ~32 — è la ragione per cui il gemello \`iscrizioni-retention\` sta in ` +
          `\`JOB_CRON_NON_SORVEGLIATI\` invece che in \`JOB_CRON\`.`,
      ).toBe('*')
    }
  })

  it('🔴 … e la migrazione che lo installa è APPLICATA, non solo scritta', () => {
    // Un file SQL non schedula niente. La distinzione fra «esiste il file» ed
    // «esiste il job nel database» è la stessa che `informativa-conservazione-
    // dichiarata.test.ts` fa per gli altri automi, e per lo stesso motivo: una
    // promessa di conservazione mantenuta da un file mai applicato è una
    // dichiarazione non veritiera (art. 13 §2 lett. a).
    const nome = SORGENTE_ROUTE.match(/const JOB = '([^']+)'/)![1]
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const file = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    const forma = new RegExp(`cron\\.schedule\\(\\s*'${nome}'`)
    const installa = file.filter((f) => forma.test(readFileSync(join(dir, f), 'utf8')))
    for (const f of installa) {
      const sql = readFileSync(join(dir, f), 'utf8')
      expect(
        /NON\s+APPLICATA/i.test(sql),
        `${f} installa \`${nome}\` ed è marcata «NON APPLICATA». Finché non è applicata al ` +
          `database, l'informativa dichiara un termine che nessuno fa scadere.`,
      ).toBe(false)
      expect(
        /APPLICATA il \d{4}-\d{2}-\d{2}/.test(sql),
        `${f} installa \`${nome}\` e non attesta in testata quando è stata applicata. ` +
          `«L'ho applicata» detto a voce non si rilegge fra sei mesi: si scrive nel file.`,
      ).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA CONSERVAZIONE SI CALCOLA PER RIGA DI SEDE, E VINCE LA PIÙ LONTANA.
//
// `candidature_insegnanti.evasa_il` è UNA colonna e porta il termine di PIÙ
// trattamenti: una candidatura rivolta a tre plessi porta tre decisioni. Il
// trigger ci scrive `max()`, ma l'aggregato `stato` è un'altra cosa ancora, e
// nel caso MISTO le due cose insieme sbagliano.
//
// Aversa rifiuta a novembre, Giugliano approva a dicembre, la candidatura è
// arrivata a gennaio. L'aggregato vale `approvata` → il termine decorre dalla
// RICEZIONE → si cancella a gennaio, cioè due mesi dopo il rifiuto di Aversa
// invece dei dodici promessi. Il verbale sparisce prima del dovuto: è la stessa
// classe di difetto che la migrazione `20260820004500` ha chiuso altrove.
//
// ⚠️ Nei casi NON misti non cambia niente, ed è la prova che questa non è una
// riscrittura: tutte rifiutate → l'ultima decisione, identico a `max(evasa_il)`;
// tutte approvate o mai valutate → la ricezione, identico a prima.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — il termine per RIGA DI SEDE', () => {
  /** Le righe di sede di una candidatura, come le consegna l'embed. */
  const sedi = (...righe: { stato: string; evasa_il?: string | null }[]) =>
    righe.map((r) => ({ stato: r.stato, evasa_il: r.evasa_il ?? null }))

  it('🔴 il caso MISTO conserva fino a dodici mesi dall’ULTIMA decisione', async () => {
    // Ricevuta 13 mesi fa; Aversa ha rifiutato UN MESE FA. Con la regola vecchia
    // l'aggregato `approvata` faceva decorrere il termine dalla ricezione e la
    // candidatura sarebbe uscita oggi, portandosi via il verbale di Aversa.
    h.righe = [
      candidatura('mista', {
        stato: 'approvata',
        creata_il: meseFa(13),
        evasa_il: meseFa(1),
        candidature_sedi: sedi(
          { stato: 'approvata', evasa_il: meseFa(1) },
          { stato: 'rifiutata', evasa_il: meseFa(1) },
        ),
      }),
    ]
    await chiama()
    expect(idsCancellati(), 'il rifiuto di un mese fa va conservato ancora undici mesi').toEqual([])
  })

  it('…e quando anche l’ULTIMA decisione ha più di dodici mesi, si cancella', async () => {
    h.righe = [
      candidatura('mista-vecchia', {
        stato: 'approvata',
        creata_il: meseFa(30),
        evasa_il: meseFa(14),
        candidature_sedi: sedi(
          { stato: 'approvata', evasa_il: meseFa(14) },
          { stato: 'rifiutata', evasa_il: meseFa(14) },
        ),
      }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual(['mista-vecchia'])
  })

  it('TUTTE RIFIUTATE: vale l’ultima decisione, come prima — non è una riscrittura', async () => {
    h.righe = [
      candidatura('respinte-fresche', {
        stato: 'rifiutata', creata_il: meseFa(20), evasa_il: meseFa(3),
        candidature_sedi: sedi(
          { stato: 'rifiutata', evasa_il: meseFa(11) },
          { stato: 'rifiutata', evasa_il: meseFa(3) },
        ),
      }),
      candidatura('respinte-vecchie', {
        stato: 'rifiutata', creata_il: meseFa(30), evasa_il: meseFa(14),
        candidature_sedi: sedi(
          { stato: 'rifiutata', evasa_il: meseFa(20) },
          { stato: 'rifiutata', evasa_il: meseFa(14) },
        ),
      }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual(['respinte-vecchie'])
  })

  it('TUTTE APPROVATE o mai valutate: vale la ricezione, come prima', async () => {
    h.righe = [
      candidatura('accolte-fresche', {
        stato: 'approvata', creata_il: meseFa(6), evasa_il: meseFa(1),
        candidature_sedi: sedi({ stato: 'approvata', evasa_il: meseFa(1) }),
      }),
      candidatura('accolte-vecchie', {
        stato: 'approvata', creata_il: meseFa(14), evasa_il: meseFa(2),
        candidature_sedi: sedi({ stato: 'approvata', evasa_il: meseFa(2) }),
      }),
      candidatura('mai-valutata', {
        stato: 'pending', creata_il: meseFa(14),
        candidature_sedi: sedi({ stato: 'pending' }),
      }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual(['accolte-vecchie', 'mai-valutata'])
  })

  it('🔴 una riga di sede con una data ILLEGGIBILE non autorizza a cancellare', async () => {
    // Stessa dottrina del caso a sede singola: su un'operazione irreversibile un
    // dato che non si sa leggere vale «non toccare», non «via libera».
    h.righe = [
      candidatura('data-rotta', {
        stato: 'rifiutata', creata_il: 'non-una-data', evasa_il: meseFa(30),
        candidature_sedi: sedi({ stato: 'pending' }),
      }),
    ]
    await chiama()
    expect(idsCancellati()).toEqual([])
  })

  it('la lettura CHIEDE le righe di sede', async () => {
    h.righe = [candidatura('c1', { creata_il: meseFa(14) })]
    await chiama()
    expect(
      h.select.join(' | '),
      'senza l’embed il termine torna a essere quello di una colonna sola',
    ).toContain('candidature_sedi(')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/gdpr/retention-candidature — senza `candidature_sedi` (CI non migrata)', () => {
  it('degrada alla regola della colonna, LO DICE, e non salta la spazzata', async () => {
    // Una conservazione che non gira è peggio di una conservazione approssimata:
    // il silenzio qui significa curriculum di persone adulte che restano
    // nell'archivio oltre il termine promesso, e nessuno che lo sappia.
    h.letture = [
      { data: null, error: { code: 'PGRST200', message: "Could not find a relationship between 'candidature_insegnanti' and 'candidature_sedi'" } },
      { data: [candidatura('c1', { stato: 'rifiutata', creata_il: meseFa(30), evasa_il: meseFa(14) })], error: null },
    ]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(idsCancellati()).toEqual(['c1'])
    const avviso = h.eventi.find((e) => e.campi.esito === 'sedi-non-leggibili')
    expect(avviso, 'il ripiego non è stato dichiarato').toBeTruthy()
    expect(avviso!.livello).toBe('warn')
    expect(avviso!.campi.error_code).toBe('PGRST200')
  })

  it('la seconda lettura NON chiede più l’embed', async () => {
    h.letture = [
      { data: null, error: { code: 'PGRST200', message: 'Could not find a relationship' } },
      { data: [], error: null },
    ]
    await chiama()
    expect(h.select).toHaveLength(2)
    expect(h.select[0]).toContain('candidature_sedi(')
    expect(h.select[1], 'ha ritentato con lo stesso embed che l’ha appena fatta fallire')
      .not.toContain('candidature_sedi(')
  })

  it('un guasto che NON riguarda le sedi non fa perdere l’embed né tace', async () => {
    // Il controllo negativo: se qualunque errore facesse cadere l'embed, il
    // ripiego diventerebbe la strada normale e nessuno lo saprebbe.
    h.erroreLettura = { code: '08006', message: 'connection failure' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(h.eventi.some((e) => e.campi.esito === 'sedi-non-leggibili')).toBe(false)
  })
})
