// @vitest-environment node
/**
 * La ricevuta di firma FEA (DL-001) sulla carta intestata reale.
 *
 * La ricevuta non ha un pulsante nel prodotto — non è stata chiesta (spec §4.4) — e
 * proprio per questo la carta le si applica lo stesso: un generatore che nessuno guarda è
 * quello che diverge per primo, e il giorno in cui qualcuno gli mette un pulsante davanti
 * scopre di avere in mano l'unico PDF dell'app con una banda verde inventata dal codice.
 *
 * Nessun dato reale: firmatario, hash e indirizzi sono inventati.
 */
import { describe, it, expect } from 'vitest'
import { buildReceiptPdf, buildReceiptPdfSuCarta, computeContentHash } from '@/lib/fea/receipt-pdf'
import type { ReceiptPayload } from '@/lib/fea/types'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { elementiTesto, immaginiDisegnate, ingombriPercorsi, sovrapposti } from '../fixtures/misure-pdf'

describe('computeContentHash', () => {
  it('deterministico e indipendente dall\'ordine delle chiavi', () => {
    const a = computeContentHash({ b: 2, a: 1, nested: { y: 2, x: 1 } }, { m: 'OTP_EMAIL' })
    const b = computeContentHash({ a: 1, b: 2, nested: { x: 1, y: 2 } }, { m: 'OTP_EMAIL' })
    expect(a).toBe(b)
    expect(a).toMatch(/^SHA256-[A-F0-9]+$/)
  })

  it('cambia se il documento muta (prova di inattaccabilità)', () => {
    const a = computeContentHash({ voto: 'ottimo' }, {})
    const b = computeContentHash({ voto: 'distinto' }, {})
    expect(a).not.toBe(b)
  })

  it('cambia se i metadati di firma mutano', () => {
    const a = computeContentHash({ x: 1 }, { signed_at: '2026-06-25T10:00:00Z' })
    const b = computeContentHash({ x: 1 }, { signed_at: '2026-06-26T10:00:00Z' })
    expect(a).not.toBe(b)
  })
})

const payload: ReceiptPayload = {
  title: 'Ricevuta di firma — Pagella',
  entitaTipo: 'pagella',
  entitaId: 'e-1',
  schoolName: 'Kidville di Prova',
  signer: { name: 'Maria Bianchi', email: 'maria@esempio.invalid' },
  signature: {
    method: 'OTP_EMAIL',
    provider: 'Firma OTP via email (FES)',
    email: 'maria@esempio.invalid',
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    signed_at: '2026-06-25T10:00:00.000Z',
    timestamp: '2026-06-25T10:00:00.000Z',
    hash: 'SHA256-ABC',
    compliance: 'CAD Art. 20 / DPR 445/2000',
  },
  documentPayload: { scrutinio: 's-1', alunno: 'a-1' },
}

const MARCHIO = {
  xMm: 0,
  yMm: CARTA.brandInizio,
  larghezzaMm: CARTA.larghezzaPagina,
  altezzaMm: CARTA.brandFine - CARTA.brandInizio,
}
const PIEDE_STAMPATO = {
  xMm: 0,
  yMm: CARTA.piedeInizio,
  larghezzaMm: CARTA.larghezzaPagina,
  altezzaMm: CARTA.piedeFine - CARTA.piedeInizio,
}
const eRigaDiServizio = (t: { yMm: number }) => Math.abs(t.yMm - CARTA.rigaServizio) < 0.1

describe('buildReceiptPdf — il contenuto', () => {
  it('produce un Buffer PDF non vuoto che inizia con %PDF', () => {
    const buf = buildReceiptPdf(payload)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(200)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })

  it('riporta firmatario, metodo, hash e conformità', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(new Uint8Array(buildReceiptPdf(payload)))).replace(/\s+/g, ' ')
    expect(testo).toContain('maria@esempio.invalid')
    expect(testo).toContain('OTP_EMAIL')
    expect(testo).toContain('203.0.113.7')
    expect(testo).toContain('CAD Art. 20')
  })
})

describe('buildReceiptPdf — la testata la porta la carta', () => {
  it('non disegna più la banda verde né la barra gialla', async () => {
    const dentro = (await ingombriPercorsi(new Uint8Array(buildReceiptPdf(payload)))).filter((p) =>
      sovrapposti(p, MARCHIO)
    )
    expect(dentro).toEqual([])
  })

  it('non disegna nessuna immagine', async () => {
    expect(await immaginiDisegnate(new Uint8Array(buildReceiptPdf(payload)))).toEqual([])
  })

  it('niente inchiostro dentro il piede stampato sulla carta', async () => {
    const pdf = new Uint8Array(buildReceiptPdf(payload))
    expect((await ingombriPercorsi(pdf)).filter((p) => sovrapposti(p, PIEDE_STAMPATO))).toEqual([])
    const testi = (await elementiTesto(pdf)).filter(
      (t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.piedeInizio
    )
    expect(testi.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })

  it('scrive tutto dentro la finestra della carta, margini compresi', async () => {
    const elementi = await elementiTesto(new Uint8Array(buildReceiptPdf(payload)))
    const fuori = elementi
      .filter((t) => !eRigaDiServizio(t))
      .filter((t) => {
        const { cima, fondo } = ingombroTesto(t.yMm, t.corpoPt)
        return (
          cima < CARTA.brandFine ||
          fondo > CARTA.contenutoFine ||
          t.xMm < CARTA.margineSx - 0.05 ||
          t.xMm + t.larghezzaMm > CARTA.margineDx + 0.05
        )
      })
    expect(fuori.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}/${t.xMm.toFixed(1)}`)).toEqual([])
  })

  it('con molte firme congiunte va a pagina nuova invece di sfondare il piede', async () => {
    const conSlot: ReceiptPayload = {
      ...payload,
      slots: Array.from({ length: 40 }, (_, i) => ({
        entita_tipo: 'pagella',
        entita_id: 'e-1',
        slot_index: i,
        signer_user_id: null,
        stato: i % 2 === 0 ? ('signed' as const) : ('pending' as const),
        completion_policy: 'all-required' as const,
        signature_log: null,
        firmato_il: i % 2 === 0 ? '2026-06-25T10:00:00.000Z' : null,
      })),
    }
    const pdf = new Uint8Array(buildReceiptPdf(conSlot))
    const elementi = await elementiTesto(pdf)
    expect(Math.max(...elementi.map((t) => t.pagina))).toBeGreaterThan(1)
    const fuori = elementi
      .filter((t) => !eRigaDiServizio(t))
      .filter((t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.contenutoFine)
    expect(fuori.map((t) => `p${t.pagina} ${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
  })
})

describe('buildReceiptPdfSuCarta — il foglio consegnato', () => {
  it('porta la carta intestata reale, non un foglio bianco', async () => {
    const pdf = await buildReceiptPdfSuCarta(payload)
    expect(pdf.byteLength).toBeGreaterThan(500_000)
    expect((await ingombriPercorsi(pdf)).length).toBeGreaterThan(50)
  })

  it('non perde il contenuto della ricevuta per strada', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(await buildReceiptPdfSuCarta(payload))).replace(/\s+/g, ' ')
    expect(testo).toContain('maria@esempio.invalid')
    expect(testo).toContain('CAD Art. 20')
  })
})
