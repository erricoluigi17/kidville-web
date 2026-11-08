// @vitest-environment node
/**
 * L'anno scolastico che il precompilato porta sul foglio (compito 4.1.S1).
 *
 * PRIMA: `annoScolasticoCorrente(oggi)` — anno dell'orologio, soglia al 1° agosto, uguale per
 * ogni bambino e ogni sede. DOPO: `annoDellaFrequenza` — l'anno in cui il bambino frequenta,
 * nel calendario della sua sede; senza calendario, l'anno del giorno `oggi` con soglia 1° settembre.
 *
 * Il client è il finto che APPLICA i filtri (`creaFintoSupabase`): un mock piatto sarebbe verde
 * anche con l'anno cablato. Nessun dato reale: uuid e nomi inventati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ANNO_SEDE = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ANNO = 'c3c3c3c3-3333-4333-8333-cccccccccccc'

const gate = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => gate)

import { caricaPrefillAlunno } from '@/lib/prestampati/prefill'

function db(): Record<string, Record<string, unknown>[]> {
  return {
    alunni: [
      {
        id: ALUNNO,
        nome: 'Mario',
        cognome: 'Rossi',
        scuola_id: SEDE,
        stato: 'iscritto',
        section_id: null,
        classe_sezione: null,
      },
    ],
    sections: [],
    scuole: [{ id: SEDE, nome: 'Kidville di Prova', citta: 'Cittanova', indirizzo: 'Via delle Betulle 1', config: null }],
    schools: [],
    student_parents: [],
    parents: [],
    admin_settings: [],
    anni_sede: [],
    frequenze: [],
  }
}

const calendarioCorrente2031 = () => [
  {
    id: ANNO_SEDE,
    scuola_id: SEDE,
    anno_id: ANNO,
    inizio: '2031-09-01',
    fine: '2032-08-31',
    ultimo_giorno_aperto: '2032-08-31',
    prepara_successivo_dal: '2032-03-01',
    stato: 'corrente',
    domande_aperte: false,
    anni_scolastici: { anno_inizio: 2031 },
  },
]

async function annoDelPrefill(client: SupabaseClient, oggi: Date): Promise<string> {
  const esito = await caricaPrefillAlunno(new Request('http://localhost/x'), client, ALUNNO, { oggi })
  if (!esito.prefill) {
    throw new Error(`prefill rifiutato: ${esito.response?.status ?? 'esito sconosciuto'}`)
  }
  return esito.prefill.dati.annoScolastico
}

const SCHEMA_ASSENTE = { errori: { anni_sede: { code: 'PGRST205', message: 'assente' } } }

beforeEach(() => {
  vi.clearAllMocks()
  gate.requireParentOfStudent.mockResolvedValue({
    user: { id: 'f5f5f5f5-5555-4555-8555-ffffffffffff', role: 'segreteria', scuola_id: SEDE },
  })
})

describe('caricaPrefillAlunno — annoScolastico', () => {
  it('con una frequenza viva nell’anno attivo della sede stampa l’etichetta di QUELL’anno', async () => {
    // 2031/2032 non lo produce nessun orologio di `oggi` (2026): arriva da frequenze → anni_sede.
    const d = db()
    d.anni_sede = calendarioCorrente2031()
    d.frequenze = [{ alunno_id: ALUNNO, scuola_id: SEDE, stato: 'iscritto', anno_sede_id: ANNO_SEDE }]
    expect(await annoDelPrefill(creaFintoSupabase(d), new Date('2026-10-10T10:00:00Z'))).toBe('2031/2032')
  })

  it('con lo schema dell’anno assente (PGRST205) e oggi = 15 agosto 2026 → 2025/2026 (cambio di soglia: era 2026/2027)', async () => {
    // PRIMA: `annoScolasticoCorrente` cambiava anno il 1° agosto, e il 15/08/2026 dava `2026/2027`.
    // DOPO: la soglia predefinita è il 1° settembre (il centro estivo è dell'anno che si chiude).
    const client = creaFintoSupabase(db(), [], SCHEMA_ASSENTE)
    expect(await annoDelPrefill(client, new Date('2026-08-15T10:00:00Z'))).toBe('2025/2026')
  })

  it('il giorno è quello di Roma: le 22:30 UTC del 31 agosto sono già il 1° settembre', async () => {
    const client = creaFintoSupabase(db(), [], SCHEMA_ASSENTE)
    expect(await annoDelPrefill(client, new Date('2026-08-31T22:30:00Z'))).toBe('2026/2027')
    expect(await annoDelPrefill(client, new Date('2026-08-31T21:30:00Z'))).toBe('2025/2026')
  })
})
