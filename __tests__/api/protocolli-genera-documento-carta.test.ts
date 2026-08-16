// @vitest-environment node
/**
 * Il documento generato dalla segreteria esce sulla CARTA INTESTATA, e non con la fascia
 * dei documenti acquisiti.
 *
 * ⚠️ **Il difetto che questo test esiste per impedire non si vede in nessun conteggio.**
 * `buildDocumentoRichiestaPdf` non disegna più la testata — ce l'ha la carta — quindi un
 * `registraProtocollo` lasciato com'era avrebbe protocollato un foglio BIANCO con sopra la
 * fascia verde di `applicaSegnatura()`: pagine giuste, byte giusti, testo estraibile
 * giusto, e un certificato senza il marchio della scuola, senza filigrana e senza il piede
 * con la P.IVA e le tre sedi. Peggio di prima, e con il numero di protocollo già bruciato
 * in un registro WORM.
 *
 * Si misura il file che finisce nel bucket — quello che la segreteria scarica davvero —
 * non ciò che la funzione promette di fare.
 *
 * Nessun dato reale: uuid, nomi e sede sono inventati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { immaginiDisegnate, ingombriPercorsi } from '../fixtures/misure-pdf'

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const OPERATORE = 'u5u5u5u5-5555-4555-8555-uuuuuuuuuuuu'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  caricati: [] as { path: string; bytes: Uint8Array }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: h.resolveScuoleAttive }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const client = creaFintoSupabase(h.db, [], {
        rpc: { prossimo_numero_protocollo: () => ({ data: 12, error: null }) },
      })
      // Lo storage del finto client LANCIA per scelta: qui se ne mette uno che conserva i
      // byte, perché è proprio il file caricato la cosa da misurare.
      ;(client as unknown as { storage: unknown }).storage = {
        from: () => ({
          upload: async (path: string, bytes: Uint8Array | Buffer) => {
            h.caricati.push({ path, bytes: new Uint8Array(bytes) })
            return { data: { path }, error: null }
          },
          createSignedUrl: async (path: string) => ({
            data: { signedUrl: `https://esempio.invalid/${path}` },
            error: null,
          }),
          remove: async () => ({ data: null, error: null }),
        }),
      }
      return client as SupabaseClient
    },
  }
})

import { POST } from '@/app/api/admin/protocolli/genera-documento/route'

const richiesta = (corpo: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/admin/protocolli/genera-documento', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.caricati = []
  h.db = {
    alunni: [
      { id: ALUNNO, nome: 'Mario', cognome: 'Rossi', classe_sezione: '3 ANNI', scuola_id: SEDE },
    ],
    scuole: [
      {
        id: SEDE,
        nome: 'Kidville di Prova',
        citta: 'Cittanova',
        indirizzo: 'Via delle Betulle 1',
        config: null,
      },
    ],
    schools: [{ id: SEDE, nome: 'Kidville di Prova' }],
    protocolli: [],
    protocolli_allegati: [],
  }
  h.requireStaff.mockResolvedValue({ user: { id: OPERATORE, role: 'segreteria', scuola_id: SEDE } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
})

async function generaEPrendiIlTimbrato(): Promise<Uint8Array> {
  const res = await POST(richiesta({ tipoDocumento: 'frequenza', alunnoId: ALUNNO }))
  expect(res.status).toBe(201)
  const timbrato = h.caricati.find((f) => f.path.endsWith('-timbrato.pdf'))
  expect(timbrato, 'nessun file timbrato caricato nel bucket').toBeTruthy()
  return timbrato!.bytes
}

describe('POST /api/admin/protocolli/genera-documento — il foglio che esce', () => {
  it('archivia un documento sulla carta intestata reale, non un foglio nudo', async () => {
    const pdf = await generaEPrendiIlTimbrato()
    // La carta è un asset da 1.097.589 byte incorporato una volta sola: un documento che
    // non la porta pesa qualche migliaio di byte. È la differenza che si misura.
    expect(pdf.byteLength).toBeGreaterThan(500_000)
    // E la carta è VETTORIALE: centinaia di tracciati, non un'immagine incollata.
    expect((await ingombriPercorsi(pdf)).length).toBeGreaterThan(50)
  })

  it('non ci mette sopra il logo della fascia dei documenti acquisiti', async () => {
    // `applicaSegnatura()` disegna un PNG bianco dentro la fascia verde. La carta della
    // scuola non contiene nessuna immagine raster (misurato: 0 immagini incorporate),
    // quindi un solo `paintImageXObject` sul foglio significa che la fascia è passata di
    // qui — sopra il marchio della scuola, che è il difetto n. 2 della specifica.
    expect(await immaginiDisegnate(await generaEPrendiIlTimbrato())).toEqual([])
  })

  it('porta la segnatura di protocollo, in chiaro, sul foglio', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(await generaEPrendiIlTimbrato())).replace(/\s+/g, ' ')
    expect(testo).toContain('KIDVILLE DI PROVA')
    expect(testo).toContain('Prot. n.')
    expect(testo).toContain('CERTIFICATO DI FREQUENZA')
  })

  it("l'originale archiviato è lo stesso documento, non un altro file", async () => {
    await generaEPrendiIlTimbrato()
    const percorsi = h.caricati.map((f) => f.path)
    expect(percorsi.filter((p) => p.endsWith('-originale.pdf'))).toHaveLength(1)
    expect(percorsi.filter((p) => p.endsWith('-timbrato.pdf'))).toHaveLength(1)
  })
})
