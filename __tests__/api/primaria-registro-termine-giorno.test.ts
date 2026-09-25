import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// LO SBLOCCO DEL GIORNO ARRIVA FINO ALLA FIRMA, E LA GET DICHIARA IL TERMINE.
//
// Due difetti dello stesso lavoro (compito R3, giro 2), provati sullo stesso
// database finto su cui girano ENTRAMBE le route — chi scrive lo sblocco
// (`primaria/sblocca:POST`) e chi lo legge (`primaria/registro:POST`/`GET`):
//
//  1. «Sblocca tutto il registro di questa classe per questa data» scrive
//     `entita_tipo = 'giorno'`. Modifiche ed eliminazioni lo leggevano
//     (`permesso-voce`), la FIRMA no: la pagina diceva «giornata sbloccata» e la
//     maestra che firmava l'ora mancante prendeva ancora 423.
//  2. La GET non diceva quali ore erano bloccate: il blocco si scopriva solo con
//     un gesto finito in 423, e restava nel browser di chi l'aveva fatto. La
//     Direzione che apriva la pagina non vedeva nessun «Sblocca».
//
// Il termine resta REALE (`calcolaScadenza`, `statoVoci`): si sostituisce solo
// `isOltreScadenza`, cioè il verdetto sulla DATA della giornata, per poter
// provare anche il giorno entro il termine senza dipendere dall'orologio.
// =============================================================================

const SEZ = 'aaaa1111-0000-4000-8000-0000000000b1'
const MATERIA = '22222222-1111-4111-8111-bbbbbbbbbbbb'
const MAESTRA = 'd0ce0001-0000-4000-8000-000000000012'
const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000011'
const RIGA = 'e9157200-0000-4000-8000-000000000011'
const FIRMA = 'f1a00000-0000-4000-8000-000000000011'
/** Una data fissa e passata: oltre il termine di 2 giorni per sempre. */
const LUNEDI = '2026-09-07'
const MARTEDI = '2026-09-08'
const ORA = 3

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  isOltreScadenza: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logScrittura: vi.fn(),
  enqueue: vi.fn(),
  notificaTitolari: vi.fn(),
  db: {} as Record<string, Riga[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, ErrorePostgrest>,
}))

vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (...a: unknown[]) => h.logEvento(...a),
    logErrore: (...a: unknown[]) => h.logErrore(...a),
  }
})
vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
  assertSezionePrimariaFirmabile: vi.fn().mockResolvedValue({ response: null, supplenza: false }),
}))
vi.mock('@/lib/auth/require-grado', () => ({ assertGradoDocente: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/audit/valutatore', () => ({
  risolviValutatore: vi.fn().mockImplementation(async () => ({ valutatoreId: MAESTRA, response: null })),
}))
// Solo il verdetto sulla data: `leggiTermini`/`calcolaScadenza` restano reali.
vi.mock('@/lib/primaria/timelock', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  isOltreScadenza: h.isOltreScadenza,
}))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: h.enqueue,
  notificaTitolariScrittura: h.notificaTitolari,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { GET as LEGGI, POST as FIRMA_POST } from '@/app/api/primaria/registro/route'
import { POST as SBLOCCA } from '@/app/api/primaria/sblocca/route'

const firma = (ora = ORA, data = LUNEDI) =>
  FIRMA_POST(
    new NextRequest('http://localhost/api/primaria/registro?userId=' + MAESTRA, {
      method: 'POST',
      body: JSON.stringify({
        sectionId: SEZ, data, oraLezione: ora, materiaId: MATERIA,
        argomento: 'Le frazioni', tipoCompresenza: 'principale', destinatariIds: [],
      }),
      headers: { 'content-type': 'application/json', 'x-user-id': MAESTRA },
    }),
  )

const sblocca = (corpo: Record<string, unknown>) =>
  SBLOCCA(
    new NextRequest('http://localhost/api/primaria/sblocca?userId=' + DIRIGENTE, {
      method: 'POST',
      body: JSON.stringify({ motivazione: 'Maestra assente: recupero autorizzato', ...corpo }),
      headers: { 'content-type': 'application/json', 'x-user-id': DIRIGENTE },
    }),
  )

const leggi = (data = LUNEDI) =>
  LEGGI(new NextRequest(`http://localhost/api/primaria/registro?sectionId=${SEZ}&data=${data}&userId=${DIRIGENTE}`))

/** La 3ª ora del lunedì, firmata dalla maestra (la 4ª resta MAI firmata). */
const rigaFirmata = (): Riga => ({
  id: RIGA,
  section_id: SEZ,
  classe_sezione: '1A',
  scuola_id: SEDE_A,
  data: LUNEDI,
  ora_lezione: ORA,
  materia_id: MATERIA,
  argomento: 'Le frazioni',
  firme_docenti: [{ id: FIRMA, maestra_id: MAESTRA, tipo_compresenza: 'principale' }],
  registro_destinatari: [],
  allegati_registro: [],
})

const esiti = () => h.logEvento.mock.calls.map((c) => (c[2] as { esito?: string } | undefined)?.esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.logScrittura.mockResolvedValue(undefined)
  h.enqueue.mockResolvedValue(undefined)
  h.notificaTitolari.mockResolvedValue(undefined)
  h.isOltreScadenza.mockResolvedValue({ locked: true, giorniLimite: 2, giorniTrascorsi: 9 })
  h.requireDocente.mockResolvedValue({
    user: { id: MAESTRA, role: 'educator', ruolo: 'educator', scuola_id: SEDE_A },
    response: null,
  })
  h.requireStaff.mockResolvedValue({
    user: { id: DIRIGENTE, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A },
    response: null,
  })
  h.db = {
    sections: [{ id: SEZ, name: '1A', scuola_id: SEDE_A, school_type: 'primaria' }],
    registro_orario: [],
    firme_docenti: [],
    registro_destinatari: [],
    sblocchi_audit: [],
    campanelle: [],
    orario_settimanale: [],
    utenti: [{ id: MAESTRA, nome: 'M', cognome: 'M' }],
    alunni: [],
    valutazioni: [],
    note_disciplinari: [],
  }
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — lo sblocco del GIORNO autorizza la firma tardiva', () => {
  it('senza sblocco: 423 con codice `VOCE_BLOCCATA` e `giorniLimite` (la pagina li mostra tradotti)', async () => {
    const res = await firma()
    expect(res.status).toBe(423)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VOCE_BLOCCATA')
    expect(corpo.giorniLimite).toBe(2)
    expect(corpo.locked).toBe(true)
    expect(esiti()).toContain('firma-bloccata-oltre-termine')
  })

  it('con lo sblocco del giorno scritto da `primaria/sblocca`: l’ora MAI firmata si firma (200)', async () => {
    const autorizzazione = await sblocca({ entitaTipo: 'giorno', sectionId: SEZ, data: LUNEDI })
    expect(autorizzazione.status).toBe(200)
    expect(h.db.sblocchi_audit).toHaveLength(1)
    expect(h.db.sblocchi_audit[0].entita_tipo).toBe('giorno')

    const res = await firma()
    expect(
      res.status,
      'La Direzione ha sbloccato la giornata e la pagina lo dice: la firma deve passare.',
    ).toBe(200)
    expect(esiti()).toContain('firma-tardiva-autorizzata-per-giorno')
    expect(h.db.registro_orario).toHaveLength(1)
  })

  it('…e anche la riga GIÀ scritta si corregge', async () => {
    h.db.registro_orario = [rigaFirmata()]
    await sblocca({ entitaTipo: 'giorno', sectionId: SEZ, data: LUNEDI })
    const res = await firma()
    expect(res.status).toBe(200)
  })

  it('lo sblocco di un ALTRO giorno non vale: 423', async () => {
    await sblocca({ entitaTipo: 'giorno', sectionId: SEZ, data: MARTEDI })
    const res = await firma()
    expect(res.status).toBe(423)
    expect(esiti()).not.toContain('firma-tardiva-autorizzata-per-giorno')
  })

  it('lo sblocco del giorno di un’ALTRA classe non vale: 423', async () => {
    h.db.sblocchi_audit = [{
      id: 'a0000000-0000-4000-8000-000000000001', entita_tipo: 'giorno', entita_id: null,
      section_id: 'aaaa1111-0000-4000-8000-0000000000ff', data: LUNEDI, ora_lezione: null,
    }]
    const res = await firma()
    expect(res.status).toBe(423)
  })

  it('DB E2E non migrato (`42703`): nessuna domanda sul giorno, resta 423 e non 500', async () => {
    h.errori = { 'sblocchi_audit:select': { code: '42703', message: 'column sblocchi_audit.section_id does not exist' } }
    const res = await firma()
    expect(res.status).toBe(423)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET — il termine della giornata si dichiara al caricamento', () => {
  it('oltre il termine e senza sblocchi: la riga e la firma sono `bloccata`, la data `oltreTermine`', async () => {
    h.db.registro_orario = [rigaFirmata()]
    const res = await leggi()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.termine).toEqual({
      letto: true, oltreTermine: true, giorniLimite: 2, giornoSbloccato: false, oreSbloccate: [],
    })
    expect(data.righe).toHaveLength(1)
    expect(data.righe[0].bloccata).toBe(true)
    expect(data.righe[0].firme_docenti[0].bloccata).toBe(true)
  })

  it('con lo sblocco del GIORNO: nulla è bloccato, e la data lo dice', async () => {
    h.db.registro_orario = [rigaFirmata()]
    await sblocca({ entitaTipo: 'giorno', sectionId: SEZ, data: LUNEDI })
    const { data } = await (await leggi()).json()
    expect(data.termine.oltreTermine).toBe(true)
    expect(data.termine.giornoSbloccato).toBe(true)
    expect(data.righe[0].bloccata).toBe(false)
    expect(data.righe[0].firme_docenti[0].bloccata).toBe(false)
  })

  it('con lo sblocco per SLOT della 4ª ora (mai firmata): la dichiara in `oreSbloccate`, la 3ª resta bloccata', async () => {
    h.db.registro_orario = [rigaFirmata()]
    await sblocca({ entitaTipo: 'registro', sectionId: SEZ, data: LUNEDI, oraLezione: 4 })
    const { data } = await (await leggi()).json()
    expect(data.termine.oreSbloccate).toEqual([4])
    expect(data.termine.giornoSbloccato).toBe(false)
    expect(data.righe[0].bloccata).toBe(true)
  })

  it('con lo sblocco della LEZIONE come voce: riga e firma non sono più bloccate', async () => {
    h.db.registro_orario = [rigaFirmata()]
    const aut = await sblocca({ entitaTipo: 'registro', entitaId: RIGA })
    expect(aut.status).toBe(200)
    const { data } = await (await leggi()).json()
    expect(data.righe[0].bloccata).toBe(false)
    // La voce `registro` porta con sé lo slot: copre anche la firma di quell'ora.
    expect(data.righe[0].firme_docenti[0].bloccata).toBe(false)
  })

  it('entro il termine: niente bloccato e nessuna lettura degli sblocchi', async () => {
    h.isOltreScadenza.mockResolvedValue({ locked: false, giorniLimite: 2, giorniTrascorsi: 1 })
    h.db.registro_orario = [rigaFirmata()]
    const { data } = await (await leggi()).json()
    expect(data.termine).toEqual({
      letto: true, oltreTermine: false, giorniLimite: 2, giornoSbloccato: false, oreSbloccate: [],
    })
    expect(data.righe[0].bloccata).toBe(false)
    expect(h.tabelle).not.toContain('sblocchi_audit')
  })

  it('un guasto nella lettura degli sblocchi NON toglie il registro: `letto: false`, nessun blocco inventato', async () => {
    h.db.registro_orario = [rigaFirmata()]
    h.errori = { 'sblocchi_audit:select': { code: '57014', message: 'statement timeout' } }
    const res = await leggi()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.righe).toHaveLength(1)
    expect(data.termine.letto).toBe(false)
    expect(data.righe[0].bloccata).toBe(false)
  })
})
