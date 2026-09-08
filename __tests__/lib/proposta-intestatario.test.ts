import { describe, it, expect } from 'vitest'
import {
  propostaApplicabile,
  intestatarioAutomaticoDelLotto,
  propostaBloccataDaiDati,
  CHIAVE_MOTIVO_PROPOSTA,
  MOTIVI_NOTI,
  type AnteprimaConProposta,
} from '@/lib/pagamenti/proposta-intestatario'

// Le condizioni con cui l'emissione singola preseleziona l'intestatario, estratte
// in un modulo puro perché il lotto usi LE STESSE e non una loro parafrasi.

const MAMMA = { adult_id: 'a-1', nome: 'Rossi Maria', fatturabile: true }
const PAPA = { adult_id: 'a-2', nome: 'Rossi Luca', fatturabile: true }

const base = (over: Partial<AnteprimaConProposta> = {}): AnteprimaConProposta => ({
  quote: [{ fatturabile: false }],
  ripartito: false,
  candidati: [MAMMA, PAPA],
  proposta: { adult_id: 'a-1', motivo: 'bonifico_esatto' },
  ordinante: 'ROSSI MARIA',
  ...over,
})

describe('propostaApplicabile — le quattro condizioni della singola', () => {
  it('proposta piena e coerente → si usa, col nome del candidato', () => {
    expect(propostaApplicabile(base())).toEqual({ adult_id: 'a-1', motivo: 'bonifico_esatto', nome: 'Rossi Maria' })
  })

  it('nessuna proposta → null', () => {
    expect(propostaApplicabile(base({ proposta: null }))).toBe(null)
  })

  it('il proposto NON è fra i candidati → null, mai un ripiego sul primo', () => {
    // è la condizione che impedisce di intestare la fattura alla persona
    // sbagliata in silenzio
    const r = propostaApplicabile(base({ proposta: { adult_id: 'a-ignoto', motivo: 'bonifico_esatto' } }))
    expect(r).toBe(null)
  })

  it('un motivo che non sappiamo spiegare → null (arriva da un JSON.parse, il tipo non basta)', () => {
    expect(propostaApplicabile(base({ proposta: { adult_id: 'a-1', motivo: 'somiglianza_fonetica' } }))).toBe(null)
  })

  it("l'ordinante vuoto o fatto di soli spazi → null: senza il bonifico non c'è niente da proporre", () => {
    expect(propostaApplicabile(base({ ordinante: '   ' }))).toBe(null)
    expect(propostaApplicabile(base({ ordinante: null }))).toBe(null)
  })

  it('un blocco degradato non fa esplodere niente', () => {
    expect(propostaApplicabile(null)).toBe(null)
    expect(propostaApplicabile(undefined)).toBe(null)
    expect(propostaApplicabile({})).toBe(null)
  })

  it('ogni motivo noto ha la sua frase, e sono quattro', () => {
    expect(Object.keys(CHIAVE_MOTIVO_PROPOSTA).sort()).toEqual([...MOTIVI_NOTI].sort())
    for (const m of MOTIVI_NOTI) expect(CHIAVE_MOTIVO_PROPOSTA[m]).toMatch(/^fatBtn_int_proposta_/)
  })
})

describe('intestatarioAutomaticoDelLotto — le due guardie in più', () => {
  it('proposta usabile e proposto fatturabile → si emette senza chiedere', () => {
    expect(intestatarioAutomaticoDelLotto(base())?.adult_id).toBe('a-1')
  })

  it('pagamento RIPARTITO → null: con i genitori separati ognuno riceve il proprio documento', () => {
    expect(intestatarioAutomaticoDelLotto(base({ ripartito: true }))).toBe(null)
    // ...ma la singola la propone lo stesso: è lei a mostrare l'avviso e a bloccare
    expect(propostaApplicabile(base({ ripartito: true }))).not.toBe(null)
  })

  it('proposto NON fatturabile → null: nel lotto nessuno legge l’avviso', () => {
    const a = base({ candidati: [{ ...MAMMA, fatturabile: false }, PAPA] })
    expect(intestatarioAutomaticoDelLotto(a)).toBe(null)
    // la singola invece lo preseleziona, e poi blocca «Emetti»
    expect(propostaApplicabile(a)?.adult_id).toBe('a-1')
  })

  it('`fatturabile` assente non vale come `true`', () => {
    const a = base({ candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria' }] })
    expect(intestatarioAutomaticoDelLotto(a)).toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PERCHÉ la riga non è entrata nel lotto: è una frase, non un documento
//
// «Manca l'intestatario» e «i suoi dati non bastano» mandano l'operatore in due
// posti diversi, e la prima è falsa quando l'app il pagatore l'ha riconosciuto.
// ─────────────────────────────────────────────────────────────────────────────
describe('propostaBloccataDaiDati', () => {
  const conCandidati = (fatturabile: boolean | undefined, over: Partial<AnteprimaConProposta> = {}): AnteprimaConProposta => ({
    quote: [],
    ripartito: false,
    candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria', ...(fatturabile === undefined ? {} : { fatturabile }) }],
    proposta: { adult_id: 'a-1', motivo: 'bonifico_esatto' },
    ordinante: 'ROSSI MARIA',
    ...over,
  })

  it('pagatore riconosciuto ma non fatturabile → true, ANCHE con le quote vuote', () => {
    // Le quote vuote sono il caso che il vecchio `quote.some(…)` non vedeva: su un
    // elenco vuoto rispondeva `false` e la frase giusta non usciva mai.
    expect(propostaBloccataDaiDati(conCandidati(false))).toBe(true)
    expect(propostaBloccataDaiDati(conCandidati(undefined))).toBe(true)
  })

  it('pagatore riconosciuto E fatturabile → false: quella riga è entrata nel lotto', () => {
    expect(propostaBloccataDaiDati(conCandidati(true))).toBe(false)
  })

  it('nessuna proposta → false: qui «manca l’intestatario» è la frase vera', () => {
    expect(propostaBloccataDaiDati({ quote: [], candidati: [], proposta: null, ordinante: null })).toBe(false)
    expect(propostaBloccataDaiDati(null)).toBe(false)
  })

  it('pagamento RIPARTITO → false: ha una frase sua, e viene prima', () => {
    // Non è «i dati non bastano»: gli intestatari sono due, ed è voluto.
    expect(propostaBloccataDaiDati(conCandidati(false, { ripartito: true }))).toBe(false)
  })
})
