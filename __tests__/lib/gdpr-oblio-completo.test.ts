import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  scrubPersonaIscrizione,
  scrubDomandaIscrizione,
  scrubSanitariDomanda,
} from '@/lib/gdpr/anonimizza'
import { anonimizzaParent, anonimizzaAlunno } from '@/lib/gdpr/esegui'

// =============================================================================
// S22 — L'OBLIO SEGUE IL DATO, NON LA RIGA.
//
// Due difetti MISURATI in produzione il 2026-07-31 (collaudo privacy, F2 e F3):
//
//  F2. Le 243 domande di iscrizione (152 codici fiscali di minori, 240 ancora
//      `pending`) non erano toccate da NESSUN flusso di oblio. Dopo una
//      cancellazione l'anagrafica risultava anonimizzata mentre la domanda
//      originale conservava in chiaro nome, cognome, codice fiscale, data di
//      nascita, residenza, ALLERGIE e NOTE MEDICHE del minore, più identità
//      completa, numero del documento, email e telefono degli adulti.
//
//  F3. Il documento d'identità degli ADULTI non veniva MAI rimosso dallo
//      storage: si rimuoveva solo quello dell'alunno, e per giunta dentro un
//      `catch { }` muto — quindi un oblio fallito a metà non lasciava traccia
//      da nessuna parte, e alla famiglia si sarebbe risposto «fatto».
//
// Più i due warning della stessa famiglia: le FOTO del minore restavano in
// `galleria_media_v2` (riga, file e `tag_students`), e nessun conteggio dei
// file NON rimossi tornava a chi ha eseguito l'oblio.
//
// Le asserzioni qui sotto sono sulla MUTAZIONE (che cosa è stato scritto,
// cancellato, rimosso), mai sul solo status: uno status 200 non dice se il
// documento d'identità di un bambino è ancora nel bucket.
// =============================================================================

const AT = '2026-08-01T09:00:00Z'

// Una domanda di iscrizione realistica nella FORMA (le chiavi sono quelle vere,
// verificate sul database di produzione), con valori palesemente inventati:
// questo repository è pubblico e non ci entra un dato di una famiglia.
function domandaDiProva() {
  return {
    children: [
      {
        nome: 'Bambino',
        cognome: 'DiProva',
        codice_fiscale: 'AAABBB10A01H501X',
        data_nascita: '2021-03-04',
        gender: 'M',
        birth_city: 'Città Finta',
        birth_province: 'NA',
        birth_nation: 'Italia',
        citizenship: 'Italiana',
        residence_address: 'Via Inventata',
        residence_street_number: '1',
        residence_city: 'Città Finta',
        residence_province: 'NA',
        zip_code: '80000',
        allergies: 'DATO SANITARIO DI PROVA',
        note_mediche: 'ALTRO DATO SANITARIO DI PROVA',
        documento_path: 'iscrizioni/doc-bambino.pdf',
      },
      {
        nome: 'Fratello',
        cognome: 'NonCoinvolto',
        codice_fiscale: 'CCCDDD11B02H501Y',
        allergies: 'ALLERGIA DEL FRATELLO',
        note_mediche: null,
        documento_path: 'iscrizioni/doc-fratello.pdf',
      },
    ],
    adults: [
      {
        ruolo: 'madre',
        first_name: 'Adulta',
        last_name: 'DiProva',
        fiscal_code: 'EEEFFF80C03H501Z',
        email: 'adulta@example.invalid',
        phone: '0000000000',
        document_type: 'CI',
        document_number: 'XX0000000',
        documento_path: 'iscrizioni/doc-adulto.pdf',
        birth_date: '1980-03-03',
        birth_place: 'Città Finta',
        birth_province: 'NA',
        birth_nation: 'Italia',
        citizenship: 'Italiana',
        address: 'Via Inventata',
        residence_street_number: '1',
        residence_city: 'Città Finta',
        residence_province: 'NA',
        zip_code: '80000',
      },
    ],
  }
}

describe('scrubPersonaIscrizione — la persona dentro la domanda', () => {
  it('azzera identità, contatti, residenza, documento e DATI SANITARI, marcando l’anonimizzazione', () => {
    const p = domandaDiProva().children[0]
    const out = scrubPersonaIscrizione(p, AT)
    for (const campo of [
      'nome', 'cognome', 'codice_fiscale', 'data_nascita', 'birth_city',
      'residence_address', 'residence_city', 'zip_code',
      'allergies', 'note_mediche', 'documento_path',
    ]) {
      expect(out[campo], `campo residuo: ${campo}`).toBeNull()
    }
    expect(out.anonimizzato_il).toBe(AT)
  })

  it('CONSERVA i campi non identificanti (il `ruolo` dell’adulto), che servono a rileggere la domanda', () => {
    const a = domandaDiProva().adults[0]
    const out = scrubPersonaIscrizione(a, AT)
    // Controllo positivo accanto a quelli negativi: se lo scrub azzerasse tutto
    // indistintamente, questa asserzione cadrebbe per prima.
    expect(out.ruolo).toBe('madre')
    expect(out.first_name).toBeNull()
    expect(out.fiscal_code).toBeNull()
    expect(out.document_number).toBeNull()
  })
})

describe('scrubDomandaIscrizione — solo il soggetto dell’oblio, non l’intera famiglia', () => {
  it('aggancia il minore per CODICE FISCALE e lascia intatto il fratello non coinvolto', () => {
    const r = scrubDomandaIscrizione(domandaDiProva(), { codiciFiscali: ['aaabbb10a01h501x'] }, AT)
    const children = (r.data as { children: Record<string, unknown>[] }).children
    expect(children[0].nome).toBeNull()
    expect(children[0].allergies).toBeNull()
    expect(children[0].codice_fiscale).toBeNull()
    // Controllo positivo: il fratello NON è oggetto della richiesta e resta.
    expect(children[1].nome).toBe('Fratello')
    expect(children[1].allergies).toBe('ALLERGIA DEL FRATELLO')
    expect(r.personeScrubbate).toBe(1)
    // Il percorso del file va RESTITUITO: è l'unico posto da cui si ricava che
    // esiste un documento d'identità da togliere dallo storage.
    expect(r.documenti).toEqual(['iscrizioni/doc-bambino.pdf'])
  })

  it('aggancia l’ADULTO per codice fiscale e restituisce il suo documento (F3)', () => {
    const r = scrubDomandaIscrizione(domandaDiProva(), { codiciFiscali: ['EEEFFF80C03H501Z'] }, AT)
    const adults = (r.data as { adults: Record<string, unknown>[] }).adults
    expect(adults[0].first_name).toBeNull()
    expect(adults[0].email).toBeNull()
    expect(adults[0].document_number).toBeNull()
    expect(r.documenti).toEqual(['iscrizioni/doc-adulto.pdf'])
    // I bambini non c'entrano con la richiesta dell'adulto? Ci entrano eccome
    // quando è il genitore a chiedere: ma questo helper scrubba SOLO chi gli
    // viene indicato. Il perimetro lo decide il chiamante.
    const children = (r.data as { children: Record<string, unknown>[] }).children
    expect(children[0].nome).toBe('Bambino')
  })

  it('aggancia anche per PERCORSO del documento (soggetti senza CF in domanda)', () => {
    const r = scrubDomandaIscrizione(
      domandaDiProva(),
      { documentoPaths: ['iscrizioni/doc-fratello.pdf'] },
      AT,
    )
    const children = (r.data as { children: Record<string, unknown>[] }).children
    expect(children[1].nome).toBeNull()
    expect(children[0].nome).toBe('Bambino')
    expect(r.personeScrubbate).toBe(1)
  })

  it('nessun soggetto combacia → nessuna modifica e nessun documento da rimuovere', () => {
    const r = scrubDomandaIscrizione(domandaDiProva(), { codiciFiscali: ['ZZZZZZ00Z00Z000Z'] }, AT)
    expect(r.personeScrubbate).toBe(0)
    expect(r.documenti).toEqual([])
    expect(r.data).toEqual(domandaDiProva())
  })
})

describe('scrubSanitariDomanda — la copia ridondante dei dati di salute', () => {
  it('toglie SOLO allergie e note mediche, lasciando il resto della domanda', () => {
    const r = scrubSanitariDomanda(domandaDiProva(), AT)
    const children = (r.data as { children: Record<string, unknown>[] }).children
    expect(children[0].allergies).toBeNull()
    expect(children[0].note_mediche).toBeNull()
    expect(children[1].allergies).toBeNull()
    // Controllo positivo: l'identità resta — la domanda approvata è un atto
    // amministrativo, e questo scrub non è una cancellazione.
    expect(children[0].nome).toBe('Bambino')
    expect(children[0].codice_fiscale).toBe('AAABBB10A01H501X')
    expect(r.minoriScrubbati).toBe(2)
  })

  it('domanda già ripulita → nessuna modifica da segnalare', () => {
    const pulita = scrubSanitariDomanda(domandaDiProva(), AT).data
    expect(scrubSanitariDomanda(pulita, AT).minoriScrubbati).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase: cattura update/delete/remove per tabella, con dati per tabella.
// ─────────────────────────────────────────────────────────────────────────────
interface Cfg {
  parent?: Record<string, unknown> | null
  iscrizioni?: Record<string, unknown>[]
  media?: Record<string, unknown>[]
  removeError?: { message: string } | null
  removeData?: { name: string }[] | null
  err?: Record<string, { code: string }>
}

function makeFake(cfg: Cfg) {
  const updates: Record<string, unknown>[] = []
  const deleted: { table: string; ids: unknown }[] = []
  const removed: { bucket: string; paths: string[] }[] = []
  const client = {
    from(table: string) {
      const state: { isDelete?: boolean } = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.in = (_col: string, vals: unknown) => {
        if (state.isDelete) deleted.push({ table, ids: vals })
        return b
      }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => { state.isDelete = true; return b }
      b.update = (row: Record<string, unknown>) => { updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({
        data: table === 'parents' ? (cfg.parent ?? null) : null,
        error: cfg.err?.[table] ?? null,
      })
      b.then = (res: (v: unknown) => unknown) => {
        const error = cfg.err?.[table] ?? null
        let data: unknown[] = []
        if (table === 'enrollment_submissions') data = cfg.iscrizioni ?? []
        if (table === 'galleria_media_v2') data = cfg.media ?? []
        return Promise.resolve({ data: error ? null : data, error }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths })
          if (cfg.removeError) return { data: null, error: cfg.removeError }
          return { data: cfg.removeData ?? paths.map((p) => ({ name: p })), error: null }
        },
      }),
    },
  }
  return { client, updates, deleted, removed }
}

describe('anonimizzaAlunno — l’oblio arriva alla domanda e allo storage (F2 + F3)', () => {
  it('scrubba la domanda di iscrizione del minore e rimuove il documento allegato', async () => {
    const f = makeFake({
      iscrizioni: [{ id: 'sub-1', data: domandaDiProva() }],
    })
    const r = await anonimizzaAlunno(
      f.client as never,
      { id: 'al-1', codice_fiscale: 'AAABBB10A01H501X', documento_path: 'anagrafica/doc-alunno.pdf' },
      AT,
      'test',
    )
    // 1. La riga della domanda è stata RISCRITTA con il minore ripulito.
    const subUpd = f.updates.find((u) => u.table === 'enrollment_submissions')
    expect(subUpd, 'la domanda di iscrizione non è stata toccata').toBeTruthy()
    const nuovoData = subUpd!.data as { children: Record<string, unknown>[] }
    expect(nuovoData.children[0].codice_fiscale).toBeNull()
    expect(nuovoData.children[0].allergies).toBeNull()
    expect(nuovoData.children[0].note_mediche).toBeNull()
    expect(nuovoData.children[1].nome).toBe('Fratello') // controllo positivo
    expect(r.iscrizioniScrubbate).toBe(1)

    // 2. I file rimossi sono ENTRAMBI: quello in anagrafica e quello che solo la
    //    domanda conosceva.
    const percorsi = f.removed.flatMap((x) => x.paths)
    expect(percorsi).toContain('anagrafica/doc-alunno.pdf')
    expect(percorsi).toContain('iscrizioni/doc-bambino.pdf')
    expect(r.fileNonRimossi).toBe(0)
  })

  it('rimozione dallo storage fallita → conteggio VISIBILE, non un catch muto', async () => {
    const f = makeFake({
      iscrizioni: [],
      removeError: { message: 'storage down' },
    })
    const r = await anonimizzaAlunno(
      f.client as never,
      { id: 'al-1', documento_path: 'anagrafica/doc-alunno.pdf' },
      AT,
      'test',
    )
    expect(r.fileNonRimossi).toBe(1)
    expect(r.file).toBe(0)
  })

  it('degrada in silenzio se `enrollment_submissions` non esiste (DB E2E non migrato)', async () => {
    const f = makeFake({ err: { enrollment_submissions: { code: 'PGRST205' } } })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1', codice_fiscale: 'AAABBB10A01H501X' }, AT, 'test')
    expect(r.iscrizioniScrubbate).toBe(0)
  })

  it('foto del minore: media taggato SOLO a lui → riga cancellata e file rimosso', async () => {
    const f = makeFake({
      media: [{ id: 'md-1', file_url: 'uploads/u1/foto.jpg', tag_students: ['al-1'] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.deleted.some((d) => d.table === 'galleria_media_v2')).toBe(true)
    expect(f.removed.flatMap((x) => x.paths)).toContain('uploads/u1/foto.jpg')
    expect(r.fotoRimosse).toBe(1)
    expect(r.fotoSganciate).toBe(0)
  })

  it('foto di gruppo con altri bambini → si toglie SOLO il tag, la foto degli altri resta', async () => {
    const f = makeFake({
      media: [{ id: 'md-2', file_url: 'uploads/u1/gruppo.jpg', tag_students: ['al-1', 'al-2'] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const mediaUpd = f.updates.find((u) => u.table === 'galleria_media_v2')
    expect(mediaUpd).toBeTruthy()
    expect(mediaUpd!.tag_students).toEqual(['al-2'])
    // La riga NON si cancella e il file NON si rimuove: dentro c'è l'immagine di
    // un altro minore, e l'oblio di uno non autorizza a cancellare il dato altrui.
    expect(f.deleted.some((d) => d.table === 'galleria_media_v2')).toBe(false)
    expect(f.removed.flatMap((x) => x.paths)).not.toContain('uploads/u1/gruppo.jpg')
    expect(r.fotoRimosse).toBe(0)
    expect(r.fotoSganciate).toBe(1)
  })
})

describe('anonimizzaParent — il documento dell’ADULTO esce davvero dal bucket (F3)', () => {
  it('raccoglie CF e documento PRIMA del patch, scrubba la domanda e rimuove il file', async () => {
    const f = makeFake({
      parent: {
        auth_user_id: 'auth-1',
        fiscal_code: 'EEEFFF80C03H501Z',
        documento_path: 'anagrafica/doc-adulto.pdf',
      },
      iscrizioni: [{ id: 'sub-1', data: domandaDiProva() }],
    })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const subUpd = f.updates.find((u) => u.table === 'enrollment_submissions')
    expect(subUpd, 'la domanda non è stata scrubbata per l’adulto').toBeTruthy()
    const nuovoData = subUpd!.data as { adults: Record<string, unknown>[]; children: Record<string, unknown>[] }
    expect(nuovoData.adults[0].fiscal_code).toBeNull()
    expect(nuovoData.adults[0].email).toBeNull()
    expect(nuovoData.children[0].nome).toBe('Bambino') // controllo positivo
    const percorsi = f.removed.flatMap((x) => x.paths)
    expect(percorsi).toContain('anagrafica/doc-adulto.pdf')
    expect(percorsi).toContain('iscrizioni/doc-adulto.pdf')
    expect(r.iscrizioniScrubbate).toBe(1)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('genitore senza documento e senza domande → nessuna chiamata allo storage', async () => {
    const f = makeFake({ parent: { auth_user_id: 'auth-1', fiscal_code: null, documento_path: null } })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(f.removed).toHaveLength(0)
    expect(r.fileRimossi).toBe(0)
    expect(r.fileNonRimossi).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La route del diritto all'oblio (Direzione): stessa correzione, altro canale.
// ─────────────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  parents: [] as Record<string, unknown>[],
  iscrizioni: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  removed: [] as string[],
  removeError: null as { message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/orfano', () => ({ parentHaAltriFigliIscritti: vi.fn(async () => false) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.in = () => b
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => b
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({ data: table === 'alunni' ? h.alunno : null, error: null })
      b.then = (res: (v: unknown) => unknown) => {
        let data: unknown[] = []
        if (table === 'student_parents') data = [{ parent_id: 'p-1' }]
        if (table === 'parents') data = h.parents
        if (table === 'enrollment_submissions') data = h.iscrizioni
        return Promise.resolve({ data, error: null }).then(res)
      }
      return b
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          h.removed.push(...paths)
          if (h.removeError) return { data: null, error: h.removeError }
          return { data: paths.map((p) => ({ name: p })), error: null }
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.alunno = {
    id: 'al-1', nome: 'Bambino', cognome: 'DiProva', stato: 'non_iscritto',
    anonimizzato_il: null, documento_path: 'anagrafica/doc-alunno.pdf',
    codice_fiscale: 'AAABBB10A01H501X', fiscal_code: null, scuola_id: 'sc-1', section_id: null,
  }
  h.parents = [{ auth_user_id: 'auth-1', fiscal_code: 'EEEFFF80C03H501Z', documento_path: 'anagrafica/doc-adulto.pdf' }]
  h.iscrizioni = [{ id: 'sub-1', data: domandaDiProva() }]
  h.updates = []
  h.removed = []
  h.removeError = null
})

describe('POST /api/admin/gdpr/erase — l’oblio segue il dato', () => {
  it('rimuove il documento dell’ADULTO oltre a quello dell’alunno (F3)', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(200)
    // Controllo positivo (quello che già funzionava) accanto a quello nuovo:
    // se la raccolta dei percorsi si rompesse in blocco, cadrebbe per primo.
    expect(h.removed).toContain('anagrafica/doc-alunno.pdf')
    expect(h.removed).toContain('anagrafica/doc-adulto.pdf')
    const json = await res.json()
    expect(json.n_file_non_rimossi).toBe(0)
  })

  it('scrubba la domanda di iscrizione del minore e dell’adulto (F2)', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(200)
    const subUpd = h.updates.filter((u) => u.table === 'enrollment_submissions')
    expect(subUpd.length).toBeGreaterThan(0)
    const scrubbata = subUpd.some((u) => {
      const d = u.data as { children?: Record<string, unknown>[]; adults?: Record<string, unknown>[] }
      return d?.children?.[0]?.codice_fiscale === null && d?.children?.[0]?.allergies === null
    })
    expect(scrubbata, 'nessuna domanda è stata ripulita').toBe(true)
    const json = await res.json()
    expect(json.iscrizioni_scrubbate).toBeGreaterThanOrEqual(1)
  })

  it('storage KO → l’oblio PARZIALE si vede nella risposta, non sparisce in un catch', async () => {
    h.removeError = { message: 'storage down' }
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'diprova bambino' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.n_file_non_rimossi).toBeGreaterThan(0)
    expect(json.file_rimossi).toBe(0)
  })
})
