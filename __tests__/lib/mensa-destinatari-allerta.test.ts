import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { ConflittoAllergia } from '@/lib/mensa/allergeni'

// =============================================================================
// ALERT ALLERGIE MENSA — chi lo riceve, e cosa succede quando non lo riceve
// nessuno.
//
// M6 (2026): il set dei ruoli ometteva `segreteria`, che la mensa la gestisce.
//
// AUDIT 2026-07-31 (F6): `destinatariAllerta` risolveva lo staff dalla sola
// colonna `utenti.scuola_id`. Per Kidville Aversa e Kidville Cesa — aperte il
// 29/07, dove nessuno ha ancora quella sede come PRIMARIA e la Direzione arriva
// dal ponte `utenti_scuole` — la lista usciva VUOTA: l'alert «nel menu di oggi
// c'è un allergene di questo bambino» non arrivava a nessuno, e `notificaAllergie`
// rispondeva comunque `{ inviata: true }`, quindi il cron delle 07:00 contava
// l'allarme come partito. Nei log, «avvisata la cucina» e «non avvisato nessuno»
// erano la stessa cosa.
//
// Qui il finto client FILTRA e SCRIVE davvero: i destinatari sono una proprietà
// verificata, e le righe finite in `notifiche` si leggono nell'accumulatore.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/push/web-push', () => ({ sendPush: vi.fn(async () => ({ gone: false })) }))
vi.mock('@/lib/mensa/allergeni', () => ({ allergeneLabel: (a: string) => a }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: vi.fn(async () => true) }))
// La maestra della sezione del bambino: mappata su 'maestra1'.
const docentiDiSezione = vi.fn(async () => ['maestra1'])
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: (...a: unknown[]) => docentiDiSezione(...(a as [])) }))

import { destinatariAllerta, notificaAllergie } from '@/lib/mensa/notify'

/** Sede storica (staff primario) + sede appena aperta (staff solo dal ponte). */
function db(): DBFinto {
  return {
    utenti: [
      { id: 'admin1', ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
      { id: 'coord1', ruolo: 'coordinator', role: 'coordinator', scuola_id: SEDE_A },
      { id: 'segr1', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
      { id: 'cuoca1', ruolo: 'cuoca', role: 'cuoca', scuola_id: SEDE_A },
      { id: 'maestra1', ruolo: 'maestra', role: 'maestra', scuola_id: SEDE_A },
      { id: 'maestra2', ruolo: 'maestra', role: 'maestra', scuola_id: SEDE_A },
      { id: 'genit1', ruolo: 'genitore', role: 'genitore', scuola_id: SEDE_A },
    ],
    // La Direzione copre anche la sede nuova, ma solo attraverso il ponte.
    utenti_scuole: [{ utente_id: 'admin1', scuola_id: SEDE_B }],
    notifiche: [],
    push_subscriptions: [],
  }
}

const CONFLITTI: ConflittoAllergia[] = [{ allergene: 'latte', portate: ['primo'] }]
const opts = (scuolaId: string) => ({
  alunnoId: 'al-1',
  nomeAlunno: 'Bambino di prova',
  classeSezione: '2 ANNI',
  sezioneId: 'sez-1',
  scuolaId,
  data: '2026-09-10',
  conflitti: CONFLITTI,
})

beforeEach(() => {
  logEvento.mockClear()
  docentiDiSezione.mockResolvedValue(['maestra1'])
})

describe('destinatariAllerta — chi riceve l\'alert', () => {
  it('include il ruolo segreteria tra i destinatari (M6)', async () => {
    const out = await destinatariAllerta(creaFintoSupabase(db()), SEDE_A, 'sez-1')
    expect(out).toContain('segr1')
  })

  it('destinatari finali = admin + coordinator + segreteria + cuoca + maestra di sezione', async () => {
    const out = await destinatariAllerta(creaFintoSupabase(db()), SEDE_A, 'sez-1')
    expect([...out].sort()).toEqual(['admin1', 'coord1', 'cuoca1', 'maestra1', 'segr1'])
    // il genitore non riceve l'alert; la maestra di ALTRA sezione neppure
    expect(out).not.toContain('genit1')
    expect(out).not.toContain('maestra2')
  })

  it('SEDE NUOVA: lo staff arriva dal ponte `utenti_scuole`, non dalla colonna', async () => {
    docentiDiSezione.mockResolvedValue([])
    const out = await destinatariAllerta(creaFintoSupabase(db()), SEDE_B, 'sez-b')
    // `admin1` ha come sede primaria la A: sulla B ci arriva solo dal ponte.
    expect(out).toEqual(['admin1'])
  })

  it('nessuno staff su quella sede ⇒ lista vuota (non è la sede sbagliata)', async () => {
    docentiDiSezione.mockResolvedValue([])
    const vuoto = db()
    vuoto.utenti_scuole = []
    const out = await destinatariAllerta(creaFintoSupabase(vuoto), SEDE_B, 'sez-b')
    expect(out).toEqual([])
  })
})

describe('notificaAllergie — «inviata» deve voler dire RICEVUTA', () => {
  it('destinatari trovati ⇒ inviata true, e le righe finiscono davvero in `notifiche`', async () => {
    const scritture: Scrittura[] = []
    const stato = db()
    const res = await notificaAllergie(creaFintoSupabase(stato, [], { scritture }), opts(SEDE_A))

    expect(res).toEqual({ inviata: true })
    const inserite = scritture.filter((s) => s.tabella === 'notifiche' && s.operazione === 'insert')
    expect(inserite).toHaveLength(1)
    const destinatari = inserite[0].valori.map((r) => r.utente_id as string).sort()
    expect(destinatari).toEqual(['admin1', 'coord1', 'cuoca1', 'maestra1', 'segr1'])
    expect(inserite[0].valori[0]).toMatchObject({ tipo: 'mensa_allergia', entita_id: 'al-1' })
    // Lo stato del DB, non solo la chiamata: 5 righe scritte.
    expect(stato.notifiche).toHaveLength(5)
  })

  it('ZERO destinatari ⇒ inviata FALSE e log `error`: un allarme senza nessuno da avvisare è un incidente', async () => {
    const scritture: Scrittura[] = []
    const vuoto = db()
    vuoto.utenti = []
    vuoto.utenti_scuole = []
    docentiDiSezione.mockResolvedValue([])

    const res = await notificaAllergie(creaFintoSupabase(vuoto, [], { scritture }), opts(SEDE_B))

    expect(res).toEqual({ inviata: false })
    // Nessuna riga inserita: non c'è nessuno a cui inserirla.
    expect(scritture.filter((s) => s.tabella === 'notifiche')).toHaveLength(0)
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'nessun-destinatario' && c[0] === 'mensa',
    )
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('error')
    // Solo uuid e metadati: mai il nome del bambino, che nel CORPO dell'alert c'è.
    expect(JSON.stringify(riga?.[2])).not.toMatch(/Bambino/)
  })
})
