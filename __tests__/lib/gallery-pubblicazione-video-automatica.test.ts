import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================================
// LA PUBBLICAZIONE AUTOMATICA DI UN VIDEO IN GALLERIA — lato server (PR 2, T7).
//
// `pubblicaVideoGalleria` è l'UNICA porta, e la chiama solo il destinatario dell'outbox registrato
// per `gallery.auto_publish`. Qui si prova ciò che decide: le riverifiche (bambino uscito, nessun
// destinatario, liberatoria persa, autore non attivo), l'ordine copia → RPC → marca → notifiche, il
// recupero di un processo morto, i fallimenti e i sessanta minuti.
//
// ─── COME È FATTO IL FINTO DATABASE, E PERCHÉ ────────────────────────────────
// Un mock piatto è verde con e senza la correzione. Qui `alunni` APPLICA i filtri che la query gli
// passa (`.in('id')`, `.eq('scuola_id')`): un bambino «trasferito» è un dato con un'altra sede, non
// una risposta scritta a mano, e se il pubblicatore smettesse di filtrare per sede il test diventa
// rosso. Le RPC sono funzioni che calcolano la risposta dagli argomenti (la pubblicazione risponde
// `n_tag_effettivi` dalla lista che ha ricevuto; la marca è UNA volta sola, come nel database).
// La copia è quella VERA (`copiaVideoInGalleria`) sopra uno Storage finto, così «409 con la stessa
// dimensione» e «copia fallita ⇒ nessuna RPC» sono comportamenti provati e non dichiarati.
//
// ─── COSA NON DEVE USCIRE DA NESSUN LOG ──────────────────────────────────────
// Identificativi di bambini, nomi, percorsi di file. L'ultimo blocco lo prova su tutti gli scenari.
// =============================================================================

const SEDE = '30000000-0000-4000-8000-000000000003'
const ALTRA_SEDE = '30000000-0000-4000-8000-0000000000ff'
const AUTORE = '20000000-0000-4000-8000-000000000002'
const INTENTO = '10000000-0000-4000-8000-000000000001'
const JOB = '40000000-0000-4000-8000-0000000000aa'
const BAMBINO_A = '50000000-0000-4000-8000-00000000000a'
const BAMBINO_B = '50000000-0000-4000-8000-00000000000b'
const BAMBINO_C = '50000000-0000-4000-8000-00000000000c'
const AMMINISTRATORE = '60000000-0000-4000-8000-000000000001'
const SEGRETERIA = '60000000-0000-4000-8000-000000000002'

const PERCORSO_USCITA = `${AUTORE}/${JOB}/1.mp4`
const PERCORSO_GALLERIA = `uploads/${AUTORE}/v-${INTENTO}.mp4`
const BYTE_USCITA = 12_345_678
const ADESSO = Date.parse('2026-10-02T12:00:00.000Z')
const MINUTI = 60_000

type Risposta = { data: unknown; error: unknown }

const h = vi.hoisted(() => ({
  // ── il mondo ──
  intento: null as unknown as Record<string, unknown> | null,
  erroreIntento: null as unknown,
  jobs: [] as Record<string, unknown>[],
  erroreJob: null as unknown,
  alunni: [] as { id: string; scuola_id: string; stato: string | null; consenso_privacy: boolean | null }[],
  /** Gli errori che le PROSSIME letture di `alunni` restituiscono, una per lettura (poi si risponde col dato). */
  erroriAlunni: [] as unknown[],
  autore: null as Record<string, unknown> | null,
  erroriAutore: [] as unknown[],
  media: null as Record<string, unknown> | null,
  erroreMedia: null as unknown,
  /** Gli errori che le PROSSIME letture di `galleria_media_v2` restituiscono, una per lettura (poi si risponde col dato). */
  erroriMedia: [] as unknown[],
  sediAutore: [] as string[],
  degradoLecito: true,
  staff: [] as string[],
  // ── gli spioni ──
  query: [] as { tabella: string; colonne: string; filtri: { m: string; c: string; v: unknown }[]; unaRiga: boolean }[],
  rpc: [] as { nome: string; args: Record<string, unknown> }[],
  ordine: [] as string[],
  notifiche: [] as Record<string, unknown>[],
  copie: [] as { bucket: string; da: string; a: string; opz: unknown }[],
  log: vi.fn(),
  // ── le risposte configurabili ──
  rpcRisposte: {} as Record<string, (args: Record<string, unknown>) => Risposta>,
  marca: null as string | null,
  storageCopy: (() => ({ data: {}, error: null })) as () => { data: unknown; error: unknown },
  storageInfo: (() => ({ data: { size: 0 }, error: null })) as (percorso: string) => { data: unknown; error: unknown },
  degrado: vi.fn(),
  scuoleDiUtente: vi.fn(),
}))

vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: vi.fn(async (_s: unknown, p: Record<string, unknown>) => {
    h.ordine.push(`notifica:${String(p.tipo)}`)
    h.notifiche.push(p)
  }),
}))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => ids.map((id) => `genitore-di-${id}`)),
  genitoriDiClassi: vi.fn(async (_s: unknown, sede: string, classi: string[]) => [`genitori-classi-${sede}-${classi.join('+')}`]),
  genitoriDiScuola: vi.fn(async (_s: unknown, sede: string) => [`genitori-sede-${sede}`]),
  staffScuola: vi.fn(async () => h.staff),
}))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente }))
// Il degrado di sede: la funzione che decide è finta (si prova che venga CHIAMATA solo con la colonna assente), il riconoscimento del codice è quello vero.
vi.mock('@/lib/forms/degrado-sede', async (originale) => ({
  ...(await originale<typeof import('@/lib/forms/degrado-sede')>()),
  degradoSedeLecito: h.degrado,
}))

import { DESTINATARI, consumaOutbox, TIPI_SOLO_DEL_RUNNER } from '@/lib/media/video/outbox'
import { consegnaPubblicazioneAutomatica } from '@/lib/media/video/outbox/destinatari'
import {
  CODICI_PUBBLICAZIONE_VIDEO,
  pubblicaVideoGalleria,
  type OpzioniPubblicazioneVideo,
} from '@/lib/gallery/pubblicazione-video-automatica'
import { CODICI_ESITO_VIDEO } from '@/lib/media/video/contratto'

/* ────────────────────────────────────────────────────────────────────────────
 * IL FINTO CLIENT
 * ──────────────────────────────────────────────────────────────────────────── */

function risposta(q: (typeof h.query)[number]): Risposta {
  const filtro = (m: string, c: string) => q.filtri.find((f) => f.m === m && f.c === c)?.v
  switch (q.tabella) {
    case 'video_intents':
      return { data: h.erroreIntento ? null : h.intento, error: h.erroreIntento }
    case 'video_jobs':
      return { data: h.erroreJob ? null : h.jobs, error: h.erroreJob }
    case 'alunni': {
      const errore = h.erroriAlunni.shift()
      if (errore) return { data: null, error: errore }
      const ids = (filtro('in', 'id') as string[] | undefined) ?? []
      const sede = filtro('eq', 'scuola_id') as string | undefined
      const righe = h.alunni
        .filter((a) => ids.includes(a.id) && (sede === undefined || a.scuola_id === sede))
        .map((a) => ({ id: a.id, stato: a.stato, consenso_privacy: a.consenso_privacy }))
      return { data: righe, error: null }
    }
    case 'utenti': {
      const errore = h.erroriAutore.shift()
      if (errore) return { data: null, error: errore }
      return { data: h.autore, error: null }
    }
    case 'galleria_media_v2': {
      const errore = h.erroriMedia.shift()
      if (errore) return { data: null, error: errore }
      if (h.erroreMedia) return { data: null, error: h.erroreMedia }
      // Il cestino: con `eliminato_il IS NULL` nella query una riga cestinata non torna, come in PostgREST.
      const soloVive = q.filtri.some((f) => f.m === 'is' && f.c === 'eliminato_il' && f.v === null)
      if (soloVive && h.media && h.media.eliminato_il != null) return { data: null, error: null }
      return { data: h.media, error: null }
    }
    default:
      return { data: [], error: null }
  }
}

function fromFinto(tabella: string) {
  const q = { tabella, colonne: '', filtri: [] as { m: string; c: string; v: unknown }[], unaRiga: false }
  h.query.push(q)
  const b: Record<string, unknown> = {}
  b.select = (colonne: string) => {
    q.colonne = colonne
    return b
  }
  for (const m of ['eq', 'in', 'is', 'not', 'order', 'limit']) {
    b[m] = (c: string, v: unknown) => {
      q.filtri.push({ m, c, v })
      return b
    }
  }
  b.maybeSingle = () => {
    q.unaRiga = true
    return Promise.resolve(risposta(q))
  }
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(risposta(q)).then(res, rej)
  return b
}

const RPC_DI_BASE: Record<string, (args: Record<string, unknown>) => Risposta> = {
  video_galleria_pubblica: (a) => ({
    data: {
      ok: true,
      created: true,
      media_id: '70000000-0000-4000-8000-000000000001',
      n_tag: h.intento?.n_tag,
      n_tag_effettivi: (a.p_tag_effettivi as string[]).length,
      broadcast: h.intento?.broadcast,
    },
    error: null,
  }),
  // UNA volta sola, come nel database: la prima chiamata vince, le altre ricevono `segnato: false`.
  video_intent_esito_segna: (a) => {
    if (h.marca !== null) return { data: { ok: true, segnato: false, esito: h.marca }, error: null }
    h.marca = String(a.p_esito)
    return { data: { ok: true, segnato: true, esito: h.marca }, error: null }
  },
  video_intent_pubblicazione_fallita: () => ({
    data: { ok: true, intent: { id: INTENTO, status: 'action_required' } },
    error: null,
  }),
}

const clientFinto = {
  from: fromFinto,
  rpc: async (nome: string, args: Record<string, unknown>) => {
    h.rpc.push({ nome, args })
    h.ordine.push(`rpc:${nome}`)
    const r = h.rpcRisposte[nome] ?? RPC_DI_BASE[nome]
    return r ? r(args) : { data: { ok: true }, error: null }
  },
  storage: {
    from: (bucket: string) => ({
      copy: async (da: string, a: string, opz: unknown) => {
        h.ordine.push('copia')
        h.copie.push({ bucket, da, a, opz })
        return h.storageCopy()
      },
      info: async (percorso: string) => h.storageInfo(percorso),
    }),
  },
} as never

/* ────────────────────────────────────────────────────────────────────────────
 * LO SCENARIO DI PARTENZA: un video pronto, tre bambini in sede, tutti con la liberatoria
 * ──────────────────────────────────────────────────────────────────────────── */

function intentoDi(extra: Record<string, unknown> = {}) {
  return {
    id: INTENTO,
    owner_id: AUTORE,
    scuola_id: SEDE,
    channel: 'gallery',
    status: 'confirmed',
    revision: 1,
    pubblicazione_automatica: true,
    tag_alunni: [BAMBINO_A, BAMBINO_B, BAMBINO_C],
    broadcast: false,
    classi_destinatarie: null,
    n_tag: 3,
    esito_notificato: null,
    pubblicazione_errore: null,
    ...extra,
  }
}

beforeEach(() => {
  h.intento = intentoDi()
  h.erroreIntento = null
  h.jobs = [
    {
      id: JOB,
      status: 'ready',
      output_bucket: 'video_processing',
      output_path: PERCORSO_USCITA,
      output_size: BYTE_USCITA,
      output_deleted_at: null,
    },
  ]
  h.erroreJob = null
  h.alunni = [BAMBINO_A, BAMBINO_B, BAMBINO_C].map((id) => ({
    id,
    scuola_id: SEDE,
    stato: 'iscritto',
    consenso_privacy: true,
  }))
  h.erroriAlunni = []
  h.autore = { id: AUTORE, ruolo: 'educator', role: 'educator', scuola_id: SEDE, archiviato_il: null }
  h.erroriAutore = []
  h.media = null
  h.erroreMedia = null
  h.erroriMedia = []
  h.sediAutore = [SEDE]
  h.degradoLecito = true
  h.staff = []
  h.query = []
  h.rpc = []
  h.ordine = []
  h.notifiche = []
  h.copie = []
  h.log.mockClear()
  h.rpcRisposte = {}
  h.marca = null
  // Lo Storage di partenza: la copia riesce.
  h.storageCopy = () => ({ data: {}, error: null })
  h.storageInfo = () => ({ data: { size: BYTE_USCITA }, error: null })
  h.degrado.mockReset()
  h.degrado.mockImplementation(async () => h.degradoLecito)
  h.scuoleDiUtente.mockReset()
  h.scuoleDiUtente.mockImplementation(async () => h.sediAutore)
})

const pubblica = (opzioni: OpzioniPubblicazioneVideo = {}) =>
  pubblicaVideoGalleria(clientFinto, INTENTO, { adesso: () => ADESSO, ...opzioni })

const logDi = (esito: string) =>
  h.log.mock.calls
    .filter((c) => (c[2] as Record<string, unknown>).esito === esito)
    .map((c) => ({ evento: c[0] as string, livello: c[1] as string, campi: c[2] as Record<string, unknown>, errore: c[3] }))

const rpcDi = (nome: string) => h.rpc.filter((r) => r.nome === nome)
const notificheDi = (tipo: string) => h.notifiche.filter((n) => n.tipo === tipo)

/* ────────────────────────────────────────────────────────────────────────────
 * 1. IL CASO NORMALE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('un video pronto, tutti i bambini ancora in sede: si pubblica e si avvisa', () => {
  it('copia → RPC col percorso restituito dalla copia → marca → avvisi, in questo ordine', async () => {
    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'pubblicato', creato: true, segnato: true, recupero: false })
    // L'ORDINE è la cosa da provare: la RPC data l'uscita a «adesso» senza poter verificare la copia, la marca decide chi notifica.
    expect(h.ordine).toEqual([
      'copia',
      'rpc:video_galleria_pubblica',
      'rpc:video_intent_esito_segna',
      'notifica:galleria',
      'notifica:video_esito',
    ])
  })

  it('la copia parte dal job (bucket, percorso, byte) verso il percorso DETERMINISTICO, con gli id minuscoli', async () => {
    await pubblica()

    expect(h.copie).toEqual([
      { bucket: 'video_processing', da: PERCORSO_USCITA, a: PERCORSO_GALLERIA, opz: { destinationBucket: 'gallery' } },
    ])
  })

  it('la RPC riceve il percorso restituito dalla copia, la revisione dell’intento e i bambini effettivi', async () => {
    await pubblica()

    const [chiamata] = rpcDi('video_galleria_pubblica')
    expect(chiamata.args).toEqual({
      p_intent_id: INTENTO,
      p_revision: 1,
      p_owner_id: AUTORE,
      p_scuola_id: SEDE,
      p_file_url: PERCORSO_GALLERIA,
      p_tag_effettivi: [BAMBINO_A, BAMBINO_B, BAMBINO_C],
    })
  })

  it('la marca è `pubblicato`, e si chiama anche quando la RPC risponde `created: false` (un altro ha già scritto la riga)', async () => {
    h.rpcRisposte.video_galleria_pubblica = () => ({
      data: { ok: true, created: false, media_id: 'm', n_tag: 3, n_tag_effettivi: 3, broadcast: false },
      error: null,
    })

    const esito = await pubblica()

    expect(rpcDi('video_intent_esito_segna').map((r) => r.args)).toEqual([{ p_intent_id: INTENTO, p_esito: 'pubblicato' }])
    expect(esito).toMatchObject({ esito: 'pubblicato', creato: false, segnato: true })
    // Il video è in galleria e la marca era libera: le notifiche partono, una volta.
    expect(notificheDi('video_esito')).toHaveLength(1)
  })

  it('le famiglie sono quelle dei bambini effettivi, col testo che non nomina niente', async () => {
    await pubblica()

    const [genitori] = notificheDi('galleria')
    expect(genitori).toMatchObject({
      tipo: 'galleria',
      scuolaId: SEDE,
      utenteIds: [`genitore-di-${BAMBINO_A}`, `genitore-di-${BAMBINO_B}`, `genitore-di-${BAMBINO_C}`],
      titolo: 'Nuovi contenuti in galleria',
      corpo: 'Ci sono nuovi contenuti nella galleria.',
      // `entitaId` è l'INSEGNANTE, non il video: la chiave del debounce per famiglia (#131).
      entitaId: AUTORE,
    })
  })

  it('l’esito a chi ha caricato: testo fisso, collegamento della sua galleria, nessun buffer, `entitaId` = l’intento', async () => {
    await pubblica()

    const [esito] = notificheDi('video_esito')
    expect(esito).toMatchObject({
      tipo: 'video_esito',
      scuolaId: SEDE,
      utenteIds: [AUTORE],
      titolo: 'Video pubblicato',
      corpo: 'Il tuo video è stato pubblicato in galleria.',
      link: '/teacher/gallery',
      entitaId: INTENTO,
      bufferMin: 0,
    })
    expect(notificheDi('video_liberatoria_revocata')).toEqual([])
  })

  it('il successo si LOGGA, con i conteggi e senza un solo bambino', async () => {
    await pubblica()

    const [riga] = logDi('pubblicazione-automatica-riuscita')
    expect(riga.livello).toBe('info')
    expect(riga.evento).toBe('galleria')
    expect(riga.campi).toMatchObject({
      intent_id: INTENTO,
      sede_id: SEDE,
      n_tag: 3,
      n_tag_effettivi: 3,
      n_usciti: 0,
      n_senza_liberatoria: 0,
      creato: true,
      segnato: true,
      famiglie_avvisate: 3,
      recupero: false,
    })
  })

  it('un id MAIUSCOLO (dell’autore e dell’intento) non sporca il percorso: la RPC lo confronta col testo MINUSCOLO del database (#46)', async () => {
    // Id con LETTERE esadecimali: con i soli numeri `toUpperCase()` non cambierebbe niente e questa prova non proverebbe niente.
    const autore = 'abcdef00-0000-4000-8000-00000000000d'
    const intento = 'a1b2c3d4-0000-4000-8000-00000000000e'
    h.intento = intentoDi({ id: intento.toUpperCase(), owner_id: autore.toUpperCase() })

    await pubblicaVideoGalleria(clientFinto, intento.toUpperCase(), { adesso: () => ADESSO })

    expect(h.copie[0].a).toBe(`uploads/${autore}/v-${intento}.mp4`)
    const rpc = rpcDi('video_galleria_pubblica')[0].args
    expect(rpc.p_owner_id).toBe(autore)
    expect(rpc.p_file_url).toBe(`uploads/${autore}/v-${intento}.mp4`)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2. LE RIVERIFICHE (spec §8.2)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('bambini usciti dal perimetro: si pubblica senza di loro', () => {
  it('un bambino trasferito e uno ritirato si TOLGONO: la RPC riceve solo chi resta, e l’insegnante legge il numero', async () => {
    h.alunni = [
      { id: BAMBINO_A, scuola_id: SEDE, stato: 'iscritto', consenso_privacy: true },
      { id: BAMBINO_B, scuola_id: ALTRA_SEDE, stato: 'iscritto', consenso_privacy: true },
      { id: BAMBINO_C, scuola_id: SEDE, stato: 'ritirato', consenso_privacy: true },
    ]

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true })
    expect(rpcDi('video_galleria_pubblica')[0].args.p_tag_effettivi).toEqual([BAMBINO_A])
    expect(notificheDi('video_esito')[0]).toMatchObject({
      corpo: 'Il tuo video è stato pubblicato in galleria. 2 bambini non sono più nella sede e non lo vedranno.',
    })
    // Le famiglie di chi è uscito NON vengono avvisate: nessun contenuto per loro.
    expect(notificheDi('galleria')[0].utenteIds).toEqual([`genitore-di-${BAMBINO_A}`])
    const [riga] = logDi('pubblicato-senza-bambini-usciti')
    expect(riga.campi).toMatchObject({ intent_id: INTENTO, n_usciti: 2, n_tag: 3 })
    expect(logDi('pubblicazione-automatica-riuscita')[0].campi).toMatchObject({ n_tag_effettivi: 1, n_usciti: 2 })
  })

  it('la lettura chiede la SEDE dell’intento e le sole colonne che servono: mai nome e cognome', async () => {
    await pubblica()

    const lettura = h.query.find((q) => q.tabella === 'alunni')
    expect(lettura).toBeDefined()
    expect(lettura?.filtri).toEqual(
      expect.arrayContaining([
        { m: 'in', c: 'id', v: [BAMBINO_A, BAMBINO_B, BAMBINO_C] },
        { m: 'eq', c: 'scuola_id', v: SEDE },
      ]),
    )
    expect(lettura?.colonne.split(',').map((c) => c.trim()).sort()).toEqual(['consenso_privacy', 'id', 'stato'])
  })

  it('il singolare è corretto: «1 bambino non è più nella sede e non lo vedrà»', async () => {
    h.alunni[2] = { ...h.alunni[2], scuola_id: ALTRA_SEDE }

    await pubblica()

    expect(notificheDi('video_esito')[0].corpo).toBe(
      'Il tuo video è stato pubblicato in galleria. 1 bambino non è più nella sede e non lo vedrà.',
    )
  })

  it('NESSUN bambino rimasto e non è un broadcast: NON si pubblica, niente copia e niente RPC di pubblicazione', async () => {
    h.alunni = h.alunni.map((a) => ({ ...a, scuola_id: ALTRA_SEDE }))

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'non-pubblicato', codice: 'NESSUN_DESTINATARIO', segnato: true })
    expect(h.copie).toEqual([])
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
    // L'intento passa ad `action_required` con QUEL codice, poi la marca `fallito`, poi — solo con la marca vinta — la notifica.
    expect(rpcDi('video_intent_pubblicazione_fallita').map((r) => r.args)).toEqual([
      { p_intent_id: INTENTO, p_codice: 'NESSUN_DESTINATARIO' },
    ])
    expect(rpcDi('video_intent_esito_segna').map((r) => r.args)).toEqual([{ p_intent_id: INTENTO, p_esito: 'fallito' }])
    expect(h.ordine).toEqual([
      'rpc:video_intent_pubblicazione_fallita',
      'rpc:video_intent_esito_segna',
      'notifica:video_esito',
    ])
    expect(notificheDi('video_esito')[0]).toMatchObject({
      titolo: 'Video non pubblicato',
      corpo: 'Il video non è stato pubblicato: nessuno dei bambini scelti è ancora nella sede.',
      entitaId: INTENTO,
    })
    // E nessuna famiglia viene avvisata di un contenuto che non c'è.
    expect(notificheDi('galleria')).toEqual([])
    expect(logDi('non-pubblicato-nessun-destinatario')[0].campi).toMatchObject({ intent_id: INTENTO, n_tag: 3 })
  })

  it('un BROADCAST senza bambini si pubblica: nessuna lettura di `alunni`, le famiglie sono quelle della sede', async () => {
    h.intento = intentoDi({ broadcast: true, tag_alunni: [], n_tag: 0 })

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true })
    expect(h.query.filter((q) => q.tabella === 'alunni')).toEqual([])
    expect(rpcDi('video_galleria_pubblica')[0].args.p_tag_effettivi).toEqual([])
    expect(notificheDi('galleria')[0].utenteIds).toEqual([`genitori-sede-${SEDE}`])
    // Un broadcast non ha bambini da togliere.
    expect(notificheDi('video_esito')[0].corpo).toBe('Il tuo video è stato pubblicato in galleria.')
  })

  it('un broadcast per CLASSI avvisa le famiglie di quelle classi', async () => {
    h.intento = intentoDi({ broadcast: true, tag_alunni: [], n_tag: 0, classi_destinatarie: ['2 ANNI'] })

    await pubblica()

    expect(notificheDi('galleria')[0].utenteIds).toEqual([`genitori-classi-${SEDE}-2 ANNI`])
  })

  it('un guasto di LETTURA dei bambini non pubblica a nessuno e non a tutti: si ripete', async () => {
    h.erroriAlunni = [{ code: '57014', message: 'canceled' }]

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'PERIMETRO_NON_LETTO' })
    expect(h.copie).toEqual([])
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
    expect(rpcDi('video_intent_esito_segna')).toEqual([])
  })

  it('la colonna di sede assente (database E2E non migrato) degrada SOLO se il degrado è lecito', async () => {
    h.erroriAlunni = [{ code: '42703', message: 'column alunni.scuola_id does not exist' }]
    h.degradoLecito = true

    const lecito = await pubblica()
    expect(lecito).toMatchObject({ esito: 'pubblicato' })
    expect(h.degrado).toHaveBeenCalledTimes(1)
    // La rilettura è SENZA il filtro di sede, e solo quello cade.
    const letture = h.query.filter((q) => q.tabella === 'alunni')
    expect(letture).toHaveLength(2)
    expect(letture[1].filtri.some((f) => f.c === 'scuola_id')).toBe(false)
    expect(letture[1].filtri.some((f) => f.c === 'id')).toBe(true)

    // In un impianto multi-sede il degrado è NEGATO: nessuna pubblicazione.
    h.rpc = []
    h.marca = null
    h.erroriAlunni = [{ code: '42703', message: 'column alunni.scuola_id does not exist' }]
    h.degradoLecito = false
    const negato = await pubblica()
    expect(negato).toEqual({ esito: 'da-ripetere', codice: 'VERIFICA_SEDE_NEGATA' })
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
  })
})

describe('la liberatoria persa fra l’invio e la pubblicazione: il video esce comunque, e la sicurezza lo sa', () => {
  beforeEach(() => {
    h.staff = [AMMINISTRATORE, SEGRETERIA]
    h.alunni[1] = { ...h.alunni[1], consenso_privacy: false }
  })

  it('il bambino senza liberatoria RESTA fra i destinatari', async () => {
    await pubblica()

    expect(rpcDi('video_galleria_pubblica')[0].args.p_tag_effettivi).toEqual([BAMBINO_A, BAMBINO_B, BAMBINO_C])
  })

  it('parte l’avviso `video_liberatoria_revocata` a chi ha caricato e a admin/coordinator/segreteria, col SOLO numero', async () => {
    await pubblica()

    const avvisi = notificheDi('video_liberatoria_revocata')
    expect(avvisi).toHaveLength(2)
    const corpo = 'Un video è stato pubblicato in galleria con 1 bambino senza liberatoria fotografica.'
    expect(avvisi[0]).toMatchObject({
      utenteIds: [AUTORE],
      titolo: 'Video pubblicato senza liberatoria',
      corpo,
      link: '/teacher/gallery',
      entitaId: INTENTO,
      scuolaId: SEDE,
    })
    expect(avvisi[1]).toMatchObject({ utenteIds: [AMMINISTRATORE, SEGRETERIA], corpo, link: '/admin/gallery' })
    const staffScuola = (await import('@/lib/notifiche/destinatari')).staffScuola as unknown as ReturnType<typeof vi.fn>
    expect(staffScuola).toHaveBeenCalledWith(clientFinto, SEDE, ['admin', 'coordinator', 'segreteria'])
    expect(logDi('pubblicato-senza-liberatoria')[0].campi).toMatchObject({ intent_id: INTENTO, n_senza_liberatoria: 1 })
  })

  it('il plurale: due bambini senza liberatoria', async () => {
    h.alunni[2] = { ...h.alunni[2], consenso_privacy: null }

    await pubblica()

    expect(notificheDi('video_liberatoria_revocata')[0].corpo).toBe(
      'Un video è stato pubblicato in galleria con 2 bambini senza liberatoria fotografica.',
    )
  })

  it('chi ha caricato e fa parte della segreteria riceve UN avviso solo, col suo collegamento', async () => {
    h.staff = [AUTORE, SEGRETERIA]

    await pubblica()

    const avvisi = notificheDi('video_liberatoria_revocata')
    expect(avvisi.map((a) => a.utenteIds)).toEqual([[AUTORE], [SEGRETERIA]])
  })

  it('un SOLO bambino rimasto senza liberatoria non fa scattare l’avviso: è la regola della «foto privata»', async () => {
    h.intento = intentoDi({ tag_alunni: [BAMBINO_B], n_tag: 1 })

    await pubblica()

    expect(notificheDi('video_liberatoria_revocata')).toEqual([])
    expect(logDi('pubblicazione-automatica-riuscita')[0].campi).toMatchObject({ n_senza_liberatoria: 0 })
  })

  it('chi è uscito dalla sede NON conta come «senza liberatoria»: si toglie prima', async () => {
    h.alunni[1] = { ...h.alunni[1], scuola_id: ALTRA_SEDE }

    await pubblica()

    expect(notificheDi('video_liberatoria_revocata')).toEqual([])
  })

  it('un guasto di lettura dei consensi non diventa un falso allarme alla Direzione: si ripete', async () => {
    h.erroriAlunni = [{ code: '57014', message: 'canceled' }]

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'da-ripetere' })
    expect(notificheDi('video_liberatoria_revocata')).toEqual([])
  })
})

describe('chi ha caricato: disattivato o senza più la sede, il video si pubblica COMUNQUE', () => {
  it('un autore archiviato non ferma niente, e lo dice il log', async () => {
    h.autore = { id: AUTORE, ruolo: 'educator', role: 'educator', scuola_id: SEDE, archiviato_il: '2026-09-30T10:00:00Z' }

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true })
    const [riga] = logDi('autore-non-attivo')
    expect(riga.livello).toBe('info')
    expect(riga.campi).toMatchObject({ intent_id: INTENTO, sede_id: SEDE, archiviato: true, con_sede: true })
  })

  it('un autore che non ha più la sede dell’intento non ferma niente', async () => {
    h.sediAutore = [ALTRA_SEDE]

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato' })
    expect(logDi('autore-non-attivo')[0].campi).toMatchObject({ archiviato: false, con_sede: false })
  })

  it('un autore attivo e con la sede non lascia nessuna riga `autore-non-attivo`', async () => {
    await pubblica()

    expect(logDi('autore-non-attivo')).toEqual([])
  })

  it('`archiviato_il` assente dallo schema: si rilegge senza e non si ferma nemmeno questo', async () => {
    h.erroriAutore = [{ code: '42703', message: 'column utenti.archiviato_il does not exist' }]

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato' })
    const letture = h.query.filter((q) => q.tabella === 'utenti')
    expect(letture).toHaveLength(2)
    expect(letture[0].colonne).toContain('archiviato_il')
    expect(letture[1].colonne).not.toContain('archiviato_il')
  })

  it('una lettura dell’autore che fallisce non ferma la pubblicazione: `warn`, e il collegamento ripiega sull’area docente', async () => {
    h.erroriAutore = [{ code: '57014', message: 'canceled' }]

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true })
    expect(logDi('autore-non-letto')[0].livello).toBe('warn')
    expect(notificheDi('video_esito')[0].link).toBe('/teacher/gallery')
  })

  it('un autore della segreteria riceve il collegamento alla galleria della segreteria', async () => {
    h.autore = { id: AUTORE, ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE, archiviato_il: null }

    await pubblica()

    expect(notificheDi('video_esito')[0].link).toBe('/admin/gallery')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 3. LA COPIA, E LA RPC SOLO A COPIA RIUSCITA (#40)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('la copia: la RPC si chiama SOLO se è riuscita', () => {
  it('una copia che fallisce NON porta alla RPC: nessun file di lavoro datato senza una copia in galleria', async () => {
    h.storageCopy = () => ({ data: null, error: { status: 500, message: 'storage non raggiungibile' } })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'COPIA_NON_RIUSCITA' })
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
    expect(rpcDi('video_intent_esito_segna')).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it('il 409 «esiste già» con la STESSA dimensione vale come copia riuscita, e la RPC parte', async () => {
    h.storageCopy = () => ({ data: null, error: { status: 409, message: 'The resource already exists' } })
    h.storageInfo = () => ({ data: { size: BYTE_USCITA }, error: null })

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true })
    expect(rpcDi('video_galleria_pubblica')[0].args.p_file_url).toBe(PERCORSO_GALLERIA)
  })

  it('il 409 con una dimensione DIVERSA non si adotta: un file qualunque sotto il nome di un video di un minore', async () => {
    h.storageCopy = () => ({ data: null, error: { status: 409, message: 'The resource already exists' } })
    h.storageInfo = () => ({ data: { size: BYTE_USCITA + 1 }, error: null })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'DESTINAZIONE_DIVERSA' })
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
  })

  it.each(['failed', 'rejected', 'cancelled'])(
    'un job finito male DOPO l’evento (`%s`, per esempio l’originale sostituito) non si ritenta per un’ora: niente da pubblicare, l’evento si consegna',
    async (stato) => {
      h.jobs = [{ ...h.jobs[0], status: stato, output_path: null, output_bucket: null }]

      const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 5 * MINUTI).toISOString() })

      expect(esito).toEqual({ esito: 'gia-concluso', stato: `job-${stato}` })
      // Nessuna copia, nessuna RPC, nessuna marca, nessuna notifica: l'esito a chi ha caricato lo dà la scansione, col difetto vero.
      expect(h.copie).toEqual([])
      expect(h.rpc).toEqual([])
      expect(h.notifiche).toEqual([])
      expect(logDi('pubblicazione-saltata')[0].campi).toMatchObject({ intent_id: INTENTO, stato: `job-${stato}` })
    },
  )

  it('…e non si arriva mai al «pubblicazione non riuscita» a 61 minuti: un job concluso non è un guasto che dura', async () => {
    h.jobs = [{ ...h.jobs[0], status: 'rejected' }]

    const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 61 * MINUTI).toISOString() })

    expect(esito).toEqual({ esito: 'gia-concluso', stato: 'job-rejected' })
    expect(rpcDi('video_intent_pubblicazione_fallita')).toEqual([])
  })

  it('un job non ancora `ready`, o senza l’uscita, non si copia', async () => {
    h.jobs = [{ ...h.jobs[0], status: 'processing' }]
    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'JOB_NON_PRONTO' })

    h.jobs = [{ ...h.jobs[0], status: 'ready', output_deleted_at: '2026-10-01T00:00:00Z' }]
    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'USCITA_ASSENTE' })

    h.jobs = []
    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'JOB_ASSENTE' })
    expect(h.copie).toEqual([])
  })
})

describe('la RPC di pubblicazione che rifiuta o non risponde: si ripete, e non si notifica', () => {
  it('`TAG_NON_DELL_INTENTO` (un oblio arrivato fra la riverifica e la RPC) è un guasto transitorio', async () => {
    h.rpcRisposte.video_galleria_pubblica = () => ({ data: { ok: false, code: 'TAG_NON_DELL_INTENTO' }, error: null })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'TAG_NON_DELL_INTENTO' })
    expect(rpcDi('video_intent_esito_segna')).toEqual([])
    expect(rpcDi('video_intent_pubblicazione_fallita')).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it('un errore di PostgREST (o di rete) è `RPC_PUBBLICA_FALLITA`: nessuna eccezione verso l’outbox', async () => {
    h.rpcRisposte.video_galleria_pubblica = () => ({ data: null, error: { code: '57014', message: 'canceled' } })

    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'RPC_PUBBLICA_FALLITA' })
  })

  it('una RPC che LANCIA (guasto di trasporto) si comporta come un errore restituito', async () => {
    h.rpcRisposte.video_galleria_pubblica = () => {
      throw new Error('fetch failed')
    }

    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'RPC_PUBBLICA_FALLITA' })
  })

  it('ogni guasto lascia una riga `warn` col codice, e senza un solo bambino', async () => {
    h.rpcRisposte.video_galleria_pubblica = () => ({ data: { ok: false, code: 'INTENT_REVOKED' }, error: null })

    await pubblica()

    const [riga] = logDi('pubblicazione-automatica-fallita')
    expect(riga.livello).toBe('warn')
    expect(riga.campi).toMatchObject({ intent_id: INTENTO, error_code: 'INTENT_REVOKED', definitiva: false })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 4. LA MARCA: SOLO CHI LA VINCE NOTIFICA (spec §8.4)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('la marca decide chi manda le notifiche', () => {
  it('con `segnato: false` il video è comunque in galleria ma NESSUNA notifica parte', async () => {
    h.marca = 'pubblicato' // un altro l'ha già segnata

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'pubblicato', creato: true, segnato: false, recupero: false })
    expect(h.notifiche).toEqual([])
    expect(logDi('pubblicazione-automatica-riuscita')[0].campi).toMatchObject({ segnato: false, famiglie_avvisate: null })
  })

  it('una marca che non si riesce a scrivere NON si prende per «vinta» e non si notifica: il giro dopo riprova dal recupero', async () => {
    h.rpcRisposte.video_intent_esito_segna = () => ({ data: null, error: { code: '57014', message: 'canceled' } })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'MARCA_NON_SCRITTA' })
    expect(h.notifiche).toEqual([])
    // La riga di galleria è scritta: lo dice la RPC, che è già stata chiamata.
    expect(rpcDi('video_galleria_pubblica')).toHaveLength(1)
  })

  it('due giri di fila sullo stesso intento: le notifiche partono UNA volta sola', async () => {
    await pubblica()
    const prima = h.notifiche.length
    expect(prima).toBeGreaterThan(0)

    // Il giro dopo trova l'intento già pubblicato e la marca già scritta (è la fotografia che il database avrebbe).
    h.intento = intentoDi({ status: 'published', esito_notificato: 'pubblicato', tag_alunni: [] })
    const secondo = await pubblica()

    expect(secondo).toEqual({ esito: 'gia-concluso', stato: 'published' })
    expect(h.notifiche).toHaveLength(prima)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 5. IL RECUPERO (#45, #80)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il recupero di un processo morto dopo la RPC (#45)', () => {
  const MEDIA = {
    id: '70000000-0000-4000-8000-000000000001',
    tag_students: [BAMBINO_A, BAMBINO_B],
    is_broadcast: false,
    target_classes: null,
  }

  beforeEach(() => {
    // Il database dopo la RPC: intento `published`, tag svuotati (minimizzati), marca ancora libera.
    h.intento = intentoDi({ status: 'published', tag_alunni: [] })
    h.media = MEDIA
  })

  it('NIENTE copia e NIENTE RPC di pubblicazione: si va dritti alla marca', async () => {
    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'pubblicato', creato: false, segnato: true, recupero: true })
    expect(h.copie).toEqual([])
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
    expect(rpcDi('video_intent_esito_segna').map((r) => r.args)).toEqual([{ p_intent_id: INTENTO, p_esito: 'pubblicato' }])
    // Nemmeno il job si legge: la purga potrebbe aver tolto l'uscita, e non serve più.
    expect(h.query.filter((q) => q.tabella === 'video_jobs')).toEqual([])
  })

  it('i destinatari si leggono dalla RIGA di galleria (l’intento non ha più i bambini), e le notifiche partono', async () => {
    await pubblica()

    const lettura = h.query.find((q) => q.tabella === 'galleria_media_v2')
    expect(lettura?.filtri).toEqual(
      expect.arrayContaining([
        { m: 'eq', c: 'upload_id', v: INTENTO },
        { m: 'eq', c: 'uploaded_by', v: AUTORE },
        { m: 'eq', c: 'scuola_id', v: SEDE },
      ]),
    )
    expect(notificheDi('galleria')[0].utenteIds).toEqual([`genitore-di-${BAMBINO_A}`, `genitore-di-${BAMBINO_B}`])
    // n_tag 3 scelti, 2 nella riga: uno non l'ha visto.
    expect(notificheDi('video_esito')[0].corpo).toBe(
      'Il tuo video è stato pubblicato in galleria. 1 bambino non è più nella sede e non lo vedrà.',
    )
    expect(logDi('pubblicazione-automatica-riuscita')[0].campi).toMatchObject({ recupero: true, segnato: true })
  })

  it('con la marca GIÀ scritta non c’è niente da fare: l’evento si consegna e nessuno è avvisato due volte', async () => {
    h.intento = intentoDi({ status: 'published', esito_notificato: 'pubblicato', tag_alunni: [] })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'gia-concluso', stato: 'published' })
    expect(h.rpc).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it('la riga di galleria si legge SOLO se viva (`eliminato_il IS NULL`): il lock del cestino lo pretende per ogni lettura', async () => {
    await pubblica()

    const lettura = h.query.find((q) => q.tabella === 'galleria_media_v2')
    expect(lettura?.filtri).toEqual(expect.arrayContaining([{ m: 'is', c: 'eliminato_il', v: null }]))
  })

  it('un video che l’insegnante ha già messo nel CESTINO non si annuncia alle famiglie: l’insegnante lo sa, nessun contenuto da mostrare', async () => {
    h.media = { ...MEDIA, eliminato_il: '2026-10-02T09:00:00Z' }

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true, recupero: true })
    expect(notificheDi('galleria')).toEqual([])
    expect(notificheDi('video_esito')).toHaveLength(1)
    expect(logDi('recupero-media-assente')).toHaveLength(1)
  })

  it('`eliminato_il` assente dallo schema (database E2E non migrato): si rilegge senza il filtro, e le famiglie sono avvisate', async () => {
    h.erroriMedia = [{ code: '42703', message: 'column galleria_media_v2.eliminato_il does not exist' }]

    await pubblica()

    const letture = h.query.filter((q) => q.tabella === 'galleria_media_v2')
    expect(letture).toHaveLength(2)
    expect(letture[0].filtri.some((f) => f.c === 'eliminato_il')).toBe(true)
    expect(letture[1].filtri.some((f) => f.c === 'eliminato_il')).toBe(false)
    expect(notificheDi('galleria')).toHaveLength(1)
  })

  it('la riga di galleria illeggibile: si ripete, SENZA marcare (la marca scritta a vuoto perderebbe l’avviso alle famiglie)', async () => {
    h.erroreMedia = { code: '57014', message: 'canceled' }

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'MEDIA_NON_LETTO' })
    expect(rpcDi('video_intent_esito_segna')).toEqual([])
  })

  it('…ma dopo un’ora si smette di aspettare: si marca e si avvisa l’insegnante, e l’avviso alle famiglie si perde (a voce alta)', async () => {
    h.erroreMedia = { code: '57014', message: 'canceled' }

    const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 61 * MINUTI).toISOString() })

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true, recupero: true })
    expect(notificheDi('galleria')).toEqual([])
    expect(notificheDi('video_esito')).toHaveLength(1)
    expect(logDi('recupero-media-non-letta')[0].livello).toBe('error')
  })

  it('la riga di galleria sparita (cestino purgato): si marca e si avvisa l’insegnante, nessuna famiglia', async () => {
    h.media = null

    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'pubblicato', segnato: true, recupero: true })
    expect(notificheDi('galleria')).toEqual([])
    expect(notificheDi('video_esito')[0].corpo).toBe('Il tuo video è stato pubblicato in galleria.')
  })

  it('anche nel recupero la liberatoria si conta, sui bambini della riga', async () => {
    h.alunni[0] = { ...h.alunni[0], consenso_privacy: false }
    h.staff = [SEGRETERIA]

    await pubblica()

    expect(notificheDi('video_liberatoria_revocata')[0].corpo).toContain('con 1 bambino senza liberatoria')
  })
})

describe('l’intento non è più pubblicabile: niente da fare, e l’evento si consegna (#80)', () => {
  it.each(['cancelled', 'superseded', 'pending'])('stato `%s`: nessuna copia, nessuna RPC, nessuna notifica', async (stato) => {
    h.intento = intentoDi({ status: stato })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'gia-concluso', stato })
    expect(h.copie).toEqual([])
    expect(h.rpc).toEqual([])
    expect(h.notifiche).toEqual([])
    expect(logDi('pubblicazione-saltata')[0].campi).toMatchObject({ intent_id: INTENTO, stato })
  })

  it('`action_required` con l’esito già segnato è il caso normale di una pubblicazione fallita: niente da fare', async () => {
    h.intento = intentoDi({ status: 'action_required', esito_notificato: 'fallito', pubblicazione_errore: 'PUBBLICAZIONE_NON_RIUSCITA' })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'gia-concluso', stato: 'action_required' })
    expect(h.rpc).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it('`action_required` SENZA la marca (un processo è morto dopo «fallita»): si completa la strada e l’insegnante viene avvisata', async () => {
    h.intento = intentoDi({ status: 'action_required', pubblicazione_errore: 'PUBBLICAZIONE_NON_RIUSCITA' })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'non-pubblicato', codice: 'PUBBLICAZIONE_NON_RIUSCITA', segnato: true })
    expect(h.copie).toEqual([])
    expect(rpcDi('video_galleria_pubblica')).toEqual([])
    expect(notificheDi('video_esito')[0]).toMatchObject({
      titolo: 'Video non pubblicato',
      corpo: 'Non siamo riusciti a pubblicare il video: apri la galleria e premi «Riprova».',
    })
  })

  it('…e col codice `NESSUN_DESTINATARIO` il testo è quello del «nessun bambino rimasto», senza il «Riprova»', async () => {
    h.intento = intentoDi({ status: 'action_required', pubblicazione_errore: 'NESSUN_DESTINATARIO' })

    await pubblica()

    expect(notificheDi('video_esito')[0].corpo).toBe(
      'Il video non è stato pubblicato: nessuno dei bambini scelti è ancora nella sede.',
    )
  })

  it('un intento che non è di galleria o non è automatico non si consegna mai: si grida e si chiude, niente quarantena', async () => {
    h.intento = intentoDi({ pubblicazione_automatica: false })

    const esito = await pubblica()

    expect(esito).toEqual({ esito: 'gia-concluso', stato: 'fuori-contratto' })
    expect(logDi('pubblicazione-evento-fuori-contratto')[0].livello).toBe('error')
    expect(h.rpc).toEqual([])
  })

  it('un intento illeggibile o assente si ripete (e si grida): non si inventa una decisione', async () => {
    h.erroreIntento = { code: '57014', message: 'canceled' }
    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'INTENTO_NON_LETTO' })

    h.erroreIntento = null
    h.intento = null
    expect(await pubblica()).toEqual({ esito: 'da-ripetere', codice: 'INTENTO_ASSENTE' })
    expect(logDi('pubblicazione-intento-non-letto').every((r) => r.livello === 'error')).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 6. I SESSANTA MINUTI (spec §8.5)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('un guasto che dura oltre i sessanta minuti diventa definitivo', () => {
  beforeEach(() => {
    h.storageCopy = () => ({ data: null, error: { status: 500, message: 'storage non raggiungibile' } })
  })

  it('a 59 minuti dalla nascita dell’evento si ripete ancora', async () => {
    const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 59 * MINUTI).toISOString() })

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'COPIA_NON_RIUSCITA' })
    expect(rpcDi('video_intent_pubblicazione_fallita')).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it('a 61 minuti: `PUBBLICAZIONE_NON_RIUSCITA`, marca `fallito`, notifica col «Riprova», evento chiuso', async () => {
    const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 61 * MINUTI).toISOString() })

    expect(esito).toEqual({ esito: 'non-pubblicato', codice: 'PUBBLICAZIONE_NON_RIUSCITA', segnato: true })
    expect(rpcDi('video_intent_pubblicazione_fallita').map((r) => r.args)).toEqual([
      { p_intent_id: INTENTO, p_codice: 'PUBBLICAZIONE_NON_RIUSCITA' },
    ])
    expect(rpcDi('video_intent_esito_segna').map((r) => r.args)).toEqual([{ p_intent_id: INTENTO, p_esito: 'fallito' }])
    expect(notificheDi('video_esito')[0]).toMatchObject({
      titolo: 'Video non pubblicato',
      corpo: 'Non siamo riusciti a pubblicare il video: apri la galleria e premi «Riprova».',
    })
    const [riga] = logDi('pubblicazione-automatica-fallita')
    expect(riga.livello).toBe('error')
    expect(riga.campi).toMatchObject({ error_code: 'COPIA_NON_RIUSCITA', definitiva: true })
  })

  it('senza la data dell’evento non si abbandona mai: «non so quanto è vecchio» non vale «è vecchio»', async () => {
    const esito = await pubblica()

    expect(esito).toMatchObject({ esito: 'da-ripetere' })
  })

  it('se nel frattempo l’intento è stato pubblicato o ritirato, la RPC «fallita» lo dice e NON si marca niente', async () => {
    h.rpcRisposte.video_intent_pubblicazione_fallita = () => ({ data: { ok: false, code: 'INTENT_PUBLISHED' }, error: null })

    const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 90 * MINUTI).toISOString() })

    expect(esito).toEqual({ esito: 'da-ripetere', codice: 'INTENT_PUBLISHED' })
    expect(rpcDi('video_intent_esito_segna')).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it('con la marca già vinta da un altro la notifica non parte, ma l’evento si chiude', async () => {
    h.marca = 'fallito'

    const esito = await pubblica({ eventoCreatoIl: new Date(ADESSO - 61 * MINUTI).toISOString() })

    expect(esito).toEqual({ esito: 'non-pubblicato', codice: 'PUBBLICAZIONE_NON_RIUSCITA', segnato: false })
    expect(h.notifiche).toEqual([])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 7. IL DESTINATARIO DELL'OUTBOX, e il registro
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il destinatario di `gallery.auto_publish`', () => {
  const evento = (extra: Record<string, unknown> = {}) => ({
    id: 'e1',
    intent_id: INTENTO,
    revision: 1,
    event_type: 'gallery.auto_publish',
    attempts: 3,
    // L'orologio del destinatario è quello VERO (non gli passa `adesso`): l'età dell'evento si costruisce da `Date.now()`, mai da una data cablata.
    created_at: new Date(Date.now() - 5 * MINUTI).toISOString(),
    ...extra,
  })
  const contesto = { operazione: 'video-runner' }

  it('è registrato nel registro, ed è la consegna della pubblicazione', () => {
    expect(DESTINATARI['gallery.auto_publish']).toBe(consegnaPubblicazioneAutomatica)
  })

  it('un video pubblicato è `consegnato`: l’evento si chiude', async () => {
    const esito = await consegnaPubblicazioneAutomatica(clientFinto, evento(), contesto)

    expect(esito).toEqual({ consegnato: true })
  })

  it('un guasto che può passare NON è consegnato, e porta il codice che l’outbox scrive sul suo tentativo', async () => {
    h.storageCopy = () => ({ data: null, error: { status: 500, message: 'x' } })

    const esito = await consegnaPubblicazioneAutomatica(clientFinto, evento(), contesto)

    expect(esito).toEqual({ consegnato: false, codice: 'COPIA_NON_RIUSCITA' })
  })

  it('un intento ritirato è «niente da fare», quindi consegnato', async () => {
    h.intento = intentoDi({ status: 'cancelled' })

    expect(await consegnaPubblicazioneAutomatica(clientFinto, evento(), contesto)).toEqual({ consegnato: true })
  })

  it('porta nei log l’operazione del consumatore, e l’età dell’evento decide i sessanta minuti', async () => {
    h.storageCopy = () => ({ data: null, error: { status: 500, message: 'x' } })

    // L'età viene dall'evento (`created_at`), non dall'orologio del processo: un evento vecchio di due ore diventa definitivo.
    const vecchio = await consegnaPubblicazioneAutomatica(
      clientFinto,
      evento({ created_at: new Date(Date.now() - 120 * MINUTI).toISOString() }),
      contesto,
    )

    expect(vecchio).toEqual({ consegnato: true })
    expect(logDi('pubblicazione-automatica-fallita')[0].campi).toMatchObject({ operazione: 'video-runner', n_tentativi: 3, definitiva: true })
  })

  it('i codici che il modulo scrive da sé sono codici del contratto', () => {
    for (const codice of CODICI_PUBBLICAZIONE_VIDEO) expect(CODICI_ESITO_VIDEO as readonly string[]).toContain(codice)
  })
})

describe('il consumo dell’outbox col tipo nuovo, per intero: claim filtrato → pubblicazione → chiusura', () => {
  it('il runner prende `gallery.auto_publish` COL FILTRO NEL CLAIM e chiude l’evento consegnato con `video_outbox_sent`', async () => {
    h.intento = intentoDi({ status: 'cancelled' })
    const chiusure: { nome: string; args: Record<string, unknown> }[] = []
    const client = {
      ...(clientFinto as unknown as Record<string, unknown>),
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chiusure.push({ nome, args })
        if (nome === 'video_outbox_claim') {
          return {
            data: {
              ok: true,
              eventi: [
                { id: 'e1', intent_id: INTENTO, revision: 1, event_type: 'gallery.auto_publish', attempts: 1, created_at: new Date().toISOString() },
              ],
            },
            error: null,
          }
        }
        return { data: { ok: true }, error: null }
      },
    } as never

    const esito = await consumaOutbox(client, { operazione: 'video-runner', limite: 1, tipi: TIPI_SOLO_DEL_RUNNER })

    expect(esito).toMatchObject({ presi: 1, inviati: 1, falliti: 0, senzaDestinatario: 0 })
    expect(chiusure.map((c) => c.nome)).toEqual(['video_outbox_claim', 'video_outbox_sent'])
    expect(chiusure[0].args.p_tipi).toEqual(['gallery.auto_publish'])
  })

  it('un guasto transitorio chiude l’evento con `video_outbox_fail` e il CODICE del guasto (il backoff è del database)', async () => {
    h.storageCopy = () => ({ data: null, error: { status: 500, message: 'x' } })
    const chiusure: { nome: string; args: Record<string, unknown> }[] = []
    const client = {
      ...(clientFinto as unknown as Record<string, unknown>),
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chiusure.push({ nome, args })
        if (nome === 'video_outbox_claim') {
          return {
            data: {
              ok: true,
              eventi: [
                { id: 'e1', intent_id: INTENTO, revision: 1, event_type: 'gallery.auto_publish', attempts: 2, created_at: new Date().toISOString() },
              ],
            },
            error: null,
          }
        }
        return { data: { ok: true }, error: null }
      },
    } as never

    const esito = await consumaOutbox(client, { operazione: 'video-runner', limite: 1, tipi: TIPI_SOLO_DEL_RUNNER })

    expect(esito).toMatchObject({ presi: 1, inviati: 0, falliti: 1 })
    const fallimento = chiusure.find((c) => c.nome === 'video_outbox_fail')
    expect(fallimento?.args.p_error_code).toBe('COPIA_NON_RIUSCITA')
    expect(chiusure.some((c) => c.nome === 'video_outbox_sent')).toBe(false)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 8. COSA NON ESCE MAI
 * ──────────────────────────────────────────────────────────────────────────── */

describe('nessun identificativo di bambino, nessun nome e nessun percorso in nessun log', () => {
  const SCENARI: { nome: string; prepara: () => void; opzioni?: () => OpzioniPubblicazioneVideo }[] = [
    { nome: 'pubblicato', prepara: () => undefined },
    {
      nome: 'pubblicato senza i bambini usciti',
      prepara: () => {
        h.alunni[1] = { ...h.alunni[1], scuola_id: ALTRA_SEDE }
      },
    },
    {
      nome: 'liberatoria persa',
      prepara: () => {
        h.alunni[1] = { ...h.alunni[1], consenso_privacy: false }
        h.staff = [SEGRETERIA]
      },
    },
    {
      nome: 'nessun destinatario',
      prepara: () => {
        h.alunni = h.alunni.map((a) => ({ ...a, scuola_id: ALTRA_SEDE }))
      },
    },
    {
      nome: 'copia fallita, definitiva dopo un’ora',
      prepara: () => {
        h.storageCopy = () => ({ data: null, error: { status: 500, message: 'x' } })
      },
      opzioni: () => ({ eventoCreatoIl: new Date(ADESSO - 2 * 60 * MINUTI).toISOString() }),
    },
    {
      nome: 'recupero dopo la RPC',
      prepara: () => {
        h.intento = intentoDi({ status: 'published', tag_alunni: [] })
        h.media = { id: 'm', tag_students: [BAMBINO_A, BAMBINO_B], is_broadcast: false, target_classes: null }
      },
    },
    {
      nome: 'autore archiviato',
      prepara: () => {
        h.autore = { id: AUTORE, ruolo: 'educator', role: 'educator', scuola_id: SEDE, archiviato_il: '2026-09-30T10:00:00Z' }
      },
    },
  ]

  it.each(SCENARI)('scenario: $nome', async ({ prepara, opzioni }) => {
    prepara()
    await pubblica(opzioni?.())

    expect(h.log.mock.calls.length, 'nessun log emesso: lo scenario non prova niente').toBeGreaterThan(0)
    const testo = JSON.stringify(h.log.mock.calls)
    for (const bambino of [BAMBINO_A, BAMBINO_B, BAMBINO_C]) expect(testo).not.toContain(bambino)
    // Il percorso porta con sé chi ha caricato: né quello del file di lavoro né quello della galleria.
    expect(testo).not.toContain(PERCORSO_USCITA)
    expect(testo).not.toContain(PERCORSO_GALLERIA)
    expect(testo).not.toContain('.mp4')
    // Le notifiche non portano nessun id di bambino nel testo (i destinatari sono account, non bambini).
    const testi = JSON.stringify(h.notifiche.map((n) => [n.titolo, n.corpo, n.link]))
    for (const bambino of [BAMBINO_A, BAMBINO_B, BAMBINO_C]) expect(testi).not.toContain(bambino)
    expect(testi).not.toContain('.mp4')
  })

  it('non legge mai nome e cognome degli alunni', async () => {
    await pubblica()

    for (const q of h.query.filter((x) => x.tabella === 'alunni')) {
      expect(q.colonne).not.toMatch(/\b(nome|cognome|codice_fiscale)\b/)
    }
  })
})
