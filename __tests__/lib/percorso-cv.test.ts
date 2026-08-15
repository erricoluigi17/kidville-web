import { describe, it, expect } from 'vitest'
import {
  CV_ESTENSIONI,
  CV_MAX_LUNGHEZZA,
  CV_PREFISSO,
  costruisciPercorsoCv,
  formaCvAmmessa,
  percorsoCvAmmesso,
} from '@/lib/candidature/percorso-cv'
import {
  ESTENSIONI_ALLEGATO_PUBBLICO,
  MIME_ALLEGATO_PUBBLICO,
  estensioneArchiviata,
} from '@/lib/upload/allegati-pubblici'

// =============================================================================
// IL PERCORSO DI UN CURRICULUM — la sutura fra la porta che lo SCRIVE e il gate
// che lo ACCETTA.
//
// ── PERCHÉ QUESTA SUITE ESISTE ──────────────────────────────────────────────
//
// `@/lib/candidature/percorso-cv` è nato il 15/08/2026 e la sua testata promette
// testualmente che «`__tests__/lib/percorso-cv.test.ts` genera percorsi con tutte
// le estensioni ammesse e lo verifica». Fino a questo file quel banco di prova
// non esisteva: la frase descriveva un presidio che non c'era, che è la forma di
// documentazione che questo repo si è già scritto in `CLAUDE.md` come la peggiore
// («un documento che descrive uno stato che non c'è più è peggio di nessun
// documento»).
//
// ── CHE COSA SI ROMPE SE LA SUTURA SI SPEZZA ────────────────────────────────
//
// `costruisciPercorsoCv` produce il percorso in `iscrizione/insegnanti/upload:POST`;
// `percorsoCvAmmesso` decide, in `iscrizione/insegnanti:POST`, se accettare il
// percorso che il modulo dichiara. Vivono nello stesso modulo proprio perché devono
// combaciare: il giorno in cui divergessero — il nome fisso cambiato da una parte
// sola, un'estensione tolta dall'elenco — il caricamento riuscirebbe e l'invio
// rifiuterebbe il percorso del PROPRIO allegato, dopo che chi si candida ha
// compilato tre passi. Nessuna delle due funzioni, letta da sola, mostra quel
// difetto: si vede solo guardandole insieme, cioè qui.
//
// ── CHE COSA QUESTA SUITE NON DIMOSTRA ──────────────────────────────────────
//
// Non dimostra che il gate GIRI. È la lezione pagata sul gemello del personale
// (`percorso-documento.test.ts`, 12/08/2026): diciotto prove verdi su una funzione
// che nessuno chiamava più, perché il campo del template si era rinominato e la
// rotta leggeva il nome vecchio. Che `iscrizione/insegnanti:POST` chiami davvero
// `percorsoCvAmmesso` lo prova `__tests__/api/candidature-insegnanti-post.test.ts`,
// che passa dalla rotta vera. Dell'altra estremità — `iscrizione/insegnanti/upload:POST`,
// che il percorso lo COSTRUISCE — al 15/08/2026 non esiste nessun test di route:
// `grep -rln 'insegnanti/upload' __tests__` trova soltanto il lock del tetto per IP
// (`architecture/upload-pubblico-con-tetto.test.ts`). Qui si prova soltanto che,
// QUANDO vengono chiamate, le due funzioni combaciano e respingono il resto.
//
// ── PERCHÉ IL RIFIUTO DI QUESTA FUNZIONE VALE ───────────────────────────────
//
// `cv_path` arriva da un ANONIMO — `/lavora-con-noi` non ha login — e diventa la
// chiave con cui la Segreteria si fa firmare un oggetto di `form_attachments`, cioè
// il bucket dove stanno anche i documenti d'iscrizione dei minori. Ogni rifiuto qui
// sotto si misura ACCANTO al suo controllo positivo: senza, una funzione che
// rispondesse `false` a qualunque cosa passerebbe l'intera suite — verde, e col
// curriculum diventato inallegabile per chi ha compilato il modulo per davvero.
// =============================================================================

/** Un uuid v4 in minuscolo, come lo scrive `crypto.randomUUID()` sul server. */
const UUID = '0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f'

/**
 * La forma canonica, RIBATTUTA a mano e non importata.
 *
 * Il nome fisso (`-cv.`) nel modulo è una costante NON esportata, e qui si riscrive
 * di proposito: importarla renderebbe questo banco di prova una tautologia, mentre
 * riscriverla è l'unico modo in cui il giorno in cui diventasse `-curriculum.` la
 * suite diventa rossa invece di seguire il codice. È esattamente il difetto che il
 * commento su `CV_NOME` descrive — un caricamento riuscito e un invio che rifiuta.
 */
const canonico = (ext = 'pdf'): string => `${CV_PREFISSO}${UUID}-cv.${ext}`

/**
 * Il controllo positivo e il rifiuto nella STESSA asserzione.
 *
 * `motivo` finisce nel messaggio d'errore perché un rosso su questa suite deve dire
 * da solo quale difesa è caduta: chi lo legge sta guardando un gate su una porta
 * anonima, non un test di formato.
 */
function rifiutato(percorso: string, motivo: string): void {
  expect(
    percorsoCvAmmesso(canonico()),
    'il controllo positivo è caduto: la funzione respinge ANCHE la forma canonica, ' +
      'quindi i rifiuti qui sotto non dimostrano niente',
  ).toBe(true)
  expect(percorsoCvAmmesso(percorso), motivo).toBe(false)
}

/**
 * Rifiutato DALLA FORMA, non dall'elenco delle estensioni.
 *
 * `formaCvAmmessa` è esportata per questa ragione sola, e sta scritto nel modulo
 * accanto all'export. La distinzione non è teorica: sul gemello del personale,
 * togliendo l'àncora `$` dalla regex (mutazione provata il 12/08/2026), quasi tutti
 * i rifiuti restavano verdi perché cadevano sull'ESTENSIONE, e l'unico che diventava
 * verde era il peggiore — quello che finisce con un'estensione legittima. Dove il
 * difetto è la forma, si misura la forma.
 */
function rifiutatoDallaForma(percorso: string, motivo: string): void {
  rifiutato(percorso, motivo)
  expect(formaCvAmmessa(percorso), `${motivo} — e la FORMA da sola lo lascia passare`).toBe(false)
}

describe('CV_ESTENSIONI — l’elenco arriva dal gate pubblico, non da una lista sua', () => {
  it('coincide con `ESTENSIONI_ALLEGATO_PUBBLICO`', () => {
    // ⚠️ IL CONFRONTO NON È RIDONDANTE, ed è la conseguenza di come la lista è
    // costruita: `CV_ESTENSIONI` NON importa questa costante — non può, perché
    // `@/lib/upload/allegati-pubblici` tira dentro `next/server` — e la ricava
    // leggendo l'`accept` del campo `cv_path` nel template. È una lettura
    // INDIRETTA, cioè una copia che può divergere: se domani l'`accept` del
    // template guadagnasse un formato che il bucket non ammette, il gate d'invio
    // accetterebbe un percorso che la rotta di caricamento non può produrre.
    expect([...CV_ESTENSIONI].sort()).toEqual([...ESTENSIONI_ALLEGATO_PUBBLICO].sort())
  })

  it('non è vuoto — una lista vuota chiuderebbe il modulo in silenzio', () => {
    // La lettura passa da `INSEGNANTE_FIELDS.find(f => f.id === 'cv_path')?.accept ?? ''`:
    // un rinomino del campo (è già successo sul modulo del personale, `documento_path`
    // → `documento_fronte_path`) non rompe niente in compilazione e lascia la lista
    // VUOTA. Da lì `percorsoCvAmmesso` respinge OGNI percorso, compreso quello che la
    // rotta di caricamento ha appena scritto: il curriculum smette di essere
    // allegabile, e nessun errore lo dice.
    expect(CV_ESTENSIONI.length, 'elenco vuoto: nessun percorso sarebbe più ammesso').toBeGreaterThan(0)
  })
})

describe('costruisciPercorsoCv — ciò che produce, il gate lo accetta', () => {
  it('per OGNI estensione ammessa', () => {
    // È la promessa scritta nella testata del modulo, ed è il punto di questa suite:
    // le due funzioni si misurano INSIEME, su tutte le estensioni, non su `pdf`.
    for (const ext of CV_ESTENSIONI) {
      const percorso = costruisciPercorsoCv(ext)
      expect(formaCvAmmessa(percorso), `la forma prodotta con «${ext}» non è quella attesa`).toBe(true)
      expect(
        percorsoCvAmmesso(percorso),
        `un curriculum «.${ext}» viene caricato e poi il modulo ne rifiuta il percorso`,
      ).toBe(true)
    }
  })

  it('per ogni TIPO che la rotta di caricamento archivia davvero', () => {
    // La catena vera, dal capo: `iscrizione/insegnanti/upload:POST` non riceve
    // un'estensione, riceve un file. L'estensione la ricava da
    // `estensioneArchiviata(gate.contentType)` — dal TIPO normalizzato, mai dal nome
    // — e la passa a `costruisciPercorsoCv`. Se le due mappe divergessero (`jpeg` di
    // là, solo `jpg` di qua) il file sarebbe caricato per davvero e l'invio
    // rifiuterebbe il proprio allegato: un difetto visibile solo guardando le due
    // estremità insieme.
    for (const mime of MIME_ALLEGATO_PUBBLICO) {
      const ext = estensioneArchiviata(mime)
      expect(ext, `«${mime}» non produce nessuna estensione`).toBeTruthy()
      expect(
        percorsoCvAmmesso(costruisciPercorsoCv(ext ?? '')),
        `un file «${mime}» resta nel bucket come «.${ext}», e il gate d’invio lo respinge`,
      ).toBe(true)
    }
  })

  it('produce SOLO la forma canonica: tolto l’uuid, quel che resta è una costante', () => {
    // Il modo diretto di dire che nel percorso non c'è nessuna variabile oltre
    // all'uuid — nessun nome, nessuna cartella, nessun residuo della richiesta.
    const percorso = costruisciPercorsoCv('pdf')
    const senzaUuid = percorso.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, '')
    expect(senzaUuid, 'nel percorso è comparsa una parte che non è né il prefisso né il nome fisso').toBe(
      `${CV_PREFISSO}-cv.pdf`,
    )
    expect(percorso).toMatch(new RegExp(`^${CV_PREFISSO}`))
  })

  it('IL NOME DEL FILE non può entrarci: la firma prende un argomento solo', () => {
    // ⚠️ SI MISURA L'ARITÀ, e non è una prova di stile. In produzione quel nome è
    // `cv-<cognome>.pdf` — lo dice `gdpr/retention-candidature:POST`, dove sta
    // scritto che «quel nome È il cognome di chi si è candidato» — e il percorso
    // finisce in una colonna, dentro un URL firmato che lo porta in chiaro e, se
    // qualcuno si distrae, dentro un log. Oggi non c'è nessun modo di farcelo
    // entrare perché non c'è nessun parametro in cui passarlo: il giorno in cui
    // qualcuno ne aggiungesse un secondo «per ritrovare i file», questa riga diventa
    // rossa PRIMA che il primo cognome finisca in un bucket.
    expect(costruisciPercorsoCv.length, 'la funzione ha guadagnato un secondo argomento').toBe(1)

    // E il controllo dall'altra parte: comunque si chiami il file scelto dal
    // browser, di quel nome nel percorso non resta un byte. L'uuid è esadecimale,
    // quindi nemmeno per caso può contenere queste lettere.
    const percorso = costruisciPercorsoCv('pdf')
    for (const pezzo of ['Esposito', 'esposito', 'Maria', 'curriculum', 'cv-Esposito']) {
      expect(percorso, `il percorso contiene «${pezzo}»`).not.toContain(pezzo)
    }
  })

  it('due caricamenti non producono mai lo stesso percorso', () => {
    // L'indice unico parziale `candidature_insegnanti_cv_unico` (migrazione
    // `20260814225302_candidature_posizioni_cv`) rende una collisione un `23505`,
    // che la porta pubblica traduce in un 400 sul campo `cv_path`. Cioè: due percorsi
    // uguali non sono un doppione innocuo, sono una candidatura che non si può
    // inviare. Duecento giri, che è più di quante candidature siano mai arrivate.
    const visti = new Set<string>()
    for (let i = 0; i < 200; i++) visti.add(costruisciPercorsoCv('pdf'))
    expect(visti.size, 'due percorsi identici: il secondo curriculum prende un 400').toBe(200)
  })

  it('non ripulisce niente — ed è il motivo per cui la rotta ricontrolla ciò che ha appena costruito', () => {
    // `iscrizione/insegnanti/upload:POST` chiama `percorsoCvAmmesso(path)` SUL PROPRIO
    // percorso, subito dopo averlo costruito, e a prima vista è una cintura sopra le
    // bretelle. Non lo è: il costruttore interpola l'estensione così com'è, senza
    // nessuna difesa, quindi la garanzia «per costruzione» vale solo finché
    // l'argomento arriva da `estensioneArchiviata`. Se un domani arrivasse da
    // `file.name`, il ricontrollo è l'unica cosa che impedisce di archiviare un
    // oggetto che poi nessuno può dichiarare.
    expect(percorsoCvAmmesso(costruisciPercorsoCv('pdf.exe'))).toBe(false)
    expect(percorsoCvAmmesso(costruisciPercorsoCv('pdf,x'))).toBe(false)
    expect(percorsoCvAmmesso(costruisciPercorsoCv(''))).toBe(false)
  })
})

describe('percorsoCvAmmesso — il percorso che punta altrove', () => {
  it('un PREFISSO diverso è rifiutato, a cominciare da quello dei documenti dei MINORI', () => {
    // `iscrizioni/…` è ciò che l'altra porta pubblica scrive nello STESSO bucket
    // (`iscrizione/upload:POST`, `iscrizioni/<cartella>/<uuid>-<nome>`): carte
    // d'identità dei genitori e fotografie di bambini. È il percorso che una
    // candidatura non deve poter dichiarare, perché dichiararlo significherebbe
    // farsi firmare quell'oggetto dal cockpit di Segreteria.
    rifiutatoDallaForma(
      `iscrizioni/generico/${UUID}-carta-identita.pdf`,
      'il prefisso dei documenti d’iscrizione dei minori',
    )
    rifiutatoDallaForma(`iscrizioni/${UUID}-cv.pdf`, 'il prefisso dei minori con la forma del curriculum')
    rifiutatoDallaForma(`documenti/${UUID}/${UUID}.pdf`, 'il prefisso del documento del personale')
    rifiutatoDallaForma(`form_attachments/${UUID}-cv.pdf`, 'il nome del bucket usato come prefisso')
    rifiutatoDallaForma(`${UUID}-cv.pdf`, 'nessun prefisso')
    rifiutatoDallaForma(`/${canonico()}`, 'percorso assoluto')
    rifiutatoDallaForma(`altro/${canonico()}`, 'il prefisso giusto ma non in testa')
    rifiutatoDallaForma(`Candidature/${UUID}-cv.pdf`, 'prefisso con la maiuscola')
    rifiutatoDallaForma(`candidature//${UUID}-cv.pdf`, 'doppia barra dopo il prefisso')
    rifiutatoDallaForma(`candidature/${UUID}/${UUID}-cv.pdf`, 'un segmento in più')
  })

  it('`..` non è nemmeno esprimibile', () => {
    // Fra l'uuid e il punto c'è una stringa fissa, quindi la risalita non ha una
    // posizione in cui stare: si verifica lo stesso, perché è la proprietà che rende
    // sicuro l'uso di questo valore come chiave di Storage.
    rifiutatoDallaForma('candidature/../../etc/passwd', 'traversal esplicito')
    rifiutatoDallaForma(`candidature/../${UUID}-cv.pdf`, 'traversal dopo il prefisso')
    rifiutatoDallaForma(`${canonico()}/..`, 'traversal in coda')
    rifiutatoDallaForma(`candidature/${UUID}-cv..pdf`, 'doppio punto prima dell’estensione')
  })

  it('l’uuid non si negozia: è la parte che chi invia il modulo NON sceglie', () => {
    // Senza l'uuid — che genera il server al momento del caricamento — il solo
    // prefisso non impedirebbe di indicare il curriculum di un'ALTRA candidatura,
    // cioè di farsi firmare l'allegato di un'altra persona.
    rifiutatoDallaForma(`candidature/${UUID.toUpperCase()}-cv.pdf`, 'uuid in maiuscolo')
    rifiutatoDallaForma(`candidature/${UUID.slice(0, 30)}-cv.pdf`, 'uuid troncato')
    rifiutatoDallaForma(`candidature/${UUID}0-cv.pdf`, 'uuid con un carattere in più')
    rifiutatoDallaForma('candidature/non-un-uuid-cv.pdf', 'niente uuid')
    rifiutatoDallaForma(`candidature/${UUID.replace('-', '')}-cv.pdf`, 'uuid senza un trattino')
    rifiutatoDallaForma(`candidature/${UUID}-cv`, 'senza estensione')
    rifiutatoDallaForma(`candidature/${UUID}.pdf`, 'senza il nome fisso')
    rifiutatoDallaForma(CV_PREFISSO, 'il solo prefisso')
    rifiutatoDallaForma('', 'stringa vuota')
  })
})

describe('percorsoCvAmmesso — i caratteri che riscrivono un filtro PostgREST', () => {
  /*
   * DOVE FINISCE QUESTO VALORE, detto una volta: in `admin/candidature-insegnanti:GET`
   * dentro un `.eq('cv_path', docPath)` (due volte: la verifica di sede e quella
   * d'origine). `.eq()` percent-encoda la virgola, quindi oggi non c'è nessuna
   * riscrittura possibile — ma la forma si valida PRIMA, perché è il giorno in cui
   * qualcuno passerà a un filtro composto (`.or(…)`, dove la virgola SEPARA le
   * condizioni) che questi rifiuti difendono qualcosa. La nota per esteso sta su
   * `percorso-documento.ts`, che ha già pagato lo stesso ragionamento.
   */

  it('la VIRGOLA è rifiutata', () => {
    rifiutatoDallaForma(`${canonico()},x`, 'una virgola aggiunge una condizione al filtro')
  })

  it('il payload che finisce con un’estensione LEGITTIMA è rifiutato — ed è il caso che conta', () => {
    // ⚠️ QUESTO È IL CASO CHE L'ELENCO DELLE ESTENSIONI NON PRENDE. La coda è
    // `…-cv.jpg`, cioè un'estensione in elenco: il controllo sull'estensione lo
    // lascerebbe passare, e a rifiutarlo è soltanto la forma.
    //
    // RIMISURATO QUI, non ereditato dal gemello: con la regex della forma privata
    // dell'àncora `$`, questo valore passa la forma (`true`) e l'estensione letta
    // dall'ultimo punto è `jpg`, che è in elenco — quindi `percorsoCvAmmesso` direbbe
    // `true`. Nella stessa mutazione la virgola semplice (`…-cv.pdf,x`) resta rossa,
    // ma per l'estensione (`pdf,x` non è in elenco), non per la forma: senza questa
    // riga la suite dichiarerebbe difesa una regola che ha smesso di difendere
    // proprio nel caso peggiore.
    rifiutatoDallaForma(
      `${canonico()},cv_path.eq.${canonico('jpg')}`,
      'il filtro composto si lascia riscrivere da questo valore',
    )
  })

  it('le PARENTESI sono rifiutate: in PostgREST raggruppano', () => {
    rifiutatoDallaForma(`${canonico()})`, 'una parentesi chiude il gruppo del filtro')
    rifiutatoDallaForma(`(${canonico()}`, 'una parentesi apre un gruppo nel filtro')
    rifiutatoDallaForma(`candidature/or(id.gt.0)-cv.pdf`, 'un gruppo intero infilato nel percorso')
  })

  it('gli APICI sono rifiutati, singoli e doppi', () => {
    rifiutatoDallaForma(`${canonico()}'`, 'un apice singolo chiude una stringa quotata')
    rifiutatoDallaForma(`${canonico()}"`, 'un apice doppio chiude un valore quotato di PostgREST')
    rifiutatoDallaForma(`candidature/"${UUID}"-cv.pdf`, 'uuid quotato')
  })

  it('gli SPAZI sono rifiutati, compresi quelli invisibili', () => {
    rifiutatoDallaForma(`${canonico()} `, 'uno spazio in coda')
    rifiutatoDallaForma(` ${canonico()}`, 'uno spazio in testa')
    rifiutatoDallaForma(`candidature/${UUID}-cv.p df`, 'uno spazio dentro l’estensione')
    rifiutatoDallaForma(`candidature/${UUID} -cv.pdf`, 'uno spazio dopo l’uuid')
    rifiutatoDallaForma(`${canonico()}\t`, 'una tabulazione in coda')
  })

  it('l’A CAPO è rifiutato, e una seconda riga dopo un percorso valido pure', () => {
    // ⚠️ È LA MISURA DELL'ÀNCORA `$`. In JavaScript, senza il flag `m`, `$` àncora
    // alla fine dell'INPUT (misurato: `/^a$/.test('a\n') === false`), a differenza di
    // Perl e Python dove accetta un a capo finale. Il giorno in cui qualcuno
    // aggiungesse `m` alla regex della forma — per un motivo qualunque —
    // `candidature/<uuid>-cv.pdf\nqualunque-cosa` passerebbe, e queste due righe sono
    // l'unico posto in cui la regressione si vede.
    rifiutatoDallaForma(`${canonico()}\n`, 'un a capo in coda')
    rifiutatoDallaForma(`${canonico()}\nqualunque-cosa`, 'una seconda riga dopo un percorso valido')
    rifiutatoDallaForma(`${canonico()}\r\n${canonico('jpg')}`, 'due percorsi validi su due righe')
  })

  it('gli altri metacaratteri non passano', () => {
    for (const metacarattere of [';', '&', '|', '=', '*', '%', '#', '?', '<', '>', '\\', '`', '$', '{', '}', '[', ']', ':']) {
      rifiutatoDallaForma(`${canonico()}${metacarattere}`, `il metacarattere «${metacarattere}» è passato`)
    }
  })
})

describe('percorsoCvAmmesso — la lunghezza e l’estensione', () => {
  it('un’estensione FUORI elenco è rifiutata anche con la forma PERFETTA', () => {
    // È il caso più insidioso, ed è anche il complemento del test sulla virgola: qui
    // la forma dice `true` e a rifiutare è l'elenco. Le due difese si vedono agire
    // separatamente, che è l'unico modo per accorgersi se una delle due smettesse.
    for (const ext of ['exe', 'html', 'svg', 'php', 'js', 'bin', 'zip', 'docx']) {
      expect(formaCvAmmessa(canonico(ext)), `«${ext}»: la forma dovrebbe essere quella giusta`).toBe(true)
      rifiutato(canonico(ext), `l’estensione «${ext}» è passata`)
    }
  })

  it('l’estensione in MAIUSCOLO resta ammessa, ed è una scelta dichiarata', () => {
    // La forma ammette `[A-Za-z0-9]+` e il confronto con l'elenco normalizza a
    // minuscolo. Non è una svista: chi vorrà stringerlo lo farà come decisione, con
    // questa riga davanti — non scoprendo per caso che un caricamento vero veniva
    // respinto. (La rotta di caricamento produce comunque solo minuscole: le
    // estensioni arrivano da `estensioneArchiviata`.)
    expect(percorsoCvAmmesso(canonico('PDF'))).toBe(true)
    expect(percorsoCvAmmesso(canonico('JpG'))).toBe(true)
  })

  it('un percorso oltre `CV_MAX_LUNGHEZZA` è rifiutato', () => {
    rifiutato(`${CV_PREFISSO}${'a'.repeat(CV_MAX_LUNGHEZZA)}`, 'una stringa lunghissima al posto del percorso')
    rifiutato(`candidature/${UUID}-cv.${'a'.repeat(CV_MAX_LUNGHEZZA)}`, 'estensione lunghissima')
    rifiutatoDallaForma(`${canonico()}${'/x'.repeat(CV_MAX_LUNGHEZZA)}`, 'coda lunghissima dopo un percorso valido')
  })

  it('il percorso PIÙ LUNGO che si possa costruire sta molto sotto il tetto', () => {
    // ⚠️ QUESTA È LA MISURA CHE IL COMMENTO DEL MODULO DICHIARA (56 caratteri), e
    // dice anche che cosa il tetto NON è: sui percorsi che la rotta costruisce non
    // decide mai. Il tetto agisce sulla stringa che arriva DA FUORI — il `cv_path`
    // dichiarato da chi invia il modulo — dove non c'è nessuna forma garantita prima
    // di lui, e serve a non far arrivare alla regex una stringa da 10.000 caratteri.
    //
    // Non essendoci nessun caso in cui la lunghezza sia l'UNICA difesa che scatta
    // (ogni percorso lungo che passa la forma ha per forza un'estensione fuori
    // elenco), qui non si finge di misurare quel ramo: si misura il margine, che è
    // ciò che diventa rosso se un giorno la forma si allargasse.
    const piuLunga = [...CV_ESTENSIONI].sort((a, b) => b.length - a.length)[0]
    const piuLungo = costruisciPercorsoCv(piuLunga)
    expect(percorsoCvAmmesso(piuLungo), `l’estensione più lunga («${piuLunga}») è respinta`).toBe(true)
    expect(
      piuLungo.length,
      `il percorso più lungo costruibile è ${piuLungo.length} caratteri e il tetto è ${CV_MAX_LUNGHEZZA}`,
    ).toBeLessThanOrEqual(CV_MAX_LUNGHEZZA)
  })
})

describe('formaCvAmmessa — il predicato non ha memoria fra due chiamate', () => {
  it('lo stesso percorso vale lo stesso, chiamata dopo chiamata', () => {
    // ⚠️ SI MISURA IL COMPORTAMENTO, NON I FLAG DELLA REGEX, e la differenza conta:
    // una regex con `g` o `y` è STATEFUL (`lastIndex` sopravvive fra due `.test()`),
    // quindi lo stesso percorso valido risulterebbe valido, poi non valido, poi
    // valido. Su una porta pubblica è un difetto che si manifesta una candidatura su
    // due — e leggerlo dai flag lo proverebbe solo per la regex di oggi, mentre così
    // vale per qualunque implementazione futura.
    for (let giro = 0; giro < 3; giro++) {
      expect(formaCvAmmessa(canonico()), `giro ${giro}: la forma canonica è stata respinta`).toBe(true)
      expect(percorsoCvAmmesso(canonico()), `giro ${giro}: il gate ha respinto la forma canonica`).toBe(true)
      expect(formaCvAmmessa(`${canonico()},x`), `giro ${giro}: un percorso con la virgola è stato accettato`).toBe(
        false,
      )
    }
  })
})
