import { describe, it, expect } from 'vitest'
import {
  MIN_PREDEFINITO,
  MAX_PREDEFINITO,
  intervallo,
  validaConfigurazione,
} from '@/lib/avvisi/partecipanti'

/**
 * ─── IL CONTATORE DEI PARTECIPANTI ───────────────────────────────────────────
 *
 * I vincoli che stanno in UN campo li esprime zod (`zNumeroPartecipanti`). Qui si
 * provano i due che guardano DUE campi e che uno schema non può vedere: il
 * rapporto `max >= min` (gemello della seconda metà del `CHECK` della colonna) e
 * l'etichetta obbligatoria solo a contatore acceso.
 */
describe('intervallo — `null` significa «non deciso», non «illimitato»', () => {
  it('i predefiniti sono 1..20, gli stessi `DEFAULT` del DDL', () => {
    expect(MIN_PREDEFINITO).toBe(1)
    expect(MAX_PREDEFINITO).toBe(20)
    expect(intervallo({ numero_min: null, numero_max: null })).toEqual({ min: 1, max: 20 })
    // Il corpo di una richiesta può non avere affatto i campi; la riga letta dal
    // database ce li ha sempre, a `null`.
    expect(intervallo({})).toEqual({ min: 1, max: 20 })
  })

  it('🔑 un `numero_max` nullo NON è «illimitato»', () => {
    // È il difetto che questa funzione esiste per evitare: letto come illimitato,
    // lascerebbe passare un'adesione da 400 persone su un pullman.
    expect(intervallo({ numero_max: null }).max).toBe(20)
    expect(intervallo({ numero_max: null }).max).not.toBe(Number.POSITIVE_INFINITY)
  })

  it('i valori espliciti vincono sui predefiniti, anche quando coincidono col limite', () => {
    expect(intervallo({ numero_min: 2, numero_max: 6 })).toEqual({ min: 2, max: 6 })
    // Uno solo dei due deciso: l'altro prende il predefinito.
    expect(intervallo({ numero_min: 4, numero_max: null })).toEqual({ min: 4, max: 20 })
    expect(intervallo({ numero_min: null, numero_max: 999 })).toEqual({ min: 1, max: 999 })
  })
})

describe('validaConfigurazione', () => {
  it('a contatore SPENTO non si controlla niente', () => {
    // L'interfaccia lascia i campi riempiti quando la segreteria accende e poi
    // rispegne l'interruttore: rifiutare il salvataggio per un'etichetta rimasta
    // in un campo NASCOSTO sarebbe un 400 su qualcosa che l'operatore non vede.
    for (const spento of [false, null, undefined]) {
      expect(
        validaConfigurazione({ chiediNumero: spento, etichetta: null, min: 10, max: 4 }),
      ).toEqual({ ok: true })
    }
  })

  it('a contatore ACCESO l\'etichetta è obbligatoria', () => {
    // Senza domanda, il genitore legge un riquadro numerico senza sapere che cosa
    // gli si sta chiedendo.
    for (const vuota of [null, undefined, '', '   ', '\t\n']) {
      expect(
        validaConfigurazione({ chiediNumero: true, etichetta: vuota, min: null, max: null }),
      ).toEqual({ ok: false, codice: 'ETICHETTA_MANCANTE' })
    }
  })

  it('un\'etichetta vera passa, con i predefiniti applicati sotto', () => {
    expect(
      validaConfigurazione({
        chiediNumero: true,
        etichetta: 'Quante persone accompagneranno il bambino?',
        min: null,
        max: null,
      }),
    ).toEqual({ ok: true })
  })

  it('🔑 NUMERO_INTERVALLO_NON_VALIDO: `min > max` — gemello del `CHECK` in colonna', () => {
    // È l'unico dei tre vincoli del `CHECK` che produrrebbe un 23514 → 500 invece
    // di un 400 leggibile: il messaggio del database nominerebbe il vincolo, non
    // il campo. E `min: 10, max: 4` è un modulo che nessuna famiglia può compilare.
    expect(
      validaConfigurazione({ chiediNumero: true, etichetta: 'Quante persone?', min: 10, max: 4 }),
    ).toEqual({ ok: false, codice: 'NUMERO_INTERVALLO_NON_VALIDO' })
  })

  it('`min === max` è LEGITTIMO: «esattamente due accompagnatori»', () => {
    expect(
      validaConfigurazione({ chiediNumero: true, etichetta: 'Quante persone?', min: 2, max: 2 }),
    ).toEqual({ ok: true })
  })

  it('il rapporto si misura DOPO i predefiniti, non prima', () => {
    // `min: 25` con `max` non deciso: il max vale 20 (il `DEFAULT` della colonna),
    // quindi l'intervallo è vuoto e va rifiutato. Guardando i campi grezzi — un
    // `null` che «non vincola» — questo caso passerebbe e finirebbe nel `CHECK`.
    expect(
      validaConfigurazione({ chiediNumero: true, etichetta: 'Quante persone?', min: 25, max: null }),
    ).toEqual({ ok: false, codice: 'NUMERO_INTERVALLO_NON_VALIDO' })
    // …e con il max alzato apposta, lo stesso min passa.
    expect(
      validaConfigurazione({ chiediNumero: true, etichetta: 'Quante persone?', min: 25, max: 30 }),
    ).toEqual({ ok: true })
  })

  it('l\'etichetta si controlla PRIMA dell\'intervallo', () => {
    // Due cose sbagliate insieme: il primo messaggio deve essere quello del campo
    // che la segreteria ha davanti per primo nel modulo.
    expect(
      validaConfigurazione({ chiediNumero: true, etichetta: '', min: 10, max: 4 }),
    ).toEqual({ ok: false, codice: 'ETICHETTA_MANCANTE' })
  })
})
