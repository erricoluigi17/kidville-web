import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LOCK — nessuna sesta strada verso il bucket pubblico.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Il consenso fotografico sul canale «sito» è stato chiuso quattro volte, sempre
 * per lo stesso motivo e sempre su una strada diversa:
 *
 *   2026-08-01  `news:POST` — il gate nasce qui, e ci resta chiuso dentro.
 *   2026-08-01  `news/[id]:PATCH` — si creava il post senza foto e la si
 *               aggiungeva dopo: nessun controllo.
 *   2026-08-01  `news/[id]/pubblica:POST` — fra la creazione e la pubblicazione
 *               una famiglia può revocare (art. 7 §3 GDPR).
 *   2026-08-03  `news/[id]/approva:POST` — la segreteria approva la proposta di
 *               un docente e nel ramo normale la pubblica nello stesso istante.
 *               `grep gateConsensoFoto src/` dava tre chiamanti; questa rotta non
 *               era fra loro, e il gate formale era verde.
 *
 * Quattro volte la stessa causa: **una regola valida per N strade, scritta su
 * N-1**. Aggiungere il controllo alla quarta rotta chiude la quarta rotta e
 * lascia identica la probabilità che esista una quinta. Questo file toglie
 * all'attenzione umana il compito di ricordarsene: il giorno in cui qualcuno
 * scrive una route nuova che mette un post in `pubblicata`, o che cancella una
 * riga di `news_posts`, è questo test a dirlo — non un collaudo, non un incidente.
 *
 * ─── COSA SORVEGLIA, E PERCHÉ CIASCUNA REGOLA ───────────────────────────────
 *
 *  1. **Chi rende un post PUBBLICATO nomina il gate.** Il bucket `news` è
 *     pubblico e servito senza login: rendere visibile un post è l'atto che
 *     espone la foto di un bambino a chiunque.
 *  2. **Chi INSERISCE una riga di `news_posts` nomina il gate.** È la strada in
 *     cui una foto nuova entra nel sistema, e lo stato ci arriva attraverso una
 *     variabile: la regola 1 da sola non la vedrebbe.
 *  3. **Chi CANCELLA una riga di `news_posts` libera prima i suoi file.**
 *     Cancellare la riga e lasciare il file è il guasto peggiore della serie: la
 *     foto resta a un indirizzo pubblico e non c'è più nessuna riga da cui
 *     ritrovarla — né il ritiro per consenso caduto né l'oblio del minore
 *     possono più arrivarci (difetto V4 del 2026-08-03).
 *  4. **Chi RISCRIVE la copertina o il rich-text di `news_posts` libera i file
 *     che escono dalla riga.** Stessa causa della 3 per la strada della modifica
 *     (difetto W1, misurato lo stesso giorno con una sonda eseguita: «PATCH
 *     sostituzione — percorsi tolti dal bucket: []»). Il file vecchio resta
 *     pubblico e nessuna riga lo nomina più.
 *  5. **Chi chiama il gate ne USA il verdetto.** Vedi la sezione qui sotto: un
 *     verificatore adversariale ha evaso la regola 1 chiamando `gateConsensoFoto`
 *     e buttando via la risposta (`void gate`). Il lock è rimasto verde.
 *
 * ─── L'ECCEZIONE, DICHIARATA E VERIFICATA ───────────────────────────────────
 *
 * Il tick del cron pubblica le programmate scadute e non passa da `gateConsensoFoto`:
 * non c'è nessun operatore a cui rifiutare, e il gate è pensato per rispondere a
 * una richiesta. Al suo posto rilegge il consenso di TUTTI i post sorvegliati
 * (`verificaPermanenzaConsenso`) e sospende l'intero tick se non ci riesce. È
 * un'eccezione con un nome e un motivo scritto, e il lock **verifica che il
 * meccanismo alternativo ci sia davvero**: un'allowlist che si limitasse a
 * esentare sarebbe un modo elegante di riaprire il buco.
 *
 * ═══ QUESTA È UNA RETE A MAGLIE LARGHE. ECCO COSA NON PRENDE ════════════════
 *
 * Questo file **cerca dei NOMI dentro dei sorgenti**. Non esegue niente, non
 * capisce niente, e chi lo legge deve saperlo: un lock che promette più di
 * quanto mantiene è peggio di nessun lock, perché sposta l'attenzione altrove.
 * Il 2026-08-03 un verificatore adversariale l'ha dimostrato sul campo,
 * scrivendo `void gate` in una rotta: la chiamata al gate c'era, il verdetto
 * finiva nel cestino, e **il lock è rimasto verde**.
 *
 * Quello che NON copre, in ordine di quanto è facile scavalcarlo:
 *
 *  a. **Il verdetto usato solo per finta.** La regola 5 pretende ora la forma
 *     `if ('response' in gate) return gate.response`, quindi `void gate` non
 *     passa più — ma un `if` con il corpo vuoto, o un `return` dentro un ramo
 *     irraggiungibile, sì. Un grep non sa distinguere un controllo da un
 *     controllo mimato.
 *  b. **La scrittura dello stato attraverso una variabile.** `SCRIVE_PUBBLICATA`
 *     cerca il LETTERALE `stato: 'pubblicata'`: `stato: STATO_VISIBILE`, o una
 *     costante importata, non lo vede. La regola 2 (chi INSERISCE nomina il
 *     gate) esiste per coprire il caso più comune, non tutti.
 *  c. **Tutto ciò che sta fuori da `src/app/api/news`.** Una server action, un
 *     cron in un'altra cartella, una RPC `SECURITY DEFINER`, una migrazione con
 *     un `UPDATE`, o un secondo gruppo di rotte: per questo file non esistono.
 *     Vale anche in piccolo: le regole 3, 4 e 5 guardano un handler alla volta
 *     (vedi `blocchi()`, e il perché — a livello di file la 4 era VUOTA), ma un
 *     handler che delega la scrittura a un helper in un ALTRO file non viene
 *     visto da nessuna delle due misure.
 *  d. **Il codice DENTRO le funzioni che nomina.** Che
 *     `liberaPercorsiPubblici` liberi davvero i file, che lo faccia PRIMA di
 *     scrivere la riga, e che liberi i percorsi GIUSTI (la differenza fra prima
 *     e dopo, non «tutti quelli del post»), qui non si vede in nessun modo.
 *
 * ═══ DOVE STA LA RETE FINE: I TEST DI COMPORTAMENTO ═════════════════════════
 *
 * Le cose che contano davvero le verificano dei test che ESEGUONO le rotte e
 * guardano che cosa finisce dentro una `remove()` e in che ordine. Sono elencati
 * in `COMPORTAMENTO` qui sotto, e un test di questo file pretende che esistano
 * ancora: cancellarli, che è il modo più semplice di far sparire il controllo
 * vero, fa cadere il lock.
 */

const RADICE = process.cwd()
const NEWS_API = path.join(RADICE, 'src', 'app', 'api', 'news')

/**
 * Le rotte che possono mettere un post in `pubblicata` senza chiamare il gate, e
 * che cosa devono nominare al suo posto. Chiave = percorso dal repo; valore =
 * `{ invece, motivo }`.
 */
const ECCEZIONI_PUBBLICAZIONE: Record<string, { invece: string; motivo: string }> = {
  'src/app/api/news/cron/run/route.ts': {
    invece: 'verificaPermanenzaConsenso',
    motivo:
      'Il tick promuove le programmate scadute: non c’è nessun operatore a cui rifiutare, e il ' +
      'gate serve a rispondere a una richiesta. Rilegge invece il consenso di tutti i post ' +
      'sorvegliati PRIMA di promuovere, e se non ci riesce sospende l’intero tick senza pubblicare.',
  },
}

/** Sostituisce i commenti con spazi lasciando intatti i ritorni a capo. */
function mascheraCommenti(sorgente: string): string {
  return sorgente
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length))
}

/**
 * I test che verificano davvero il COMPORTAMENTO, e non i nomi. Questo lock
 * delega a loro tutto ciò che un grep non può vedere (vedi la testata): se
 * qualcuno li cancella, il controllo vero sparisce in silenzio e resta solo la
 * rete a maglie larghe. Perciò la loro esistenza è essa stessa un'asserzione.
 */
const COMPORTAMENTO = [
  '__tests__/api/news-patch-file-pubblici.test.ts',
  '__tests__/api/news-delete-file-pubblici.test.ts',
  '__tests__/api/news-post-media-orfani.test.ts',
  '__tests__/api/news-consenso-foto.test.ts',
  '__tests__/api/news-consenso-foto-patch.test.ts',
  '__tests__/api/news-consenso-foto-approva.test.ts',
  '__tests__/lib/news/permanenza-consenso.test.ts',
]

/** `stato: 'pubblicata'` / `updates.stato = 'pubblicata'` — la SCRITTURA, non il confronto. */
const SCRIVE_PUBBLICATA = /stato\s*[:=]\s*'pubblicata'/
const INSERISCE_POST = /from\(\s*'news_posts'\s*\)[\s\S]{0,120}?\.insert\(/
const CANCELLA_POST = /from\(\s*'news_posts'\s*\)[\s\S]{0,120}?\.delete\(/
const AGGIORNA_POST = /from\(\s*'news_posts'\s*\)[\s\S]{0,200}?\.update\(/
/**
 * La SCRITTURA di un campo che porta indirizzi di file: `copertina_url: …` come
 * chiave di un oggetto, oppure `updates.copertina_url = …` come assegnazione.
 * La lettura (`post.copertina_url` passato al gate, come fanno `pubblica` e
 * `approva`) NON deve contare: non fa uscire nessun file dalla riga.
 */
const SCRIVE_MEDIA = /(?:(?<![.\w])(?:copertina_url|contenuto_json)\s*:|(?:copertina_url|contenuto_json)\s*=(?!=))/
/**
 * Il verdetto del gate va USATO: `void gate` ha già evaso questo lock una volta.
 *
 * È una SORGENTE, non un `RegExp`, e non per stile: una regex con il flag `g`
 * si porta dietro `lastIndex` fra una chiamata e l'altra, quindi riusare lo
 * stesso oggetto per `matchAll` e per `test` fa saltare metà dei riscontri — un
 * test che si dichiara verde perché non ha guardato. È il difetto che questo
 * file esiste per impedire, e nella prima stesura di questa regola c'era.
 */
const CHIAMA_GATE = String.raw`(?:const|let)\s+(\w+)\s*=\s*await\s+gateConsensoFoto\(`
/**
 * Il verdetto della LIBERAZIONE, che è la novità del 2026-08-03 e che la clausola
 * gemella qui sopra non copriva: `liberaPercorsiPubblici` e
 * `liberaFilePubbliciDelPost` dicono `liberato: false` quando i file NON sono
 * usciti dal bucket pubblico, e chi ignora quella risposta cancella la riga (o la
 * riscrive) lasciando online la foto di un bambino, senza più niente da cui
 * ritrovarla. Un verificatore adversariale ha dimostrato che `if (false &&
 * !liberazione.liberato)` passava il lock: il nome c'era, il controllo no.
 */
const CHIAMA_LIBERAZIONE = String.raw`(?:const|let)\s+(\w+)\s*=\s*await\s+libera(?:PercorsiPubblici|FilePubbliciDelPost)\(`

function routeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...routeFiles(full))
    else if (e.name === 'route.ts') out.push(full)
  }
  return out
}

const FILES = routeFiles(NEWS_API).map((f) => ({
  rel: path.relative(RADICE, f).split(path.sep).join('/'),
  src: mascheraCommenti(fs.readFileSync(f, 'utf8')),
}))

/**
 * Spezza un file di rotta nei suoi HANDLER (`export const PATCH = …`), più il
 * resto del file come blocco a sé.
 *
 * Non è un dettaglio di implementazione: le regole 3 e 4 sono nate a livello di
 * FILE e in quella forma erano vuote proprio dove servivano. `[id]/route.ts`
 * contiene sia la DELETE (che libera i file) sia la PATCH (che il 2026-08-03 non
 * lo faceva): il nome della liberazione era nel file, e la regola passava
 * mentre il difetto c'era. Verificato togliendo la liberazione dalla sola PATCH:
 * il lock restava verde. Le due domande si fanno per handler.
 */
function blocchi(f: { rel: string; src: string }): { rel: string; src: string }[] {
  const re = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g
  const tagli = [...f.src.matchAll(re)].map((m) => ({ i: m.index ?? 0, nome: m[1] }))
  if (tagli.length === 0) return [f]
  const out = [{ rel: `${f.rel} (fuori dagli handler)`, src: f.src.slice(0, tagli[0].i) }]
  for (let k = 0; k < tagli.length; k++) {
    const fine = k + 1 < tagli.length ? tagli[k + 1].i : f.src.length
    out.push({ rel: `${f.rel}:${tagli[k].nome}`, src: f.src.slice(tagli[k].i, fine) })
  }
  return out
}

const BLOCCHI = FILES.flatMap(blocchi)

const pubblicano = FILES.filter((f) => SCRIVE_PUBBLICATA.test(f.src))
const inseriscono = FILES.filter((f) => INSERISCE_POST.test(f.src))
// Per HANDLER, non per file: vedi `blocchi()`.
const cancellano = BLOCCHI.filter((f) => CANCELLA_POST.test(f.src))
const riscrivonoMedia = BLOCCHI.filter((f) => AGGIORNA_POST.test(f.src) && SCRIVE_MEDIA.test(f.src))

describe('lock · il consenso fotografico non si aggira cambiando rotta', () => {
  it('l’inventario trova davvero delle rotte (se cade, il lock si sta autoingannando)', () => {
    // Senza questa asserzione un errore nel percorso renderebbe VERDI tutti i
    // test qui sotto: non troverebbero niente da controllare e lo chiamerebbero
    // successo. È lo stesso difetto che questo file esiste per impedire.
    expect(FILES.length, 'nessuna route sotto src/app/api/news: percorso sbagliato').toBeGreaterThanOrEqual(10)
    expect(pubblicano.length, 'nessuna rotta mette un post in «pubblicata»: la regex non misura più niente').toBeGreaterThanOrEqual(3)
    expect(inseriscono.length, 'nessuna rotta inserisce in news_posts').toBeGreaterThanOrEqual(1)
    expect(cancellano.length, 'nessuna rotta cancella da news_posts').toBeGreaterThanOrEqual(1)
    expect(
      riscrivonoMedia.length,
      'nessuna rotta riscrive copertina/rich-text di news_posts: la regola 4 non misura più niente',
    ).toBeGreaterThanOrEqual(1)
  })

  it('ogni rotta che rende un post PUBBLICATO nomina `gateConsensoFoto`', () => {
    const nude = pubblicano
      .filter((f) => !f.src.includes('gateConsensoFoto') && !(f.rel in ECCEZIONI_PUBBLICAZIONE))
      .map((f) => f.rel)
    expect(
      nude,
      'Queste rotte mettono un post in «pubblicata» senza passare dal gate del consenso. Il bucket ' +
        '`news` è pubblico e servito senza login: pubblicare è l’atto che espone la foto di un ' +
        'bambino. O si chiama `gateConsensoFoto` (come fanno news:POST, news/[id]:PATCH, ' +
        'news/[id]/pubblica:POST e news/[id]/approva:POST), oppure si dichiara qui sopra un’eccezione ' +
        'con il meccanismo che la sostituisce e il motivo per cui basta.',
    ).toEqual([])
  })

  it('ogni rotta che INSERISCE un post nomina `gateConsensoFoto`', () => {
    // La creazione porta lo stato dentro una variabile (`record.stato = stato`):
    // la regola sopra, che cerca il letterale, non la vedrebbe. Ed è la strada in
    // cui una foto NUOVA entra nel sistema.
    const nude = inseriscono.filter((f) => !f.src.includes('gateConsensoFoto')).map((f) => f.rel)
    expect(nude, 'una riga di news_posts nasce senza che nessuno abbia verificato il consenso').toEqual([])
  })

  it('ogni rotta che CANCELLA un post libera prima i suoi file dal bucket pubblico', () => {
    const nude = cancellano
      .filter((f) => !f.src.includes('liberaFilePubbliciDelPost'))
      .map((f) => f.rel)
    expect(
      nude,
      'Queste rotte cancellano una riga di news_posts senza togliere i suoi file dal bucket ' +
        'PUBBLICO. È il guasto peggiore della serie: la foto del bambino resta al suo indirizzo e ' +
        'sparisce l’ultima riga che la nominava, quindi né il ritiro per consenso caduto né ' +
        'l’oblio del minore possono più arrivarci. Si usa `liberaFilePubbliciDelPost` ' +
        '(`src/lib/news/permanenza-consenso.ts`), la stessa funzione del ritiro: PRIMA il file ' +
        'verificato, POI la riga.',
    ).toEqual([])
  })

  it('ogni rotta che RISCRIVE copertina o rich-text libera i file che escono dalla riga', () => {
    // Difetto W1 (2026-08-03). `PATCH /api/news/[id]` sostituiva la copertina e
    // non toccava lo Storage: da quell'istante nessuna riga nominava più il file
    // vecchio, che resta servito dal bucket PUBBLICO. Revoca del consenso e
    // diritto all'oblio partono entrambi dalla riga corrente
    // (`percorsiPubbliciDelPost(post)`): su un file che nessuna riga cita non
    // arrivano più, mai. È la stessa causa della DELETE, sulla strada accanto.
    const nude = riscrivonoMedia
      .filter((f) => !/libera(?:PercorsiPubblici|FilePubbliciDelPost)/.test(f.src))
      .map((f) => f.rel)
    expect(
      nude,
      'Queste rotte riscrivono `copertina_url`/`contenuto_json` di news_posts senza togliere dal ' +
        'bucket PUBBLICO i file che la riga smette di nominare. Si usa `liberaPercorsiPubblici` ' +
        '(`src/lib/news/permanenza-consenso.ts`) sulla DIFFERENZA fra i percorsi di prima e quelli ' +
        'di dopo — la stessa funzione del ritiro e della DELETE: PRIMA il file verificato, POI la riga.',
    ).toEqual([])
  })

  it('il verdetto del gate non si può buttare via (`void gate` ha già evaso questo lock)', () => {
    // L'evasione è DIMOSTRATA, non ipotetica: un verificatore adversariale ha
    // chiamato `gateConsensoFoto` e scritto `void gate`. Il nome c'era, il
    // controllo no, il lock era verde. Qui si pretende che la variabile del
    // verdetto compaia in un `'response' in …` e in un `return ….response`.
    // NON è un verificatore semantico e non pretende di esserlo (vedi la
    // testata, punto a): chiude la strada percorsa, non tutte le strade.
    const senzaUso: string[] = []
    for (const f of FILES) {
      for (const m of f.src.matchAll(new RegExp(CHIAMA_GATE, 'g'))) {
        const v = m[1]
        const controlla = new RegExp(`'response'\\s+in\\s+${v}\\b`).test(f.src)
        const restituisce = new RegExp(`return\\s+${v}\\.response`).test(f.src)
        if (!controlla || !restituisce) senzaUso.push(`${f.rel} (${v})`)
      }
    }
    expect(
      senzaUso,
      'Qui il gate del consenso è chiamato e il suo verdetto non viene usato per fermare la ' +
        'scrittura. Chiamarlo senza leggerne la risposta costa una query e non protegge niente: ' +
        'serve `if (\'response\' in gate) return gate.response`.',
    ).toEqual([])
    // Controllo positivo: senza, la regola sarebbe verde in un mondo dove
    // nessuno chiama più il gate — cioè esattamente quando il difetto è tornato.
    const chiamanti = FILES.filter((f) => new RegExp(CHIAMA_GATE).test(f.src)).length
    expect(chiamanti, 'nessuna rotta chiama più il gate: la regola non misura niente').toBeGreaterThanOrEqual(4)
  })

  it('nemmeno il verdetto della LIBERAZIONE si può buttare via', () => {
    // LA CLAUSOLA GEMELLA, e mancava proprio sulle funzioni nuove. Si pretende la
    // forma `if (!<v>.liberato)` — che è ciò che `if (false && !v.liberato)` NON
    // soddisfa — e che dentro quel ramo ci sia un `return` e nessuna scrittura:
    // rispondere «non fatto» è l'unica cosa lecita quando i file sono ancora nel
    // bucket pubblico. Resta un grep e non pretende di essere altro (vedi la
    // testata, punto a): chiude la strada percorsa, non tutte le strade.
    const senzaUso: string[] = []
    for (const f of BLOCCHI) {
      for (const m of f.src.matchAll(new RegExp(CHIAMA_LIBERAZIONE, 'g'))) {
        const v = m[1]
        const guardia = new RegExp(String.raw`if\s*\(\s*!\s*${v}\.liberato\s*\)`).exec(f.src)
        if (!guardia) {
          senzaUso.push(`${f.rel} (${v}: nessun \`if (!${v}.liberato)\`)`)
          continue
        }
        // Il ramo, guardato per quello che fa: deve USCIRE, e non deve scrivere.
        const ramo = f.src.slice(guardia.index, guardia.index + 600)
        if (!/\breturn\b/.test(ramo)) {
          senzaUso.push(`${f.rel} (${v}: il ramo non esce)`)
        }
        if (/\.(?:update|delete|insert|upsert)\s*\(/.test(ramo.split(/\breturn\b/)[0])) {
          senzaUso.push(`${f.rel} (${v}: il ramo scrive prima di uscire)`)
        }
      }
    }
    expect(
      senzaUso,
      'Qui si chiede a `liberaPercorsiPubblici`/`liberaFilePubbliciDelPost` se i file sono usciti ' +
        'dal bucket PUBBLICO e non si usa la risposta per fermare la scrittura. Con `liberato: ' +
        'false` i file sono ancora là: cancellare la riga (o farle smettere di nominarli) lascia ' +
        'online la foto di un bambino senza più niente da cui ritrovarla. Serve ' +
        '`if (!<verdetto>.liberato) return …`, e nel ramo nessuna scrittura.',
    ).toEqual([])
    // Controllo positivo: senza, la regola sarebbe verde in un mondo dove nessuno
    // libera più niente — cioè esattamente quando il difetto V4 è tornato.
    const chiamanti = BLOCCHI.filter((f) => new RegExp(CHIAMA_LIBERAZIONE).test(f.src)).length
    expect(
      chiamanti,
      'nessun handler libera più i file dal bucket pubblico: la regola non misura niente',
    ).toBeGreaterThanOrEqual(2)
  })

  it('ogni rotta che SCRIVE copertina o rich-text rifiuta i media di un altro post', () => {
    // IL PASSO 1 DELL'ATTACCO, e nel giro 1 era chiuso su una strada sola. La
    // difesa (`percorsiPubbliciEstranei`, oggi `mediaEstranei`) viveva sulla sola
    // `PATCH`: bastava CREARE il post con l'indirizzo già dentro. È la quinta volta
    // in questa serie che la stessa regola vive su N-1 strade, e per la quinta
    // volta la N-esima è quella che nessuno aveva guardato. Da qui in avanti lo
    // dice questo lock, non un collaudo.
    const scrivono = BLOCCHI.filter(
      (f) => SCRIVE_MEDIA.test(f.src) && /\.(?:insert|update)\(/.test(f.src),
    )
    expect(
      scrivono.length,
      'nessun handler scrive copertina/rich-text di news_posts: la regola non misura più niente',
    ).toBeGreaterThanOrEqual(2)
    const nude = scrivono.filter((f) => !/\bmediaEstranei\(/.test(f.src)).map((f) => f.rel)
    expect(
      nude,
      'Questi handler scrivono `copertina_url`/`contenuto_json` senza chiedersi se quegli ' +
        'indirizzi appartengano ad ALTRI post. Il bucket `news` è pubblico e i suoi indirizzi li ' +
        'conosce chiunque legga il sito: una riga che comincia a nominare il file di un altro lo ' +
        'porta dentro il raggio d’azione della propria modifica successiva, e per l’area di sosta ' +
        'privata è peggio — una `move()` in service-role che RENDE PUBBLICA la foto di un altro ' +
        'operatore. Si usa `mediaEstranei` (`src/lib/news/permanenza-consenso.ts`) e si risponde ' +
        '403 con `codice: NEWS_MEDIA_ESTRANEO`.',
    ).toEqual([])
  })

  it('i test di COMPORTAMENTO a cui questo lock delega esistono ancora', () => {
    // Questo file cerca dei nomi dentro dei sorgenti: non esegue niente e non
    // può vedere se una funzione fa quello che dice (testata, punto d). La
    // verifica vera è là dentro. Cancellarli è il modo più semplice di far
    // sparire il controllo lasciando in piedi l'apparenza: ora si vede.
    const mancanti = COMPORTAMENTO.filter((rel) => !fs.existsSync(path.join(RADICE, rel)))
    expect(
      mancanti,
      'Questi test eseguono le rotte e guardano che cosa finisce davvero dentro una `remove()` e ' +
        'in che ordine. Senza di loro resta solo un grep sui nomi — che è già stato evaso una ' +
        'volta. Se un file è stato spostato o rinominato, aggiorna l’elenco: non toglierlo.',
    ).toEqual([])
  })

  it('le eccezioni dichiarate esistono ancora e portano davvero il meccanismo che promettono', () => {
    // Un'allowlist che si limita a esentare è un modo elegante di riaprire il
    // buco: qui si pretende il controllo POSITIVO, cioè che l'alternativa citata
    // nel motivo sia scritta nel file.
    for (const [rel, { invece, motivo }] of Object.entries(ECCEZIONI_PUBBLICAZIONE)) {
      const f = FILES.find((x) => x.rel === rel)
      expect(f, `eccezione stantia: ${rel} non esiste più fra le rotte di news`).toBeTruthy()
      expect(
        pubblicano.some((x) => x.rel === rel),
        `eccezione stantia: ${rel} non mette più nessun post in «pubblicata», va tolta da qui`,
      ).toBe(true)
      expect(f!.src, `${rel}: l’eccezione promette \`${invece}\` e nel file non c’è`).toContain(invece)
      expect(motivo.length, `${rel}: un’eccezione senza motivo scritto è un’eccezione non motivata`).toBeGreaterThan(80)
    }
  })

  it('il gate è chiamato da tutte e quattro le rotte che oggi lo devono chiamare', () => {
    // Controllo POSITIVO dell'intero lock. Le regole qui sopra sono negative
    // («nessuna rotta senza gate»): resterebbero verdi anche se qualcuno
    // cancellasse le chiamate insieme alle scritture, cioè proprio quando il
    // difetto è tornato per una strada nuova.
    const attesi = [
      'src/app/api/news/route.ts',
      'src/app/api/news/[id]/route.ts',
      'src/app/api/news/[id]/pubblica/route.ts',
      'src/app/api/news/[id]/approva/route.ts',
    ]
    const senzaGate = attesi.filter((rel) => !FILES.find((f) => f.rel === rel)?.src.includes('gateConsensoFoto'))
    expect(senzaGate, 'una delle quattro rotte storiche ha perso la chiamata al gate').toEqual([])
  })
})
