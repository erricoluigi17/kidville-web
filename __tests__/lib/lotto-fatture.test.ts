// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  TETTO_LOTTO,
  INTERVALLO_FRA_EMISSIONI_MS,
  PAUSA_DOPO_RIFIUTO_LOCALE_MS,
  prontaPerIlLotto,
  corpoEmissione,
  pausaDopo,
  fermaIlLotto,
  numeroInDubbio,
  stimaRimanenteMs,
  CODICE_TRASPORTO_IGNOTO,
} from '@/lib/pagamenti/lotto-fatture'

/**
 * IL MOTORE DEL LOTTO — puro, in ambiente `node`, senza React né `next-intl`.
 *
 * Qui non si collauda una schermata: si collaudano le quattro decisioni che
 * rendono «emetti tutte» una funzione utile invece che un modo rapido di bruciare
 * la quota di Aruba e di spedire dodici fatture con la causale sbagliata.
 */

describe('le costanti del ritmo', () => {
  it('l’intervallo è 90 s e non 60: il limite del `signin` è 60, e un limite non è un margine', () => {
    expect(INTERVALLO_FRA_EMISSIONI_MS).toBe(90_000)
    // Il tetto vale ~18 minuti di scheda aperta (12 × 90 s) e due lotti pieni in
    // un'ora restano sotto i 60 upload/ora anche se qualcuno emette a mano.
    expect(TETTO_LOTTO).toBe(12)
    expect((TETTO_LOTTO * INTERVALLO_FRA_EMISSIONI_MS) / 60_000).toBeLessThanOrEqual(20)
    expect(TETTO_LOTTO * 2).toBeLessThanOrEqual(60)
    expect(PAUSA_DOPO_RIFIUTO_LOCALE_MS).toBe(5_000)
  })
})

describe('pausaDopo — il ritmo si misura DA INIZIO A INIZIO', () => {
  it('una chiamata da 40 s lascia 50 s di attesa', () => {
    expect(pausaDopo(200, 40_000)).toBe(50_000)
  })

  it('una chiamata più lunga dell’intervallo non fa aspettare niente (mai negativo)', () => {
    expect(pausaDopo(200, 130_000)).toBe(0)
  })

  it('un rifiuto LOCALE costa 5 s, non 90: ad Aruba non è partito niente', () => {
    expect(pausaDopo(409, 500)).toBe(PAUSA_DOPO_RIFIUTO_LOCALE_MS)
    expect(pausaDopo(400, 10)).toBe(PAUSA_DOPO_RIFIUTO_LOCALE_MS)
    expect(pausaDopo(404, 10)).toBe(PAUSA_DOPO_RIFIUTO_LOCALE_MS)
    expect(pausaDopo(422, 10)).toBe(PAUSA_DOPO_RIFIUTO_LOCALE_MS)
  })

  it('un 200 lento e un 409 lento NON pagano lo stesso: è la differenza che rende usabile un lotto di respinte', () => {
    // Con la sola sottrazione, dodici righe respinte costerebbero 18 minuti di
    // attesa per nessuna chiamata ad Aruba.
    expect(pausaDopo(409, 500)).toBeLessThan(pausaDopo(200, 500))
  })
})

describe('fermaIlLotto — quando NON si prova la riga successiva', () => {
  it('vero su 502, 503, 500 e 0 (la risposta non è arrivata affatto)', () => {
    for (const stato of [502, 503, 500, 0]) {
      expect(fermaIlLotto(stato), `stato ${stato}`).toBe(true)
    }
  })

  it('falso sui rifiuti che riguardano SOLO quella riga (409, 422)', () => {
    expect(fermaIlLotto(409)).toBe(false)
    expect(fermaIlLotto(422)).toBe(false)
    expect(fermaIlLotto(400)).toBe(false)
    expect(fermaIlLotto(404)).toBe(false)
  })

  it('falso su 200: una riga riuscita non ferma niente', () => {
    expect(fermaIlLotto(200)).toBe(false)
  })
})

describe('corpoEmissione — `causale: null`, MAI `undefined`', () => {
  it('il campo `causale` c’è ed è `null`', () => {
    const corpo = corpoEmissione('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
    expect(corpo.pagamento_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
    expect(corpo.causale).toBeNull()
    // ⚠️ `toBeNull()` da solo NON basta: `undefined` fallirebbe qui, ma un corpo
    // che il campo non ce l'ha affatto è indistinguibile da uno che lo manda
    // `null` una volta serializzato male. `null` significa «togli la correzione
    // manuale salvata», `undefined` (cioè il campo assente) «non toccarla»: è la
    // differenza che ha mandato allo SDI la FPR 1948/26 con la causale sbagliata.
    expect('causale' in corpo).toBe(true)
    expect(JSON.parse(JSON.stringify(corpo))).toHaveProperty('causale', null)
    expect(Object.keys(JSON.parse(JSON.stringify(corpo)))).toContain('causale')
  })

  it('serializzato, il corpo del lotto NON è quello che omette la causale', () => {
    const conNull = JSON.stringify(corpoEmissione('p-1'))
    const senza = JSON.stringify({ pagamento_id: 'p-1', causale: undefined })
    expect(conNull).not.toBe(senza)
    expect(senza).not.toContain('causale')
    expect(conNull).toContain('"causale":null')
  })
})

describe('prontaPerIlLotto — si emette solo ciò che l’anteprima dichiara fatturabile', () => {
  it('vera con tutte le quote fatturabili', () => {
    expect(prontaPerIlLotto({ quote: [{ fatturabile: true }] })).toBe(true)
    expect(prontaPerIlLotto({ quote: [{ fatturabile: true }, { fatturabile: true }] })).toBe(true)
  })

  it('falsa se anche UNA sola quota non è fatturabile', () => {
    expect(prontaPerIlLotto({ quote: [{ fatturabile: true }, { fatturabile: false }] })).toBe(false)
  })

  it('falsa senza quote: nessuna quota non è «tutto a posto», è «non si sa a chi intestarla»', () => {
    // `Array.prototype.every` su un elenco vuoto risponde `true`: senza il
    // controllo sulla lunghezza, un pagamento senza quote entrerebbe nel lotto.
    expect(prontaPerIlLotto({ quote: [] })).toBe(false)
    expect(prontaPerIlLotto({ quote: null })).toBe(false)
    expect(prontaPerIlLotto({})).toBe(false)
    expect(prontaPerIlLotto(null)).toBe(false)
  })
})

describe('numeroInDubbio — «mi fermo?» e «il numero è in dubbio?» sono DUE domande', () => {
  it('il 502 di TRASPORTO è in dubbio, e a dirlo è il codice che il server dichiara', () => {
    expect(numeroInDubbio(502, CODICE_TRASPORTO_IGNOTO)).toBe(true)
    expect(numeroInDubbio(502, null)).toBe(true)
  })

  it('la risposta MAI ARRIVATA è il caso peggiore da leggere: in dubbio', () => {
    // Indistinguibile da «la POST è partita e ha emesso»: su un documento fiscale
    // l'ignoto si dichiara, non si arrotonda al caso migliore.
    expect(numeroInDubbio(0, null)).toBe(true)
  })

  it('un 503 FERMA il lotto ma non mette in dubbio nessun numero', () => {
    // I 503 di `src/lib/aruba/emissione.ts` (:473, :510, :530, :566, :583, :846,
    // :931 e la mappa :2062-2063) nascono TUTTI prima del `signin` — Aruba non
    // configurata, cedente incompleto, una lettura caduta — e ognuno di quei rami
    // lo scrive nel proprio messaggio: «nessun numero è stato consumato». È anche
    // l'esito più probabile del PRIMO lotto vero.
    expect(fermaIlLotto(503)).toBe(true)
    expect(numeroInDubbio(503, null)).toBe(false)
  })

  it('un 500 e un 429 fermano il lotto senza consumare niente', () => {
    // 500 = l'XML non composto (prima dell'upload) o il `catch` della rotta;
    // 429 = un tetto di frequenza NOSTRO, cioè una POST che ad Aruba non è mai
    // arrivata. Il 429 di Aruba, quello vero, esce 502 col codice di trasporto.
    expect(fermaIlLotto(500)).toBe(true)
    expect(fermaIlLotto(429)).toBe(true)
    expect(numeroInDubbio(500, null)).toBe(false)
    expect(numeroInDubbio(429, null)).toBe(false)
  })

  it('i rifiuti locali non fermano il lotto e non sono in dubbio', () => {
    for (const s of [400, 404, 409, 422]) {
      expect(fermaIlLotto(s)).toBe(false)
      expect(numeroInDubbio(s, null)).toBe(false)
    }
  })

  it('una riga riuscita non è mai «in dubbio»', () => {
    expect(numeroInDubbio(200, null)).toBe(false)
  })

  it('il predicato che FERMA resta più largo di quello che dubita', () => {
    // È il punto di tutto: «mi fermo?» va bene larga, «il numero è in dubbio?» no —
    // è un'affermazione che manda un operatore a cercare un documento sul pannello
    // Aruba, e su un 503 lì non c'è niente da trovare.
    const stati = [0, 400, 404, 409, 422, 429, 500, 502, 503]
    for (const s of stati) {
      if (numeroInDubbio(s, null)) expect(fermaIlLotto(s)).toBe(true)
    }
    expect(stati.filter((s) => fermaIlLotto(s)).length).toBeGreaterThan(
      stati.filter((s) => numeroInDubbio(s, null)).length,
    )
  })
})

/**
 * ─── QUANTO MANCA — la sola domanda che un'attesa di diciotto minuti pone ────
 *
 * MISURATO sullo screenshot del 2026-09-07: durante il lotto si leggeva soltanto
 * «Fattura 1/3 · invio in corso». Con dodici fatture il lotto dura **circa
 * diciotto minuti** (12 × 90 s, il ritmo del `signin` di Aruba): novanta secondi
 * di riga ferma si leggono come un blocco, e chi li legge così ricarica la pagina
 * — cioè fa la sola cosa che qui non si deve fare, perché perde di vista quali
 * documenti fiscali siano già partiti.
 *
 * La stima è START-TO-START, come tutto il resto di questo file: la riga in volo
 * non si conta (sta finendo), quelle dopo costano un intervallo ciascuna, e
 * l'attesa in corso si somma perché è tempo che deve ancora passare.
 */
describe('stimaRimanenteMs — quanto manca alla fine del lotto', () => {
  it('a lotto appena partito, con tre righe, mancano due intervalli', () => {
    // La prima è in volo: finirà in pochi secondi. Restano la seconda e la terza,
    // e fra una partenza e l'altra passano 90 s.
    expect(stimaRimanenteMs(0, 3, null)).toBe(2 * INTERVALLO_FRA_EMISSIONI_MS)
  })

  it('durante l’attesa, la pausa in corso si SOMMA agli intervalli che restano', () => {
    expect(stimaRimanenteMs(1, 3, 90_000)).toBe(90_000 + INTERVALLO_FRA_EMISSIONI_MS)
  })

  it('sull’ultima riga non resta nessun intervallo: solo la pausa che manca', () => {
    expect(stimaRimanenteMs(2, 3, PAUSA_DOPO_RIFIUTO_LOCALE_MS)).toBe(PAUSA_DOPO_RIFIUTO_LOCALE_MS)
    expect(stimaRimanenteMs(2, 3, null)).toBe(0)
  })

  it('a lotto finito — o oltre — la stima è zero, mai negativa', () => {
    expect(stimaRimanenteMs(3, 3, null)).toBe(0)
    expect(stimaRimanenteMs(5, 3, null)).toBe(0)
    expect(stimaRimanenteMs(0, 0, null)).toBe(0)
  })

  it('IL CONTO CHE HA FATTO NASCERE IL TETTO: dodici fatture ≈ diciotto minuti', () => {
    // Se un giorno l'intervallo o il tetto cambiassero, questa riga dice subito
    // quanto tempo si sta chiedendo a una segretaria davanti a una barra.
    const minuti = stimaRimanenteMs(0, TETTO_LOTTO, null) / 60_000
    expect(Math.round(minuti)).toBe(17)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La proposta del bonifico entra nel lotto: le stesse condizioni della singola,
// più le due guardie che la singola ottiene da un umano che guarda lo schermo.
// ─────────────────────────────────────────────────────────────────────────────
describe('prontaPerIlLotto — quando è la proposta a sbloccare la riga', () => {
  const conProposta = (over: Record<string, unknown> = {}) => ({
    quote: [{ fatturabile: false }],
    ripartito: false,
    candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria', fatturabile: true }],
    proposta: { adult_id: 'a-1', motivo: 'bonifico_esatto' },
    ordinante: 'ROSSI MARIA',
    ...over,
  })

  it('quote non fatturabili ma proposta usabile → pronta', () => {
    expect(prontaPerIlLotto(conProposta())).toBe(true)
  })

  it('quote vuote restano NON pronte, anche con una proposta', () => {
    // `every` su un elenco vuoto risponde `true`: il controllo di lunghezza non è
    // una ridondanza, e la proposta non deve diventare la scorciatoia che lo aggira
    expect(prontaPerIlLotto(conProposta({ quote: [] }))).toBe(false)
  })

  it('pagamento ripartito → non pronta, anche con la proposta', () => {
    expect(prontaPerIlLotto(conProposta({ ripartito: true }))).toBe(false)
  })

  it('proposto non fatturabile → non pronta: si eviterebbe di bruciare un colpo di quota', () => {
    expect(prontaPerIlLotto(conProposta({ candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria', fatturabile: false }] }))).toBe(false)
  })

  it('senza proposta il predicato è quello di prima', () => {
    expect(prontaPerIlLotto({ quote: [{ fatturabile: true }] })).toBe(true)
    expect(prontaPerIlLotto({ quote: [{ fatturabile: false }] })).toBe(false)
  })
})

describe('corpoEmissione — l’intestatario viaggia, la causale no', () => {
  it('senza intestatario il campo è ASSENTE, non `null`', () => {
    const c = corpoEmissione('p-1')
    expect(c).toEqual({ pagamento_id: 'p-1', causale: null })
    expect('intestatario' in c).toBe(false)
  })

  it('con intestatario porta solo il ramo `adult`', () => {
    expect(corpoEmissione('p-1', 'a-1')).toEqual({
      pagamento_id: 'p-1', causale: null, intestatario: { tipo: 'adult', adult_id: 'a-1' },
    })
  })

  it('`causale: null` resta in ENTRAMBI i casi: è ciò che toglie la correzione appiccicosa', () => {
    expect(corpoEmissione('p-1').causale).toBe(null)
    expect(corpoEmissione('p-1', 'a-1').causale).toBe(null)
  })
})
