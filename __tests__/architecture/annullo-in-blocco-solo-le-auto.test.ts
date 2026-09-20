// @vitest-environment node
/**
 * LOCK · L'ANNULLAMENTO IN BLOCCO TOCCA SOLO LE RIGHE DELLA MACCHINA — E I DUE
 * FILTRI STANNO NELLA STESSA QUERY.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * «Disfa tutto ciò che l'import ha deciso da solo» è una frase innocua finché non
 * si guarda che cosa la esegue. In `riconciliazione_movimenti` le righe
 * `confermato` sono di DUE specie e si distinguono per una colonna sola:
 *   · `abbinato_auto_il` valorizzato → l'ha deciso la macchina all'import;
 *   · `abbinato_auto_il` NULL → **l'ha confermata una persona**, con un click, e
 *     dietro c'è un incasso che qualcuno ha controllato.
 *
 * `NULL` non è un quinto stato: `stato` dice `confermato` in tutt'e due i casi. La
 * marca è l'UNICO appiglio che separa le due specie, e da qui discende la forma
 * esatta del guasto che questo lock impedisce:
 *
 *     .from('riconciliazione_movimenti')
 *     .update({ stato: 'da_abbinare' })
 *     .eq('import_id', importId)
 *     .eq('stato', 'confermato')        // ← e la marca? filtrata DOPO, in JS
 *
 * Una query così non fallisce. Non dà un errore, non dà un log, e restituisce un
 * numero di righe più grande del previsto che nessuno confronta con niente. Ciò
 * che ha fatto è stornare gli incassi che un'operatrice aveva registrato a mano,
 * dentro lo stesso import, sulle righe che la macchina aveva lasciato gialle —
 * cioè esattamente il lavoro che una persona ha fatto perché la macchina non ne
 * era capace.
 *
 * ⚠️ Il filtro va nella STESSA QUERY, non «da qualche parte nell'handler». È la
 * stessa ragione per cui `isolamento-sede-coverage.test.ts` pretende il filtro di
 * sede dentro la query e non nell'handler: un `AND` lo rende vero, un filtro
 * applicato in JavaScript sulle righe già lette arriva dopo che l'`UPDATE` è già
 * passato, e su un `.select()` lascia comunque uscire righe che non dovevano
 * essere lette. Un filtro a valle si può anche spostare, duplicare o dimenticare
 * in un ramo; una clausola dentro la catena no.
 *
 * ─── COM'È NATO QUESTO LOCK, E PERCHÉ LA STORIA VA SCRITTA ──────────────────
 *
 * È stato scritto il 2026-09-20 quando **la rotta dell'annullamento in blocco non
 * esisteva ancora**: il repository la annunciava in tre punti —
 * `…/riconciliazione/[id]/route.ts` («un endpoint nuovo li riaprirà in blocco»),
 * `riapertura-movimento.ts` e il PRD — ma sotto `src/app/api` non c'era.
 *
 * Le due scorciatoie erano tutt'e due sbagliate: puntare a un percorso inventato
 * avrebbe dato un lock ROSSO su un file mai esistito, e «salta se il file manca»
 * avrebbe dato un lock VERDE che non guarda niente — la cecità che questo
 * repository ha già pagato tre volte (`lock-ciechi-audit`, 2026-09-19). Il lock è
 * nato perciò ARMATO e in attesa: le regole scritte per intero, un CENSIMENTO dei
 * file che nominano la marca, e la prova che il rilevatore morde fatta su sorgenti
 * SINTETICI, nei due versi.
 *
 * **Poche ore dopo la rotta è arrivata** (`…/riconciliazione/annulla-import/route.ts`,
 * scritta in parallelo su questo stesso albero) e il censimento l'ha intercettata
 * al primo giro, con il messaggio che dice cosa fare. È dichiarata qui sotto, e da
 * quel momento la regola dei due filtri non è più una buona intenzione in una
 * testata: si applica al codice vero. I sorgenti sintetici restano, e restano
 * necessari — sono l'unica cosa che dimostra che il rilevatore VEDE il guasto,
 * dato che il codice vero (giustamente) non ce l'ha.
 *
 * Le tre cose che questo lock fa, oggi:
 *  1. CENSIMENTO — l'elenco dei file che SCELGONO RIGHE con la marca è dichiarato
 *     (`AMMESSI_A_FILTRARE_LA_MARCA`). Uno in più non è vietato: è un avviso, e
 *     serve a far leggere questa regola a chi sta per decidere sulla differenza
 *     fra «l'ha fatto la macchina» e «l'ha fatto una persona». Il criterio è
 *     «filtrare», non «nominare»: il perché — misurato, in un'ora, su tre falsi
 *     allarmi consecutivi — sta accanto all'elenco.
 *  2. RIUSO — chi riapre un movimento passa da `riapertura-movimento.ts`: lo
 *     storno idempotente, la mappa degli errori della RPC e il compare-and-swap
 *     stanno lì, e sono stati estratti dalla rotta proprio perché la riapertura in
 *     blocco dovesse riusarli e non riscriverli.
 *  3. LA REGOLA DEI DUE FILTRI — su ogni query del repository, più i sintetici.
 *
 * ⚠️ SI ASSERISCE SUL CODICE SENZA COMMENTI (`mascheraSorgente`): i file
 * sorvegliati NOMINANO `abbinato_auto_il` e l'annullamento in blocco nelle proprie
 * testate, perché spiegano la regola che questo lock protegge.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fileSorgente, riga } from '../fixtures/sorgente'

const RADICE = process.cwd()

/**
 * Dove si guarda. DUE alberi e non uno solo: la riapertura di oggi vive per metà
 * in una rotta e per metà in `src/lib` (è stata estratta apposta), e un lock che
 * guardasse solo `src/app/api` sarebbe cieco sulla metà in cui l'annullamento in
 * blocco ha più probabilità di essere scritto.
 */
const ALBERI = [path.join('src', 'app', 'api'), path.join('src', 'lib')]

/** La tabella di cui si parla: le righe dell'estratto conto. */
const TAVOLA = /\.from\(\s*['"`]riconciliazione_movimenti['"`]\s*\)/g

/**
 * I file AMMESSI a SCEGLIERE RIGHE con la marca, cioè a metterla in un filtro
 * PostgREST. Oggi è uno solo.
 *
 * ⚠️ IL CRITERIO È «FILTRARE», NON «NOMINARE», e la differenza è stata misurata
 * su questo stesso albero mentre il lock veniva scritto. Nominare la marca lo
 * fanno in tre modi diversi:
 *
 *  · chi la LEGGE per mostrarla o confrontarla — la riapertura singola la chiede
 *    dentro `MOV_SELECT_MARCA`, il riepilogo confronta il timestamp della riga
 *    con quello della notifica. Non scelgono niente: guardano un valore che
 *    qualcun altro ha già deciso;
 *  · chi la SCRIVE o la AZZERA — e quelli stanno in `DEVONO_NOMINARE_LA_MARCA`,
 *    dove la sparizione è un guasto;
 *  · chi ci FILTRA — «dammi le righe che ha deciso la macchina». **Questo solo è
 *    l'atto pericoloso**: è il punto in cui si separano le righe della macchina da
 *    quelle di una persona, ed è il punto in cui sbagliare significa stornare
 *    l'incasso che un'operatrice ha registrato a mano.
 *
 * La prima stesura di questo elenco censiva chiunque NOMINASSE la colonna. In
 * un'ora è diventato rosso tre volte su codice corretto — l'estrazione della query
 * dalla rotta al modulo, e due rotte nuove che la marca la leggono e basta — cioè
 * si comportava da tripwire invece che da lock. Un lock che grida sul codice
 * giusto si fa zittire con un'allowlist, e ha ragione chi lo zittisce. Questo
 * elenco è perciò corto e mirato: chi ci entra sta davvero decidendo.
 */
const AMMESSI_A_FILTRARE_LA_MARCA = [
  // Il modulo che legge le righe automatiche di un import, paginate: i TRE filtri
  // nella stessa catena. È il cuore dell'annullamento in blocco.
  path.join('src', 'lib', 'pagamenti', 'righe-automatiche.ts'),
]

/**
 * I file in cui la marca DEVE comparire: è il ciclo di vita completo della
 * colonna, e se uno di questi smette di nominarla non è un refactoring, è un
 * pezzo di regola caduto.
 *
 *  · `marca-automatica.ts` — la sonda «l'automatismo deve partire?»: senza la
 *    marca l'annullamento in blocco non esiste, e la fase non deve partire;
 *  · `riconciliazione-conferma.ts` — la ACCENDE, dentro il compare-and-swap;
 *  · `riapertura-movimento.ts` — la SPEGNE, insieme agli altri legami morti. Se
 *    smettesse, la riga tornerebbe in coda ancora «automatica» e il prossimo
 *    annullo disferebbe il lavoro di una persona.
 */
const DEVONO_NOMINARE_LA_MARCA = [
  path.join('src', 'lib', 'pagamenti', 'marca-automatica.ts'),
  path.join('src', 'lib', 'pagamenti', 'riconciliazione-conferma.ts'),
  path.join('src', 'lib', 'pagamenti', 'riapertura-movimento.ts'),
]

/** Chi riapre un movimento deve passare di qui, non riscriverlo. */
const MODULO_RIAPERTURA = path.join('src', 'lib', 'pagamenti', 'riapertura-movimento.ts')

/** La rotta che disfa ciò che l'import ha deciso da solo. */
const ROTTA_ANNULLO = path.join('src', 'app', 'api', 'pagamenti', 'riconciliazione', 'annulla-import', 'route.ts')

/** Il modulo che LEGGE le righe automatiche di un import, paginate. */
const MODULO_RIGHE_AUTO = path.join('src', 'lib', 'pagamenti', 'righe-automatiche.ts')

/**
 * Il PERIMETRO dell'annullamento in blocco: la rotta più il modulo che legge le
 * righe da riaprire.
 *
 * ⚠️ È un perimetro e non un file solo di proposito. La selezione delle righe si
 * sta spostando dalla rotta al modulo mentre questo lock viene scritto, ed è il
 * verso giusto — ma un lock inchiodato al file in cui il codice si trova OGGI
 * diventa verde su un guscio il giorno in cui il codice esce di lì. La regola
 * chiede perciò che i tre filtri stiano insieme DA QUALCHE PARTE dentro il
 * perimetro, e che il perimetro non sia vuoto.
 */
const PERIMETRO_ANNULLO = [ROTTA_ANNULLO, MODULO_RIGHE_AUTO]

/** La rotta della riapertura singola, l'altra porta che spegne la marca. */
const ROTTA_SINGOLA = path.join('src', 'app', 'api', 'pagamenti', 'riconciliazione', '[id]', 'route.ts')

// ─────────────────────────────────────────────────────────────────────────────
// Le forme
// ─────────────────────────────────────────────────────────────────────────────

/** Il ricevitore della catena, per riattaccarle le continuazioni condizionali. */
const RICEVE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\s*$/

/** Una riga sola: `.single()` / `.maybeSingle()`. */
const SINGOLA = /\.(?:single|maybeSingle)\s*\(/

/** Una riga sola per identità: `.eq('id', …)`. */
const PER_ID = /\.(?:eq|in)\s*\(\s*['"`]id['"`]/

/** L'istruzione che riscrive o cancella righe. */
const SCRITTURA = /\.(?:update|delete)\s*\(/

/**
 * Il filtro che identifica UN IMPORT — cioè la forma dell'annullamento in blocco:
 * «disfa tutto ciò che QUEST'IMPORT ha deciso da solo».
 *
 * ⚠️ È QUESTO, e non «una scrittura di massa qualsiasi», il trigger della seconda
 * regola — ed è una correzione fatta con un rilievo vero in mano, non per
 * prudenza. La prima stesura gridava su `src/lib/gdpr/esegui.ts:1795`, che
 * aggiorna in massa `causale` e `controparte` sui movimenti NON confermati per
 * cancellare il nome di un bambino da una causale bancaria: è una BONIFICA, non
 * un annullamento — non tocca `stato`, non scioglie nessun abbinamento, e
 * pretendere lì un filtro sulla marca vorrebbe dire lasciare il codice fiscale di
 * un minore scritto sulle righe che la macchina ha confermato. Un lock che chiede
 * di riscrivere codice corretto si fa zittire con un'allowlist, e ha ragione chi
 * lo zittisce.
 */
const FILTRO_IMPORT = /\.(?:eq|in)\s*\(\s*['"`]import_id['"`]/

/** Il filtro sulla MARCA, in tutte le forme PostgREST in uso nel repo. */
const FILTRO_MARCA =
  /\.(?:eq|neq|not|is|in|filter)\s*\(\s*['"`]abbinato_auto_il['"`]|['"`.]abbinato_auto_il\.(?:eq|in|is|not)\./

/** Il filtro sullo STATO, nelle stesse forme. */
const FILTRO_STATO =
  /\.(?:eq|neq|not|is|in|filter)\s*\(\s*['"`]stato['"`]|['"`.]stato\.(?:eq|in|is|not)\.|\.match\s*\(\s*\{[^}]*\bstato\b/

export interface Unita {
  /** Riga (1-based) del `.from(…)` che apre l'unità. */
  riga: number
  /** La catena PIÙ le sue continuazioni condizionali: ciò che PostgREST manda in AND. */
  testo: string
}

/**
 * Le query su `riconciliazione_movimenti` di un sorgente, ciascuna con le sue
 * continuazioni.
 *
 * «Una query» è la catena che parte da `.from('…')` PIÙ le riassegnazioni sulla
 * variabile che la riceve (`let q = supabase.from(…)` seguito da
 * `if (x) q = q.eq('stato', 'confermato')`): PostgREST le combina in AND, quindi
 * sono la stessa query. È la forma con cui il repo scrive il degrado sulle colonne
 * assenti, e senza questo pezzo il lock leggerebbe metà delle query e griderebbe
 * su codice corretto — che è il modo più rapido per farsi zittire con un'allowlist.
 */
export function unitaMovimenti(src: string): Unita[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const out: Unita[] = []
  TAVOLA.lastIndex = 0
  for (const m of senzaCommenti.matchAll(TAVOLA)) {
    const inizio = m.index
    const fine = fineCatena(struttura, inizio)
    const tratti: [number, number][] = [[inizio, fine]]
    // Sulla `struttura` e non su `senzaCommenti`: qui si analizza una FORMA, e il
    // contenuto di una stringa che dicesse `let q =` la falserebbe.
    const variabile = RICEVE.exec(struttura.slice(Math.max(0, inizio - 300), inizio))?.[1]
    if (variabile) {
      const re = new RegExp(`\\b${variabile}\\s*\\.`, 'g')
      re.lastIndex = fine
      for (let r = re.exec(struttura); r; r = re.exec(struttura)) {
        const punto = r.index + r[0].length - 1
        tratti.push([punto, fineCatena(struttura, punto)])
      }
    }
    out.push({ riga: riga(src, inizio), testo: tratti.map(([a, b]) => senzaCommenti.slice(a, b)).join('\n') })
  }
  return out
}

export interface Rilievo {
  file: string
  riga: number
  motivo: 'marca-senza-stato' | 'annullo-di-import-senza-marca'
}

/**
 * I rilievi di un sorgente. Due motivi, uno per ciascuno dei due versi in cui la
 * coppia di filtri si può rompere — e sono asimmetrici nel danno:
 *
 *  · `annullo-di-import-senza-marca` è il verso GRAVE: una scrittura di massa
 *    agganciata a un `import_id` che non nomina la marca disfa anche le righe che
 *    una PERSONA ha confermato dentro quell'import, e storna i suoi incassi;
 *  · `marca-senza-stato` è l'altro: si toccano righe già riaperte o ignorate, e il
 *    conteggio che si mostra all'operatore non è quello che si è fatto.
 *
 * Le letture/scritture di UNA riga (`.single()`, `.eq('id', …)`) non sono massive
 * e restano fuori: lì l'identità è il filtro, e chi la verifica è il gate di sede.
 */
export function rilievi(file: string, src: string): Rilievo[] {
  const out: Rilievo[] = []
  for (const u of unitaMovimenti(src)) {
    if (SINGOLA.test(u.testo) || PER_ID.test(u.testo)) continue
    const marca = FILTRO_MARCA.test(u.testo)
    const stato = FILTRO_STATO.test(u.testo)
    if (marca && !stato) out.push({ file, riga: u.riga, motivo: 'marca-senza-stato' })
    else if (SCRITTURA.test(u.testo) && FILTRO_IMPORT.test(u.testo) && !marca) {
      out.push({ file, riga: u.riga, motivo: 'annullo-di-import-senza-marca' })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Il repository
// ─────────────────────────────────────────────────────────────────────────────

const SORGENTI = ALBERI.flatMap((a) => fileSorgente(path.join(RADICE, a))).map((assoluto) => ({
  relativo: path.relative(RADICE, assoluto),
  grezzo: fs.readFileSync(assoluto, 'utf8'),
}))

const senzaCommentiDi = (s: string) => mascheraSorgente(s).senzaCommenti
const di = (relativo: string) => SORGENTI.find((f) => f.relativo === relativo)

// ─────────────────────────────────────────────────────────────────────────────
// I sorgenti sintetici del controllo positivo
// ─────────────────────────────────────────────────────────────────────────────

/** La forma GIUSTA: i due filtri nella stessa catena. */
const BUONO = `
export const POST = withRoute('x:POST', async () => {
  const { data, error } = await supabase
    .from('riconciliazione_movimenti')
    .update({ stato: 'da_abbinare' })
    .eq('import_id', importId)
    .eq('stato', 'confermato')
    .not('abbinato_auto_il', 'is', null)
    .select('id')
})
`

/** La forma giusta scritta per CONTINUAZIONE: PostgREST la manda in AND lo stesso. */
const BUONO_CONTINUAZIONE = `
export const POST = withRoute('x:POST', async () => {
  let q = supabase.from('riconciliazione_movimenti').update({ stato: 'da_abbinare' }).eq('import_id', importId)
  q = q.eq('stato', 'confermato')
  if (conMarca) q = q.not('abbinato_auto_il', 'is', null)
  const { data, error } = await q.select('id')
})
`

/** Il guasto GRAVE: la marca filtrata a valle, in JavaScript. */
const ROTTO_MARCA_A_VALLE = `
export const POST = withRoute('x:POST', async () => {
  const { data, error } = await supabase
    .from('riconciliazione_movimenti')
    .update({ stato: 'da_abbinare' })
    .eq('import_id', importId)
    .eq('stato', 'confermato')
    .select('id, abbinato_auto_il')
  const automatiche = (data ?? []).filter((r) => r.abbinato_auto_il != null)
})
`

/** L'altro verso: la marca c'è, lo stato è finito a valle. */
const ROTTO_STATO_A_VALLE = `
export const POST = withRoute('x:POST', async () => {
  const { data, error } = await supabase
    .from('riconciliazione_movimenti')
    .select('id, stato')
    .eq('import_id', importId)
    .not('abbinato_auto_il', 'is', null)
  const confermate = (data ?? []).filter((r) => r.stato === 'confermato')
})
`

/** Una riga sola per id: non è massiva, e non deve produrre rilievi. */
const UNA_RIGA_SOLA = `
const { data } = await supabase
  .from('riconciliazione_movimenti')
  .update({ stato: 'da_abbinare' })
  .eq('id', movimentoId)
  .select('id')
  .maybeSingle()
`

/**
 * La BONIFICA GDPR: scrittura di massa, nessun `import_id`, non disfa niente —
 * cancella il nome di un bambino da una causale bancaria. Non deve produrre
 * rilievi, ed è la forma vera che ha fatto correggere la regola (v. la testata di
 * `FILTRO_IMPORT`): qui pretendere un filtro sulla marca vorrebbe dire lasciare il
 * codice fiscale di un minore scritto sulle righe confermate.
 */
const BONIFICA_GDPR = `
const { data: movCf, error } = await supabase
  .from('riconciliazione_movimenti')
  .update({ causale: null, controparte: null })
  .neq('stato', 'confermato')
  .ilike('causale', '%' + cf + '%')
  .select('id')
`

describe('LOCK · l’annullamento in blocco tocca solo le righe della macchina', () => {
  it('controllo positivo: i due alberi si leggono davvero', () => {
    // «Zero file letti» e «zero violazioni» hanno lo stesso colore: senza questo
    // blocco un percorso sbagliato renderebbe verde tutto il resto.
    expect(SORGENTI.length, 'i sorgenti non si leggono più').toBeGreaterThan(500)
    for (const albero of ALBERI) {
      const n = SORGENTI.filter((f) => f.relativo.startsWith(albero + path.sep)).length
      expect(n, `nessun file letto sotto ${albero}`).toBeGreaterThan(100)
    }
    // E il rilevatore deve vedere le query che ci sono: se `unitaMovimenti` non
    // trovasse più niente, la regola sarebbe muta ovunque.
    const conQuery = SORGENTI.filter((f) => unitaMovimenti(f.grezzo).length > 0).map((f) => f.relativo)
    expect(
      conQuery.length,
      'il rilevatore non trova più nessuna query su `riconciliazione_movimenti`: o la tabella è ' +
        'stata rinominata, o `unitaMovimenti` si è rotto. In tutt’e due i casi questo lock ha ' +
        'smesso di guardare qualcosa.',
    ).toBeGreaterThan(3)
  })

  it('controllo positivo: il rilevatore MORDE, nei due versi', () => {
    // È il blocco che tiene in piedi questo lock finché la rotta non esiste. Senza,
    // la regola qui sotto scansionerebbe zero unità massive e sarebbe verde per la
    // ragione sbagliata — la cecità che questo repository ha già pagato tre volte.
    expect(rilievi('sintetico', BUONO), 'la forma giusta produce rilievi').toEqual([])
    expect(
      rilievi('sintetico', BUONO_CONTINUAZIONE),
      'un filtro aggiunto per CONTINUAZIONE è nella stessa query — PostgREST lo manda in AND — e ' +
        'non deve produrre rilievi: un lock che grida su codice corretto si fa zittire con ' +
        'un’allowlist, e ha ragione chi lo zittisce.',
    ).toEqual([])
    expect(rilievi('sintetico', UNA_RIGA_SOLA), 'una riga sola per id non è massiva').toEqual([])
    expect(
      rilievi('sintetico', BONIFICA_GDPR),
      'la bonifica GDPR non disfa nessun abbinamento e non deve produrre rilievi: v. la testata ' +
        'di `FILTRO_IMPORT`, dove è scritto il rilievo vero che ha fatto correggere la regola.',
    ).toEqual([])

    expect(
      rilievi('sintetico', ROTTO_MARCA_A_VALLE).map((r) => r.motivo),
      'il rilevatore NON vede una riapertura di massa che filtra la marca in JavaScript: è il ' +
        'guasto grave — storna gli incassi confermati a mano — ed è la ragione per cui questo ' +
        'lock esiste.',
    ).toEqual(['annullo-di-import-senza-marca'])

    expect(
      rilievi('sintetico', ROTTO_STATO_A_VALLE).map((r) => r.motivo),
      'il rilevatore NON vede una selezione per marca a cui manca il filtro sullo stato.',
    ).toEqual(['marca-senza-stato'])
  })

  it('🔴 nessuna query esistente separa i due filtri', () => {
    const trovati = SORGENTI.flatMap((f) => rilievi(f.relativo, f.grezzo))
    expect(
      trovati.map((r) => `${r.file}:${r.riga} — ${r.motivo}`),
      'Il filtro sulla marca e quello sullo stato devono stare NELLA STESSA QUERY. Un filtro ' +
        'applicato dopo, sulle righe già lette, arriva quando l’`UPDATE` è già passato: si ' +
        'riaprono righe che una PERSONA aveva confermato, si stornano i suoi incassi, e non ' +
        'c’è nessun errore da leggere — solo un conteggio più grande del previsto che nessuno ' +
        'confronta con niente.\n',
    ).toEqual([])
  })

  it('🔴 dentro il perimetro dell’annullo, OGNI query per import porta i TRE filtri', () => {
    // La regola generale qui sopra è scritta in NERO — vieta le forme sbagliate —
    // e da sola sarebbe verde anche su una rotta svuotata, o cancellata. Questa è
    // la sua metà in BIANCO: pretende che la selezione esista e sia fatta bene.
    //
    // ⚠️ E QUI LA LETTURA CONTA QUANTO LA SCRITTURA, che è la ragione per cui
    // questa regola non si limita agli `update`. L'annullamento in blocco non
    // riapre con un `UPDATE` di massa: LEGGE le righe da riaprire e poi chiama
    // `riapriMovimento` una per una, come deve. Il filtro che decide che cosa si
    // storna è quindi quello della SELECT: toglierlo da lì è il guasto per
    // intero — gli incassi che una persona ha registrato a mano vengono stornati
    // uno per uno, ordinatamente, da un codice che non ha sbagliato niente
    // tranne la domanda che ha fatto al database.
    //
    // La regola vale su TUTTE le unità del perimetro, non su una: due query e un
    // filtro dimenticato in una sola è precisamente il modo in cui questa cosa
    // succederebbe.
    const dentro = PERIMETRO_ANNULLO.map((p) => ({ p, f: di(p) }))
    for (const { p, f } of dentro) {
      expect(
        f,
        `${p} non c’è più. Se l’annullamento in blocco è stato spostato, questo lock va spostato ` +
          'con lui: un lock che punta al file da cui il codice è uscito resta VERDE su un guscio, ' +
          'ed è la specie di cecità che questo repository ha già pagato tre volte.',
      ).toBeDefined()
    }

    const unita = dentro.flatMap(({ p, f }) => unitaMovimenti(f!.grezzo).map((u) => ({ ...u, file: p })))
    expect(
      unita.length,
      'Il perimetro dell’annullamento in blocco non interroga più `riconciliazione_movimenti`: ' +
        'i file sono vuoti, o la selezione delle righe da riaprire è passata fuori dal perimetro ' +
        'dichiarato in `PERIMETRO_ANNULLO`.',
    ).toBeGreaterThan(0)

    // Le query DI MASSA agganciate a un import: sono quelle che scelgono le righe
    // su cui si storna. Le letture di una riga sola per id restano fuori.
    const perImport = unita.filter(
      (u) => FILTRO_IMPORT.test(u.testo) && !SINGOLA.test(u.testo) && !PER_ID.test(u.testo),
    )
    expect(
      perImport.length,
      'Nel perimetro dell’annullamento in blocco non c’è più nessuna query di massa agganciata a ' +
        'un `import_id`: la selezione delle righe da riaprire è sparita, o è uscita dal ' +
        'perimetro dichiarato in `PERIMETRO_ANNULLO`. In tutt’e due i casi la regola qui sotto ' +
        'non sta più guardando niente.',
    ).toBeGreaterThan(0)

    const monche = perImport
      .filter((u) => !(FILTRO_STATO.test(u.testo) && FILTRO_MARCA.test(u.testo)))
      .map((u) => `${u.file}:${u.riga}`)
    expect(
      monche,
      'Questa query sceglie le righe di un import senza portare tutt’e TRE i filtri nella stessa ' +
        'catena: `import_id` (solo quest’import, mai lo storico), `stato = confermato` (una riga ' +
        'già riaperta non si riapre due volte) e `abbinato_auto_il IS NOT NULL` (SOLO ciò che ha ' +
        'deciso la macchina). Un filtro applicato dopo, in JavaScript, non produce nessun ' +
        'errore: produce un elenco più lungo del dovuto, e dentro ci sono le righe che una ' +
        'PERSONA aveva confermato a mano — che verranno stornate una per una, ordinatamente.\n' +
        monche.join('\n'),
    ).toEqual([])
  })

  it('🔴 nessun file NUOVO sceglie righe con la marca senza essere dichiarato', () => {
    const filtra = SORGENTI.filter((f) => FILTRO_MARCA.test(senzaCommentiDi(f.grezzo)))
      .map((f) => f.relativo)
      .sort()

    // Il verso severo: chi sceglie righe con la marca senza essersi dichiarato.
    const ammessi = new Set(AMMESSI_A_FILTRARE_LA_MARCA)
    expect(
      filtra.filter((f) => !ammessi.has(f)),
      'Un file SCEGLIE righe con `abbinato_auto_il` senza essere dichiarato. Non è un divieto: ' +
        'è l’AVVISO per cui questo lock esiste.\n\n' +
        'Filtrare su quella colonna vuol dire separare le righe che ha deciso la macchina da ' +
        'quelle che ha confermato una persona — `stato` dice `confermato` in tutt’e due i casi, ' +
        'e la marca è l’unica differenza. Se è quello che stai facendo: (1) aggiungi il ' +
        'percorso ad `AMMESSI_A_FILTRARE_LA_MARCA`; (2) se stai scegliendo le righe di un ' +
        'import, mettilo in `PERIMETRO_ANNULLO` e porta i TRE filtri nella stessa catena; ' +
        '(3) se poi riapri, riusa `riapriMovimento` invece di riscrivere lo storno.\n\n' +
        'Sbagliare qui non dà nessun errore: dà un elenco più lungo del dovuto, e dentro ci ' +
        'sono gli incassi che qualcuno ha registrato a mano.',
    ).toEqual([])

    // La metà positiva: qualcuno DEVE filtrarci, o l'annullamento in blocco ha
    // smesso di distinguere le due specie di riga.
    expect(
      filtra.length,
      'Nessun file filtra più su `abbinato_auto_il`. L’annullamento in blocco ha smesso di ' +
        'distinguere le righe della macchina da quelle di una persona — oppure la colonna non ' +
        'si usa più, e allora questo lock va tolto con lei, non lasciato verde.',
    ).toBeGreaterThan(0)

    // E i file del CICLO DI VITA della marca devono continuare a nominarla:
    // accenderla, spegnerla, chiedere se esiste.
    const nomina = SORGENTI.filter((f) => /\babbinato_auto_il\b/.test(senzaCommentiDi(f.grezzo)))
      .map((f) => f.relativo)
    for (const f of DEVONO_NOMINARE_LA_MARCA) {
      expect(
        nomina,
        `${f} non nomina più \`abbinato_auto_il\`. Non è un file che la usa per comodità: è un ` +
          'pezzo del ciclo di vita della colonna — chi la accende, chi la spegne, chi chiede se ' +
          'esiste. Se è caduto, la marca mente in uno dei due versi.',
      ).toContain(f)
    }
  })

  it('🔴 chi riapre un movimento passa dal modulo, invece di riscriverlo', () => {
    const modulo = di(MODULO_RIAPERTURA)
    expect(modulo, `${MODULO_RIAPERTURA} non c’è più: il lock sorveglia un file che non esiste`).toBeDefined()
    const codice = senzaCommentiDi(modulo!.grezzo)
    expect(
      codice,
      'Il modulo non esporta più `riapriMovimento`. Lo storno idempotente, la mappa degli errori ' +
        'della RPC, il compare-and-swap e l’azzeramento della marca sono stati estratti dalla ' +
        'rotta PROPRIO perché la riapertura in blocco dovesse riusarli: se sono tornati dentro ' +
        'un handler, la seconda copia nasce oggi e diverge domani.',
    ).toMatch(/export\s+async\s+function\s+riapriMovimento\b/)
    expect(
      codice,
      'Il modulo non azzera più la marca alla riapertura. Senza, la riga torna in coda ancora ' +
        '«automatica»: una riconferma fatta a mano non la spegne, e il prossimo annullamento in ' +
        'blocco disferebbe il lavoro di una persona.',
    ).toMatch(/\babbinato_auto_il\b/)

    // La metà positiva: TUTT'E DUE le porte che riaprono devono passare di lì —
    // quella singola e quella in blocco. È l'asserzione che diventa rossa il
    // giorno in cui qualcuno riporta lo storno dentro un handler «per
    // semplificare», ed è il motivo per cui quel codice è stato estratto.
    for (const porta of [ROTTA_SINGOLA, ROTTA_ANNULLO]) {
      const r = di(porta)
      expect(r, `${porta} non c’è più: una delle due porte della riapertura è sparita`).toBeDefined()
      expect(
        senzaCommentiDi(r!.grezzo),
        `${porta} non importa più \`riapriMovimento\`. Lo storno, l’idempotenza e l’azzeramento ` +
          'della marca non si riscrivono: in blocco, una seconda copia sbaglia su MILLE righe ' +
          'invece che su una.',
      ).toMatch(/import\s*\{[^}]*\briapriMovimento\b[^}]*\}\s*from\s*'@\/lib\/pagamenti\/riapertura-movimento'/)
      expect(
        senzaCommentiDi(r!.grezzo),
        `${porta} importa \`riapriMovimento\` ma non lo chiama.`,
      ).toMatch(/\briapriMovimento\s*\(/)
    }
  })
})
