import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Riga, Scrittura, ErrorePostgrest } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { dataRomaDi } from '@/lib/primaria/timelock'

// =============================================================================
// R1 — DELETE /api/primaria/registro: la PROPRIA firma, o la lezione INTERA.
//
// Spec 2026-09-24 («2 Primaria» e «Decisioni aggiunte prima del lancio»):
//  · il docente elimina la propria firma coi suoi destinatari; se era l'unica
//    firma, sparisce la lezione;
//  · la lezione intera la eliminano solo Segreteria e Direzione;
//  · gli allegati della lezione eliminata vanno nel CESTINO (eliminato_il,
//    eliminato_da, slot d'origine) PRIMA del DELETE della lezione;
//  · la notifica «nuovi compiti» ancora in coda si ritira, quella partita resta;
//  · permessi e termine da `permesso-voce` (VERO, non mockato: è il gate sotto
//    test), sblocchi per voce, slot o giorno.
//
// Il database è il finto Supabase che APPLICA i filtri e le scritture: le
// asserzioni guardano che cosa resta nelle tabelle, non lo status soltanto.
// ⚠️ Il finto client non emula le cascate delle FK: che firme e destinatari se ne
// vadano con la lezione (e i destinatari con la firma) lo garantisce il database
// (`ON DELETE CASCADE`, già nella baseline), qui si prova QUALE riga colpisce il
// DELETE e che nessun'altra scrittura parta.
// =============================================================================

const SEZ = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRA_SEDE = '11111111-3333-4111-8111-bbbbbbbbbbbb'
const DOCENTE = '99999999-1111-4111-8111-aaaaaaaaaaaa'
const COLLEGA = '99999999-2222-4111-8111-aaaaaaaaaaaa'
const SEGRETERIA = '99999999-3333-4111-8111-aaaaaaaaaaaa'
const LEZ = '22222222-0000-4000-8000-000000000001'
const LEZ_ALTRA = '22222222-0000-4000-8000-000000000002'
const LEZ_SEDE_B = '22222222-0000-4000-8000-000000000003'
const FIRMA_MIA = '33333333-0000-4000-8000-000000000001'
const FIRMA_COLLEGA = '33333333-0000-4000-8000-000000000002'
const ALUNNO_1 = '44444444-0000-4000-8000-000000000001'
const GENITORE_1 = '55555555-0000-4000-8000-000000000001'
const GENITORE_2 = '55555555-0000-4000-8000-000000000002'
const ALL_ATTIVO = '66666666-0000-4000-8000-000000000001'
const ALL_CESTINO = '66666666-0000-4000-8000-000000000002'
const ALL_ALTRA = '66666666-0000-4000-8000-000000000003'

const OGGI = dataRomaDi(new Date().toISOString())
/** Una data ben oltre il termine di 2 giorni. */
const LONTANA = '2026-01-12'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, unknown>,
  logScrittura: vi.fn(),
  notificaTitolari: vi.fn(),
  genitori: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as never, errori: h.errori as never })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: vi.fn(),
  notificaTitolariScrittura: h.notificaTitolari,
}))
vi.mock('@/lib/anagrafiche/legami', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  getGenitoriDiAlunni: h.genitori,
}))

import { DELETE } from '@/app/api/primaria/registro/route'

const req = (query: string, utente = DOCENTE) =>
  new NextRequest(`http://localhost/api/primaria/registro?userId=${utente}&${query}`, {
    method: 'DELETE',
    headers: { 'x-user-id': utente },
  })

const comeDocente = (id = DOCENTE) =>
  h.requireDocente.mockResolvedValue({ user: { id, role: 'educator', scuola_id: SEDE_A }, response: null })
const comeSegreteria = () =>
  h.requireDocente.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A }, response: null })

const righe = (t: string) => h.db[t] as Riga[]
const scritte = (t: string, op?: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === t && (!op || s.operazione === op))

function lezione(id: string, data: string, extra: Riga = {}): Riga {
  return {
    id, scuola_id: SEDE_A, section_id: SEZ, classe_sezione: '1A', data, ora_lezione: 2,
    materia_id: null, argomento: 'Le frazioni', compiti: 'Pag. 12', data_consegna_compiti: null,
    ...extra,
  }
}

function notifica(id: string, extra: Riga): Riga {
  return {
    id, tipo: 'compiti', titolo: 'Nuovi compiti assegnati', entita_tipo: 'registro',
    push_inviata_il: null, corpo: 'Pag. 12', ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle.length = 0
  h.scritture.length = 0
  h.errori = {}
  h.logScrittura.mockResolvedValue(undefined)
  h.notificaTitolari.mockResolvedValue(undefined)
  h.genitori.mockImplementation(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, id === ALUNNO_1 ? [GENITORE_1] : [GENITORE_2])
    return m
  })
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
    utenti: [
      { id: DOCENTE, gradi: ['primaria'], scuola_id: SEDE_A, ruolo: 'educator', nome: 'D', cognome: 'D' },
      { id: COLLEGA, gradi: ['primaria'], scuola_id: SEDE_A, ruolo: 'educator', nome: 'C', cognome: 'C' },
    ],
    admin_settings: [{ scuola_id: SEDE_A, funzioni_matrice: { primaria: { registro: true } } }],
    registro_orario: [
      lezione(LEZ, OGGI),
      lezione(LEZ_ALTRA, OGGI, { ora_lezione: 3 }),
      lezione(LEZ_SEDE_B, OGGI, { scuola_id: SEDE_B, section_id: SEZ_ALTRA_SEDE, classe_sezione: '3C' }),
    ],
    firme_docenti: [
      {
        id: FIRMA_MIA, registro_id: LEZ, maestra_id: DOCENTE, tipo_compresenza: 'sostegno',
        argomento_proprio: 'Ripasso', compiti_propri: 'Scheda 3',
      },
      {
        id: FIRMA_COLLEGA, registro_id: LEZ, maestra_id: COLLEGA, tipo_compresenza: 'principale',
        argomento_proprio: null, compiti_propri: null,
      },
    ],
    registro_destinatari: [
      { id: 'd1', registro_id: LEZ, firma_id: FIRMA_MIA, alunno_id: ALUNNO_1 },
    ],
    allegati_registro: [
      { id: ALL_ATTIVO, registro_id: LEZ, eliminato_il: null, eliminato_da: null, slot_section_id: null, slot_data: null, slot_ora_lezione: null },
      {
        id: ALL_CESTINO, registro_id: LEZ, eliminato_il: '2026-09-20T08:00:00.000Z', eliminato_da: COLLEGA,
        slot_section_id: SEZ, slot_data: OGGI, slot_ora_lezione: 2,
      },
      { id: ALL_ALTRA, registro_id: LEZ_ALTRA, eliminato_il: null, eliminato_da: null, slot_section_id: null, slot_data: null, slot_ora_lezione: null },
    ],
    notifiche: [
      // In coda, testo proprio della mia firma, al genitore del mio destinatario.
      notifica('n-propria', { utente_id: GENITORE_1, entita_id: LEZ, corpo: 'Scheda 3' }),
      // In coda, compiti di classe della stessa lezione, a un altro genitore.
      notifica('n-classe', { utente_id: GENITORE_2, entita_id: LEZ }),
      // GIÀ PARTITA: resta sempre.
      notifica('n-partita', { utente_id: GENITORE_1, entita_id: LEZ, corpo: 'Scheda 3', push_inviata_il: '2026-09-25T07:00:00.000Z' }),
      // In coda, ma di un'ALTRA lezione.
      notifica('n-altra', { utente_id: GENITORE_2, entita_id: LEZ_ALTRA }),
    ],
    sblocchi_audit: [],
    utenti_scuole: [],
  } as Record<string, Riga[]>
})

const idsDi = (t: string) => righe(t).map((r) => r.id)

describe('DELETE /api/primaria/registro — la propria firma', () => {
  it('elimina SOLO la mia firma e i miei destinatari; la lezione con un\'altra firma resta', async () => {
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ eliminata: 'firma', firmaId: FIRMA_MIA, registroId: LEZ, allegatiNelCestino: 0 })

    expect(idsDi('firme_docenti')).toEqual([FIRMA_COLLEGA])
    // Il DELETE ha colpito SOLO la mia firma. I miei destinatari se ne vanno con
    // lei per la FK della baseline (`registro_destinatari_firma_id_fkey`, ON DELETE
    // CASCADE), che il finto client non emula: la route non li cancella a mano.
    const delFirme = scritte('firme_docenti', 'delete')
    expect(delFirme).toHaveLength(1)
    expect(delFirme[0].colpite.map((r) => r.id)).toEqual([FIRMA_MIA])
    expect(scritte('registro_destinatari')).toEqual([])
    // La lezione resta, e nessuna scrittura la sfiora.
    expect(idsDi('registro_orario')).toContain(LEZ)
    expect(scritte('registro_orario')).toEqual([])
    // Nessun allegato toccato: la lezione è viva.
    expect(scritte('allegati_registro')).toEqual([])
    expect(righe('allegati_registro').find((a) => a.id === ALL_ATTIVO)?.eliminato_il).toBeNull()
  })

  it('ritira dalla coda SOLO la notifica col testo proprio ai genitori dei miei destinatari', async () => {
    // Stesso testo, stessa lezione, ma a un genitore che NON è dei miei
    // destinatari (i compiti di classe possono coincidere col testo proprio).
    h.db.notifiche.push(notifica('n-stesso-testo', { utente_id: GENITORE_2, entita_id: LEZ, corpo: 'Scheda 3' }))
    // Lo STESSO genitore del mio destinatario ha un altro figlio nel resto della
    // classe: in coda ha anche i compiti di classe della stessa lezione, con un
    // testo diverso. Quella notifica non è mia e deve restare.
    h.db.notifiche.push(notifica('n-classe-stesso-genitore', { utente_id: GENITORE_1, entita_id: LEZ, corpo: 'Pag. 12' }))
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(200)
    expect((await res.json()).data.notificheRitirate).toBe(1)
    expect(idsDi('notifiche').sort()).toEqual(['n-altra', 'n-classe', 'n-classe-stesso-genitore', 'n-partita', 'n-stesso-testo'])
    expect(h.genitori).toHaveBeenCalledWith(expect.anything(), [ALUNNO_1])
  })

  it('audit: logScrittura delete della firma, con prima e dopo', async () => {
    await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const input = h.logScrittura.mock.calls[0][1]
    expect(input).toMatchObject({
      entitaTipo: 'firma', entitaId: FIRMA_MIA, azione: 'delete', scuolaId: SEDE_A, sectionId: SEZ, valoreDopo: null,
    })
    expect(input.valorePrima).toMatchObject({ firma: { id: FIRMA_MIA }, destinatari: [ALUNNO_1], registro_id: LEZ })
  })

  it('la firma di un COLLEGA → 403 VOCE_NON_AUTORE, niente cancellato', async () => {
    const res = await DELETE(req(`firmaId=${FIRMA_COLLEGA}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VOCE_NON_AUTORE')
    expect(h.scritture).toEqual([])
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('firma inesistente → 404 FIRMA_NON_TROVATA', async () => {
    const res = await DELETE(req('firmaId=33333333-0000-4000-8000-0000000000ff'))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FIRMA_NON_TROVATA')
  })

  it('una lettura fallita non si traveste da 404: 500 LETTURA_FALLITA', async () => {
    h.errori = { 'firme_docenti:select': { code: 'XX000', message: 'guasto' } as ErrorePostgrest }
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.scritture).toEqual([])
  })
})

describe('DELETE /api/primaria/registro — l\'unica firma porta via la lezione', () => {
  beforeEach(() => {
    h.db.firme_docenti = h.db.firme_docenti.filter((f) => f.id === FIRMA_MIA)
  })

  it('lezione eliminata; allegati attivi nel CESTINO con chi, quando e lo slot; PRIMA del DELETE', async () => {
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ eliminata: 'lezione', firmaId: FIRMA_MIA, registroId: LEZ, allegatiNelCestino: 1 })

    expect(idsDi('registro_orario')).not.toContain(LEZ)
    expect(idsDi('registro_orario')).toContain(LEZ_ALTRA)

    const attivo = righe('allegati_registro').find((a) => a.id === ALL_ATTIVO)!
    expect(attivo.eliminato_il).toEqual(expect.any(String))
    expect(attivo.eliminato_da).toBe(DOCENTE)
    expect(attivo).toMatchObject({ slot_section_id: SEZ, slot_data: OGGI, slot_ora_lezione: 2 })
    // Quello già nel cestino conserva la sua data e il suo autore.
    const giaCestino = righe('allegati_registro').find((a) => a.id === ALL_CESTINO)!
    expect(giaCestino).toMatchObject({ eliminato_il: '2026-09-20T08:00:00.000Z', eliminato_da: COLLEGA })
    // L'allegato di un'altra lezione non si tocca.
    expect(righe('allegati_registro').find((a) => a.id === ALL_ALTRA)?.eliminato_il).toBeNull()

    // L'ordine: il cestino viene PRIMA del DELETE della lezione (il vincolo del DB lo esige).
    const ordine = (h.scritture as Scrittura[]).map((s) => `${s.tabella}:${s.operazione}`)
    expect(ordine.indexOf('allegati_registro:update')).toBeGreaterThanOrEqual(0)
    expect(ordine.indexOf('allegati_registro:update')).toBeLessThan(ordine.indexOf('registro_orario:delete'))
    // Il DELETE porta la sede della riga letta.
    expect(scritte('registro_orario', 'delete')[0].colpite.map((r) => r.id)).toEqual([LEZ])
  })

  it('ritira TUTTE le «compiti» in coda della lezione; restano la partita e quella di un\'altra lezione', async () => {
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect((await res.json()).data.notificheRitirate).toBe(2)
    expect(idsDi('notifiche').sort()).toEqual(['n-altra', 'n-partita'])
  })

  it('audit: logScrittura delete della lezione con il motivo «ultima-firma»', async () => {
    await DELETE(req(`firmaId=${FIRMA_MIA}`))
    const input = h.logScrittura.mock.calls[0][1]
    expect(input).toMatchObject({ entitaTipo: 'registro', entitaId: LEZ, azione: 'delete', valoreDopo: null })
    expect(input.valorePrima).toMatchObject({
      registro: { id: LEZ }, firma_eliminata: FIRMA_MIA, allegati_nel_cestino: [ALL_ATTIVO], motivo: 'ultima-firma',
    })
  })

  it('se il DELETE della lezione fallisce, il cestino si ANNULLA e nessuna notifica si ritira', async () => {
    h.errori = { 'registro_orario:delete': { code: '23514', message: 'check' } as ErrorePostgrest }
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('REGISTRO_NON_ELIMINATO')
    const attivo = righe('allegati_registro').find((a) => a.id === ALL_ATTIVO)!
    expect(attivo.eliminato_il).toBeNull()
    expect(attivo.eliminato_da).toBeNull()
    expect(idsDi('notifiche')).toHaveLength(4)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/primaria/registro — la lezione intera', () => {
  it('un docente → 403 LEZIONE_ELIMINA_SOLO_STAFF, senza leggere né scrivere', async () => {
    const res = await DELETE(req(`registroId=${LEZ}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('LEZIONE_ELIMINA_SOLO_STAFF')
    expect(h.tabelle).toEqual([])
    expect(h.scritture).toEqual([])
  })

  it('la Segreteria elimina la lezione con più firme; allegati nel cestino a suo nome', async () => {
    comeSegreteria()
    const res = await DELETE(req(`registroId=${LEZ}`, SEGRETERIA))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ eliminata: 'lezione', firmaId: null, registroId: LEZ, allegatiNelCestino: 1 })
    expect(idsDi('registro_orario')).not.toContain(LEZ)
    expect(righe('allegati_registro').find((a) => a.id === ALL_ATTIVO)?.eliminato_da).toBe(SEGRETERIA)
    const input = h.logScrittura.mock.calls[0][1]
    expect(input.valorePrima).toMatchObject({ motivo: 'lezione-intera' })
    expect(input.valorePrima.firme.map((f: Riga) => f.id).sort()).toEqual([FIRMA_MIA, FIRMA_COLLEGA].sort())
  })

  it('la Segreteria di un\'ALTRA sede → 403 di sede, niente cancellato', async () => {
    comeSegreteria()
    const res = await DELETE(req(`registroId=${LEZ_SEDE_B}`, SEGRETERIA))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('una lezione di INFANZIA della stessa sede → 403 CLASSE_NON_DI_PRIMARIA, niente cancellato né cestinato', async () => {
    // `registro_orario` è condiviso col registro 0-6: da questa porta la
    // Segreteria non deve poter cancellare una lezione di nido o infanzia.
    const SEZ_INFANZIA = '11111111-4444-4111-8111-cccccccccccc'
    const LEZ_INFANZIA = '22222222-0000-4000-8000-000000000004'
    const ALL_INFANZIA = '66666666-0000-4000-8000-000000000004'
    h.db.sections.push({ id: SEZ_INFANZIA, name: 'Girasoli', scuola_id: SEDE_A, school_type: 'infanzia' })
    h.db.registro_orario.push(lezione(LEZ_INFANZIA, OGGI, { section_id: SEZ_INFANZIA, classe_sezione: 'Girasoli' }))
    h.db.allegati_registro.push({
      id: ALL_INFANZIA, registro_id: LEZ_INFANZIA, eliminato_il: null, eliminato_da: null,
      slot_section_id: null, slot_data: null, slot_ora_lezione: null,
    })
    comeSegreteria()
    const res = await DELETE(req(`registroId=${LEZ_INFANZIA}`, SEGRETERIA))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CLASSE_NON_DI_PRIMARIA')
    expect(idsDi('registro_orario')).toContain(LEZ_INFANZIA)
    expect(h.scritture).toEqual([])
    expect(righe('allegati_registro').find((a) => a.id === ALL_INFANZIA)?.eliminato_il).toBeNull()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('DB non migrato (niente colonne del cestino) CON allegati → 503, la lezione resta', async () => {
    comeSegreteria()
    h.errori = { 'allegati_registro:update': { code: 'PGRST204', message: 'colonna' } as ErrorePostgrest }
    const res = await DELETE(req(`registroId=${LEZ}`, SEGRETERIA))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('REGISTRO_CESTINO_NON_DISPONIBILE')
    expect(idsDi('registro_orario')).toContain(LEZ)
  })

  it('DB non migrato SENZA allegati → si elimina', async () => {
    comeSegreteria()
    h.db.allegati_registro = h.db.allegati_registro.filter((a) => a.registro_id !== LEZ)
    h.errori = { 'allegati_registro:update': { code: 'PGRST204', message: 'colonna' } as ErrorePostgrest }
    const res = await DELETE(req(`registroId=${LEZ}`, SEGRETERIA))
    expect(res.status).toBe(200)
    expect(idsDi('registro_orario')).not.toContain(LEZ)
  })

  it('firmaId e registroId insieme → 400, nessuna lettura', async () => {
    comeSegreteria()
    const res = await DELETE(req(`registroId=${LEZ}&firmaId=${FIRMA_MIA}`, SEGRETERIA))
    expect(res.status).toBe(400)
    expect(h.tabelle).toEqual([])
  })
})

describe('DELETE /api/primaria/registro — il termine e gli sblocchi', () => {
  beforeEach(() => {
    h.db.registro_orario = h.db.registro_orario.map((r) => (r.id === LEZ ? { ...r, data: LONTANA } : r))
  })

  it('oltre il termine → 423 VOCE_BLOCCATA, anche per la Segreteria sulla lezione intera', async () => {
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(423)
    expect((await res.json()).codice).toBe('VOCE_BLOCCATA')

    comeSegreteria()
    const res2 = await DELETE(req(`registroId=${LEZ}`, SEGRETERIA))
    expect(res2.status).toBe(423)
    expect(h.scritture).toEqual([])
  })

  it('con lo sblocco del GIORNO della classe → passa', async () => {
    h.db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ, data: LONTANA, ora_lezione: null }]
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(200)
    expect(idsDi('firme_docenti')).toEqual([FIRMA_COLLEGA])
  })

  it('con lo sblocco della VOCE (la firma) → passa', async () => {
    h.db.sblocchi_audit = [{ id: 's2', entita_tipo: 'firma', entita_id: FIRMA_MIA, section_id: null, data: null, ora_lezione: null }]
    const res = await DELETE(req(`firmaId=${FIRMA_MIA}`))
    expect(res.status).toBe(200)
  })

  it('con lo sblocco dello SLOT (registro, sezione+data+ora) → passa la lezione intera', async () => {
    comeSegreteria()
    h.db.sblocchi_audit = [{ id: 's3', entita_tipo: 'registro', entita_id: null, section_id: SEZ, data: LONTANA, ora_lezione: 2 }]
    const res = await DELETE(req(`registroId=${LEZ}`, SEGRETERIA))
    expect(res.status).toBe(200)
    expect(idsDi('registro_orario')).not.toContain(LEZ)
  })
})
