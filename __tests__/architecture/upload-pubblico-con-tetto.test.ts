import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ESTENSIONI_ALLEGATO_PUBBLICO,
  MIME_ALLEGATO_PUBBLICO,
  TETTO_UPLOAD_CANDIDATURE,
  TETTO_UPLOAD_PERSONALE,
  TETTO_UPLOAD_PUBBLICO,
} from '@/lib/upload/allegati-pubblici'

/**
 * LOCK · un handler PUBBLICO che scrive nello Storage ha un tetto per IP e una lista di tipi.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA STORIA (collaudo del 2026-08-02, sicurezza F1). `POST /api/iscrizione/upload` accettava
 * caricamenti ANONIMI nel bucket dei documenti d'iscrizione dei minori senza tetto per IP e
 * senza allowlist di tipo, mentre le tre rotte sorelle dello stesso wizard pubblico ce
 * l'avevano tutte. Misurato dal vivo: dieci POST di fila, dieci risposte dell'handler, mai
 * un 429; la stessa prova su `/api/iscrizione` si ferma al quinto tentativo.
 *
 * PERCHÉ NESSUN LOCK LA VEDEVA. Perché la regola era stata applicata a una LISTA CHIUSA di
 * rotte invece che a tutti gli handler pubblici, e `gate-coverage.test.ts` esentava proprio
 * quella riga dichiarando «tetto di dimensione» — che c'era davvero, mentre il tetto di
 * FREQUENZA e la lista dei tipi non c'erano e nessun test li pretendeva. È la forma di
 * difetto che questo ciclo ha già corretto tre volte: una regola giusta, e una porta accanto.
 *
 * PERCHÉ QUESTO FILE È SCRITTO AL CONTRARIO. Non c'è nessun elenco di rotte da controllare:
 * l'elenco lo RICAVA dal codice — ogni `route.ts` che scrive su Storage e non ha un gate
 * d'identità — così una rotta di upload che nascesse domani entra nel perimetro da sola. Un
 * lock con la lista dentro avrebbe lo stesso difetto delle rotte che sorveglia.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd()
const API = path.join(RADICE, 'src', 'app', 'api')
const MIGRAZIONI = path.join(RADICE, 'supabase', 'migrations')

/** Gli stessi gate primitivi di `gate-coverage.test.ts`: chi stabilisce l'identità. */
const GATE = new RegExp(
  '\\b(?:requireStaff|requireDocente|requireUser|requireKitchenRead|requireParentOfStudent' +
    '|requireFunzione|requireArea|loadAppUser|resolveIdentity|resolveSessionAppId|sealDangerous' +
    '|genitoreHasFiglio)\\s*\\(|CRON_SECRET|\\bauth\\s*\\.\\s*getUser\\s*\\(',
)

/** Commenti via, stringhe intatte: senza, una regola citata in un commento passerebbe per codice. */
function senzaCommenti(sorgente: string): string {
  return sorgente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

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

type Rotta = { rel: string; src: string }

const TUTTE: Rotta[] = routeFiles(API).map((f) => ({
  rel: path.relative(RADICE, f).split(path.sep).join('/'),
  src: senzaCommenti(fs.readFileSync(f, 'utf8')),
}))

/** Le rotte che CARICANO un file nello Storage. */
const DI_UPLOAD = TUTTE.filter((r) => /\.\s*storage\b/.test(r.src) && /\.\s*upload\s*\(/.test(r.src))

/** Fra quelle, le PUBBLICHE: nessun gate d'identità in tutto il file. */
const PUBBLICHE = DI_UPLOAD.filter((r) => !GATE.test(r.src))

// ─── la dichiarazione del bucket, letta dalle migrazioni ─────────────────────

function statementDelleMigrazioni(): string[] {
  const out: string[] = []
  for (const file of fs.readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()) {
    const testo = fs
      .readFileSync(path.join(MIGRAZIONI, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
    for (const sql of testo.split(';')) if (sql.trim()) out.push(sql)
  }
  return out
}

const STATEMENT = statementDelleMigrazioni()

/** L'ULTIMA lista di tipi dichiarata in migrazione per il bucket indicato. */
function mimeDichiarati(bucket: string): string[] {
  let ultimi: string[] = []
  for (const sql of STATEMENT) {
    if (!/storage\.buckets/i.test(sql) || !new RegExp(`'${bucket}'`).test(sql)) continue
    const sorgente = sql.match(/allowed_mime_types\s*=\s*(array\s*\[[\s\S]*?\])/i)?.[1]
    if (!sorgente) continue
    const trovati = [...sorgente.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((m) => m[1])
    if (trovati.length) ultimi = trovati
  }
  return ultimi
}

/** L'ULTIMO limite di dimensione dichiarato in migrazione per il bucket indicato. */
function limiteDichiarato(bucket: string): number | null {
  let ultimo: number | null = null
  for (const sql of STATEMENT) {
    if (!/storage\.buckets/i.test(sql) || !new RegExp(`'${bucket}'`).test(sql)) continue
    const assegnati = [...sql.matchAll(/file_size_limit\s*=\s*(\d+)/gi)]
    if (assegnati.length) ultimo = Number(assegnati[assegnati.length - 1][1])
  }
  return ultimo
}

const ordinati = (v: readonly string[]) => [...new Set(v)].sort()

describe('lock architettura · gli upload da una porta aperta hanno tetto e tipi', () => {
  it('la misura vede davvero le rotte (se cade, tutto il resto è verde su niente)', () => {
    // Un rilevatore rotto — cartella sbagliata, regex che non aggancia più `.upload(` —
    // renderebbe verdi per sempre tutte le prove qui sotto, su un elenco vuoto.
    expect(TUTTE.length).toBeGreaterThan(200)
    expect(DI_UPLOAD.length).toBeGreaterThanOrEqual(10)
    // La TERZA è arrivata l'11/08/2026: `iscrizione/personale/upload` riceve la
    // scansione del documento d'identità di chi già lavora qui, sul bucket separato
    // `documenti_personale`. È entrata in questo elenco senza che nessuno la
    // aggiungesse a mano — è il punto del lock, che ricava le rotte dal codice — e
    // passa le prove qui sotto perché è stata scritta copiando la sorella.
    //
    // La QUARTA è arrivata il 15/08/2026: `iscrizione/insegnanti/upload` riceve il
    // curriculum di chi si candida da `/lavora-con-noi`. Scrive in `form_attachments`
    // — lo STESSO bucket delle due porte delle famiglie, cioè quello dei documenti
    // d'iscrizione dei minori — sotto il prefisso `candidature/`, e il suo tetto è
    // `TETTO_UPLOAD_CANDIDATURE` (la prova sta più in basso, con la sua aritmetica).
    //
    // ⚠️ IL MESSAGGIO DI QUESTA ASSERZIONE DICEVA IL FALSO, e la quarta rotta lo ha
    // misurato. Diceva: «Se ne compare una in più va bene: deve solo passare le prove
    // qui sotto». Non è ciò che il codice fa: l'asserzione è un `toEqual` su un elenco
    // ESATTO, quindi il 15/08 la rotta nuova ha reso rosso proprio questo punto, e non
    // per un difetto suo — passa tutte le prove qui sotto. Chi legge un messaggio che
    // promette il contrario di ciò che l'asserzione fa conclude che il rosso sia un
    // guasto del lock, e la reazione più rapida a un lock che «sbaglia» è spegnerlo.
    //
    // Il messaggio adesso dice il contratto vero, che è anche quello che si vuole: una
    // porta di caricamento ANONIMA in più è una decisione, e passa da qui perché
    // qualcuno la veda — insieme al tetto che le si dà, che va dichiarato accanto alla
    // sua costante e provato nel test dell'aritmetica in fondo a questo file.
    expect(
      PUBBLICHE.map((r) => r.rel).sort(),
      'Le rotte di upload senza sessione sono queste, ESATTAMENTE queste. Se ne compare ' +
        'una in più questo punto diventa rosso apposta: una porta anonima che scrive nello ' +
        'Storage è una decisione, e va aggiunta qui A MANO insieme alla prova del suo tetto ' +
        '(il test dell’aritmetica, in fondo al file). Se ne SPARISCONO, il rilevatore non ' +
        'riconosce più i gate e questo lock ha smesso di controllare qualcosa.',
    ).toEqual([
      'src/app/api/iscrizione/insegnanti/upload/route.ts',
      'src/app/api/iscrizione/personale/upload/route.ts',
      'src/app/api/iscrizione/upload/route.ts',
      'src/app/api/public/forms/[token]/upload/route.ts',
    ])
  })

  it('il rilevatore riconosce i gate: una rotta protetta non finisce fra le pubbliche', () => {
    // CONTROLLO POSITIVO all'incontrario: `chat/upload` e `avvisi/upload` hanno un gate, e
    // devono restare fuori dal perimetro. Se ci finissero dentro, le prove sotto sarebbero
    // rosse per un motivo sbagliato — ed è il modo più rapido perché un lock venga spento.
    const protette = DI_UPLOAD.filter((r) => GATE.test(r.src)).map((r) => r.rel)
    expect(protette).toContain('src/app/api/chat/upload/route.ts')
    expect(protette).toContain('src/app/api/avvisi/upload/route.ts')
  })

  it.each(PUBBLICHE.map((r) => r.rel))('`%s` ha un tetto per IP', (rel) => {
    const src = PUBBLICHE.find((r) => r.rel === rel)!.src
    expect(
      /rateLimit\s*\(/.test(src) && /clientIp\s*\(/.test(src),
      `${rel} scrive nello Storage senza sapere chi chiama e senza un tetto per indirizzo: ` +
        'dieci richieste di fila arrivano tutte all\'handler, e nel bucket ci finisce quello ' +
        'che vogliono. È il difetto misurato il 2026-08-02 su `iscrizione/upload`.',
    ).toBe(true)
    // ⚠️ QUESTA PROVA È CAMBIATA IL 13/08/2026, e la differenza è precisa.
    //
    // Pretendeva il nome `TETTO_UPLOAD_PUBBLICO`, cioè UN numero per tutte le porte. Ma
    // le porte non hanno la stessa aritmetica: le due delle famiglie scrivono in
    // `form_attachments` (4,2 allegati a domanda, 5 domande per finestra), quella del
    // personale in `documenti_personale` (13 dipendenti × 2 facce dietro un solo NAT).
    // Chiamarle «la stessa regola» ha prodotto, il 12/08, un +50% sulle porte dei minori
    // per un bisogno che era di un'altra porta.
    //
    // Ciò che il lock difende resta identico e non si è indebolito: **il numero non si
    // scrive dentro la rotta**. Deve arrivare da `@/lib/upload/allegati-pubblici`, dove
    // vive accanto alla misura che lo giustifica. È l'invariante di `gallery` (50 MB nel
    // bucket, 200 nella route, per mesi), e vale per un numero scritto a mano ovunque —
    // compresa una costante locale che si chiamasse `TETTO_UPLOAD_QUALCOSA`.
    const usati = [...src.matchAll(/\bTETTO_UPLOAD_[A-Z_]+\b/g)].map((m) => m[0])
    expect(
      usati.length,
      `${rel} non usa nessun tetto condiviso: il numero è scritto a mano dentro la rotta ` +
        '(o non c\'è). I tetti vivono in src/lib/upload/allegati-pubblici.ts, dove accanto ' +
        'c\'è l\'aritmetica che li giustifica.',
    ).toBeGreaterThan(0)
    for (const nome of new Set(usati)) {
      expect(
        new RegExp(
          `import\\s*\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*['"]@/lib/upload/allegati-pubblici['"]`,
          's',
        ).test(src),
        `${rel} usa \`${nome}\` senza importarlo da @/lib/upload/allegati-pubblici: è un ` +
          'numero locale travestito da costante condivisa, cioè il difetto di `gallery` con ' +
          'un nome che lo nasconde meglio.',
      ).toBe(true)
    }
  })

  it.each(PUBBLICHE.map((r) => r.rel))('`%s` passa dal gate condiviso sui tipi', (rel) => {
    const src = PUBBLICHE.find((r) => r.rel === rel)!.src
    expect(
      /verificaAllegatoPubblico\s*\(/.test(src),
      `${rel} non chiama \`verificaAllegatoPubblico\`: il tipo dichiarato dal client tornerebbe ` +
        "a essere l'unica cosa che decide, su una porta a cui bussa chiunque.",
    ).toBe(true)
    expect(
      /contentType:\s*gate\.contentType/.test(src),
      `${rel} passa allo Storage un contentType che non viene dal gate: con ` +
        '`application/octet-stream` un file valido verrebbe respinto DOPO il caricamento, ' +
        'appena il bucket dichiara i suoi tipi.',
    ).toBe(true)
  })

  it('ogni tetto regge l’aritmetica della SUA porta, e non cresce in silenzio', () => {
    // ⚠️ QUESTA PROVA HA AVUTO TRE FORME IN DUE GIORNI, e le due sbagliate insegnano più
    // di quella giusta.
    //
    //  · fino all'11/08 chiedeva `>= 20` a un numero solo: difendeva l'aritmetica delle
    //    famiglie mentre le facce del documento del personale erano diventate due, cioè
    //    difendeva un conto che nessuno rifaceva più;
    //  · il 12/08 è diventata `>= 26` sullo STESSO numero solo — che ha portato a 30 il
    //    tetto delle due porte dei minori per un fabbisogno che era della terza.
    //
    // La forma giusta è una prova PER PORTA, perché le aritmetiche sono due:
    //
    //  · FAMIGLIE (2026-08-02) — 961 allegati per 227 domande = 4,2 file a domanda, e gli
    //    INVII sono 5 ogni 10 minuti per IP: cinque domande complete ≈ 21 file. Il valore
    //    in vigore è 20 e resta quello finché nessuno misura i 429 di quella porta.
    //  · PERSONALE (2026-08-12) — ogni persona consegna DUE scansioni, e quel modulo si
    //    compila in gruppo dietro il NAT della sede: Giugliano ha 13 account di personale,
    //    quindi 13 × 2 = 26.
    //
    // Dal 15/08/2026 le aritmetiche sono TRE, e la terza è la più stretta:
    //
    //  · CANDIDATURE (2026-08-15) — `/lavora-con-noi` ha UN campo file, cioè un
    //    curriculum per candidatura: non 4,2 allegati e non due facce. E gli INVII di
    //    quella porta sono già chiusi a 3 all'ora per IP (`iscrizione/insegnanti:POST`),
    //    quindi al massimo 3 nella finestra di dieci minuti di questo contatore:
    //
    //        1 curriculum × 3 invii ammessi × 2 tentativi a testa = 6
    //
    //    I due tentativi sono i due modi in cui il primo caricamento fallisce davvero —
    //    413 (oltre il limite della piattaforma) e 415 (il `.docx`, che è il formato in
    //    cui la maggioranza dei curriculum viaggia e che questo bucket non ammette).
    //
    // ⚠️ DAL 2026-08-24 IL NUMERO NON CAMBIA MA LA POSTA SÌ, e va detto qui perché
    // è il posto in cui si decide se 6 basta. Fino al 23 agosto il caricamento era
    // un passo FACOLTATIVO: un 429 su quella porta voleva dire «non puoi
    // allegare», e la candidatura partiva lo stesso. Da quando il curriculum è
    // OBBLIGATORIO, lo stesso 429 vuol dire «non puoi candidarti» — un rifiuto che
    // chiude la porta invece di limarla, su un modulo pubblico e senza login, dove
    // chi lo riceve non ha nessuno a cui chiedere.
    //
    // L'aritmetica regge lo stesso (3 invii ammessi × 2 tentativi = 6, e il
    // vincolo stretto resta il tetto degli INVII), quindi il valore non si tocca:
    // alzarlo «per sicurezza» su una porta anonima che scrive nel bucket dei
    // minori sarebbe il contrario della sicurezza. Ma chi un giorno vedrà dei 429
    // su `TETTO_UPLOAD_CANDIDATURE` sappia che sta guardando persone che non
    // riescono a candidarsi, non allegati mancanti.
    expect(
      TETTO_UPLOAD_PUBBLICO,
      'il tetto delle porte delle famiglie è sceso sotto le cinque domande complete che ' +
        "l'aritmetica del 02/08/2026 misura: dal tetto in poi la famiglia prende 429",
    ).toBeGreaterThanOrEqual(20)
    // Il soffitto delle porte delle famiglie NON è 30: quel numero è stato il segno del
    // difetto, non una soglia. Sopra i 21 non c'è nessuna misura che lo giustifichi, e un
    // tetto alzato «per sicurezza» su una porta anonima che scrive nel bucket dei minori è
    // il contrario della sicurezza.
    expect(
      TETTO_UPLOAD_PUBBLICO,
      'il tetto delle porte delle famiglie è cresciuto oltre la sua aritmetica: se serve ' +
        'davvero, si misuri prima quanti 429 quella porta ha servito',
    ).toBeLessThanOrEqual(21)

    expect(
      TETTO_UPLOAD_PERSONALE,
      'sotto i 26 una sede intera del personale (13 persone × 2 facce) non riesce a ' +
        'consegnare le scansioni nello stesso pomeriggio: dal tetto in poi prende 429',
    ).toBeGreaterThanOrEqual(26)
    // Sopra i 30 un tetto per IP smette di essere un tetto. Chi ha bisogno di più rifaccia
    // il conto delle persone in servizio invece di aggiungere un margine al margine.
    expect(TETTO_UPLOAD_PERSONALE).toBeLessThanOrEqual(30)

    expect(
      TETTO_UPLOAD_CANDIDATURE,
      'sotto i 6 chi si candida non ha nemmeno un secondo tentativo: il primo caricamento ' +
        'che cade su un 413 o su un 415 (il `.docx`) consuma uno slot, e la candidatura ' +
        'resta ferma con un 429 indistinguibile da un servizio rotto',
    ).toBeGreaterThanOrEqual(6)
    // ⚠️ QUI IL SOFFITTO COINCIDE COL PAVIMENTO, e a differenza delle altre due porte non
    // è una svista: è l'unica delle tre che NON ha un margine, e la ragione sta accanto
    // alla costante. Un caricamento oltre il sesto non può diventare una candidatura —
    // l'INVIO è già chiuso a 3 all'ora — quindi sarebbe soltanto un oggetto in più dentro
    // `form_attachments`, cioè dentro il bucket che custodisce i documenti d'iscrizione
    // dei minori. Su una porta ANONIMA che scrive lì, un tetto che eccede il numero di
    // invii possibili è spazio regalato e nient'altro.
    expect(
      TETTO_UPLOAD_CANDIDATURE,
      'il tetto dei curriculum è cresciuto oltre gli invii che quella porta ammette: ogni ' +
        'slot in più non produce una candidatura, produce un oggetto in più nel bucket dei ' +
        'minori. Si alza PRIMA il tetto degli invii (`limit` in `iscrizione/insegnanti:POST`), ' +
        'e questo dopo',
    ).toBeLessThanOrEqual(6)

    // ⚠️ E LA DERIVAZIONE SI MISURA, non si racconta. Il commento qui sopra dice che 6
    // discende dal tetto degli INVII (3 all'ora) moltiplicato per due tentativi; scritto
    // solo in prosa, quel «3» invecchia da solo — è già successo in `gate-coverage`, dove
    // una motivazione ha dichiarato «tetto 3 invii/ora» per un giro intero dopo che la
    // rotta era passata a 20, restando verde. Qui il numero si legge dal CODICE della
    // rotta degli invii: se qualcuno lo cambia senza rifare questo conto, il lock lo dice.
    const SRC_INVII = path.join(RADICE, 'src', 'app', 'api', 'iscrizione', 'insegnanti', 'route.ts')
    const invii = Number(
      /rateLimit\s*\(\s*`candidature-insegnanti:[^`]*`\s*,\s*\{[^}]*\blimit:\s*(\d+)/.exec(
        senzaCommenti(fs.readFileSync(SRC_INVII, 'utf8')),
      )?.[1],
    )
    expect(
      Number.isFinite(invii),
      'Il tetto degli INVII di `iscrizione/insegnanti:POST` non si legge più: la chiave del ' +
        'contatore o la forma della chiamata sono cambiate. Senza quel numero la prova qui ' +
        'sotto non misura niente — sistemare la lettura, non toglierla.',
    ).toBe(true)
    expect(
      TETTO_UPLOAD_CANDIDATURE,
      `il tetto dei caricamenti (${TETTO_UPLOAD_CANDIDATURE}) non è più il doppio degli invii ` +
        `ammessi (${invii}): uno dei due è stato mosso da solo. L'aritmetica sta accanto alla ` +
        'costante in src/lib/upload/allegati-pubblici.ts — si rifà lì, non si aggiusta qui.',
    ).toBe(invii * 2)

    // E i tre numeri NON devono coincidere per caso: se un giorno due tornassero uguali, la
    // prova per porta smetterebbe di distinguere e si tornerebbe al numero unico senza che
    // nessuno lo decida. (Se un domani coincidessero per una ragione vera, questa riga va
    // tolta CONSAPEVOLMENTE, che è appunto il punto.)
    //
    // La riga era una sola coppia fino al 14/08/2026 (`PERSONALE ≠ PUBBLICO`): con la terza
    // porta le coppie sono tre, e controllarne una su tre sarebbe stato il modo esatto in cui
    // questo lock si allarga in silenzio — la stessa forma del difetto che il file racconta
    // in testa, una regola giusta e una porta accanto.
    const tetti = [TETTO_UPLOAD_PUBBLICO, TETTO_UPLOAD_PERSONALE, TETTO_UPLOAD_CANDIDATURE]
    expect(
      new Set(tetti).size,
      'Due tetti di porte diverse sono tornati allo stesso numero: da qui a riunirli in una ' +
        'costante sola il passo è corto, ed è il difetto del 12/08/2026 (il fabbisogno di una ' +
        'porta che allenta le altre). Le aritmetiche sono tre e restano tre.',
    ).toBe(tetti.length)
  })

  it('la lista dei tipi non diventa «passa tutto» (controllo negativo)', () => {
    for (const vietato of [
      'text/html',
      'text/plain',
      'image/svg+xml',
      'application/octet-stream',
      'application/x-msdownload',
    ]) {
      expect(
        (MIME_ALLEGATO_PUBBLICO as readonly string[]).includes(vietato),
        `\`${vietato}\` è entrato fra i tipi ammessi su una porta ANONIMA. Allargare la lista ` +
          'in silenzio è il modo elegante di disattivare questo lock: HTML e SVG portano ' +
          'script, e `octet-stream` è l\'etichetta con cui passa qualunque cosa.',
      ).toBe(false)
    }
    // CONTROLLO POSITIVO: la lista serve ancora a qualcosa.
    expect((MIME_ALLEGATO_PUBBLICO as readonly string[]).includes('application/pdf')).toBe(true)
    expect((ESTENSIONI_ALLEGATO_PUBBLICO as readonly string[]).includes('exe')).toBe(false)
  })

  it('il bucket `form_attachments` dichiara in migrazione gli stessi tipi del gate', () => {
    const dichiarati = mimeDichiarati('form_attachments')
    expect(
      dichiarati.length,
      'Nessuna migrazione dichiara `allowed_mime_types` per `form_attachments`. Con la ' +
        'colonna a NULL il bucket accetta qualunque tipo, e l\'unica difesa torna a essere ' +
        'quella applicativa: basta la prossima rotta che dimentichi il gate.',
    ).toBeGreaterThan(0)
    expect(
      ordinati(dichiarati),
      'I tipi del bucket e quelli di `MIME_ALLEGATO_PUBBLICO` devono COINCIDERE: se il ' +
        'bucket è più stretto il file viene respinto dopo il caricamento (500 opaco), se è ' +
        'più largo la migrazione dichiara una sicurezza che non esiste.',
    ).toEqual(ordinati(MIME_ALLEGATO_PUBBLICO))
  })

  it('il bucket `form_attachments` dichiara un limite di dimensione', () => {
    expect(
      limiteDichiarato('form_attachments'),
      'Il bucket dei documenti d\'iscrizione non ha un `file_size_limit`: il freno vive solo ' +
        'dentro le route, e vale finché ogni route se lo ricorda.',
    ).toBeGreaterThan(0)
  })
})
