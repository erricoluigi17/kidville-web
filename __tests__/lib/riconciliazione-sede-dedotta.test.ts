import { describe, it, expect } from 'vitest'
import { sedeDedotta, agganciaFuoriSede } from '@/lib/pagamenti/riconciliazione'

// `sedeDedotta` è la sorella di `agganciaFuoriSede`: stessa regola, stesse soglie
// (60 di punteggio, 20 di distacco), partizione diversa. Qui si collauda che dica
// la verità — e soprattutto che TACCIA quando la verità non c'è.

const GIU = 'giu-0000-0000-0000-000000000001'
const CESA = 'cesa-000-0000-0000-000000000002'
const AVE = 'ave-0000-0000-0000-000000000003'

const cand = (pid: string, score: number, cf = false) => ({ pagamento_id: pid, score, cf_match: cf })
const sedi = (m: Record<string, string | null>) => (pid: string) => m[pid] ?? null

describe('sedeDedotta — quando si può dire di quale sede è', () => {
  it('un candidato solo, sopra soglia → quella sede', () => {
    expect(sedeDedotta([cand('p1', 75)], sedi({ p1: CESA }))).toEqual({ scuola_id: CESA, certa: false })
  })

  it('sotto soglia → null: 50 punti non bastano a nominare un plesso', () => {
    expect(sedeDedotta([cand('p1', 50)], sedi({ p1: CESA }))).toBe(null)
  })

  it('un codice fiscale decide, e lo dichiara `certa`', () => {
    expect(sedeDedotta([cand('p1', 1050, true), cand('p2', 90)], sedi({ p1: GIU, p2: CESA })))
      .toEqual({ scuola_id: GIU, certa: true })
  })

  it('distacco insufficiente fra due sedi → null', () => {
    // 90 contro 75 fa 15: meno dei 20 richiesti. Nominare Cesa qui sarebbe una
    // bugia detta con sicurezza.
    expect(sedeDedotta([cand('p1', 90), cand('p2', 75)], sedi({ p1: CESA, p2: AVE }))).toBe(null)
  })

  it('pareggio esatto fra due sedi → null (9 righe su 219, in produzione)', () => {
    expect(sedeDedotta([cand('p1', 80), cand('p2', 80)], sedi({ p1: CESA, p2: AVE }))).toBe(null)
  })

  it('due candidati della STESSA sede si sommano nel verdetto, non si annullano', () => {
    // partizionando per sede, entrambi stanno in `fuori`: nessuno dei due è il
    // «dentro» dell'altro
    expect(sedeDedotta([cand('p1', 90), cand('p2', 85)], sedi({ p1: CESA, p2: CESA })))
      .toEqual({ scuola_id: CESA, certa: false })
  })

  it('due codici fiscali di sedi diverse → null, senza un caso speciale', () => {
    expect(sedeDedotta([cand('p1', 1050, true), cand('p2', 1040, true)], sedi({ p1: GIU, p2: CESA }))).toBe(null)
  })

  it('candidati senza sede risolta non pesano da nessuna parte', () => {
    expect(sedeDedotta([cand('p1', 75), cand('p2', 90)], sedi({ p1: CESA, p2: null })))
      .toEqual({ scuola_id: CESA, certa: false })
  })

  it('nessun suggerimento → null', () => {
    expect(sedeDedotta([], sedi({}))).toBe(null)
  })
})

describe('le due sorelle non si contraddicono', () => {
  const ATTIVE = new Set([GIU])

  it("il ribaltamento del `cf_match` DENTRO: per `altra_sede` è null, per la sede dedotta è casa", () => {
    // È il caso che il piano segnalava come il più facile da sbagliare.
    const sugg = [cand('p1', 1050, true), cand('p2', 90)]
    const m = sedi({ p1: GIU, p2: CESA })
    expect(agganciaFuoriSede(sugg, m, ATTIVE)).toBe(null)          // non è di un'altra sede
    expect(sedeDedotta(sugg, m)).toEqual({ scuola_id: GIU, certa: true })  // ...è di casa
  })

  it('quando `altra_sede` nomina un plesso, la sede dedotta nomina lo stesso', () => {
    const sugg = [cand('p1', 95)]
    const m = sedi({ p1: CESA })
    expect(agganciaFuoriSede(sugg, m, ATTIVE)?.scuola_id).toBe(CESA)
    expect(sedeDedotta(sugg, m)?.scuola_id).toBe(CESA)
  })

  it('due candidati forti in DUE sedi diverse: «non è tua» resta vero, «di quale» no', () => {
    // Il caso che separa le due domande, e va scritto perché sembra una
    // contraddizione e non lo è. Da Giugliano, con i due candidati entrambi
    // altrove, `agganciaFuoriSede` risponde correttamente «questo bonifico non è
    // tuo» — è un verdetto BINARIO, e il nome del plesso è un di più che serve al
    // testo dell'avviso. `sedeDedotta` invece quel nome lo userebbe come CHIAVE DI
    // UN BIDONE del filtro: 90 contro 85 non basta a decidere in quale, e sceglierne
    // uno farebbe sparire la riga dalla vista dell'altra sede.
    const sugg = [cand('p1', 90), cand('p2', 85)]
    const m = sedi({ p1: CESA, p2: AVE })
    expect(agganciaFuoriSede(sugg, m, ATTIVE)?.scuola_id).toBe(CESA)
    expect(sedeDedotta(sugg, m)).toBe(null)
  })

  it('e infatti dalla sede vincente il verdetto binario è lo stesso', () => {
    const sugg = [cand('p1', 90), cand('p2', 85)]
    const m = sedi({ p1: CESA, p2: AVE })
    // per un operatore di Cesa il bonifico NON è di un'altra sede...
    expect(agganciaFuoriSede(sugg, m, new Set([CESA]))).toBe(null)
    // ...ma nemmeno lì l'app sa dire con certezza di quale sia
    expect(sedeDedotta(sugg, m)).toBe(null)
  })
})
