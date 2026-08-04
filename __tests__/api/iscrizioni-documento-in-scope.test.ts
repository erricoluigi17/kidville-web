import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// F1 (collaudo privacy 2026-07-31) — DATI DI MINORI, FUGA MISURATA IN PRODUZIONE.
//
//   GET /api/admin/iscrizioni?doc=<percorso di una domanda di GIUGLIANO>
//   Cookie: sessione della segreteria di AVERSA        → 200 {"url": "…/sign/…"}
//   e quell'URL, scaricato SENZA alcuna autenticazione → 200, l'immagine intera
//   del documento d'identità di un bambino.
//
// La causa non è lo storage: è il gate. `requireStaff` verifica CHI chiede, non
// CHE COSA viene chiesto — e il percorso arrivava dalla query dritto a
// `createSignedUrl` col client service-role. Il bucket `form_attachments`
// contiene 870 documenti d'identità di minori e di adulti.
//
// Il contratto messo alla prova qui:
//  · il percorso si RISOLVE alla domanda che lo contiene (rami `children` e
//    `adults`), e quella domanda dev'essere in una sede attiva per chi chiede;
//  · se non si risolve, si NEGA: un documento d'identità non si firma «perché
//    non risulta di nessuno»;
//  · l'asserzione che conta è sulla MUTAZIONE, non sullo status: `createSignedUrl`
//    non deve essere INVOCATA. Un 403 con l'URL già firmato altrove sarebbe un
//    falso verde (l'URL vive 10 minuti ed è scaricabile senza sessione);
//  · accanto a ogni diniego c'è il CONTROLLO POSITIVO: sulla propria sede il
//    documento si scarica ancora. Un gate che nega a tutti passerebbe un test
//    fatto di soli 403.
//
// Il finto client implementa DAVVERO il contenimento jsonb (`@>`, che PostgREST
// espone come `cs`/`contains`): se la route interrogasse con la chiave sbagliata
// non troverebbe la domanda, e il controllo positivo cadrebbe.
// =============================================================================

const GIUGLIANO = 'a1a1a1a1-0000-4000-8000-00000000000a'
const AVERSA = 'b2b2b2b2-0000-4000-8000-00000000000b'

// Percorsi come li scrive `iscrizione/upload:POST`: `iscrizioni/<cartella>/<uuid>-<nome file>`.
// Nomi di file volutamente neutri: nel repo pubblico non entrano nomi di persone.
const DOC_BIMBO_GIUGLIANO = 'iscrizioni/iscrizioni/11111111-1111-4111-8111-111111111111-documento.png'
const DOC_ADULTO_AVERSA = 'iscrizioni/iscrizioni/22222222-2222-4222-8222-222222222222-documento.png'
const DOC_INESISTENTE = 'iscrizioni/iscrizioni/99999999-9999-4999-8999-999999999999-documento.png'

interface Riga {
  id: string
  scuola_id: string | null
  data: Record<string, unknown>
  status?: string
  assigned_classes?: unknown
  created_at?: string
}

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  /** Ogni invocazione di `createSignedUrl`: è QUI che si misura la fuga. */
  firme: [] as { bucket: string; percorso: string; ttl: number }[],
  righe: [] as Riga[],
  erroreDb: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/auth/parent-identity', () => ({
  ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))

vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: async () => ({ scuolaId: GIUGLIANO }),
  scuoleDiUtente: async () => [GIUGLIANO],
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

// ── Contenimento jsonb, la semantica vera di `@>` ─────────────────────────────
// PostgREST espone `@>` come `cs`; supabase-js lo scrive `.contains(col, oggetto)`.
// Su un array: OGNI elemento del lato destro dev'essere contenuto in QUALCHE
// elemento del sinistro — è ciò che rende `{"children":[{"documento_path":P}]}`
// una chiave di ricerca valida anche su domande con più figli.
function contieneJson(sinistro: unknown, destro: unknown): boolean {
  if (Array.isArray(destro)) {
    if (!Array.isArray(sinistro)) return false
    return destro.every((d) => sinistro.some((s) => contieneJson(s, d)))
  }
  if (destro !== null && typeof destro === 'object') {
    if (sinistro === null || typeof sinistro !== 'object' || Array.isArray(sinistro)) return false
    const s = sinistro as Record<string, unknown>
    return Object.entries(destro as Record<string, unknown>).every(
      ([k, v]) => k in s && contieneJson(s[k], v),
    )
  }
  return sinistro === destro
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (percorso: string, ttl: number) => {
          h.firme.push({ bucket, percorso, ttl })
          return { data: { signedUrl: `https://firmato.test/${bucket}/${percorso}` }, error: null }
        },
      }),
    },
    from(tabella: string) {
      const predicati: ((r: Riga) => boolean)[] = []
      let massimo = Infinity
      const esegui = () => {
        if (h.erroreDb) return { data: null, error: h.erroreDb }
        if (tabella !== 'enrollment_submissions') return { data: [], error: null }
        const righe = h.righe.filter((r) => predicati.every((p) => p(r))).slice(0, massimo)
        return { data: righe, error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, v: unknown) => {
        predicati.push((r) => (r as unknown as Record<string, unknown>)[col] === v)
        return b
      }
      b.in = (col: string, vals: unknown[]) => {
        predicati.push((r) => vals.includes((r as unknown as Record<string, unknown>)[col]))
        return b
      }
      b.contains = (col: string, atteso: unknown) => {
        predicati.push((r) => contieneJson((r as unknown as Record<string, unknown>)[col], atteso))
        return b
      }
      b.limit = (n: number) => {
        massimo = n
        return b
      }
      b.order = () => b
      // Dal 2026-08-04 l'elenco è paginato (`.range()`, T11-F4): la catena non
      // finisce più su `order()`, quindi il finto client deve saperlo attraversare.
      b.range = (da: number, a: number) => {
        massimo = Math.min(massimo, a - da + 1)
        return b
      }
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(esegui()).then(ok, ko)
      b.maybeSingle = async () => {
        const r = esegui()
        if (r.error) return { data: null, error: r.error }
        return { data: (r.data as Riga[])[0] ?? null, error: null }
      }
      b.single = async () => {
        const r = esegui()
        if (r.error) return { data: null, error: r.error }
        return { data: (r.data as Riga[])[0] ?? null, error: null }
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/iscrizioni/route'

const chiediDoc = (percorso: string) =>
  GET(
    new Request(
      `http://localhost/api/admin/iscrizioni?doc=${encodeURIComponent(percorso)}`,
    ) as never,
  )

const chiediElenco = () => GET(new Request('http://localhost/api/admin/iscrizioni') as never)

const comeStaff = (id: string, sedi: string[]) => {
  h.requireStaff.mockResolvedValue({ user: { id, role: 'segreteria', scuola_id: sedi[0] } })
  h.resolveScuoleAttive.mockResolvedValue(sedi)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.eventi = []
  h.firme = []
  h.erroreDb = null
  h.righe = [
    {
      id: 'dom-giugliano',
      scuola_id: GIUGLIANO,
      status: 'pending',
      created_at: '2026-07-20T10:00:00Z',
      data: {
        children: [{ documento_path: DOC_BIMBO_GIUGLIANO }, { documento_path: null }],
        adults: [{ documento_path: null }],
      },
    },
    {
      id: 'dom-aversa',
      scuola_id: AVERSA,
      status: 'pending',
      created_at: '2026-07-21T10:00:00Z',
      data: {
        children: [{ documento_path: null }],
        adults: [{ documento_path: DOC_ADULTO_AVERSA }],
      },
    },
  ]
  comeStaff('seg-aversa', [AVERSA])
})

describe('GET /api/admin/iscrizioni?doc= — il gate controlla l\'OGGETTO, non solo il ruolo', () => {
  it('segreteria di AVERSA sul documento di un minore di GIUGLIANO → 403 e NESSUNA firma', async () => {
    const res = await chiediDoc(DOC_BIMBO_GIUGLIANO)
    const json = await res.json()
    // Prima la MUTAZIONE, poi lo status: è l'ordine che rende leggibile il rosso
    // quando il gate viene rimosso — l'URL firmato non dev'essere nemmeno
    // prodotto, perché vive 10 minuti e si scarica senza sessione.
    expect(h.firme).toHaveLength(0)
    expect(json.url).toBeUndefined()
    expect(res.status).toBe(403)
  })

  it('CONTROLLO POSITIVO — segreteria di GIUGLIANO sullo stesso percorso → 200 con url firmata', async () => {
    comeStaff('seg-giugliano', [GIUGLIANO])
    const res = await chiediDoc(DOC_BIMBO_GIUGLIANO)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(typeof json.url).toBe('string')
    expect(h.firme).toEqual([
      { bucket: 'form_attachments', percorso: DOC_BIMBO_GIUGLIANO, ttl: 600 },
    ])
  })

  it('CONTROLLO POSITIVO — il documento di un ADULTO della propria sede si apre (ramo `adults`)', async () => {
    const res = await chiediDoc(DOC_ADULTO_AVERSA)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(typeof json.url).toBe('string')
    expect(h.firme.map((f) => f.percorso)).toEqual([DOC_ADULTO_AVERSA])
  })

  it('admin multi-sede: entrambi i documenti si aprono', async () => {
    comeStaff('admin-1', [GIUGLIANO, AVERSA])
    expect((await chiediDoc(DOC_BIMBO_GIUGLIANO)).status).toBe(200)
    expect((await chiediDoc(DOC_ADULTO_AVERSA)).status).toBe(200)
    expect(h.firme).toHaveLength(2)
  })

  it('percorso che non risolve a nessuna domanda → 403 e nessuna firma (non si tira a indovinare)', async () => {
    comeStaff('admin-1', [GIUGLIANO, AVERSA])
    const res = await chiediDoc(DOC_INESISTENTE)
    expect(res.status).toBe(403)
    expect(h.firme).toHaveLength(0)
    expect((await res.json()).url).toBeUndefined()
  })

  it('lettura del DB fallita → FAIL-CLOSED: nessuna firma, log `error`', async () => {
    h.erroreDb = { code: '08006', message: 'connection failure' }
    const res = await chiediDoc(DOC_BIMBO_GIUGLIANO)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(h.firme).toHaveLength(0)
    const err = h.eventi.find((e) => e.campi?.esito === 'documento-non-verificabile')
    expect(err?.livello).toBe('error')
  })

  it('il diniego lascia un `warn` PERSISTITO senza il percorso in chiaro', async () => {
    await chiediDoc(DOC_BIMBO_GIUGLIANO)
    const negato = h.eventi.find((e) => e.campi?.esito === 'documento-fuori-sede')
    expect(negato).toBeDefined()
    // `multi_sede` è in EVENTI_PERSISTITI: il warn finisce in `app_log`, non solo su stdout.
    expect(negato?.evento).toBe('multi_sede')
    expect(negato?.livello).toBe('warn')
    expect(negato?.campi.sede_id).toBe(GIUGLIANO)
    // Il percorso contiene il NOME DEL FILE caricato dalla famiglia: mai nei log.
    const serializzato = JSON.stringify(negato?.campi ?? {})
    expect(serializzato).not.toContain(DOC_BIMBO_GIUGLIANO)
    expect(serializzato).not.toContain('documento.png')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // T06-F4 — «CHI HA VISTO I DATI DI MIO FIGLIO?» NON AVEVA RISPOSTA.
  //
  // Il diniego lasciava una riga (il `warn` qui sopra). L'ACCESSO RIUSCITO no: si
  // firmava una URL che vive 10 minuti, scaricabile senza sessione, sul documento
  // d'identità di un minore — e non restava traccia di CHI l'avesse chiesta.
  //
  // Un registro che annota solo i tentativi respinti risponde alla domanda
  // sbagliata. Quella che una famiglia ha diritto di fare (art. 15 GDPR) è chi ha
  // guardato, non chi ci ha provato senza riuscirci. Ed è anche la regola 5 di
  // AGENTS.md: gli eventi critici loggano ANCHE il successo, se no «nessun log»
  // non distingue «nessuno ha guardato» da «non è mai partito niente».
  // ═══════════════════════════════════════════════════════════════════════════

  it('l’accesso RIUSCITO lascia una riga persistita con CHI ha chiesto', async () => {
    comeStaff('seg-giugliano', [GIUGLIANO])
    await chiediDoc(DOC_BIMBO_GIUGLIANO)
    expect(h.firme).toHaveLength(1)

    const letto = h.eventi.find((e) => e.campi?.esito === 'documento-firmato')
    expect(
      letto,
      'la firma è riuscita e non è rimasta nessuna traccia: alla domanda «chi ha visto i dati ' +
        'di mio figlio?» non si può rispondere',
    ).toBeDefined()
    // `multi_sede` è in EVENTI_PERSISTITI: finisce in `app_log`, non solo su stdout.
    // Una riga che vive il tempo di un deploy non è un registro degli accessi.
    expect(letto?.evento).toBe('multi_sede')
    expect(letto?.campi.sede_id).toBe(GIUGLIANO)
  })

  it('e quella riga NON contiene il percorso né il nome del file della famiglia', async () => {
    comeStaff('seg-giugliano', [GIUGLIANO])
    await chiediDoc(DOC_BIMBO_GIUGLIANO)
    const letto = h.eventi.find((e) => e.campi?.esito === 'documento-firmato')
    // Senza questa riga il caso sarebbe VERDE anche con nessun log affatto:
    // `JSON.stringify({})` non contiene niente, quindi «non contiene il percorso»
    // sarebbe vero per la ragione sbagliata. È la forma di test finto che questa
    // giornata ha trovato più di venti volte.
    expect(letto).toBeDefined()
    const serializzato = JSON.stringify(letto?.campi ?? {})
    // Stessa regola del diniego: il percorso porta il nome del file scelto da una
    // persona. Un registro degli accessi che per esistere deve loggare il dato che
    // sorveglia è un secondo archivio da proteggere, non una difesa.
    expect(serializzato).not.toContain(DOC_BIMBO_GIUGLIANO)
    expect(serializzato).not.toContain('documento.png')
  })

  it('NON REGRESSIONE — senza `?doc=` l\'elenco resta filtrato per sede', async () => {
    const res = await chiediElenco()
    expect(res.status).toBe(200)
    // Dal 2026-08-04 l'elenco è paginato e restituisce `{ data, total }`
    // (T11-F4). Il filtro di sede è quello che questo caso sorveglia, e non
    // cambia: fuori esce solo la domanda della sede attiva.
    const json = (await res.json()) as { data: Riga[]; total: number }
    expect(json.data.map((r) => r.id)).toEqual(['dom-aversa'])
    expect(json.total).toBe(1)
    expect(h.firme).toHaveLength(0)
  })
})
