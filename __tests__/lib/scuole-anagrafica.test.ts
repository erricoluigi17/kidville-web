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
    expect(normalizzaAnagraficaSede({ autorizzazione_nido: { numero: ' ', data: '', ente: null } }).autorizzazione_nido).toBeNull()
    expect(normalizzaAnagraficaSede({}).autorizzazione_nido).toBeNull()
    expect(normalizzaAnagraficaSede({ autorizzazione_nido: { numero: ' 102A ', data: '2025-10-29', ente: ' Comune di Giugliano in Campania ' } }).autorizzazione_nido)
      .toEqual({ numero: '102A', data: '2025-10-29', ente: 'Comune di Giugliano in Campania' })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // `comune` → `ente`: la rinomina non poteva cancellare tre righe vere
  //
  // Il campo si chiamava `comune`, e su due sedi su tre l'autorizzazione l'ha
  // rilasciata un **Ambito socio-sanitario** (spec §2.1). Il nome sbagliato non
  // stava solo nello schema: l'etichetta del form chiedeva un Comune e il
  // certificato stampava «rilasciata dal Comune di Ambito Socio-Sanitario C06 —
  // …» a un ente pubblico.
  //
  // Ma rinominare una chiave dentro uno schema che è ANCHE lista bianca in
  // scrittura vuol dire cancellarla: al primo `PATCH`, le tre autorizzazioni
  // salvate sotto `comune` sarebbero sparite e con loro il certificato per il
  // Bonus Nido — in silenzio, su tutte e tre le sedi. Il valore vecchio si
  // travasa in `ente`, la chiave vecchia non si riscrive: è la migrazione del
  // dato fatta dal salvataggio, invece che da una `UPDATE` sul JSONB di
  // produzione.
  // ───────────────────────────────────────────────────────────────────────────
  it('la chiave vecchia `comune` si travasa in `ente` e non torna nell’oggetto salvato', () => {
    const salvata = normalizzaAnagraficaSede({
      autorizzazione_nido: { numero: '17', data: '2024-10-01', comune: 'Ambito Socio-Sanitario C06 — Comune capofila Aversa' },
    })
    expect(salvata.autorizzazione_nido).toEqual({
      numero: '17',
      data: '2024-10-01',
      ente: 'Ambito Socio-Sanitario C06 — Comune capofila Aversa',
    })
    expect(salvata.autorizzazione_nido).not.toHaveProperty('comune')
  })

  it('con entrambe le chiavi vince `ente`: è quella che il form manda', () => {
    expect(
      normalizzaAnagraficaSede({
        autorizzazione_nido: { ente: 'Ambito Socio-Sanitario C6 — Comune capofila Casaluce', comune: 'Cesa' },
      }).autorizzazione_nido?.ente,
    ).toBe('Ambito Socio-Sanitario C6 — Comune capofila Casaluce')
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
        autorizzazione_nido: { numero: '6/2018', data: '2018-04-12', ente: 'Ambito Socio-Sanitario C6 — Comune capofila Casaluce' },
      },
    })
    expect(a.legale_rappresentante).toBe('Errico Cesario')
    expect(a.autorizzazione_nido).toEqual({
      numero: '6/2018',
      data: '2018-04-12',
      ente: 'Ambito Socio-Sanitario C6 — Comune capofila Casaluce',
    })
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
      autorizzazione_nido: { numero: '6/2018', data: '2018-04-12', ente: 'Ambito Socio-Sanitario C6 — Comune capofila Casaluce' },
    })
    const config = { anagrafica: salvata }
    expect(leggiAutorizzazioneNido(config)).toEqual({
      numero: '6/2018',
      data: '2018-04-12',
      ente: 'Ambito Socio-Sanitario C6 — Comune capofila Casaluce',
    })
    expect(parseAnagraficaSede(config).legale_rappresentante).toBe('Errico Cesario')
  })

  it('e regge anche il giro di una riga SCRITTA PRIMA della rinomina', () => {
    // La riga com'era in produzione il 2026-08-16, prima che il form la risalvasse:
    // il prestampato deve continuare a leggerla, o il certificato per il Bonus Nido
    // sparisce fra la rinomina e il primo salvataggio.
    const vecchia = { anagrafica: { autorizzazione_nido: { numero: '102A', data: '2025-10-29', comune: 'Comune di Giugliano in Campania' } } }
    expect(leggiAutorizzazioneNido(vecchia)?.ente).toBe('Comune di Giugliano in Campania')
    // E riaprendo il form si vede il valore, non un campo vuoto da ridigitare.
    expect(parseAnagraficaSede(vecchia).autorizzazione_nido?.ente).toBe('Comune di Giugliano in Campania')
  })
})
