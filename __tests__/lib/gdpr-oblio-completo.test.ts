import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  scrubPersonaIscrizione,
  scrubDomandaIscrizione,
  scrubSanitariDomanda,
} from '@/lib/gdpr/anonimizza'
import { anonimizzaParent, anonimizzaAlunno, REGISTRO_BUCKET_OBLIO } from '@/lib/gdpr/esegui'

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
      b.not = () => b
      b.order = () => b
      b.range = () => b
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
        // `credenziali` non ha nessuna tabella-indice: l'unico modo di ritrovare
        // il PDF di una famiglia è elencare il bucket. Un finto client senza
        // `list` non è un client Supabase, ed è la differenza che dal 2026-08-02
        // decide se una password in chiaro resta lì o no.
        list: async () => ({ data: [] as { name: string }[], error: null }),
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
vi.mock('@/lib/gdpr/orfano', () => ({
  leggiAltriFigliIscritti: vi.fn(async () => ({ ok: true, haAltriFigli: false })),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.in = () => b
      b.order = () => b
      b.range = () => b
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => b
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, ...row }); return b }
      // `parents` risponde anche in forma singola: da quando la route passa da
      // `anonimizzaParent`, l'anagrafica dell'adulto si legge con `maybeSingle`
      // — ed è da lì che escono il codice fiscale e il percorso del documento
      // d'identità. Un doppio che qui risponde `null` farebbe passare per
      // «l'adulto non ha documenti» ciò che è solo un mock incompleto.
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? h.alunno : table === 'parents' ? (h.parents[0] ?? null) : null,
        error: null,
      })
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
        // Serve a due cose diverse, ed entrambe passano da qui: elencare il
        // bucket `credenziali` (che non ha nessuna tabella-indice) e VERIFICARE
        // che un file non uscito non sia rimasto nell'archivio. Elenco vuoto =
        // «non c'è più», che è l'esito voluto.
        list: async () => ({ data: [] as { name: string }[], error: null }),
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
    id: 'al-1', nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato',
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

// ═════════════════════════════════════════════════════════════════════════════
// IL PASSAGGIO INVERSO — si parte dai BUCKET, non dai rilievi.
//
// IL DIFETTO, misurato il 2026-08-02 (collaudo privacy #2). Lo Storage ha 13
// magazzini; l'oblio ne svuotava DUE (`form_attachments` e `gallery`). Restavano
// dentro, senza scadenza e senza che nessuno lo sapesse, le pagelle del bambino
// (32 oggetti), gli allegati scambiati in chat con la scuola (27 — dove per
// dichiarazione della migrazione «passano certificati medici, foto di bambini»),
// i PDF delle credenziali (8), il protocollo (2) e l'allegato di un avviso (1).
//
// LA CAUSA NON È LA SVISTA, È IL METODO. Il ciclo ha lavorato PER RILIEVO — una
// domanda d'iscrizione, un documento d'identità, una foto — e ha chiuso ciascuno
// dentro il suo bucket. Nessuno ha mai fatto il giro contrario: prendere
// l'ELENCO dei bucket e chiedere, uno per uno, «chi lo svuota quando la famiglia
// se ne va?». `fatture` era escluso con una ragione scritta (conservazione
// fiscale); gli altri cinque non erano esclusi — erano **non nominati**, che è la
// forma in cui un dato di un minore resta per sempre senza che nessuno lo abbia
// deciso.
//
// COSA PRETENDE QUESTA PARTE DEL FILE.
//  1. Ogni bucket che esiste — quelli classificati in
//     `__tests__/architecture/bucket-storage-dichiarati.test.ts` e quelli della
//     fotografia della produzione — compare in `REGISTRO_BUCKET_OBLIO`.
//  2. Chi è dichiarato COPERTO viene davvero svuotato: non si crede al registro,
//     si esegue l'oblio su un client finto e si guarda su quali bucket è finita
//     una `remove()`. Un registro che dichiara e non fa è peggio del silenzio.
//  3. Chi è dichiarato ESCLUSO porta la sua ragione scritta, come `fatture`.
//     Un'esclusione motivata è una decisione; un'omissione non è niente.
// ═════════════════════════════════════════════════════════════════════════════

interface CfgB {
  parent?: Record<string, unknown> | null
  iscrizioni?: Record<string, unknown>[]
  media?: Record<string, unknown>[]
  pagelle?: { id: string; file_url: string | null }[]
  certificati?: { id: string; file_path: string | null }[]
  threadAlunno?: { id: string }[]
  threadGenitore?: { id: string }[]
  messaggi?: { id: string; attachment_url: string | null }[]
  /** Gli articoli del blog PUBBLICO che dichiarano il minore fra i ritratti. */
  newsPosts?: Record<string, unknown>[]
  /**
   * Gli ALTRI articoli, cioè quelli che possono possedere gli stessi file. È un
   * insieme diverso dal precedente e deve restarlo: «l'articolo che ritrae il
   * bambino» e «l'articolo che possiede il file» sono le due grandezze che la
   * regressione del 2026-08-03 confondeva, cancellando l'immagine di un altro.
   */
  altriNewsPosts?: Record<string, unknown>[]
  credenziali?: { name: string }[]
  err?: Record<string, { code: string }>
  removeError?: { message: string } | null
  listError?: { message: string } | null
}

function makeFakeBucket(cfg: CfgB) {
  const updates: Record<string, unknown>[] = []
  const deleted: { table: string; ids: unknown }[] = []
  const removed: { bucket: string; paths: string[] }[] = []
  const listati: { bucket: string; prefisso: string }[] = []
  const client = {
    from(table: string) {
      const st: {
        isDelete?: boolean
        eq: Record<string, unknown>
        neq: Record<string, unknown>
        esclusi: string[] | null
        finestra: { da: number; a: number } | null
      } = { eq: {}, neq: {}, esclusi: null, finestra: null }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { st.eq[col] = val; return b }
      b.neq = (col: string, val: unknown) => { st.neq[col] = val; return b }
      b.not = (col: string, op: string, val: unknown) => {
        // `.not('id','in','(a,b)')`: l'esclusione dei post che stanno perdendo i
        // propri file. Si applica DAVVERO — vedi il commento su `news_posts`.
        if (col === 'id' && op === 'in') {
          st.esclusi = String(val).replace(/^\(|\)$/g, '').split(',').filter((x) => x !== '')
        }
        return b
      }
      b.order = () => b
      b.range = (da: number, a: number) => { st.finestra = { da, a }; return b }
      b.in = (_col: string, vals: unknown) => {
        if (st.isDelete) deleted.push({ table, ids: vals })
        return b
      }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => { st.isDelete = true; return b }
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
        if (table === 'pagelle') data = cfg.pagelle ?? []
        if (table === 'certificati_medici') data = cfg.certificati ?? []
        // I thread di un ALUNNO si cercano per `student_id`, quelli di un
        // GENITORE per `parent_id`: sono due insiemi diversi e il finto client
        // deve saperli distinguere, altrimenti il canale genitore risulterebbe
        // coperto grazie ai dati dell'altro.
        if (table === 'chat_threads') {
          data = ('student_id' in st.eq ? cfg.threadAlunno : cfg.threadGenitore) ?? []
        }
        if (table === 'chat_messages') data = cfg.messaggi ?? []
        // Due domande diverse sulla stessa tabella, e il finto client deve
        // distinguerle: «quali articoli ritraggono questo bambino?» (per uuid) e
        // «c'è un ALTRO articolo che nomina questo file?» (una passata a PAGINE,
        // con i post in ritiro esclusi, prima di toglierlo dal bucket pubblico —
        // e l'esclusione qui si applica sul serio, come nel database, perché un
        // finto compiacente renderebbe invisibile proprio il difetto che il
        // controllo chiude). Rispondere alla seconda con le righe
        // della prima significa che il post risponde di sé stesso: il file non
        // uscirebbe mai più e l'oblio smetterebbe di arrivare al bucket.
        if (table === 'news_posts') {
          if (st.finestra) {
            const esclusi = new Set(st.esclusi ?? [])
            data = [...(cfg.altriNewsPosts ?? [])]
              .sort((x, y) => String((x as { id?: unknown }).id).localeCompare(String((y as { id?: unknown }).id)))
              .filter((r) => !esclusi.has(String((r as { id?: unknown }).id)))
              .slice(st.finestra.da, st.finestra.a + 1)
          } else {
            data = cfg.newsPosts ?? []
          }
        }
        return Promise.resolve({ data: error ? null : data, error }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths })
          if (cfg.removeError) return { data: null, error: cfg.removeError }
          return { data: paths.map((p) => ({ name: p })), error: null }
        },
        list: async (prefisso: string) => {
          listati.push({ bucket, prefisso })
          if (cfg.listError) return { data: null, error: cfg.listError }
          return { data: cfg.credenziali ?? [], error: null }
        },
      }),
    },
  }
  return { client, updates, deleted, removed, listati }
}

const bucketToccati = (removed: { bucket: string; paths: string[] }[]) =>
  [...new Set(removed.filter((r) => r.paths.length > 0).map((r) => r.bucket))].sort()

/** L'indirizzo pubblico che `promuoviMediaBozza` scrive nella riga di un articolo. */
const URL_FOTO_NEWS = 'https://esempio.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-abc.jpg'

describe('oblio · la foto sul blog PUBBLICO esce SUBITO, non al prossimo tick', () => {
  // Il bucket `news` è l'unico PUBBLICO dei tredici: è servito a chiunque
  // conosca l'indirizzo, senza login. Fino al 2026-08-03 l'oblio non ci arrivava
  // affatto da qui — `obliaFotoNewsAlunno` era scritta, testata, e non chiamata
  // da nessuna parte in `src/`. La copertura passava solo dal tick, che rilegge i
  // consensi ogni dieci minuti: una finestra di dieci minuti in cui la foto di un
  // bambino di cui è stata chiesta la cancellazione resta a un indirizzo pubblico.
  //
  // Dieci minuti sono poco per un archivio e sono tanto per una famiglia che ha
  // appena esercitato un diritto. Il tick resta — è la rete che prende anche i
  // casi che non passano da `anonimizzaAlunno` — ma non è più l'unica cosa.

  it('ALUNNO · l’oblio toglie l’articolo dalla vista e il file dal bucket `news`', async () => {
    const f = fakePieno()
    await anonimizzaAlunno(f.client as never, { id: 'al-1', documento_path: null }, AT, 'test')
    expect(
      bucketToccati(f.removed),
      'nessuna `remove()` sul bucket `news`: la foto del minore resta a un indirizzo pubblico ' +
        'fino al prossimo tick, e nessuna riga di codice dice che qualcuno se ne occuperà',
    ).toContain('news')
    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd, 'il post non è stato ritirato').toBeTruthy()
    expect(upd!.stato).toBe('nascosta')
    // L'uuid di un bambino cancellato non resta scritto nella riga: è un
    // riferimento a una persona che ha chiesto di sparire.
    expect(upd!.bambini_ritratti).toEqual([])
  })

  it('CONTROLLO POSITIVO — nessun articolo lo ritrae → il bucket `news` non si tocca', async () => {
    // Senza questo controllo, un oblio che manda una `remove()` a vuoto su ogni
    // bucket passerebbe il test qui sopra senza aver cancellato niente.
    const f = makeFakeBucket({ newsPosts: [] })
    await anonimizzaAlunno(f.client as never, { id: 'al-1', documento_path: null }, AT, 'test')
    expect(bucketToccati(f.removed)).not.toContain('news')
  })

  it('il registro dell’oblio dichiara `news` coperto dal canale ALUNNO', () => {
    // La voce e il codice devono dire la stessa cosa: finché `obliaFotoNewsAlunno`
    // non era chiamata da nessuno, il registro lo diceva («NON è ancora sincrona»)
    // ed era onesto. Ora che lo è, un registro fermo alla frase di prima sarebbe
    // una descrizione falsa — la specie di frase che ha già superato questo lock
    // una volta.
    const voce = REGISTRO_BUCKET_OBLIO.news
    expect(voce.stato).toBe('coperto')
    const canali = voce.stato === 'coperto' ? voce.canali : []
    expect(canali).toContain('alunno')
  })
})

describe('oblio · i bucket che restavano pieni (pagelle, certificati, chat, credenziali)', () => {
  it('ALUNNO · la pagella esce dal bucket `pagelle`, e la riga che la indicizza sparisce', async () => {
    const f = makeFakeBucket({ pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const su = f.removed.find((x) => x.bucket === 'pagelle')
    expect(su, 'nessuna `remove()` sul bucket `pagelle`: il PDF con le valutazioni resta').toBeTruthy()
    expect(su!.paths).toEqual(['scr-1/al-1.pdf'])
    // La riga va via insieme al file: `pagelle.file_url` senza file è un indice
    // che punta al vuoto, e resterebbe a dire che quel bambino ha una pagella.
    expect(f.deleted.some((d) => d.table === 'pagelle')).toBe(true)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('ALUNNO · il certificato medico esce da `certificati-medici` con la riga che lo descrive', async () => {
    const f = makeFakeBucket({ certificati: [{ id: 'cm-1', file_path: 'al-1/uuid.pdf' }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const su = f.removed.find((x) => x.bucket === 'certificati-medici')
    expect(su, 'il certificato medico di un minore resta nel bucket').toBeTruthy()
    expect(su!.paths).toEqual(['al-1/uuid.pdf'])
    // `certificati_medici.note` e `nota_validazione` sono testo libero scritto
    // da un genitore e da chi valida: la riga non si può lasciare.
    expect(f.deleted.some((d) => d.table === 'certificati_medici')).toBe(true)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('ALUNNO · gli allegati dei suoi thread escono da `chat-allegati` e il percorso in tabella si azzera', async () => {
    const f = makeFakeBucket({
      threadAlunno: [{ id: 'th-1' }],
      messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/uuid-referto.pdf' }],
    })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const su = f.removed.find((x) => x.bucket === 'chat-allegati')
    expect(su, 'gli allegati della chat non escono dal bucket').toBeTruthy()
    expect(su!.paths).toEqual(['auth-9/uuid-referto.pdf'])
    // Il percorso è esso stesso un dato: contiene l'uuid di chi ha caricato e il
    // NOME del file scelto dalla famiglia, che quasi sempre è il nome di una
    // persona o la parola «referto».
    const upd = f.updates.find((u) => u.table === 'chat_messages')
    expect(upd, '`chat_messages.attachment_url` resta scritto in tabella').toBeTruthy()
    expect(upd!.attachment_url).toBeNull()
  })

  it('GENITORE · allegati dei SUOI thread + PDF delle credenziali escono dai bucket', async () => {
    const f = makeFakeBucket({
      parent: { auth_user_id: 'auth-1', fiscal_code: null, documento_path: null },
      threadGenitore: [{ id: 'th-9' }],
      messaggi: [{ id: 'ms-9', attachment_url: 'auth-1/uuid-foto.jpg' }],
      credenziali: [{ name: 'p-1-1700000000000.pdf' }, { name: 'altro-1700000000000.pdf' }],
    })
    await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(f.removed.find((x) => x.bucket === 'chat-allegati')?.paths).toEqual(['auth-1/uuid-foto.jpg'])
    const cred = f.removed.find((x) => x.bucket === 'credenziali')
    expect(cred, 'il PDF con la password in chiaro resta nel bucket `credenziali`').toBeTruthy()
    // Controllo positivo E negativo nella stessa asserzione: si toglie il PDF di
    // QUESTO genitore e non quello di un altro. Il nome del file è
    // `<id>-<timestamp>.pdf`, quindi il confronto è sul prefisso `<id>-`: una
    // ricerca per sottostringa toglierebbe le credenziali a una famiglia che non
    // ha chiesto niente.
    expect(cred!.paths).toEqual(['p-1-1700000000000.pdf'])
  })

  it('GENITORE · niente da togliere → lo Storage non si tocca affatto', async () => {
    const f = makeFakeBucket({ parent: { auth_user_id: 'auth-1', fiscal_code: null, documento_path: null } })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(f.removed.filter((x) => x.paths.length > 0)).toHaveLength(0)
    expect(r.fileRimossi).toBe(0)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('schema assente (DB E2E della CI non migrato) → nessun file, nessun rumore', async () => {
    const f = makeFakeBucket({
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
      certificati: [{ id: 'cm-1', file_path: 'al-1/uuid.pdf' }],
      threadAlunno: [{ id: 'th-1' }],
      messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/x.pdf' }],
      err: {
        pagelle: { code: 'PGRST205' },
        certificati_medici: { code: 'PGRST205' },
        chat_threads: { code: 'PGRST205' },
        chat_messages: { code: 'PGRST205' },
      },
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.removed.filter((x) => x.paths.length > 0)).toHaveLength(0)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('storage KO su un bucket nuovo → l’oblio parziale è VISIBILE nel conteggio', async () => {
    const f = makeFakeBucket({
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
      removeError: { message: 'storage down' },
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(
      r.fileNonRimossi,
      'una rimozione fallita su `pagelle` non arriva a chi ha eseguito l’oblio',
    ).toBeGreaterThan(0)
  })

  it('elenco delle credenziali non leggibile → l’oblio si dichiara INCOMPLETO', async () => {
    // Se il bucket non si può elencare non si sa che cosa ci fosse da togliere.
    // Rispondere «0 file non rimossi» vorrebbe dire «niente da fare», ed è
    // esattamente l'ambiguità che ha nascosto per mesi il guasto delle email.
    const f = makeFakeBucket({
      parent: { auth_user_id: 'auth-1', fiscal_code: null, documento_path: null },
      listError: { message: 'storage down' },
    })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(r.fileNonRimossi).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL LOCK — ogni magazzino ha un responsabile, o una ragione scritta per non averlo
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()

/**
 * I bucket CLASSIFICATI in `__tests__/architecture/bucket-storage-dichiarati.test.ts`.
 *
 * Si legge il file come TESTO, non si importa: quel lock è di un'altra famiglia
 * (visibilità dei bucket) e importarlo ne eseguirebbe i test dentro questo file.
 * Quello che serve qui è solo l'elenco dei nomi — cioè la domanda «quali
 * magazzini esistono», a cui quel file risponde già ed è l'unico posto dove
 * qualcuno si ricorderà di aggiungere il prossimo.
 */
function bucketClassificati(): string[] {
  const testo = readFileSync(
    join(RADICE, '__tests__', 'architecture', 'bucket-storage-dichiarati.test.ts'),
    'utf8',
  )
  const riservati = /const RISERVATI = \[([\s\S]*?)\] as const/.exec(testo)?.[1] ?? ''
  const pubblici =
    /const PUBBLICI_PER_DECISIONE: Record<string, string> = \{([\s\S]*?)\n\}/.exec(testo)?.[1] ?? ''
  const nomi = [
    ...[...riservati.matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]),
    // Le chiavi dell'oggetto: due spazi di rientro, poi il nome, poi i due punti.
    ...[...pubblici.matchAll(/^ {2}([a-z0-9_-]+):/gm)].map((m) => m[1]),
  ]
  return [...new Set(nomi)].sort()
}

/** I bucket che ESISTONO davvero, dalla fotografia versionata della produzione. */
function bucketInProduzione(): string[] {
  const foto = JSON.parse(
    readFileSync(join(RADICE, '__tests__', 'fixtures', 'bucket-storage-snapshot.json'), 'utf8'),
  ) as { bucket: { id: string }[] }
  return foto.bucket.map((b) => b.id).sort()
}

const NOTI = [...new Set([...bucketClassificati(), ...bucketInProduzione()])].sort()

/** Un client finto con OGNI sorgente piena: tutto ciò che l'oblio può trovare. */
function fakePieno() {
  return makeFakeBucket({
    parent: {
      auth_user_id: 'auth-1',
      fiscal_code: 'EEEFFF80C03H501Z',
      documento_path: 'anagrafica/doc-adulto.pdf',
    },
    iscrizioni: [{ id: 'sub-1', data: domandaDiProva() }],
    media: [{ id: 'md-1', file_url: 'uploads/u1/foto.jpg', tag_students: ['al-1'] }],
    pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }],
    certificati: [{ id: 'cm-1', file_path: 'al-1/uuid.pdf' }],
    threadAlunno: [{ id: 'th-1' }],
    threadGenitore: [{ id: 'th-9' }],
    messaggi: [{ id: 'ms-1', attachment_url: 'auth-9/uuid-referto.pdf' }],
    newsPosts: [
      {
        id: 'np-1',
        stato: 'pubblicata',
        bambini_ritratti: ['al-1'],
        copertina_url: URL_FOTO_NEWS,
        contenuto_json: null,
      },
    ],
    credenziali: [{ name: 'p-1-1700000000000.pdf' }, { name: 'auth-1-1700000000001.pdf' }],
  })
}

const copertiPerCanale = (canale: 'alunno' | 'genitore') =>
  Object.entries(REGISTRO_BUCKET_OBLIO)
    .filter(([, v]) => v.stato === 'coperto' && v.canali.includes(canale))
    .map(([k]) => k)
    .sort()

const esclusi = Object.entries(REGISTRO_BUCKET_OBLIO)
  .filter(([, v]) => v.stato === 'escluso')
  .map(([k]) => k)

describe('lock · l’oblio conosce OGNI magazzino dello Storage', () => {
  it('l’elenco dei bucket si legge davvero (sanity: se cade, tutto il resto è verde sul vuoto)', () => {
    // Un parser rotto renderebbe questo lock verde per sempre, su niente — ed è
    // il modo più silenzioso di non controllare nulla.
    expect(bucketClassificati().length, 'nessun bucket letto da `bucket-storage-dichiarati.test.ts`').toBeGreaterThan(9)
    expect(bucketInProduzione().length, 'fotografia dello Storage vuota o illeggibile').toBeGreaterThan(9)
    expect(bucketClassificati()).toContain('form_attachments')
    expect(bucketClassificati()).toContain('news')
  })

  it('OGNI bucket noto è nel registro dell’oblio: coperto, oppure escluso con la ragione', () => {
    const senzaResponsabile = NOTI.filter((b) => !(b in REGISTRO_BUCKET_OBLIO))
    expect(
      senzaResponsabile,
      `Questi magazzini esistono e nessuno dice chi li svuota quando una famiglia se ne va:\n` +
        `  ${senzaResponsabile.join('\n  ')}\n` +
        `Aggiungili a \`REGISTRO_BUCKET_OBLIO\` in \`src/lib/gdpr/esegui.ts\`: o come ` +
        `\`coperto\` (e allora ci vuole il codice che li svuota, non basta scriverlo) o come ` +
        `\`escluso\` con la ragione. Un bucket NON NOMINATO è la forma in cui il dato di un ` +
        `minore resta per sempre senza che nessuno lo abbia deciso: è successo a cinque ` +
        `magazzini su sette fino al 2026-08-02.`,
    ).toEqual([])
  })

  it('il registro non contiene magazzini inventati (una copertura su niente è peggio del niente)', () => {
    const fantasmi = Object.keys(REGISTRO_BUCKET_OBLIO).filter((b) => !NOTI.includes(b))
    expect(
      fantasmi,
      `Il registro dell'oblio nomina bucket che non esistono: ${fantasmi.join(', ')}. ` +
        `Se un bucket è stato cancellato, di' dove sono finiti i suoi file; se è stato ` +
        `rinominato, il codice che lo svuota sta puntando al posto sbagliato e non se ne ` +
        `accorge nessuno.`,
    ).toEqual([])
  })

  it('ogni esclusione porta la sua ragione scritta, come `fatture`', () => {
    expect(esclusi.length, 'nessuna esclusione: il registro non è stato compilato').toBeGreaterThan(0)
    for (const b of esclusi) {
      const voce = REGISTRO_BUCKET_OBLIO[b]
      const motivo = voce.stato === 'escluso' ? voce.motivo : ''
      expect(
        motivo.trim().length,
        `\`${b}\` è escluso dall'oblio senza una ragione scritta. Un'esclusione senza motivo ` +
          `non è una decisione, è un'omissione con un'etichetta sopra: scrivi PERCHÉ quel ` +
          `magazzino non si svuota (obbligo di legge? nessun aggancio all'interessato? ` +
          `retention separata?) e chi lo ha deciso.`,
      ).toBeGreaterThan(80)
    }
  })

  it('ALUNNO · i bucket dichiarati coperti vengono davvero svuotati (non si crede al registro)', async () => {
    const f = fakePieno()
    await anonimizzaAlunno(
      f.client as never,
      { id: 'al-1', codice_fiscale: 'AAABBB10A01H501X', documento_path: 'anagrafica/doc-alunno.pdf' },
      AT,
      'test',
    )
    const toccati = bucketToccati(f.removed)
    const mancanti = copertiPerCanale('alunno').filter((b) => !toccati.includes(b))
    expect(
      mancanti,
      `Il registro dichiara questi bucket coperti per l'ALUNNO, ma \`anonimizzaAlunno\` non ` +
        `ci manda nessuna \`remove()\`: ${mancanti.join(', ')}. Un registro che dichiara e ` +
        `non fa è peggio del silenzio: fa rispondere «fatto» a una famiglia.`,
    ).toEqual([])
  })

  it('GENITORE · i bucket dichiarati coperti vengono davvero svuotati', async () => {
    const f = fakePieno()
    await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const toccati = bucketToccati(f.removed)
    const mancanti = copertiPerCanale('genitore').filter((b) => !toccati.includes(b))
    expect(
      mancanti,
      `Il registro dichiara questi bucket coperti per il GENITORE, ma \`anonimizzaParent\` ` +
        `non ci manda nessuna \`remove()\`: ${mancanti.join(', ')}.`,
    ).toEqual([])
  })

  it('nessun oblio tocca un bucket ESCLUSO (le fatture non si cancellano)', async () => {
    // Il verso opposto, ed è un presidio vero: `fatture` ha dieci anni di
    // conservazione obbligatoria, `protocollo` è un registro DPR 445. Una
    // `remove()` di troppo qui non è un dato in più cancellato: è un obbligo di
    // legge violato dall'automatismo che doveva rispettarne un altro.
    const fa = fakePieno()
    await anonimizzaAlunno(fa.client as never, { id: 'al-1', documento_path: 'anagrafica/doc.pdf' }, AT, 'test')
    const fg = fakePieno()
    await anonimizzaParent(fg.client as never, 'p-1', AT, 'test')
    const toccati = [...new Set([...bucketToccati(fa.removed), ...bucketToccati(fg.removed)])]
    expect(toccati.filter((b) => esclusi.includes(b))).toEqual([])
    // Controllo positivo: se il fake non facesse toccare NIENTE, la riga qui
    // sopra sarebbe verde su un oblio che non è mai partito.
    expect(toccati.length, 'il client finto non ha prodotto nessuna rimozione').toBeGreaterThan(3)
  })
})
