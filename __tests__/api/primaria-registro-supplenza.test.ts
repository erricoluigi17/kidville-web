import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// L4-a/e — LA SUPPLENZA NEL PROPRIO PLESSO, e i due confini che NON cadono.
//
// Decisione del titolare (2026-09-09): un docente può firmare il registro in
// QUALUNQUE sezione `school_type = 'primaria'` della PROPRIA sede, anche in una
// che non gli è assegnata. Prima rispondeva 403 «Sezione non assegnata al
// docente»: misurato sul database di produzione lo stesso giorno, 37 delle 75
// combinazioni docente×classe-di-primaria nella stessa sede erano chiuse, e 13
// educator su 15 ne guadagnano almeno una.
//
// Il permesso si allarga con un gate NUOVO (`assertSezionePrimariaFirmabile`) e
// non toccando `assertSezioneInScope`, che lo condividono valutazioni, note,
// pagelle e fascicolo — l'anagrafica e i dati sanitari di 133 bambini.
//
// QUI IL MODULO DI SCOPE È QUELLO VERO, non un `vi.mock`: un test che sostituisce
// il gate che sta verificando prova solo che la route chiama qualcosa. Il finto
// Supabase i filtri li applica davvero.
// =============================================================================

const SEZ_MIA = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_NON_MIA = '11111111-2222-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRA_SEDE = '11111111-3333-4111-8111-bbbbbbbbbbbb'
const SEZ_INFANZIA = '11111111-4444-4111-8111-aaaaaaaaaaaa'
const DOCENTE = '99999999-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  logScrittura: vi.fn(),
  enqueue: vi.fn(),
  notificaTitolari: vi.fn(),
  isOltreScadenza: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as never })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/primaria/timelock', () => ({ isOltreScadenza: h.isOltreScadenza }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: h.enqueue,
  notificaTitolariScrittura: h.notificaTitolari,
}))

import { POST } from '@/app/api/primaria/registro/route'

const req = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/primaria/registro?userId=' + DOCENTE, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-user-id': DOCENTE },
  })

/** Un corpo che supera il controllo «firma vuota»: c'è un argomento di classe. */
const corpo = (sectionId: string, extra: Record<string, unknown> = {}) => ({
  sectionId,
  data: '2026-09-09',
  oraLezione: 2,
  argomento: 'Le frazioni',
  compiti: '',
  dataConsegnaCompiti: null,
  tipoCompresenza: 'principale',
  argomentoProprio: '',
  compitiPropri: '',
  destinatariIds: [],
  ...extra,
})

/** Le righe di `registro_orario` scritte dal finto database. */
const righeScritte = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'registro_orario')

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle.length = 0
  h.scritture.length = 0
  h.logScrittura.mockResolvedValue(undefined)
  h.enqueue.mockResolvedValue(undefined)
  h.notificaTitolari.mockResolvedValue(undefined)
  h.isOltreScadenza.mockResolvedValue({ locked: false, giorniLimite: 2 })
  h.requireDocente.mockResolvedValue({
    user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A }, response: null,
  })
  h.db = {
    sections: [
      { id: SEZ_MIA, name: '1A', scuola_id: SEDE_A, school_type: 'primaria' },
      { id: SEZ_NON_MIA, name: '2B', scuola_id: SEDE_A, school_type: 'primaria' },
      { id: SEZ_ALTRA_SEDE, name: '3C', scuola_id: SEDE_B, school_type: 'primaria' },
      { id: SEZ_INFANZIA, name: 'Girasoli', scuola_id: SEDE_A, school_type: 'infanzia' },
    ],
    // Il docente è assegnato SOLO a `SEZ_MIA`.
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: SEZ_MIA }],
    utenti: [{ id: DOCENTE, gradi: ['primaria'], scuola_id: SEDE_A, ruolo: 'educator', nome: 'D', cognome: 'D' }],
    admin_settings: [{ scuola_id: SEDE_A, funzioni_matrice: { primaria: { registro: true } } }],
    registro_orario: [],
    firme_docenti: [],
    registro_destinatari: [],
    sblocchi_audit: [],
    alunni: [],
  } as Record<string, Riga[]>
})

describe('POST /api/primaria/registro — supplenza (L4-a) e grado (L4-e)', () => {
  // ── IL CONTROLLO NEGATIVO, ed è il motivo per cui il gate è nuovo ──────────
  it('IL CONFINE DI SEDE REGGE: una sezione di un ALTRO plesso resta 403 e non scrive niente', async () => {
    const res = await POST(req(corpo(SEZ_ALTRA_SEDE)))
    expect(res.status).toBe(403)
    // Il diniego passa da `rifiutoSede`: porta il CODICE, che il client traduce.
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(righeScritte()).toEqual([])
  })

  it('supplenza: sezione di primaria della PROPRIA sede ma NON assegnata → 200', async () => {
    const res = await POST(req(corpo(SEZ_NON_MIA)))
    expect(res.status).toBe(200)
    expect((await res.json()).supplenza).toBe(true)
    expect(righeScritte().length).toBe(1)
  })

  /**
   * (a) E (c) NON ERANO MAI STATE PROVATE INSIEME, e si ostacolavano.
   *
   * Questo è il corpo LETTERALE che `page.tsx` produce in supplenza senza scrivere
   * niente — il caso NORMALE, perché dell'ora altrui il supplente non sa nulla e
   * l'argomento lo scriverà la titolare. Il client cabla `materiaId: null`
   * (`altraClasse ? null : …`) e NASCONDE la tendina della materia
   * (`{!altraClasse && …}`); i condivisi vuoti li OMETTE (`condiviso()`); i propri
   * non li manda affatto (`proprio()`), e i destinatari sono `[]` perché gli alunni
   * dell'altra classe non sono caricati.
   *
   * Con la guardia della «firma vuota» calcolata sul payload, questa richiesta
   * riceveva 400 «indica almeno la materia, l'argomento o i compiti» — e la materia
   * è uno dei tre rimedi che a schermo, in supplenza, non esiste. Era la funzione
   * nuova del lotto che inciampava nella guardia nuova del lotto.
   */
  const corpoSupplenzaSenzaTesto = {
    sectionId: SEZ_NON_MIA, data: '2026-09-09', oraLezione: 2,
    materiaId: null, tipoCompresenza: 'principale', destinatariIds: [],
  }

  it('supplenza SENZA testo (il corpo vero della modale) → 200: firmare È il contenuto', async () => {
    const res = await POST(req(corpoSupplenzaSenzaTesto))
    expect(res.status).toBe(200)
    expect((await res.json()).supplenza).toBe(true)
    expect((h.scritture as Scrittura[]).filter((s) => s.tabella === 'firme_docenti').length).toBe(1)
  })

  it('CONTRO-PROVA: nella PROPRIA classe la stessa firma vuota resta 400 (la guardia non è spenta)', async () => {
    const res = await POST(req({ ...corpoSupplenzaSenzaTesto, sectionId: SEZ_MIA }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Firma vuota')
    expect(righeScritte()).toEqual([])
  })

  it("la supplenza finisce nell'AUDIT: `supplenza: true` in valoreDopo", async () => {
    await POST(req(corpo(SEZ_NON_MIA)))
    const input = h.logScrittura.mock.calls[0][1] as { valoreDopo: { supplenza: boolean } }
    expect(input.valoreDopo.supplenza).toBe(true)
  })

  it("la firma nella PROPRIA classe non è una supplenza: `supplenza: false`, e il campo c'è comunque", async () => {
    const res = await POST(req(corpo(SEZ_MIA)))
    expect(res.status).toBe(200)
    const input = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(input.valoreDopo.supplenza).toBe(false)
    expect('supplenza' in input.valoreDopo).toBe(true)
  })

  it('una sezione della propria sede che NON è di primaria resta 403 (questa è la porta della primaria)', async () => {
    const res = await POST(req(corpo(SEZ_INFANZIA)))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('primaria')
    expect(righeScritte()).toEqual([])
  })

  // ── L4-e: si firma la primaria solo se si insegna alla primaria ────────────
  it('educator senza il grado «primaria» → 403 anche nella classe ASSEGNATA, e non scrive', async () => {
    h.db.utenti = [{ id: DOCENTE, gradi: ['infanzia'], scuola_id: SEDE_A, ruolo: 'educator', nome: 'D', cognome: 'D' }]
    const res = await POST(req(corpo(SEZ_MIA)))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Docente non abilitato alla primaria')
    expect(righeScritte()).toEqual([])
  })

  /**
   * ⚠️ IL CASO CHE MANCAVA, ed è quello che disfa il lotto da dentro.
   *
   * (a) allarga il permesso — un educator firma in QUALUNQUE sezione di primaria
   * della sua sede — e (e) è l'UNICO contrappeso: chi la primaria non la insegna
   * resta fuori. Ma `assertGradoDocente` chiedeva `user.role !== 'educator'`, cioè
   * la VESTE scelta col cookie `kv-active-role`, non i ruoli REALI. Stessa persona,
   * stessa classe, `gradi: ['infanzia']`: in veste da maestra 403, in veste di
   * genitore 200 — e la firma finiva a database.
   *
   * MISURATO in produzione il 2026-09-09 (sole SELECT): 67 educator, 9 col ponte
   * `parents` (quindi due ruoli reali, quindi `conRuoloAttivo` si applica), 8 dei 9
   * SENZA 'primaria' in `gradi`, e 5 di quegli 8 in una sede che ha classi di
   * primaria. Non è teorico: sono cinque persone.
   *
   * La regola del repo è scritta in `predicati-ruolo.ts:43-46` — AUTORIZZAZIONE =
   * `haRuolo`, PRESENTAZIONE = `user.role` — e la route sorella
   * `primaria/classe/[sectionId]:GET` era già stata corretta così, con un avviso
   * (righe 56-63) che NOMINA questa riga.
   */
  it('VESTE ≠ RUOLO: educator+genitore senza il grado, in veste di GENITORE → 403 come in veste da maestra', async () => {
    h.db.utenti = [{ id: DOCENTE, gradi: ['infanzia'], scuola_id: SEDE_A, ruolo: 'educator', nome: 'D', cognome: 'D' }]
    h.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: 'genitore', ruoli: ['educator', 'genitore'], scuola_id: SEDE_A },
      response: null,
    })
    const res = await POST(req(corpo(SEZ_MIA)))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Docente non abilitato alla primaria')
    // L'asserzione che distingue: col gate spento la firma si SCRIVE, e un 403
    // senza questa riga resterebbe verde anche se la scrittura fosse partita.
    expect(righeScritte()).toEqual([])
    expect((h.scritture as Scrittura[]).filter((s) => s.tabella === 'firme_docenti')).toEqual([])
  })

  it('VESTE ≠ RUOLO, contro-prova: educator+genitore CON il grado, in veste di genitore → 200', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: 'genitore', ruoli: ['educator', 'genitore'], scuola_id: SEDE_A },
      response: null,
    })
    const res = await POST(req(corpo(SEZ_MIA)))
    expect(res.status).toBe(200)
    expect(righeScritte().length).toBe(1)
  })

  it('la segreteria non passa dal gate del grado (agisce su tutta la scuola)', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: 'segreteria', scuola_id: SEDE_A }, response: null,
    })
    h.db.utenti = [{ id: DOCENTE, gradi: [], scuola_id: SEDE_A, ruolo: 'segreteria', nome: 'S', cognome: 'S' }]
    // La firma resta del DOCENTE titolare (vincolo FEA): senza `docenteId` è 422,
    // non 403 — cioè il gate del grado non l'ha fermata.
    const res = await POST(req(corpo(SEZ_MIA)))
    expect(res.status).toBe(422)
  })
})
