import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// NOTE DELLA PRIMARIA — modifica ed eliminazione (compito NO1, spec 2026-09-24).
//
// Il database è `creaFintoSupabase`, che FILTRA e SCRIVE davvero: le asserzioni
// guardano che cosa è rimasto nelle tabelle, non lo status. Girano i moduli
// reali di scope, permesso-voce (termine + sblocchi), audit e legami; l'unico
// finto è l'identità della richiesta (`requireDocente`).
//
// Ogni blocco nomina il difetto che lo farebbe diventare rosso.
// =============================================================================

const MAESTRA = 'd0ce0001-0000-4000-8000-000000000001'
const ALTRA_MAESTRA = 'd0ce0001-0000-4000-8000-000000000002'
const SEGRETERIA = '5e9e0001-0000-4000-8000-000000000003'
const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000004'

const SEZ = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_ALTRA_SEDE = 'bbbb2222-0000-4000-8000-0000000000b2'

const ALUNNO_1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const ALUNNO_2 = 'a1a1a1a1-0000-4000-8000-000000000002'
const ALUNNO_3 = 'a1a1a1a1-0000-4000-8000-000000000003'
const ALUNNO_4 = 'a1a1a1a1-0000-4000-8000-000000000004'

const GENITORE_1 = '9e9e0001-0000-4000-8000-000000000001'
const GENITORE_2 = '9e9e0001-0000-4000-8000-000000000002'
/** Genitore di DUE alunni dello stesso gruppo (fratelli). */
const GENITORE_FRATELLI = '9e9e0001-0000-4000-8000-000000000003'

const GRUPPO = '96096000-0000-4000-8000-000000000001'
const ALTRO_GRUPPO = '96096000-0000-4000-8000-000000000002'

const NOTA_1 = 'e0e00000-0000-4000-8000-000000000001' // gruppo, alunno 1, FIRMATA
const NOTA_2 = 'e0e00000-0000-4000-8000-000000000002' // gruppo, alunno 2
const NOTA_3 = 'e0e00000-0000-4000-8000-000000000003' // gruppo, alunno 3 (fratello del 4)
const NOTA_4 = 'e0e00000-0000-4000-8000-000000000004' // gruppo, alunno 4 (fratello del 3)
const NOTA_ALTRO_GRUPPO = 'e0e00000-0000-4000-8000-000000000005'
const NOTA_SOLA = 'e0e00000-0000-4000-8000-000000000006' // senza gruppo, dell'ALTRA maestra
const NOTA_VECCHIA = 'e0e00000-0000-4000-8000-000000000007' // oltre il termine, senza gruppo
const NOTA_ALTRA_SEDE = 'e0e00000-0000-4000-8000-000000000008'

/** 12:00 del 10/09/2026 a Roma. Termine delle note: 2 giorni. */
const ADESSO = new Date('2026-09-10T10:00:00Z')
const IERI = '2026-09-09T08:00:00Z'
const CINQUE_GIORNI_FA = '2026-09-05T08:00:00Z'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as Scrittura[],
  errori: undefined as Record<string, { code: string; message?: string }> | undefined,
}))

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, [], { scritture: h.scritture, errori: h.errori }),
  }
})

import { GET, POST, PATCH, DELETE } from '@/app/api/primaria/note/route'

const utenti = {
  maestra: { id: MAESTRA, role: 'educator', ruolo: 'educator', scuola_id: SEDE_A },
  altraMaestra: { id: ALTRA_MAESTRA, role: 'educator', ruolo: 'educator', scuola_id: SEDE_A },
  segreteria: { id: SEGRETERIA, role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE_A },
  segreteriaAltraSede: { id: SEGRETERIA, role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE_B },
  dirigente: { id: DIRIGENTE, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A },
}
function come(u: keyof typeof utenti) {
  h.requireDocente.mockResolvedValue({ user: utenti[u] })
}

function nota(id: string, extra: Riga = {}): Riga {
  return {
    id,
    alunno_id: ALUNNO_1,
    section_id: SEZ,
    maestra_id: MAESTRA,
    categoria: 'disciplinare',
    testo: 'Testo originale',
    richiede_firma: true,
    firmata_il: null,
    firmata_da: null,
    oscurata_ad_altri: true,
    nota_gruppo_id: GRUPPO,
    creato_il: IERI,
    ...extra,
  }
}

function notifica(id: string, utente: string, extra: Riga = {}): Riga {
  return {
    id,
    utente_id: utente,
    tipo: 'nota_firma',
    titolo: 'Nuova nota — richiesta firma',
    corpo: 'Testo originale',
    entita_tipo: 'nota',
    entita_id: GRUPPO,
    push_inviata_il: null,
    ...extra,
  }
}

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ, scuola_id: SEDE_A, name: '2A', school_type: 'primaria' },
    { id: SEZ_ALTRA_SEDE, scuola_id: SEDE_B, name: '2B', school_type: 'primaria' },
  ],
  utenti_scuole: [{ utente_id: DIRIGENTE, scuola_id: SEDE_A }],
  alunni: [ALUNNO_1, ALUNNO_2, ALUNNO_3, ALUNNO_4].map((id) => ({ id, section_id: SEZ, scuola_id: SEDE_A })),
  utenti_sezioni: [
    { utente_id: MAESTRA, section_id: SEZ },
    { utente_id: ALTRA_MAESTRA, section_id: SEZ },
  ],
  admin_settings: [
    { scuola_id: SEDE_A, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 },
    { scuola_id: SEDE_B, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 },
  ],
  note_disciplinari: [
    nota(NOTA_1, { alunno_id: ALUNNO_1, firmata_il: '2026-09-09T12:00:00Z', firmata_da: GENITORE_1 }),
    nota(NOTA_2, { alunno_id: ALUNNO_2 }),
    nota(NOTA_3, { alunno_id: ALUNNO_3 }),
    nota(NOTA_4, { alunno_id: ALUNNO_4 }),
    nota(NOTA_ALTRO_GRUPPO, { alunno_id: ALUNNO_1, nota_gruppo_id: ALTRO_GRUPPO, firmata_il: '2026-09-09T12:00:00Z', firmata_da: GENITORE_1 }),
    nota(NOTA_SOLA, { alunno_id: ALUNNO_2, maestra_id: ALTRA_MAESTRA, nota_gruppo_id: null }),
    nota(NOTA_VECCHIA, { alunno_id: ALUNNO_2, nota_gruppo_id: null, creato_il: CINQUE_GIORNI_FA }),
    nota(NOTA_ALTRA_SEDE, { section_id: SEZ_ALTRA_SEDE, nota_gruppo_id: null }),
  ],
  nota_ricezioni: [
    { id: 'f1f10000-0000-4000-8000-000000000001', nota_id: NOTA_1, alunno_id: ALUNNO_1, genitore_id: GENITORE_1 },
    { id: 'f1f10000-0000-4000-8000-000000000002', nota_id: NOTA_ALTRO_GRUPPO, alunno_id: ALUNNO_1, genitore_id: GENITORE_1 },
  ],
  legame_genitori_alunni: [
    { alunno_id: ALUNNO_1, genitore_id: GENITORE_1 },
    { alunno_id: ALUNNO_2, genitore_id: GENITORE_2 },
    { alunno_id: ALUNNO_3, genitore_id: GENITORE_FRATELLI },
    { alunno_id: ALUNNO_4, genitore_id: GENITORE_FRATELLI },
  ],
  student_parents: [],
  parents: [],
  notifiche: [
    notifica('c0c00000-0000-4000-8000-000000000001', GENITORE_1),
    notifica('c0c00000-0000-4000-8000-000000000002', GENITORE_2),
    notifica('c0c00000-0000-4000-8000-000000000003', GENITORE_FRATELLI),
    // già PARTITA: non si ritira (nessuna rettifica).
    notifica('c0c00000-0000-4000-8000-000000000004', GENITORE_1, { push_inviata_il: '2026-09-09T08:10:00Z' }),
    // di un ALTRO gruppo, stesso genitore: non si tocca.
    notifica('c0c00000-0000-4000-8000-000000000005', GENITORE_1, { entita_id: ALTRO_GRUPPO }),
    // stesso entita_id ma un altro tipo (non è l'avviso della nota): non si tocca.
    notifica('c0c00000-0000-4000-8000-000000000006', GENITORE_1, { tipo: 'firma_ricevuta' }),
  ],
  sblocchi_audit: [],
  audit_scritture_docente: [],
})

function richiesta(metodo: string, url: string, body?: unknown): NextRequest {
  return {
    url,
    method: metodo,
    nextUrl: new URL(url),
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest
}
const BASE = 'http://localhost/api/primaria/note'
const patch = (body: Record<string, unknown>) => PATCH(richiesta('PATCH', BASE, body))
const elimina = (id: string, ambito?: string) =>
  DELETE(richiesta('DELETE', `${BASE}?id=${id}${ambito ? `&ambito=${ambito}` : ''}`))

const note = () => h.db.note_disciplinari as Riga[]
const notaDb = (id: string) => note().find((n) => n.id === id)
const ricezioni = () => (h.db.nota_ricezioni as Riga[]).map((r) => r.nota_id)
const notificheIds = () => (h.db.notifiche as Riga[]).map((n) => String(n.id).slice(-1)).sort()
const audit = () => h.db.audit_scritture_docente as Riga[]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  h.db = dbBase()
  h.scritture = []
  h.errori = undefined
  come('maestra')
})
afterEach(() => {
  vi.useRealTimers()
})

describe('PATCH — firma azzerata e ambito', () => {
  it('«solo questo alunno» su una nota FIRMATA: cambia solo lei, e la firma si azzera', async () => {
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, modificate: 1, firme_azzerate: 1 })

    expect(notaDb(NOTA_1)).toMatchObject({ testo: 'Testo corretto', firmata_il: null, firmata_da: null })
    // Il resto del gruppo NON si tocca.
    expect(notaDb(NOTA_2)?.testo).toBe('Testo originale')
    // La presa visione della nota modificata sparisce; quella di un'altra nota resta.
    expect(ricezioni()).toEqual([NOTA_ALTRO_GRUPPO])
    // Nessun avviso nuovo al genitore.
    expect(h.db.notifiche).toHaveLength(6)

    const a = audit()
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ entita_tipo: 'nota', entita_id: NOTA_1, azione: 'update', section_id: SEZ, scuola_id: SEDE_A })
  })

  it('«tutti» modifica OGNI nota del gruppo e nessun\'altra', async () => {
    const res = await patch({ id: NOTA_2, categoria: 'didattica', richiedeFirma: false, ambito: 'gruppo' })
    expect(res.status).toBe(200)
    expect((await res.json()).modificate).toBe(4)

    for (const id of [NOTA_1, NOTA_2, NOTA_3, NOTA_4]) {
      expect(notaDb(id)).toMatchObject({ categoria: 'didattica', richiede_firma: false, firmata_il: null })
    }
    expect(notaDb(NOTA_ALTRO_GRUPPO)?.categoria).toBe('disciplinare')
    expect(notaDb(NOTA_ALTRO_GRUPPO)?.firmata_il).toBe('2026-09-09T12:00:00Z')
    expect(ricezioni()).toEqual([NOTA_ALTRO_GRUPPO])
    expect(audit()[0]).toMatchObject({ entita_id: GRUPPO, azione: 'update' })
  })

  it('una nota SENZA gruppo con «tutti» agisce solo su sé stessa', async () => {
    const res = await patch({ id: NOTA_VECCHIA, testo: 'x', ambito: 'gruppo' })
    // oltre il termine: prima serve lo sblocco
    expect(res.status).toBe(423)
    h.db.sblocchi_audit.push({ entita_tipo: 'nota', entita_id: NOTA_VECCHIA })
    const ok = await patch({ id: NOTA_VECCHIA, testo: 'x', ambito: 'gruppo' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).modificate).toBe(1)
    expect(notaDb(NOTA_VECCHIA)?.testo).toBe('x')
    expect(note().filter((n) => n.testo === 'x')).toHaveLength(1)
  })

  it('rimandare lo STESSO testo non cancella la firma del genitore', async () => {
    const res = await patch({ id: NOTA_1, testo: 'Testo originale', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect((await res.json()).modificate).toBe(0)
    expect(notaDb(NOTA_1)?.firmata_il).toBe('2026-09-09T12:00:00Z')
    expect(ricezioni()).toContain(NOTA_1)
    expect(audit()).toHaveLength(0)
  })

  it('senza ambito, o senza niente da cambiare: 400 e nessuna scrittura', async () => {
    expect((await patch({ id: NOTA_1, testo: 'y' })).status).toBe(400)
    expect((await patch({ id: NOTA_1, ambito: 'alunno' })).status).toBe(400)
    expect((await patch({ id: NOTA_1, testo: '  \n ', ambito: 'alunno' })).status).toBe(400)
    expect(h.scritture).toHaveLength(0)
  })

  it('una nota salvata con l\'a capo finale, risalvata senza toccarla: firma e presa visione restano', async () => {
    // Difetto: il confronto fra il testo rifilato e quello salvato NON rifilato
    // faceva risultare «cambiata» la nota e azzerava la firma.
    ;(notaDb(NOTA_1) as Riga).testo = 'Testo originale\n'
    const res = await patch({ id: NOTA_1, testo: 'Testo originale', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ modificate: 0, firme_azzerate: 0 })
    expect(notaDb(NOTA_1)).toMatchObject({ firmata_il: '2026-09-09T12:00:00Z', firmata_da: GENITORE_1 })
    expect(ricezioni()).toContain(NOTA_1)
    expect(audit()).toHaveLength(0)
  })
})

describe('PATCH — l\'avviso ancora in coda si allinea alla nota modificata', () => {
  const notificaDb = (suffisso: string) => (h.db.notifiche as Riga[]).find((n) => String(n.id).endsWith(suffisso))

  it('«solo questo alunno»: l\'avviso IN CODA del suo genitore porta il testo nuovo; gli altri no', async () => {
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(200)

    // Genitore dell'alunno modificato, avviso in coda: testo nuovo.
    expect(notificaDb('01')).toMatchObject({ corpo: 'Testo corretto', tipo: 'nota_firma' })
    // Già PARTITO: resta com'era.
    expect(notificaDb('04')?.corpo).toBe('Testo originale')
    // Genitore di un ALTRO alunno del gruppo (nota non modificata): resta com'era.
    expect(notificaDb('02')?.corpo).toBe('Testo originale')
    expect(notificaDb('03')?.corpo).toBe('Testo originale')
    // Altro gruppo, altro tipo: non si toccano.
    expect(notificaDb('05')?.corpo).toBe('Testo originale')
    expect(notificaDb('06')?.corpo).toBe('Testo originale')
    // Nessun avviso nuovo.
    expect(h.db.notifiche).toHaveLength(6)
  })

  it('«tutti» senza più firma: ogni avviso in coda del gruppo diventa «Nuova nota», testo e tipo compresi', async () => {
    const res = await patch({ id: NOTA_2, testo: 'Per tutti', richiedeFirma: false, ambito: 'gruppo' })
    expect(res.status).toBe(200)

    for (const s of ['01', '02', '03']) {
      expect(notificaDb(s)).toMatchObject({ corpo: 'Per tutti', tipo: 'nota', titolo: 'Nuova nota' })
    }
    expect(notificaDb('04')).toMatchObject({ corpo: 'Testo originale', tipo: 'nota_firma' })
    expect(notificaDb('05')).toMatchObject({ corpo: 'Testo originale', tipo: 'nota_firma' })
    expect(notificaDb('06')).toMatchObject({ tipo: 'firma_ricevuta' })
  })

  it('il testo lungo si tronca come in POST (140 caratteri)', async () => {
    const lungo = 'x'.repeat(300)
    await patch({ id: NOTA_2, testo: lungo, ambito: 'gruppo' })
    expect(notificaDb('02')?.corpo).toBe('x'.repeat(140))
  })

  it('un aggiornamento respinto dal DB non fa fallire la modifica della nota (va a log)', async () => {
    h.errori = { 'notifiche:update': { code: '57014', message: 'canceling statement' } }
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect(notaDb(NOTA_1)?.testo).toBe('Testo corretto')
    expect(notificaDb('01')?.corpo).toBe('Testo originale')
  })
})

describe('PATCH — ordine: prima le firme, poi la nota', () => {
  it('se la cancellazione delle prese visione fallisce: 500, e nota + firma restano intatte e coerenti', async () => {
    h.errori = { 'nota_ricezioni:delete': { code: '57014', message: 'canceling statement' } }
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('NOTA_OPERAZIONE_NON_RIUSCITA')
    expect(body).not.toHaveProperty('firme_azzerate')
    // Niente di mezzo: la firma è ancora sul testo che il genitore ha firmato.
    expect(notaDb(NOTA_1)).toMatchObject({ testo: 'Testo originale', firmata_il: '2026-09-09T12:00:00Z' })
    expect(ricezioni()).toContain(NOTA_1)
    expect(audit()).toHaveLength(0)

    // Il nuovo tentativo completa il lavoro.
    h.errori = undefined
    const ok = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ modificate: 1, firme_azzerate: 1 })
    expect(notaDb(NOTA_1)).toMatchObject({ testo: 'Testo corretto', firmata_il: null, firmata_da: null })
    expect(ricezioni()).not.toContain(NOTA_1)
  })

  it('se l\'update della nota fallisce dopo le firme: 500, e il nuovo tentativo la trova ancora «cambiata»', async () => {
    h.errori = { 'note_disciplinari:update': { code: '57014', message: 'canceling statement' } }
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(500)
    expect(notaDb(NOTA_1)?.testo).toBe('Testo originale')

    h.errori = undefined
    const ok = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect((await ok.json()).modificate).toBe(1)
    expect(notaDb(NOTA_1)).toMatchObject({ testo: 'Testo corretto', firmata_il: null })
    expect(ricezioni()).not.toContain(NOTA_1)
  })
})

describe('Permessi: autore, staff, sede, termine, sblocchi', () => {
  it('un\'altra maestra della classe NON modifica né elimina la nota altrui (403 VOCE_NON_AUTORE)', async () => {
    come('altraMaestra')
    const r1 = await patch({ id: NOTA_1, testo: 'no', ambito: 'alunno' })
    expect(r1.status).toBe(403)
    expect((await r1.json()).codice).toBe('VOCE_NON_AUTORE')
    const r2 = await elimina(NOTA_2, 'alunno')
    expect(r2.status).toBe(403)
    expect(note()).toHaveLength(8)
    expect(notaDb(NOTA_1)?.testo).toBe('Testo originale')
  })

  it('la Segreteria della sede modifica la nota di una maestra; quella di un\'altra sede no', async () => {
    come('segreteria')
    expect((await patch({ id: NOTA_SOLA, testo: 'da segreteria', ambito: 'alunno' })).status).toBe(200)
    expect(notaDb(NOTA_SOLA)?.testo).toBe('da segreteria')

    come('segreteriaAltraSede')
    const res = await patch({ id: NOTA_1, testo: 'fuori sede', ambito: 'alunno' })
    expect(res.status).toBe(403)
    expect(notaDb(NOTA_1)?.testo).toBe('Testo originale')
  })

  it('il termine vale anche per la Direzione: oltre 2 giorni 423 finché non c\'è lo sblocco del GIORNO', async () => {
    come('dirigente')
    const res = await elimina(NOTA_VECCHIA, 'alunno')
    expect(res.status).toBe(423)
    expect((await res.json()).codice).toBe('VOCE_BLOCCATA')
    expect(notaDb(NOTA_VECCHIA)).toBeDefined()

    h.db.sblocchi_audit.push({ entita_tipo: 'giorno', entita_id: null, section_id: SEZ, data: '2026-09-05', ora_lezione: null })
    expect((await elimina(NOTA_VECCHIA, 'alunno')).status).toBe(200)
    expect(notaDb(NOTA_VECCHIA)).toBeUndefined()
  })

  it('«tutti» esige il permesso su OGNI nota: uno sblocco per voce su una sola non basta per il gruppo', async () => {
    // Tutto il gruppo oltre il termine.
    for (const n of note()) if (n.nota_gruppo_id === GRUPPO) n.creato_il = CINQUE_GIORNI_FA
    h.db.sblocchi_audit.push({ entita_tipo: 'nota', entita_id: NOTA_2 })

    const gruppo = await patch({ id: NOTA_2, testo: 'tutti', ambito: 'gruppo' })
    expect(gruppo.status).toBe(423)
    expect(note().filter((n) => n.testo === 'tutti')).toHaveLength(0)

    const solo = await patch({ id: NOTA_2, testo: 'solo lei', ambito: 'alunno' })
    expect(solo.status).toBe(200)
    expect(notaDb(NOTA_2)?.testo).toBe('solo lei')
    expect(notaDb(NOTA_3)?.testo).toBe('Testo originale')
  })

  it('una nota DELLO STESSO gruppo con un autore diverso blocca il «tutti» (403) senza scrivere niente', async () => {
    const n4 = notaDb(NOTA_4) as Riga
    n4.maestra_id = ALTRA_MAESTRA
    const res = await elimina(NOTA_1, 'gruppo')
    expect(res.status).toBe(403)
    expect(note()).toHaveLength(8)
  })

  it('nota inesistente: 404 NOTA_NON_TROVATA', async () => {
    const res = await elimina('e0e00000-0000-4000-8000-0000000000ff', 'alunno')
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('NOTA_NON_TROVATA')
  })
})

describe('DELETE — eliminazione e ritiro degli avvisi in coda', () => {
  it('una nota FIRMATA si elimina; si ritira l\'avviso in coda del suo genitore, non quelli degli altri', async () => {
    const res = await elimina(NOTA_1, 'alunno')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, eliminate: 1, firme_rimosse: 1 })
    expect(notaDb(NOTA_1)).toBeUndefined()
    expect(notaDb(NOTA_2)).toBeDefined()

    // Ritirata la 1 (genitore 1, in coda). Restano: genitore 2 e fratelli (il
    // gruppo ha ancora le loro note), la 4 già partita, la 5 di un altro gruppo,
    // la 6 di un altro tipo.
    expect(notificheIds()).toEqual(['2', '3', '4', '5', '6'])
    expect(audit()[0]).toMatchObject({ entita_id: NOTA_1, azione: 'delete', scuola_id: SEDE_A, section_id: SEZ })
  })

  it('il genitore di due fratelli nel gruppo tiene l\'avviso finché resta la nota di uno dei due', async () => {
    await elimina(NOTA_3, 'alunno')
    expect(notificheIds()).toContain('3')
    await elimina(NOTA_4, 'alunno')
    expect(notificheIds()).not.toContain('3')
  })

  it('«tutti» elimina il gruppo intero e ritira ogni avviso ancora in coda di quel gruppo', async () => {
    const res = await elimina(NOTA_2, 'gruppo')
    expect(res.status).toBe(200)
    expect((await res.json()).eliminate).toBe(4)
    expect(note().map((n) => n.id).sort()).toEqual([NOTA_ALTRO_GRUPPO, NOTA_SOLA, NOTA_VECCHIA, NOTA_ALTRA_SEDE].sort())
    expect(notificheIds()).toEqual(['4', '5', '6'])
    expect(audit()[0]).toMatchObject({ entita_id: GRUPPO, azione: 'delete' })
  })

  it('una cancellazione respinta dal DB è 500 con codice, e nessun avviso ritirato', async () => {
    h.errori = { 'note_disciplinari:delete': { code: '57014', message: 'canceling statement' } }
    const res = await elimina(NOTA_1, 'alunno')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('NOTA_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(body)).not.toContain('canceling statement')
    expect(h.db.notifiche).toHaveLength(6)
  })
})

describe('GET — stato di ogni nota per la UI', () => {
  it('modificabile/bloccata per chi guarda, gruppo e numero di alunni', async () => {
    const res = await GET(richiesta('GET', `${BASE}?sectionId=${SEZ}`))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    const per = new Map((data as Riga[]).map((n) => [n.id, n]))
    expect(per.size).toBe(7) // la nota dell'altra sede non è di questa classe

    expect(per.get(NOTA_1)).toMatchObject({
      nota_gruppo_id: GRUPPO,
      n_alunni_gruppo: 4,
      modificabile: true,
      bloccata: false,
      gruppo_modificabile: true,
    })
    expect(per.get(NOTA_ALTRO_GRUPPO)).toMatchObject({ n_alunni_gruppo: 1 })
    // Altrui: non modificabile, ma nemmeno bloccata.
    expect(per.get(NOTA_SOLA)).toMatchObject({ modificabile: false, bloccata: false, n_alunni_gruppo: 1 })
    // Oltre il termine: bloccata (la Direzione vedrà «Sblocca»).
    expect(per.get(NOTA_VECCHIA)).toMatchObject({ modificabile: false, bloccata: true, giorni_limite: 2 })
  })

  it('basta una nota del gruppo non modificabile perché il gruppo non lo sia', async () => {
    ;(notaDb(NOTA_4) as Riga).creato_il = CINQUE_GIORNI_FA
    const { data } = await (await GET(richiesta('GET', `${BASE}?sectionId=${SEZ}`))).json()
    const n1 = (data as Riga[]).find((n) => n.id === NOTA_1)
    expect(n1).toMatchObject({ modificabile: true, gruppo_modificabile: false })
  })

  it('con i permessi leggibili dichiara statoVociDisponibile: true', async () => {
    const body = await (await GET(richiesta('GET', `${BASE}?sectionId=${SEZ}`))).json()
    expect(body.statoVociDisponibile).toBe(true)
  })

  // Difetto: un guasto nel calcolo dei SOLI bottoni rispondeva 500 e il docente
  // non vedeva più nessuna nota. L'elenco resta; i bottoni si spengono.
  it.each([
    ['termini (admin_settings)', 'admin_settings'],
    ['sblocchi (sblocchi_audit)', 'sblocchi_audit'],
    // La lettura della sede (`sections`) non si isola qui: la usa anche lo
    // scope, che col finto fallirebbe prima. Il ramo è lo stesso (`null` →
    // bottoni spenti), provato dai due guasti qui sopra.
  ])('guasto di lettura dei %s: 200, le note si vedono, nessuna modificabile, flag false', async (_nome, tabella) => {
    h.errori = { [tabella]: { code: '57014', message: 'canceling statement' } }
    const res = await GET(richiesta('GET', `${BASE}?sectionId=${SEZ}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.statoVociDisponibile).toBe(false)
    const data = body.data as Riga[]
    expect(data).toHaveLength(7)
    for (const n of data) {
      expect(n).toMatchObject({ modificabile: false, bloccata: false, gruppo_modificabile: false })
    }
    // Il numero di alunni del gruppo si conta dal solo elenco.
    expect(data.find((n) => n.id === NOTA_1)?.n_alunni_gruppo).toBe(4)
    expect(JSON.stringify(body)).not.toContain('canceling statement')
  })
})

describe('POST — la notifica porta il gruppo, così si può ritirare', () => {
  it('entita_id della notifica = nota_gruppo_id delle note inserite', async () => {
    h.db.notifiche = []
    const res = await POST(
      richiesta('POST', BASE, {
        sectionId: SEZ,
        alunnoIds: [ALUNNO_1, ALUNNO_2],
        categoria: 'didattica',
        testo: 'Nuova nota di prova',
        richiedeFirma: true,
      }),
    )
    expect(res.status).toBe(201)
    const { data } = await res.json()
    const gruppi = new Set((data as Riga[]).map((n) => n.nota_gruppo_id))
    expect(gruppi.size).toBe(1)
    const [gruppo] = [...gruppi]

    const accodate = h.db.notifiche as Riga[]
    expect(accodate.map((n) => n.utente_id).sort()).toEqual([GENITORE_1, GENITORE_2].sort())
    for (const n of accodate) expect(n).toMatchObject({ entita_tipo: 'nota', entita_id: gruppo, tipo: 'nota_firma' })
  })
})
