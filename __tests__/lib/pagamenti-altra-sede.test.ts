import { describe, it, expect } from 'vitest'
import {
  agganciaFuoriSede,
  suggerisciMatch,
  SOGLIA_AGGANCIO,
  DISTACCO_AGGANCIO,
  type CandidatoSede,
} from '@/lib/pagamenti/riconciliazione'

/**
 * ─── «QUESTO BONIFICO SEMBRA DI UN'ALTRA SEDE» ───────────────────────────────
 *
 * L'estratto conto della banca è UNO e i suggerimenti si calcolano contro i
 * pagamenti aperti di TUTTE le sedi (deliberato). Ma poi la schermata mostra a
 * ogni segreteria solo i candidati della PROPRIA sede: se l'aggancio forte è a
 * Cesa e a Giugliano restano tre candidati deboli, la riga invita a un
 * abbinamento sbagliato — e l'incasso finisce sulla voce di un altro bambino.
 *
 * Qui si collauda il VERDETTO puro, che è la sola parte che decide. Non fa I/O:
 * riceve i candidati, una funzione che dice la sede di un pagamento e l'insieme
 * delle sedi attive dell'operatore.
 */

const GIU = 'sc-giugliano'
const CESA = 'sc-cesa'
const AVE = 'sc-aversa'

/** Le sedi dell'operatore: Giugliano. */
const ATTIVE: ReadonlySet<string> = new Set([GIU])

/** La mappa `pagamento → sede` come la costruisce la rotta da `pagamenti(id, scuola_id)`. */
const sedi = (m: Record<string, string | null | undefined>) => (id: string) => m[id]

const cand = (pagamento_id: string, score: number, cf_match = false): CandidatoSede =>
  cf_match ? { pagamento_id, score, cf_match: true } : { pagamento_id, score }

describe('SOGLIA_AGGANCIO / DISTACCO_AGGANCIO — le due soglie hanno un nome', () => {
  it('valgono 60 e 20: sono i numeri che erano cablati dentro `suggerisciMatch`', () => {
    expect(SOGLIA_AGGANCIO).toBe(60)
    expect(DISTACCO_AGGANCIO).toBe(20)
  })

  /**
   * Le costanti non sono decorazione: se un giorno qualcuno le cambiasse senza
   * accorgersi che le legge anche il matcher, questi due casi lo direbbero. Il
   * movimento vale esattamente il residuo (+50) e cita nome e periodo (+25 +15) →
   * 90, contro un secondo candidato al solo importo esatto (50): distacco 40.
   */
  it('il matcher le USA davvero: sopra soglia e con distacco → «suggerito»', () => {
    const esito = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'RETTA SETTEMBRE GIULIA FABBRI', controparte: '' },
      [
        { id: 'p1', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_nome: 'Giulia Fabbri' },
        { id: 'p2', importo: 150, importo_pagato: 0 },
      ],
    )
    expect(esito.suggerimenti[0].score).toBeGreaterThanOrEqual(SOGLIA_AGGANCIO)
    expect(esito.suggerimenti[0].score - esito.suggerimenti[1].score).toBeGreaterThanOrEqual(DISTACCO_AGGANCIO)
    expect(esito.stato).toBe('suggerito')
  })

  it('…e sotto il distacco resta «da abbinare» (due candidati a pari punteggio)', () => {
    const esito = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO', controparte: '' },
      [
        { id: 'p1', importo: 150, importo_pagato: 0 },
        { id: 'p2', importo: 150, importo_pagato: 0 },
      ],
    )
    expect(esito.suggerimenti[0].score - esito.suggerimenti[1].score).toBeLessThan(DISTACCO_AGGANCIO)
    expect(esito.stato).toBe('da_abbinare')
  })
})

describe('agganciaFuoriSede — la tabella dei casi', () => {
  it('CF su un’altra sede → SÌ, per codice fiscale, e nomina QUELLA sede', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 1050, true), cand('p-giu', 50)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toEqual({ scuola_id: CESA, per_cf: true })
  })

  it('due CF fuori sede → vince quello col punteggio più alto', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 1050, true), cand('p-ave', 1075, true)],
      sedi({ 'p-cesa': CESA, 'p-ave': AVE }),
      ATTIVE,
    )
    expect(v).toEqual({ scuola_id: AVE, per_cf: true })
  })

  it('CF nella PROPRIA sede → NO: l’aggancio forte ce l’ha l’operatore', () => {
    const v = agganciaFuoriSede(
      [cand('p-giu', 1050, true), cand('p-cesa', 50)],
      sedi({ 'p-giu': GIU, 'p-cesa': CESA }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  /**
   * ⚠️ IL BONIFICO DI FAMIGLIA CON I FRATELLI IN DUE PLESSI — un CF dentro e un
   * CF fuori. Dire «i suggerimenti qui sotto sono deboli» sarebbe FALSO: quello
   * di casa è l'aggancio più forte che esista, ed è proprio la riga da cui si
   * apre l'«Incasso unico» (`movimentoMultiCf`).
   *
   * ⚠️ A DIRE NO È LA GUARDIA SU `cfDentro`, NON IL DISTACCO — e per due giri qui
   * c'era scritto il contrario («due punteggi CF quasi pari, distacco ~0»). Non
   * lo sono: un `cf_match` vale `CF_BONUS` (1000) **più** i segnali deboli, che
   * arrivano a 100. Il solo «importo esatto» su un lato ne fa 50, cioè più del
   * distacco richiesto. Il caso qui sotto, a 1050 contro 1050, non distingue le
   * due spiegazioni: resta verde anche senza la guardia. Quello dopo sì.
   */
  it('un CF dentro E un CF fuori (fratelli in due sedi) → NO', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 1050, true), cand('p-giu', 1050, true)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  /**
   * ⚠️ IL CASO CHE SEPARA LA GUARDIA DAL DISTACCO, ed è quello vero: i due
   * fratelli hanno due quote di importo diverso, e solo quella di Cesa vale
   * esattamente il bonifico (+50 «importo esatto»). Due `cf_match`, distacco 50,
   * ben sopra i 20 richiesti: senza la guardia il verdetto scatterebbe e la
   * schermata direbbe «i suggerimenti qui sotto sono deboli» sopra un aggancio
   * per codice fiscale. Un CF nella propria sede non si declassa MAI.
   */
  it('CF dentro contro CF fuori più alto (distacco 50) → NO lo stesso: il CF di casa non si declassa', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 1050, true), cand('p-giu', 1000, true)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  /**
   * …e la guardia vale anche quando il CF di casa è l'unico segnale che ha: il
   * punteggio del CF fuori sede è più alto di 75, il distacco è enorme, e non
   * cambia niente. È la stessa proprietà, vista dall'altro capo.
   */
  it('CF dentro «nudo» contro CF fuori con tutti i segnali deboli → NO', () => {
    const v = agganciaFuoriSede(
      [cand('p-ave', 1100, true), cand('p-giu', 1000, true), cand('p-cesa', 90)],
      sedi({ 'p-ave': AVE, 'p-giu': GIU, 'p-cesa': CESA }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  it('100 fuori contro 50 dentro → SÌ (sopra soglia, distacco 50)', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 100), cand('p-giu', 50)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toEqual({ scuola_id: CESA, per_cf: false })
  })

  it('70 fuori contro 60 dentro → NO: il distacco è 10, sotto i 20 richiesti', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 70), cand('p-giu', 60)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  /**
   * ⚠️ IL CONFINE DEL DISTACCO, ESATTO — il gemello del caso «60 fuori e niente
   * dentro» qui sotto, che copre l'altra soglia. Senza questo, `>=` e `>` sono
   * indistinguibili su `DISTACCO_AGGANCIO`: la mutazione lasciava verdi tutti i
   * 367 test del perimetro, e per quel ramo il collaudo era decorazione. Le due
   * soglie hanno lo stesso nome e lo stesso peso: hanno anche lo stesso collaudo.
   */
  it('80 fuori contro 60 dentro → SÌ: il distacco vale ESATTAMENTE 20, e la soglia è inclusiva', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 60 + DISTACCO_AGGANCIO), cand('p-giu', 60)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toEqual({ scuola_id: CESA, per_cf: false })
  })

  it('79 fuori contro 60 dentro → NO: un punto sotto il confine e il verdetto si spegne', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 59 + DISTACCO_AGGANCIO), cand('p-giu', 60)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  /**
   * ⚠️ QUI STA LA DECISIONE, e non è un caso limite qualsiasi: `bestDentro` vale
   * ZERO quando la propria sede non ha nessun candidato, MAI «verdetto
   * automatico». Un bonifico con un solo candidato debole altrove non è «di
   * un'altra sede»: è un bonifico che nessuno ha capito, e dirlo sarebbe una
   * bugia detta con sicurezza.
   */
  it('50 fuori e NIENTE dentro → NO: sotto soglia, e «nessuno l’ha capito» non è «è di Cesa»', () => {
    const v = agganciaFuoriSede([cand('p-cesa', 50)], sedi({ 'p-cesa': CESA }), ATTIVE)
    expect(v).toBeNull()
  })

  it('60 fuori e niente dentro → SÌ: la soglia è inclusiva, e il distacco da 0 è 60', () => {
    const v = agganciaFuoriSede([cand('p-cesa', SOGLIA_AGGANCIO)], sedi({ 'p-cesa': CESA }), ATTIVE)
    expect(v).toEqual({ scuola_id: CESA, per_cf: false })
  })

  it('sede NULL (pagamento mai letto o sparito) → NO, e non accusa nessun plesso', () => {
    const v = agganciaFuoriSede([cand('p-ignoto', 100)], sedi({ 'p-ignoto': null }), ATTIVE)
    expect(v).toBeNull()
  })

  it('sede UNDEFINED (id non nella mappa) → NO, stesso trattamento', () => {
    const v = agganciaFuoriSede([cand('p-sparito', 100)], sedi({}), ATTIVE)
    expect(v).toBeNull()
  })

  /**
   * Gli ignoti non contano DA NESSUNA PARTE: non fanno alzare `bestDentro` (che
   * spegnerebbe un verdetto vero) e non diventano un «fuori» (che accuserebbe un
   * plesso a caso). Qui l'ignoto ha il punteggio più alto di tutti e non sposta
   * niente: il verdetto resta quello dei due candidati con la sede risolta.
   */
  it('un ignoto con punteggio altissimo non entra né in «dentro» né in «fuori»', () => {
    const v = agganciaFuoriSede(
      [cand('p-ignoto', 900), cand('p-cesa', 100), cand('p-giu', 50)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      ATTIVE,
    )
    expect(v).toEqual({ scuola_id: CESA, per_cf: false })
  })

  it('lista VUOTA → NO', () => {
    expect(agganciaFuoriSede([], sedi({}), ATTIVE)).toBeNull()
  })

  it('tutti i candidati sono della propria sede → NO (non c’è nessun «fuori»)', () => {
    const v = agganciaFuoriSede(
      [cand('p-giu', 100), cand('p-giu2', 20)],
      sedi({ 'p-giu': GIU, 'p-giu2': GIU }),
      ATTIVE,
    )
    expect(v).toBeNull()
  })

  it('operatore multi-sede: Cesa è fra le sue → NO, è «dentro»', () => {
    const v = agganciaFuoriSede(
      [cand('p-cesa', 100), cand('p-giu', 50)],
      sedi({ 'p-cesa': CESA, 'p-giu': GIU }),
      new Set([GIU, CESA]),
    )
    expect(v).toBeNull()
  })

  /**
   * ⚠️ IL CASO DI BORDO CHE SEMBRA UN BUG E NON LO È — vale la pena vederlo
   * scritto come test, perché è quello che qualcuno segnalerà.
   *
   * I suggerimenti si calcolano ALL'IMPORT e si cappano a 3 non-CF: se i primi
   * tre sono tutti di Cesa, il candidato di Giugliano non è MAI stato salvato.
   * `bestDentro` vale 0 e il verdetto scatta. È voluto: la schermata non ha
   * nessun candidato locale da proporre, e proprio per questo l'unica cosa vera
   * da dire è che il bonifico sembra di un altro plesso.
   */
  it('i primi 3 tutti fuori sede (cap all’import): nessun «dentro», verdetto SÌ', () => {
    const v = agganciaFuoriSede(
      [cand('p-c1', 90), cand('p-c2', 75), cand('p-c3', 65)],
      sedi({ 'p-c1': CESA, 'p-c2': CESA, 'p-c3': AVE }),
      ATTIVE,
    )
    expect(v).toEqual({ scuola_id: CESA, per_cf: false })
  })
})
