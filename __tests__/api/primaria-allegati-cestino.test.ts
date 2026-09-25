// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { dataRomaDi } from '@/lib/primaria/timelock'
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro'

// =============================================================================
// R2 — ALLEGATI DEL REGISTRO: cestino, ripristino, rinomina, sostituzione.
//
// Spec 2026-09-24 («2 Primaria», «Decisioni aggiunte», «Convenzioni»):
//  · DELETE → nel cestino (`eliminato_il`, `eliminato_da`, slot dalla lezione),
//    il file RESTA nello Storage;
//  · POST cestino { id } → ripristino entro 7 giorni; senza lezione si riaggancia a
//    quella rifirmata nello stesso slot, altrimenti 409 LEZIONE_DA_RIFIRMARE;
//  · PATCH { id, nome } → rinomina; sostituzione = file nuovo + RIGA nuova, vecchia
//    nel cestino;
//  · GET cestino della classe coi giorni residui;
//  · permessi da `permesso-voce` (VERO, non mockato): autore o staff, termine sulla
//    data della lezione, sblocco della Direzione.
//
// Il database è il finto Supabase che APPLICA filtri e scritture: le asserzioni
// guardano che cosa resta nelle tabelle e che cosa è stato chiesto allo Storage.
// =============================================================================

const SEZ = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRA_SEDE = '11111111-3333-4111-8111-bbbbbbbbbbbb'
const DOCENTE = '99999999-1111-4111-8111-aaaaaaaaaaaa'
const COLLEGA = '99999999-2222-4111-8111-aaaaaaaaaaaa'
const SEGRETERIA = '99999999-3333-4111-8111-aaaaaaaaaaaa'
const LEZ = '22222222-0000-4000-8000-000000000001'
const LEZ_VECCHIA = '22222222-0000-4000-8000-000000000002'
const LEZ_SEDE_B = '22222222-0000-4000-8000-000000000003'
const LEZ_RIFIRMATA = '22222222-0000-4000-8000-000000000004'
const ALL_MIO = '66666666-0000-4000-8000-000000000001'
const ALL_COLLEGA = '66666666-0000-4000-8000-000000000002'
const ALL_VECCHIO = '66666666-0000-4000-8000-000000000003'
const ALL_SEDE_B = '66666666-0000-4000-8000-000000000004'
const ALL_NEL_CESTINO = '66666666-0000-4000-8000-000000000005'
const ALL_ORFANO = '66666666-0000-4000-8000-000000000006'
const ALL_SCADUTO = '66666666-0000-4000-8000-000000000007'
const ALL_ORFANO_SENZA = '66666666-0000-4000-8000-000000000008'
const ALL_VECCHIO_CESTINO = '66666666-0000-4000-8000-00000000000a'
const ALL_CESTINO_SEDE_B = '66666666-0000-4000-8000-00000000000b'
const ALL_ORFANO_SEDE_B = '66666666-0000-4000-8000-00000000000c'
const LEZ_RIFIRMATA_SEDE_B = '22222222-0000-4000-8000-000000000005'

const OGGI = dataRomaDi(new Date().toISOString())
/** Una data ben oltre il termine di 2 giorni. */
const LONTANA = '2026-01-12'
const GIORNO_MS = 24 * 60 * 60 * 1000
const fa = (giorni: number) => new Date(Date.now() - giorni * GIORNO_MS).toISOString()

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, unknown>,
  logScrittura: vi.fn(),
  notificaTitolari: vi.fn(),
  storage: [] as Array<{ op: string; bucket: string; percorsi: string[] }>,
  uploadFallisce: false,
}))

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => {
    const client = creaFintoSupabase(h.db, h.tabelle, {
      scritture: h.scritture as never,
      errori: h.errori as never,
    }) as unknown as { storage: unknown }
    client.storage = {
      listBuckets: async () => ({ data: [{ name: 'registro-allegati' }], error: null }),
      createBucket: async () => ({ data: null, error: null }),
      updateBucket: async () => ({ data: null, error: null }),
      from: (bucket: string) => ({
        upload: async (percorso: string) => {
          h.storage.push({ op: 'upload', bucket, percorsi: [percorso] })
          return h.uploadFallisce
            ? { data: null, error: { message: 'quota', statusCode: '500' } }
            : { data: { path: percorso }, error: null }
        },
        remove: async (percorsi: string[]) => {
          h.storage.push({ op: 'remove', bucket, percorsi })
          return { data: [], error: null }
        },
        createSignedUrl: async (percorso: string, ttl: number) => {
          h.storage.push({ op: `firma:${ttl}`, bucket, percorsi: [percorso] })
          return { data: { signedUrl: `https://finto/${bucket}/${percorso}?t=1` }, error: null }
        },
      }),
    }
    return client
  }
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: vi.fn(),
  notificaTitolariScrittura: h.notificaTitolari,
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/primaria/allegati/route'
import { GET as GET_CESTINO, POST as RIPRISTINA } from '@/app/api/primaria/allegati/cestino/route'
import { POST as SOSTITUISCI } from '@/app/api/primaria/allegati/sostituisci/route'
import { BUCKET_ALLEGATI_REGISTRO } from '@/lib/primaria/allegati-registro'

const URL_BASE = 'http://localhost/api/primaria/allegati'
const conUtente = (utente: string) => ({ 'x-user-id': utente })

const reqDelete = (id: string, utente = DOCENTE) =>
  new NextRequest(`${URL_BASE}?id=${id}`, { method: 'DELETE', headers: conUtente(utente) })
const reqPatch = (corpo: unknown, utente = DOCENTE) =>
  new NextRequest(URL_BASE, {
    method: 'PATCH',
    headers: { ...conUtente(utente), 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })
const reqGet = (registroId: string, utente = DOCENTE) =>
  new NextRequest(`${URL_BASE}?registroId=${registroId}`, { headers: conUtente(utente) })
const reqCestino = (sectionId: string, utente = DOCENTE) =>
  new NextRequest(`${URL_BASE}/cestino?sectionId=${sectionId}`, { headers: conUtente(utente) })
const reqRipristina = (id: string, utente = DOCENTE) =>
  new NextRequest(`${URL_BASE}/cestino`, {
    method: 'POST',
    headers: { ...conUtente(utente), 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
function reqMultipart(url: string, campi: Record<string, string | File>, utente = DOCENTE) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(campi)) fd.append(k, v)
  return new NextRequest(url, { method: 'POST', headers: conUtente(utente), body: fd })
}
const pdf = (nome = 'scheda-nuova.pdf', byte = 1024) =>
  new File([new Uint8Array(byte)], nome, { type: 'application/pdf' })

const comeDocente = (id = DOCENTE) =>
  h.requireDocente.mockResolvedValue({ user: { id, role: 'educator', scuola_id: SEDE_A }, response: null })
const comeSegreteria = () =>
  h.requireDocente.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A }, response: null })

const righe = (t: string) => h.db[t] as Riga[]
const riga = (t: string, id: string) => righe(t).find((r) => r.id === id) as Riga | undefined
const scritte = (t: string, op?: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === t && (!op || s.operazione === op))

function lezione(id: string, data: string, extra: Riga = {}): Riga {
  return { id, scuola_id: SEDE_A, section_id: SEZ, classe_sezione: '1A', data, ora_lezione: 2, ...extra }
}

function allegato(id: string, extra: Riga): Riga {
  return {
    id, registro_id: LEZ, ambito: 'compiti', tipo: 'pdf', file_url: `registro/${LEZ}/${id}.pdf`,
    file_name: `${id.slice(-1)}.pdf`, dimensione_byte: 10, caricato_da: DOCENTE, creato_il: fa(1),
    eliminato_il: null, eliminato_da: null, slot_section_id: SEZ, slot_data: OGGI, slot_ora_lezione: 2,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle.length = 0
  h.scritture.length = 0
  h.storage.length = 0
  h.uploadFallisce = false
  h.errori = {}
  h.logScrittura.mockResolvedValue(undefined)
  h.notificaTitolari.mockResolvedValue(undefined)
  comeDocente()
  h.db = {
    sections: [
      { id: SEZ, name: '1A', scuola_id: SEDE_A, school_type: 'primaria' },
      { id: SEZ_ALTRA_SEDE, name: '3C', scuola_id: SEDE_B, school_type: 'primaria' },
    ],
    utenti_sezioni: [
      { utente_id: DOCENTE, section_id: SEZ },
      { utente_id: COLLEGA, section_id: SEZ },
    ],
    utenti_scuole: [],
    admin_settings: [{ scuola_id: SEDE_A, funzioni_matrice: { primaria: { registro: true } } }],
    registro_orario: [
      lezione(LEZ, OGGI),
      lezione(LEZ_VECCHIA, LONTANA, { ora_lezione: 3 }),
      lezione(LEZ_SEDE_B, OGGI, { scuola_id: SEDE_B, section_id: SEZ_ALTRA_SEDE, classe_sezione: '3C' }),
    ],
    allegati_registro: [
      allegato(ALL_MIO, {}),
      allegato(ALL_COLLEGA, { caricato_da: COLLEGA }),
      allegato(ALL_VECCHIO, { registro_id: LEZ_VECCHIA, slot_data: LONTANA, slot_ora_lezione: 3 }),
      allegato(ALL_SEDE_B, { registro_id: LEZ_SEDE_B, slot_section_id: SEZ_ALTRA_SEDE }),
      // Nel cestino da due giorni e mezzo, con la sua lezione ancora viva.
      allegato(ALL_NEL_CESTINO, { eliminato_il: fa(2.5), eliminato_da: DOCENTE }),
      // Di un collega, nel cestino da un giorno e mezzo: la lezione (ora 4 di oggi) è stata ELIMINATA.
      allegato(ALL_ORFANO, { registro_id: null, caricato_da: COLLEGA, eliminato_il: fa(1.5), eliminato_da: SEGRETERIA, slot_ora_lezione: 4 }),
      // Come sopra, ora 5: nessuno la rifirma.
      allegato(ALL_ORFANO_SENZA, { registro_id: null, caricato_da: COLLEGA, eliminato_il: fa(1), eliminato_da: SEGRETERIA, slot_ora_lezione: 5 }),
      // Oltre la custodia. Com'è nella realtà: la lezione è di molto prima (un allegato
      // scaduto ha sempre una lezione oltre il termine di 2 giorni), e non c'è sblocco.
      allegato(ALL_SCADUTO, {
        registro_id: LEZ_VECCHIA, slot_data: LONTANA, slot_ora_lezione: 3,
        eliminato_il: fa(GIORNI_CESTINO_REGISTRO + 1), eliminato_da: DOCENTE,
      }),
      // Dell'autore, su una lezione OLTRE il termine, nel cestino da 3 giorni, senza
      // sblocchi: il ripristino lo decide la custodia, non il termine sulla lezione.
      allegato(ALL_VECCHIO_CESTINO, {
        registro_id: LEZ_VECCHIA, slot_data: LONTANA, slot_ora_lezione: 3,
        eliminato_il: fa(3), eliminato_da: DOCENTE,
      }),
    ],
    sblocchi_audit: [],
  } as Record<string, Riga[]>
})

// ─── DELETE: nel cestino ─────────────────────────────────────────────────────

describe('DELETE /api/primaria/allegati — nel cestino, il file resta', () => {
  it('l’autore mette il SUO allegato nel cestino: eliminato_il/da e slot dalla lezione, nessun file tolto', async () => {
    const res = await DELETE(reqDelete(ALL_MIO))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(ALL_MIO)
    expect(Date.parse(body.data.ripristinabileFinoAl) - Date.parse(body.data.eliminatoIl)).toBe(
      GIORNI_CESTINO_REGISTRO * GIORNO_MS,
    )

    const r = riga('allegati_registro', ALL_MIO)!
    expect(r.eliminato_il).toBe(body.data.eliminatoIl)
    expect(r.eliminato_da).toBe(DOCENTE)
    expect(r).toMatchObject({ registro_id: LEZ, slot_section_id: SEZ, slot_data: OGGI, slot_ora_lezione: 2 })
    // La riga c'è ancora (nessun DELETE) e lo Storage non è stato toccato.
    expect(scritte('allegati_registro', 'delete')).toHaveLength(0)
    expect(h.storage.filter((s) => s.op === 'remove')).toHaveLength(0)
    // Solo QUELLA riga è stata colpita.
    expect(scritte('allegati_registro', 'update').flatMap((s) => s.colpite.map((c) => c.id))).toEqual([ALL_MIO])

    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'allegato', entitaId: ALL_MIO, azione: 'delete', sectionId: SEZ, scuolaId: SEDE_A }),
    )
  })

  it('un docente NON autore riceve 403 VOCE_NON_AUTORE e l’allegato resta vivo', async () => {
    const res = await DELETE(reqDelete(ALL_COLLEGA))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VOCE_NON_AUTORE')
    expect(riga('allegati_registro', ALL_COLLEGA)!.eliminato_il).toBeNull()
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  it('la Segreteria elimina l’allegato di un docente', async () => {
    comeSegreteria()
    const res = await DELETE(reqDelete(ALL_COLLEGA, SEGRETERIA))
    expect(res.status).toBe(200)
    expect(riga('allegati_registro', ALL_COLLEGA)!.eliminato_da).toBe(SEGRETERIA)
  })

  it('oltre il termine sulla data della LEZIONE: 423; con lo sblocco per voce della Direzione passa', async () => {
    let res = await DELETE(reqDelete(ALL_VECCHIO))
    expect(res.status).toBe(423)
    expect((await res.json()).codice).toBe('VOCE_BLOCCATA')
    expect(riga('allegati_registro', ALL_VECCHIO)!.eliminato_il).toBeNull()

    righe('sblocchi_audit').push({ id: 's1', entita_tipo: 'allegato', entita_id: ALL_VECCHIO })
    res = await DELETE(reqDelete(ALL_VECCHIO))
    expect(res.status).toBe(200)
    expect(riga('allegati_registro', ALL_VECCHIO)!.eliminato_il).not.toBeNull()
  })

  it('anche la Segreteria è fermata dal termine (vale per tutti)', async () => {
    comeSegreteria()
    const res = await DELETE(reqDelete(ALL_VECCHIO, SEGRETERIA))
    expect(res.status).toBe(423)
  })

  it('un allegato già nel cestino non si elimina di nuovo: 404', async () => {
    const res = await DELETE(reqDelete(ALL_NEL_CESTINO))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_NON_TROVATO')
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  it('una classe di un’ALTRA sede: 403 e niente scritto', async () => {
    const res = await DELETE(reqDelete(ALL_SEDE_B))
    expect(res.status).toBe(403)
    expect(riga('allegati_registro', ALL_SEDE_B)!.eliminato_il).toBeNull()
  })

  it('DB non migrato (colonna del cestino assente): 503 dichiarato, niente cancellato', async () => {
    h.errori = { 'allegati_registro:select': { code: '42703' } }
    const res = await DELETE(reqDelete(ALL_MIO))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_CESTINO_NON_DISPONIBILE')
    expect(scritte('allegati_registro')).toHaveLength(0)
  })
})

// ─── PATCH: rinomina ─────────────────────────────────────────────────────────

describe('PATCH /api/primaria/allegati — rinomina', () => {
  it('l’autore cambia il nome MOSTRATO; il file e il resto della riga non cambiano', async () => {
    const prima = { ...riga('allegati_registro', ALL_MIO)! }
    const res = await PATCH(reqPatch({ id: ALL_MIO, nome: '  Scheda delle frazioni  ' }))
    expect(res.status).toBe(200)
    const dopo = riga('allegati_registro', ALL_MIO)!
    expect(dopo.file_name).toBe('Scheda delle frazioni')
    expect(dopo.file_url).toBe(prima.file_url)
    expect(dopo.eliminato_il).toBeNull()
    expect(scritte('allegati_registro', 'update')[0].valori).toEqual([{ file_name: 'Scheda delle frazioni' }])
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entitaTipo: 'allegato', entitaId: ALL_MIO, azione: 'update',
        valorePrima: { id: ALL_MIO, file_name: prima.file_name },
        valoreDopo: { id: ALL_MIO, file_name: 'Scheda delle frazioni' },
      }),
    )
  })

  it('nome vuoto: 400 e niente scritto', async () => {
    const res = await PATCH(reqPatch({ id: ALL_MIO, nome: '   ' }))
    expect(res.status).toBe(400)
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  it('un allegato nel cestino non si rinomina (404), quello di un collega nemmeno (403)', async () => {
    expect((await PATCH(reqPatch({ id: ALL_NEL_CESTINO, nome: 'x' }))).status).toBe(404)
    expect((await PATCH(reqPatch({ id: ALL_COLLEGA, nome: 'x' }))).status).toBe(403)
    expect(scritte('allegati_registro')).toHaveLength(0)
  })
})

// ─── GET della lezione: solo i vivi ─────────────────────────────────────────

describe('GET /api/primaria/allegati — gli allegati VIVI della lezione, coi permessi', () => {
  it('esclude il cestino e dice per ciascuno se chi guarda può modificarlo', async () => {
    const res = await GET(reqGet(LEZ))
    expect(res.status).toBe(200)
    const dati = (await res.json()).data as Array<{ id: string; modificabile: boolean; file_url: string | null }>
    expect(dati.map((a) => a.id).sort()).toEqual([ALL_MIO, ALL_COLLEGA].sort())
    expect(dati.find((a) => a.id === ALL_MIO)!.modificabile).toBe(true)
    expect(dati.find((a) => a.id === ALL_COLLEGA)!.modificabile).toBe(false)
    // Nessun link firmato per un allegato nel cestino.
    const firmati = h.storage.filter((s) => s.op.startsWith('firma')).flatMap((s) => s.percorsi)
    expect(firmati.some((p) => p.includes(ALL_NEL_CESTINO) || p.includes(ALL_SCADUTO))).toBe(false)
  })
})

// ─── POST: caricamento ───────────────────────────────────────────────────────

describe('POST /api/primaria/allegati — il caricamento lascia la traccia', () => {
  it('inserisce la riga col PERCORSO e scrive l’audit dell’insert', async () => {
    const res = await POST(reqMultipart(URL_BASE, { file: pdf('verifica.pdf'), registroId: LEZ }))
    expect(res.status).toBe(201)
    const nuovo = (await res.json()).data
    expect(nuovo).toMatchObject({ registro_id: LEZ, tipo: 'pdf', file_name: 'verifica.pdf', caricato_da: DOCENTE })
    expect(nuovo.file_url).toMatch(new RegExp(`^registro/${LEZ}/.+\\.pdf$`))
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'allegato', entitaId: nuovo.id, azione: 'insert' }),
    )
  })

  it('formato non ammesso: 400 col codice, e niente tocca lo Storage', async () => {
    const res = await POST(
      reqMultipart(URL_BASE, { file: new File(['x'], 'a.exe', { type: 'application/x-msdownload' }), registroId: LEZ }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_FORMATO_NON_AMMESSO')
    expect(h.storage).toHaveLength(0)
  })
})

// ─── Sostituzione ────────────────────────────────────────────────────────────

describe('POST /api/primaria/allegati/sostituisci — riga nuova, la vecchia nel cestino', () => {
  const URL_SOST = `${URL_BASE}/sostituisci`

  it('il file nuovo nasce in una RIGA NUOVA sulla stessa lezione; la vecchia va nel cestino col suo file', async () => {
    const vecchioFile = riga('allegati_registro', ALL_MIO)!.file_url
    const res = await SOSTITUISCI(reqMultipart(URL_SOST, { id: ALL_MIO, file: pdf('corretta.pdf') }))
    expect(res.status).toBe(201)
    const body = await res.json()
    const nuovoId = body.data.id as string
    expect(nuovoId).not.toBe(ALL_MIO)

    const nuovo = riga('allegati_registro', nuovoId)!
    expect(nuovo).toMatchObject({ registro_id: LEZ, ambito: 'compiti', file_name: 'corretta.pdf', caricato_da: DOCENTE })
    // Nata viva: il finto database non mette i predefiniti, e la route non scrive il cestino.
    expect(nuovo.eliminato_il ?? null).toBeNull()
    expect(nuovo.file_url).not.toBe(vecchioFile)

    const vecchio = riga('allegati_registro', ALL_MIO)!
    expect(vecchio.eliminato_il).toBe(body.sostituito.eliminatoIl)
    expect(vecchio.eliminato_da).toBe(DOCENTE)
    expect(vecchio.file_url).toBe(vecchioFile)

    // Caricato un percorso NUOVO, nessun file tolto: il vecchio lo custodisce il cestino.
    expect(h.storage.filter((s) => s.op === 'upload').flatMap((s) => s.percorsi)).toEqual([nuovo.file_url])
    expect(h.storage.filter((s) => s.op === 'remove')).toHaveLength(0)
    const azioni = h.logScrittura.mock.calls.map((c) => [(c[1] as Riga).azione, (c[1] as Riga).entitaId])
    expect(azioni).toEqual([['insert', nuovoId], ['delete', ALL_MIO]])
  })

  it('se la riga nuova non si scrive, la vecchia TORNA viva e il file nuovo esce dal bucket', async () => {
    h.errori = { 'allegati_registro:insert': { code: '23514' } }
    const res = await SOSTITUISCI(reqMultipart(URL_SOST, { id: ALL_MIO, file: pdf() }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_SCRITTURA_FALLITA')
    expect(riga('allegati_registro', ALL_MIO)!.eliminato_il).toBeNull()
    const caricato = h.storage.find((s) => s.op === 'upload')!.percorsi
    expect(h.storage.filter((s) => s.op === 'remove').flatMap((s) => s.percorsi)).toEqual(caricato)
  })

  it('un docente non autore: 403 PRIMA di caricare qualunque file', async () => {
    const res = await SOSTITUISCI(reqMultipart(URL_SOST, { id: ALL_COLLEGA, file: pdf() }))
    expect(res.status).toBe(403)
    expect(h.storage).toHaveLength(0)
    expect(riga('allegati_registro', ALL_COLLEGA)!.eliminato_il).toBeNull()
  })

  it('caricamento e sostituzione chiedono allo Storage lo STESSO bucket, quello della costante', async () => {
    expect(BUCKET_ALLEGATI_REGISTRO).toBe('registro-allegati')

    expect((await POST(reqMultipart(URL_BASE, { file: pdf('a.pdf'), registroId: LEZ }))).status).toBe(201)
    expect((await SOSTITUISCI(reqMultipart(URL_SOST, { id: ALL_MIO, file: pdf('b.pdf') }))).status).toBe(201)

    const caricamenti = h.storage.filter((s) => s.op === 'upload')
    expect(caricamenti).toHaveLength(2)
    expect(caricamenti.map((s) => s.bucket)).toEqual([BUCKET_ALLEGATI_REGISTRO, BUCKET_ALLEGATI_REGISTRO])
  })
})

// ─── Il cestino della classe ─────────────────────────────────────────────────

describe('GET /api/primaria/allegati/cestino — il cestino della CLASSE, coi giorni residui', () => {
  beforeEach(() => {
    // La lezione dell'ora 4 è stata rifirmata: l'orfano dell'ora 4 può tornare.
    righe('registro_orario').push(lezione(LEZ_RIFIRMATA, OGGI, { ora_lezione: 4 }))
  })

  it('la Segreteria vede tutti gli allegati ripristinabili della classe, e nient’altro', async () => {
    comeSegreteria()
    const res = await GET_CESTINO(reqCestino(SEZ, SEGRETERIA))
    expect(res.status).toBe(200)
    const voci = (await res.json()).data as Array<Record<string, unknown>>
    // Né i vivi, né lo scaduto, né l'altra sede.
    expect(voci.map((v) => v.id).sort()).toEqual(
      [ALL_NEL_CESTINO, ALL_ORFANO, ALL_ORFANO_SENZA, ALL_VECCHIO_CESTINO].sort(),
    )

    const di = (id: string) => voci.find((v) => v.id === id)!
    // Giorni INTERI per difetto: 7 − 2,5 = 4,5 → 4; 7 − 1,5 = 5,5 → 5.
    expect(di(ALL_NEL_CESTINO).giorniResidui).toBe(GIORNI_CESTINO_REGISTRO - 3)
    expect(di(ALL_ORFANO).giorniResidui).toBe(GIORNI_CESTINO_REGISTRO - 2)
    expect(di(ALL_NEL_CESTINO).lezioneDaRifirmare).toBe(false)
    expect(di(ALL_ORFANO).lezioneDaRifirmare).toBe(false)
    expect(di(ALL_ORFANO_SENZA).lezioneDaRifirmare).toBe(true)
    expect(di(ALL_ORFANO_SENZA).ripristinabile).toBe(false)
    expect(di(ALL_ORFANO).ripristinabile).toBe(true)
  })

  it('una lezione OLTRE il termine non blocca il ripristino: ripristinabile, e nessun «Sblocca»', async () => {
    const res = await GET_CESTINO(reqCestino(SEZ))
    expect(res.status).toBe(200)
    const voci = (await res.json()).data as Array<Record<string, unknown>>
    const vecchio = voci.find((v) => v.id === ALL_VECCHIO_CESTINO)!
    expect(vecchio).toMatchObject({ ripristinabile: true, lezioneDaRifirmare: false, slot_data: LONTANA })
    // Il termine non vale per il ripristino: la UI non deve offrire uno sblocco che
    // `primaria/sblocca` (solo allegati vivi) rifiuterebbe sempre.
    expect(voci.every((v) => !v.bloccata)).toBe(true)
    expect(righe('sblocchi_audit')).toHaveLength(0)
  })

  it('un docente vede nel cestino i SOLI allegati che ha caricato lui', async () => {
    righe('allegati_registro').push(allegato('66666666-0000-4000-8000-000000000009', { caricato_da: COLLEGA, eliminato_il: fa(1) }))
    const res = await GET_CESTINO(reqCestino(SEZ))
    const voci = (await res.json()).data as Array<{ id: string; caricato_da: string }>
    expect(voci.length).toBeGreaterThan(0)
    expect(voci.every((v) => v.caricato_da === DOCENTE)).toBe(true)
  })

  it('una classe di un’altra sede: 403', async () => {
    const res = await GET_CESTINO(reqCestino(SEZ_ALTRA_SEDE))
    expect(res.status).toBe(403)
  })
})

// ─── Il ripristino ───────────────────────────────────────────────────────────

describe('POST /api/primaria/allegati/cestino — il ripristino', () => {
  it('un allegato con la sua lezione viva torna vivo, sulla stessa lezione', async () => {
    const res = await RIPRISTINA(reqRipristina(ALL_NEL_CESTINO))
    expect(res.status).toBe(200)
    expect((await res.json()).riagganciato).toBe(false)
    expect(riga('allegati_registro', ALL_NEL_CESTINO)).toMatchObject({ eliminato_il: null, eliminato_da: null, registro_id: LEZ })
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'allegato', entitaId: ALL_NEL_CESTINO, azione: 'update' }),
    )
  })

  it('lezione ELIMINATA e poi RIFIRMATA nello stesso slot: si riaggancia alla lezione nuova', async () => {
    comeSegreteria()
    righe('registro_orario').push(lezione(LEZ_RIFIRMATA, OGGI, { ora_lezione: 4 }))
    const res = await RIPRISTINA(reqRipristina(ALL_ORFANO, SEGRETERIA))
    expect(res.status).toBe(200)
    expect((await res.json()).riagganciato).toBe(true)
    expect(riga('allegati_registro', ALL_ORFANO)).toMatchObject({ eliminato_il: null, registro_id: LEZ_RIFIRMATA })
    // Nello STESSO update: mai un allegato vivo senza lezione.
    expect(scritte('allegati_registro', 'update')[0].valori[0]).toMatchObject({ eliminato_il: null, registro_id: LEZ_RIFIRMATA })
  })

  it('lezione eliminata e NON rifirmata: 409 LEZIONE_DA_RIFIRMARE, niente cambia', async () => {
    comeSegreteria()
    const res = await RIPRISTINA(reqRipristina(ALL_ORFANO_SENZA, SEGRETERIA))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('LEZIONE_DA_RIFIRMARE')
    expect(riga('allegati_registro', ALL_ORFANO_SENZA)!.eliminato_il).not.toBeNull()
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  it('una lezione in un ALTRO slot (altra ora) non basta', async () => {
    comeSegreteria()
    righe('registro_orario').push(lezione(LEZ_RIFIRMATA, OGGI, { ora_lezione: 6 }))
    const res = await RIPRISTINA(reqRipristina(ALL_ORFANO_SENZA, SEGRETERIA))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('LEZIONE_DA_RIFIRMARE')
  })

  it('oltre i giorni di custodia (lezione lontana, nessuno sblocco): 409 SCADUTO, non 423', async () => {
    const res = await RIPRISTINA(reqRipristina(ALL_SCADUTO))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_CESTINO_SCADUTO')
    expect(riga('allegati_registro', ALL_SCADUTO)!.eliminato_il).not.toBeNull()
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  it('l’autore ripristina il suo allegato di una lezione OLTRE il termine, senza sblocco: torna vivo', async () => {
    const res = await RIPRISTINA(reqRipristina(ALL_VECCHIO_CESTINO))
    expect(res.status).toBe(200)
    expect((await res.json()).riagganciato).toBe(false)
    expect(riga('allegati_registro', ALL_VECCHIO_CESTINO)).toMatchObject({
      eliminato_il: null, eliminato_da: null, registro_id: LEZ_VECCHIA,
    })
    expect(scritte('allegati_registro', 'update').flatMap((s) => s.colpite.map((c) => c.id))).toEqual([ALL_VECCHIO_CESTINO])
    expect(righe('sblocchi_audit')).toHaveLength(0)
  })

  it('un collega non ripristina l’allegato scaduto di un altro, ma sente SCADUTO (409), non un 403', async () => {
    comeDocente(COLLEGA)
    const res = await RIPRISTINA(reqRipristina(ALL_SCADUTO, COLLEGA))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_CESTINO_SCADUTO')
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  it('un collega non autore su una voce viva nel cestino: 403 VOCE_NON_AUTORE, niente cambia', async () => {
    comeDocente(COLLEGA)
    const res = await RIPRISTINA(reqRipristina(ALL_VECCHIO_CESTINO, COLLEGA))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VOCE_NON_AUTORE')
    expect(riga('allegati_registro', ALL_VECCHIO_CESTINO)!.eliminato_il).not.toBeNull()
    expect(scritte('allegati_registro')).toHaveLength(0)
  })

  // Lo scope della classe sulla strada PROPRIA del ripristino: la sezione viene dalla
  // lezione o, per un orfano, da `slot_section_id`. L'autore è DOCENTE apposta, così il
  // CHI passa e l'unica barriera rimasta è `assertSezioneInScope`.
  it('altra sede, con la lezione viva: 403, niente torna vivo, niente scritto', async () => {
    righe('allegati_registro').push(allegato(ALL_CESTINO_SEDE_B, {
      registro_id: LEZ_SEDE_B, slot_section_id: SEZ_ALTRA_SEDE, caricato_da: DOCENTE,
      eliminato_il: fa(1), eliminato_da: DOCENTE,
    }))
    const res = await RIPRISTINA(reqRipristina(ALL_CESTINO_SEDE_B))
    expect(res.status).toBe(403)
    expect(riga('allegati_registro', ALL_CESTINO_SEDE_B)!.eliminato_il).not.toBeNull()
    expect(riga('allegati_registro', ALL_CESTINO_SEDE_B)!.registro_id).toBe(LEZ_SEDE_B)
    expect(scritte('allegati_registro')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('la classe viene dalla LEZIONE, non dalla foto dello slot: slot in scope ma lezione di un’altra sede → 403', async () => {
    righe('allegati_registro').push(allegato(ALL_CESTINO_SEDE_B, {
      registro_id: LEZ_SEDE_B, slot_section_id: SEZ, caricato_da: DOCENTE,
      eliminato_il: fa(1), eliminato_da: DOCENTE,
    }))
    const res = await RIPRISTINA(reqRipristina(ALL_CESTINO_SEDE_B))
    expect(res.status).toBe(403)
    expect(riga('allegati_registro', ALL_CESTINO_SEDE_B)!.eliminato_il).not.toBeNull()
    expect(scritte('allegati_registro')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('altra sede, ORFANO con una lezione rifirmata nel suo slot: 403, nessun riaggancio', async () => {
    righe('registro_orario').push(lezione(LEZ_RIFIRMATA_SEDE_B, OGGI, {
      scuola_id: SEDE_B, section_id: SEZ_ALTRA_SEDE, classe_sezione: '3C', ora_lezione: 4,
    }))
    righe('allegati_registro').push(allegato(ALL_ORFANO_SEDE_B, {
      registro_id: null, slot_section_id: SEZ_ALTRA_SEDE, slot_data: OGGI, slot_ora_lezione: 4,
      caricato_da: DOCENTE, eliminato_il: fa(1), eliminato_da: DOCENTE,
    }))
    const res = await RIPRISTINA(reqRipristina(ALL_ORFANO_SEDE_B))
    expect(res.status).toBe(403)
    expect(riga('allegati_registro', ALL_ORFANO_SEDE_B)).toMatchObject({ registro_id: null })
    expect(riga('allegati_registro', ALL_ORFANO_SEDE_B)!.eliminato_il).not.toBeNull()
    expect(scritte('allegati_registro')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('un allegato VIVO non è nel cestino: 409', async () => {
    const res = await RIPRISTINA(reqRipristina(ALL_MIO))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALLEGATO_REGISTRO_NON_NEL_CESTINO')
  })

  it('un docente non ripristina l’allegato di un altro (403), nemmeno se la lezione c’è', async () => {
    righe('registro_orario').push(lezione(LEZ_RIFIRMATA, OGGI, { ora_lezione: 4 }))
    const res = await RIPRISTINA(reqRipristina(ALL_ORFANO))
    expect(res.status).toBe(403)
    expect(riga('allegati_registro', ALL_ORFANO)!.eliminato_il).not.toBeNull()
  })

  it('eliminare e poi ripristinare riporta l’allegato dov’era (giro completo)', async () => {
    expect((await DELETE(reqDelete(ALL_MIO))).status).toBe(200)
    expect((await GET(reqGet(LEZ))).status).toBe(200)
    const assente = ((await (await GET(reqGet(LEZ))).json()).data as Array<{ id: string }>).map((a) => a.id)
    expect(assente).not.toContain(ALL_MIO)
    expect((await RIPRISTINA(reqRipristina(ALL_MIO))).status).toBe(200)
    const presente = ((await (await GET(reqGet(LEZ))).json()).data as Array<{ id: string }>).map((a) => a.id)
    expect(presente).toContain(ALL_MIO)
  })
})
