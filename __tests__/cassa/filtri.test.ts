import { describe, expect, it } from 'vitest'
import { filtraMovimentiCassa, FILTRI_CASSA_INIZIALI, intervalloMeseCassa } from '@/lib/cassa/filtri'
import type { RigaMovimentoCassa } from '@/lib/cassa/tipi'

const uscita: RigaMovimentoCassa = {
  id: 'm1', scuola_id: 's1', tipo: 'uscita', importo: 25, metodo: 'contanti', data: '2026-10-15',
  categoria_id: 'c1', categoria_nome: 'Caffè e pulizie', descrizione: 'Detersivi', note: 'necessità mensili',
  allegato_path: 's1/ricevuta.pdf', incasso_id: null, chiusura_id: null, registrato_da: null,
  creato_il: '2026-10-15T10:00:00Z', storno_di: null, stornato_il: null, storno_motivo: null, origine: 'cassa',
}
const righe: RigaMovimentoCassa[] = [
  uscita,
  { ...uscita, id: 'm2', scuola_id: 's2', tipo: 'entrata', importo: 90, metodo: 'bonifico', data: '2026-09-01', categoria_id: null, categoria_nome: null, descrizione: 'Quota', note: null, allegato_path: null },
  { ...uscita, id: 'i1', origine: 'incasso', tipo: 'entrata', importo: 50, categoria_id: null, categoria_nome: 'Incasso', descrizione: null, note: null, allegato_path: null },
  { ...uscita, id: 'm3', stornato_il: '2026-10-16T10:00:00Z' },
  { ...uscita, id: 'm4', storno_di: 'm3', importo: -25 },
  { ...uscita, id: 'm5', tipo: 'prelievo' },
  { ...uscita, id: 'm6', tipo: 'rettifica', importo: -3 },
]
const ids = (f: Partial<typeof FILTRI_CASSA_INIZIALI>) => filtraMovimentiCassa(righe, { ...FILTRI_CASSA_INIZIALI, ...f }).movimenti.map(r => r.id)

describe('filtri registro cassa', () => {
  it('il reset comprende tutte le righe, inclusi gli storni', () => expect(ids({})).toEqual(righe.map(r => r.id)))
  it.each(['uscita', 'entrata', 'prelievo', 'rettifica'] as const)('filtra il tipo %s', tipo => {
    expect(ids({ tipo })).toEqual(righe.filter(r => r.tipo === tipo).map(r => r.id))
  })
  it('combina tutti i criteri senza modificare le righe originali', () => {
    const prima = JSON.stringify(righe)
    expect(ids({ tipo: 'uscita', scuolaId: 's1', da: '2026-10-15', a: '2026-10-15', categoriaId: 'c1', metodo: 'contanti', origine: 'cassa', stato: 'attivo', allegato: 'presente', importoMin: '25', importoMax: '25', ricerca: 'NECESSITA' })).toEqual(['m1'])
    expect(JSON.stringify(righe)).toBe(prima)
  })
  it('cerca descrizione, note e categoria ignorando maiuscole e accenti', () => {
    expect(ids({ ricerca: 'detersivi' })).toContain('m1')
    expect(ids({ ricerca: 'necessita' })).toContain('m1')
    expect(ids({ ricerca: ' CAFFE ' })).toContain('m1')
    expect(ids({ ricerca: 'inesistente' })).toEqual([])
  })
  it('distingue attivi, originali stornati e contromovimenti', () => {
    expect(ids({ stato: 'stornato' })).toEqual(['m3'])
    expect(ids({ stato: 'contromovimento' })).toEqual(['m4'])
    expect(ids({ stato: 'attivo' })).not.toContain('m3')
    expect(ids({ stato: 'attivo' })).not.toContain('m4')
  })
  it('filtra origine e allegati assenti anche con valori nulli', () => {
    expect(ids({ origine: 'incasso', allegato: 'assente' })).toEqual(['i1'])
    expect(ids({ scuolaId: 's2', metodo: 'bonifico' })).toEqual(['m2'])
  })
  it('gli importi sono valori assoluti: include il contromovimento dello stesso importo', () => {
    expect(ids({ importoMin: '25,00', importoMax: '25.00', stato: 'contromovimento' })).toEqual(['m4'])
  })
  it.each([
    { da: '2026-10-16', a: '2026-10-01' },
    { da: '2026-02-30' },
    { importoMin: '50', importoMax: '20' },
    { importoMin: '-1' },
    { importoMax: 'abc' },
  ])('un intervallo invalido non restituisce risultati ingannevoli: %j', f => {
    const esito = filtraMovimentiCassa(righe, { ...FILTRI_CASSA_INIZIALI, ...f })
    expect(esito.errore).toBeTruthy()
    expect(esito.movimenti).toEqual([])
  })
  it('il mese compila entrambi gli estremi anche a febbraio bisestile', () => {
    expect(intervalloMeseCassa('2028-02')).toEqual({ da: '2028-02-01', a: '2028-02-29' })
    expect(intervalloMeseCassa('2026-13')).toBeNull()
    expect(intervalloMeseCassa('')).toBeNull()
  })
})


describe('cassa di provenienza distinta dalla categoria di spesa', () => {
  it('filtra una cassa specifica o quella generale, compreso lo storico senza campo', () => {
    const dati = [uscita, { ...uscita, id: 'da-categoria', cassa_categoria_id: 'p1' }];
    expect(filtraMovimentiCassa(dati, { ...FILTRI_CASSA_INIZIALI, cassaId: 'p1' }).movimenti.map(r => r.id)).toEqual(['da-categoria']);
    expect(filtraMovimentiCassa(dati, { ...FILTRI_CASSA_INIZIALI, cassaId: '__generale__' }).movimenti.map(r => r.id)).toEqual(['m1']);
  });
});
