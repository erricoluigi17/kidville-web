import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
// Il redattore VERO, non il finto: le righe di log di questa route si verificano
// dopo di lui, perché è lui a decidere che cosa arriva davvero in `app_log`.
import { redact } from '@/lib/logging/redact'
import type { DBFinto } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'

// =============================================================================
// `GET /api/primaria/compiti` — l'elenco dei compiti per casa di una classe.
//
// ─── PERCHÉ IL FINTO CLIENT È QUELLO CHE PROIETTA ────────────────────────────
//
// `finto-supabase` dichiara di non emulare la proiezione di `select()`: le righe
// tornano INTERE. Con quello, l'asserzione che conta di più di questo file —
// «nessun uuid di alunno e nessun nome compare nella risposta» — sarebbe verde
// anche dopo aver messo i destinatari nel corpo, perché il fixture porta comunque
// i campi. `creaFintoSupabaseConProiezione` proietta come PostgREST: ciò che la
// route non ha chiesto non arriva, e ciò che ha chiesto arriva solo se lo mette
// in risposta.
//
// ⚠️ Il finto client LANCIA su `storage.from(...)`: qui `client.storage` è
// sostituito da un finto Storage che REGISTRA bucket, percorsi e TTL, così «ha
// firmato» è una proprietà verificata e non una speranza.
//
// ─── LA CONTROPROVA ──────────────────────────────────────────────────────────
//
// Ogni caso di questo file è stato visto ROSSO rompendo la route di proposito:
// togliendo `.eq('scuola_id', …)`, facendo uscire `alunno_id` dentro
// `individualizzati`, togliendo il filtro sulle righe senza compiti e
// restituendo il percorso grezzo al posto del `null` della firma fallita.
//
// ⚠️ 2026-09-19 — SETTE DI QUESTI CASI NON MISURAVANO NIENTE, e sono stati
// rifatti dopo che il codice è stato rotto in undici modi e la suite è rimasta
// verde in sette. Il pezzo che manca alla frase qui sopra è che la controprova
// va rifatta *su ogni caso*, non sulla route nel suo insieme: un file di test
// che diventa rosso quando si rompe UNA cosa non dimostra niente sulle altre
// dieci. I sette buchi erano: il gate prima del client (si guardava `h.tabelle`,
// dove `createAdminClient` non scrive niente), il `.trim()` sui compiti, il
// fallback `materie(nome) ?? materia`, `destinatari: 0`, gli URL storici
// completi, `oggiFiscaleISO()` (uguale a UTC 22 ore su 24) e il filtro
// `.eq('id', …)` sulla seconda lettura di `sections`.
//
// ─── LA PAGINAZIONE (2026-09-19) ─────────────────────────────────────────────
//
// `troncato` è stato sostituito da `prossimoCursore`, e con lui è cambiata la cosa
// che questo file deve difendere: non più «la risposta dichiara di essere
// incompleta», ma **`prossimoCursore: null` non esce mai mentre ci sono compiti
// più vecchi da leggere**. È l'unica promessa del contratto, e i casi marcati 🔴
// sono quelli che la tengono in piedi.
//
// La controprova è stata rifatta su TRE FAMIGLIE di difetto, non su una:
//  · il KEYSET — tolto lo spareggio sull'`id` (1 rosso), poi ridotto il keyset alla
//    sola `data` (2 rossi: il gemello sul confine e le ore rimaste della giornata);
//  · la CONDIZIONE DI FINE — «non ho trovato compiti» scambiato per «non c'è altro»,
//    cioè il cursore azzerato quando la pagina esce vuota (7 rossi, fra cui il caso
//    🔴 della perdita silenziosa);
//  · il FILTRO POST-LETTURA — il `.trim()` e il ramo `compiti_propri` tolti da
//    `haCompiti` (6 rossi).
//
// ─── IL CURSORE COME INGRESSO, E LA RIGA DI LOG VERA (2026-09-19, secondo giro) ─
//
// Due cose di questo file erano scritte e non provate — lo stesso difetto di
// sopra, ripetuto in piccolo:
//  · `zCursore` si dichiara «UN PRESIDIO DI SICUREZZA» perché i suoi tre valori
//    finiscono dentro la stringa di `.or()`, e NESSUNO dei 57 casi lo verificava:
//    con `i: z.string()` la suite restava verde, 57 su 57. Il blocco «il cursore
//    non entra come sintassi nella stringa di `.or()`» è la prova che mancava, e
//    la controprova è stata rifatta CAMPO PER CAMPO: `i` senza alfabeto → 7 rossi,
//    `d` senza regex → 3, `o` senza `.int()` → 2, `v` senza `literal` → 2, `s`
//    senza `zUuid` → 1.
//    Quell'ultimo «1» è costato un caso riscritto: `s` fuori forma dà 400 anche
//    senza `zUuid` (una stringa che uuid non è non può mai essere uguale al
//    `sectionId`), quindi asserire lo STATO non misurava lo schema. Si asserisce
//    la CAUSA, che è la cosa che cambia davvero.
//  · la riga di log si verifica ora DIETRO `redact()` e non sugli argomenti di
//    `logEvento`: la causa stava su `motivo`, che è una radice di testo libero, e
//    in `app_log` arrivava `[redatto:str/13]`. Il test era verde su una frase
//    falsa — «il motivo resta nel LOG» — perché misurava ciò che la route ha
//    DETTO, non ciò che il database riceve.
// =============================================================================

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRA_SEDE = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SEZIONE = 'cccccccc-0000-4000-8000-00000000000c'
const ALTRA_SEZIONE = 'cccccccc-0000-4000-8000-00000000000f'
const DOCENTE = 'dddddddd-0000-4000-8000-00000000000d'

/**
 * Gli uuid dei bambini: non devono comparire in nessun punto della risposta.
 * Sono inventati — il repository è pubblico e in produzione ci sono minori veri.
 */
const ALUNNO_1 = 'e1e1e1e1-0000-4000-8000-000000000001'
const ALUNNO_2 = 'e2e2e2e2-0000-4000-8000-000000000002'

const BUCKET = 'registro-allegati'
const TTL_ATTESO = 600

/**
 * La DIMENSIONE DI PAGINA della route (`RIGHE_PER_PAGINA` in
 * `src/app/api/primaria/compiti/route.ts`) e quante letture può fare una sola
 * risposta (`GIRI_MAX_PER_PAGINA`).
 *
 * Sono RIBATTUTI e non importati perché un `route.ts` dell'App Router esporta i
 * metodi HTTP e poco altro: esportare una costante da lì è il genere di cosa che
 * il build di Next può rifiutare. Se i numeri della route cambiano, queste righe
 * vanno cambiate con loro — ed è il punto, non un fastidio: la dimensione di
 * pagina è un patto col client (decide quante volte dovrà richiamare), non un
 * dettaglio interno che si muove di nascosto.
 */
const PAGINA_ATTESA = 300
const GIRI_ATTESI = 4

/**
 * Il tetto di PostgREST, LETTO da `supabase/config.toml` invece che ribattuto: è
 * il posto dove vive davvero, e un numero copiato qui resterebbe indietro proprio
 * il giorno in cui contasse. `null` se la riga sparisce — e il caso che lo usa
 * diventa rosso invece di passare su un `undefined`.
 */
const MAX_ROWS = (() => {
  const testo = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8')
  const m = /^\s*max_rows\s*=\s*(\d+)/m.exec(testo)
  return m ? Number(m[1]) : null
})()

/**
 * L'AMPIEZZA MASSIMA DELLA FINESTRA — `GIORNI_MAX_INTERVALLO`, tornato a 365 il
 * 2026-09-19 insieme alla paginazione.
 *
 * ⚠️ NON È PIÙ CALCOLATO dal tetto delle righe, e il caso che lo verificava è
 * stato tolto invece di essere adattato: il ragionamento che legava i due numeri
 * («la finestra più larga è quella che una lettura sola sa leggere per intero»)
 * era valido finché la finestra doveva stare in UNA lettura. Adesso il limite
 * delle righe lo risolve il cursore, e questo numero fa un mestiere diverso —
 * dire di no a un intervallo che nessuno chiede sul serio. Tenere in piedi quel
 * caso con numeri nuovi avrebbe conservato la forma di una prova che non prova
 * più niente.
 */
const FINESTRA_ATTESA = 365

/** Le ore di lezione di un giorno nel CASO PEGGIORE misurato in produzione il
 *  2026-09-19: `max(ore) = 5` per coppia classe/giorno in `registro_orario`, e
 *  `max = 5` nella griglia di `orario_settimanale`. Serve a costruire fixture che
 *  somigliano a un registro vero, non a far tornare un conto. */
const ORE_PEGGIORI_AL_GIORNO = 5

/** Il percorso come lo archivia `primaria/allegati:POST`. Mai un indirizzo. */
const PERCORSO_FOTO = 'registro/11111111-2222-4333-8444-555555555555/1757000000000-ab12cd3.jpg'

/**
 * Una riga STORICA: `file_url` è l'indirizzo pubblico completo, di quando il
 * contenitore era `public: true`. `percorsoNelBucket` deve ricavarne il percorso.
 */
const PERCORSO_STORICO = 'registro/99999999-8888-4777-8666-555555555555/1699000000000-zz99xy1.pdf'
const URL_PUBBLICO_STORICO =
  `https://progetto.supabase.co/storage/v1/object/public/${BUCKET}/${PERCORSO_STORICO}`

type RispostaFirma = {
  data: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> | null
  error: unknown
}

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertSezioneInScope: vi.fn(),
  logEvento: vi.fn(),
  /**
   * La spia su `createAdminClient`. Esiste perché `h.tabelle` NON la sostituisce:
   * creare il client service-role non legge nessuna tabella, quindi un
   * `createAdminClient()` spostato PRIMA del gate lasciava `tabelle` vuoto e la
   * suite verde. È l'unico modo di provare che dopo un 403 il client non nasce.
   */
  creaClient: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
  proiezioni: [] as Proiezione[],
  /** Ogni chiamata a `createSignedUrls`: bucket, percorsi e TTL richiesti. */
  firme: [] as Array<{ bucket: string; percorsi: string[]; ttl: number }>,
  /** `null` = risposta felice costruita sui percorsi ricevuti. */
  risposta: null as RispostaFirma | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: (...a: unknown[]) => h.assertSezioneInScope(...a) }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  return {
    createAdminClient: async () => {
      h.creaClient()
      const client = creaFintoSupabaseConProiezione(
        h.db, h.tabelle, { errori: h.errori }, h.proiezioni,
      ) as unknown as { storage: unknown }
      client.storage = {
        from: (bucket: string) => ({
          createSignedUrls: async (percorsi: string[], ttl: number) => {
            h.firme.push({ bucket, percorsi, ttl })
            if (h.risposta) return h.risposta
            return {
              data: percorsi.map((p) => ({
                path: p,
                signedUrl: `https://finto.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=finto`,
                error: null,
              })),
              error: null,
            }
          },
        }),
      }
      return client
    },
  }
})

import { GET } from '@/app/api/primaria/compiti/route'

const req = (qs = `sectionId=${SEZIONE}`) =>
  new NextRequest(`http://localhost/api/primaria/compiti?${qs}`)

/** Oggi nel fuso italiano: la finestra predefinita parte da 30 giorni fa. */
const OGGI = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
const IERI = new Date(Date.parse(`${OGGI}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

/** N giorni di CALENDARIO prima di una data 'YYYY-MM-DD' (aritmetica, niente fusi). */
const menoGiorni = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

const firmato = (percorso: string) =>
  `https://finto.supabase.co/storage/v1/object/sign/${BUCKET}/${percorso}?token=finto`

/**
 * Le righe del registro. Il fixture NON costruisce i join dalla stringa di
 * select: gli oggetti annidati li mette qui, com'è documentato in
 * `finto-supabase`.
 */
const righeBase = () => [
  {
    // Ora con il compito di CLASSE, la materia d'anagrafica e un allegato.
    id: 'reg-1',
    section_id: SEZIONE,
    scuola_id: SEDE,
    data: OGGI,
    ora_lezione: 2,
    materia: 'matematica (testo storico)',
    argomento: 'Le frazioni',
    compiti: 'Esercizi 3 e 4 di pagina 88',
    data_consegna_compiti: '2026-09-22',
    materie: { nome: 'Matematica' },
    firme_docenti: [{ id: 'firma-1', compiti_propri: null }],
    registro_destinatari: [],
    allegati_registro: [
      { id: 'all-1', tipo: 'immagine', ambito: 'argomento', file_url: PERCORSO_FOTO, file_name: 'lavagna.jpg' },
    ],
  },
  {
    // Ora SENZA compiti di classe ma con un'assegnazione MIRATA a due bambini.
    id: 'reg-2',
    section_id: SEZIONE,
    scuola_id: SEDE,
    data: IERI,
    ora_lezione: 1,
    materia: null,
    argomento: 'Lettura',
    compiti: '   ',
    data_consegna_compiti: null,
    materie: { nome: 'Italiano' },
    firme_docenti: [
      { id: 'firma-2', compiti_propri: 'Scheda facilitata A' },
      { id: 'firma-3', compiti_propri: null },
    ],
    registro_destinatari: [
      { firma_id: 'firma-2', alunno_id: ALUNNO_1 },
      { firma_id: 'firma-2', alunno_id: ALUNNO_2 },
    ],
    allegati_registro: [],
  },
  {
    // Ora con il SOLO argomento: non è un compito e non deve comparire.
    id: 'reg-3',
    section_id: SEZIONE,
    scuola_id: SEDE,
    data: IERI,
    ora_lezione: 3,
    materia: null,
    argomento: 'Ripasso in classe',
    compiti: null,
    data_consegna_compiti: null,
    materie: { nome: 'Storia' },
    firme_docenti: [{ id: 'firma-4', compiti_propri: '' }],
    registro_destinatari: [],
    allegati_registro: [],
  },
  {
    // SOLI SPAZI e NESSUN individualizzato: è la riga che smaschera il `.trim()`.
    // `reg-2` non bastava — ha `compiti: '   '` ma esce lo stesso grazie a
    // `compiti_propri`, quindi togliendo il `.trim()` restava dentro comunque e
    // nessuna asserzione cambiava colore.
    id: 'reg-solo-spazi',
    section_id: SEZIONE,
    scuola_id: SEDE,
    data: IERI,
    ora_lezione: 4,
    materia: null,
    argomento: 'Ora di compresenza',
    compiti: '   ',
    data_consegna_compiti: null,
    materie: { nome: 'Musica' },
    firme_docenti: [{ id: 'firma-5', compiti_propri: null }],
    registro_destinatari: [],
    allegati_registro: [],
  },
  {
    // Stessa CLASSE, altra SEDE: la riga impossibile che smaschera il filtro
    // mancante. Senza `.eq('scuola_id', …)` entrerebbe nell'elenco.
    id: 'reg-altra-sede',
    section_id: SEZIONE,
    scuola_id: ALTRA_SEDE,
    data: OGGI,
    ora_lezione: 4,
    materia: null,
    argomento: 'Lezione di un altro plesso',
    compiti: 'Compiti di un altro plesso',
    data_consegna_compiti: null,
    materie: { nome: 'Inglese' },
    firme_docenti: [],
    registro_destinatari: [],
    allegati_registro: [],
  },
]

const dbBase = (): DBFinto => ({
  sections: [
    // ⚠️ LA CIVETTA, E STA PRIMA APPOSTA. La seconda lettura di `sections` è per
    // `id`, e `maybeSingle()` restituisce la PRIMA riga che passa i filtri: senza
    // `.eq('id', sectionId)` la sede della query diventerebbe questa, e tutta la
    // vista si sposterebbe su un altro plesso con un 200 in faccia. Finché questa
    // riga è la prima, quel filtro non può sparire in silenzio.
    { id: ALTRA_SEZIONE, scuola_id: ALTRA_SEDE, school_type: 'primaria' },
    { id: SEZIONE, scuola_id: SEDE, school_type: 'primaria' },
  ],
  registro_orario: righeBase(),
})

type Allegato = {
  id: string
  tipo: string | null
  ambito: string | null
  file_name: string | null
  file_url: string | null
}

type Compito = {
  id: string
  data: string
  ora_lezione: number
  materia: string | null
  compiti: string | null
  data_consegna_compiti: string | null
  allegati: Allegato[]
  individualizzati: Array<{ compiti: string; destinatari: number }>
}

type Payload = { compiti: Compito[]; prossimoCursore: string | null }

async function corpoOk(qs?: string): Promise<Payload> {
  const res = await GET(req(qs))
  expect(res.status).toBe(200)
  const corpo = (await res.json()) as { success: boolean; data: Payload }
  expect(corpo.success).toBe(true)
  return corpo.data
}

async function elenco(qs?: string): Promise<Compito[]> {
  return (await corpoOk(qs)).compiti
}

/** Le righe del registro, come array modificabile. */
const registro = () => h.db.registro_orario as Record<string, unknown>[]

// ─── GLI ATTREZZI DELLA PAGINAZIONE ──────────────────────────────────────────

/**
 * Un registro FITTO: `giorni` giornate consecutive all'indietro da oggi, `ore`
 * ore ciascuna, e un predicato che decide quali ore portano un compito.
 *
 * Gli `id` sono zeropaddati apposta: il keyset della route ha `id` come terzo
 * criterio d'ordine, e con `reg-9` / `reg-10` l'ordine lessicale del finto client
 * (e di PostgREST, che confronta testo) non sarebbe quello numerico. Un fixture
 * che ordina in un modo mentre il codice ne presume un altro fa fallire il test
 * per una ragione che non c'entra con la route.
 */
function registroFitto(
  giorni: number,
  haCompiti: (giorno: number, ora: number) => boolean,
  ore = ORE_PEGGIORI_AL_GIORNO,
): Record<string, unknown>[] {
  const righe: Record<string, unknown>[] = []
  for (let g = 0; g < giorni; g++) {
    const iso = menoGiorni(OGGI, g)
    for (let ora = 1; ora <= ore; ora++) {
      righe.push({
        id: `reg-${String(g).padStart(4, '0')}-${ora}`,
        section_id: SEZIONE, scuola_id: SEDE, data: iso, ora_lezione: ora,
        materia: null, argomento: `Lezione ${g}/${ora}`,
        compiti: haCompiti(g, ora) ? `Compito ${g}/${ora}` : null,
        data_consegna_compiti: null, materie: null,
        firme_docenti: [], registro_destinatari: [], allegati_registro: [],
      })
    }
  }
  return righe
}

/** Gli id delle righe del fixture che DEVONO uscire, nell'ordine della route. */
function attesiDalFixture(): string[] {
  return registro()
    .filter((r) => String(r.compiti ?? '').trim() !== '')
    .sort((a, b) =>
      String(b.data).localeCompare(String(a.data)) ||
      Number(a.ora_lezione) - Number(b.ora_lezione) ||
      String(a.id).localeCompare(String(b.id)),
    )
    .map((r) => String(r.id))
}

/**
 * Percorre TUTTE le pagine finché `prossimoCursore` non è `null`.
 *
 * ⚠️ Il tetto di giri non è prudenza: è l'asserzione che un cursore che non
 * avanza — il difetto peggiore di una paginazione, perché il client cicla per
 * sempre e la pagina non finisce mai di caricare — diventi un test rosso invece
 * di un test che non finisce.
 */
async function tutteLePagine(qsBase: string, maxPagine = 12): Promise<Payload[]> {
  const pagine: Payload[] = []
  let cursore: string | null = null
  for (let i = 0; i < maxPagine; i++) {
    const pagina = await corpoOk(cursore ? `${qsBase}&cursore=${encodeURIComponent(cursore)}` : qsBase)
    pagine.push(pagina)
    if (pagina.prossimoCursore === null) return pagine
    expect(pagina.prossimoCursore, 'il cursore non avanza: il client ciclerebbe per sempre')
      .not.toBe(cursore)
    cursore = pagina.prossimoCursore
  }
  throw new Error(`la paginazione non è finita in ${maxPagine} pagine: cursore che non avanza?`)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.proiezioni = []
  h.firme = []
  h.risposta = null
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE }, response: null })
  h.assertSezioneInScope.mockResolvedValue(null)
})

afterEach(() => {
  // Un solo caso usa l'orologio falso; se restasse acceso contagerebbe i
  // successivi, che calcolano la finestra predefinita sull'oggi vero.
  vi.useRealTimers()
})

describe('GET /api/primaria/compiti — la forma del contratto', () => {
  it('200 con i campi esatti, materia dall’anagrafica e scadenza dei compiti', async () => {
    const { compiti, prossimoCursore } = await corpoOk()

    expect(compiti.map((c) => c.id)).toEqual(['reg-1', 'reg-2'])
    expect(Object.keys(compiti[0]).sort()).toEqual([
      'allegati', 'compiti', 'data', 'data_consegna_compiti', 'id', 'individualizzati', 'materia', 'ora_lezione',
    ])
    expect(compiti[0]).toMatchObject({
      data: OGGI,
      ora_lezione: 2,
      // `materie(nome)` vince sul testo storico della riga.
      materia: 'Matematica',
      compiti: 'Esercizi 3 e 4 di pagina 88',
      data_consegna_compiti: '2026-09-22',
    })
    // Il controllo NEGATIVO della paginazione: cinque righe stanno in una pagina,
    // quindi non c'è un seguito da chiedere. Senza questa riga i casi che
    // pretendono un cursore sarebbero verdi anche con un cursore cablato che esce
    // sempre.
    expect(prossimoCursore).toBeNull()
  })

  it('l’ordine è data DISCENDENTE, poi ora crescente', async () => {
    // Una seconda ora nello stesso giorno del primo compito, con ora minore.
    registro().push({
      id: 'reg-0', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 1,
      materia: null, argomento: null, compiti: 'Ripassare le tabelline', data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })
    const compiti = await elenco()
    expect(compiti.map((c) => [c.data, c.ora_lezione])).toEqual([
      [OGGI, 1], [OGGI, 2], [IERI, 1],
    ])
  })

  it('una riga con il solo ARGOMENTO non compare: non è un compito', async () => {
    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).not.toContain('reg-3')
  })

  it('SOLI SPAZI non sono un compito: la riga senza individualizzati resta fuori', async () => {
    // Il caso che copre il `.trim()`. Va tenuto separato da `reg-2` (spazi + un
    // `compiti_propri`), che esce comunque e quindi non dimostra niente.
    const inFixture = registro().find((r) => r.id === 'reg-solo-spazi')
    expect(inFixture, 'la riga di soli spazi è sparita dal fixture: il caso non misura più niente').toBeTruthy()
    expect(inFixture?.compiti).toBe('   ')

    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).not.toContain('reg-solo-spazi')
  })

  it('senza compiti di classe ma con `compiti_propri` la riga COMPARE, col conteggio giusto', async () => {
    const compiti = await elenco()
    const mirata = compiti.find((c) => c.id === 'reg-2')!
    expect(mirata.compiti).toBe('   ')
    // Una sola voce: la firma con `compiti_propri: null` non è un'assegnazione.
    expect(mirata.individualizzati).toEqual([{ compiti: 'Scheda facilitata A', destinatari: 2 }])
  })

  it('un individualizzato SENZA destinatari esce con `destinatari: 0`, non sparisce', async () => {
    // È una firma con i compiti propri scritti e nessuna riga in
    // `registro_destinatari` — succede quando l'insegnante scrive il compito e
    // non ha ancora spuntato i bambini. Il testo c'è e va mostrato: uno zero è
    // un'informazione, l'assenza della voce sarebbe una bugia.
    registro().push({
      id: 'reg-zero-destinatari', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 6,
      materia: null, argomento: null, compiti: null, data_consegna_compiti: null,
      materie: { nome: 'Arte' },
      firme_docenti: [{ id: 'firma-9', compiti_propri: 'Disegno libero' }],
      registro_destinatari: [], allegati_registro: [],
    })
    const compiti = await elenco()
    const riga = compiti.find((c) => c.id === 'reg-zero-destinatari')!
    expect(riga.individualizzati).toEqual([{ compiti: 'Disegno libero', destinatari: 0 }])
  })

  it('senza `materie(nome)` la materia è quella STORICA scritta nella riga', async () => {
    // Il ramo `?? r.materia` del fallback: sulle righe più vecchie `materia_id`
    // non c'era e il nome era testo libero. Senza un caso così, il `??` poteva
    // sparire con la suite verde.
    registro().push({
      id: 'reg-materia-storica', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 7,
      materia: 'ed. motoria (testo storico)', argomento: null,
      compiti: 'Portare la tuta', data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })
    const compiti = await elenco()
    expect(compiti.find((c) => c.id === 'reg-materia-storica')!.materia).toBe('ed. motoria (testo storico)')
    // …e il controllo positivo accanto: dove l'anagrafica c'è, vince lei.
    expect(compiti.find((c) => c.id === 'reg-1')!.materia).toBe('Matematica')
  })

  it('una materia d’anagrafica VUOTA non vince sul testo storico: `""` non è un nome', async () => {
    // `materie.nome` è NOT NULL ma senza CHECK (verificato in produzione il
    // 2026-09-19): la stringa vuota è un valore permesso, e con `??` (nullish)
    // vinceva sul testo storico della riga. La materia usciva come `""` — una
    // materia senza nome, dove il nome c'era. Il file aveva già `pieno()` per
    // questa distinzione e lo applicava ai compiti quaranta righe più in là.
    registro().push({
      id: 'reg-materia-vuota', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 6,
      materia: 'ed. motoria (storico)', argomento: null,
      compiti: 'Portare la tuta', data_consegna_compiti: null,
      materie: { nome: '' }, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })
    // …e una riga in cui non c'è NIENTE dei due resta `null`, non `''`.
    registro().push({
      id: 'reg-materia-niente', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 7,
      materia: '   ', argomento: null, compiti: 'Compito senza materia', data_consegna_compiti: null,
      materie: { nome: '' }, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })

    const compiti = await elenco()
    expect(compiti.find((c) => c.id === 'reg-materia-vuota')!.materia).toBe('ed. motoria (storico)')
    expect(compiti.find((c) => c.id === 'reg-materia-niente')!.materia).toBeNull()
  })

  it('la classe di un ALTRO plesso non entra: sezione e sede filtrano nella stessa query', async () => {
    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).not.toContain('reg-altra-sede')
    // La prova che il filtro non è «per caso»: la select è partita da
    // `registro_orario`, e la riga estranea ha la STESSA sezione — solo la sede
    // la distingue.
    expect(h.tabelle).toContain('registro_orario')
  })

  it('la sede viene da QUESTA classe: la seconda lettura di `sections` è filtrata per id', async () => {
    // In `sections` la prima riga è un'ALTRA sezione, di un altro plesso. Senza
    // `.eq('id', sectionId)` `maybeSingle()` prenderebbe lei, e la query dei
    // compiti filtrerebbe su `ALTRA_SEDE`: elenco vuoto (o peggio, i compiti del
    // plesso sbagliato) dentro un 200.
    const sezioni = h.db.sections as Record<string, unknown>[]
    expect(sezioni[0].id, 'la sezione civetta non è più la prima: il caso non misura più niente')
      .toBe(ALTRA_SEZIONE)

    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).toEqual(['reg-1', 'reg-2'])
    expect(h.tabelle).toContain('sections')
  })
})

describe('nessun dato del singolo bambino esce da questa vista', () => {
  it('né uuid né nomi nel JSON serializzato', async () => {
    const res = await GET(req())
    const testo = JSON.stringify(await res.json())
    expect(testo).not.toContain(ALUNNO_1)
    expect(testo).not.toContain(ALUNNO_2)
    expect(testo).not.toContain('alunno_id')
    expect(testo).not.toContain('registro_destinatari')
    // I destinatari si contano, e il conteggio c'è: senza questa riga
    // l'asserzione qui sopra sarebbe verde anche non leggendoli affatto.
    expect(testo).toContain('"destinatari":2')
  })

  it('`alunno_id` non viene nemmeno CHIESTO al database', async () => {
    // Non uscire dal JSON era già vero, ma il campo veniva letto: restava a un
    // `...r` di distanza dalla risposta, dentro una route il cui punto dichiarato
    // è che nessun uuid di bambino esca di qui. Il conteggio per `firma_id` è
    // esatto da solo — l'UNIQUE `(registro_id, firma_id, alunno_id)` impedisce la
    // coppia ripetuta — quindi il modo più economico di non farlo uscire è non
    // chiederlo.
    await elenco()
    const sel = h.proiezioni.find((p) => p.tabella === 'registro_orario')
    expect(sel, 'nessuna select osservata su registro_orario: il caso non misura niente').toBeTruthy()
    expect(sel!.colonne, 'controllo positivo: si sta guardando la select vera').toContain('firme_docenti')
    expect(sel!.colonne).toMatch(/registro_destinatari\(\s*firma_id\s*\)/)
    expect(sel!.colonne).not.toContain('alunno_id')
  })

  it('la firma del docente non esce nemmeno come identificativo', async () => {
    const res = await GET(req())
    const testo = JSON.stringify(await res.json())
    expect(testo).not.toContain('firma-2')
    expect(testo).not.toContain('firme_docenti')
  })
})

describe('gli allegati escono FIRMATI, mai come percorso di bucket', () => {
  it('il percorso salvato diventa un indirizzo firmato, sul bucket e col TTL del progetto', async () => {
    const compiti = await elenco()
    expect(h.firme, 'lo Storage dev’essere stato interrogato').toHaveLength(1)
    expect(h.firme[0].bucket).toBe(BUCKET)
    expect(h.firme[0].ttl).toBe(TTL_ATTESO)
    expect(compiti[0].allegati).toEqual([
      {
        id: 'all-1',
        tipo: 'immagine',
        ambito: 'argomento',
        file_name: 'lavagna.jpg',
        file_url: firmato(PERCORSO_FOTO),
      },
    ])
  })

  it('l’AMBITO esce, per l’argomento come per i compiti: la linguetta deve poterli distinguere', async () => {
    // 🔴 E NON SI FILTRA. Misura di produzione del 2026-09-19: `allegati_registro`
    // ha zero righe e l'unico caricatore dell'app non manda mai `ambito` (che in
    // `primaria/allegati:POST` ha `.default('argomento')`). Un filtro
    // `ambito === 'compiti'` renderebbe la lista vuota per sempre, in silenzio.
    // Perciò il caso qui sotto pretende che escano ENTRAMBI.
    registro().push({
      id: 'reg-ambiti', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 5,
      materia: null, argomento: null, compiti: 'Leggere il capitolo 4', data_consegna_compiti: null,
      materie: { nome: 'Italiano' }, firme_docenti: [], registro_destinatari: [],
      allegati_registro: [
        { id: 'all-arg', tipo: 'immagine', ambito: 'argomento', file_url: 'registro/x/arg.jpg', file_name: 'arg.jpg' },
        { id: 'all-com', tipo: 'documento', ambito: 'compiti', file_url: 'registro/x/com.pdf', file_name: 'com.pdf' },
      ],
    })
    const compiti = await elenco()
    const riga = compiti.find((c) => c.id === 'reg-ambiti')!

    // ⚠️ La colonna va chiesta ANCHE nella select, e questa riga serve perché il
    // finto client non proietta il contenuto degli EMBED (lo costruisce il
    // fixture): senza, togliere `ambito` dalla `select` lascerebbe la risposta
    // identica qui e diversa in produzione, cioè il verde peggiore che esista.
    const sel = h.proiezioni.find((p) => p.tabella === 'registro_orario')
    expect(sel, 'nessuna select osservata su registro_orario').toBeTruthy()
    expect(sel!.colonne).toMatch(/allegati_registro\([^)]*\bambito\b/)

    expect(Object.keys(riga.allegati[0]).sort()).toEqual(['ambito', 'file_name', 'file_url', 'id', 'tipo'])
    expect(riga.allegati.map((a) => [a.id, a.ambito])).toEqual([
      ['all-arg', 'argomento'],
      ['all-com', 'compiti'],
    ])
    // E tutti e due sono stati firmati: esporre l'ambito non deve aver introdotto
    // per sbaglio un filtro a valle.
    expect(riga.allegati.every((a) => a.file_url !== null)).toBe(true)
  })

  it('un `file_url` STORICO (indirizzo pubblico completo) viene riportato a percorso e firmato', async () => {
    // Le righe di quando il contenitore era `public: true` portano l'indirizzo
    // intero. Senza questo caso, `percorsoNelBucket` poteva sparire dalla route
    // lasciando la suite verde: i percorsi nudi funzionano lo stesso.
    registro().push({
      id: 'reg-storica', section_id: SEZIONE, scuola_id: SEDE, data: OGGI, ora_lezione: 8,
      materia: null, argomento: null, compiti: 'Scheda allegata', data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [],
      allegati_registro: [
        { id: 'all-storico', tipo: 'documento', ambito: 'compiti', file_url: URL_PUBBLICO_STORICO, file_name: 'scheda.pdf' },
      ],
    })
    const compiti = await elenco()

    // Allo Storage è andato il PERCORSO, non l'indirizzo.
    expect(h.firme[0].percorsi).toContain(PERCORSO_STORICO)
    expect(h.firme[0].percorsi.some((p) => p.startsWith('http'))).toBe(false)
    expect(compiti.find((c) => c.id === 'reg-storica')!.allegati[0].file_url)
      .toBe(firmato(PERCORSO_STORICO))
  })

  it('firma fallita ⇒ `file_url: null`, MAI il percorso grezzo, e il motivo nel log', async () => {
    h.risposta = { data: null, error: { message: 'bucket not found', statusCode: '404' } }
    const res = await GET(req())
    const corpo = (await res.json()) as { data: Payload }
    const testo = JSON.stringify(corpo)

    expect(corpo.data.compiti[0].allegati[0].file_url).toBeNull()
    expect(testo, 'il percorso grezzo maschererebbe il guasto da «allegato rotto»').not.toContain(
      `"${PERCORSO_FOTO}"`,
    )
    const errori = h.logEvento.mock.calls.filter((c) => c[0] === 'storage' && c[1] === 'error')
    expect(errori.length, 'un fallimento muto è il difetto, non il rimedio').toBeGreaterThan(0)
    expect((errori[0][2] as { operazione?: string }).operazione).toBe('primaria/compiti:GET')
  })

  it('senza allegati lo Storage non si tocca affatto', async () => {
    registro()[0].allegati_registro = []
    const compiti = await elenco()
    expect(compiti[0].allegati).toEqual([])
    expect(h.firme).toHaveLength(0)
  })

  it('il tetto è sulle RIGHE: una pagina piena con due allegati fa il doppio dei percorsi, in una firma sola', async () => {
    // 🔴 LA MISURA CHE DICEVA IL FALSO. Fino al 2026-09-19 il commento del tetto
    // prometteva «al massimo N percorsi in una sola `createSignedUrls`»: il tetto è
    // sulle righe, e ogni riga porta N allegati. `primaria/allegati:POST` limita la
    // DIMENSIONE del file (10 MB / 3 MB), mai il NUMERO per `registro_id` — quindi
    // il secondo fattore non ha tetto.
    h.db.registro_orario = Array.from({ length: PAGINA_ATTESA }, (_, i) => ({
      id: `reg-all-${String(i).padStart(4, '0')}`, section_id: SEZIONE, scuola_id: SEDE,
      data: OGGI, ora_lezione: (i % 8) + 1,
      materia: null, argomento: null, compiti: `Compito ${i}`, data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [],
      allegati_registro: [
        { id: `all-${i}-a`, tipo: 'immagine', ambito: 'compiti', file_url: `registro/riga-${i}/a.jpg`, file_name: 'a.jpg' },
        { id: `all-${i}-b`, tipo: 'documento', ambito: 'compiti', file_url: `registro/riga-${i}/b.pdf`, file_name: 'b.pdf' },
      ],
    }))

    const { compiti } = await corpoOk()
    expect(compiti).toHaveLength(PAGINA_ATTESA)

    // Una sola chiamata allo Storage — non si spezza in blocchi — e dentro ci sono
    // DUE percorsi per riga, non uno.
    expect(h.firme).toHaveLength(1)
    expect(h.firme[0].percorsi, 'i percorsi sono righe × allegati, non righe').toHaveLength(PAGINA_ATTESA * 2)

    // E la cosa si SA: oltre le righe di una pagina — il punto in cui l'ipotesi «un
    // allegato per riga» smette di valere — parte la riga di `warn` da cui si
    // deciderà se spezzare in blocchi.
    const avvisi = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'storage' && c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'firme-oltre-la-stima',
    )
    expect(avvisi, 'nessuno saprebbe mai che quel blocco è cresciuto').toHaveLength(1)
    expect(avvisi[0][2]).toMatchObject({
      operazione: 'primaria/compiti:GET',
      n_percorsi: PAGINA_ATTESA * 2,
      n_righe: PAGINA_ATTESA,
      limite: PAGINA_ATTESA,
    })
  })

  it('un allegato per riga NON supera la stima: nessun avviso (controllo negativo)', async () => {
    // Senza questo, l'asserzione qui sopra sarebbe verde anche con un `warn`
    // cablato che parte sempre.
    h.db.registro_orario = Array.from({ length: PAGINA_ATTESA }, (_, i) => ({
      id: `reg-uno-${String(i).padStart(4, '0')}`, section_id: SEZIONE, scuola_id: SEDE,
      data: OGGI, ora_lezione: (i % 8) + 1,
      materia: null, argomento: null, compiti: `Compito ${i}`, data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [],
      allegati_registro: [
        { id: `solo-${i}`, tipo: 'immagine', ambito: 'compiti', file_url: `registro/riga-${i}/a.jpg`, file_name: 'a.jpg' },
      ],
    }))

    await elenco()
    expect(h.firme[0].percorsi).toHaveLength(PAGINA_ATTESA)
    const avvisi = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'firme-oltre-la-stima',
    )
    expect(avvisi).toHaveLength(0)
  })
})

describe('il periodo: predefinito, estremi e tetto', () => {
  it('senza `dataDa` si guardano gli ultimi 30 giorni, non tutto il registro', async () => {
    const vecchia = new Date(Date.parse(`${OGGI}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10)
    registro().push({
      id: 'reg-vecchia', section_id: SEZIONE, scuola_id: SEDE, data: vecchia, ora_lezione: 1,
      materia: null, argomento: null, compiti: 'Compiti di due mesi fa', data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })
    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).not.toContain('reg-vecchia')
    // …e con `dataDa` esplicito quella stessa riga entra: la prova che a escluderla
    // è la finestra e non un altro filtro.
    const conDa = await elenco(`sectionId=${SEZIONE}&dataDa=${vecchia}`)
    expect(conDa.map((c) => c.id)).toContain('reg-vecchia')
  })

  it('senza `dataA` non c’è tetto superiore: i compiti assegnati nel futuro si vedono', async () => {
    const domani = new Date(Date.parse(`${OGGI}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    registro().push({
      id: 'reg-futura', section_id: SEZIONE, scuola_id: SEDE, data: domani, ora_lezione: 1,
      materia: null, argomento: null, compiti: 'Per la prossima settimana', data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })
    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).toContain('reg-futura')
    // Con `dataA` a oggi, invece, esce dal periodo.
    const conA = await elenco(`sectionId=${SEZIONE}&dataA=${OGGI}`)
    expect(conA.map((c) => c.id)).not.toContain('reg-futura')
  })

  it('«oggi» è quello ITALIANO: a Roma mezzanotte e mezza la finestra è già del giorno dopo', async () => {
    // `oggiFiscaleISO()` contro `new Date().toISOString()`: le due date
    // coincidono 22 ore su 24, quindi sostituendo la prima con la seconda la
    // suite restava verde. Qui l'orologio è fermo su un istante in cui NON
    // coincidono — 22:30 UTC del 19/09 è già il 20/09 alle 00:30 a Roma.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-19T22:30:00Z'))

    // Finestra predefinita: da 30 giorni prima dell'oggi ITALIANO (2026-09-20),
    // cioè dal 2026-08-21. Con l'oggi UTC (2026-09-19) partirebbe dal 2026-08-20
    // e la prima riga entrerebbe.
    h.db.registro_orario = [
      {
        id: 'reg-20-agosto', section_id: SEZIONE, scuola_id: SEDE, data: '2026-08-20', ora_lezione: 1,
        materia: null, argomento: null, compiti: 'Fuori dalla finestra italiana', data_consegna_compiti: null,
        materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
      },
      {
        id: 'reg-21-agosto', section_id: SEZIONE, scuola_id: SEDE, data: '2026-08-21', ora_lezione: 1,
        materia: null, argomento: null, compiti: 'Dentro per un giorno', data_consegna_compiti: null,
        materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
      },
    ]

    const compiti = await elenco()
    expect(compiti.map((c) => c.id)).toEqual(['reg-21-agosto'])

    // Il secondo bersaglio dello stesso scarto: anche il TETTO si misura
    // sull'oggi italiano. Dal 2026-02-08 al 2026-09-20 sono 224 giorni (rifiuto);
    // con l'oggi UTC (2026-09-19) sarebbero 223, cioè la finestra massima esatta,
    // e passerebbe. La data è RICALCOLATA sulla finestra: prima qui c'era
    // `2025-09-19`, che a 365/366 giorni discriminava e a 223 non discrimina più —
    // sarebbe rifiutata in tutti e due i casi, cioè verde senza misurare niente.
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=${menoGiorni('2026-09-20', FINESTRA_ATTESA + 1)}`))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { codice?: string }).codice).toBe('PERIODO_TROPPO_LUNGO')
  })

  it('400 CON CODICE su un intervallo oltre la finestra, e NON un elenco troncato in silenzio', async () => {
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=2024-01-01&dataA=2026-01-01`))
    expect(res.status).toBe(400)
    const corpo = (await res.json()) as { error: string; codice?: string; details?: unknown }

    // 🔴 IL CODICE, non `details`. Fino al 2026-09-19 il rifiuto usciva dal
    // `superRefine` dello schema, cioè come `{ error: 'Dati non validi', details:
    // [{ message: 'Periodo troppo lungo…' }] }` — e `details` in tutta `src/` lo
    // legge un solo componente, che ne usa il `path`. Il docente leggeva «Dati
    // non validi».
    expect(corpo.codice).toBe('PERIODO_TROPPO_LUNGO')
    // La prosa porta il numero VERO della finestra: se la costante si muove senza
    // che il messaggio la segua, il docente legge un tetto che non esiste.
    expect(corpo.error).toContain(String(FINESTRA_ATTESA))
    expect(corpo.error).toMatch(/[Pp]eriodo troppo lungo/)
    expect(corpo.details, 'il motivo non deve tornare a nascondersi in `details`').toBeUndefined()

    // Il rifiuto arriva PRIMA di qualunque lettura, e prima ancora del client
    // service-role: non si legge mezzo anno per poi buttarlo via.
    expect(h.tabelle).toEqual([])
    expect(h.creaClient).not.toHaveBeenCalled()
  })

  it('la finestra massima esatta passa: il tetto è un massimo, non un divieto', async () => {
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, FINESTRA_ATTESA)}&dataA=${OGGI}`))
    expect(res.status).toBe(200)
  })

  it('senza `dataA` il tetto si misura su OGGI: un `dataDa` di tre anni fa è rifiutato', async () => {
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=2023-01-01`))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { codice?: string }).codice).toBe('PERIODO_TROPPO_LUNGO')
  })

  it('400 CON CODICE quando la fine precede l’inizio: un intervallo impossibile non è «nessun compito»', async () => {
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=2026-09-10&dataA=2026-09-01`))
    expect(res.status).toBe(400)
    const corpo = (await res.json()) as { error: string; codice?: string }
    expect(corpo.codice).toBe('PERIODO_ROVESCIATO')
    // Non riusa il codice del tetto: «restringi l'intervallo» qui non è il rimedio.
    expect(corpo.codice).not.toBe('PERIODO_TROPPO_LUNGO')
    expect(h.tabelle).toEqual([])
    expect(h.creaClient).not.toHaveBeenCalled()
  })

  it('un `dataDa` NEL FUTURO senza `dataA` non è rovesciato: l’intervallo è aperto', async () => {
    // Il controllo che impedisce al rifiuto di mordere troppo: «i compiti da
    // lunedì in poi» è una domanda legittima, e con l'estremo superiore assente
    // l'ampiezza calcolata su oggi è negativa — non un periodo impossibile.
    const domani = new Date(Date.parse(`${OGGI}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=${domani}`))
    expect(res.status).toBe(200)
  })

  it('un estremo VUOTO (`?dataDa=`) non è un rifiuto muto: 200 con la finestra predefinita', async () => {
    // Una barra filtri o un navigatore di date con il campo svuotato manda `''`,
    // non un parametro assente. Con `zDataYMD.optional()` nudo la stringa vuota non
    // era «nessun estremo»: era una data che non rispetta la regex, cioè un 400
    // «Dati non validi» SENZA `codice` — la stessa forma di rifiuto muto che i due
    // codici del periodo sono nati per chiudere, sul parametro accanto.
    const vecchia = menoGiorni(OGGI, 60)
    registro().push({
      id: 'reg-vuoto-vecchia', section_id: SEZIONE, scuola_id: SEDE, data: vecchia, ora_lezione: 1,
      materia: null, argomento: null, compiti: 'Compiti di due mesi fa', data_consegna_compiti: null,
      materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
    })

    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=&dataA=`))
    expect(res.status, 'la stringa vuota va letta come «nessun estremo», non come data non valida').toBe(200)

    // …e la finestra è quella PREDEFINITA, non «tutto il registro»: senza questa
    // riga il caso sarebbe verde anche se `''` fosse diventato «nessun filtro».
    const corpo = (await res.json()) as { data: Payload }
    const ids = corpo.data.compiti.map((c) => c.id)
    expect(ids).toContain('reg-1')
    expect(ids).not.toContain('reg-vuoto-vecchia')
  })

  it('l’anno scolastico intero (364 giorni) NON è più rifiutato: si legge a pagine', async () => {
    // 🔴 IL CASO CHE HA CAMBIATO SEGNO. Fino al 2026-09-19 questa stessa richiesta
    // — la pastiglia «Anno scolastico» del registro — riceveva un 400
    // `PERIODO_TROPPO_LUNGO`, perché la finestra era calcolata dal tetto delle
    // righe e nessun tetto sotto il `max_rows = 1000` di PostgREST poteva coprire
    // un anno. Era un rifiuto onesto (meglio di un elenco accorciato in silenzio)
    // ma toglieva al docente una funzione che gli serve: a giugno, da settembre a
    // gennaio non si vedeva più niente.
    //
    // Adesso l'anno si legge: non in una risposta, ma in una sequenza di pagine
    // che finisce con `prossimoCursore: null`. Il caso peggiore misurato — 5 ore
    // in ogni giorno di lezione, lunedì-venerdì — fa ~1.000 righe, cioè più di
    // `max_rows`: se la paginazione non funzionasse, qui mancherebbe qualcosa.
    const da = menoGiorni(OGGI, 364)
    const righe: Record<string, unknown>[] = []
    for (let g = 0; g <= 364; g++) {
      const giorno = new Date(Date.parse(`${da}T00:00:00Z`) + g * 86_400_000)
      // Sabato e domenica non esistono nel registro: misurato, non supposto.
      if (giorno.getUTCDay() === 0 || giorno.getUTCDay() === 6) continue
      const iso = giorno.toISOString().slice(0, 10)
      for (let ora = 1; ora <= ORE_PEGGIORI_AL_GIORNO; ora++) {
        righe.push({
          id: `reg-anno-${iso}-${ora}`, section_id: SEZIONE, scuola_id: SEDE, data: iso, ora_lezione: ora,
          materia: null, argomento: null, compiti: `Compito ${iso} ora ${ora}`, data_consegna_compiti: null,
          materie: null, firme_docenti: [], registro_destinatari: [], allegati_registro: [],
        })
      }
    }
    // La misura che rende il caso una misura e non una posa: un anno al caso
    // peggiore non sta in una pagina, e nemmeno nel `max_rows` di PostgREST.
    expect(righe.length, 'un anno al caso peggiore deve superare una pagina').toBeGreaterThan(PAGINA_ATTESA)
    expect(righe.length, 'un anno al caso peggiore deve superare max_rows').toBeGreaterThan(MAX_ROWS!)
    h.db.registro_orario = righe

    const pagine = await tutteLePagine(`sectionId=${SEZIONE}&dataDa=${da}&dataA=${OGGI}`)
    const raccolti = pagine.flatMap((p) => p.compiti.map((c) => c.id))

    // Tutte le righe dell'anno, nessuna persa e nessuna ripetuta, nell'ordine
    // della route (data DESC, ora ASC) e non in quello del fixture.
    expect(raccolti).toEqual(attesiDalFixture())
    expect(raccolti, 'un anno non è più un anno: il fixture è cambiato').toHaveLength(righe.length)
    expect(new Set(raccolti).size, 'una riga è uscita due volte').toBe(raccolti.length)
    // …e il primo compito della lista è il PIÙ RECENTE: l'ordine non si perde fra
    // una pagina e l'altra.
    expect(raccolti[0]).toBe(`reg-anno-${righe.at(-1)!.data}-1`)
  })
})

describe('la paginazione: `prossimoCursore: null` è una promessa, non un’assenza', () => {
  it('🔴 la pagina sta COMODAMENTE sotto `max_rows`, o la condizione di fine mente', async () => {
    // LA TRAPPOLA DELLA CONDIZIONE DI FINE. La route dice «non c'è altro» quando
    // una lettura torna con MENO righe di quante ne ha chieste. Se la pagina
    // superasse `max_rows`, a tagliare sarebbe PostgREST: 1.000 righe su 1.200
    // chieste sono «meno del tetto», e la route direbbe `prossimoCursore: null`
    // davanti a mezzo anno ancora da leggere — la perdita silenziosa prodotta
    // dalla paginazione che esiste per impedirla.
    expect(MAX_ROWS, 'max_rows non si legge più da supabase/config.toml: il caso non misura niente')
      .toBeTypeOf('number')
    expect(PAGINA_ATTESA).toBeLessThan(MAX_ROWS!)
    // «Comodamente», non «di uno»: deve reggere anche un `max_rows` dimezzato.
    expect(PAGINA_ATTESA * 2).toBeLessThanOrEqual(MAX_ROWS!)
  })

  it('una finestra che sta in una pagina non ha un seguito: `prossimoCursore: null`', async () => {
    h.db.registro_orario = registroFitto(20, () => true)
    const { compiti, prossimoCursore } = await corpoOk(`sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 20)}`)
    expect(compiti.length).toBe(20 * ORE_PEGGIORI_AL_GIORNO)
    expect(compiti.length).toBeLessThan(PAGINA_ATTESA)
    expect(prossimoCursore, 'non c’è niente da chiedere ancora').toBeNull()
  })

  it('una finestra che NON ci sta: la pagina dopo riprende dove si era fermata, riga per riga', async () => {
    // 100 giorni × 5 ore = 500 righe, tutte con un compito: due pagine piene di
    // 300 e 200. L'asserzione è sugli ID, non sui conteggi — due pagine da 250
    // farebbero 500 anche saltando una riga e ripetendone un'altra.
    h.db.registro_orario = registroFitto(100, () => true)
    const qs = `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 100)}`

    const prima = await corpoOk(qs)
    expect(prima.compiti).toHaveLength(PAGINA_ATTESA)
    expect(prima.prossimoCursore, 'restano 200 righe e la risposta dice che non c’è altro').not.toBeNull()

    const seconda = await corpoOk(`${qs}&cursore=${encodeURIComponent(prima.prossimoCursore!)}`)
    expect(seconda.compiti).toHaveLength(500 - PAGINA_ATTESA)
    expect(seconda.prossimoCursore).toBeNull()

    const raccolti = [...prima.compiti, ...seconda.compiti].map((c) => c.id)
    expect(raccolti, 'una riga è stata saltata o ripetuta sul confine').toEqual(attesiDalFixture())
    expect(new Set(raccolti).size).toBe(raccolti.length)
    // Il confine cade DENTRO la sequenza: l'ultima della prima pagina e la prima
    // della seconda sono consecutive, non a caso.
    expect(prima.compiti.at(-1)!.id).toBe(attesiDalFixture()[PAGINA_ATTESA - 1])
    expect(seconda.compiti[0].id).toBe(attesiDalFixture()[PAGINA_ATTESA])
  })

  it('🔴 il keyset SUL CONFINE: stessa data, ore diverse, spezzate a metà da una pagina', async () => {
    // Con 8 ore al giorno il confine delle 300 righe NON cade fra due giornate:
    // cade dentro la 38ª, fra l'ora 4 e l'ora 5 (37 giorni × 8 = 296, poi 4 ore).
    // È il caso che smaschera un keyset scritto sulla sola `data`: `data.lt.X`
    // butterebbe via le quattro ore rimaste di quel giorno, e sparirebbero senza
    // che nessun conteggio cambi in modo evidente.
    h.db.registro_orario = registroFitto(60, () => true, 8)
    const qs = `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 60)}`

    const prima = await corpoOk(qs)
    const ultima = prima.compiti.at(-1)!
    expect(ultima, 'il confine non cade più a metà di una giornata: il caso non misura niente')
      .toMatchObject({ data: menoGiorni(OGGI, 37), ora_lezione: 4 })

    const seconda = await corpoOk(`${qs}&cursore=${encodeURIComponent(prima.prossimoCursore!)}`)
    // La prima riga della pagina dopo è la 5ª ora dello STESSO giorno.
    expect(seconda.compiti[0]).toMatchObject({ data: menoGiorni(OGGI, 37), ora_lezione: 5 })

    const raccolti = [...prima.compiti, ...seconda.compiti].map((c) => c.id)
    expect(raccolti, 'le ore rimaste del giorno di confine sono sparite').toEqual(attesiDalFixture())
  })

  it('🔴 lo SPAREGGIO sull’id: due righe con la stessa data e la stessa ora, una per parte del confine', async () => {
    // L'indice `uidx_registro_orario_chiave` è su `(scuola_id, classe_sezione,
    // data, ora_lezione)`, non su `section_id`: garantisce quasi la chiave del
    // keyset, non la chiave del keyset. Qui le due righe gemelle cadono ESATTAMENTE
    // sul confine — la 300ª e la 301ª — e senza `id` come terzo criterio la seconda
    // non starebbe né nella pagina di prima (non è «maggiore») né in quella dopo.
    const righe = registroFitto(37, () => true, 8) // 296 righe
    const giornoConfine = menoGiorni(OGGI, 37)
    for (const [ora, coda] of [[1, 'a'], [2, 'a'], [3, 'a'], [4, 'a'], [4, 'b']] as const) {
      righe.push({
        id: `reg-0037-${ora}${coda}`, section_id: SEZIONE, scuola_id: SEDE,
        data: giornoConfine, ora_lezione: ora,
        materia: null, argomento: null, compiti: `Compito gemello ${ora}${coda}`,
        data_consegna_compiti: null, materie: null,
        firme_docenti: [], registro_destinatari: [], allegati_registro: [],
      })
    }
    expect(righe, 'il confine non cade più fra i due gemelli').toHaveLength(PAGINA_ATTESA + 1)
    h.db.registro_orario = righe

    const qs = `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 40)}`
    const prima = await corpoOk(qs)
    expect(prima.compiti.at(-1)!.id).toBe('reg-0037-4a')

    const seconda = await corpoOk(`${qs}&cursore=${encodeURIComponent(prima.prossimoCursore!)}`)
    expect(seconda.compiti.map((c) => c.id), 'il gemello sul confine è sparito').toEqual(['reg-0037-4b'])
    expect(seconda.prossimoCursore).toBeNull()
  })

  it('🔴 MAI `prossimoCursore: null` con compiti più vecchi ancora da leggere', async () => {
    // IL CASO CHE TIENE IN PIEDI TUTTO IL RESTO, nella sua forma peggiore: 300
    // giorni di registro (1.500 righe) in cui gli UNICI compiti sono nelle dieci
    // righe PIÙ VECCHIE. Una route che smettesse di leggere perché «non ho trovato
    // compiti» — la scorciatoia naturale — risponderebbe `{ compiti: [],
    // prossimoCursore: null }` e quei dieci compiti non li vedrebbe più nessuno,
    // con un 200 in faccia.
    const giorni = 300
    h.db.registro_orario = registroFitto(giorni, (g) => g >= giorni - 2)
    const attesi = attesiDalFixture()
    expect(attesi, 'i compiti non sono più solo in fondo: il caso non misura niente')
      .toHaveLength(2 * ORE_PEGGIORI_AL_GIORNO)

    const pagine = await tutteLePagine(`sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, giorni)}`)
    const raccolti = pagine.flatMap((p) => p.compiti.map((c) => c.id))
    expect(raccolti, 'la paginazione ha dichiarato la fine prima di arrivarci').toEqual(attesi)

    // E l'ultima pagina è l'unica che dice `null`: le altre no.
    expect(pagine.at(-1)!.prossimoCursore).toBeNull()
    expect(pagine.slice(0, -1).every((p) => p.prossimoCursore !== null)).toBe(true)
  })

  it('una pagina INTERMEDIA può essere vuota col cursore valorizzato, e lo dichiara nel log', async () => {
    // Il contratto lo prevede: la route pagina righe di REGISTRO e restituisce
    // solo quelle con un compito, quindi un tratto senza compiti è una pagina
    // vuota. La route ne legge fino a `GIRI_ATTESI` per ridurre il caso, e quando
    // il tetto morde risponde vuoto CON il cursore — mai vuoto con `null`.
    const righeVuote = GIRI_ATTESI * PAGINA_ATTESA
    const giorniVuoti = righeVuote / ORE_PEGGIORI_AL_GIORNO
    h.db.registro_orario = registroFitto(giorniVuoti + 2, (g) => g >= giorniVuoti)

    const prima = await corpoOk(`sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, giorniVuoti + 2)}`)
    expect(prima.compiti, 'i primi quattro tratti non hanno compiti').toEqual([])
    expect(prima.prossimoCursore, '🔴 vuoto E senza cursore: i compiti in fondo sarebbero persi').not.toBeNull()

    // La cosa si SA: senza questa riga nessuno saprebbe mai quante classi hanno
    // tratti di registro più lunghi del tetto dei giri.
    const avvisi = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'registro' && c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'pagina-senza-compiti',
    )
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0][2]).toMatchObject({
      operazione: 'primaria/compiti:GET', sezione: SEZIONE, limite: PAGINA_ATTESA, n_giri: GIRI_ATTESI,
    })

    // …e la pagina dopo i compiti ce li ha davvero.
    const seconda = await corpoOk(
      `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, giorniVuoti + 2)}&cursore=${encodeURIComponent(prima.prossimoCursore!)}`,
    )
    expect(seconda.compiti.map((c) => c.id)).toEqual(attesiDalFixture())
  })

  it('il ciclo interno RISPARMIA la pagina vuota quando i compiti arrivano entro il tetto dei giri', async () => {
    // Il controllo positivo del ciclo: un tratto senza compiti lungo due pagine
    // non produce due risposte vuote. Senza il ciclo questa sarebbe `[]` con un
    // cursore, e il caso qui sopra resterebbe verde lo stesso — cioè non
    // proverebbe che il ciclo esiste.
    const giorniVuoti = (2 * PAGINA_ATTESA) / ORE_PEGGIORI_AL_GIORNO
    h.db.registro_orario = registroFitto(giorniVuoti + 1, (g) => g >= giorniVuoti)

    const prima = await corpoOk(`sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, giorniVuoti + 1)}`)
    expect(prima.compiti.map((c) => c.id), 'il ciclo non ha proseguito oltre il primo tratto vuoto')
      .toEqual(attesiDalFixture())
    const avvisi = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'pagina-senza-compiti',
    )
    expect(avvisi, 'la pagina non è vuota: non c’è niente da segnalare').toHaveLength(0)
  })

  it('il cursore è OPACO, e la pagina successiva si logga (`withRoute` non persiste i 200)', async () => {
    h.db.registro_orario = registroFitto(100, () => true)
    const qs = `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 100)}`
    const prima = await corpoOk(qs)

    // Opaco: dentro non si legge né la classe né una data. Non è un segreto — è il
    // patto che il client non lo interpreti.
    expect(prima.prossimoCursore).not.toContain(SEZIONE)
    expect(prima.prossimoCursore).not.toContain(OGGI)
    expect(prima.prossimoCursore).toMatch(/^[A-Za-z0-9_-]+$/)

    // La prima pagina NON logga: sarebbe una riga a ogni apertura della linguetta.
    expect(h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'pagina-successiva',
    )).toHaveLength(0)

    await corpoOk(`${qs}&cursore=${encodeURIComponent(prima.prossimoCursore!)}`)
    const righe = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'registro' && c[1] === 'info' && (c[2] as { esito?: string })?.esito === 'pagina-successiva',
    )
    expect(righe, '«nessun log» non distinguerebbe «nessuno pagina» da «la paginazione non parte»')
      .toHaveLength(1)
    expect(righe[0][2]).toMatchObject({ operazione: 'primaria/compiti:GET', sezione: SEZIONE, ultima: true })
  })

  it('il cursore NON allarga la finestra: le righe fuori periodo restano fuori', async () => {
    // Il keyset è in AND con gli estremi, non al loro posto. Senza questa riga un
    // cursore potrebbe diventare il modo per leggere fuori dal periodo chiesto.
    h.db.registro_orario = registroFitto(100, () => true)
    const qs = `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 100)}&dataA=${menoGiorni(OGGI, 70)}`
    const pagine = await tutteLePagine(qs)
    const date = pagine.flatMap((p) => p.compiti.map((c) => c.data))
    // `registroFitto(100, …)` genera i giorni 0..99: dentro `[−100, −70]` ce ne
    // sono 30 (dal 99 al 70), non 31.
    expect(date.length).toBe(30 * ORE_PEGGIORI_AL_GIORNO)
    expect(date.every((d) => d >= menoGiorni(OGGI, 100) && d <= menoGiorni(OGGI, 70))).toBe(true)
  })
})

describe('un cursore che non è nostro: 400, non un silenzio e non un 500', () => {
  /** Un cursore ben formato per una sezione qualunque: base64url di JSON. */
  const cursorePer = (sezione: string) =>
    Buffer.from(
      JSON.stringify({ v: 1, s: sezione, d: OGGI, o: 2, i: '11111111-2222-4333-8444-555555555555' }),
      'utf8',
    ).toString('base64url')

  it.each([
    ['spazzatura', 'non-e-base64!!'],
    ['base64 di non-JSON', Buffer.from('ciao', 'utf8').toString('base64url')],
    ['JSON senza i campi giusti', Buffer.from(JSON.stringify({ a: 1 }), 'utf8').toString('base64url')],
    ['versione sconosciuta', Buffer.from(
      JSON.stringify({ v: 99, s: SEZIONE, d: OGGI, o: 1, i: '11111111-2222-4333-8444-555555555555' }), 'utf8',
    ).toString('base64url')],
    ['data inesistente nel calendario', Buffer.from(
      JSON.stringify({ v: 1, s: SEZIONE, d: '2026-02-30', o: 1, i: '11111111-2222-4333-8444-555555555555' }), 'utf8',
    ).toString('base64url')],
  ])('400 col suo codice su un cursore %s, e nessuna lettura parte', async (_nome, cursore) => {
    const res = await GET(req(`sectionId=${SEZIONE}&cursore=${encodeURIComponent(cursore)}`))
    expect(res.status, 'un cursore illeggibile non è un guasto del server').toBe(400)
    const corpo = (await res.json()) as { error: string; codice?: string }
    expect(corpo.codice).toBe('CORPO_NON_VALIDO')
    expect(corpo.error).toMatch(/ricarica/i)
    // 🔴 NON si riparte dall'inizio in silenzio: il docente ha in mano mezza
    // lista, e ricominciare senza dirglielo è la perdita silenziosa con un'altra
    // faccia.
    expect(h.tabelle).toEqual([])
    expect(h.creaClient).not.toHaveBeenCalled()
  })

  it('un cursore di un’ALTRA sezione è rifiutato, non usato per guidare questa lettura', async () => {
    const res = await GET(req(`sectionId=${SEZIONE}&cursore=${encodeURIComponent(cursorePer(ALTRA_SEZIONE))}`))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { codice?: string }).codice).toBe('CORPO_NON_VALIDO')
    expect(h.creaClient).not.toHaveBeenCalled()

    // La causa resta nel LOG, distinta dalla forma sbagliata: a schermo sarebbe
    // rumore, in SQL è la differenza fra un client che perde i cursori e un client
    // che li scambia fra le classi.
    //
    // 🔴 SI GUARDA DIETRO IL REDATTORE, NON DAVANTI. Fino al 2026-09-19 questo
    // caso asseriva `motivo: 'altra-sezione'` sugli ARGOMENTI di `logEvento`,
    // cioè su ciò che la route ha DETTO — non su ciò che `app_log` riceve. E
    // `motivo` è una radice di testo libero in `@/lib/logging/redact`: in tabella
    // arrivava `"motivo":"[redatto:str/13]"`. La frase qui sopra era falsa, e
    // questo test era verde lo stesso. Passare i campi da `redact()` è l'unico
    // modo di misurare la riga vera; la chiave è ora `tipo`, che la lista bianca
    // ha già.
    const righe = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'cursore-non-valido',
    )
    expect(righe).toHaveLength(1)
    const inTabella = redact(righe[0][2]) as { sezione?: unknown; tipo?: unknown; esito?: unknown }
    expect(inTabella).toMatchObject({ sezione: SEZIONE, esito: 'cursore-non-valido', tipo: 'altra-sezione' })
    // Il cursore stesso NON si logga: è testo arrivato da fuori.
    expect(JSON.stringify(righe[0][2])).not.toContain(cursorePer(ALTRA_SEZIONE))
  })

  it('…e una forma illeggibile dà l’ALTRA causa: `forma`, anch’essa viva dopo la redazione', async () => {
    // Il controllo negativo del caso qui sopra: senza, `tipo` potrebbe essere una
    // costante cablata («altra-sezione» sempre) e le due asserzioni resterebbero
    // verdi mentre la riga di log non distingue più niente — che è esattamente
    // ciò che faceva la redazione quando la chiave era `motivo`.
    const res = await GET(req(`sectionId=${SEZIONE}&cursore=non-e-base64!!`))
    expect(res.status).toBe(400)
    const righe = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'cursore-non-valido',
    )
    expect(righe).toHaveLength(1)
    expect((redact(righe[0][2]) as { tipo?: unknown }).tipo).toBe('forma')
  })

  it('il cursore della PROPRIA sezione passa (controllo positivo del rifiuto)', async () => {
    // Senza questa riga i casi qui sopra sarebbero verdi anche con un rifiuto
    // cablato che respinge ogni cursore — cioè con la paginazione spenta.
    const res = await GET(req(`sectionId=${SEZIONE}&cursore=${encodeURIComponent(cursorePer(SEZIONE))}`))
    expect(res.status).toBe(200)
    expect(h.creaClient).toHaveBeenCalledTimes(1)
  })

  it('`?cursore=` VUOTO non è un cursore rotto: è la prima pagina', async () => {
    // Stessa ragione degli estremi del periodo: un campo svuotato manda `''`, non
    // un parametro assente, e trattarlo come «cursore illeggibile» trasformerebbe
    // un caso normale in un 400.
    const res = await GET(req(`sectionId=${SEZIONE}&cursore=`))
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: Payload }
    expect(corpo.data.compiti.map((c) => c.id)).toEqual(['reg-1', 'reg-2'])
  })
})

// =============================================================================
// 🔴 IL CURSORE È UN INGRESSO NELLA STRINGA DI `.or()`
//
// `zCursore` (`route.ts`) porta scritto «QUESTO SCHEMA È UN PRESIDIO DI SICUREZZA,
// non una formalità»: i tre valori del cursore finiscono DENTRO la stringa che si
// manda a PostgREST, dove `,` `(` `)` `.` e `"` sono SINTASSI. Fino al 2026-09-19
// era l'unica cosa di quel file senza una prova: sostituendo la regex del campo
// `i` con un `z.string()` nudo la suite restava verde, 57 casi su 57.
//
// E non è un rischio teorico. Con l'alfabeto tolto e il cursore
// `i = "<uuid>),data.gte.1900-01-01,and(id.not.is.null"`:
//
//   ROUTE SANA        → 400 · CORPO_NON_VALIDO · 0 righe
//   ROUTE INDEBOLITA  → 200 · 300 righe · le STESSE 300 della pagina precedente
//
// Il disgiunto iniettato risale al primo livello dell'albero di `.or()` e ANNULLA
// il keyset: la pagina successiva torna identica alla precedente, il client non
// arriva mai alla fine e la linguetta gira a vuoto per sempre. È la perdita
// silenziosa dell'altro verso — non una riga che sparisce, una lista che non
// finisce.
//
// ⚠️ IL CONTROLLO POSITIVO STA QUI DENTRO, in fondo, e non è cortesia: senza, tutto
// questo blocco resterebbe verde spegnendo la paginazione — un rifiuto cablato che
// respinge ogni cursore dà 400 a tutti i casi qui sotto. Il positivo pretende che
// un cursore buono passi E che la seconda pagina sia davvero un'ALTRA pagina.
// =============================================================================
describe('🔴 il cursore non entra come sintassi nella stringa di `.or()`', () => {
  const cursoreDa = (campi: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(campi), 'utf8').toString('base64url')

  /** Un `i` che l'alfabeto di `zCursore` accetta: serve a isolare l'attacco sugli ALTRI campi. */
  const ID_BUONO = '11111111-2222-4333-8444-555555555555'
  const QS = `sectionId=${SEZIONE}&dataDa=${menoGiorni(OGGI, 100)}`

  /**
   * Cursori fabbricati a mano: ognuno, se arrivasse a `.or()`, cambierebbe
   * l'albero logico che la route crede di aver scritto. Sono raggruppati per
   * CAMPO perché è così che si vede che cosa non è coperto: `i` (l'alfabeto),
   * `d` (la regex della data), `o` (l'intero), `v` e `s` (la forma del cursore).
   */
  const CATTIVI: Array<[string, Record<string, unknown>]> = [
    // ─── `i`: la virgola, le parentesi, le virgolette, il punto ───────────────
    ['i con virgola e un disgiunto che prende tutto', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: 'x),data.gte.1900-01-01,and(id.not.is.null' }],
    ['i con un `and(` annidato', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: 'x,and(data.gte.1900-01-01)' }],
    ['i con parentesi e un `or(`', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: `x),or(data.eq."${OGGI}"` }],
    ['i con virgolette', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: 'x"),data.gte."1900-01-01' }],
    ['i con il PUNTO, che in PostgREST separa colonna e operatore', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: 'data.gte.1900-01-01' }],
    ['i vuoto', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: '' }],
    ['i oltre i 64 caratteri', { v: 1, s: SEZIONE, d: OGGI, o: 2, i: 'a'.repeat(300) }],
    // ─── `d`: la data passa da `zDataYMD`, che è anche una regex ──────────────
    ['d con virgola e virgolette', { v: 1, s: SEZIONE, d: `${OGGI}",data.gte."1900-01-01`, o: 2, i: ID_BUONO }],
    ['d con le sole virgolette (chiude quelle della route)', { v: 1, s: SEZIONE, d: `${OGGI}"`, o: 2, i: ID_BUONO }],
    ['d inesistente nel calendario', { v: 1, s: SEZIONE, d: '2026-02-30', o: 2, i: ID_BUONO }],
    // ─── `o`: interpolato NUDO, senza virgolette ──────────────────────────────
    ['o come stringa iniettata', { v: 1, s: SEZIONE, d: OGGI, o: '2),data.gte.1900-01-01,and(id.not.is.null', i: ID_BUONO }],
    ['o frazionario (il punto è un separatore)', { v: 1, s: SEZIONE, d: OGGI, o: 2.5, i: ID_BUONO }],
    ['o NaN', { v: 1, s: SEZIONE, d: OGGI, o: Number.NaN, i: ID_BUONO }],
    // Oltre il numero sicuro `String(n)` passa alla notazione esponenziale:
    // `1.5e+21` porta un punto e un `+` dentro la stringa del filtro.
    ['o oltre il numero sicuro (esce come `1.5e+21`)', { v: 1, s: SEZIONE, d: OGGI, o: 1.5e21, i: ID_BUONO }],
    // ─── `v`: la forma del cursore, non la sintassi del filtro ────────────────
    ['v diverso da 1', { v: 2, s: SEZIONE, d: OGGI, o: 2, i: ID_BUONO }],
    ['v come stringa "1"', { v: '1', s: SEZIONE, d: OGGI, o: 2, i: ID_BUONO }],
  ]

  it.each(CATTIVI)('%s → 400 `CORPO_NON_VALIDO`, e nessuna lettura parte', async (_nome, campi) => {
    const res = await GET(req(`${QS}&cursore=${encodeURIComponent(cursoreDa(campi))}`))
    const corpo = (await res.json()) as { codice?: string }
    expect([res.status, corpo.codice]).toEqual([400, 'CORPO_NON_VALIDO'])
    expect(h.creaClient, 'un cursore rifiutato non deve far nascere il client service-role')
      .not.toHaveBeenCalled()
    expect(h.tabelle, 'e nemmeno una riga di registro deve essere letta').toEqual([])
  })

  it('`s` che non è un uuid è rifiutato per FORMA, non scambiato per un cursore di un’altra classe', async () => {
    // ⚠️ QUESTO CASO NON PUÒ STARE NELLA TABELLA QUI SOPRA, ed è stato spostato
    // dopo averlo visto verde CON e SENZA `zUuid` su `s`. Il motivo è che `s` non
    // entra mai nella stringa di `.or()`: viene confrontato con `sectionId`, e una
    // stringa che uuid non è non può mai essere uguale a un `sectionId` (che
    // `getQuerySchema` ha già validato come uuid). Il 400 arriva comunque —
    // `altra-sezione` invece di `forma` — quindi un'asserzione sul solo stato è
    // decorazione: misura il confronto, non lo schema.
    //
    // Ciò che `zUuid` cambia davvero è la CAUSA, ed è la causa che conta: la riga
    // di log esiste per distinguere «un client che perde i cursori» da «un client
    // che li scambia fra le classi», e archiviare spazzatura come «altra-sezione»
    // sporcherebbe esattamente quel segnale — con l'aggravante che un cursore
    // corrotto sembrerebbe un tentativo di leggere un'altra classe.
    const res = await GET(req(
      `${QS}&cursore=${encodeURIComponent(cursoreDa({ v: 1, s: 'non-un-uuid', d: OGGI, o: 2, i: ID_BUONO }))}`,
    ))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { codice?: string }).codice).toBe('CORPO_NON_VALIDO')
    expect(h.creaClient).not.toHaveBeenCalled()

    const righe = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'cursore-non-valido',
    )
    expect(righe).toHaveLength(1)
    expect((redact(righe[0][2]) as { tipo?: unknown }).tipo).toBe('forma')
  })

  it('`__proto__` come CHIAVE JSON non inquina `Object.prototype` e non cambia l’esito', async () => {
    // Costruito a mano e non con `JSON.stringify({ __proto__: … })`, che di
    // `__proto__` non fa una chiave: imposta il prototipo e il campo sparisce.
    const avvelenato = Buffer.from(
      `{"v":1,"s":"${SEZIONE}","d":"${OGGI}","o":2,"i":"${ID_BUONO}","__proto__":{"inquinato":true}}`,
      'utf8',
    ).toString('base64url')

    const res = await GET(req(`${QS}&cursore=${encodeURIComponent(avvelenato)}`))
    expect(res.status).toBe(200)
    expect(({} as Record<string, unknown>).inquinato).toBeUndefined()
  })

  it('🔑 CONTROLLO POSITIVO: un cursore buono passa E restringe davvero la lettura', async () => {
    // Senza questo caso l'intero blocco sarebbe verde con la paginazione spenta.
    h.db.registro_orario = registroFitto(80, () => true)

    const prima = await corpoOk(QS)
    expect(prima.compiti).toHaveLength(PAGINA_ATTESA)
    expect(prima.prossimoCursore).not.toBeNull()

    const seconda = await corpoOk(`${QS}&cursore=${encodeURIComponent(prima.prossimoCursore!)}`)
    expect(seconda.compiti).toHaveLength(80 * ORE_PEGGIORI_AL_GIORNO - PAGINA_ATTESA)
    // 🔴 Nessuna riga della prima pagina ricompare: è la firma del keyset vivo, ed
    // è esattamente ciò che l'iniezione qui sopra annullerebbe.
    const primi = new Set(prima.compiti.map((c) => c.id))
    expect(seconda.compiti.some((c) => primi.has(c.id))).toBe(false)
  })
})

describe('i gate, e le letture che non devono partire', () => {
  it('403 quando `assertSezioneInScope` rifiuta, e il registro non viene letto', async () => {
    h.assertSezioneInScope.mockResolvedValue(
      NextResponse.json({ error: 'Accesso negato: classe fuori dal tuo plesso' }, { status: 403 }),
    )
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.tabelle, 'dopo un 403 non deve partire nessuna lettura del registro').not.toContain('registro_orario')
  })

  it('il gate di ruolo viene PRIMA del client: dopo un 403 il client non NASCE nemmeno', async () => {
    // `h.tabelle` non bastava: `createAdminClient()` non legge nessuna tabella,
    // quindi spostandolo sopra il gate restavano 22 casi verdi. Qui si guarda la
    // creazione, che è la cosa che non deve avvenire — è service-role e scavalca
    // la RLS.
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'negato' }, { status: 403 }) })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.creaClient).not.toHaveBeenCalled()
    expect(h.tabelle).toEqual([])
    expect(h.assertSezioneInScope).not.toHaveBeenCalled()
  })

  it('…e su una richiesta buona il client NASCE (controllo positivo della spia)', async () => {
    // Senza questo, la spia qui sopra sarebbe verde anche se non fosse collegata
    // a niente: «mai chiamata» e «non esiste» hanno lo stesso colore.
    await elenco()
    expect(h.creaClient).toHaveBeenCalledTimes(1)
  })

  it('400 senza `sectionId`', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(400)
    expect(h.tabelle).toEqual([])
    expect(h.creaClient).not.toHaveBeenCalled()
  })

  it('400 con un `sectionId` che non è un uuid', async () => {
    const res = await GET(req('sectionId=prima-a'))
    expect(res.status).toBe(400)
    expect(h.tabelle).toEqual([])
  })

  it('400 con una data inesistente nel calendario', async () => {
    const res = await GET(req(`sectionId=${SEZIONE}&dataDa=2026-02-30`))
    expect(res.status).toBe(400)
  })
})

describe('PostgREST non lancia: una lettura rotta non si traveste da «nessun compito»', () => {
  it('registro illeggibile ⇒ NON 200 e nessun elenco', async () => {
    h.errori = { registro_orario: { code: 'PGRST301', message: 'permission denied' } }
    const res = await GET(req())
    expect(res.status).not.toBe(200)
    const corpo = (await res.json()) as { data?: unknown; codice?: string }
    expect(corpo.data, 'il client non deve poter leggere un elenco vuoto da una risposta di guasto').toBeUndefined()
    expect(corpo.codice).toBe('LETTURA_FALLITA')
    const righe = h.logEvento.mock.calls.filter(
      (c) => c[1] === 'error' && (c[2] as { esito?: string })?.esito === 'compiti-non-letti',
    )
    expect(righe).toHaveLength(1)
  })

  it('sezione illeggibile ⇒ 500 dichiarato, non un 404 su una riga mai letta', async () => {
    h.errori = { sections: { code: 'PGRST301', message: 'permission denied' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const corpo = (await res.json()) as { codice?: string }
    expect(corpo.codice).toBe('LETTURA_FALLITA')
    const righe = h.logEvento.mock.calls.filter(
      (c) => c[1] === 'error' && (c[2] as { esito?: string })?.esito === 'sezione-non-risolta',
    )
    expect(righe).toHaveLength(1)
  })
})

describe('il catalogo non ribatte il numero della finestra', () => {
  // Il numero della finestra vive in UN posto solo: `GIORNI_MAX_INTERVALLO`. Fino
  // al 2026-09-19 il catalogo ne teneva una seconda copia («al massimo 365 giorni
  // per volta») senza nessun accoppiamento dichiarato, e quella copia è
  // precisamente ciò che è rimasto indietro quando il numero si è mosso: la frase
  // che il docente legge non viene dal server — `PERIODO_TROPPO_LUNGO` non sta in
  // `CODICI_CON_DETTAGLIO`, quindi la prosa della route (che il numero ce l'ha
  // giusto) non arriva mai allo schermo.
  const catalogo = (lingua: 'it' | 'en') =>
    JSON.parse(readFileSync(join(process.cwd(), 'messages', lingua, 'shared.json'), 'utf8')) as Record<string, string>

  it('né in italiano né in inglese la frase contiene una cifra', () => {
    for (const lingua of ['it', 'en'] as const) {
      const frase = catalogo(lingua).errorePeriodoTroppoLungo
      // Controllo positivo: si sta guardando la voce giusta, non una chiave sparita
      // (che renderebbe `undefined` e l'asserzione sotto verde per sbaglio).
      expect(frase, `manca errorePeriodoTroppoLungo in messages/${lingua}/shared.json`).toBeTruthy()
      expect(frase.toLowerCase()).toMatch(lingua === 'it' ? /periodo|intervallo/ : /range/)
      expect(
        frase,
        `«${frase}» ribatte un numero che vive nella route: è la copia che resta indietro`,
      ).not.toMatch(/\d/)
    }
  })
})
