// @vitest-environment node
//
// ⚠️ AMBIENTE `node`, E NON È UNA PREFERENZA: IN jsdom QUESTO FILE ERA VERDE PER SBAGLIO.
//
// La route termina con `new NextResponse(data, …)` dove `data` è il Blob che
// Supabase Storage restituisce. Il `Blob` di **jsdom NON ha `stream()`**; quello
// di Node sì (misurato: jsdom `haStream:false`, node `haStream:true`). In
// produzione gira Node, quindi jsdom qui non simulava il runtime vero — ne
// simulava uno che non esiste.
//
// Il costo di quella distanza è stato misurato, non immaginato: in locale
// (Node 24) i due casi «passa» erano VERDI, e in CI (Node 22) sono esplosi con
// `TypeError: object.stream is not a function`. Il verde locale asseriva `200`
// su un corpo che non erano i byte del PDF — cioè la cosa che il test dovrebbe
// dimostrare.
//
// Da qui anche l'asserzione sui BYTE, non solo sullo stato: uno `status` giusto
// con un corpo sbagliato è esattamente ciò che jsdom produceva.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL PDF DELLE CREDENZIALI APPLICA LA STESSA REGOLA DEL RESET — o non serve a niente.
 *
 * `admin/regenerate-credentials` nega alla Segreteria il reset di un account di
 * Direzione. Ma il PDF con la password IN CHIARO vive in un bucket e si scarica
 * con una chiave che viaggia dentro una notifica, e una notifica si inoltra.
 * Chiudere il reset lasciando aperto il download significherebbe chiudere la
 * porta e lasciare la finestra: fino al 2026-09-03 l'unica difesa di questa
 * route era `assertUtenteInScope`, cioè la sede — e ad Aversa l'admin sta nella
 * stessa sede della segreteria.
 */
/** I quattro byte d'apertura di un PDF: `%PDF`. */
const PDF_FINTO = [37, 80, 68, 70]

const h = vi.hoisted(() => {
  const stato = {
    requireStaff: vi.fn(),
    /** La riga di `utenti` per il bersaglio della chiave. `null` = non è staff. */
    utente: null as null | { id: string; scuola_id: string | null; ruolo: string | null },
    /** Le chiavi effettivamente chieste allo storage: deve restare VUOTO sul diniego. */
    scaricati: [] as string[],
    creaFinto: () => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === 'utenti'
                ? { data: stato.utente, error: null }
                : { data: null, error: null },
          }),
        }),
      }),
      storage: {
        from: () => ({
          download: async (chiave: string) => {
            stato.scaricati.push(chiave)
            // Un Blob, com'è quello vero di Supabase Storage — e in ambiente
            // `node` ha `stream()`, che è ciò che `NextResponse` gli chiede.
            return { data: new Blob([new Uint8Array(PDF_FINTO)]), error: null }
          },
        }),
      },
    }),
  }
  return stato
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Scope di sede concessivo di proposito: l'oggetto di questo file è il gate di
// RUOLO. L'isolamento fra sedi di questa route ha già i suoi test.
vi.mock('@/lib/auth/scope', () => ({
  assertUtenteInScope: vi.fn(async () => null),
  assertParentInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => h.creaFinto(),
  createClient: async () => h.creaFinto(),
}))

import { GET } from '@/app/api/admin/credentials-pdf/route'
import { NextRequest } from 'next/server'

const CHIAVE = '11111111-1111-4111-8111-111111111111-1756900000000.pdf'
const chiedi = () =>
  GET(new NextRequest(`http://localhost/api/admin/credentials-pdf?key=${encodeURIComponent(CHIAVE)}`))

describe('credentials-pdf — il PDF di un account di Direzione non si scarica dalla Segreteria', () => {
  beforeEach(() => {
    h.requireStaff.mockReset()
    h.scaricati.length = 0
  })

  it.each(['admin', 'coordinator'])(
    'segreteria che chiede il PDF di un %s: 403, e lo storage NON viene toccato',
    async (ruolo) => {
      h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'segreteria', scuola_id: 's1' } })
      h.utente = { id: 'staff-1', scuola_id: 's1', ruolo }
      const res = await chiedi()
      expect(res.status).toBe(403)
      expect((await res.json()).codice).toBe('CREDENZIALI_STAFF_RISERVATE')
      // Non basta il 403: se il file fosse già stato letto, il diniego arriverebbe
      // dopo che la password è uscita dal bucket.
      expect(h.scaricati).toHaveLength(0)
    },
  )

  it('segreteria che chiede il PDF di una maestra del proprio plesso: passa, e il PDF arriva davvero', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'segreteria', scuola_id: 's1' } })
    h.utente = { id: 'staff-1', scuola_id: 's1', ruolo: 'educator' }
    const res = await chiedi()
    expect(res.status).toBe(200)
    expect(h.scaricati).toEqual([CHIAVE])
    // I BYTE, non solo lo stato: `%PDF` in testa. Un 200 con un corpo sbagliato
    // è ciò che jsdom produceva, e nessuna asserzione sullo status lo vedeva.
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PDF_FINTO))
  })

  it('admin che chiede il PDF di un admin: passa (non regredisce)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'admin', scuola_id: 's1' } })
    h.utente = { id: 'staff-1', scuola_id: 's1', ruolo: 'admin' }
    const res = await chiedi()
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PDF_FINTO))
  })

  it('il PDF di un GENITORE non passa da questo gate (ramo diverso, non regredisce)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'a1', role: 'segreteria', scuola_id: 's1' } })
    h.utente = null // non è staff → ramo genitore
    const res = await chiedi()
    // Il finto risponde `null` anche su `parents`: la route nega 404 «PDF non
    // trovato». Ciò che si prova qui è che NON risponde 403 sul ruolo, cioè che
    // il gate nuovo non è finito sul ramo sbagliato.
    expect(res.status).toBe(404)
    expect(h.scaricati).toHaveLength(0)
  })
})
