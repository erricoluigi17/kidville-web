import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { formeDiRicerca, ripulisciTermineRicerca } from '@/lib/validation/ricerca-testo'
import { testoCorrisponde } from '@/lib/ui/testo-ricerca'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { residuoEffettivo, type AgingPagamento } from '@/lib/pagamenti/aging'
import { pagantiAmmessiPerAlunni } from '@/lib/pagamenti/pagante-ammesso'
import { eAncoraIscritto } from '@/lib/alunni/stato'

/**
 * ─── CERCARE UN BAMBINO PER COMPORRE UN BONIFICO ─────────────────────────────
 *
 * `GET /api/pagamenti/riconciliazione/alunni?q=<≥2 caratteri>&limite=1..20`
 *   → 200 { success: true, data: AlunnoRicerca[], troncato, sedi }
 *
 * Non scrive niente. Risponde a una domanda sola: «quali bambini, fra quelli
 * che posso gestire, rispondono a questo nome, a questo cognome o a questo
 * codice fiscale?».
 *
 * ─── PERCHÉ NON BASTAVA QUELLO CHE C'ERA ────────────────────────────────────
 * Il pannello filtrava LATO BROWSER l'elenco che la pagina si era già caricata
 * con `/api/pagamenti?scuola_id=…&solo_aperti=true`: **una sede sola**, e
 * **solo chi ha una voce aperta**. Il titolare ha chiesto l'opposto di
 * entrambi — qualunque bambino delle sedi su cui si ha diritto, anche senza
 * nessuna voce aperta, perché un bonifico può saldare un arretrato, pagare una
 * ricarica ticket o aprire una voce che ancora non esiste.
 *
 * ─── PERCHÉ NON RIUSA `/api/admin/legami-familiari?tipo=alunni` ─────────────
 * Quella cerca per nome, cognome e codice fiscale, quindi sembra la stessa
 * cosa. Diverge in tre punti, e il primo basta:
 *  1. filtra su `STATI_CON_CANALE_FAMIGLIA`, cioè **esclude i ritirati** — e il
 *     bonifico che salda l'arretrato di un bambino che ha lasciato è il caso
 *     NORMALE di fine anno. Là è giusto (un bambino ritirato non si aggiunge a
 *     una famiglia dallo sportello); qui sarebbe il difetto;
 *  2. usa `scuoleDiUtente`, cioè un perimetro più largo di quello della
 *     scrittura (vedi sotto);
 *  3. non sa niente di voci aperte né di paganti, che sono le due cose per cui
 *     questa schermata esiste.
 *
 * ─── 🔴 PRIVACY: QUI SI CERCANO MINORI ──────────────────────────────────────
 *  · **nome e cognome ESCONO**, e possono farlo solo perché ogni riga è dentro
 *    il perimetro PER COSTRUZIONE: il filtro sulle sedi sta NELLA QUERY
 *    (`.in('scuola_id', sedi)`), non a valle in JavaScript. Un filtro di sede
 *    applicato dopo la lettura è un filtro che il prossimo `select` scritto qui
 *    accanto non eredita. Senza il nome, però, un bambino non si sceglie: è
 *    l'unico dato identificante che questa schermata richiede davvero;
 *  · **il codice fiscale NON esce MAI.** È chiave di ricerca, non dato da
 *    mostrare: di lui esce il solo booleano `trovato_per_cf`, che dice
 *    «l'hai trovato così» senza ripetere il codice di un minore in una risposta
 *    HTTP. Stessa scelta di `/api/admin/search`, che è il precedente;
 *  · **niente data di nascita, niente residenza, niente note mediche**: non
 *    servono a nessuna decisione di questa schermata, e ciò che non esce non si
 *    può perdere;
 *  · **nei log**: `operazione`, `esito`, quanti risultati, `troncato`, quante
 *    sedi. Mai il TERMINE cercato (è un cognome o un codice fiscale) e mai gli
 *    uuid dei bambini. `withRoute` tiene del path il solo `pathname`, quindi la
 *    query string non entra nemmeno da quella porta.
 *
 * ─── IL PERIMETRO DI SEDE ───────────────────────────────────────────────────
 * `resolveScuoleAttive`, lo STESSO insieme che usa la scrittura
 * (`…/[id]/componi:POST`), non `scuoleDiUtente` che è più largo: offrire un
 * bambino che poi la conferma rifiuterà è peggio che non offrirlo — manda
 * l'operatrice a comporre un pagamento contro un muro che sappiamo già dov'è.
 * Il prezzo è dichiarato: una selezione stretta nel SedeSelector restringe
 * anche questa ricerca. È la direzione sicura in cui sbagliare — mai più larga
 * dell'ambito dichiarato a schermo.
 *
 * ─── IL RICHIAMO, E IL SUO LIMITE NOTO ──────────────────────────────────────
 * `ilike` in Postgres **non** è insensibile agli accenti: «niccolo» non trova
 * «Niccolò». Si interroga quindi con DUE forme del termine (come l'ha scritto
 * chi cerca, e senza accenti: `formeDiRicerca`), che recupera il caso
 * frequente. ⚠️ **Il richiamo PIENO richiederebbe `unaccent` sul database** —
 * estensione, migrazione e indice — e qui non si fa: chi digita «Niccolò» non
 * troverà un «Niccolo» scritto senza accento in anagrafica. È un debito, ed è
 * scritto: un debito muto è peggio di un debito dichiarato.
 *
 * ─── DEGRADO: `null` NON È `0` ──────────────────────────────────────────────
 * PostgREST non lancia, ritorna `{ error }`, e qui si guarda sempre. La lettura
 * degli ALUNNI è quella senza cui la risposta sarebbe una bugia («quel bambino
 * non c'è»): fallisce con 500 e il suo codice. Le due letture di contorno —
 * le voci aperte e i paganti — degradano, ma a **`null`**, mai a `0`/`false`:
 * `0` direbbe «questa famiglia non deve niente» e `false` direbbe «non ha
 * nessun adulto collegato», cioè due fatti, mentre la verità è «non ho potuto
 * guardare». La UI mostri un trattino, non uno zero. Stesso trattamento per la
 * finestra delle voci TRONCATA dal `db-max-rows` (§6): un conteggio corto è un
 * `0` parziale, cioè la stessa bugia più difficile da vedere.
 * Sul DB E2E della CI, non migrato, `alunni.stato` e `pagamenti.sconto` possono
 * non esistere: `42703` si ritenta senza quella colonna, e lo si dichiara.
 *
 * ⚠️ IL SEGMENTO `alunni` VINCE SU `[id]` — Next risolve prima le rotte
 * statiche: `/api/pagamenti/riconciliazione/alunni` arriva qui e non a
 * `[id]/route.ts`, che infatti pretende un uuid. Nessun bonifico può chiamarsi
 * «alunni», quindi non si nasconde niente.
 */

const OPERAZIONE = 'pagamenti/riconciliazione/alunni:GET'

/** Sotto i due caratteri non si cerca: si risponde vuoto, come `admin/search`. */
const MINIMO_RICERCA = 2

/** Il massimo che la pagina può chiedere. Un elenco di bambini si cerca, non si sfoglia. */
const LIMITE_MASSIMO = 20

/** L'asterisco, che dentro `like`/`ilike` PostgREST traduce in `%`. */
const JOLLY_ILIKE = '*'

/**
 * Quanta ricerca c'è davvero in una forma, tolti i jolly: un asterisco NON è
 * contenuto. Si toglie solo per MISURARE, mai dal filtro che parte (vedi il §5).
 *
 * ⚠️ `split`/`join` e non un'espressione regolare, che qui sarebbe la scrittura
 * naturale: un letterale come quello che neutralizza l'asterisco contiene la
 * sequenza che CHIUDE un commento a blocchi, e il controllo positivo del lock
 * `pagante-ammesso-un-motore-solo` — che toglie i commenti e poi verifica di non
 * aver lasciato delimitatori per strada — la scambia per un commento
 * sopravvissuto e si ferma. Misurato: quel lock è diventato rosso su questa riga.
 */
const contenutoRicercabile = (forma: string): string => forma.split(JOLLY_ILIKE).join('')

/**
 * ⚠️ NIENTE `.strict()`, ed è la stessa nota (e la stessa ragione) del GET del
 * contesto: la pagina di Contabilità appende `?userId=` a ogni richiesta, e con
 * lo schema chiuso ogni ricerca sarebbe un 400.
 */
const getQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limite: z.coerce.number().int().min(1).max(LIMITE_MASSIMO).default(10),
})

/**
 * `pagamenti` con lo sconto di Contabilità v2; senza, sul DB E2E della CI.
 *
 * ⚠️ `stato` è chiesto ma NON filtrato, ed è voluto: serve solo a soddisfare il
 * tipo `AgingPagamento` (dove è obbligatorio) perché `residuoEffettivo` accetti
 * la riga. Letto da fuori sembra un filtro dimenticato — qui l'aperto si decide
 * dal RESIDUO, vedi il §6.
 */
const SEL_VOCI = 'alunno_id, importo, importo_pagato, sconto, stato, tipo'
const SEL_VOCI_BASE = 'alunno_id, importo, importo_pagato, stato, tipo'

/**
 * Righe CHIESTE sulla finestra delle voci dei (massimo venti) bambini trovati.
 *
 * ⚠️ Non sta «sotto» il `db-max-rows` di PostgREST: ci COINCIDE —
 * `supabase/config.toml` dichiara `max_rows = 1000`. Il punto non è il numero, è
 * che senza un tetto DICHIARATO la risposta verrebbe troncata lì **in silenzio**,
 * e un troncamento muto su questa lettura è un `residuo_aperto` più basso del
 * vero su una schermata che incassa: lo `0` travestito da verità che tutto il
 * resto della rotta è costruito per evitare. Il fratello di questa cartella
 * (`…/riconciliazione:POST`, `BLOCCO_APERTI`) pagina proprio per questo.
 *
 * Qui non si pagina, si degrada: venti bambini non possono avere mille voci
 * scritte da una segreteria, e il giorno che le avessero la risposta onesta è
 * «non ho potuto contare» (`null`), non un conteggio corto. Misurato sul
 * database di produzione il **2026-09-20** — sole aggregazioni, nessuna riga
 * letta: `pagamenti` ha **892** righe in tutto, **14** al massimo per bambino, e
 * i venti più carichi ne sommano **109**. Quei numeri invecchiano, l'argomento
 * no: il codice qui sotto non si appoggia al margine, lo misura.
 */
const BLOCCO_VOCI = 1000

export interface AlunnoRicerca {
  alunno_id: string
  /** «Cognome Nome», e solo per le sedi del perimetro: vedi la testata. */
  nome: string
  classe_sezione: string | null
  scuola_id: string | null
  /** Ancora iscritto. Un `false` NON toglie la riga: si incassa anche un arretrato. */
  attivo: boolean
  /** Quante voci con residuo. `null` = non si è potuto leggere, ≠ «nessuna». */
  voci_aperte: number | null
  /** Quanto residuo in totale. `null` come sopra. */
  residuo_aperto: number | null
  /** C'è un adulto che può essere il pagante. `null` = non si è potuto stabilire. */
  ha_pagante: boolean | null
  /** L'ho trovato per CODICE FISCALE, non per nome. Il codice non esce. */
  trovato_per_cf: boolean
}

interface AlunnoRiga {
  id: string
  nome?: string | null
  cognome?: string | null
  classe_sezione?: string | null
  scuola_id?: string | null
  stato?: string | null
  codice_fiscale?: string | null
}

const testo = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** Il codice PostgREST di un errore, per il log. Mai il `message`: è prosa del DB. */
function codiceErroreDi(e: unknown): { error_code: string } {
  const err = e as { code?: unknown } | null
  const c = typeof err?.code === 'string' && err.code.trim() !== '' ? err.code.trim() : 'sconosciuto'
  return { error_code: c }
}

/** La busta, una sola: i due ritorni vuoti e quello pieno hanno la stessa forma. */
function rispondi(
  data: AlunnoRicerca[],
  troncato: boolean,
  sedi: Record<string, string>,
): NextResponse {
  return NextResponse.json({ success: true, data, troncato, sedi })
}

export const GET = withRoute('pagamenti/riconciliazione/alunni:GET', async (request: Request) => {
  try {
    // ── 1 · IL GATE, PRIMA DI TUTTO — ZOD COMPRESO ──────────────────────────
    // ⚠️ NON lo tiene fermo il lock `corpo-letto-dopo-il-gate`, e attribuirglielo
    // sarebbe appoggiare una riga a una garanzia che non c'è: quel lock sorveglia
    // le letture del CORPO (`request.json`/`formData`/`text`, `parseBody`,
    // `parseMultipart`), e questa è una GET che un corpo non ce l'ha — legge solo
    // la query string. A tenerlo fermo è il caso «il gate di ruolo viene prima di
    // tutto, zod compreso» del file di test di questa rotta: con `requireStaff`
    // che risponde 403, una query malformata per zod deve tornare ancora 403.
    // Invertire questi due blocchi la fa diventare 400, cioè dice a chi non ha il
    // permesso che cosa c'era di sbagliato nella sua richiesta.
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    // ── 2 · zod su ciò che arriva dal client ────────────────────────────────
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const limite = q.data.limite

    // ── 3 · SOTTO I DUE CARATTERI NON SI INTERROGA IL DATABASE ──────────────
    // Non è un'ottimizzazione: `%a%` su tre plessi è l'intero registro letto per
    // una lettera battuta per sbaglio, e una schermata che si apre con il campo
    // vuoto la batte a ogni apertura. Elenco vuoto, e nessun `from()`.
    const termine = ripulisciTermineRicerca(q.data.q ?? '')
    if (termine.length < MINIMO_RICERCA) return rispondi([], false, {})

    const supabase = await createAdminClient()

    // ── 4 · IL PERIMETRO: quello della SCRITTURA, non uno più largo ─────────
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
    if (sedi.length === 0) {
      // Scope vuoto = diniego, mai «tutte»: `resolveScuoleAttive` è fail-closed.
      //
      // 🔴 LA RIGA LA SCRIVE QUESTA ROTTA, e non ci si appoggia a `scope.ts`. Il
      // `warn` `sedi-attive-non-accessibili` di quel modulo copre UN caso solo —
      // il cookie che seleziona sedi non (più) accessibili. Quando invece è
      // `scuoleDiUtente` a rispondere `[]` (un non-admin con `scuola_id` nullo,
      // o una lettura del ponte fallita), `resolveScuoleAttive` ritorna `[]` in
      // TOTALE SILENZIO. Senza questa riga l'operatrice cerca, non trova niente
      // e non resta traccia da nessuna parte: è la confusione «non l'ho trovato»
      // / «non ho potuto cercare» che tutto il resto della rotta è costruito per
      // impedire, rientrata dall'unico ramo che non la dichiarava.
      //
      // Stesso evento dell'altro ritorno vuoto (`righe.length === 0`), perché la
      // domanda a cui si risponde in `app_log` è la stessa; a distinguerli è
      // `sedi: 0`, cioè «non c'era niente in cui cercare».
      logEvento('pagamento', 'info', {
        operazione: OPERAZIONE,
        esito: 'ricerca-alunni',
        n: 0,
        troncato: false,
        sedi: 0,
      })
      return rispondi([], false, {})
    }

    // ── 5 · GLI ALUNNI ──────────────────────────────────────────────────────
    // ⚠️ NESSUN FILTRO SU `stato`, ED È LA DIVERGENZA DELIBERATA da
    // `legami-familiari?tipo=alunni`: un ritirato DEVE comparire, o il suo
    // arretrato non si incassa più. Lo stato esce come `attivo`, perché la
    // scrittura lo usa (una voce NUOVA su un non iscritto è un 422 alla
    // conferma) e il pannello deve saperlo PRIMA.
    //
    // ⚠️ Si chiede `limite + 1` riga e se ne mostrano `limite`. Un elenco
    // troncato che tace fa concludere «quel bambino non c'è», che è il modo
    // peggiore di sbagliare in una ricerca: qui il troncamento è un DATO.
    //
    // Le due forme del termine (con e senza accenti) stanno DENTRO il `.or`, e
    // il filtro di sede dentro `.in`: la restrizione vive nella query, dove il
    // lock `isolamento-sede-coverage` la vede e dove il prossimo `select` non
    // può dimenticarsela.
    // ⚠️ La soglia passa anche alle FORME: una forma più corta del minimo è la
    // guardia del §3 aggirata da dentro. Un termine di soli segni diacritici
    // (due `U+0300` di fila) sopravvive alla guardia e `senzaAccenti` lo riduce a
    // stringa vuota: `nome.ilike.%%` sarebbe l'anagrafica intera del perimetro.
    //
    // ⚠️ E LA SOGLIA SI MISURA SUL CONTENUTO, NON SUI CARATTERI. `*` non è fra i
    // metacaratteri che `ripulisciTermineRicerca` neutralizza — non può esserlo:
    // quella funzione è condivisa con `admin/search` e `legami-familiari`, e
    // toccarla sposterebbe il filtro di tre campi in una volta, con un effetto
    // da misurare sui test di tutti e tre (sta scritto nel suo commento). Ma
    // dentro `ilike` PostgREST lo legge come `%`, quindi `q=**` passa la guardia
    // dei due caratteri e diventa `nome.ilike.%**%`, cioè `%%%%`: «qualunque
    // riga» — fino a venti nomi, cognomi e classi di minori per un termine che
    // di contenuto non ne ha. Incoerente perfino con sé stessa, visto che `q=a`
    // è respinto e `q=**`, che è strettamente più largo, passerebbe.
    // Si chiude QUI, dove il perimetro è di una rotta sola: la forma parte
    // INTERA, asterisco compreso — **non** perché un asterisco letterale si
    // possa trovare (dentro `ilike` PostgREST lo legge come `%`, quindi non si
    // può: `q=ro*` trova «Rossini» proprio perché è un jolly), ma perché
    // mutilare il termine renderebbe questo filtro diverso da quello di
    // `admin/search` e `legami-familiari`, che partono dalla stessa ripulitura.
    // Si scarta la FORMA senza contenuto, non il carattere: a decidere se vale
    // la pena partire è ciò che resta togliendo i jolly.
    const forme = formeDiRicerca(termine, MINIMO_RICERCA).filter(
      (f) => contenutoRicercabile(f).length >= MINIMO_RICERCA,
    )
    if (forme.length === 0) return rispondi([], false, {})
    const like = forme.flatMap((f) => [
      `nome.ilike.%${f}%`,
      `cognome.ilike.%${f}%`,
      `codice_fiscale.ilike.%${f}%`,
    ])
    let alunniRes = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, scuola_id, stato, codice_fiscale')
      .in('scuola_id', sedi)
      .or(like.join(','))
      .order('cognome')
      .order('nome')
      .limit(limite + 1)
    let statoLetto = true
    if (alunniRes.error && (alunniRes.error as { code?: string }).code === '42703') {
      // DB E2E della CI, non migrato: `stato` non c'è. Il degrado è APERTO —
      // tutti risultano attivi — e non muto: chiudere vorrebbe dire rispondere
      // «nessuno può ricevere una voce nuova» perché uno schema è indietro.
      statoLetto = false
      logEvento('db', 'info', {
        operazione: OPERAZIONE,
        esito: 'colonna-stato-assente',
        entita_tipo: 'alunni',
        error_code: '42703',
      })
      alunniRes = (await supabase
        .from('alunni')
        .select('id, nome, cognome, classe_sezione, scuola_id, codice_fiscale')
        .in('scuola_id', sedi)
        .or(like.join(','))
        .order('cognome')
        .order('nome')
        .limit(limite + 1)) as typeof alunniRes
    }
    if (alunniRes.error) {
      // 🔴 Un guasto NON si traveste da elenco vuoto: «non l'ho trovato» e «non
      // ho potuto cercare» mandano l'operatrice a fare due cose opposte.
      logErrore(
        { operazione: OPERAZIONE, stato: 500, evento: 'alunni-non-cercati', ...codiceErroreDi(alunniRes.error) },
        alunniRes.error,
      )
      return NextResponse.json(
        {
          error: 'Non è stato possibile cercare i bambini: riprova fra poco.',
          codice: 'CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA',
        },
        { status: 500 },
      )
    }

    const trovati = ((alunniRes.data ?? []) as AlunnoRiga[]).filter((a) => typeof a.id === 'string')
    const troncato = trovati.length > limite
    const righe = trovati.slice(0, limite)
    if (righe.length === 0) {
      logEvento('pagamento', 'info', {
        operazione: OPERAZIONE, esito: 'ricerca-alunni', n: 0, troncato, sedi: sedi.length,
      })
      return rispondi([], troncato, {})
    }
    const ids = righe.map((a) => a.id)

    // ── 6 · LE VOCI APERTE DEI (MASSIMO 20) TROVATI, IN UNA LETTURA SOLA ────
    // Una query per bambino sarebbe un N+1 su una schermata che si ridisegna a
    // ogni tasto battuto. Il residuo è `residuoEffettivo` — importo − sconto −
    // incassato, clampato a zero — e non una sottrazione riscritta qui: su una
    // voce scontata i due numeri divergono, e a valle c'è una fattura.
    //
    // 🔴 QUI «APERTA» VUOL DIRE RESIDUO > 0, non `stato IN ('da_pagare',
    // 'parziale','scaduto')` come in `/api/pagamenti?solo_aperti=true` e nella
    // lettura di `riconciliazione:GET` (la terna di `STATI_APERTI` in
    // `@/lib/pagamenti/aging`). La divergenza è deliberata: su una schermata che
    // INCASSA, l'unica domanda è «quanto manca», e `stato` è una colonna che un
    // trigger aggiorna dopo — una voce saldata con lo stato non ancora girato
    // comparirebbe come debito, e un abbuono registrato come sconto no. Il
    // residuo coincide con `statoEffettivo`, che infatti dalle date e dal
    // residuo lo ricalcola.
    //
    // ⚠️ IL TETTO È DICHIARATO (`BLOCCO_VOCI`), non sperato: senza `.limit()`
    // PostgREST taglia a `db-max-rows` e non lo dice, e una finestra tagliata
    // qui non sbaglia di poco — sottrae voci al residuo di un bambino su una
    // schermata che sta per incassare un bonifico.
    let vociRes = await supabase.from('pagamenti').select(SEL_VOCI).in('alunno_id', ids).limit(BLOCCO_VOCI)
    if (vociRes.error && (vociRes.error as { code?: string }).code === '42703') {
      logEvento('db', 'info', {
        operazione: OPERAZIONE,
        esito: 'colonna-sconto-assente',
        entita_tipo: 'pagamenti',
        error_code: '42703',
      })
      vociRes = (await supabase
        .from('pagamenti')
        .select(SEL_VOCI_BASE)
        .in('alunno_id', ids)
        .limit(BLOCCO_VOCI)) as typeof vociRes
    }
    // Pagina PIENA = finestra probabilmente tagliata. Si degrada come per un
    // errore di lettura — a `null`, mai a un conteggio corto — perché un numero
    // più basso del vero qui è peggio di un trattino: dice «deve meno di così».
    const vociTroncate = !vociRes.error && ((vociRes.data ?? []) as unknown[]).length >= BLOCCO_VOCI
    if (vociTroncate) {
      logEvento('pagamento', 'warn', {
        operazione: OPERAZIONE,
        esito: 'voci-aperte-finestra-troncata',
        entita_tipo: 'pagamenti',
        // Quanti bambini stavano nella finestra. NON il tetto: `BLOCCO_VOCI` è
        // una costante, e un campo che dice sempre la stessa cosa è peggio di un
        // campo che manca — sembra un'informazione.
        n: ids.length,
      })
    }
    const vociLette = !vociRes.error && !vociTroncate
    if (vociRes.error) {
      // Degrado a `null`, non a zero: vedi la testata. Un warn, perché «nessuna
      // voce aperta» e «non ho potuto guardare» qui si somigliano troppo.
      logEvento('pagamento', 'warn', {
        operazione: OPERAZIONE,
        esito: 'voci-aperte-non-lette',
        entita_tipo: 'pagamenti',
        n: ids.length,
        ...codiceErroreDi(vociRes.error),
      }, vociRes.error)
    }
    const conteggio = new Map<string, { voci: number; residuo: number }>()
    for (const v of (vociRes.data ?? []) as (AgingPagamento & { alunno_id?: string | null })[]) {
      const alunnoId = testo(v.alunno_id)
      // I contenitori `padre` non si incassano: sono la somma delle rate figlie,
      // e contarli raddoppierebbe il dovuto di ogni piano a rate.
      if (!alunnoId || v.tipo === 'padre') continue
      const residuo = residuoEffettivo(v)
      if (residuo <= 0) continue
      const acc = conteggio.get(alunnoId) ?? { voci: 0, residuo: 0 }
      acc.voci += 1
      acc.residuo += residuo
      conteggio.set(alunnoId, acc)
    }

    // ── 7 · C'È UN PAGANTE? La stessa regola che userà la CONFERMA ──────────
    // `pagantiAmmessiPerAlunni` è il modulo da cui passano tutt'e due le porte
    // che decidono chi può pagare (il contesto che lo MOSTRA, `componi` che lo
    // SCRIVE). Ricavare qui un «ha un genitore» con una query propria vorrebbe
    // dire un terzo verdetto sulla stessa domanda: si vedrebbe un bambino
    // «pronto» che alla conferma non ha nessun intestatario possibile.
    const ammessi = await pagantiAmmessiPerAlunni(supabase, ids, OPERAZIONE)
    const conPagante = new Set(ammessi.legami.map((l) => l.student_id))

    // ── 8 · I NOMI DELLE SEDI (la busta, non la riga) ───────────────────────
    const idSedi = [...new Set(righe.map((a) => testo(a.scuola_id)).filter((s): s is string => !!s))]
    const sediNome: Record<string, string> = {}
    if (idSedi.length > 0) {
      const sc = await supabase.from('scuole').select('id, nome').in('id', idSedi)
      if (sc.error) {
        // Il degrado è l'ASSENZA della chiave, mai una stringa inventata: la
        // schermata dirà «un altro plesso» senza nominarlo, che è vero.
        logEvento('pagamento', 'warn', {
          operazione: OPERAZIONE,
          esito: 'nomi-sedi-non-letti',
          entita_tipo: 'scuole',
          n: idSedi.length,
          ...codiceErroreDi(sc.error),
        }, sc.error)
      }
      for (const s of (sc.data ?? []) as { id?: string; nome?: string | null }[]) {
        const nome = testo(s.nome)
        if (s.id && nome) sediNome[s.id] = nome
      }
    }

    const data: AlunnoRicerca[] = righe.map((a) => {
      const cognome = testo(a.cognome)
      const nome = testo(a.nome)
      /**
       * ⚠️ `testoCorrisponde` e non un `includes` grezzo: normalizza accenti e
       * apostrofi da tutt'e due i lati, che è l'unico modo perché «Niccolo»
       * digitato senza accento risulti trovato PER NOME invece che spacciato
       * per un aggancio sul codice fiscale.
       */
      const perNome = testoCorrisponde([nome, cognome, `${cognome ?? ''} ${nome ?? ''}`], termine)
      const perCf = testoCorrisponde([testo(a.codice_fiscale)], termine)
      const aperte = conteggio.get(a.id) ?? null
      return {
        alunno_id: a.id,
        nome: [cognome, nome].filter(Boolean).join(' ').trim() || 'Bambino senza nome',
        classe_sezione: testo(a.classe_sezione),
        scuola_id: testo(a.scuola_id),
        attivo: statoLetto ? eAncoraIscritto(a.stato) : true,
        voci_aperte: vociLette ? (aperte?.voci ?? 0) : null,
        // Due decimali: è denaro, e la somma in virgola mobile di tre residui
        // produce code come `128.60000000000002`.
        residuo_aperto: vociLette ? Math.round((aperte?.residuo ?? 0) * 100) / 100 : null,
        // `completo: false` = una delle due sorgenti del ponte non si è letta.
        // Allora `false` direbbe «non ha nessun adulto», che è un'altra cosa.
        ha_pagante: ammessi.completo ? conPagante.has(a.id) : null,
        // Trovato PER codice fiscale = il codice corrisponde e il nome no. È
        // ciò che serve a chi legge («non si chiama così, ma il CF è suo»), ed
        // è tutto quello che del codice fiscale attraversa il confine.
        trovato_per_cf: perCf && !perNome,
      }
    })

    // 🔴 CONTEGGI, MAI IL TERMINE: è un cognome o un codice fiscale di un
    // minore, e `app_log` si conserva 30 giorni ed è interrogabile in SQL.
    logEvento('pagamento', 'info', {
      operazione: OPERAZIONE,
      esito: 'ricerca-alunni',
      n: data.length,
      troncato,
      sedi: sedi.length,
    })

    return rispondi(data, troncato, sediNome)
  } catch (err) {
    // `withRoute` NON vede le eccezioni catturate: senza questa riga il 500
    // uscirebbe muto.
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return NextResponse.json(
      {
        error: 'Non è stato possibile cercare i bambini: riprova fra poco.',
        codice: 'CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA',
      },
      { status: 500 },
    )
  }
})
