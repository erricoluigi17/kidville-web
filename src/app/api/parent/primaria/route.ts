import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { limitaAiFatti } from '@/lib/presenze/finestra-trascorsa'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { addGiorni } from '@/lib/format/data'
import { zDataYMD, zOpzionale } from '@/lib/validation/common'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { firmaPercorsi, percorsoNelBucket } from '@/lib/allegati/storage'

// ─── IL CONTENITORE DEGLI ALLEGATI DEL REGISTRO ──────────────────────────────
//
// È PRIVATO (`public: false`, deciso in `primaria/allegati:POST`), e in tabella
// `allegati_registro.file_url` porta il PERCORSO dentro il contenitore
// (`registro/<uuid>/<timestamp>-<rnd>.jpg`), non un indirizzo: l'indirizzo lo
// genera la LETTURA, firmato e a scadenza breve, dietro al gate della route che
// lo serve. Stesso modello di galleria, avvisi, incarichi e chat.
//
// Il nome è ripetuto qui perché `primaria/allegati/route.ts` lo tiene in una
// `const` non esportata. Due stringhe uguali in due file sono due cose da tenere
// allineate: la casa giusta è `@/lib/allegati/storage`, accanto a
// `BUCKET_AVVISI_ALLEGATI` e `BUCKET_TASK_ALLEGATI`, insieme alle altre due
// route che lo nominano (`primaria/allegati`, `primaria/registro`).
const BUCKET_REGISTRO_ALLEGATI = 'registro-allegati'

/** Un allegato come esce dal join `allegati_registro(...)`. */
type AllegatoRegistro = {
  id: string
  tipo: string | null
  file_url: string | null
  file_name: string | null
}

// ─── LA FINESTRA DEL REGISTRO: IL PREIMPOSTATO E IL TETTO ────────────────────
//
// 14 giorni è il PREIMPOSTATO DELLA BACHECA — quanto registro vede il genitore
// che apre `/parent/compiti` senza chiedere niente — e NON un limite tecnico:
// la colonna `registro_orario.data` è indicizzata e la sezione produce una
// manciata di righe al giorno. Fino al 2026-09-19 era però l'unica finestra
// possibile, perché nessun parametro sapeva spostarla: dopo una pausa — una
// malattia, le vacanze di Natale — la bacheca rispondeva «Nessun compito
// assegnato di recente» con il registro pieno, e al genitore non restava alcun
// modo di guardare più indietro. Da qui `dataDa`.
//
// Resta 14 e non 30 perché è ciò che la bacheca mostra all'apertura: alzarlo
// cambierebbe in silenzio la prima schermata di tutte le famiglie (e il peso di
// ogni chiamata delle altre pagine che leggono questa stessa route senza
// `dataDa`), che è una decisione di prodotto, non un effetto collaterale di un
// filtro nuovo.
const GIORNI_REGISTRO_PREDEFINITI = 14

// Il tetto di `dataDa`: un anno scolastico abbondante. Oltre, si RIFIUTA con
// 400 invece di clampare in silenzio — un clamp restituirebbe una pagina che
// non corrisponde a ciò che è stato chiesto, e il genitore leggerebbe «non c'è
// nient'altro» dove la risposta vera è «più indietro di così non si guarda».
const GIORNI_REGISTRO_MASSIMI = 365

/**
 * QUANTE RIGHE DI REGISTRO SI LEGGONO IN UNA RISPOSTA, e perché proprio 500.
 *
 * 🔴 IL DIFETTO CHE QUESTA COSTANTE CHIUDE L'ABBIAMO INTRODOTTO NOI, il
 * 2026-09-19, e non è di chi ha scritto il selettore di periodo: è una
 * conseguenza che nessuno aveva misurato. Fino a questo ramo la finestra era
 * FISSA a 14 giorni e il problema non poteva darsi; da quando la bacheca arriva
 * all'anno scolastico (~364 giorni), la stessa query senza `.limit()` può
 * chiedere più righe di quante PostgREST ne restituisca.
 *
 * 🔴 PostgREST TRONCA DA SOLO, E NON LO DICE. `supabase/config.toml:18`
 * dichiara `max_rows = 1000` (ed è anche il valore del progetto ospitato): una
 * lettura senza tetto che ne trovasse 1.400 ne riceverebbe 1.000, dentro un 200
 * identico a quello completo. E con l'ordine `data DESC` a sparire sarebbe la
 * parte più VECCHIA della finestra — cioè esattamente ciò che il genitore ha
 * chiesto quando ha allargato il periodo. È lo stesso difetto che la corsia
 * gemella ha appena chiuso sull'altro lato dell'app (`api/primaria/compiti`,
 * la linguetta del docente).
 *
 * QUANTO SERVE, misurato in produzione il 2026-09-19:
 *
 *   SELECT max(ore) FROM (SELECT section_id, data, count(*) AS ore
 *                           FROM registro_orario GROUP BY 1, 2) t;   → 5
 *
 * Cinque ore in ogni giorno di lezione, lunedì-venerdì. Una classe compilata per
 * intero fa quindi ~5 righe × ~200 giorni di lezione ≈ **1.000 righe di anno
 * scolastico**: il tetto di PostgREST, esatto. Oggi è LATENTE — in tutta la
 * produzione `registro_orario` ha 97 righe — ma latente non vuol dire innocuo:
 * vuol dire che il giorno in cui morde non se ne accorge nessuno.
 *
 * PERCHÉ 500 E NON 1.000 NÉ 300:
 *  · sta COMODAMENTE sotto il mille, non appena sotto: a tagliare siamo noi, in
 *    un punto che conosciamo, e resta vero anche se un domani `max_rows`
 *    scendesse. Un tetto pari a `max_rows` sarebbe indistinguibile dal suo;
 *  · 500 righe = 100 giorni di lezione = 20 settimane. Delle quattro scelte
 *    della bacheca (14 · 30 · 90 giorni · anno) le prime tre stanno dentro con
 *    margine anche per una classe compilata per intero (~50, ~105, ~320 righe):
 *    a poter eccedere è la sola «anno in corso», e solo da metà anno in poi.
 *    Con 300 — il tetto della route sorella, che però PAGINA — a troncare
 *    sarebbe già «90 giorni», cioè tre scelte su quattro;
 *  · `count: 'exact'` rende il taglio DICHIARABILE invece che indovinabile: il
 *    conteggio lo fa il database sull'intera finestra e non risente del
 *    `.limit()`, quindi `totale > lette` è un fatto letto, non una stima
 *    ricavata dall'aver riempito il tetto.
 *
 * 🔴 E QUESTA ROUTE **NON SI PAGINA**, deliberatamente — è l'altra differenza
 * con la sorella. `api/primaria/compiti` serve UNA linguetta e può quindi
 * permettersi un cursore: chi la chiama è uno solo, e «carica i compiti
 * precedenti» è un gesto che quella schermata ha. Qui la risposta è un
 * PACCHETTO che TRE consumatori ricevono in una chiamata sola, e due dei tre non
 * hanno nessun comando con cui chiedere il seguito:
 *
 *   · `parent/compiti/page.tsx:72`        la bacheca Compiti — l'unica con un
 *                                         gesto, il selettore di periodo, che
 *                                         però SPOSTA la finestra e non scorre
 *                                         le righe: non è un «carica altro»;
 *   · `parent/lezioni/page.tsx:23`        nessun comando;
 *   · `lib/auth/use-child-school-type.ts` (la `fetch` dentro l'hook: si cita per
 *     NOME perché il numero è già invecchiato una volta — quel file è passato da
 *     33 a 482 righe mentre questo lavoro era in corso)  un hook, che una schermata su cui
 *                                         premere non ce l'ha proprio.
 *
 * ⚠️ TRE, NON QUATTRO, e il numero è stato scritto sbagliato qui per primo: le
 * pagine sotto `/parent/primaria/*` chiamano le dieci SOTTO-route (`/note`,
 * `/assenze`, `/orario`, `/valutazioni`, `/pagella`, `/scrutinio`…), non questa,
 * e `parent/primaria/page.tsx` non fa nessuna `fetch`. Il numero non si ricopia
 * da qui: `grep -rn 'api/parent/primaria?' src` lo rifà in un secondo (la prima
 * riga che stampa è questa route, le altre sono i chiamanti).
 *
 * Aggiungere un cursore cambierebbe comunque il contratto per tutti e tre,
 * compresi i due che di questo filtro non sanno niente. Il tetto quindi taglia
 * davvero: l'unica cosa che si può fare — e che si fa — è DIRLO.
 */
const RIGHE_REGISTRO_MASSIME = 500

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi degrada a 404 dalla
// query su `alunni` — stesso criterio di parent/competenze.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
  // Inizio della finestra del REGISTRO, e di nient'altro (vedi la testata della
  // GET). Facoltativo: assente = il preimpostato qui sopra, che è il
  // comportamento di ogni chiamante scritto prima di questo parametro.
  //
  // `zDataYMD` e non una regex: valida anche il CALENDARIO, quindi `2026-02-30`
  // si ferma qui invece di arrivare a Postgres e tornare come 500 (22008).
  //
  // `zOpzionale` e non un `.optional()` nudo: una barra filtri non toglie il
  // parametro dall'indirizzo quando il periodo torna a «tutto», ci lascia la
  // STRINGA VUOTA — e `.optional()` da solo la consegna a `zDataYMD`, che la
  // rifiuta: un 400 su un filtro AZZERATO, cioè sull'azione più innocua della
  // barra. Il commento di `@/lib/validation/common` mette in guardia proprio da
  // questo caso, ed è la convenzione già seguita da `zPeriodo` e
  // `zTestoRicerca`. Qui `''` vale «non specificato», cioè il preimpostato.
  //
  // Il tetto è un `.refine` e non un controllo nel corpo perché così vive
  // accanto alla forma del dato e risponde PRIMA di qualunque lettura: il 400
  // esce senza aver toccato il database. Sta DENTRO `zOpzionale`, cioè prima
  // dell'`.optional()` che quella applica: con `dataDa` assente o vuoto il
  // valore è già `undefined` e il refine non viene nemmeno valutato.
  dataDa: zOpzionale(
    zDataYMD.refine(
      (d) => d >= addGiorni(oggiFiscaleISO(), -GIORNI_REGISTRO_MASSIMI),
      `Data troppo lontana: il registro è consultabile fino a ${GIORNI_REGISTRO_MASSIMI} giorni indietro`,
    ),
  ),
})

// GET /api/parent/primaria?studentId=&userId=&dataDa=
// Vista genitore (read-only) del registro primaria del figlio, con OSCURAMENTO:
// gli argomenti/compiti "propri" del docente di sostegno sono visibili solo se il
// figlio è tra i destinatari. Valutazioni mostrate dopo il buffer notifica.
//
// `dataDa` (YYYY-MM-DD, facoltativo) sposta indietro l'inizio della finestra del
// solo `registro_orario`. È un INGRESSO, non un contratto già onorato: chi lo
// manderà è il selettore di periodo della bacheca Compiti
// (`src/app/(dashboard)/parent/compiti/page.tsx`), che vive in un altro file —
// quindi questa riga non è in grado di dire se oggi lo manda davvero, e non lo
// afferma. Chi ha bisogno di saperlo lo chieda al repo, non al commento:
// `grep -rn "dataDa" src/app` risponde in un secondo ed è sempre aggiornato.
// La route in ogni caso non lo pretende: assente o vuoto, vale il preimpostato
// qui sopra, che è ciò che vede ogni chiamante scritto prima. Le altre quattro
// raccolte della risposta (valutazioni, note disciplinari, presenze, materie)
// NON lo leggono e non devono: questa route serve anche `/parent/lezioni` e
// l'hook `use-child-school-type` (l'elenco completo dei tre consumatori sta
// sulla costante `RIGHE_REGISTRO_MASSIME`), e allargare quelle finestre insieme
// al registro cambierebbe in silenzio schermate che nessuno ha chiesto di
// toccare.
export const GET = withRoute('parent/primaria:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId, dataDa } = q.data

    // ─── IL CONTROLLO ERA SCRITTO COME UN PERMESSO, E PER METÀ DEGLI ATTORI
    //     NON CONTROLLAVA NIENTE ─────────────────────────────────────────────
    //
    // Diceva:
    //   `if (agisceComeGenitore(auth.user)) { …serve il legame col bambino… }`
    // cioè «se stai guardando in veste di famiglia e quel bambino non è tuo
    // figlio, ti nego». Per chiunque NON agisse da genitore — un educator di
    // un'altra sezione o di un'altra sede, la cuoca, la segreteria di un altro
    // plesso — il controllo non era permissivo: NON C'ERA. Il gate a monte era
    // `requireUser`, che ammette OGNI utente autenticato, e il client è
    // `createAdminClient()` (service-role), che scavalca la RLS: questa riga era
    // l'unica cosa fra un account qualunque e il registro di un minore indicato
    // per uuid — lezioni, valutazioni, NOTE DISCIPLINARI in testo libero e
    // assenze con lo stato della giustificazione.
    //
    // Il rimedio NON è scambiare il predicato con `eFamiglia`: lascerebbe in
    // piedi la stessa forma (nego a un genitore, non chiedo niente agli altri).
    // La domanda giusta non è «di che ruolo sei» ma «questo bambino ti è
    // raggiungibile?», e `requireParentOfStudent` la risponde per TUTTI: legame
    // di famiglia per chi è famiglia — biforcando sul LEGAME e non sulla veste,
    // così le cinque docenti-genitori aprono il registro del proprio figlio
    // anche fuori dalle sezioni che insegnano — plesso e sezione per tutti gli
    // altri, che è il perimetro con cui l'educator continua a leggere i bambini
    // delle proprie classi e la segreteria tutte le classi del proprio plesso.
    //
    // Era l'ULTIMA delle otto route della primaria senza questo gate: le sette
    // sorelle (`{assenze,note,orario,pagella,scrutinio,valutazioni}:GET` e
    // `pagella/firma:POST`) ci passano già, e servono gli stessi dati.
    //
    // Il gate sta PRIMA di `createAdminClient()`: dopo un 403 non deve partire
    // nemmeno una lettura.
    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, cognome, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Tipo scuola della sezione (per la vista adattiva lato client).
    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).maybeSingle()
      schoolType = sez?.school_type ?? null
    }

    if (schoolType !== 'primaria') {
      // Il registro qui non si legge nemmeno: la finestra è letta per intero
      // perché non c'è niente da leggere. Il campo c'è lo stesso — un contratto
      // che compare e scompare a seconda del ramo costringe ogni chiamante a un
      // `?.` in più, e quel `?.` è il posto dove il troncamento torna a essere
      // silenzioso.
      return NextResponse.json({
        success: true,
        data: {
          schoolType, child: alunno, lezioni: [], valutazioni: [], note: [], assenze: [], materie: [],
          finestraRegistro: { troncata: false, lette: 0, totale: 0 },
        },
      })
    }

    // Buffer notifica (per la visibilità delle valutazioni).
    const { data: settings } = await supabase
      .from('admin_settings')
      .select('notif_buffer_valutazioni_min')
      .eq('scuola_id', alunno.scuola_id)
      .maybeSingle()
    const bufferMin = settings?.notif_buffer_valutazioni_min ?? 10
    const sogliaVal = new Date(Date.now() - bufferMin * 60_000).toISOString()

    // L'inizio della finestra di registro per la sezione: quella chiesta dal
    // client, oppure gli ultimi `GIORNI_REGISTRO_PREDEFINITI` giorni.
    //
    // Il giorno di partenza è `oggiFiscaleISO()` (Europe/Rome) e non più un
    // `Date.now()` letto in UTC: il runtime gira in UTC e fra mezzanotte e le
    // due del mattino `toISOString()` restituisce ancora IERI — la stessa
    // famiglia di difetti che il resto del repo ha già pagato quattro volte
    // (vedi `@/lib/presenze/finestra-trascorsa`). Qui valeva un giorno di
    // registro in più o in meno in quella fascia; ora il giorno lo decide il
    // fuso in cui la scuola sta.
    const da = dataDa ?? addGiorni(oggiFiscaleISO(), -GIORNI_REGISTRO_PREDEFINITI)

    // ⚠️ SI DESTRUTTURA IL SOLO `{ data }`, E QUESTO È UN DIFETTO NOTO —
    //    preesistente, identico su `main`, NON introdotto da `dataDa`.
    //
    // PostgREST non lancia: ritorna `{ data: null, error }`. Un guasto sulla
    // lettura di `registro_orario` (rete, RLS, colonna rinominata) arriva qui
    // come `registro = null`, diventa `registro ?? []` poco più sotto ed esce
    // come una risposta 200 con zero lezioni — cioè ESATTAMENTE il sintomo che
    // questa finestra esiste per curare, «Nessun compito assegnato di recente»,
    // senza errore per il genitore e senza log applicativo. Vale allo stesso
    // modo per le altre quattro letture.
    //
    // Non si corregge QUI: gestire l'`error` cambia ciò che vedono i TRE
    // consumatori di questa route (`/parent/compiti`, `/parent/lezioni` e l'hook
    // `use-child-school-type` — elencati con file e riga sulla costante
    // `RIGHE_REGISTRO_MASSIME`), ed è un intervento suo — con i suoi test e la
    // sua voce di PRD — non un effetto collaterale di un filtro nuovo. Chi passa
    // di qui e ha quel mandato: parte da questa riga.
    const [{ data: registro, count: totaleRegistro }, { data: valutazioni }, { data: note }, { data: assenze }, { data: materie }] = await Promise.all([
      supabase
        .from('registro_orario')
        .select(
          `
          id, data, ora_lezione, materia, argomento, compiti, data_consegna_compiti,
          materie(nome),
          firme_docenti(id, argomento_proprio, compiti_propri),
          registro_destinatari(firma_id, alunno_id),
          allegati_registro(id, tipo, file_url, file_name)
        `,
          // Il conteggio lo fa il DATABASE sull'intera finestra, e NON risente
          // del `.limit()` qui sotto: è la differenza fra «ho letto tutto» e «ho
          // riempito il tetto», che senza di lui non si distinguono. Costa un
          // `count(*)` su `(section_id, data)`, che è filtro indicizzato e non
          // una scansione: il prezzo di sapere quanto non si è letto.
          { count: 'exact' },
        )
        .eq('section_id', alunno.section_id)
        .gte('data', da)
        .order('data', { ascending: false })
        .order('ora_lezione')
        // Il tetto ESPLICITO, e il motivo per cui non è 1.000 né un cursore sta
        // tutto sulla costante. Qui basta la conseguenza: oltre questa riga la
        // finestra non è letta per intero, e la risposta lo dichiara.
        .limit(RIGHE_REGISTRO_MASSIME),
      supabase
        .from('valutazioni')
        .select('id, materia, tipo, modalita, argomento, giudizio_sintetico, giudizio_testo, creato_il')
        .eq('alunno_id', studentId)
        .not('modalita', 'is', null)
        .lte('creato_il', sogliaVal)
        .order('creato_il', { ascending: false }),
      supabase
        .from('note_disciplinari')
        .select('id, categoria, testo, richiede_firma, firmata_il, creato_il')
        .eq('alunno_id', studentId)
        .order('creato_il', { ascending: false }),
      // Assenze/ritardi/uscite degli ultimi 30 giorni, con stato giustificazione.
      //
      // Il tetto a OGGI (rilievo T26): questa lettura non aveva alcun limite
      // superiore, e da quando «Comunica un'assenza» scrive nel futuro un giorno
      // non ancora arrivato sarebbe comparso fra le assenze del bambino. Oggi è
      // latente — il suo unico consumatore, `PrimariaParentView`, non è montato
      // da nessuna pagina — ma è una porta aperta, e la regola sta in un posto
      // solo (`@/lib/presenze/finestra-trascorsa`). Con Q4 il tetto porta anche
      // il secondo asse (la SORGENTE): il solo `data <= oggi` non esclude
      // l'assenza annunciata per il giorno corrente.
      limitaAiFatti(
        supabase
          .from('presenze')
          .select('id, data, stato, giustificata, giustificazione_testo, giust_vista_il')
          .eq('alunno_id', studentId)
          .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
          .gte('data', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)),
      ).order('data', { ascending: false }),
      // Materie della sezione (per il selettore della giustifica didattica).
      supabase
        .from('materie')
        .select('id, nome')
        .eq('section_id', alunno.section_id)
        .eq('attiva', true)
        .order('ordine'),
    ])

    // ─── L'ALLEGATO USCIVA COME PERCORSO, CIOÈ COME LINK MORTO ───────────────
    //
    // `file_url` è un percorso dentro un contenitore PRIVATO. Restituito grezzo,
    // il browser della famiglia lo risolveva come indirizzo RELATIVO
    // (`https://app.kidville.it/parent/compiti/registro/<uuid>/…`) e rispondeva
    // 404: nessun errore, nessun log, soltanto un allegato che non si apre.
    //
    // Si firma IN BLOCCO — una chiamata allo Storage per pagina, non una per
    // allegato — con la stessa funzione di avvisi, incarichi e chat: stesso TTL
    // (10 minuti), stesso log col corpo dell'errore del provider, stessa
    // gestione del fallimento. Una firma inventata qui sarebbe una quinta forma
    // da tenere allineata.
    //
    // Il percorso si calcola UNA volta per allegato e si riusa: la funzione che
    // decide che cosa firmare dev'essere la stessa che decide che cosa
    // sostituire, altrimenti le due strade possono divergere in silenzio.
    const percorsoPerAllegato = new Map<string, string | null>()
    for (const r of registro ?? []) {
      for (const a of (r.allegati_registro ?? []) as AllegatoRegistro[]) {
        percorsoPerAllegato.set(a.id, percorsoNelBucket(BUCKET_REGISTRO_ALLEGATI, a.file_url))
      }
    }
    const percorsi = [...new Set([...percorsoPerAllegato.values()].filter((p): p is string => p !== null))]
    // `firmaPercorsi` con l'elenco vuoto non tocca lo Storage: la lezione senza
    // allegati non paga niente.
    const urlFirmato = await firmaPercorsi(
      supabase,
      BUCKET_REGISTRO_ALLEGATI,
      percorsi,
      'parent/primaria:GET',
    )

    // Applica oscuramento: contenuti "propri" visibili solo se il figlio è destinatario.
    const lezioni = (registro ?? []).map((r) => {
      const firme = (r.firme_docenti ?? []) as { id: string; argomento_proprio: string | null; compiti_propri: string | null }[]
      const dest = (r.registro_destinatari ?? []) as { firma_id: string; alunno_id: string }[]
      const extra = firme
        .filter((f) => (f.argomento_proprio || f.compiti_propri) && dest.some((d) => d.firma_id === f.id && d.alunno_id === studentId))
        .map((f) => ({ argomento: f.argomento_proprio, compiti: f.compiti_propri }))
      return {
        id: r.id,
        data: r.data,
        ora_lezione: r.ora_lezione,
        materia: (r.materie as { nome?: string } | null)?.nome ?? r.materia,
        argomento: r.argomento,
        compiti: r.compiti,
        data_consegna_compiti: r.data_consegna_compiti,
        // Chi non si è potuto firmare esce con `file_url: null` — MAI il
        // percorso grezzo, che come indirizzo non funziona lo stesso e
        // maschererebbe un guasto dello Storage da «allegato rotto». Il client
        // non rende nessuna ancora per un allegato senza indirizzo.
        allegati: ((r.allegati_registro ?? []) as AllegatoRegistro[]).map((a) => {
          const p = percorsoPerAllegato.get(a.id) ?? null
          return {
            id: a.id,
            tipo: a.tipo,
            file_name: a.file_name,
            file_url: p === null ? null : (urlFirmato.get(p) ?? null),
          }
        }),
        individualizzate: extra,
      }
    })

    // ─── LA FINESTRA LETTA, E QUANTA NE MANCA ────────────────────────────────
    //
    // ⚠️ QUESTO CAMPO PARLA DELLA FINESTRA, NON DEI COMPITI, e la distinzione
    // non è una sottigliezza: «non ho letto tutto il periodo» NON è «mancano dei
    // compiti». Una classe che segna le lezioni senza mai scrivere i compiti può
    // benissimo superare il tetto e restituire ZERO compiti insieme a un
    // troncamento vero — e in quel caso le due frasi «restringi» e «nessun
    // compito: prova ad allargare» si contraddicono a schermo. È la
    // contraddizione già misurata sull'altro lato dell'app: la bacheca la
    // risolve spegnendo l'invito ad allargare quando la finestra è troncata
    // (`LezioniCompitiSections.tsx`), perché allargare, con il taglio attivo,
    // non porta indietro NIENTE — le righe lette restano le stesse più recenti.
    //
    // ⚠️ RIGUARDA IL SOLO `registro_orario`, e un campo unico che dicesse «la
    // risposta è troncata» tirerebbe dentro tutte e cinque le raccolte senza
    // dire più niente di preciso su nessuna. Sulle altre quattro, però, la frase
    // comoda — «hanno finestre proprie e non sono toccate» — è VERA SOLO PER
    // DUE, e scriverla per tutte sarebbe la seconda volta in questo file che un
    // commento afferma un conteggio che una lettura smentisce:
    //
    //  · `presenze`   ha una finestra vera: 30 giorni indietro e `limitaAiFatti`
    //                 a chiudere il lato del futuro. Non può eccedere;
    //  · `materie`    è limitata per costruzione — le materie ATTIVE di UNA
    //                 sezione, che sono una manciata;
    //  · `valutazioni`      ha il solo estremo SUPERIORE `.lte('creato_il',
    //                 sogliaVal)`, che è il buffer notifica: nasconde ciò che è
    //                 appena stato scritto, non limita quanto indietro si legge;
    //  · `note_disciplinari` non ha NESSUN filtro di data.
    //
    // Le ultime due sono quindi **strutturalmente senza tetto**: niente finestra,
    // niente `.limit()`, niente `count`. Crescono per tutta la carriera
    // scolastica dell'alunno e la risposta le porta tutte — **fino al `max_rows`
    // di PostgREST**, che è 1.000 (`supabase/config.toml`) e vale per OGNI
    // lettura, non solo per quella che qui porta un `.limit()`. Oltre quella
    // soglia il taglio c'è comunque, ed è invisibile: esattamente il difetto che
    // la testata di questo file descrive per il registro. Due ordini di
    // grandezza sopra la misura di oggi (4 e 12 per alunno), quindi latente —
    // ma è il tetto vero, e chiamarlo «nessun tetto» sarebbe la stessa
    // imprecisione che questa corsia è stata bocciata per aver scritto.
    //
    // PERCHÉ RESTANO COSÌ, dichiarato invece che sottinteso. Misurato in
    // produzione il 2026-09-19 con due `max(count(*))` per alunno — interi, non
    // righe: 4 valutazioni e 12 note nel caso peggiore, cioè due ordini di
    // grandezza sotto il `max_rows` di PostgREST. E oggi nessuna schermata
    // MONTATA le rende: il loro consumatore è `PrimariaParentView`, che nessuna
    // pagina importa. Chiuderle vorrebbe dire cambiare un payload che questa
    // corsia ha promesso di non toccare, quindi è lavoro di chi avrà quel
    // mandato e non un effetto collaterale di un filtro sulla bacheca.
    //
    // E perché una scelta dichiarata non venga ribaltata in silenzio, il test
    // la PRETENDE: il `describe` «`valutazioni` e `note_disciplinari` restano
    // senza tetto» di `__tests__/api/parent-primaria-finestra-registro.test.ts`
    // riempie quelle due tabelle oltre il tetto del registro e vuole indietro
    // tutte le righe. Chi un domani le chiudesse trova un rosso qui invece di un
    // verde e mezza pagella in meno a schermo.
    //
    // `totale` è il conteggio del database, quindi `troncata` è un CONFRONTO fra
    // due numeri letti e non l'ipotesi «ho riempito il tetto, quindi forse ce
    // n'è ancora». Il ripiego esiste solo se `count` non arriva (`null`): lì
    // l'unico indizio è proprio il tetto riempito, e sbagliare dichiarando un
    // troncamento che non c'è è meno grave che tacerne uno che c'è.
    //
    // ⚠️ QUEL RAMO ORA SI VEDE FALLIRE. Era una scelta scritta e non provata:
    // sostituendo il ripiego con `false` — cioè tacendo il troncamento proprio
    // quando il conteggio manca — nessun test diventava rosso. Adesso sì
    // (`describe` «il conteggio che non arriva», nello stesso file), e lo stesso
    // vale per il `warn` qui sotto, che con `if (false)` restava invisibile.
    const lette = registro?.length ?? 0
    const totale = totaleRegistro ?? null
    const troncata = totale === null ? lette >= RIGHE_REGISTRO_MASSIME : totale > lette

    if (troncata) {
      // `warn` e non `info`: finché in produzione ci sono 97 righe di registro
      // questa riga non deve comparire MAI, e il giorno in cui comparisse è
      // l'informazione da cui si decide se alzare il tetto o dare alla bacheca
      // un modo di chiedere il seguito. Senza, «nessun log» non distinguerebbe
      // «non tronca mai» da «tronca e non lo sa nessuno» — che è la stessa
      // ambiguità delle email che rispondevano 403.
      logEvento('registro', 'warn', {
        operazione: 'parent/primaria:GET',
        esito: 'finestra-registro-troncata',
        sezione: alunno.section_id,
        limite: RIGHE_REGISTRO_MASSIME,
        n_lette: lette,
        n_totale: totale,
      })
    }

    return NextResponse.json({
      success: true,
      data: {
        schoolType, child: alunno, lezioni,
        valutazioni: valutazioni ?? [], note: note ?? [], assenze: assenze ?? [], materie: materie ?? [],
        finestraRegistro: { troncata, lette, totale },
      },
    })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
