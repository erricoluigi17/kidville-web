// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  TETTO_LOTTO,
  TETTO_BLOCCO,
  ATTESA_FRA_BLOCCHI_MS,
  DURATA_BLOCCO_STIMATA_MS,
  PAUSA_FRA_UPLOAD_MS,
  RISERVA_PEGGIORE_MS,
  BUDGET_BLOCCO_MS,
  LAVORO_UTILE_MS,
  MARGINE_PIATTAFORMA_MS,
  MAX_DURATION_BLOCCO_S,
  PAUSA_DOPO_RIFIUTO_LOCALE_MS,
  prontaPerIlLotto,
  corpoEmissione,
  pausaDopo,
  pausaDopoBlocco,
  bloccoHaToccatoAruba,
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
  it('l’attesa fra blocchi è 65 s e non 60: il limite del `signin` è 60, e un limite non è un margine', () => {
    // ⚠️ Il 2026-09-07 un `signin` ha preso 429 con NOVANTA secondi di intervallo,
    // perché il cron `fattura-sync` fa il suo accesso per conto proprio e ruba lo
    // slot del minuto. Cinque secondi sono il minimo onesto, non l'abbondanza.
    expect(ATTESA_FRA_BLOCCHI_MS).toBeGreaterThan(60_000)
    expect(PAUSA_DOPO_RIFIUTO_LOCALE_MS).toBe(5_000)
  })

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
    expect(DURATA_BLOCCO_STIMATA_MS).toBeLessThan(LAVORO_UTILE_MS)
  })

  it('il tetto della SELEZIONE e quello del BLOCCO sono due numeri diversi', () => {
    // ⚠️ Fino al 2026-09-07 erano lo stesso, e il nome `TETTO_LOTTO` significava
    // entrambe le cose. Adesso: quante se ne mettono in coda (50, la soglia oraria
    // che l'app si dà su Aruba) e quante ne parte alla volta (15, ciò che entra nel
    // budget di un'invocazione). Confonderli dimezzerebbe la selezione o farebbe
    // partire blocchi che non stanno nei 300 secondi.
    expect(TETTO_LOTTO).toBeGreaterThan(TETTO_BLOCCO)
    expect(TETTO_LOTTO).toBe(50)
    expect(TETTO_BLOCCO).toBe(15)
  })
})

describe('pausaDopo — il ritmo si misura DA INIZIO A INIZIO', () => {
  it('un blocco da 40 s lascia 25 s di attesa', () => {
    expect(pausaDopo(200, 40_000)).toBe(ATTESA_FRA_BLOCCHI_MS - 40_000)
  })

  it('un blocco più lungo dell’attesa non fa aspettare niente (mai negativo)', () => {
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
  it('tre righe stanno in UN blocco: costano un blocco, non tre intervalli', () => {
    // ⚠️ È la riscrittura, non un riallineamento. Con la vecchia formula «una
    // fattura, un intervallo» tre righe avrebbero risposto due attese fra blocchi —
    // più di due minuti per un blocco che ne dura quaranta secondi.
    expect(stimaRimanenteMs(0, 3, null)).toBe(DURATA_BLOCCO_STIMATA_MS)
  })

  it('durante l’attesa, la pausa in corso si SOMMA a quel che resta', () => {
    expect(stimaRimanenteMs(TETTO_BLOCCO, TETTO_BLOCCO + 3, ATTESA_FRA_BLOCCHI_MS)).toBe(
      ATTESA_FRA_BLOCCHI_MS + DURATA_BLOCCO_STIMATA_MS,
    )
  })

  it('due blocchi costano due blocchi PIÙ una attesa: le attese sono una in meno', () => {
    expect(stimaRimanenteMs(0, TETTO_BLOCCO + 1, null)).toBe(
      2 * DURATA_BLOCCO_STIMATA_MS + ATTESA_FRA_BLOCCHI_MS,
    )
  })

  it('un rifiuto locale si distingue: la pausa in corso è di 5 s, non di un’attesa fra blocchi', () => {
    expect(stimaRimanenteMs(0, 3, PAUSA_DOPO_RIFIUTO_LOCALE_MS)).toBe(
      PAUSA_DOPO_RIFIUTO_LOCALE_MS + DURATA_BLOCCO_STIMATA_MS,
    )
  })

  it('a lotto finito — o oltre — la stima è zero, mai negativa', () => {
    expect(stimaRimanenteMs(3, 3, null)).toBe(0)
    expect(stimaRimanenteMs(5, 3, null)).toBe(0)
    expect(stimaRimanenteMs(0, 0, null)).toBe(0)
  })

  it('IL CONTO CHE GIUSTIFICA IL LAVORO: sessanta fatture ≈ sei minuti, non ottantasette', () => {
    // Prima: cinque lotti da dodici a novanta secondi per riga ≈ 87 minuti di
    // scheda presidiata. Adesso: quattro blocchi. Se un giorno queste costanti
    // cambiassero, questa riga dice subito quanto tempo si sta chiedendo a una
    // persona davanti a una barra.
    const minuti = stimaRimanenteMs(0, 60, null) / 60_000
    expect(Math.round(minuti)).toBe(6)
  })
})

describe('il 504 di piattaforma è un numero in DUBBIO, non una riga saltata', () => {
  /**
   * ─── PERCHÉ ARRIVA ADESSO ────────────────────────────────────────────────────────
   * Finché il ciclo girava nel browser, una POST per fattura, il 504 non si presentava:
   * l'emissione singola dura ~44 secondi su un `maxDuration` di 300. Col ciclo sul
   * server e un budget di tempo, l'invocazione troncata dalla piattaforma diventa il
   * modo PREVISTO di fallire — e fino a quindici documenti possono essere partiti senza
   * che nessuna risposta lo dica.
   *
   * ⚠️ Oggi il pannello si salva PER CASO: Vercel manda il 504 con un corpo HTML,
   * `res.json()` lancia, il `catch` mette `stato = 0` e `numeroInDubbio(0)` è vero. È un
   * salvataggio accidentale, non una regola: chiunque riscrivesse quel ciclo con un
   * ragionevole `res.json().catch(() => null)` riporterebbe il 504 in superficie con
   * `dubbio = false`, e la riga verrebbe etichettata «saltata» — che questo file
   * definisce come *un'AFFERMAZIONE: per questa riga non è successo niente*.
   *
   * Una affermazione falsa su un documento fiscale vale più di una riga ritentata: il
   * 504 entra fra i dubbi.
   */
  it('504 → il numero è in dubbio', () => {
    expect(numeroInDubbio(504)).toBe(true)
  })

  it('e ferma il lotto, come ogni 5xx', () => {
    expect(fermaIlLotto(504)).toBe(true)
  })

  it('il 503 resta FUORI dai dubbi: nasce prima del signin e lo dice nel messaggio', () => {
    // La distinzione che il 2026-09-07 ha stretto: sbagliare per eccesso qui manda un
    // operatore a cercare sul pannello Aruba un documento che non esiste.
    expect(numeroInDubbio(503)).toBe(false)
  })
})

describe('un blocco tutto respinto dai NOSTRI gate non ha toccato Aruba', () => {
  /**
   * ⚠️ SERVE PERCHÉ IL TRASPORTO È CAMBIATO, e il difetto che chiude è più insidioso
   * di quello di prima. Con una POST per riga bastava lo status: `pausaDopo(409, …)`
   * valeva cinque secondi perché ad Aruba non era partito niente. Adesso la POST di un
   * blocco risponde **200** anche quando tutte e quindici le righe sono state respinte
   * da un gate nostro — e fidarsi dello status annuncerebbe minuti di attesa a chi non
   * ha consumato nemmeno una richiesta del secchio.
   */
  it('nessuna emessa e solo rifiuti locali ⇒ non ha toccato Aruba', () => {
    expect(bloccoHaToccatoAruba({ emesse: 0, fallite: [{ statoHttp: 409 }, { statoHttp: 422 }] })).toBe(false)
  })

  it('una sola emessa basta a dire che ci è andato', () => {
    expect(bloccoHaToccatoAruba({ emesse: 1, fallite: [{ statoHttp: 409 }] })).toBe(true)
  })

  it('un rifiuto NON locale è già un contatto: lo status non è nella lista dei nostri gate', () => {
    expect(bloccoHaToccatoAruba({ emesse: 0, fallite: [{ statoHttp: 502 }] })).toBe(true)
  })

  it('la pausa segue: cinque secondi se non ha toccato niente, l’attesa piena altrimenti', () => {
    expect(pausaDopoBlocco(1_000, false)).toBe(PAUSA_DOPO_RIFIUTO_LOCALE_MS)
    expect(pausaDopoBlocco(40_000, true)).toBe(ATTESA_FRA_BLOCCHI_MS - 40_000)
    expect(pausaDopoBlocco(999_000, true)).toBe(0)
  })
})
