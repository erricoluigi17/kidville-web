import { beforeEach, describe, expect, it, vi } from 'vitest'

import itShared from '../../messages/it/shared.json'

// =============================================================================
// GLI ESITI DI UN VIDEO DI GALLERIA (PR 2, T7): la marca «una volta sola», i testi, gli avvisi e la
// scansione dei video la cui conversione è fallita.
//
// Cosa si prova, e perché in questo modo:
//
//  · I TESTI sono la spec §7 parola per parola, e quelli di una conversione fallita sono LE STESSE
//    frasi del catalogo che l'insegnante legge a schermo (`messages/it/shared.json`): una frase sola
//    per lo stesso fatto. Nessun testo riceve altro che numeri.
//  · LA MARCA è UNA volta sola: la scansione notifica solo se `segnato` è vero, e due giri sullo
//    stesso intento — il runner e la retention si incrociano — producono UNA notifica.
//  · LA SCANSIONE legge due liste (gli intenti in volo, i loro job definitivi) e il finto database
//    APPLICA i filtri: un job `ready` o un intento già marcato non è un candidato perché i dati
//    dicono così, non perché la risposta è scritta a mano.
//  · LA REGOLA #37: un job `failed` con `attempt > 1` è un guasto NOSTRO ritentato fino all'esaurimento,
//    qualunque fosse l'ultimo codice tecnico; un `rejected` resta il suo difetto.
// =============================================================================

const SEDE = '30000000-0000-4000-8000-000000000003'
const AUTORE = '20000000-0000-4000-8000-000000000002'
const AUTORE_SEGRETERIA = '20000000-0000-4000-8000-000000000009'
const AMMINISTRATORE = '60000000-0000-4000-8000-000000000001'
const SEGRETERIA = '60000000-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({
  intenti: [] as Record<string, unknown>[],
  jobs: [] as Record<string, unknown>[],
  utenti: [] as Record<string, unknown>[],
  errori: {} as Record<string, unknown>,
  eccezioneIntenti: false,
  query: [] as { tabella: string; colonne: string; filtri: { m: string; c: string; v: unknown }[] }[],
  rpc: [] as { nome: string; args: Record<string, unknown> }[],
  /** Le marche già scritte: intento → esito. Una per intento, come nel database. */
  marche: new Map<string, string>(),
  notifiche: [] as Record<string, unknown>[],
  log: vi.fn(),
  staff: [] as string[],
  rispostaMarca: null as null | (() => { data: unknown; error: unknown }),
}))

vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: vi.fn(async (_s: unknown, p: Record<string, unknown>) => {
    h.notifiche.push(p)
  }),
}))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn(async () => h.staff),
  genitoriDiAlunni: vi.fn(),
  genitoriDiClassi: vi.fn(),
  genitoriDiScuola: vi.fn(),
}))

import {
  codiceDaInoltrare,
  corpoAvvisoLiberatoria,
  corpoConversioneFallita,
  corpoPubblicatoSenzaBambini,
  LIMITE_ESITI_PER_GIRO,
  notificaAvvisoLiberatoria,
  notificaEsitoDocente,
  scansionaEsitiDiConversione,
  segnaEsito,
  testoEsitoDocente,
  type EsitoPerDocente,
} from '@/lib/media/video/esiti'

/* ────────────────────────────────────────────────────────────────────────────
 * IL FINTO CLIENT: applica i filtri `eq`, `is`, `in`
 * ──────────────────────────────────────────────────────────────────────────── */

type Q = { tabella: string; colonne: string; filtri: { m: string; c: string; v: unknown }[] }

function applica(righe: Record<string, unknown>[], q: Q): Record<string, unknown>[] {
  return righe.filter((r) =>
    q.filtri.every((f) => {
      if (f.m === 'eq') return r[f.c] === f.v
      if (f.m === 'is') return (r[f.c] ?? null) === f.v
      if (f.m === 'in') return (f.v as unknown[]).includes(r[f.c])
      return true
    }),
  )
}

function rispondi(q: Q): { data: unknown; error: unknown } {
  const errore = h.errori[q.tabella]
  if (errore) return { data: null, error: errore }
  const sorgente = q.tabella === 'video_intents' ? h.intenti : q.tabella === 'video_jobs' ? h.jobs : q.tabella === 'utenti' ? h.utenti : []
  return { data: applica(sorgente, q), error: null }
}

const client = {
  from: (tabella: string) => {
    const q: Q = { tabella, colonne: '', filtri: [] }
    h.query.push(q)
    if (tabella === 'video_intents' && h.eccezioneIntenti) throw new Error('rete caduta')
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
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rispondi(q)).then(res, rej)
    return b
  },
  rpc: async (nome: string, args: Record<string, unknown>) => {
    h.rpc.push({ nome, args })
    if (nome !== 'video_intent_esito_segna') return { data: { ok: true }, error: null }
    if (h.rispostaMarca) return h.rispostaMarca()
    const id = String(args.p_intent_id)
    // UNA volta sola per intento, come `UPDATE … WHERE esito_notificato IS NULL`: la prima vince, le altre ricevono `segnato: false`.
    if (h.marche.has(id)) return { data: { ok: true, segnato: false, esito: h.marche.get(id) }, error: null }
    h.marche.set(id, String(args.p_esito))
    // Come il database: una volta marcato, l'intento esce dalla lista di chi non ha la marca.
    for (const i of h.intenti) if (i.id === id) i.esito_notificato = String(args.p_esito)
    return { data: { ok: true, segnato: true, esito: args.p_esito }, error: null }
  },
} as never

/* ────────────────────────────────────────────────────────────────────────────
 * I DATI
 * ──────────────────────────────────────────────────────────────────────────── */

const idIntento = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const idJob = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function intento(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: idIntento(n),
    owner_id: AUTORE,
    scuola_id: SEDE,
    pubblicazione_automatica: true,
    status: 'confirmed',
    esito_notificato: null,
    ...extra,
  }
}

function job(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: idJob(n),
    intent_id: idIntento(n),
    status: 'failed',
    error_code: 'ENCODE_FAILED',
    attempt: 1,
    ...extra,
  }
}

beforeEach(() => {
  h.intenti = []
  h.jobs = []
  h.utenti = [
    { id: AUTORE, ruolo: 'educator' },
    { id: AUTORE_SEGRETERIA, ruolo: 'segreteria' },
  ]
  h.errori = {}
  h.eccezioneIntenti = false
  h.query = []
  h.rpc = []
  h.marche = new Map()
  h.notifiche = []
  h.log.mockClear()
  h.staff = []
  h.rispostaMarca = null
})

const logDi = (esito: string) =>
  h.log.mock.calls
    .filter((c) => (c[2] as Record<string, unknown>).esito === esito)
    .map((c) => ({ evento: c[0] as string, livello: c[1] as string, campi: c[2] as Record<string, unknown>, errore: c[3], opzioni: c[4] }))

const catalogo = itShared as Record<string, string>

/* ────────────────────────────────────────────────────────────────────────────
 * 1. I TESTI (spec §7)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('i testi: la spec §7, italiano, senza nomi né nomi di file', () => {
  it('pubblicato', () => {
    expect(testoEsitoDocente({ tipo: 'pubblicato', nUsciti: 0 })).toEqual({
      titolo: 'Video pubblicato',
      corpo: 'Il tuo video è stato pubblicato in galleria.',
    })
  })

  it('pubblicato senza N bambini: il numero, il plurale e il singolare', () => {
    expect(testoEsitoDocente({ tipo: 'pubblicato', nUsciti: 2 }).corpo).toBe(
      'Il tuo video è stato pubblicato in galleria. 2 bambini non sono più nella sede e non lo vedranno.',
    )
    expect(corpoPubblicatoSenzaBambini(1)).toBe(
      'Il tuo video è stato pubblicato in galleria. 1 bambino non è più nella sede e non lo vedrà.',
    )
  })

  it('non pubblicato per mancanza di destinatari, e pubblicazione non riuscita col «Riprova»', () => {
    expect(testoEsitoDocente({ tipo: 'nessun-destinatario' })).toEqual({
      titolo: 'Video non pubblicato',
      corpo: 'Il video non è stato pubblicato: nessuno dei bambini scelti è ancora nella sede.',
    })
    expect(testoEsitoDocente({ tipo: 'pubblicazione-non-riuscita' })).toEqual({
      titolo: 'Video non pubblicato',
      corpo: 'Non siamo riusciti a pubblicare il video: apri la galleria e premi «Riprova».',
    })
  })

  it('l’avviso di liberatoria porta il solo numero (plurale e singolare)', () => {
    expect(corpoAvvisoLiberatoria(3)).toBe('Un video è stato pubblicato in galleria con 3 bambini senza liberatoria fotografica.')
    expect(corpoAvvisoLiberatoria(1)).toBe('Un video è stato pubblicato in galleria con 1 bambino senza liberatoria fotografica.')
  })

  it('una conversione fallita legge la frase del CATALOGO, la stessa che l’insegnante vede a schermo', () => {
    expect(corpoConversioneFallita('VIDEO_GUASTO_NOSTRO')).toBe(catalogo.erroreVideoGuastoNostro)
    expect(corpoConversioneFallita('VIDEO_TROPPO_LUNGO')).toBe(catalogo.erroreVideoTroppoLungo)
    expect(corpoConversioneFallita('VIDEO_FILE_NON_VALIDO')).toBe(catalogo.erroreVideoFileNonValido)
    expect(corpoConversioneFallita('VIDEO_ORIGINALE_NON_COINCIDE')).toBe(catalogo.erroreVideoOriginaleNonCoincide)
    // Il guasto nostro dice che il filmato non c'entra: è la frase che NON deve essere quella del file.
    expect(corpoConversioneFallita('VIDEO_GUASTO_NOSTRO')).toContain('problema nostro')
    expect(corpoConversioneFallita('VIDEO_CONVERSIONE_NON_RIUSCITA')).not.toContain('problema nostro')
  })

  it.each(['VIDEO_RIPROVA', 'VIDEO_GIA_CONCLUSO', 'VIDEO_APP_DA_AGGIORNARE', 'VIDEO_OPERAZIONE_NON_RIUSCITA', 'SEDE_DA_SPECIFICARE', null] as const)(
    'il codice `%s`, che non descrive una conversione fallita, ripiega sulla frase generica',
    (codice) => {
      expect(corpoConversioneFallita(codice)).toBe(catalogo.erroreVideoConversioneNonRiuscita)
    },
  )

  it('nessun testo contiene altro che frasi fisse e numeri: nemmeno con quantità enormi', () => {
    const tutti = [
      testoEsitoDocente({ tipo: 'pubblicato', nUsciti: 0 }),
      testoEsitoDocente({ tipo: 'pubblicato', nUsciti: 199 }),
      testoEsitoDocente({ tipo: 'nessun-destinatario' }),
      testoEsitoDocente({ tipo: 'pubblicazione-non-riuscita' }),
      testoEsitoDocente({ tipo: 'conversione-fallita', codice: 'VIDEO_GUASTO_NOSTRO' }),
      { titolo: '', corpo: corpoAvvisoLiberatoria(199) },
    ]
    for (const t of tutti) {
      expect(t.corpo.length).toBeGreaterThan(0)
      expect(t.corpo).not.toMatch(/\.(mp4|mov|jpg)\b/i)
      expect(t.corpo).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    }
  })

})

describe('il codice che l’outbox accetta (`^[A-Z][A-Z0-9_]{0,79}$`)', () => {
  it('lascia com’è un codice già valido, e compone gli altri', () => {
    expect(codiceDaInoltrare('TAG_NON_DELL_INTENTO', 'X')).toBe('TAG_NON_DELL_INTENTO')
    expect(codiceDaInoltrare('tag-non.dell intento', 'X')).toBe('TAG_NON_DELL_INTENTO')
    // Un codice PostgREST comincia con una cifra: non passerebbe, si prefissa.
    expect(codiceDaInoltrare('42P01', 'X')).toBe('E_42P01')
    expect(codiceDaInoltrare('', 'RIPIEGO')).toBe('RIPIEGO')
    expect(codiceDaInoltrare(undefined, 'RIPIEGO')).toBe('RIPIEGO')
    expect(codiceDaInoltrare(42, 'RIPIEGO')).toBe('RIPIEGO')
  })

  it('e non supera mai gli 80 caratteri', () => {
    const lungo = codiceDaInoltrare('A'.repeat(300), 'X')
    expect(lungo.length).toBeLessThanOrEqual(80)
    expect(lungo).toMatch(/^[A-Z][A-Z0-9_]{0,79}$/)
    expect(codiceDaInoltrare('9'.repeat(300), 'X')).toMatch(/^[A-Z][A-Z0-9_]{0,79}$/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2. LA MARCA
 * ──────────────────────────────────────────────────────────────────────────── */

describe('segnaEsito: «tocca a te» solo per chi riceve `segnato: true`', () => {
  it('chiama la RPC con l’intento e l’esito, e riporta se ha vinto la marca', async () => {
    const prima = await segnaEsito(client, idIntento(1), 'pubblicato', 'video-runner')
    const seconda = await segnaEsito(client, idIntento(1), 'pubblicato', 'video-runner')

    expect(prima).toEqual({ ok: true, segnato: true })
    expect(seconda).toEqual({ ok: true, segnato: false })
    expect(h.rpc.map((r) => r.args)).toEqual([
      { p_intent_id: idIntento(1), p_esito: 'pubblicato' },
      { p_intent_id: idIntento(1), p_esito: 'pubblicato' },
    ])
  })

  it('un errore di PostgREST, un rifiuto e un’eccezione sono `ok: false`, con la riga `error` e SENZA mai dire «segnato»', async () => {
    h.rispostaMarca = () => ({ data: null, error: { code: '57014', message: 'canceled' } })
    expect(await segnaEsito(client, idIntento(1), 'fallito', 'video-runner')).toEqual({ ok: false, codice: 'MARCA_NON_SCRITTA' })

    h.rispostaMarca = () => ({ data: { ok: false, code: 'INVALID_STATE' }, error: null })
    expect(await segnaEsito(client, idIntento(1), 'fallito', 'video-runner')).toEqual({ ok: false, codice: 'INVALID_STATE' })

    h.rispostaMarca = () => {
      throw new Error('fetch failed')
    }
    expect(await segnaEsito(client, idIntento(1), 'fallito', 'video-runner')).toEqual({ ok: false, codice: 'MARCA_NON_SCRITTA' })

    const righe = logDi('esito-non-segnato')
    expect(righe).toHaveLength(3)
    expect(righe.every((r) => r.livello === 'error' && r.campi.intent_id === idIntento(1))).toBe(true)
  })

  it('una risposta che non è un oggetto con `ok` non vale «segnato»', async () => {
    h.rispostaMarca = () => ({ data: null, error: null })
    const esito = await segnaEsito(client, idIntento(1), 'pubblicato', 'video-runner')
    expect(esito.ok).toBe(false)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 3. LE NOTIFICHE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('notificaEsitoDocente', () => {
  it('accoda `video_esito` a chi ha caricato: subito, con l’intento come entità, senza debounce', async () => {
    await notificaEsitoDocente(client, {
      intentId: idIntento(1),
      ownerId: AUTORE,
      scuolaId: SEDE,
      esito: { tipo: 'pubblicato', nUsciti: 0 },
      operazione: 'video-runner',
    })

    expect(h.notifiche).toEqual([
      {
        tipo: 'video_esito',
        scuolaId: SEDE,
        utenteIds: [AUTORE],
        titolo: 'Video pubblicato',
        corpo: 'Il tuo video è stato pubblicato in galleria.',
        link: '/teacher/gallery',
        entitaTipo: 'video',
        entitaId: idIntento(1),
        bufferMin: 0,
      },
    ])
    // Niente `debounce`: ogni video ha il suo esito, e un debounce per entità lo cancellerebbe.
    expect('debounce' in h.notifiche[0]).toBe(false)
  })

  // #152. Il collegamento dell'ESITO è lo stesso per ogni caso della spec §7 — comprese le frasi che dicono «premi Riprova» —: l'area docente,
  // l'unica pagina che ha il flusso dei video. Che sia così anche per chi ha caricato dallo STAFF lo provano la scansione (qui sotto, con
  // un autore che nei dati ha davvero il ruolo) e il pubblicatore (`gallery-pubblicazione-video-automatica.test.ts`): la funzione non
  // riceve più il ruolo di nessuno, quindi qui non c'è modo di chiedergli un altro collegamento.
  it.each<[string, EsitoPerDocente]>([
    ['pubblicato', { tipo: 'pubblicato', nUsciti: 0 }],
    ['pubblicato senza N bambini', { tipo: 'pubblicato', nUsciti: 2 }],
    ['nessun destinatario', { tipo: 'nessun-destinatario' }],
    ['pubblicazione non riuscita, col «Riprova»', { tipo: 'pubblicazione-non-riuscita' }],
    ['conversione fallita', { tipo: 'conversione-fallita', codice: 'VIDEO_GUASTO_NOSTRO' }],
  ])('%s: porta all’area docente, la sola pagina col flusso dei video (#152)', async (_nome, esito) => {
    await notificaEsitoDocente(client, {
      intentId: idIntento(1),
      ownerId: AUTORE_SEGRETERIA,
      scuolaId: SEDE,
      esito,
      operazione: 'video-runner',
    })

    expect(h.notifiche.map((n) => n.link)).toEqual(['/teacher/gallery'])
  })

  it('il SUCCESSO si logga: `esito-docente-accodato`, col caso e l’intento, una riga per intento', async () => {
    await notificaEsitoDocente(client, {
      intentId: idIntento(1),
      ownerId: AUTORE,
      scuolaId: SEDE,
      esito: { tipo: 'conversione-fallita', codice: 'VIDEO_GUASTO_NOSTRO' },
      operazione: 'video-retention',
    })

    const [riga] = logDi('esito-docente-accodato')
    expect(riga.evento).toBe('galleria')
    expect(riga.livello).toBe('info')
    expect(riga.campi).toMatchObject({
      operazione: 'video-retention',
      tipo: 'conversione-fallita',
      intent_id: idIntento(1),
      sede_id: SEDE,
    })
    expect(riga.opzioni).toEqual({ distingui: ['intent_id'] })
  })
})

describe('notificaAvvisoLiberatoria', () => {
  const base = { intentId: idIntento(1), ownerId: AUTORE, scuolaId: SEDE, operazione: 'video-runner' }

  it('con zero bambini non fa niente', async () => {
    expect(await notificaAvvisoLiberatoria(client, { ...base, nSenzaLiberatoria: 0 })).toBe(0)
    expect(h.notifiche).toEqual([])
  })

  it('a chi ha caricato e allo staff della sede: tipo di sicurezza, solo il numero, collegamenti diversi', async () => {
    h.staff = [AMMINISTRATORE, SEGRETERIA]

    const destinatari = await notificaAvvisoLiberatoria(client, { ...base, nSenzaLiberatoria: 2 })

    expect(destinatari).toBe(3)
    expect(h.notifiche.map((n) => [n.tipo, n.utenteIds, n.link])).toEqual([
      ['video_liberatoria_revocata', [AUTORE], '/teacher/gallery'],
      ['video_liberatoria_revocata', [AMMINISTRATORE, SEGRETERIA], '/admin/gallery'],
    ])
    for (const n of h.notifiche) {
      expect(n.corpo).toBe('Un video è stato pubblicato in galleria con 2 bambini senza liberatoria fotografica.')
      expect(n.titolo).toBe('Video pubblicato senza liberatoria')
      expect(n.entitaId).toBe(idIntento(1))
      expect(n.bufferMin).toBe(0)
    }
    expect(logDi('pubblicato-senza-liberatoria')[0].campi).toMatchObject({ n_senza_liberatoria: 2, n_destinatari: 3 })
  })

  it('uno staff che contiene già chi ha caricato non lo avvisa due volte; senza staff resta l’avviso a chi ha caricato', async () => {
    h.staff = [AUTORE, AUTORE, SEGRETERIA]
    expect(await notificaAvvisoLiberatoria(client, { ...base, nSenzaLiberatoria: 1 })).toBe(2)
    expect(h.notifiche.map((n) => n.utenteIds)).toEqual([[AUTORE], [SEGRETERIA]])
    // #152: chi ha caricato va all'area docente ANCHE se fa parte dello staff (è lì che ritrova il suo video); la galleria della segreteria è
    // solo per lo staff che NON ha caricato.
    expect(h.notifiche.map((n) => n.link)).toEqual(['/teacher/gallery', '/admin/gallery'])

    h.notifiche = []
    h.staff = []
    expect(await notificaAvvisoLiberatoria(client, { ...base, nSenzaLiberatoria: 1 })).toBe(1)
    expect(h.notifiche.map((n) => n.utenteIds)).toEqual([[AUTORE]])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 4. LA SCANSIONE DELLE CONVERSIONI FALLITE (§8.5)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('la scansione: chi ha una conversione fallita e nessuna marca', () => {
  const scansiona = (limite?: number) => scansionaEsitiDiConversione(client, { operazione: 'video-runner', limite })

  it('niente intenti in volo: nessun job letto, nessuna RPC', async () => {
    expect(await scansiona()).toEqual({ esito: 'ok', candidati: 0, notificati: 0 })
    expect(h.query.map((q) => q.tabella)).toEqual(['video_intents'])
    expect(h.rpc).toEqual([])
  })

  it('un intento il cui job è ancora vivo o `ready` NON è un candidato (lo dicono i dati, non una risposta scritta a mano)', async () => {
    h.intenti = [intento(1), intento(2), intento(3)]
    h.jobs = [job(1, { status: 'queued' }), job(2, { status: 'ready', error_code: null }), job(3, { status: 'processing' })]

    expect(await scansiona()).toEqual({ esito: 'ok', candidati: 0, notificati: 0 })
    expect(h.rpc).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  // #161. «Un job `cancelled` non si notifica» (spec §3: l'ha chiesto qualcuno) era protetto solo dalla FORMA della query — il test «le liste»,
  // più sotto, guarda che il filtro sia `['failed', 'rejected']` — e un filtro riscritto per bene lo fa passare comunque, mentre uno cambiato lo
  // fa cadere per il motivo sbagliato. Qui è il COMPORTAMENTO, su un finto database che APPLICA il filtro: un intento automatico `confirmed` il cui
  // job è stato annullato non riceve né marca né notifica, e accanto a lui un intento il cui job è davvero fallito li riceve — quindi la scansione
  // sta lavorando, non è semplicemente spenta. Con `cancelled` aggiunto alla query questo test cade (candidati 2, notificati 2).
  it('un job `cancelled` NON si marca e NON si notifica: l’ha chiesto qualcuno (#161)', async () => {
    h.intenti = [intento(1), intento(2)]
    h.jobs = [job(1, { status: 'cancelled', error_code: null, attempt: 0 }), job(2)]

    const esito = await scansiona()

    expect(esito).toEqual({ esito: 'ok', candidati: 1, notificati: 1 })
    // La marca è stata chiesta, e vinta, solo per l'intento del job fallito.
    expect(h.rpc.map((r) => r.args.p_intent_id)).toEqual([idIntento(2)])
    expect(h.notifiche.map((n) => n.entitaId)).toEqual([idIntento(2)])
    // E l'intento del job annullato è com'era: nessuna marca scritta, quindi nessun esito «fallito» per un video che nessuno aspetta.
    expect(h.marche.has(idIntento(1))).toBe(false)
    expect(h.intenti[0].esito_notificato).toBeNull()
  })

  it('un job `failed` dopo più tentativi è un guasto NOSTRO: la marca è `fallito`, il testo è quello del guasto nostro (#37)', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1, { status: 'failed', error_code: 'ENCODE_FAILED', attempt: 4 })]

    const esito = await scansiona()

    expect(esito).toEqual({ esito: 'ok', candidati: 1, notificati: 1 })
    expect(h.rpc.map((r) => r.args)).toEqual([{ p_intent_id: idIntento(1), p_esito: 'fallito' }])
    expect(h.notifiche).toHaveLength(1)
    expect(h.notifiche[0]).toMatchObject({
      tipo: 'video_esito',
      scuolaId: SEDE,
      utenteIds: [AUTORE],
      titolo: 'Video non pubblicato',
      corpo: catalogo.erroreVideoGuastoNostro,
      entitaId: idIntento(1),
      link: '/teacher/gallery',
    })
  })

  it('lo stesso codice al PRIMO tentativo è del file: legge «conversione non riuscita», non «problema nostro»', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1, { status: 'failed', error_code: 'ENCODE_FAILED', attempt: 1 })]

    await scansiona()

    expect(h.notifiche[0].corpo).toBe(catalogo.erroreVideoConversioneNonRiuscita)
  })

  it.each([
    ['MISSING_VIDEO_STREAM', 'erroreVideoFileNonValido'],
    ['VIDEO_TOO_LONG', 'erroreVideoTroppoLungo'],
    ['UNSUPPORTED_VIDEO_CODEC', 'erroreVideoFormatoNonSupportato'],
    ['ORIGINALE_DIVERSO', 'erroreVideoOriginaleNonCoincide'],
    ['ORIGINALE_SOSTITUITO', 'erroreVideoOriginaleNonCoincide'],
  ])('un job `rejected` per `%s` dice il difetto del FILE (anche dopo più tentativi)', async (codice, chiave) => {
    h.intenti = [intento(1)]
    h.jobs = [job(1, { status: 'rejected', error_code: codice, attempt: 3 })]

    await scansiona()

    expect(h.notifiche[0].corpo).toBe(catalogo[chiave])
  })

  it('un upload mai concluso (`UPLOAD_ABBANDONATO`) avvisa che il caricamento va rifatto', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1, { status: 'failed', error_code: 'UPLOAD_ABBANDONATO', attempt: 0 })]

    await scansiona()

    expect(h.notifiche[0].corpo).toBe(catalogo.erroreVideoNonTrovato)
  })

  it('con la marca già vinta da un altro NESSUNA notifica, e non conta fra i notificati', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1)]
    h.marche.set(idIntento(1), 'fallito')

    const esito = await scansiona()

    expect(esito).toEqual({ esito: 'ok', candidati: 1, notificati: 0 })
    expect(h.notifiche).toEqual([])
  })

  it('due scansioni di fila (il runner e la retention): UNA notifica', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1)]

    const prima = await scansiona()
    const seconda = await scansiona()

    expect(prima.notificati).toBe(1)
    // La seconda non trova più l'intento fra quelli senza marca (lo dicono i dati), e se lo trovasse la marca direbbe `false`.
    expect(seconda.notificati).toBe(0)
    expect(h.notifiche).toHaveLength(1)
  })

  it('una marca che non si scrive non si prende per vinta: nessuna notifica, e gli altri intenti proseguono', async () => {
    h.intenti = [intento(1), intento(2)]
    h.jobs = [job(1), job(2)]
    let chiamate = 0
    h.rispostaMarca = () => {
      chiamate += 1
      return chiamate === 1
        ? { data: null, error: { code: '57014', message: 'canceled' } }
        : { data: { ok: true, segnato: true, esito: 'fallito' }, error: null }
    }

    const esito = await scansiona()

    expect(esito).toEqual({ esito: 'ok', candidati: 2, notificati: 1 })
    expect(h.notifiche.map((n) => n.entitaId)).toEqual([idIntento(2)])
  })

  // #152. L'esito di una conversione fallita porta all'area docente per CHIUNQUE abbia caricato, staff compreso: è l'unica pagina col flusso dei
  // video e il «Riprova». Il ruolo ESISTE nei dati (`utenti`, che il finto database serve): è il codice a non guardarlo più. Prima la scansione lo
  // leggeva e mandava amministratore, coordinamento e segreteria in `/admin/gallery`, dove il «Riprova» non c'è — con il vecchio codice i primi
  // tre casi cadono, e l'insegnante (`educator`) resta verde.
  it.each(['admin', 'coordinator', 'segreteria', 'educator'])(
    'chi ha caricato con il ruolo `%s` riceve il collegamento dell’area docente (#152)',
    async (ruolo) => {
      h.utenti = [{ id: AUTORE_SEGRETERIA, ruolo }]
      h.intenti = [intento(1, { owner_id: AUTORE_SEGRETERIA }), intento(2)]
      h.jobs = [job(1), job(2)]

      await scansiona()

      expect(h.notifiche.map((n) => [n.entitaId, n.utenteIds, n.link])).toEqual([
        [idIntento(1), [AUTORE_SEGRETERIA], '/teacher/gallery'],
        [idIntento(2), [AUTORE], '/teacher/gallery'],
      ])
    },
  )

  it('le liste: gli intenti AUTOMATICI, `confirmed`, senza marca — poi, fra loro, i job `failed`/`rejected`', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1)]

    await scansiona()

    const intenti = h.query.find((q) => q.tabella === 'video_intents')
    expect(intenti?.filtri).toEqual(
      expect.arrayContaining([
        { m: 'eq', c: 'pubblicazione_automatica', v: true },
        { m: 'eq', c: 'status', v: 'confirmed' },
        { m: 'is', c: 'esito_notificato', v: null },
      ]),
    )
    const jobs = h.query.find((q) => q.tabella === 'video_jobs')
    expect(jobs?.filtri).toEqual(
      expect.arrayContaining([
        { m: 'in', c: 'intent_id', v: [idIntento(1)] },
        { m: 'in', c: 'status', v: ['failed', 'rejected'] },
      ]),
    )
    // Né un intento già annullato né uno già pubblicato: non sono nella lista, quindi non si avvisano.
    h.query = []
    h.intenti = [intento(2, { status: 'cancelled' }), intento(3, { status: 'published' }), intento(4, { pubblicazione_automatica: false }), intento(5, { esito_notificato: 'fallito' })]
    h.jobs = [job(2), job(3), job(4), job(5)]
    expect(await scansiona()).toEqual({ esito: 'ok', candidati: 0, notificati: 0 })
  })

  it('il tetto per giro: oltre `limite` il resto aspetta il giro dopo, e lo dice il log', async () => {
    const quanti = LIMITE_ESITI_PER_GIRO + 5
    h.intenti = Array.from({ length: quanti }, (_, i) => intento(i + 1))
    h.jobs = Array.from({ length: quanti }, (_, i) => job(i + 1))

    const esito = await scansiona()

    expect(esito).toEqual({ esito: 'ok', candidati: quanti, notificati: LIMITE_ESITI_PER_GIRO })
    expect(logDi('esiti-scansionati')[0].campi).toMatchObject({ n_candidati: quanti, n_notificati: LIMITE_ESITI_PER_GIRO, n_oltre_il_limite: 5 })
    // Il giro dopo prende il resto: i primi sono marcati e non tornano.
    const dopo = await scansiona()
    expect(dopo.notificati).toBe(5)
  })

  it('i job di intenti numerosi si leggono a BLOCCHI (`.in()` finisce in una query string)', async () => {
    const quanti = 230
    h.intenti = Array.from({ length: quanti }, (_, i) => intento(i + 1))
    h.jobs = []

    await scansiona()

    const letture = h.query.filter((q) => q.tabella === 'video_jobs')
    expect(letture.length).toBe(3)
    for (const q of letture) {
      expect((q.filtri.find((f) => f.c === 'intent_id')?.v as string[]).length).toBeLessThanOrEqual(100)
    }
  })

  it('a zero candidati non si scrive niente: una scansione a vuoto ogni cinque minuti è rumore', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1, { status: 'queued' })]

    await scansiona()

    expect(logDi('esiti-scansionati')).toEqual([])
  })

  // #154. Un intento di galleria senza sede non si può avvisare (`notificaEvento` vuole la sede) e NON DOVREBBE ESISTERE: il database lo vieta
  // (`video_intents_scuola_scope_chk`), quindi se compare un vincolo è stato tolto. Prima lo si saltava con un `continue` muto, a ogni giro e per
  // sempre. Ora la scansione grida — `error`, una riga per giro — e non si ferma: chi una sede ce l'ha è avvisato come sempre.
  describe('un intento senza sede (#154): non dovrebbe esistere, e la scansione non tace più', () => {
    it('UNA riga `error` per giro col conteggio e il più vecchio; niente marca per loro, e gli altri intenti proseguono', async () => {
      // L'ordine dell'array è quello della query (`updated_at` crescente): il primo è il più vecchio.
      h.intenti = [intento(1, { scuola_id: null }), intento(2, { scuola_id: null }), intento(3)]
      h.jobs = [job(1), job(2), job(3)]

      const esito = await scansiona()

      expect(esito).toEqual({ esito: 'ok', candidati: 3, notificati: 1 })
      // Né marca né notifica per chi non ha una sede dove avvisare; quello che ce l'ha è avvisato.
      expect(h.rpc.map((r) => r.args.p_intent_id)).toEqual([idIntento(3)])
      expect(h.notifiche.map((n) => n.entitaId)).toEqual([idIntento(3)])
      const righe = logDi('esiti-intento-senza-sede')
      expect(righe).toHaveLength(1)
      expect(righe[0].evento).toBe('cron')
      expect(righe[0].livello).toBe('error')
      // I campi, TUTTI e solo questi: un uuid dell'intento, un conteggio, due etichette. Nessun proprietario, nessuna sede, nessun nome.
      expect(righe[0].campi).toEqual({
        operazione: 'video-runner',
        esito: 'esiti-intento-senza-sede',
        n_senza_sede: 2,
        intent_id: idIntento(1),
      })
      expect(righe[0].opzioni).toEqual({ distingui: ['intent_id'] })
    })

    it('una riga A OGNI GIRO finché lo stato dura: la scansione non lo dà per assodato dopo la prima volta', async () => {
      h.intenti = [intento(1, { scuola_id: null })]
      h.jobs = [job(1)]

      await scansiona()
      await scansiona()

      expect(logDi('esiti-intento-senza-sede')).toHaveLength(2)
      // E non si marca mai: la marca vuol dire «avvisato», e qui nessuno lo è stato.
      expect(h.rpc).toEqual([])
    })

    it('si conta fra TUTTI i candidati, anche oltre il tetto del giro (un intento senza sede non sparisce perché è in coda)', async () => {
      h.intenti = [intento(1), intento(2, { scuola_id: null })]
      h.jobs = [job(1), job(2)]

      const esito = await scansiona(1) // il tetto lascia passare un solo candidato: il primo

      expect(esito).toEqual({ esito: 'ok', candidati: 2, notificati: 1 })
      expect(logDi('esiti-intento-senza-sede')[0].campi).toMatchObject({ n_senza_sede: 1, intent_id: idIntento(2) })
    })

    it('è un fatto dei CANDIDATI: senza un job fallito la scansione non lo guarda, e con le sedi in ordine non scrive niente', async () => {
      h.intenti = [intento(1, { scuola_id: null }), intento(2)]
      h.jobs = [job(1, { status: 'processing' }), job(2)]

      await scansiona()

      expect(logDi('esiti-intento-senza-sede')).toEqual([])
    })
  })
})

describe('la scansione che non riesce: lo schema che non c’è si dichiara, ogni altro guasto si grida, e non lancia mai', () => {
  const scansiona = () => scansionaEsitiDiConversione(client, { operazione: 'video-retention' })

  it('una lettura degli intenti che fallisce è `lettura-fallita`, con la riga `error` e il codice', async () => {
    h.errori.video_intents = { code: '57014', message: 'canceled' }

    expect(await scansiona()).toEqual({ esito: 'lettura-fallita', candidati: 0, notificati: 0 })
    const [riga] = logDi('esiti-lettura-fallita')
    expect(riga.livello).toBe('error')
    expect(riga.campi).toMatchObject({ operazione: 'video-retention', tipo: 'video_intents', error_code: '57014' })
  })

  it('una lettura dei job che fallisce NON notifica niente', async () => {
    h.intenti = [intento(1)]
    h.errori.video_jobs = { code: '57014', message: 'canceled' }

    expect(await scansiona()).toEqual({ esito: 'lettura-fallita', candidati: 0, notificati: 0 })
    expect(h.rpc).toEqual([])
    expect(h.notifiche).toEqual([])
  })

  it.each(['42P01', 'PGRST205', '42703', 'PGRST204'])(
    'il codice `%s` (database E2E non migrato) è `schema-assente`: `warn`, non un guasto',
    async (codice) => {
      h.errori.video_intents = { code: codice, message: 'manca' }

      expect(await scansiona()).toEqual({ esito: 'schema-assente', candidati: 0, notificati: 0 })
      expect(logDi('esiti-schema-assente')[0].livello).toBe('warn')
      expect(logDi('esiti-lettura-fallita')).toEqual([])
    },
  )

  it('un’eccezione di trasporto non esce: `lettura-fallita` e la riga `error`', async () => {
    h.eccezioneIntenti = true

    expect(await scansiona()).toEqual({ esito: 'lettura-fallita', candidati: 0, notificati: 0 })
    expect(logDi('esiti-scansione-eccezione')[0].livello).toBe('error')
  })
})

describe('cosa non esce mai da qui', () => {
  it('nessun log e nessun testo contiene un file, un percorso o un id di bambino', async () => {
    h.intenti = [intento(1)]
    h.jobs = [job(1, { status: 'rejected', error_code: 'ORIGINALE_DIVERSO', attempt: 1 })]
    h.staff = [SEGRETERIA]

    await scansionaEsitiDiConversione(client, { operazione: 'video-runner' })
    await notificaAvvisoLiberatoria(client, {
      intentId: idIntento(1),
      ownerId: AUTORE,
      scuolaId: SEDE,
      nSenzaLiberatoria: 2,
      operazione: 'video-runner',
    })

    const testo = JSON.stringify([h.log.mock.calls, h.notifiche.map((n) => [n.titolo, n.corpo, n.link])])
    expect(testo).not.toMatch(/\.(mp4|mov)\b/i)
    expect(testo).not.toContain('tag_alunni')
    expect(testo).not.toContain('nome')
  })
})
