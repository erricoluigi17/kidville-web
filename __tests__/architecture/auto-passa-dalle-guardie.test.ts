// @vitest-environment node
/**
 * LOCK · L'IMPORT NON SCRIVE DENARO DA SÉ: PASSA DALLE DUE GUARDIE.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Dal 2026-09-20 la fase in fondo al `POST` dell'import chiude da sola i bonifici
 * che `valutaCertezza` dichiara certi. Sono scritture contabili vere — un incasso
 * su una voce, o una transazione che ne salda diverse — e non c'è nessuno a
 * guardarle mentre accadono.
 *
 * Fra quella fase e il database stanno DUE porte, e sono le stesse che usa il
 * percorso manuale:
 *   · `confermaSuVoceSingola` — l'incasso su una voce sola, col compare-and-swap
 *     sulla riga bancaria e la guardia sul residuo;
 *   · `registraConciliazione` — la composizione, con `puoConfermare` come gate
 *     UNICO, la guardia anti-doppia-fattura e la RPC atomica.
 *
 * Il difetto che questo lock impedisce ha una forma sola e un nome solo:
 * **«semplifichiamo»**. La fase sa già quale voce e quale importo; l'incasso è
 * una riga; la tentazione di scriverla qui — un `insert` su `incassi`, o la RPC
 * chiamata direttamente col payload già pronto — è tanto più forte quanto più il
 * chiamante è sicuro di sé. E ciò che si salta scrivendola qui non è un giro di
 * codice: è il residuo (si incassa più di quanto è dovuto, e nessuno lo vede
 * finché non arriva il sollecito), è la doppia fattura sulla stessa voce, è il
 * compare-and-swap (due import dello stesso estratto conto scrivono l'incasso due
 * volte), ed è la marca `abbinato_auto_il` scritta DENTRO la transazione — senza
 * la quale resta una riga confermata dalla macchina e non marcata, cioè una riga
 * che l'annullamento in blocco non troverà mai più.
 *
 * Nessuna di queste cose fallisce rumorosamente. Tutte producono numeri
 * plausibili su uno schermo.
 *
 * ─── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 * Sui DUE file della strada automatica — la rotta di import e la fase che vive
 * fuori di essa:
 *  1. non toccano `incassi` né `pagamenti_transazioni`: quelle tabelle sono delle
 *     guardie;
 *  2. non chiamano le RPC contabili (`registra_transazione_contabile`,
 *     `annulla_transazione_contabile`): il motore atomico si raggiunge solo
 *     attraverso `conciliazione-registra.ts`;
 *  3. non fanno l'`update` che CONFERMA una riga bancaria, e non scrivono la
 *     marca `abbinato_auto_il`: sta dentro il compare-and-swap delle guardie, mai
 *     in un `UPDATE` dopo;
 *  4. la fase chiama DAVVERO tutt'e due le guardie — è la metà positiva, quella
 *     che diventa rossa se un domani qualcuno toglie la chiamata invece di
 *     aggiungerne una vietata;
 *  5. la rotta delega la fase al modulo, invece di riprenderla in casa.
 *
 * ─── 🚪 E LE PORTE NUOVE, CHE SONO IL MODO PER USCIRE DA QUI ────────────────
 *
 * Le cinque regole qui sopra guardano DUE file nominati, ed è il loro limite: la
 * «semplificazione» che vietano si ottiene anche senza toccarli. Basta un modulo
 * nuovo — `riconciliazione-auto-scrittura.ts`, mettiamo — con dentro l'`insert`
 * su `incassi` o la `.rpc('registra_transazione_contabile')`, importato dalla
 * fase e chiamato da lei. I due file sorvegliati resterebbero puliti, e con loro
 * tutto questo lock; il censimento del lock gemello (`auto-abbinamento-un-
 * predicato-solo`) guarda i chiamanti di `valutaCertezza` e non lo vedrebbe, e
 * quello di `annullo-in-blocco-solo-le-auto` guarda chi FILTRA sulla marca, che
 * un modulo del genere non fa. La strada automatica salterebbe le guardie con
 * quattro lock verdi.
 *
 * Da qui le due regole in fondo, che chiudono il perimetro invece di allargare
 * l'elenco dei file:
 *  6. gli import della fase sono DICHIARATI (`IMPORT_FASE`), come il lock gemello
 *     fa con i chiamanti del predicato. Uno in più non è vietato: è un avviso —
 *     una porta nuova sulla strada automatica va PROVATA, non dedotta — e
 *     l'`import(` dinamico, che a un elenco statico sfuggirebbe, è escluso a
 *     parte;
 *  7. i moduli LOCALI che la fase importa non scrivono contabilità al posto suo:
 *     le stesse forme vietate ai due sorvegliati valgono su ciascuno di loro,
 *     tolti i due guardiani, che quelle forme le contengono per mestiere. Così il
 *     modulo nuovo deve prima dichiararsi (regola 6) e poi comunque non può
 *     scrivere (regola 7).
 *
 * ⚠️ IL CONTROLLO POSITIVO QUI È DOPPIO, e la seconda metà è quella che conta:
 * non basta sapere che i due file si leggono — bisogna sapere che i RILEVATORI
 * vedono. Ognuna delle forme vietate viene perciò cercata anche sui due file che
 * la contengono per mestiere (`riconciliazione-conferma.ts` ha gli `incassi`,
 * `conciliazione-registra.ts` ha la RPC): se una regex si rompesse, sarebbe muta
 * là come qui, e questo lock resterebbe verde senza guardare niente.
 *
 * ⚠️ SI ASSERISCE SUL CODICE SENZA COMMENTI. I due file sorvegliati NOMINANO
 * tutto ciò che questo lock vieta — la RPC, gli incassi, la marca — perché
 * spiegano nelle loro testate perché non lo fanno. Un lock che legge un file come
 * testo legge anche i commenti, e in questo repository è già successo che un lock
 * si immunizzasse da solo col proprio commento.
 *
 * ⚠️ E I COMMENTI SI TOLGONO CON `mascheraSorgente`, NON CON DUE `replace` A MANO.
 * La prima stesura usava `t.replace(/\/\*[\s\S]*?\*\//g, '')…`, che non conosce le
 * stringhe: un `/*` dentro un letterale gli apre un finto commento e CANCELLA il
 * codice fino al primo terminatore (che qui non si scrive: chiuderebbe questa
 * testata). Misurato il 2026-09-20 su tutto `src/`, lo strip a
 * mano vedeva meno codice della maschera in 19 file, per ~9.600 caratteri. Questo
 * lock non era fra gli esposti — i suoi file non sono fra i 19 — ma il guasto è
 * nella FORMA, non nel campione, e la regola 7 gli ha appena aggiunto file che
 * quel campione non conteneva. La maschera sostituisce invece di cancellare, e il
 * controllo positivo qui sotto verifica la lunghezza per dimostrarlo.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mascheraSorgente } from '../fixtures/sorgente'

const RADICE = process.cwd()

/** La rotta che riceve l'estratto conto e, in fondo, lascia partire la fase. */
const ROTTA = join('src', 'app', 'api', 'pagamenti', 'riconciliazione', 'route.ts')
/** La fase automatica: sta fuori dalla rotta perché non ha una `Request`. */
const FASE = join('src', 'lib', 'pagamenti', 'riconciliazione-auto-import.ts')

/** I due sorvegliati, con la firma che dimostra che il corpo c'è ancora. */
const SORVEGLIATI: { file: string; firma: string }[] = [
  { file: ROTTA, firma: "withRoute('pagamenti/riconciliazione:POST'" },
  { file: FASE, firma: 'export async function abbinaImportAutomaticamente(' },
]

/**
 * Le due guardie, e i file in cui vivono. Servono anche da controllo positivo dei
 * rilevatori: `riconciliazione-conferma.ts` scrive negli `incassi` e fa l'`update`
 * che conferma la riga; `conciliazione-registra.ts` chiama la RPC. Sono i posti
 * GIUSTI in cui quelle forme esistono — e la prova che le regex qui sotto le
 * sanno vedere.
 */
const GUARDIA_SINGOLA = join('src', 'lib', 'pagamenti', 'riconciliazione-conferma.ts')
const GUARDIA_COMPOSITA = join('src', 'lib', 'pagamenti', 'conciliazione-registra.ts')

/** Le tabelle del denaro: chi le tocca sta scrivendo contabilità. */
const TABELLE_VIETATE = ['incassi', 'pagamenti_transazioni']

/** Le RPC contabili: il motore atomico, che ha una porta sola. */
const RPC_VIETATE = ['registra_transazione_contabile', 'annulla_transazione_contabile']

/** `.from('tabella')` per una tabella data. */
const daTabella = (t: string) => new RegExp(`\\.from\\(\\s*['"\`]${t}['"\`]\\s*\\)`)

/** `.rpc('nome'` per una RPC data. */
const rpcChiamata = (n: string) => new RegExp(`\\.rpc\\(\\s*['"\`]${n}['"\`]`)

/**
 * L'`update` che CONFERMA una riga bancaria: la catena parte da
 * `.from('riconciliazione_movimenti')` e arriva a `.update(`. La finestra di 300
 * caratteri copre la catena spezzata su più righe senza inseguire un `.update(`
 * che appartenga a tutt'altra query duecento righe più in basso.
 */
const CONFERMA_MOVIMENTO = /\.from\(\s*['"`]riconciliazione_movimenti['"`]\s*\)[\s\S]{0,300}?\.update\s*\(/

/** La marca «l'ha deciso la macchina»: si scrive dentro il compare-and-swap, mai qui. */
const MARCA = /\babbinato_auto_il\b/

/**
 * Gli import DICHIARATI della fase (regola 6). Sono quattordici, e l'elenco è
 * l'unico posto in cui si vede per intero che cosa la strada automatica ha a
 * portata di mano: tre servizi (logger, audit, sedi), il tipo del client, e dieci
 * moduli di `src/lib/pagamenti/` di cui solo DUE scrivono contabilità — i due
 * guardiani.
 *
 * Un import in più non è vietato: è un avviso, e il messaggio dice che cosa fare.
 * Il senso è che nessuno possa aggiungere una porta sulla strada automatica
 * SENZA leggere questa testata.
 */
const IMPORT_FASE = [
  '@supabase/supabase-js',
  '@/lib/audit/scrittura',
  '@/lib/auth/require-staff',
  '@/lib/logging/logger',
  '@/lib/scuole/reali',
  '@/lib/pagamenti/aging',
  '@/lib/pagamenti/conciliazione-composita',
  '@/lib/pagamenti/conciliazione-registra',
  '@/lib/pagamenti/marca-automatica',
  '@/lib/pagamenti/pagante-ammesso',
  '@/lib/pagamenti/pagante-comune',
  '@/lib/pagamenti/riconciliazione-auto',
  '@/lib/pagamenti/riconciliazione-conferma',
  '@/lib/pagamenti/transazioni-quadratura',
]

/** Gli specificatori dei due guardiani: le forme vietate là dentro sono il mestiere. */
const SPEC_GUARDIE = ['@/lib/pagamenti/riconciliazione-conferma', '@/lib/pagamenti/conciliazione-registra']

/** Un `import … from '…'` statico, anche spezzato su più righe. */
const IMPORT_STATICO = /^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm

/** L'`import()` dinamico: la porta che a un elenco statico sfuggirebbe. */
const IMPORT_DINAMICO = /\bimport\s*\(/

/** `@/x` → il file di `src/` che lo implementa, o `null` se non è un percorso locale. */
function risolvi(spec: string): string | null {
  if (!spec.startsWith('@/')) return null
  const base = join(RADICE, 'src', spec.slice(2))
  for (const q of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(q)) return relative(RADICE, q)
  }
  return null
}

/**
 * Via i commenti — con la maschera CONDIVISA del repository (`../fixtures/sorgente`),
 * non con due `replace` scritti qui: conosce stringhe, template e regex, e
 * sostituisce con spazi invece di cancellare. Il perché sta nella testata.
 */
const senzaCommenti = (t: string): string => mascheraSorgente(t).senzaCommenti

const leggi = (f: string) => readFileSync(join(RADICE, f), 'utf8')
const GREZZO = new Map(
  [...SORVEGLIATI.map((s) => s.file), GUARDIA_SINGOLA, GUARDIA_COMPOSITA].map((f) => [f, leggi(f)]),
)
const CODICE = new Map([...GREZZO].map(([f, g]) => [f, senzaCommenti(g)]))

describe('LOCK · l’abbinamento automatico passa dalle guardie, sempre', () => {
  it('controllo positivo: i due sorvegliati si leggono, e la maschera non ha divorato il codice', () => {
    for (const { file, firma } of SORVEGLIATI) {
      const c = CODICE.get(file)!
      expect(c.length, `${file} è vuoto: il lock sorveglia un file che non c'è più`).toBeGreaterThan(2000)
      expect(
        c,
        `${file} non contiene più la sua firma (${firma}): o la strada automatica è stata ` +
          'spostata altrove — e allora questo lock va spostato con lei — o il file è stato svuotato.',
      ).toContain(firma)
    }

    // La maschera sostituisce i commenti con spazi: il testo ripulito è lungo
    // esatto come il grezzo. Se si accorciasse avrebbe CANCELLATO, e nel pezzo
    // cancellato potrebbe stare esattamente l'`insert` che questo lock cerca —
    // che è il modo in cui uno strip scritto a mano rende un lock verde e cieco.
    const accorciati = [...GREZZO].filter(([f, g]) => CODICE.get(f)!.length !== g.length).map(([f]) => f)
    expect(
      accorciati,
      'La maschera ha ACCORCIATO un sorgente: ha cancellato invece di sostituire, e in quella ' +
        'finestra cieca può stare una delle forme vietate qui sotto. Si ripara ' +
        '`__tests__/fixtures/sorgente.ts`, non si allarga la tolleranza qui.\n' + accorciati.join('\n'),
    ).toEqual([])
  })

  it('controllo positivo: i RILEVATORI vedono le forme vietate dove esistono per mestiere', () => {
    // Senza questo blocco una regex rotta sarebbe muta ovunque, e le regole qui
    // sotto passerebbero per la ragione sbagliata: «zero forme trovate» e «la
    // regex non trova niente» hanno lo stesso colore.
    const conferma = CODICE.get(GUARDIA_SINGOLA)!
    expect(
      daTabella('incassi').test(conferma),
      `il rilevatore degli incassi non vede più la riga che li scrive in ${GUARDIA_SINGOLA}`,
    ).toBe(true)
    expect(
      CONFERMA_MOVIMENTO.test(conferma),
      `il rilevatore dell'update di conferma non vede più il compare-and-swap in ${GUARDIA_SINGOLA}`,
    ).toBe(true)
    expect(
      MARCA.test(conferma),
      `il rilevatore della marca non vede più \`abbinato_auto_il\` in ${GUARDIA_SINGOLA}`,
    ).toBe(true)
    expect(
      rpcChiamata('registra_transazione_contabile').test(CODICE.get(GUARDIA_COMPOSITA)!),
      `il rilevatore della RPC non vede più la chiamata in ${GUARDIA_COMPOSITA}`,
    ).toBe(true)
  })

  it('🔴 la strada automatica non tocca le tabelle del denaro', () => {
    const colpevoli: string[] = []
    for (const { file } of SORVEGLIATI) {
      for (const t of TABELLE_VIETATE) {
        if (daTabella(t).test(CODICE.get(file)!)) colpevoli.push(`${file} → ${t}`)
      }
    }
    expect(
      colpevoli,
      'Qui si sta scrivendo contabilità fuori dalle guardie. `incassi` e `pagamenti_transazioni` ' +
        'si toccano da `riconciliazione-conferma.ts` e da `conciliazione-registra.ts`, che sono ' +
        'gli unici due punti in cui vivono la guardia sul residuo, quella anti-doppia-fattura e ' +
        'il compare-and-swap. Un `insert` scritto qui li salta tutti e tre, e non fallisce: ' +
        'produce un numero plausibile.\n' + colpevoli.join('\n'),
    ).toEqual([])
  })

  it('🔴 la strada automatica non chiama le RPC contabili', () => {
    const colpevoli: string[] = []
    for (const { file } of SORVEGLIATI) {
      for (const n of RPC_VIETATE) {
        if (rpcChiamata(n).test(CODICE.get(file)!)) colpevoli.push(`${file} → ${n}`)
      }
    }
    expect(
      colpevoli,
      'Il motore atomico ha UNA porta, e si chiama `registraConciliazione`. Chiamare la RPC con ' +
        'un payload composto qui salta `puoConfermare` — il gate unico, quello che non si ' +
        'ricompone a mano — e con lui la guardia anti-doppia-fattura.\n' + colpevoli.join('\n'),
    ).toEqual([])
  })

  it('🔴 la strada automatica non conferma la riga bancaria da sé, né scrive la marca', () => {
    for (const { file } of SORVEGLIATI) {
      const c = CODICE.get(file)!
      expect(
        CONFERMA_MOVIMENTO.test(c),
        `${file} fa un \`update\` su \`riconciliazione_movimenti\`. La conferma della riga ` +
          'bancaria sta DENTRO il compare-and-swap delle guardie: fuori di lì, due import dello ' +
          'stesso estratto conto scrivono l\'incasso due volte, e la seconda non se ne accorge. ' +
          '(L\'`insert` delle righe appena importate è un\'altra cosa e resta lecito.)',
      ).toBe(false)
      expect(
        MARCA.test(c),
        `${file} scrive o legge \`abbinato_auto_il\` per conto proprio. La marca si scrive dentro ` +
          'la transazione che conferma, mai in un `UPDATE` dopo: fuori di lì l\'esito parziale è ' +
          'una riga confermata dalla macchina e NON marcata, cioè una riga che l\'annullamento ' +
          'in blocco non troverà mai più. Se serve sapere se la colonna esiste, la domanda si fa ' +
          'a `marcaAutomaticaDisponibile`, che è fail-closed apposta.',
      ).toBe(false)
    }
  })

  it('🔴 la fase chiama DAVVERO tutt’e due le guardie', () => {
    // La metà positiva del lock. Le cinque regole qui sopra vietano: da sole
    // sarebbero verdi anche su una fase che non scrive più niente — che è l'altro
    // modo di rompere questo automatismo, e il più silenzioso dei due.
    const c = CODICE.get(FASE)!
    expect(
      c,
      'La fase automatica non chiama più `confermaSuVoceSingola`: l\'abbinamento su voce singola ' +
        '— il caso più frequente — o è sparito, o è stato riscritto altrove.',
    ).toMatch(/\bconfermaSuVoceSingola\s*\(/)
    expect(
      c,
      'La fase automatica non chiama più `registraConciliazione`: la composizione — il bonifico ' +
        'che salda più voci insieme — o è sparita, o è stata riscritta altrove.',
    ).toMatch(/\bregistraConciliazione\s*\(/)
  })

  it('🔴 la rotta delega la fase al modulo, invece di riprenderla in casa', () => {
    const c = CODICE.get(ROTTA)!
    expect(
      c,
      'La rotta non importa più `abbinaImportAutomaticamente`. Le guardie non stanno nella rotta ' +
        'e non stanno nella fase: si chiamano dove sono già. Se la fase è tornata dentro un ' +
        'handler HTTP, questo lock va riscritto con lei — non cancellato.',
    ).toMatch(/import\s*\{[^}]*\babbinaImportAutomaticamente\b[^}]*\}\s*from\s*'@\/lib\/pagamenti\/riconciliazione-auto-import'/)
    expect(c, 'la rotta importa la fase ma non la chiama').toMatch(/\babbinaImportAutomaticamente\s*\(/)
  })

  it('🔴 la fase non apre porte nuove sulla strada automatica senza dichiararle', () => {
    const c = CODICE.get(FASE)!
    const trovati = [...new Set([...c.matchAll(IMPORT_STATICO)].map((m) => m[1]))].sort()

    // Controllo positivo del rilevatore: un elenco vuoto vorrebbe dire che la
    // regex non vede più gli `import`, e il confronto qui sotto sarebbe verde
    // per la ragione sbagliata il giorno in cui l'elenco dichiarato si
    // svuotasse con lui.
    expect(trovati.length, 'il rilevatore non trova più nessun `import` nella fase').toBeGreaterThan(5)

    expect(
      trovati,
      'Gli import della fase automatica sono cambiati. Non è un divieto: è un AVVISO, lo stesso ' +
        'che `auto-abbinamento-un-predicato-solo` fa sui chiamanti del predicato.\n\n' +
        'Questo lock vieta a DUE file nominati di scrivere contabilità da sé; un modulo nuovo, ' +
        'importato dalla fase, è il modo per ottenere la stessa «semplificazione» restando fuori ' +
        'dal loro perimetro — e resterebbe fuori anche da quello degli altri tre lock di questo ' +
        'gruppo. Se la porta nuova serve: (1) dichiarala in `IMPORT_FASE`; (2) se scrive denaro, ' +
        'non scriverlo lì — le guardie sono due e hanno un nome; (3) provala, perché una porta ' +
        'sulla strada automatica va PROVATA, non dedotta: di là si chiude un bonifico senza che ' +
        'nessuno clicchi.',
    ).toEqual([...IMPORT_FASE].sort())

    // L'elenco qui sopra è statico, e un `await import('…')` gli sfuggirebbe
    // interamente: è l'unico modo di aggiungere una dipendenza senza comparire
    // in `IMPORT_FASE`, quindi si vieta a parte.
    expect(
      IMPORT_DINAMICO.test(c),
      'La fase automatica usa un `import()` dinamico. Una dipendenza caricata così non compare ' +
        'in nessun elenco di import e sfugge alla regola qui sopra: sulla strada che scrive ' +
        'denaro senza un gesto umano, ciò che si carica si dichiara.',
    ).toBe(false)
  })

  it('🔴 nessun modulo importato dalla fase scrive contabilità al posto suo', () => {
    const c = CODICE.get(FASE)!
    const locali = [...new Set([...c.matchAll(IMPORT_STATICO)].map((m) => m[1]))]
      .filter((s) => s.startsWith('@/') && !SPEC_GUARDIE.includes(s))
      .sort()

    // Due controlli positivi, perché «nessun modulo scansionato» e «nessuna
    // violazione» hanno lo stesso colore: i moduli devono essere parecchi, e
    // ognuno deve risolvere a un file vero.
    expect(locali.length, 'la fase non importa più nessun modulo locale: il censimento è muto').toBeGreaterThan(5)
    const nonRisolti = locali.filter((s) => risolvi(s) === null)
    expect(
      nonRisolti,
      'Uno specificatore non si risolve a nessun file di `src/`: `risolvi` non conosce la forma ' +
        'con cui è scritto (una cartella con `index.ts`, un\'estensione nuova, un alias diverso) ' +
        'e quel modulo NON viene scansionato. Un censimento che salta in silenzio è la cecità ' +
        'che questo gruppo di lock esiste per non ripetere.\n' + nonRisolti.join('\n'),
    ).toEqual([])

    const colpevoli: string[] = []
    for (const spec of locali) {
      const file = risolvi(spec)!
      const codice = senzaCommenti(leggi(file))
      for (const t of TABELLE_VIETATE) if (daTabella(t).test(codice)) colpevoli.push(`${file} → ${t}`)
      for (const n of RPC_VIETATE) if (rpcChiamata(n).test(codice)) colpevoli.push(`${file} → ${n}`)
      if (CONFERMA_MOVIMENTO.test(codice)) colpevoli.push(`${file} → update di conferma`)
      // ⚠️ La MARCA non si cerca qui, ed è una scelta misurata, non una svista:
      // `marca-automatica.ts` la NOMINA per mestiere — è la sonda che chiede se
      // la colonna esiste, ed è fail-closed apposta. Cercarla anche qui
      // renderebbe questa regola rossa su codice corretto al primo giro, e un
      // lock che grida sul codice giusto si fa zittire con un'allowlist. Il
      // divieto di SCRIVERLA resta intero sui due file sorvegliati, che sono i
      // soli a poterla scrivere fuori dalla transazione.
    }
    expect(
      colpevoli,
      'Un modulo importato dalla fase automatica scrive contabilità. È la forma con cui si esce ' +
        'da questo lock senza toccarne i due file: l\'`insert` su `incassi` o la RPC si spostano ' +
        'in un modulo nuovo, la fase lo chiama, e i due sorvegliati restano puliti. Ciò che si ' +
        'salta è sempre lo stesso — la guardia sul residuo, quella anti-doppia-fattura, il ' +
        'compare-and-swap e la marca scritta DENTRO la transazione — e non fallisce: produce un ' +
        'numero plausibile.\n' + colpevoli.join('\n'),
    ).toEqual([])
  })
})
