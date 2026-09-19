import { describe, it, expect } from 'vitest'
import { riepilogoPosti } from '@/lib/avvisi/posti'

/**
 * ─── I POSTI SI CONTANO IN PERSONE ───────────────────────────────────────────
 *
 * Un pullman ha 50 sedili, non 50 famiglie. Il caso che questi test tengono rosso
 * è la riga SENZA `numero_partecipanti`, che vale **1** — gemello del
 * `COALESCE(numero_partecipanti, 1)` della funzione SQL `avviso_posti_occupati`.
 * Quella decide chi entra, questa mostra il totale: se divergono, la schermata
 * dice «22 su 50» mentre il database rifiuta la ventitreesima adesione, e nessuno
 * dei due test se ne accorge perché ciascuna metà, da sola, è coerente.
 */
describe('riepilogoPosti', () => {
  it('senza adesioni il riepilogo è tutto a zero', () => {
    expect(riepilogoPosti([], 50)).toEqual({
      persone: 0,
      famiglie: 0,
      inAttesa: 0,
      personeInAttesa: 0,
      sopraCapienza: false,
    })
  })

  it('🔑 una riga SENZA numero vale 1 — gemello del `COALESCE(numero_partecipanti, 1)`', () => {
    // `null` e campo assente sono la stessa cosa: l'avviso aveva il contatore
    // spento, ma quella famiglia porta comunque il suo bambino. Zero sarebbe
    // l'unico valore che rende il totale più piccolo del numero di adesioni.
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: null, parent_id: 'p1' },
        { stato_adesione: 'ammessa', parent_id: 'p2' },
        { stato_adesione: 'ammessa', numero_partecipanti: 3, parent_id: 'p3' },
      ],
      null,
    )
    expect(riep.persone).toBe(5) // 1 + 1 + 3
    expect(riep.famiglie).toBe(3)
  })

  it('un `numero_partecipanti` che non è un numero VERO vale comunque 1', () => {
    // `NaN` è un `number`: sommato una volta sola renderebbe `NaN` l'intero
    // riepilogo, cioè «50 posti su NaN» a schermo. È la famiglia di difetti del
    // `?? 0` che ha congelato per sempre lo stato SDI di una fattura.
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: Number.NaN, parent_id: 'p1' },
        { stato_adesione: 'ammessa', numero_partecipanti: Number.POSITIVE_INFINITY, parent_id: 'p2' },
      ],
      10,
    )
    expect(riep.persone).toBe(2)
    expect(Number.isFinite(riep.persone)).toBe(true)
  })

  it('solo `ammessa` occupa: la lista d\'attesa è contata a parte', () => {
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: 2, parent_id: 'p1' },
        { stato_adesione: 'in_attesa', numero_partecipanti: 4, parent_id: 'p2' },
        { stato_adesione: 'in_attesa', numero_partecipanti: null, parent_id: 'p3' },
      ],
      10,
    )
    expect(riep.persone).toBe(2)
    expect(riep.famiglie).toBe(1) // chi è in coda non è una famiglia «dentro»
    expect(riep.inAttesa).toBe(2) // due RIGHE in coda
    expect(riep.personeInAttesa).toBe(5) // 4 + 1: che cosa entrerebbe alzando il tetto
  })

  it('è una LISTA BIANCA: uno stato sconosciuto non occupa e non va in coda', () => {
    // `=== 'ammessa'` e non `!== 'in_attesa'`. Il giorno in cui arriva un terzo
    // stato (`annullata`), con la lista nera il tetto si riempirebbe di righe che
    // nessuno conta più.
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: 2, parent_id: 'p1' },
        { stato_adesione: 'annullata', numero_partecipanti: 9, parent_id: 'p2' },
        { stato_adesione: null, numero_partecipanti: 9, parent_id: 'p3' },
      ],
      10,
    )
    expect(riep.persone).toBe(2)
    expect(riep.inAttesa).toBe(0)
    expect(riep.personeInAttesa).toBe(0)
  })

  it('🔑 `famiglie` distingue i FRATELLI: lo stesso genitore due volte è una famiglia sola', () => {
    // Una famiglia con due figli nello stesso avviso dichiara lo stesso
    // accompagnatore due volte: il totale in persone dice 4 dove le teste sono 3.
    // È voluto (un pullman pieno al 110% è un bambino a terra), ma la segreteria
    // deve poter leggere quanto il totale sia gonfio.
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: 2, parent_id: 'p1' },
        { stato_adesione: 'ammessa', numero_partecipanti: 2, parent_id: 'p1' },
        { stato_adesione: 'ammessa', numero_partecipanti: 1, parent_id: 'p2' },
      ],
      null,
    )
    expect(riep.persone).toBe(5)
    expect(riep.famiglie).toBe(2)
  })

  it('le righe senza `parent_id` restano famiglie DISTINTE', () => {
    // Sommarle in una voce sola farebbe sparire famiglie vere dal conteggio — un
    // numero troppo BASSO, che è il verso pericoloso: farebbe credere che il
    // gonfiore dei fratelli sia maggiore di quello che è.
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: 1 },
        { stato_adesione: 'ammessa', numero_partecipanti: 1 },
        { stato_adesione: 'ammessa', numero_partecipanti: 1, parent_id: null },
      ],
      null,
    )
    expect(riep.famiglie).toBe(3)
    expect(riep.persone).toBe(3)
  })

  it('`sopraCapienza` è stretto: pieno esatto non è sopra', () => {
    const righe = [
      { stato_adesione: 'ammessa', numero_partecipanti: 25, parent_id: 'p1' },
      { stato_adesione: 'ammessa', numero_partecipanti: 25, parent_id: 'p2' },
    ]
    expect(riepilogoPosti(righe, 50).sopraCapienza).toBe(false)
    expect(riepilogoPosti(righe, 49).sopraCapienza).toBe(true)
  })

  it('⚠️ SOPRA CAPIENZA È CONSENTITO: il tetto si può abbassare sotto l\'occupato', () => {
    // Il pullman grande non è disponibile, restano 30 posti invece di 50: nessuno
    // viene espulso da un'adesione già confermata per un campo modificato in un
    // modulo. Questa funzione RIPORTA lo stato, non lo rifiuta — il numero serve
    // alla segreteria per sapere quante telefonate deve fare.
    const riep = riepilogoPosti(
      [
        { stato_adesione: 'ammessa', numero_partecipanti: 20, parent_id: 'p1' },
        { stato_adesione: 'ammessa', numero_partecipanti: 22, parent_id: 'p2' },
      ],
      30,
    )
    expect(riep.persone).toBe(42)
    expect(riep.sopraCapienza).toBe(true)
  })

  it('`postiTotali` nullo o assente significa NESSUN tetto, non zero posti', () => {
    // È il caso della gran parte degli avvisi. Uno `0` trattato come tetto
    // metterebbe ogni adesione sopra capienza.
    const righe = [{ stato_adesione: 'ammessa', numero_partecipanti: 99, parent_id: 'p1' }]
    expect(riepilogoPosti(righe, null).sopraCapienza).toBe(false)
    expect(riepilogoPosti(righe, undefined).sopraCapienza).toBe(false)
  })
})
