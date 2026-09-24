// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  TETTO_LOTTO,
  TETTO_BLOCCO,
  PAUSA_FRA_UPLOAD_MS,
  RISERVA_PEGGIORE_MS,
  BUDGET_BLOCCO_MS,
  LAVORO_UTILE_MS,
  MARGINE_PIATTAFORMA_MS,
  MAX_DURATION_BLOCCO_S,
  prontaPerIlLotto,
  quoteTutteFatturabili,
  fermaIlLotto,
} from '@/lib/pagamenti/lotto-fatture'

/**
 * IL MOTORE DEL LOTTO — puro, in ambiente `node`, senza React né `next-intl`.
 *
 * Qui non si collauda una schermata: si collaudano le tre decisioni del lotto —
 * le costanti del ritmo, `fermaIlLotto` (quando il blocco del lavoratore della coda
 * si ferma) e `prontaPerIlLotto` (quali righe entrano in coda con un gesto).
 * `corpoEmissione`, il corpo della vecchia POST del lotto nel browser, è stato tolto
 * nella consegna 2b (D9): lo tiene fuori l'ultimo `describe` di questo file.
 */

describe('le costanti del ritmo', () => {
  it('dentro un blocco il ritmo degli upload sta sotto i 30 al minuto dichiarati', () => {
    expect(60_000 / PAUSA_FRA_UPLOAD_MS).toBeLessThanOrEqual(30)
  })

  it('IL BUDGET RISERVA IL COSTO PEGGIORE DI UNA FATTURA, non la media', () => {
    // È la differenza che decide se un'invocazione muore col numero già allocato.
    // Il ritentativo dopo un 429 è un `await` di 90 s che vive dentro `arubaUpload`:
    // una riserva sui ~3 secondi medi lascerebbe partire una fattura con sessanta
    // secondi di margine, e quella finirebbe oltre il muro dei 300.
    expect(RISERVA_PEGGIORE_MS).toBeGreaterThanOrEqual(90_000)
    expect(BUDGET_BLOCCO_MS).toBe(MAX_DURATION_BLOCCO_S * 1_000 - MARGINE_PIATTAFORMA_MS)
    // ⚠️ LA RISERVA NON VA SOTTRATTA DAL BUDGET: la guardia la somma al tempo trascorso
    // ogni volta che decide. Toglierla anche da qui la conterebbe due volte, e la
    // guardia scatterebbe PRIMA della prima fattura — un blocco che non emette mai
    // niente. È il difetto che il test della route ha trovato appena scritto.
    expect(LAVORO_UTILE_MS).toBeGreaterThan(0)
  })

  it('un blocco pieno sta LARGO dentro il budget', () => {
    // Se un giorno il tetto del blocco salisse oltre ciò che il budget regge, la
    // guardia di tempo troncherebbe sempre l'ultima parte del blocco — e il lotto
    // sembrerebbe rotto proprio quando sta lavorando bene.
    // Quindici upload a `PAUSA_FRA_UPLOAD_MS`, più accesso e lettura del pavimento (~10 s):
    // il blocco del lavoratore della coda deve starci largo.
    expect(TETTO_BLOCCO * PAUSA_FRA_UPLOAD_MS + 10_000).toBeLessThan(LAVORO_UTILE_MS)
  })

  it('il tetto della SELEZIONE e quello del BLOCCO sono due numeri diversi', () => {
    // ⚠️ Fino al 2026-09-07 erano lo stesso, e il nome `TETTO_LOTTO` significava
    // entrambe le cose. Adesso: quante se ne mettono in coda con un gesto (500 dal
    // 2026-09-23, quanto la POST della coda accetta — prima era 50, la soglia oraria,
    // perché il lotto partiva dal browser) e quante ne parte alla volta (15, ciò che
    // entra nel budget di un'invocazione del lavoratore). Confonderli ridurrebbe la
    // selezione o farebbe partire blocchi che non stanno nei 300 secondi.
    expect(TETTO_LOTTO).toBeGreaterThan(TETTO_BLOCCO)
    expect(TETTO_LOTTO).toBe(500)
    expect(TETTO_BLOCCO).toBe(15)
  })
})

describe('fermaIlLotto — quando NON si prova la riga successiva', () => {
  it('vero su 502, 503, 504, 500, 429 e 0 (la risposta non è arrivata affatto)', () => {
    for (const stato of [502, 503, 504, 500, 429, 0]) {
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

  it('quote VUOTE + proposta usabile → PRONTA: è il caso in cui la proposta serve di più', () => {
    // Zero quote significa «l'anagrafica non dice a chi intestare»
    // (`determinaQuoteFatturazione`, passo 5). Misurato in Conciliazione il 2026-09-08:
    // la MAGGIORANZA delle righe selezionabili sta così, e per quasi tutte l'ordinante
    // del bonifico nomina UN solo genitore, coi dati fiscali completi. I conteggi esatti
    // stanno in `lotto-fatture.ts` con l'ora accanto — e invecchiano in mezz'ora.
    //
    // Il server è già pronto ad accettarle: `applicaIntestatarioScelto` su zero quote
    // ne crea UNA con l'intestatario scelto e il totale, e sta PRIMA del 422 — è
    // esattamente ciò che fa funzionare l'emissione singola. A scartarle era solo
    // questo predicato, che diceva «manca l'intestatario» sapendo chi era.
    expect(prontaPerIlLotto(conProposta({ quote: [] }))).toBe(true)
  })

  it('quote vuote SENZA proposta restano non pronte: è il motivo per cui il controllo di lunghezza esiste', () => {
    // `[].every()` risponde `true`. Il controllo non è sparito: si è spostato DENTRO
    // il primo ramo, che è l'unico a cui serviva. Se sparisse davvero, un pagamento
    // di cui non si sa nulla passerebbe come «pronto» e brucerebbe un colpo di quota.
    expect(prontaPerIlLotto({ quote: [] })).toBe(false)
    expect(prontaPerIlLotto({})).toBe(false)
    expect(prontaPerIlLotto(null)).toBe(false)
  })

  it('quoteTutteFatturabili: l’elenco vuoto NON è «tutte fatturabili»', () => {
    // Il predicato esiste per essere scritto una volta sola: `prontaPerIlLotto` e il
    // pannello (che decide se spedire l'intestatario proposto) devono rispondere alla
    // stessa domanda con le stesse parole. Erano due copie, e la seconda sbagliava.
    expect(quoteTutteFatturabili([])).toBe(false)
    expect(quoteTutteFatturabili(null)).toBe(false)
    expect(quoteTutteFatturabili(undefined)).toBe(false)
    expect(quoteTutteFatturabili([{ fatturabile: true }])).toBe(true)
    expect(quoteTutteFatturabili([{ fatturabile: true }, { fatturabile: false }])).toBe(false)
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

describe('gli export del motore del lotto — l’insieme ESATTO (consegna 2b, D9)', () => {
  // Fragile di proposito: un export nuovo e legittimo si aggiunge QUI a mano, dopo averlo deciso.
  // Allargare l'elenco in automatico farebbe tornare il codice morto senza rumore.
  it('nessun export in più: `corpoEmissione`, morto dal nucleo della coda, non torna', async () => {
    const modulo = await import('@/lib/pagamenti/lotto-fatture')
    expect(Object.keys(modulo).sort()).toEqual([
      'BUDGET_BLOCCO_MS', 'LAVORO_UTILE_MS', 'MARGINE_PIATTAFORMA_MS', 'MAX_DURATION_BLOCCO_S',
      'PAUSA_FRA_UPLOAD_MS', 'RISERVA_PEGGIORE_MS', 'TETTO_BLOCCO', 'TETTO_LOTTO',
      'fermaIlLotto', 'prontaPerIlLotto', 'quoteTutteFatturabili',
    ])
  })
  it('nemmeno come tipo: lo verifica `tsc --noEmit`, non vitest', () => {
    // @ts-expect-error — `CorpoEmissione` è stato tolto nella consegna 2b (D9): se torna esportato, questa direttiva resta inutilizzata e il gate `tsc` diventa rosso.
    const morto: import('@/lib/pagamenti/lotto-fatture').CorpoEmissione | undefined = undefined
    expect(morto).toBeUndefined()
  })
})
