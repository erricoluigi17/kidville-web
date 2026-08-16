// @vitest-environment node
/**
 * L'ordine d'acquisto al fornitore sulla carta intestata reale.
 *
 * È il documento di questo lotto che esce dalla scuola verso un TERZO — un fornitore che
 * non ha mai visto l'app e che, di Kidville, vede solo questo foglio. Fino al 2026-08-16
 * partiva senza intestazione di sorta: nome della scuola in 15 pt e via. La ragione
 * sociale, la P.IVA e le tre sedi le porta ora la carta.
 *
 * Nessun dato reale: fornitore e P.IVA sono inventati.
 */
import { describe, it, expect } from 'vitest'
import { buildOrdineFornitorePdf, type OrdineFornitorePdfInput } from '@/lib/merch/pdf'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { elementiTesto, immaginiDisegnate, ingombriPercorsi, sovrapposti } from '../fixtures/misure-pdf'

const BASE: OrdineFornitorePdfInput = {
  numero: 'PO-2026-001',
  committente: {
    denominazione: 'Scuola di Prova Soc. Coop.',
    piva: '01234567890',
    indirizzo: 'Via delle Betulle 1 — 80000 Cittanova (XX)',
  },
  fornitore: { nome: 'ForniTop', email: 'ordini@esempio.invalid' },
  righe: [
    { articolo: 'Polo', taglia: 'M', quantita: 5 },
    { articolo: 'Cappellino', taglia: '', quantita: 3 },
  ],
  note: 'Consegna entro fine mese',
}

const ordine = (modifiche: Partial<OrdineFornitorePdfInput> = {}) =>
  new Uint8Array(buildOrdineFornitorePdf({ ...BASE, ...modifiche }))

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

describe('buildOrdineFornitorePdf', () => {
  it('produce un PDF (Buffer con header %PDF)', () => {
    const buf = buildOrdineFornitorePdf(BASE)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })

  it('riporta committente, fornitore, articoli e totale', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (await estraiTesto(ordine())).replace(/\s+/g, ' ')
    expect(testo).toContain('Scuola di Prova Soc. Coop.')
    expect(testo).toContain('ForniTop')
    expect(testo).toContain("ORDINE D'ACQUISTO PO-2026-001")
    expect(testo).toContain('Polo')
    expect(testo).toContain('Totale pezzi: 8')
  })
})

describe('buildOrdineFornitorePdf — sta dentro la carta', () => {
  it('non scrive sopra il marchio della scuola', async () => {
    const sopra = (await elementiTesto(ordine())).filter(
      (t) => ingombroTesto(t.yMm, t.corpoPt).cima < CARTA.brandFine
    )
    expect(sopra.map((t) => `${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])
    expect((await ingombriPercorsi(ordine())).filter((p) => sovrapposti(p, MARCHIO))).toEqual([])
  })

  it('non disegna nessuna immagine e nessun filetto nel piede stampato', async () => {
    expect(await immaginiDisegnate(ordine())).toEqual([])
    expect((await ingombriPercorsi(ordine())).filter((p) => sovrapposti(p, PIEDE_STAMPATO))).toEqual([])
  })

  it('rispetta i margini laterali della carta', async () => {
    const fuori = (await elementiTesto(ordine())).filter(
      (t) => t.xMm < CARTA.margineSx - 0.05 || t.xMm + t.larghezzaMm > CARTA.margineDx + 0.05
    )
    expect(fuori.map((t) => `${t.testo} @ x=${t.xMm.toFixed(1)}`)).toEqual([])
  })

  it('con molte righe cambia pagina invece di attraversare il piede', async () => {
    // 60 articoli: prima di questa riparazione il salto di pagina scattava a y>270, cioè
    // DENTRO il piede a quattro colonne della carta (272,1 → 285,1). Le ultime tre righe
    // dell'ordine finivano stampate sulla ragione sociale della scuola.
    const molte = ordine({
      righe: Array.from({ length: 60 }, (_, i) => ({
        articolo: `Articolo di prova numero ${i + 1}`,
        taglia: 'M',
        quantita: 2,
      })),
    })
    const elementi = await elementiTesto(molte)
    expect(Math.max(...elementi.map((t) => t.pagina))).toBeGreaterThan(1)

    const fuori = elementi
      .filter((t) => !eRigaDiServizio(t))
      .filter((t) => ingombroTesto(t.yMm, t.corpoPt).fondo > CARTA.contenutoFine)
    expect(fuori.map((t) => `p${t.pagina} ${t.testo} @ ${t.yMm.toFixed(1)}`)).toEqual([])

    const filetti = (await ingombriPercorsi(molte)).filter((p) => sovrapposti(p, PIEDE_STAMPATO))
    expect(filetti).toEqual([])
  })

  it('non perde nemmeno una riga per strada', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = (
      await estraiTesto(
        ordine({
          righe: Array.from({ length: 60 }, (_, i) => ({
            articolo: `Articolo di prova numero ${i + 1}`,
            taglia: 'M',
            quantita: 2,
          })),
        })
      )
    ).replace(/\s+/g, ' ')
    expect(testo).toContain('Articolo di prova numero 1 ')
    expect(testo).toContain('Articolo di prova numero 60')
    expect(testo).toContain('Totale pezzi: 120')
  })
})
