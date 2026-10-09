import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import { redact } from '@/lib/logging/redact'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  alunni: [] as Record<string, unknown>[],
  links: [] as Record<string, unknown>[],
  parents: [] as Record<string, unknown>[],
  // Quante righe il database DICE che ci sono (`count: 'exact'`), che può essere
  // più di quante ne arrivano: PostgREST taglia a un tetto di configurazione.
  contaTotale: null as number | null,
  // Il registro della primaria (2026-10-08), per tabella. Vuoto di default: chi
  // non ha voti, pagelle, scrutini o note è un candidato come prima.
  registro: {} as Record<string, { alunno_id: string }[]>,
  // Errore PostgREST iniettato su una tabella del registro.
  erroreRegistro: {} as Record<string, { code: string; message: string }>,
  // Errore PostgREST sulla lettura dell'elenco stesso.
  erroreAlunni: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// `logEvento` spiato, non silenziato: è QUESTA la porta da cui un bambino
// sparisce in silenzio, e senza asserzione «loggato» il difetto tornerebbe
// identico — con l'elenco vuoto e nessuno che sa quanti sono stati esclusi.
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      // Il doppio APPLICA i filtri su `stato`, non li ignora: questo file esiste
      // per provare CHI finisce nell'elenco dei candidati all'oblio, e un doppio
      // che accetta ogni filtro senza applicarlo restituirebbe sempre la stessa
      // riga — cioè passerebbe anche con la query sbagliata. Le altre colonne
      // restano no-op di proposito: l'isolamento per sede ha il suo file
      // (`__tests__/api/gdpr-scope-sede.test.ts`) e qui non si riscrive PostgREST.
      const filtri: { statoNeq?: string; statoIn?: string[]; alunnoId?: string } = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      // `alunno_id` lo legge solo il controllo del registro della primaria: il
      // doppio lo APPLICA, così un bambino con il registro non contagia gli altri.
      b.eq = (col: string, val: unknown) => { if (col === 'alunno_id') filtri.alunnoId = String(val); return b }
      b.is = () => b
      b.neq = (col: string, val: unknown) => { if (col === 'stato') filtri.statoNeq = String(val); return b }
      b.in = (col: string, vals: unknown) => { if (col === 'stato') filtri.statoIn = (vals as unknown[]).map(String); return b }
      b.order = () => b
      b.limit = () => b
      b.then = (res: (v: unknown) => unknown) => {
        if (table === 'alunni' && h.erroreAlunni) return Promise.resolve({ data: null, error: h.erroreAlunni }).then(res)
        if (h.erroreRegistro[table]) return Promise.resolve({ data: null, error: h.erroreRegistro[table] }).then(res)
        if (table in h.registro) {
          const righe = h.registro[table].filter((r) => r.alunno_id === filtri.alunnoId)
          return Promise.resolve({ data: righe, error: null }).then(res)
        }
        let data: Record<string, unknown>[] =
          table === 'alunni' ? h.alunni : table === 'student_parents' ? h.links : table === 'parents' ? h.parents : []
        if (table === 'alunni') {
          if (filtri.statoNeq !== undefined) data = data.filter((a) => a.stato !== filtri.statoNeq)
          if (filtri.statoIn !== undefined) data = data.filter((a) => filtri.statoIn!.includes(String(a.stato)))
        }
        return Promise.resolve({ data, error: null, count: h.contaTotale ?? data.length }).then(res)
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/gdpr/candidates/route'

// NextRequest (non Request): da quando la route filtra per sede legge il cookie
// `sedi_attive` tramite `resolveScuoleAttive`, che vuole `request.cookies`.
const get = () => new NextRequest('http://localhost/api/admin/gdpr/candidates')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  // `ritirato`, non `non_iscritto`: la tendina dello stato offre iscritto ·
  // ritirato · sospeso, e `non_iscritto` non è mai stato scritto da nessuna riga
  // di `src/` — era un valore esistente solo qui dentro. Un banco di prova che
  // usa uno stato che il prodotto non sa produrre non prova il prodotto.
  h.alunni = [{ id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'ritirato' }]
  h.links = [{ student_id: 'al-1', parent_id: 'p-1' }]
  h.parents = [{ id: 'p-1', first_name: 'Maria', last_name: 'Rossi' }]
  h.contaTotale = null
  h.registro = {}
  h.erroreRegistro = {}
  h.erroreAlunni = null
})

describe('GET /api/admin/gdpr/candidates', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(get())).status).toBe(403)
  })

  it('200 lista candidati con i genitori collegati', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('al-1')
    expect(json[0].genitori).toEqual([{ id: 'p-1', nome: 'Maria Rossi' }])
  })

  // ⬇︎ REGRESSIONE — il difetto era in produzione.
  // La query era `.neq('stato', 'iscritto')`, una negazione. La tendina di
  // `StudentDetailPanel` offre anche `sospeso`, che è un bambino iscritto a
  // tutti gli effetti: bastava usarla perché comparisse fra i candidati
  // all'anonimizzazione irreversibile, in un elenco che si conferma digitando
  // un nominativo. Ora l'elenco è un'allowlist e `sospeso` non ne fa parte.
  it('un alunno SOSPESO non è un candidato all\'oblio', async () => {
    h.alunni = [
      { id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'ritirato' },
      { id: 'al-2', nome: 'Luca', cognome: 'Bianchi', classe_sezione: 'B', stato: 'sospeso' },
    ]
    h.links = []
    const json = await (await GET(get())).json()
    expect(json.map((a: { id: string }) => a.id)).toEqual(['al-1'])
  })

  it('uno stato mai visto prima non entra da solo fra i candidati', async () => {
    // `alunni.stato` non ha vincolo `CHECK` e la PATCH admin la valida con
    // `z.unknown()`: qualunque stringa può arrivarci. Con una negazione ogni
    // refuso diventava un candidato all'oblio senza che nessuno lo decidesse.
    h.alunni = [{ id: 'al-9', nome: 'Anna', cognome: 'Verdi', classe_sezione: 'C', stato: 'trasferito' }]
    h.links = []
    expect(await (await GET(get())).json()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DOVE UN BAMBINO SPARISCE IN SILENZIO — ed è qui, non nel 409 di `erase`.
//
// L'elenco chiuso è la protezione giusta, ma ha un costo: chi resta fuori resta
// fuori senza dirlo. La Direzione apre il pannello, legge «Nessun alunno non
// iscritto da anonimizzare» e chiude — e se un minore aveva uno stato fuori
// elenco, non esisteva una riga che dicesse quanti fossero né con quale stato.
// Il 409 di `erase` non copre il caso: `OblioPanel` manda a `erase` solo gli
// `id` che QUESTA lista ha già ammesso, quindi da interfaccia non si raggiunge.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/gdpr/candidates — chi l’elenco chiuso lascia fuori', () => {
  const rigaGdpr = () => h.logEvento.mock.calls.find((c) => c[0] === 'gdpr')

  it('conta e NOMINA gli stati esclusi, a livello warn', async () => {
    h.alunni = [
      { id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'ritirato' },
      { id: 'al-2', nome: 'Luca', cognome: 'Bianchi', classe_sezione: 'B', stato: 'trasferito' },
      { id: 'al-3', nome: 'Sara', cognome: 'Neri', classe_sezione: 'B', stato: 'boh' },
      { id: 'al-4', nome: 'Gaia', cognome: 'Blu', classe_sezione: 'C', stato: 'iscritto' },
      { id: 'al-5', nome: 'Ivo', cognome: 'Gialli', classe_sezione: 'C', stato: 'sospeso' },
    ]
    h.links = []
    const json = await (await GET(get())).json()
    expect(json.map((a: { id: string }) => a.id)).toEqual(['al-1'])

    const riga = rigaGdpr()
    expect(riga, 'nessun log sull’elenco dei candidati').toBeTruthy()
    expect(riga![1]).toBe('warn')
    // `sospeso` è escluso ed è GIUSTO che lo sia (è un bambino iscritto): entra
    // nel conteggio perché la domanda a cui la riga risponde è «chi non compare
    // e non è iscritto in senso stretto», che è esattamente ciò che la Direzione
    // non può vedere dal pannello.
    expect(riga![2]).toMatchObject({ esito: 'candidati-esclusi-fuori-elenco', n_candidati: 1, n_esclusi: 3 })
    expect(riga![2].tipo).toBe('boh/sospeso/trasferito')
    expect(riga![2].n_stati).toBe(3)
  })

  it('la riga ARRIVA in tabella leggibile: passa la redazione senza essere oscurata', async () => {
    // Il presidio che manca a quasi tutti i log: `logEvento` è stato chiamato,
    // ma `app_log` riceve il risultato di `redact()`. `tipo` è in lista bianca e
    // «la chiave apre, il VALORE conferma»: con un separatore fuori
    // dall'alfabeto di `FORMA_ENUMERATO` — la barra verticale, per dirne uno —
    // la riga sarebbe finita in tabella oscurata, cioè un log che c'è e non dice
    // niente. Questa riga esiste perché quel difetto è già stato scritto una
    // volta, in questo stesso file, ed è stato visto solo provandolo.
    h.alunni = [
      { id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'ritirato' },
      { id: 'al-2', nome: 'Luca', cognome: 'Bianchi', classe_sezione: 'B', stato: 'trasferito' },
      { id: 'al-3', nome: 'Sara', cognome: 'Neri', classe_sezione: 'B', stato: 'boh' },
    ]
    h.links = []
    await GET(get())
    const dopo = redact(rigaGdpr()![2]) as Record<string, unknown>
    expect(dopo.tipo).toBe('boh/trasferito')
    expect(dopo.esito).toBe('candidati-esclusi-fuori-elenco')
    expect(dopo.n_esclusi).toBe(2)
  })

  it('dichiara `troncato` quando il database dice che le righe sono più di quelle arrivate', async () => {
    // `n_esclusi` calcolato sulle sole righe ARRIVATE mentirebbe verso il basso:
    // «nessuno escluso» proprio quando ce ne sono troppi per stare in una
    // risposta. Il numero resta un minimo, ma smette di spacciarsi per totale.
    h.alunni = [{ id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'ritirato' }]
    h.links = []
    h.contaTotale = 900
    await GET(get())
    expect(rigaGdpr()![2].troncato).toBe(true)
  })

  it('nessun escluso ⇒ la riga c’è lo stesso: «zero» è un’informazione', async () => {
    // Con i soli casi diversi da zero, «nessun log» significherebbe insieme «non
    // c'era nessuno da escludere» e «la sonda non è mai partita»: è l'ambiguità
    // che ha tenuto nascosto per mesi il guasto delle email di credenziali.
    h.alunni = [{ id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'ritirato' }]
    h.links = []
    await GET(get())
    const riga = rigaGdpr()
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('info')
    expect(riga![2]).toMatchObject({ esito: 'candidati-elencati', n_candidati: 1, n_esclusi: 0, tipo: 'nessuno' })
  })

  it('la riga non porta né nomi né cognomi: `gdpr` è un evento PERSISTITO', async () => {
    h.alunni = [{ id: 'al-2', nome: 'Luca', cognome: 'Bianchi', classe_sezione: 'B', stato: 'trasferito' }]
    h.links = []
    await GET(get())
    expect(JSON.stringify(rigaGdpr()![2])).not.toMatch(/Luca|Bianchi/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL REGISTRO DELLA PRIMARIA (titolare, 2026-10-08): chi ce l'ha NON si
// anonimizza, ma resta IN elenco con il motivo. Un bambino che sparisce in
// silenzio dall'elenco dell'oblio è il difetto già pagato qui sopra
// (`candidati-esclusi-fuori-elenco`): il pannello spegne il comando, non lo nasconde.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/gdpr/candidates — il registro della primaria', () => {
  beforeEach(() => {
    h.alunni = [
      { id: 'al-1', nome: 'Bambino', cognome: 'DiProva', classe_sezione: 'A', stato: 'ritirato' },
      { id: 'al-2', nome: 'Bambina', cognome: 'DiProva', classe_sezione: 'B', stato: 'ritirato' },
    ]
    h.links = []
  })

  it('chi ha il registro resta in elenco con `registro_primaria: true`; gli altri `false`', async () => {
    h.registro = { valutazioni: [{ alunno_id: 'al-2' }] }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string; registro_primaria: boolean }[]
    expect(json.map((a) => a.id)).toEqual(['al-1', 'al-2'])
    expect(json.find((a) => a.id === 'al-1')!.registro_primaria).toBe(false)
    expect(json.find((a) => a.id === 'al-2')!.registro_primaria).toBe(true)
  })

  it('ogni tabella del registro conta, non solo i voti', async () => {
    h.registro = { certificati_competenze: [{ alunno_id: 'al-1' }] }
    const json = (await (await GET(get())).json()) as { id: string; registro_primaria: boolean }[]
    expect(json.find((a) => a.id === 'al-1')!.registro_primaria).toBe(true)
    expect(json.find((a) => a.id === 'al-2')!.registro_primaria).toBe(false)
  })

  it('una lettura del registro FALLITA → 500: «non ho guardato» non è «non c’è»', async () => {
    h.erroreRegistro = { note_disciplinari: { code: '57014', message: 'timeout' } }
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('GDPR_CANDIDATI_NON_LETTI')
  })
})

describe('GET /api/admin/gdpr/candidates — l’elenco che non si legge', () => {
  it('lettura dell’elenco fallita → 500 con il codice, mai il messaggio grezzo del database', async () => {
    h.erroreAlunni = { code: '42501', message: 'permission denied for table alunni' }
    const res = await GET(get())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('GDPR_CANDIDATI_NON_LETTI')
    expect(JSON.stringify(corpo)).not.toContain('permission denied')
  })
})
