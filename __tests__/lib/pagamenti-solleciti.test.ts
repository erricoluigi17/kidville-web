import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SOLLECITI_CONFIG,
  livelliEffettivi,
  prossimoLivello,
  renderTemplate,
} from '@/lib/pagamenti/solleciti'

describe('renderTemplate', () => {
  it('sostituisce i segnaposto e lascia intatti quelli ignoti', () => {
    const out = renderTemplate('Gentile famiglia di {alunno}, restano {residuo} per "{descrizione}" (scad. {scadenza}). {boh}', {
      alunno: 'Mario Rossi', residuo: '€ 50.00', descrizione: 'Retta Settembre', scadenza: '05/09/2026',
    })
    expect(out).toBe('Gentile famiglia di Mario Rossi, restano € 50.00 per "Retta Settembre" (scad. 05/09/2026). {boh}')
  })
})

describe('livelliEffettivi', () => {
  it('senza config usa i 3 livelli di default', () => {
    expect(livelliEffettivi(null)).toHaveLength(3)
    expect(livelliEffettivi(undefined)[0].giorni_da_scadenza).toBe(DEFAULT_SOLLECITI_CONFIG.livelli[0].giorni_da_scadenza)
  })
  it('la config sovrascrive per-livello mantenendo i default mancanti', () => {
    const liv = livelliEffettivi({ livelli: [{ giorni_da_scadenza: 5, oggetto: 'Custom', testo: 'T' }] })
    expect(liv[0].oggetto).toBe('Custom')
    expect(liv).toHaveLength(3)
  })
})

describe('prossimoLivello', () => {
  it('parte sempre dal livello 1 e non salta i livelli', () => {
    expect(prossimoLivello(null, 12, 0)).toBe(1)
    expect(prossimoLivello(null, 12, 1)).toBe(2)
  })
  it('null se il livello successivo non è ancora maturo o si è al massimo', () => {
    expect(prossimoLivello(null, 12, 2)).toBeNull() // L3 richiede 20gg
    expect(prossimoLivello(null, 40, 3)).toBeNull() // cap
    expect(prossimoLivello(null, 1, 0)).toBeNull()  // L1 richiede 3gg
  })
})
