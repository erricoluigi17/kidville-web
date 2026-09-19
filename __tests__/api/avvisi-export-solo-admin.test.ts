import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// GET /api/avvisi/[id]/risposte/esporta — IL FILE CHE PORTA I NOMI DEI BAMBINI.
//
// Tre cose che questo elenco deve avere, e nessuna è cosmetica:
//
//  1. UN GATE DI SEGRETERIA, e una route tutta sua. Il `GET` accanto è
//     `requireDocente`, che comprende l'`educator`: un `?format=csv` su quello
//     avrebbe messo l'esportazione dietro un gate più largo, e un `if (ruolo)`
//     dentro un handler gatato per un pubblico più largo è la forma «un gate
//     dentro un ramo `if` non domina il ramo `else`».
//  2. `Cache-Control: no-store`. È un elenco di minori: non deve restare nella
//     cache di un computer di segreteria usato da più persone, né in una cache
//     condivisa lungo la strada.
//  3. LE CELLE DISINNESCATE. Excel tratta come FORMULA una cella che comincia
//     per `=`, `+`, `-` o `@`, e questo file è fatto di testo libero: nomi di
//     famiglie e un'etichetta digitata in segreteria.
//
// E una quarta, che si prova con un'asserzione NEGATIVA: il log dell'estrazione
// deve esistere — «chi ha scaricato l'elenco dei bambini e quando» — e non deve
// contenere un solo nome.
// =============================================================================

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  utente: { id: 'u-1', role: 'segreteria', scuola_id: 'sc-1' } as { id: string; role: string; scuola_id: string },
  avviso: null as Record<string, unknown> | null,
  risposte: [] as Record<string, unknown>[],
  alunni: [] as Record<string, unknown>[],
  utenti: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({ assertAvvisoInScope: (...a: unknown[]) => h.assertAvvisoInScope(...a) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: (...a: unknown[]) => h.logScrittura(...a) }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const risultato = () => {
        if (table === 'avvisi') return { data: h.avviso, error: null }
        if (table === 'avvisi_risposte') return { data: h.risposte, error: null }
        if (table === 'alunni') return { data: h.alunni, error: null }
        if (table === 'utenti') return { data: h.utenti, error: null }
        return { data: null, error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.maybeSingle = async () => risultato()
      // Thenable: le letture d'elenco si aspettano con `await` sulla catena.
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risultato()).then(ok, ko)
      return b
    },
  }),
}))

import { GET } from '@/app/api/avvisi/[id]/risposte/esporta/route'

const ctx = (id = AVVISO_ID) => ({ params: Promise.resolve({ id }) })
const req = () => ({
  url: `http://test/api/avvisi/${AVVISO_ID}/risposte/esporta`,
  method: 'GET',
  headers: new Headers(),
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: 'u-1', role: 'segreteria', scuola_id: 'sc-1' }
  h.avviso = { id: AVVISO_ID, scuola_id: 'sc-1', etichetta_numero: 'Accompagnatori' }
  h.risposte = [
    {
      id: 'r1', parent_id: 'p1', student_id: 'a1', risposta: 'si',
      risposto_il: '2026-09-19T08:30:00Z', numero_partecipanti: 3,
      stato_adesione: 'ammessa', in_coda_dal: null,
    },
    {
      id: 'r2', parent_id: 'p2', student_id: 'a2', risposta: 'si',
      risposto_il: '2026-09-19T09:00:00Z', numero_partecipanti: 2,
      stato_adesione: 'in_attesa', in_coda_dal: '2026-09-19T09:00:00Z',
    },
    {
      // 🔴 IL CASO CHE RENDE LA COLONNA DELLO STATO INDISPENSABILE: questa
      // famiglia si è RITIRATA, e il numero le resta salvato accanto. Senza lo
      // stato in chiaro sembrerebbe partecipante con 4 persone.
      id: 'r3', parent_id: 'p3', student_id: 'a3', risposta: 'no',
      risposto_il: '2026-09-19T10:00:00Z', numero_partecipanti: 4,
      stato_adesione: null, in_coda_dal: null,
    },
  ]
  h.alunni = [
    { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A' },
    { id: 'a2', nome: 'Luca', cognome: 'Bianchi', classe_sezione: '1A' },
    { id: 'a3', nome: 'Sara', cognome: 'Verdi', classe_sezione: '2B' },
  ]
  h.utenti = [
    { id: 'p1', first_name: 'Anna', last_name: 'Rossi', nome: null, cognome: null },
    { id: 'p2', first_name: null, last_name: null, nome: 'Paolo', cognome: 'Bianchi' },
    { id: 'p3', first_name: 'Elena', last_name: 'Verdi', nome: null, cognome: null },
  ]
  h.requireStaff.mockImplementation(async (_r: unknown, allowed?: readonly string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    return ammessi.includes(h.utente.role)
      ? { user: h.utente }
      : { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
  })
  h.requireDocente.mockImplementation(async () => ({ user: h.utente }))
  h.assertAvvisoInScope.mockResolvedValue(null)
})

describe('GET /api/avvisi/[id]/risposte/esporta — gate e intestazioni', () => {
  it('403 per l’EDUCATOR: l’elenco con i nomi è riservato alla segreteria', async () => {
    h.utente = { id: 'u-doc', role: 'educator', scuola_id: 'sc-1' }
    const res = await GET(req(), ctx())
    expect(res.status).toBe(403)
    expect(h.logScrittura, 'nessun file è uscito, quindi nessuna estrazione da tracciare').not.toHaveBeenCalled()
  })

  it('403 per un admin di UN’ALTRA SEDE', async () => {
    h.assertAvvisoInScope.mockResolvedValue(NextResponse.json({ error: 'fuori plesso' }, { status: 403 }))
    const res = await GET(req(), ctx())
    expect(res.status).toBe(403)
  })

  it('`Cache-Control: no-store` e allegato: un elenco di minori non si mette in cache', async () => {
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Type')).toContain('text/csv')
  })
})

describe('GET .../esporta — il contenuto del file', () => {
  it('il BOM c’è DAVVERO nei byte (e `text()` non basta a vederlo)', async () => {
    // ⚠️ TRAPPOLA MISURATA SCRIVENDO QUESTO TEST, e vale la pena scriverla
    // perché è un verde/rosso falso in entrambe le direzioni.
    // `Response.text()` esegue la «UTF-8 decode» della specifica fetch, e quella
    // **rimuove il BOM iniziale**: un `testo.startsWith('﻿')` è rosso anche
    // quando il BOM c'è. Letto al contrario: chi si accontentasse di `text()`
    // per verificarlo non potrebbe mai vederlo, e chi lo togliesse dal codice non
    // vedrebbe nessun test diventare rosso. Si guardano i BYTE.
    const byte = new Uint8Array(await (await GET(req(), ctx())).arrayBuffer())
    expect(
      [byte[0], byte[1], byte[2]],
      'senza BOM Excel su Windows apre il file in codifica locale e gli accenti dei nomi si rompono',
    ).toEqual([0xef, 0xbb, 0xbf])
  })

  it('colonne nell’ordine atteso, etichetta del numero dall’avviso', async () => {
    const testo = await (await GET(req(), ctx())).text()
    const intestazione = testo.split('\r\n')[0]
    expect(intestazione).toContain('Classe')
    expect(intestazione).toContain('Alunno')
    expect(intestazione).toContain('Genitore')
    expect(intestazione).toContain('Stato adesione')
    expect(intestazione).toContain('Risposta')
    expect(intestazione).toContain('Accompagnatori')
    expect(intestazione).toContain('Risposto il')
    expect(intestazione).toContain('In coda dal')
  })

  it('lo STATO è in chiaro: una famiglia ritirata non sembra partecipante', async () => {
    const testo = await (await GET(req(), ctx())).text()
    const righe = testo.split('\r\n')

    expect(righe.some((r) => r.includes('Sara Verdi') && r.includes('4'))).toBe(true)
    // …ma la sua cella di stato è VUOTA, non «Confermata». È l'unica cosa che
    // distingue quel `4` dai `4` di chi viene davvero.
    const rigaSara = righe.find((r) => r.includes('Sara Verdi')) ?? ''
    expect(rigaSara).not.toContain('Confermata')
    expect(rigaSara).toContain('No')

    expect(righe.find((r) => r.includes('Mario Rossi'))).toContain('Confermata')
    expect(righe.find((r) => r.includes('Luca Bianchi'))).toContain('In lista d’attesa')
  })

  it('le date hanno il fuso italiano, mai la forma ISO/UTC', async () => {
    const testo = await (await GET(req(), ctx())).text()
    // 08:30 UTC del 19 settembre sono le 10:30 a Roma (ora legale). Un
    // `toISOString()` avrebbe scritto «2026-09-19T08:30:00.000Z», e fra
    // mezzanotte e le due avrebbe pure sbagliato GIORNO.
    expect(testo).toContain('19/09/2026, 10:30')
    expect(testo).not.toContain('T08:30')
  })

  it('🔴 le celle che cominciano per =, +, -, @ sono DISINNESCATE', async () => {
    h.alunni = [
      { id: 'a1', nome: '=cmd', cognome: 'Rossi', classe_sezione: '-1A' },
      { id: 'a2', nome: 'Luca', cognome: 'Bianchi', classe_sezione: '1A' },
      { id: 'a3', nome: 'Sara', cognome: 'Verdi', classe_sezione: '2B' },
    ]
    h.utenti = [
      { id: 'p1', first_name: '+39', last_name: 'Rossi', nome: null, cognome: null },
      { id: 'p2', first_name: '@tutti', last_name: 'Bianchi', nome: null, cognome: null },
      { id: 'p3', first_name: 'Elena', last_name: 'Verdi', nome: null, cognome: null },
    ]
    h.avviso = { id: AVVISO_ID, scuola_id: 'sc-1', etichetta_numero: '=SOMMA(A1:A9)' }

    const testo = await (await GET(req(), ctx())).text()

    // L'apice iniziale dice al foglio di calcolo «questo è testo»: il contenuto
    // resta leggibile e la formula non parte all'apertura del file.
    expect(testo).toContain('"\'=cmd Rossi"')
    expect(testo).toContain('"\'-1A"')
    expect(testo).toContain('"\'+39 Rossi"')
    expect(testo).toContain('"\'@tutti Bianchi"')
    expect(testo, 'l’etichetta è testo libero della segreteria, e finisce in intestazione').toContain('"\'=SOMMA(A1:A9)"')

    // Controprova: una cella normale NON viene toccata. Senza questa riga il
    // test passerebbe anche con una funzione che mette l'apice a tutto.
    expect(testo).toContain('Sara Verdi')
    expect(testo).not.toContain("'Sara Verdi")
  })
})

describe('GET .../esporta — la traccia dell’estrazione', () => {
  it('il log d’estrazione esiste, con conteggi e uuid', async () => {
    await GET(req(), ctx())

    const righe = h.logEvento.mock.calls.filter((c) => c[0] === 'avvisi')
    expect(righe, 'senza questa riga non si può rispondere a «chi ha scaricato l’elenco dei bambini»').toHaveLength(1)

    const campi = righe[0][2] as Record<string, unknown>
    expect(campi.esito).toBe('export-csv')
    expect(campi.avviso).toBe(AVVISO_ID)
    expect(campi.uid).toBe('u-1')
    expect(campi.ruolo).toBe('segreteria')
    expect(campi.n_righe).toBe(3)
    // Le PERSONE, non le adesioni: conta solo chi è `ammessa` (3), e il ritirato
    // con 4 salvati accanto non entra nel conto.
    expect(campi.n_persone).toBe(3)
    expect(campi.formato).toBe('csv')

    // E la traccia immodificabile, con la convenzione del repo per gli export di
    // dati personali (`entitaTipo: 'export_…'`).
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(audit.entitaTipo).toBe('export_avviso_risposte')
    expect(audit.entitaId).toBe(AVVISO_ID)
    expect(audit.scuolaId).toBe('sc-1')
  })

  it('🔴 ASSERZIONE NEGATIVA: nel log non finisce NESSUN nome, e nemmeno l’etichetta', async () => {
    h.avviso = { id: AVVISO_ID, scuola_id: 'sc-1', etichetta_numero: 'Accompagnatori della gita al lago' }
    await GET(req(), ctx())

    // Tutto ciò che questa route ha scritto nei log, in una stringa sola. La
    // redazione a lista bianca è la difesa vera, ma una difesa che non si misura
    // è una difesa creduta: qui si guarda cosa esce DAVVERO dal chiamante.
    const tutto = JSON.stringify(h.logEvento.mock.calls) + JSON.stringify(h.logScrittura.mock.calls.map((c) => c[1]))

    for (const vietato of ['Mario', 'Rossi', 'Luca', 'Bianchi', 'Sara', 'Verdi', 'Anna', 'Paolo', 'Elena']) {
      expect(tutto, `un nome è finito nei log: ${vietato}`).not.toContain(vietato)
    }
    // L'etichetta è testo libero digitato in segreteria: non è un enumerato, e
    // nei log non ci va — è il canale da cui passerebbe qualunque cosa scritta lì.
    expect(tutto).not.toContain('Accompagnatori')
    expect(tutto).not.toContain('lago')
  })
})
