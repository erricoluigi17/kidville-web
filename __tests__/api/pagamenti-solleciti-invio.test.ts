import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sendEmail: vi.fn(async (opts: { to: string; subject: string; text: string }) => Boolean(opts)),
  // Dal 2026-08-15 il sollecito manda anche l'HTML, quindi passa da
  // `sendEmailDetailed`. Il mock DEVE esporre entrambe: `vi.mock` sostituisce
  // il modulo INTERO, e una funzione dimenticata qui diventa un 500 opaco.
  sendEmailDetailed: vi.fn(async (opts: {
    to: string; subject: string; text: string; html?: string
    chiaveIdempotenza?: string; ritentativi?: { scadenza?: number }
  }): Promise<{ ok: boolean; error: string | null; incerto?: boolean }> => ({ ok: Boolean(opts), error: null })),
  enqueueNotifiche: vi.fn(async () => {}),
  pagamenti: [] as Record<string, unknown>[],
  sollecitiEsistenti: [] as Record<string, unknown>[],
  settingsRows: [] as Record<string, unknown>[],
  settingsRow: {} as Record<string, unknown>,
  legami: [] as Record<string, unknown>[],
  utenti: [] as Record<string, unknown>[],
  quote: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  // Guasti sul registro `solleciti` (rifinitura 2026-10-05): `{ error }` di PostgREST,
  // oppure un RIGETTO (rete, client), sulla lettura dei livelli e sull'insert.
  erroreLivelli: null as null | { code: string; message: string },
  livelliLancia: false,
  erroreRegistro: null as null | { code: string; message: string },
  registroLancia: false,
  // Fase 8: la presa sulla cadenza, le letture a blocchi, l'ordine fra presa ed email.
  presaVuota: false,
  errorePresa: null as null | { code: string; message: string },
  erroreLetturaPagamenti: null as null | { code: string; message: string },
  ins: [] as { table: string; col: string; n: number }[],
  ordini: [] as { table: string; col: string }[],
  sequenza: [] as string[],
  // Sessione 9: la cadenza come la vede il database, l'ultima presa scritta, gli annullamenti
  // (il valore rimesso), il guasto dell'annullamento e i filtri di contenimento sul registro.
  cadenzaInDb: null as string | null,
  ultimaPresa: null as string | null,
  annullamenti: [] as (string | null)[],
  erroreAnnullamento: null as null | { code: string; message: string },
  contenimenti: [] as { table: string; col: string; val: string }[],
  logEvento: vi.fn(),
}))

// Il logger VERO, con il solo `logEvento` spiato: `withRoute` e il resto della
// catena ne usano anche altri export, e un mock parziale li lascerebbe `undefined`.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.logEvento(...a)
      return vero.logEvento(...a)
    },
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/email/send', () => ({ sendEmail: h.sendEmail, sendEmailDetailed: h.sendEmailDetailed }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: vi.fn(async () => ['sc-1']) }))
vi.mock('@/lib/supabase/server-client', () => {
  // Il contenimento jsonb di PostgREST (`cs`), ridotto a ciò che il motore usa (sessione 9): il
  // filtro è un elenco di oggetti, e ognuno deve avere nel valore un elemento con le stesse
  // chiavi e gli stessi valori. Una riga senza `destinatari` non contiene niente, come in Postgres.
  const contiene = (valore: unknown, filtro: string): boolean => {
    const attesi = JSON.parse(filtro) as Record<string, unknown>[]
    return Array.isArray(valore) && attesi.every((a) =>
      valore.some((v: unknown) => v !== null && typeof v === 'object'
        && Object.entries(a).every(([k, x]) => (v as Record<string, unknown>)[k] === x)))
  }
  return {
    createAdminClient: async () => ({
      from: (table: string) => {
        const b: Record<string, unknown> = {}
        let aggiornamento: Record<string, unknown> | null = null
        // Sessione 9: il filtro sulla cadenza (`.eq`/`.is` su `ultimo_sollecito_il`) distingue la
        // PRESA dall'ANNULLAMENTO; il contenimento filtra davvero le righe del registro.
        let filtroCadenza: { val: unknown } | null = null
        let contenimento: { col: string; val: string } | null = null
        b.select = () => b
        b.eq = (col: string, val: unknown) => { if (col === 'ultimo_sollecito_il') filtroCadenza = { val }; return b }
        b.in = (col: string, vals: unknown[]) => { h.ins.push({ table, col, n: vals.length }); return b }
        b.is = (col: string, val: unknown) => { if (col === 'ultimo_sollecito_il') filtroCadenza = { val }; return b }
        b.lt = () => b
        b.neq = () => b
        b.contains = (col: string, val: string) => {
          h.contenimenti.push({ table, col, val })
          contenimento = { col, val }
          return b
        }
        b.order = (col: string) => { h.ordini.push({ table, col }); return b }
        b.limit = () => b
        b.maybeSingle = async () => ({ data: table === 'admin_settings' ? h.settingsRow : table === 'scuole' ? { nome: 'Kidville Giugliano' } : null, error: null })
        b.insert = (row: Record<string, unknown>) => {
          h.inserts.push({ table, row })
          if (table === 'solleciti' && h.registroLancia) {
            return { then: (_r: unknown, ko: (e: unknown) => unknown) => ko(new TypeError('fetch failed')) }
          }
          const errore = table === 'solleciti' ? h.erroreRegistro : null
          return { then: (r: (v: unknown) => unknown) => r({ data: null, error: errore }), select: () => ({ single: async () => ({ data: row, error: null }) }) }
        }
        b.update = (row: Record<string, unknown>) => {
          h.updates.push({ table, row })
          aggiornamento = row
          return b
        }
        b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (table === 'pagamenti' && aggiornamento && 'ultimo_sollecito_il' in aggiornamento) {
            const valore = (aggiornamento.ultimo_sollecito_il ?? null) as string | null
            // L'ANNULLAMENTO: condizionato sulla presa che questo giro ha appena scritto.
            if (h.ultimaPresa !== null && filtroCadenza?.val === h.ultimaPresa) {
              h.sequenza.push('annullamento')
              h.annullamenti.push(valore)
              if (h.erroreAnnullamento) return resolve({ data: null, error: h.erroreAnnullamento })
              // Un altro giro ha già ripreso la voce: l'UPDATE condizionato tocca zero righe.
              if (h.cadenzaInDb !== h.ultimaPresa) return resolve({ data: [], error: null })
              h.cadenzaInDb = valore
              return resolve({ data: [{ id: 'x' }], error: null })
            }
            // LA PRESA.
            h.sequenza.push('presa')
            if (h.errorePresa) return resolve({ data: null, error: h.errorePresa })
            if (h.presaVuota) return resolve({ data: [], error: null })
            h.ultimaPresa = valore
            h.cadenzaInDb = valore
            return resolve({ data: [{ id: 'x' }], error: null })
          }
          if (table === 'pagamenti' && !aggiornamento && h.erroreLetturaPagamenti) {
            return resolve({ data: null, error: h.erroreLetturaPagamenti })
          }
          if (table === 'solleciti' && h.livelliLancia && reject) return reject(new TypeError('fetch failed'))
          if (table === 'solleciti' && h.erroreLivelli) return resolve({ data: null, error: h.erroreLivelli })
          const c = contenimento
          return resolve({
            data:
              table === 'pagamenti' ? h.pagamenti
              : table === 'solleciti' ? (c ? h.sollecitiEsistenti.filter((r) => contiene(r[c.col], c.val)) : h.sollecitiEsistenti)
              : table === 'admin_settings' ? h.settingsRows
              : table === 'legame_genitori_alunni' ? h.legami
              : table === 'utenti' ? h.utenti
              : table === 'pagamenti_quote' ? h.quote
              : [],
            error: null,
          })
        }
        return b
      },
    }),
  }
})

import { POST } from '@/app/api/pagamenti/solleciti/route'
import { POST as RUN } from '@/app/api/pagamenti/solleciti/run/route'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1'
const PID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
/**
 * Il CODICE DELLA VOCE di `PID`, cioè `codiceVoce(PID)` — trascritto a mano, mai
 * ricalcolato qui: comporlo invocando la stessa funzione che il motore invoca
 * renderebbe verde anche una mescola rotta. Dal 2026-09-20 la causale del sollecito
 * lo porta come già lo porta quella dell'app, e le due devono restare identiche:
 * la prova stringa-contro-stringa sta in `solleciti-causale-codice.test.ts`.
 */
const COD_PID = '#Y899P47'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/solleciti', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.erroreLivelli = null
  h.livelliLancia = false
  h.erroreRegistro = null
  h.registroLancia = false
  h.presaVuota = false
  h.errorePresa = null
  h.erroreLetturaPagamenti = null
  h.ins = []
  h.ordini = []
  h.sequenza = []
  h.cadenzaInDb = null
  h.ultimaPresa = null
  h.annullamenti = []
  h.erroreAnnullamento = null
  h.contenimenti = []
  h.sendEmailDetailed.mockImplementation(async (opts) => {
    h.sequenza.push('email')
    return { ok: Boolean(opts), error: null }
  })
  h.enqueueNotifiche.mockImplementation(async () => {})
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.pagamenti = [{
    id: PID, alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta Giugno', importo: 150, importo_pagato: 0,
    stato: 'scaduto', scadenza: '2026-06-05', tipo: 'singolo', ultimo_sollecito_il: null,
    // CF SINTETICO — non appartiene a nessuna persona reale (repo pubblico).
    alunni: { nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'TSTTST00T00T000T' },
  }]
  h.sollecitiEsistenti = []
  h.settingsRow = { solleciti_config: {}, fiscale_config: { denominazione: 'Kidville' }, aruba_config: {} }
  // `alunno_id` presente: i tutori si risolvono sull'unione runtime+anagrafica.
  h.legami = [{ alunno_id: 'al-1', genitore_id: 'g-1' }]
  h.utenti = [{ id: 'g-1', email: 'genitore@test.it', nome: 'Giulia', cognome: 'Farina' }]
  h.quote = []
})

describe('POST /api/pagamenti/solleciti', () => {
  it('anteprima: rende i testi SENZA inviare nulla', async () => {
    const res = await POST(post({ pagamento_ids: [PID], anteprima: true }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].ok).toBe(true)
    expect(j.data[0].corpo).toContain('Mario Rossi')
    // Importi in formato it-IT (virgola decimale), MAI in stile US col punto.
    expect(j.data[0].corpo).toContain('150,00')
    expect(j.data[0].corpo).not.toContain('150.00')
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(0)
  })

  // E1 — l'email deve riportare gli importi in it-IT: virgola decimale e punto
  // separatore delle migliaia («€ 1.234,50»), mai lo stile US «1234.50».
  it('importi in it-IT: separatore migliaia + virgola decimale nel corpo email', async () => {
    h.pagamenti[0].importo = 1234.5
    h.pagamenti[0].importo_pagato = 0
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
    const text = (h.sendEmailDetailed.mock.calls[0][0] as { text: string }).text
    expect(text).toContain('1.234,50')
    expect(text).not.toContain('1234.50')
    expect(text).not.toContain('1234.5')
  })

  it('invio: email al genitore, log a registro e ultimo_sollecito_il aggiornato', async () => {
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
    expect(h.sendEmailDetailed.mock.calls[0][0]).toMatchObject({ to: 'genitore@test.it' })
    expect(h.inserts.some((i) => i.table === 'solleciti')).toBe(true)
    expect(h.updates.some((u) => u.table === 'pagamenti' && u.row.ultimo_sollecito_il)).toBe(true)
    expect(h.enqueueNotifiche).toHaveBeenCalled()
  })

  // Causale bonifico: il corpo dell'email deve portare la causale consigliata
  // completa «{descrizione} {codice} {CF} {Nome Cognome} {SEDE}», ripulita per la
  // banca (abbinamento univoco dei bonifici in riconciliazione).
  it('causale: il corpo email contiene la causale completa (descrizione, minore, CF, sede)', async () => {
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
    const text = (h.sendEmailDetailed.mock.calls[0][0] as { text: string }).text
    // Il codice sta ATTACCATO alla descrizione, col CF subito dopo, e mai in coda:
    // il campo causale dell'home banking si taglia da destra. Senza `#`: Poste lo rifiuta.
    expect(text).toContain(`Retta Giugno ${COD_PID.slice(1)} TSTTST00T00T000T Mario Rossi GIUGLIANO`)
    expect(text.toLowerCase()).toContain('causale')
  })

  // Modello di causale PER CATEGORIA (causali_config, per slug) reso coi dati della
  // voce, inclusi i nuovi segnaposto {mese}/{anno}/{importo}.
  it('causale per-categoria: usa il modello dello slug con mese/anno/importo', async () => {
    h.settingsRow = {
      solleciti_config: {}, fiscale_config: { denominazione: 'Kidville' }, aruba_config: {},
      causali_config: { retta: 'Retta {mese} {anno} {importo} - {nome_completo} - {codice_fiscale}' },
    }
    h.pagamenti[0].periodo_competenza = '2026-06-01'
    h.pagamenti[0].payment_categories = { slug: 'retta' }
    const res = await POST(post({ pagamento_ids: [PID], anteprima: true }))
    expect(res.status).toBe(200)
    const j = await res.json()
    // Il modello di questa sede non cita né `{codice}` né `{descrizione}` — è il
    // caso vero delle tre sedi, scritte quando il codice non esisteva. Senza
    // `{descrizione}` il `findIndex` di `conCodiceVoce` torna -1, il
    // `Math.max(0, -1)` ricade sul PRIMO segmento e il segnaposto gli viene
    // ACCODATO: il codice esce perciò in coda al primo segmento — che resta
    // comunque la testa della causale, ed è ciò che conta, perché il campo
    // dell'home banking si taglia da destra.
    // Ripulita per la banca: «€ 150,00» diventa «EUR 150 00», i « - » diventano spazi.
    expect(j.data[0].corpo).toContain(`Retta giugno 2026 EUR 150 00 ${COD_PID.slice(1)} Mario Rossi TSTTST00T00T000T`)
  })

  it('anti-spam: sollecito recente → saltato con motivo cadenza', async () => {
    h.pagamenti[0].ultimo_sollecito_il = new Date().toISOString()
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0].ok).toBe(false)
    expect(j.data[0].motivo).toContain('cadenza')
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('saldato → saltato', async () => {
    h.pagamenti[0].stato = 'pagato'
    h.pagamenti[0].importo_pagato = 150
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0].ok).toBe(false)
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(403)
  })

  // #36 — pagamento split: i destinatari NON sono i tutori del bambino, ma i
  // titolari delle quote (adult_id di pagamenti_quote). Con legami VUOTI, un
  // invio riuscito prova che i destinatari arrivano dalle quote.
  it('#36 split: destinatari risolti dagli adult_id di pagamenti_quote', async () => {
    h.pagamenti[0].tipo = 'split'
    h.quote = [{ adult_id: 'ad-1' }, { adult_id: 'ad-2' }]
    h.utenti = [{ id: 'ad-1', email: 'ad1@test.it' }, { id: 'ad-2', email: 'ad2@test.it' }]
    h.legami = [] // se i destinatari venissero dai legami, non si invierebbe nulla
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].ok).toBe(true)
    expect((j.data[0].destinatari as { id: string }[]).map((d) => d.id)).toEqual(['ad-1', 'ad-2'])
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(2)
    const to = h.sendEmailDetailed.mock.calls.map((c) => c[0].to)
    expect(to).toEqual(expect.arrayContaining(['ad1@test.it', 'ad2@test.it']))
  })

  it('#36 split senza quote né legami → nessun destinatario, niente invio', async () => {
    h.pagamenti[0].tipo = 'split'
    h.quote = []
    h.legami = []
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0].ok).toBe(false)
    expect(j.data[0].motivo).toContain('destinatario')
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })
})

describe('POST /api/pagamenti/solleciti/run', () => {
  it('401 senza x-cron-secret', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    const res = await RUN(new Request('http://localhost/api/pagamenti/solleciti/run', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('con secret ma nessuna scuola abilitata → 0 invii', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    h.settingsRows = [{ scuola_id: 'sc-1', solleciti_config: { enabled: false } }]
    const res = await RUN(new Request('http://localhost/api/pagamenti/solleciti/run', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.inviati).toBe(0)
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
    // il run aggiorna comunque gli scaduti (sostituisce genera_solleciti SQL)
    expect(h.updates.some((u) => u.table === 'pagamenti' && u.row.stato === 'scaduto')).toBe(true)
  })

  // #34 — giro automatico con scuola abilitata e candidato scaduto/obbligatorio:
  // deve INVIARE, escludendo il contenitore rateale `tipo='padre'`.
  it('#34 cron: config abilitata + candidato scaduto → invia ed ESCLUDE il contenitore padre', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    h.settingsRows = [{ scuola_id: 'sc-1', solleciti_config: { enabled: true } }]
    h.pagamenti = [
      { id: PID, alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta', importo: 150, importo_pagato: 0,
        stato: 'scaduto', scadenza: '2026-06-01', tipo: 'singolo', obbligatorio: true, ultimo_sollecito_il: null,
        alunni: { nome: 'Mario', cognome: 'Rossi' } },
      { id: PID2, alunno_id: 'al-2', scuola_id: 'sc-1', descrizione: 'Rateale annuale', importo: 300, importo_pagato: 0,
        stato: 'scaduto', scadenza: '2026-06-01', tipo: 'padre', obbligatorio: true, ultimo_sollecito_il: null,
        alunni: { nome: 'Luca', cognome: 'Bianchi' } },
    ]
    const res = await RUN(new Request('http://localhost/api/pagamenti/solleciti/run', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.esaminati).toBe(2)
    // solo il pagamento `singolo` è sollecitato; il contenitore `padre` è escluso
    expect(j.inviati).toBe(1)
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
    expect(h.sendEmailDetailed.mock.calls[0][0]).toMatchObject({ to: 'genitore@test.it' })
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// IL RIQUADRO «DATI PER IL BONIFICO» VIENE DALLO STESSO MOTORE DELLA PAGINA.
//
// IBAN e intestatario del sollecito e quelli della card «Come pagare» del
// genitore sono le stesse due righe, lette dalla stessa configurazione: se le
// leggessero due volte divergerebbero al primo cambio, e nessuno se ne
// accorgerebbe — perché entrambe continuerebbero ad avere l'aria di essere
// giuste. `coordinateBonificoSede` è il posto unico; qui si misura che il
// riquadro che parte davvero non cambia di una riga.
// =============================================================================
describe('POST /api/pagamenti/solleciti — le coordinate del bonifico', () => {
  // IBAN SINTETICO: l'esempio pubblico della Banca d'Italia, e la sua variante
  // con una cifra cambiata. Nessuno dei due appartiene a un conto reale.
  const IBAN_OK = 'IT60X0542811101000000123456'
  const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456'
  const IBAN_STORTO = 'IT60X0542811101000000123457'

  const htmlInviato = () => (h.sendEmailDetailed.mock.calls[0][0] as { html?: string }).html ?? ''
  /**
   * Il pezzo di email che segue l'etichetta «Intestato a».
   *
   * ⚠️ NON basta cercare la denominazione nell'HTML intero: la stessa stringa
   * firma anche la prosa del sollecito (`{scuola}` nei modelli), quindi un
   * `toContain` sull'intero messaggio resterebbe verde anche con la riga
   * «Intestato a» sparita — misurato rompendo il codice apposta. Senza
   * l'etichetta l'`indexOf` vale -1 e questa fetta resta vuota: rosso, come
   * dev'essere.
   */
  const dopoIntestatario = () => {
    const html = htmlInviato()
    const i = html.indexOf('Intestato a')
    return i < 0 ? '' : html.slice(i)
  }

  it('IBAN valido: nel riquadro esce a gruppi di quattro, con l’intestatario', async () => {
    h.settingsRow = { solleciti_config: {}, fiscale_config: { denominazione: 'Coop La Favola', iban: IBAN_OK }, aruba_config: {} }
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(200)
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
    expect(htmlInviato()).toContain(IBAN_LEGGIBILE)
    expect(dopoIntestatario()).toContain('Coop La Favola')
  })

  it('IBAN con una cifra sbagliata: la riga IBAN non compare affatto', async () => {
    // Mostrarlo sarebbe peggio che ometterlo: l'errore lo scoprirebbe la
    // famiglia dopo aver mandato i soldi da qualche altra parte.
    h.settingsRow = { solleciti_config: {}, fiscale_config: { denominazione: 'Kidville', iban: IBAN_STORTO }, aruba_config: {} }
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(200)
    const html = htmlInviato()
    expect(html).not.toContain(IBAN_STORTO)
    expect(html).not.toContain('IT60')
    // Il resto del riquadro resta: importo, causale, intestatario.
    expect(html).toContain('Intestato a')
  })

  it('denominazione assente: nessun intestatario inventato, e il resto parte lo stesso', async () => {
    h.settingsRow = { solleciti_config: {}, fiscale_config: {}, aruba_config: {} }
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(200)
    const html = htmlInviato()
    expect(html).not.toContain('Intestato a')
    expect(html).toContain('Dati per il bonifico')
  })

  it('la denominazione arriva anche da `aruba_config.fiscal.ragione_sociale`', async () => {
    h.settingsRow = {
      solleciti_config: {},
      fiscale_config: {},
      aruba_config: { fiscal: { ragione_sociale: 'La Favola societa cooperativa', piva: '01234567890' } },
    }
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(200)
    expect(dopoIntestatario()).toContain('La Favola societa cooperativa')
  })

  it('una sede che si chiama DAVVERO «La Segreteria» mostra comunque «Intestato a»', async () => {
    // Il ripiego per il testo dell'email è la stringa «La Segreteria», e finché
    // l'intestatario si deduceva da lì un dato legittimo identico al ripiego
    // veniva scambiato per «non configurato»: la riga spariva. Un valore
    // sentinella che collide con un valore vero è un difetto, non un caso limite.
    h.settingsRow = { solleciti_config: {}, fiscale_config: { denominazione: 'La Segreteria', iban: IBAN_OK }, aruba_config: {} }
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(200)
    expect(htmlInviato()).toContain('Intestato a')
  })
})

/**
 * I TRE `catch` MUTI DEL MOTORE (rifinitura, 2026-10-05). La lettura dei livelli già
 * inviati, l'accodamento della push e la scrittura del registro `solleciti` avevano un
 * `catch { /* commento *\/ }` — e due di loro stavano attorno a `await supabase.from(…)`,
 * che NON lancia: l'errore di PostgREST torna in `{ error }`, e il `catch` non scattava
 * mai. Il comportamento resta quello di prima (il sollecito parte lo stesso), ma ora il
 * guasto si DICE: `info` se è il registro assente del DB non migrato, `error` altrimenti.
 */
describe('sollecitaPagamenti — i guasti secondari non tacciono', () => {
  const eventi = (esito: string) =>
    h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
  /** Il sollecito è PARTITO davvero: email, registro tentato, data aggiornata. */
  const partito = async (res: Response) => {
    expect(res.status).toBe(200)
    expect((await res.json()).data[0]).toMatchObject({ pagamento_id: PID, ok: true })
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
    expect(h.updates.some((u) => u.table === 'pagamenti' && u.row.ultimo_sollecito_il)).toBe(true)
  }

  it('tutto riuscito: nessuna riga di guasto', async () => {
    await partito(await POST(post({ pagamento_ids: [PID] })))
    for (const esito of ['registro-solleciti-assente', 'livelli-non-letti', 'push-non-accodata', 'registro-sollecito-non-scritto']) {
      expect(eventi(esito)).toHaveLength(0)
    }
  })

  it('registro dei livelli ASSENTE (42P01, DB della CI): parte dal livello 1, e una riga `info`', async () => {
    h.erroreLivelli = { code: '42P01', message: 'relation "solleciti" does not exist' }
    await partito(await POST(post({ pagamento_ids: [PID] })))
    const log = eventi('registro-solleciti-assente').filter((c) => (c[2] as { operazione?: string }).operazione === 'solleciti:livelli')
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(log[0][2]).toEqual({ operazione: 'solleciti:livelli', esito: 'registro-solleciti-assente', n: 1 })
  })

  it('livelli non letti per un altro motivo: il sollecito parte, e una riga `error` col codice', async () => {
    h.erroreLivelli = { code: '57014', message: 'canceling statement due to statement timeout' }
    await partito(await POST(post({ pagamento_ids: [PID] })))
    const log = eventi('livelli-non-letti')
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][3]).toMatchObject({ code: '57014' })
  })

  it('lettura dei livelli che RIGETTA: il sollecito parte, e il rigetto si logga', async () => {
    h.livelliLancia = true
    await partito(await POST(post({ pagamento_ids: [PID] })))
    const log = eventi('livelli-non-letti')
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][3]).toBeInstanceOf(TypeError)
  })

  it('push che non si accoda: l’email è partita, il registro si scrive lo stesso, e la push persa si dice', async () => {
    h.enqueueNotifiche.mockRejectedValueOnce(new Error('coda push non raggiungibile'))
    await partito(await POST(post({ pagamento_ids: [PID] })))
    expect(h.inserts.some((i) => i.table === 'solleciti')).toBe(true)
    const log = eventi('push-non-accodata')
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['notifica', 'error'])
    expect(log[0][2]).toEqual({ operazione: 'solleciti:push', esito: 'push-non-accodata', pagamento_id: PID })
  })

  it('registro del sollecito ASSENTE all’insert: il sollecito resta valido, e una riga `info`', async () => {
    h.erroreRegistro = { code: 'PGRST205', message: "Could not find the table 'public.solleciti' in the schema cache" }
    await partito(await POST(post({ pagamento_ids: [PID] })))
    const log = eventi('registro-solleciti-assente').filter((c) => (c[2] as { operazione?: string }).operazione === 'solleciti:registro')
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(log[0][2]).toEqual({ operazione: 'solleciti:registro', esito: 'registro-solleciti-assente', pagamento_id: PID })
  })

  it('registro del sollecito non scritto per un altro motivo: riga `error`, senza oggetto né corpo', async () => {
    h.erroreRegistro = { code: '23502', message: 'null value in column "livello" violates not-null constraint' }
    await partito(await POST(post({ pagamento_ids: [PID] })))
    const log = eventi('registro-sollecito-non-scritto')
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][2]).toEqual({ operazione: 'solleciti:registro', esito: 'registro-sollecito-non-scritto', pagamento_id: PID })
    expect(log[0][3]).toMatchObject({ code: '23502' })
    // Il corpo del sollecito (nome del bambino, CF nella causale) non entra nei campi del log.
    expect(JSON.stringify(log[0][2])).not.toContain('Mario')
  })

  it('insert del registro che RIGETTA: il sollecito resta valido, e il rigetto si logga', async () => {
    h.registroLancia = true
    await partito(await POST(post({ pagamento_ids: [PID] })))
    const log = eventi('registro-sollecito-non-scritto')
    expect(log).toHaveLength(1)
    expect(log[0][3]).toBeInstanceOf(TypeError)
  })
})

// =============================================================================
// FASE 8 DELLA ROADMAP DI ROBUSTEZZA — il giro può morire a metà.
//
// La cadenza (`ultimo_sollecito_il`) si scriveva DOPO email, push e registro: un giro
// morto in mezzo lasciava la voce «mai sollecitata», e il giro dopo rispediva. E due
// giri sulla stessa voce (cron + bottone) spedivano entrambi. Ora la cadenza è la
// PRESA: un UPDATE condizionato prima dell'email.
// =============================================================================
const runReq = () => new Request('http://localhost/api/pagamenti/solleciti/run', {
  method: 'POST', headers: { 'x-cron-secret': 'test-secret' },
})

describe('solleciti — la presa sulla cadenza, PRIMA dell’email (fase 8)', () => {
  it('🔴 la cadenza si scrive prima dell’email, non dopo', async () => {
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sequenza).toEqual(['presa', 'email'])
  })

  it('🔴 un altro giro ha appena sollecitato la voce (la presa tocca zero righe) ⇒ nessuna email', async () => {
    h.presaVuota = true
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
    expect(h.inserts.filter((i) => i.table === 'solleciti')).toEqual([])
    expect(j.data[0]).toMatchObject({ ok: false, motivo: 'sollecito già inviato da un altro giro' })
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'info' && (c[2] as { esito?: string }).esito === 'sollecito-gia-in-corso')).toBe(true)
  })

  it('la presa che fallisce ⇒ nessuna email, esito di GUASTO, riga `error` col codice', async () => {
    h.errorePresa = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
    expect(j.data[0]).toMatchObject({ ok: false, guasto: true })
    const righe = h.logEvento.mock.calls.filter((c) => c[1] === 'error' && (c[2] as { esito?: string }).esito === 'cadenza-non-scritta')
    expect(righe).toHaveLength(1)
    expect((righe[0][3] as { code?: string }).code).toBe('57014')
  })

  it('l’anteprima non prende niente: nessuna scrittura della cadenza', async () => {
    await POST(post({ pagamento_ids: [PID], anteprima: true }))
    expect(h.sequenza).toEqual([])
  })

  it('ogni email porta la chiave d’idempotenza voce + livello + destinatario + giorno (solo uuid e data)', async () => {
    await POST(post({ pagamento_ids: [PID] }))
    const chiave = (h.sendEmailDetailed.mock.calls[0][0] as { chiaveIdempotenza?: string }).chiaveIdempotenza
    expect(chiave).toMatch(new RegExp(`^sollecito:${PID}:L1:g-1:\\d{4}-\\d{2}-\\d{2}$`))
    expect(chiave).not.toContain('@')
  })
})

describe('solleciti — le letture a blocchi e la voce non letta (fase 8)', () => {
  it('250 voci ⇒ tre letture da ≤100 sia delle voci sia dei livelli, non un `.in()` da 250', async () => {
    const { sollecitaPagamenti } = await import('@/lib/pagamenti/solleciti-invio')
    const { createAdminClient } = await import('@/lib/supabase/server-client')
    const ids = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    await sollecitaPagamenti(await createAdminClient(), ids, { anteprima: true })
    const voci = h.ins.filter((x) => x.table === 'pagamenti' && x.col === 'id').map((x) => x.n)
    const livelli = h.ins.filter((x) => x.table === 'solleciti').map((x) => x.n)
    expect(voci).toEqual([100, 100, 50])
    expect(livelli).toEqual([100, 100, 50])
  })

  it('🔴 voci NON LETTE (errore PostgREST) ⇒ guasto, non «pagamento non trovato»', async () => {
    h.erroreLetturaPagamenti = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0]).toMatchObject({ ok: false, guasto: true, motivo: 'pagamento non letto: sollecito non inviato' })
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })
})

describe('solleciti — il tetto di tempo (fase 8)', () => {
  it('scadenza già passata ⇒ nessuna presa, nessuna email, esiti «rinviato», una riga `warn`', async () => {
    const { sollecitaPagamenti } = await import('@/lib/pagamenti/solleciti-invio')
    const { createAdminClient } = await import('@/lib/supabase/server-client')
    const esiti = await sollecitaPagamenti(await createAdminClient(), [PID], { automatico: true, scadenza: Date.now() - 1 })
    expect(esiti).toEqual([{ pagamento_id: PID, ok: false, motivo: 'rinviato per tempo', rinviato: true }])
    expect(h.sequenza).toEqual([])
    const righe = h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string }).esito === 'rinviati-per-tempo')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('warn')
  })
})

describe('POST /api/pagamenti/solleciti/run — fase 8', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    h.settingsRows = [{ scuola_id: 'sc-1', solleciti_config: { enabled: true } }]
  })
  const battitoOk = () => h.logEvento.mock.calls.some((c) => c[0] === 'cron' && (c[2] as { esito?: string }).esito === 'ok')

  it('i candidati si leggono in ordine di scadenza (i debiti più vecchi prima)', async () => {
    await RUN(runReq())
    expect(h.ordini).toContainEqual({ table: 'pagamenti', col: 'scadenza' })
  })

  it('500 candidati, il tetto della lettura ⇒ una riga `warn` lo dice', async () => {
    h.pagamenti = Array.from({ length: 500 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, alunno_id: 'al-1', scuola_id: 'sc-1',
      descrizione: 'Retta', importo: 150, importo_pagato: 150, stato: 'pagato', scadenza: '2026-06-01',
      tipo: 'singolo', obbligatorio: true, ultimo_sollecito_il: null,
    }))
    const res = await RUN(runReq())
    expect(res.status).toBe(200)
    const righe = h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string }).esito === 'candidati-troncati')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('warn')
  })

  it('🔴 un guasto su una voce ⇒ 500 e riga `error`, MAI il battito «ok»', async () => {
    h.errorePresa = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await RUN(runReq())
    expect(res.status).toBe(500)
    expect(h.logEvento.mock.calls.some((c) => c[0] === 'cron' && c[1] === 'error' && (c[2] as { esito?: string }).esito === 'solleciti-con-guasti')).toBe(true)
    expect(battitoOk()).toBe(false)
  })
})

// =============================================================================
// SESSIONE 9 — un sollecito conta come inviato solo se un'email è partita.
// Indirizzi solo su `example.test`.
// =============================================================================
describe('solleciti — il livello conta solo i solleciti RECAPITATI (sessione 9)', () => {
  it('L1 recapitato, L2 registrato senza nessuna email partita ⇒ il prossimo è di nuovo il 2', async () => {
    h.sollecitiEsistenti = [
      { pagamento_id: PID, livello: 1, destinatari: [{ id: 'g-1', inviata: true }] },
      { pagamento_id: PID, livello: 2, destinatari: [{ id: 'g-1', inviata: false }] },
    ]
    const res = await POST(post({ pagamento_ids: [PID], anteprima: true }))
    const j = await res.json()
    expect(j.data[0]).toMatchObject({ pagamento_id: PID, ok: true, livello: 2 })
    expect(h.contenimenti).toContainEqual({ table: 'solleciti', col: 'destinatari', val: '[{"inviata":true}]' })
  })
})
