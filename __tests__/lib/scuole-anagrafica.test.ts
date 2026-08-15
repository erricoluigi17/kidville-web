import { describe, it, expect } from 'vitest'
import { normalizzaAnagraficaSede, parseAnagraficaSede } from '@/lib/scuole/anagrafica'
import { leggiAutorizzazioneNido } from '@/lib/prestampati/prefill'

describe('normalizzaAnagraficaSede', () => {
  it('trim, vuoti → null, cod. mecc. e provincia maiuscoli', () => {
    const n = normalizzaAnagraficaSede({ codice_meccanografico: ' na1e123456 ', provincia: 'na', cap: '  ', telefono: '081 123' })
    expect(n.codice_meccanografico).toBe('NA1E123456')
    expect(n.provincia).toBe('NA')
    expect(n.cap).toBeNull()
    expect(n.telefono).toBe('081 123')
    expect(n.pec).toBeNull()
  })

  it('il legale rappresentante SOPRAVVIVE alla normalizzazione', () => {
    // Il difetto del 2026-08-15: la normalizzazione non modifica l'oggetto,
    // lo RICOSTRUISCE dai campi noti — e il PATCH scrive quel nuovo oggetto al
    // posto del precedente. Finché questa chiave non era nell'elenco, il nome
    // del legale rappresentante veniva cancellato dal primo salvataggio, anche
    // se scritto a mano nel database.
    const n = normalizzaAnagraficaSede({ legale_rappresentante: '  Errico Cesario ' })
    expect(n.legale_rappresentante).toBe('Errico Cesario')
  })

  it('autorizzazione al nido: tre campi vuoti → null, non un oggetto di null', () => {
    expect(normalizzaAnagraficaSede({ autorizzazione_nido: { numero: ' ', data: '', comune: null } }).autorizzazione_nido).toBeNull()
    expect(normalizzaAnagraficaSede({}).autorizzazione_nido).toBeNull()
    expect(normalizzaAnagraficaSede({ autorizzazione_nido: { numero: ' 77/2024 ', data: '2024-09-01', comune: ' Giugliano in Campania ' } }).autorizzazione_nido)
      .toEqual({ numero: '77/2024', data: '2024-09-01', comune: 'Giugliano in Campania' })
  })
})

describe('parseAnagraficaSede', () => {
  it('estrae da config JSONB', () => {
    const a = parseAnagraficaSede({ anagrafica: { codice_meccanografico: 'NA1E123456', provincia: 'NA' }, altro: 1 })
    expect(a.codice_meccanografico).toBe('NA1E123456')
    expect(a.provincia).toBe('NA')
  })
  it('config null/malformata → tutti null (mai throw)', () => {
    expect(parseAnagraficaSede(null).codice_meccanografico).toBeNull()
    expect(parseAnagraficaSede({ anagrafica: 'stringa-sbagliata' }).cap).toBeNull()
    expect(parseAnagraficaSede(undefined).pec).toBeNull()
  })
  it('legge legale rappresentante e autorizzazione dal JSONB', () => {
    const a = parseAnagraficaSede({
      anagrafica: {
        legale_rappresentante: 'Errico Cesario',
        autorizzazione_nido: { numero: '77/2024', data: '2024-09-01', comune: 'Cesa' },
      },
    })
    expect(a.legale_rappresentante).toBe('Errico Cesario')
    expect(a.autorizzazione_nido).toEqual({ numero: '77/2024', data: '2024-09-01', comune: 'Cesa' })
  })
  it("un'autorizzazione mal formata non porta via il resto della scheda", () => {
    // Lo `safeParse` non fallisce a metà: fallisce del tutto. Senza la potatura
    // in lettura, una sola chiave scritta a mano in forma sbagliata farebbe
    // sparire dalla schermata anche denominazione e legale rappresentante.
    const a = parseAnagraficaSede({
      anagrafica: { denominazione: 'La Favola soc. coop.', legale_rappresentante: 'Errico Cesario', autorizzazione_nido: 'n. 77 del 2024' },
    })
    expect(a.denominazione).toBe('La Favola soc. coop.')
    expect(a.legale_rappresentante).toBe('Errico Cesario')
    expect(a.autorizzazione_nido).toBeNull()
  })
})

describe('il giro completo: quello che il form salva è quello che il prestampato legge', () => {
  it('la scheda normalizzata è leggibile da leggiAutorizzazioneNido', () => {
    // Scrittura e lettura vivono in due file diversi e non condividono un tipo:
    // il form normalizza in `lib/scuole/anagrafica`, il prestampato rilegge in
    // `lib/prestampati/prefill`. Questo test è la giuntura fra i due.
    const salvata = normalizzaAnagraficaSede({
      legale_rappresentante: 'Errico Cesario',
      autorizzazione_nido: { numero: '77/2024', data: '2024-09-01', comune: 'Cesa' },
    })
    const config = { anagrafica: salvata }
    expect(leggiAutorizzazioneNido(config)).toEqual({ numero: '77/2024', data: '2024-09-01', comune: 'Cesa' })
    expect(parseAnagraficaSede(config).legale_rappresentante).toBe('Errico Cesario')
  })
})
