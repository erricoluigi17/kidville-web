import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AVVISI_CONFIG,
  DEFAULT_FUNZIONI_MATRICE,
  DEFAULT_SOLLECITI_SEDE_NUOVA,
  FUNZIONI_REGISTRO,
  GRADI_REGISTRO,
  defaultAdminSettingsRow,
} from '@/lib/scuole/admin-settings-default'
import { isFunzioneAbilitata, type GradoContext } from '@/lib/auth/require-grado'

// A3 — Una sede nuova nasceva SENZA la riga `admin_settings`: `loadGradoContext`
// leggeva `matrice = {}` e `requireFunzione` rispondeva 403 su TUTTE le funzioni
// docente (require-grado.ts:36-44 e :64-86). Qui si fissa il default con cui la
// sede nasce, e lo si verifica sul comportamento vero — non sulla forma del JSON:
// «il docente di quel grado NON prende 403».

const ctx = (grado: 'nido' | 'infanzia' | 'primaria'): GradoContext => ({
  userId: 'u-1',
  gradi: [grado],
  scuolaId: 'sede-nuova',
  matrice: DEFAULT_FUNZIONI_MATRICE as GradoContext['matrice'],
})

describe('default admin_settings di una sede nuova — funzioni_matrice', () => {
  it('copre esattamente i 3 gradi × 13 funzioni della griglia di Impostazioni', () => {
    expect(Object.keys(DEFAULT_FUNZIONI_MATRICE).sort()).toEqual([...GRADI_REGISTRO].sort())
    for (const g of GRADI_REGISTRO) {
      expect(Object.keys(DEFAULT_FUNZIONI_MATRICE[g]).sort()).toEqual([...FUNZIONI_REGISTRO].sort())
    }
    expect(FUNZIONI_REGISTRO).toHaveLength(13)
  })

  it('nido/infanzia: diario, appello, mensa, chat, avvisi, gallery abilitati (niente 403)', () => {
    for (const g of ['nido', 'infanzia'] as const) {
      for (const f of ['diario', 'appello', 'mensa', 'chat', 'avvisi', 'gallery', 'armadietto', 'modulistica']) {
        expect(isFunzioneAbilitata(ctx(g), f), `${g}/${f}`).toBe(true)
      }
      // Funzioni della sola primaria: restano spente anche per la sede nuova.
      for (const f of ['registro', 'valutazioni', 'pagelle', 'orario']) {
        expect(isFunzioneAbilitata(ctx(g), f), `${g}/${f}`).toBe(false)
      }
    }
  })

  it('primaria: registro, valutazioni, pagelle, orario e note abilitati (niente 403)', () => {
    for (const f of ['registro', 'valutazioni', 'pagelle', 'orario', 'note', 'appello', 'mensa', 'chat', 'avvisi']) {
      expect(isFunzioneAbilitata(ctx('primaria'), f), `primaria/${f}`).toBe(true)
    }
  })

  it('nessun grado resta con la matrice vuota (era la causa del 403 su tutto)', () => {
    for (const g of GRADI_REGISTRO) {
      const abilitate = Object.values(DEFAULT_FUNZIONI_MATRICE[g]).filter(Boolean)
      expect(abilitate.length, g).toBeGreaterThan(0)
    }
  })
})

describe('default admin_settings di una sede nuova — riga da inserire', () => {
  it('porta scuola_id, la matrice, i solleciti SPENTI e chi pubblica gli avvisi', () => {
    const row = defaultAdminSettingsRow('11111111-1111-4111-8111-111111111111')
    expect(row.scuola_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(row.funzioni_matrice).toEqual(DEFAULT_FUNZIONI_MATRICE)
    expect(row.solleciti_config).toEqual(DEFAULT_SOLLECITI_SEDE_NUOVA)
    expect(DEFAULT_SOLLECITI_SEDE_NUOVA.enabled).toBe(false)
    // S24: la matrice accende `avvisi` per tutti e tre i gradi, quindi la sede
    // deve anche sapere CHI può pubblicarli — altrimenti la funzione è accesa e
    // inutilizzabile insieme.
    expect(row.avvisi_config).toEqual(DEFAULT_AVVISI_CONFIG)
  })

  it('non scrive colonne che il DB riempie da solo — con UNA eccezione dichiarata', () => {
    // Meno colonne si scrivono, meno cose si rompono quando il DB cambia default:
    // tutto ciò che ha un DEFAULT in `admin_settings` NON va replicato qui.
    //
    // L'ECCEZIONE è `avvisi_config`, e il collaudo del 2026-07-31 dice perché. Il
    // DB la riempie da solo — con `'{}'`, che è un valore valido e insieme
    // inservibile: Aversa e Cesa sono nate così, e la loro segreteria non poteva
    // pubblicare un avviso. «Il DB ha già un default» è una buona ragione per non
    // scrivere una colonna solo finché quel default è una configurazione USABILE;
    // qui non lo era.
    expect(Object.keys(defaultAdminSettingsRow('x')).sort()).toEqual(
      ['avvisi_config', 'funzioni_matrice', 'scuola_id', 'solleciti_config'],
    )
  })
})
