// @vitest-environment node
/**
 * LOCK · IL CODICE DELLA VOCE NASCE IN UN POSTO SOLO, E LA CAUSALE DEL BONIFICO
 * ESCE DA UNA PORTA SOLA.
 *
 * È il gemello di `causale-fattura-un-motore-solo.test.ts`, sull'altro documento:
 * là si sorveglia la causale che va allo SDI, qui quella che la famiglia copia
 * nel bonifico — e il codice `#K7MXN3P` che la macchina ci ricercherà dentro.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * `codiceVoce(pagamentoId)` è una funzione PURA dell'uuid del pagamento: lo stesso
 * uuid dà sempre le stesse sette lettere, e non c'è nessuna tabella che le
 * conservi. È quello che la rende utile — il codice si stampa nel sollecito oggi e
 * si riconosce nell'estratto conto di marzo — ed è anche quello che la rende
 * pericolosa: una SECONDA implementazione non sbaglia rumorosamente. Produce
 * sette caratteri dell'alfabeto giusto, della lunghezza giusta, col sigillo
 * giusto. Semplicemente non sono quelli che il matcher cerca.
 *
 * Il guasto che ne esce non ha un errore da nessuna parte:
 *   · il genitore copia una causale col codice di una funzione;
 *   · `estraiCodiciVoce` legge quella causale e cerca il codice dell'altra;
 *   · nessuna corrispondenza, il bonifico resta rosso, e chi guarda la coda vede
 *     un movimento «non riconosciuto» che porta addosso il proprio codice scritto
 *     per esteso.
 *
 * Dal 2026-09-20 la posta è più alta: quel codice non è più un aiuto alla vista.
 * È uno dei fatti su cui `valutaCertezza` decide di chiudere un bonifico **da
 * solo**. Un codice generato da una seconda copia non fa sbagliare l'abbinamento —
 * lo fa mancare, in silenzio, e i contatori dell'import tornano numeri più piccoli
 * che nessuno sa leggere come un guasto.
 *
 * ─── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 *  1. `codiceVoce` ed `estraiCodiciVoce` hanno UNA definizione sola, nel motore.
 *  2. I chiamanti sono quelli DICHIARATI: uno in più non è vietato, è un avviso.
 *  3. Nessun file `'use client'` importa il motore. Il codice si calcola sul
 *     SERVER, dove c'è l'uuid del pagamento; calcolarlo nel browser vuol dire
 *     spedire quell'uuid al browser e avere due strade verso le stesse sette
 *     lettere — cioè la divergenza di sempre, entrata dalla porta del client.
 *  4. `renderCausale(` non compare più nella rotta dei pagamenti: chi compone la
 *     causale di un bonifico passa da `causaleBonifico`, l'UNICA porta che applica
 *     `conCodiceVoce`. È la differenza fra una causale col codice e una senza, e
 *     una causale senza codice non fallisce: arriva a destinazione, si legge
 *     benissimo, e semplicemente non si riconcilia da sola.
 *  5. L'editor della fattura riceve il catalogo DELLA FATTURA
 *     (`PLACEHOLDER_CAUSALE_FATTURA`), che il chip `{codice}` non ce l'ha. Offrirlo
 *     là sarebbe un segnaposto che a runtime rende vuoto — e `renderCausale` omette
 *     con grazia un segmento i cui segnaposto sono tutti vuoti: il segmento
 *     sparirebbe da un documento fiscale senza nessun errore.
 *
 * ⚠️ SI ASSERISCE SUL CODICE SENZA COMMENTI, e qui la trappola è armata per
 * davvero: la rotta dei pagamenti NOMINA `renderCausale` nella propria testata —
 * scritto apposta, per dire che usa l'altra porta. Letta sul sorgente grezzo, la
 * regola 4 sarebbe ROSSA proprio sul file che la rispetta; e una regola scritta al
 * contrario («la rotta deve nominare `causaleBonifico`») sarebbe VERDE su una
 * rotta che quel nome ce l'ha solo nel commento. Il secondo controllo positivo qui
 * sotto prova tutt'e due i versi sul file vero.
 *
 * ⚠️ E I COMMENTI SI TOLGONO CON `mascheraSorgente`, NON CON DUE `replace` A MANO.
 * La prima stesura di questo lock usava
 * `t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')`, che non
 * conosce le stringhe: un `/*` dentro un letterale gli apre un finto commento che
 * si chiude sul primo terminatore successivo — che qui non si scrive, perché
 * chiuderebbe questa testata — e CANCELLA il codice in mezzo. Misurato sul
 * repository il 2026-09-20, confrontando i due su tutti i file di `src/`: in **19
 * file** lo strip a mano vedeva MENO codice della maschera, per ~9.600 caratteri
 * non-spazio; il peggiore è
 * `src/components/features/teacher/tasks/TaskCard.tsx`, dove l'attributo
 * `accept="image/*,.pdf,.doc,.docx"` si mangia ~180 righe di JSX.
 *
 * Per questo lock la posta è precisa: dentro una di quelle finestre cieche
 * potevano stare un `codiceVoce(` non dichiarato, un `'use client'` che importa il
 * motore o un secondo `renderCausale(` — e il censimento avrebbe detto che non
 * c'erano. Nessuno dei 19 li contiene oggi (verificato), ma «oggi non morde» non è
 * «non può mordere»: è la cecità che il 2026-09-19 è costata tre lock
 * (`lock-ciechi-audit`). La maschera sostituisce invece di cancellare — stessa
 * lunghezza del grezzo — e il primo controllo positivo qui sotto verifica quella
 * lunghezza su TUTTI i file scansionati, non sui tre sorvegliati: la vecchia
 * guardia sui delimitatori residui girava solo su quei tre, cioè mai su nessuno
 * dei 19.
 *
 * ⚠️ COSA NON DIMOSTRA: che il codice sia quello GIUSTO. La stabilità della
 * stringa — l'alfabeto, il seme, i sette caratteri — è congelata da
 * `codice-voce-congelato.test.ts`, ed è un'altra domanda: quello dice «non
 * cambiare la formula», questo dice «non scriverne una seconda».
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mascheraSorgente, fileSorgente } from '../fixtures/sorgente'

const RADICE = process.cwd()

/** Il motore: la formula, l'alfabeto, il sigillo, e il lettore inverso. */
const MOTORE = join('src', 'lib', 'pagamenti', 'codice-voce.ts')

/**
 * Chi CHIAMA `codiceVoce`, dichiarato. Sono quattro, e ognuno ha una ragione:
 *  · la rotta dei pagamenti — il codice accanto alla causale suggerita nell'app;
 *  · `riconciliazione.ts` — il matcher, che lo confronta con la causale in banca;
 *  · `riconciliazione-auto.ts` — il predicato che, riconosciuto il codice, chiude
 *    il bonifico senza che nessuno clicchi;
 *  · `solleciti-invio.ts` — il codice dentro l'email che la famiglia riceve.
 */
const CHIAMANTI_CODICE = [
  join('src', 'app', 'api', 'pagamenti', 'route.ts'),
  join('src', 'lib', 'pagamenti', 'riconciliazione.ts'),
  join('src', 'lib', 'pagamenti', 'riconciliazione-auto.ts'),
  join('src', 'lib', 'pagamenti', 'solleciti-invio.ts'),
  // Il QUINTO, arrivato il 2026-09-20 mentre questo lock veniva scritto — ed è il
  // censimento qui sotto che l'ha intercettato, non una lettura a mano.
  // `motivo-abbinamento.ts` RICOSTRUISCE il perché la macchina ha chiuso una riga:
  // il motivo non è salvato da nessuna parte, e l'unico appiglio che non invecchia
  // è proprio questo codice, che è una funzione pura dell'uuid del pagamento.
  // Sta sotto la stessa regola degli altri proprio per quello: se il codice
  // ricostruito qui non fosse lo stesso generato là, la schermata spiegherebbe un
  // abbinamento con una prova che non torna.
  join('src', 'lib', 'pagamenti', 'motivo-abbinamento.ts'),
]

/** Chi legge i codici DENTRO una causale: le strade del riconoscimento. */
const CHIAMANTI_ESTRAI = [
  join('src', 'lib', 'pagamenti', 'riconciliazione.ts'),
  join('src', 'lib', 'pagamenti', 'riconciliazione-auto.ts'),
  // Stessa ragione: qui si rilegge la causale di una riga già chiusa per dire
  // quale codice conteneva.
  join('src', 'lib', 'pagamenti', 'motivo-abbinamento.ts'),
]

/** La rotta che propone all'app la causale del bonifico. */
const ROTTA_PAGAMENTI = join('src', 'app', 'api', 'pagamenti', 'route.ts')

/** L'editor dei modelli di causale: un componente solo, usato due volte. */
const EDITOR = join('src', 'components', 'features', 'admin', 'pagamenti', 'CausaliPanel.tsx')

/** Gli specificatori con cui si arriva al motore, relativo e con alias. */
const IMPORTA_MOTORE = /from\s*['"](?:@\/lib\/pagamenti\/codice-voce|\.{1,2}\/(?:.*\/)?codice-voce)['"]/

/**
 * Via i commenti — con la maschera CONDIVISA del repository (`../fixtures/sorgente`),
 * non con due `replace` scritti qui: conosce stringhe, template e regex, e
 * sostituisce con spazi invece di cancellare, quindi non può perdere una riga. Il
 * perché sta nella testata, col numero (19 file, ~9.600 caratteri).
 */
const senzaCommenti = (t: string): string => mascheraSorgente(t).senzaCommenti

const SORGENTI = fileSorgente(join(RADICE, 'src')).map((a) => {
  const grezzo = readFileSync(a, 'utf8')
  return { relativo: relative(RADICE, a), grezzo, codice: senzaCommenti(grezzo) }
})

const di = (relativo: string) => SORGENTI.find((f) => f.relativo === relativo)

describe('LOCK · un solo motore per il codice della voce e la causale del bonifico', () => {
  it('controllo positivo: i sorgenti si leggono, e la maschera non ha divorato il codice', () => {
    expect(SORGENTI.length, 'i sorgenti di `src/` non si leggono più').toBeGreaterThan(500)

    const firme: [string, string][] = [
      [MOTORE, 'export function codiceVoce('],
      [ROTTA_PAGAMENTI, "withRoute('pagamenti:GET'"],
      [EDITOR, 'segnaposto={PLACEHOLDER_CAUSALE_FATTURA}'],
    ]
    for (const [file, firma] of firme) {
      const f = di(file)
      expect(f, `${file} non è stato letto: il lock sorveglia un file che non c'è più`).toBeDefined()
      expect(
        f!.codice,
        `${file} non contiene più la sua firma (${firma}): o il file è stato svuotato, o ciò che ` +
          'questo lock sorveglia si è spostato — e allora il lock va spostato con lui.',
      ).toContain(firma)
    }

    // ⚠️ LA GUARDIA CHE PRIMA MANCAVA. La vecchia verifica sui delimitatori
    // residui girava sui soli tre file qui sopra, cioè mai su nessuno dei 19 in
    // cui lo strip a mano si mangiava il codice: una cecità che, per
    // costruzione, non poteva accorgersi di sé. Questa invece gira su TUTTI i
    // file scansionati, e non costa niente perché la maschera garantisce un
    // invariante misurabile: commenti sostituiti da spazi, quindi il testo
    // ripulito è lungo esatto come il grezzo. Un solo file più corto vuol dire
    // codice sparito dal censimento — e un censimento cieco non elenca il
    // chiamante che non si è dichiarato.
    const accorciati = SORGENTI.filter((f) => f.codice.length !== f.grezzo.length).map(
      (f) => `${f.relativo} (${f.grezzo.length} → ${f.codice.length})`,
    )
    expect(
      accorciati,
      'La maschera ha ACCORCIATO un sorgente: da qualche parte ha cancellato invece di ' +
        'sostituire, e in quella finestra cieca possono stare un `codiceVoce(` non dichiarato, ' +
        'un `use client` che importa il motore o un secondo `renderCausale(`. Si ripara ' +
        '`__tests__/fixtures/sorgente.ts` — dove se ne appoggiano altri sei lock — non si ' +
        'allarga la tolleranza qui.\n' + accorciati.join('\n'),
    ).toEqual([])
  })

  it('controllo positivo: la maschera morde nei DUE versi sulla rotta dei pagamenti', () => {
    // Questo è il blocco che tiene in piedi la regola 4, e prova tutt'e due i modi
    // di sbagliarla. La testata della rotta nomina `renderCausale` per dire che NON
    // lo usa: sul grezzo il divieto sarebbe rosso sul file che lo rispetta.
    const f = di(ROTTA_PAGAMENTI)!
    expect(f.grezzo, 'la rotta non nomina più `renderCausale` nemmeno nei commenti').toContain('renderCausale')
    expect(f.codice, 'la maschera non ha spento il commento che nomina `renderCausale`').not.toContain('renderCausale')
    // E nell'altro verso: `causaleBonifico` sta nel commento E nel codice. Una
    // regola scritta sul grezzo sarebbe verde anche il giorno in cui restasse solo
    // la frase.
    expect(f.codice, 'la rotta non chiama più `causaleBonifico`').toMatch(/\bcausaleBonifico\s*\(/)
  })

  it('🔴 il motore ha UNA definizione sola per ciascuna delle due funzioni', () => {
    for (const nome of ['codiceVoce', 'estraiCodiciVoce']) {
      const re = new RegExp(`export\\s+function\\s+${nome}\\b`)
      const definizioni = SORGENTI.filter((f) => re.test(f.codice)).map((f) => f.relativo)
      expect(
        definizioni,
        `${nome} deve essere definita una volta sola, in ${MOTORE}. Una seconda implementazione ` +
          'non sbaglia rumorosamente: produce sette caratteri dell\'alfabeto giusto che ' +
          'semplicemente non sono quelli che il matcher cerca.',
      ).toEqual([MOTORE])
    }
  })

  it('🔴 i chiamanti sono quelli dichiarati, e non uno di più', () => {
    const censimento = (re: RegExp) =>
      SORGENTI.filter((f) => f.relativo !== MOTORE && re.test(f.codice)).map((f) => f.relativo).sort()

    expect(
      censimento(/\bcodiceVoce\s*\(/),
      'I chiamanti di `codiceVoce` sono cambiati. Non è un divieto: è un AVVISO. Chi genera il ' +
        'codice di una voce sta scrivendo una stringa che poi qualcun ALTRO dovrà riconoscere in ' +
        'un estratto conto — e che dal 2026-09-20 può far chiudere un bonifico senza che nessuno ' +
        'clicchi. Una porta in più va dichiarata in `CHIAMANTI_CODICE` qui sopra, e provata.',
    ).toEqual([...CHIAMANTI_CODICE].sort())

    expect(
      censimento(/\bestraiCodiciVoce\s*\(/),
      'I lettori di codici dentro una causale sono cambiati. Stessa regola, dal lato del ' +
        'riconoscimento: chi legge i codici sta decidendo che cosa una causale «nomina», e oggi ' +
        'quel fatto entra nel predicato che chiude i bonifici da solo.',
    ).toEqual([...CHIAMANTI_ESTRAI].sort())
  })

  it('🔴 nessun file `use client` importa il motore del codice', () => {
    const colpevoli = SORGENTI.filter(
      (f) => /^\s*['"]use client['"]/m.test(f.codice) && IMPORTA_MOTORE.test(f.codice),
    ).map((f) => f.relativo)
    expect(
      colpevoli,
      'Il codice della voce si calcola sul SERVER, dove l\'uuid del pagamento c\'è già. ' +
        'Importarlo in un componente client vuol dire mandare quell\'uuid al browser e avere due ' +
        'strade verso le stesse sette lettere: il giorno in cui una delle due cambia, la causale ' +
        'che la famiglia copia e il codice che il matcher cerca smettono di coincidere — e ' +
        'nessuna delle due parti dà un errore.\n' + colpevoli.join('\n'),
    ).toEqual([])
  })

  it('🔴 la rotta dei pagamenti non compone la causale con il motore nudo', () => {
    const c = di(ROTTA_PAGAMENTI)!.codice
    expect(
      c,
      'La rotta chiama `renderCausale`. La causale di un BONIFICO esce da `causaleBonifico`, che ' +
        'è l\'unica porta ad applicare `conCodiceVoce` — cioè l\'unica che garantisce il ' +
        '`{codice}` anche ai modelli che non lo citano. Con `renderCausale` nudo la causale è ' +
        'perfettamente leggibile e semplicemente non si riconcilia da sola: nessun errore, ' +
        'nessun log, e il bonifico resta rosso.',
    ).not.toMatch(/\brenderCausale\s*\(/)
  })

  it('🔴 l’editor della fattura riceve il catalogo della fattura', () => {
    const c = di(EDITOR)!.codice
    // Il componente è UNO, usato due volte. Che riceva due cataloghi diversi è
    // tutta la separazione: il chip `{codice}` esiste solo per il bonifico.
    expect(
      c,
      'Il pannello della fattura non riceve più `PLACEHOLDER_CAUSALE_FATTURA`. Se gli si passa il ' +
        'catalogo del bonifico, l\'admin vede il chip `{codice}` anche là — dove a runtime ' +
        '`dati.codice` non arriva mai e il segnaposto rende VUOTO. E `renderCausale` omette con ' +
        'grazia un segmento i cui segnaposto sono tutti vuoti: quel segmento sparirebbe da un ' +
        'documento fiscale senza nessun errore.',
    ).toContain('segnaposto={PLACEHOLDER_CAUSALE_FATTURA}')
    expect(
      c,
      'Il pannello del bonifico non riceve più `PLACEHOLDER_CAUSALE`: i due cataloghi sono due ' +
        'perché i due documenti sono due.',
    ).toContain('segnaposto={PLACEHOLDER_CAUSALE}')
    // Il catalogo della fattura si FILTRA da quello del bonifico, non si ricopia:
    // una seconda copia dell'elenco diverge al primo segnaposto nuovo, e diverge
    // in silenzio perché nessuna delle due sarebbe sbagliata da sola.
    expect(
      di(join('src', 'lib', 'pagamenti', 'causale-fattura.ts'))!.codice,
      'Il catalogo della fattura non è più il FILTRO di quello del bonifico: è stato ricopiato.',
    ).toMatch(/PLACEHOLDER_CAUSALE_FATTURA[^=]*=\s*PLACEHOLDER_CAUSALE\.filter\(/)
  })
})
