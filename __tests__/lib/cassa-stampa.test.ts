// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { costruisciConteggioPdf, differenzeConteggio, type ConteggioCassa, type StampaConteggioInput } from '@/lib/cassa/stampa'
import { elementiTesto } from '../fixtures/misure-pdf'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'

const conteggio: ConteggioCassa = {
  righe: [
    { scuola_id: 's1', cassa_categoria_id: 'c1', cassa_nome: 'Saggio', entrate: 150, uscite: 20, prelievi: 0, rettifiche: 0, netto: 130 },
    { scuola_id: 's2', cassa_categoria_id: 'c1', cassa_nome: 'Saggio', entrate: 80, uscite: 10, prelievi: 0, rettifiche: 0, netto: 70 },
    { scuola_id: 's1', cassa_categoria_id: null, cassa_nome: null, entrate: 40, uscite: 15, prelievi: 5, rettifiche: -2, netto: 18 },
  ],
  totali: { entrate: 270, uscite: 45, prelievi: 5, rettifiche: -2, netto: 218 },
}
const base: StampaConteggioInput = {
  raggruppamento: 'totale', conteggio, da: '2026-09-01', a: '2026-09-30',
  sedi: [{ id: 's1', nome: 'Kidville Alfa' }, { id: 's2', nome: 'Kidville Beta' }],

}
async function testo(i: StampaConteggioInput) { return (await elementiTesto(new Uint8Array(costruisciConteggioPdf(i)))).map((e) => e.testo).join(' ') }

describe('conteggio contanti PDF', () => {
  it('totale dichiara periodo/sedi e solo flussi contanti senza chiamarlo saldo fisico', async () => {
    const t = await testo(base)
    expect(t).toContain('01/09/2026')
    expect(t).toContain('30/09/2026')
    expect(t).toContain('Kidville Alfa')
    expect(t).toContain('Kidville Beta')
    expect(t).toContain('270,00')
    expect(t).toContain('218,00')
    expect(t).not.toContain('Altri metodi')
    expect(t).toContain('escluso fondo iniziale')
    expect(t).toContain('non è il saldo fisico')
  })

  it('singola categoria somma entrate e uscite attribuite, generale distinta fuori dal netto selezionato', async () => {
    const t = await testo({ ...base, raggruppamento: 'categoria', categoriaId: 'c1' })
    expect(t).toContain('Saggio')
    expect(t).toContain('230,00')
    expect(t).toContain('30,00')
    expect(t).toContain('200,00')
    expect(t).toContain('Cassa generale')
    expect(t).toContain('18,00')
    expect(t).toContain('non inclusa nel totale della categoria')
    expect(t).not.toContain('218,00')
  })

  it('non perde categorie oltre una pagina e resta nella finestra della carta con nomi lunghi', async () => {
    const righe = Array.from({ length: 90 }, (_, n) => ({ ...conteggio.righe[0], cassa_categoria_id: `c${n}`, cassa_nome: `Categoria ${n} con un nome lungo da mantenere leggibile`, entrate: 10, uscite: 2, netto: 8 }))
    const pdf = costruisciConteggioPdf({ ...base, raggruppamento: 'categoria', categoriaId: undefined, conteggio: { righe, totali: { entrate: 900, uscite: 180, prelievi: 0, rettifiche: 0, netto: 720 } } })
    const elementi = await elementiTesto(new Uint8Array(pdf))
    expect(elementi.map((e) => e.testo).join(' ')).toContain('Categoria 89')
    expect(Math.max(...elementi.map((e) => e.pagina))).toBeGreaterThan(1)
    for (const e of elementi) {
      const ingombro = ingombroTesto(e.yMm, e.corpoPt)
      expect(ingombro.cima).toBeGreaterThan(CARTA.brandFine)
      if (Math.abs(e.yMm - CARTA.rigaServizio) > 0.1) expect(ingombro.fondo).toBeLessThanOrEqual(CARTA.contenutoFine + 0.02)
      expect(e.xMm).toBeGreaterThanOrEqual(CARTA.margineSx - 0.02)
      expect(e.xMm + e.larghezzaMm).toBeLessThanOrEqual(CARTA.margineDx + 0.1)
    }
  })

  it('verifica somme complessive e formula di ogni riga, non solo un totale dichiarato', () => {
    expect(differenzeConteggio(conteggio)).toEqual([])
    expect(differenzeConteggio({ ...conteggio, totali: { ...conteggio.totali, netto: 220 } })).not.toEqual([])
    const rotto = structuredClone(conteggio)
    rotto.righe[0].netto += 1
    rotto.righe[1].netto -= 1
    expect(differenzeConteggio(rotto)).not.toEqual([])
  })
})


it('ottobre: storno di settembre resta -100 contanti senza un vecchio report contraddittorio', async () => {
  const riga = { scuola_id: 's1', cassa_categoria_id: 'c1', cassa_nome: 'Retta', entrate: -100, uscite: 0, prelievi: 0, rettifiche: 0, netto: -100 }
  // Vecchio report: originale di settembre escluso, quindi lo storno ottobre è perso.
  // Anche se un chiamante lo passa, il documento cash non deve rappresentarlo.
  const input = { ...base, da: '2026-10-01', a: '2026-10-31', conteggio: { righe: [riga], totali: riga }, report: { entrate_per_categoria: [], uscite_per_categoria: [], mensile: [] } }
  const t = await testo(input)
  expect(t).toContain('Entrate: € -100,00')
  expect(t).toContain('Netto dei movimenti: € -100,00')
  expect(t).not.toContain('Entrate pagamenti')
  expect(t).not.toContain('Flussi del report')
})


it('categorie omonime di sedi diverse riportano la propria sede accanto al nome', async () => {
  const a = { scuola_id: 's1', cassa_categoria_id: 'ca', cassa_nome: 'Gita', entrate: 30, uscite: 0, prelievi: 0, rettifiche: 0, netto: 30 }
  const b = { ...a, scuola_id: 's2', cassa_categoria_id: 'cb', entrate: 20, netto: 20 }
  const t = await testo({ ...base, raggruppamento: 'categoria', conteggio: { righe: [a, b], totali: { entrate: 50, uscite: 0, prelievi: 0, rettifiche: 0, netto: 50 } } })
  expect(t).toContain('Gita - Kidville Alfa')
  expect(t).toContain('Gita - Kidville Beta')
})
