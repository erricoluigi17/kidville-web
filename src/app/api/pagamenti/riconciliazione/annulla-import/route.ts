import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
// 🔴 LA RIAPERTURA NON SI RISCRIVE QUI. `riapriMovimento` è il codice del
// pulsante singolo: lo storno idempotente, la mappa degli errori della RPC, il
// compare-and-swap e l'avviso sulle fatture vive. La sua testata lo dice da prima
// che questo file esistesse — «un endpoint nuovo dovrà riaprire i bonifici IN
// BLOCCO, e deve passare esattamente di qui». Ricopiarlo è il modo certo di farlo
// divergere, e la seconda copia nascerebbe senza i rami che quella fetta ha
// imparato a suon di incidenti (il `KV409` del ritentativo, la marcatura muta di
// `stornato_il`, la RPC vecchia che non riapre).
import { riapriMovimento } from '@/lib/pagamenti/riapertura-movimento'
// La QUERY dell'insieme sta anch'essa fuori: la guardano tre porte (questo
// elenco, questo annullo, la notifica differita) e devono guardare le stesse
// righe. Il perché per esteso sta nella testata di quel modulo.
import { leggiRigheAutomatiche, TETTO_ANNULLO, type RigaAuto } from '@/lib/pagamenti/righe-automatiche'
import { percheAbbinato, type MotivoAbbinamentoUi } from '@/lib/pagamenti/motivo-abbinamento'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DISFARE IN BLOCCO CIÒ CHE LA MACCHINA HA CHIUSO DA SOLA.
 *
 * Due porte sullo stesso insieme di righe, e il fatto che siano due è il punto:
 *  · `GET`  — l'elenco di che cosa l'import ha chiuso da sé, con il PERCHÉ;
 *  · `POST` — lo storno di tutte quelle righe, una per una.
 *
 * ─── 🔴 PERCHÉ L'ELENCO STA QUI E NON SUL `GET` DEL REGISTRO ────────────────
 *
 * La consegna diceva di prendere l'elenco da
 * `GET /api/pagamenti/riconciliazione?import_id=…&stato=confermato`, «il filtro
 * esiste già». Esiste, ma risponde a una domanda DIVERSA, e la differenza non è
 * di comodità: quel filtro porta i confermati di un import — **tutti**, compresi
 * quelli che una persona ha confermato a mano dopo l'import — e non porta né la
 * marca `abbinato_auto_il` (non è in `COLONNE_REGISTRO`) né il motivo
 * dell'abbinamento, che non esiste in nessuna colonna (v. `./motivo-abbinamento`).
 *
 * Usarlo avrebbe prodotto il difetto peggiore che questa schermata possa avere:
 * **l'elenco e il bersaglio dell'annullo sarebbero stati due insiemi diversi**.
 * Il `POST` qui sotto cerca `abbinato_auto_il IS NOT NULL`; quella lista ne
 * avrebbe mostrati di più. E siccome la conferma si DIGITA — si scrive il numero
 * delle righe da riaprire — quel numero sarebbe stato il numero sbagliato:
 * l'unica cosa che costringe a guardare l'elenco avrebbe certificato un elenco
 * che non è quello che si sta per disfare.
 *
 * Quindi l'elenco lo fa la STESSA query dell'annullo (`leggiRigheAutomatiche`),
 * e «che cosa vedo» e «che cosa disfo» non possono divergere per costruzione. Il
 * `GET` del registro resta quello che è: nessuna riga di quel file è toccata.
 *
 * ─── IL PERIMETRO CAMBIA FRA LE DUE PORTE, ED È UNA DECISIONE DEL TITOLARE ──
 *
 * L'automatismo lavora su TUTTE E TRE le sedi anche quando chi importa ne
 * gestisce una sola (la deroga è dichiarata e loggata in
 * `@/lib/pagamenti/riconciliazione-auto-import`): l'estratto conto è uno solo
 * per i tre plessi, e senza quella deroga per due sedi su tre l'abbinamento
 * automatico non esisterebbe.
 *
 * **L'annullamento no.** Disfare è uno STORNO, cioè un movimento contabile
 * definitivo sul denaro di una sede, e lì il perimetro torna quello
 * dell'operatore (`resolveScuoleAttive`) — lo stesso gate del pulsante singolo.
 * Se anche UNA delle sedi toccate non è sua si risponde **403 prima di qualunque
 * scrittura**: mai un annullo a metà. Il `GET` lo dice PRIMA
 * (`annullabile: false`), così il pannello non offre nemmeno il pulsante.
 *
 * ⚠️ 403 e non 404, a differenza di `…/[id]:PATCH` che nasconde l'esistenza di
 * un movimento di un'altra sede. Qui nascondere non avrebbe senso: sono righe
 * dell'import che l'operatore ha appena caricato, su un registro che è
 * cross-sede per progetto e che ha già davanti. Ciò che va rifiutata è la
 * SCRITTURA, non la conoscenza — e un 404 su righe che ha sotto gli occhi
 * sarebbe solo un messaggio che non spiega niente.
 *
 * ─── NON È ATOMICA, E NON FINGE DI ESSERLO ──────────────────────────────────
 *
 * Sono N storni indipendenti: ognuno è una transazione contabile a sé (o una RPC
 * atomica, sul ramo composito). Non esiste un `BEGIN` che li tenga insieme, e
 * inventarne uno vorrebbe dire una RPC nuova che rifà dentro SQL il lavoro di
 * `riapriMovimento`. La risposta perciò non dice «fatto»: dice quante righe sono
 * tornate in coda, quante hanno fallito e con quale codice, quanti incassi sono
 * stati stornati, quante transazioni annullate.
 *
 * **Il ritentativo è idempotente per costruzione**, e non per promessa —
 * verificato leggendo `riapriMovimento`, non dedotto: quel modulo PROSEGUE,
 * invece di rifiutare, sia quando lo storno dell'incasso risulta già registrato
 * (il contro-incasso c'è: `stornoGiaRegistrato`, e i 404/409 di
 * `eseguiStornoIncasso`) sia quando la RPC risponde `KV409` «transazione già
 * annullata». E le righe già riaperte non rientrano nemmeno nella query: non
 * sono più `confermato`. Un secondo `POST` sullo stesso import trova soltanto
 * ciò che il primo ha lasciato indietro.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Lo stesso tetto dell'import (`…/riconciliazione:POST`), e per la stessa
 * ragione: il default di una Function è 10 secondi, e qui dentro possono esserci
 * fino a 200 storni, ognuno con la sua RPC o il suo contro-incasso. Il taglio
 * arriverebbe a metà del ciclo — cioè con parte delle righe riaperte e nessuna
 * risposta che dica quali.
 */
export const maxDuration = 300

const OPERAZIONE_GET = 'pagamenti/riconciliazione/annulla-import:GET'
const OPERAZIONE_POST = 'pagamenti/riconciliazione/annulla-import:POST'

// ─────────────────────────────────────────────────────────────────────────────
// GET — l'elenco di ciò che la macchina ha chiuso, col perché.
// ─────────────────────────────────────────────────────────────────────────────

const getQuerySchema = z.object({ import_id: zUuid })

/** Una riga dell'elenco, come la legge la schermata. */
interface RigaRiepilogo {
    id: string
    data_operazione: string
    importo: number
    /** La causale intera: il registro è l'estratto conto condiviso del titolare. */
    causale: string | null
    /**
     * La voce su cui la riga è stata chiusa: «Nome Cognome · descrizione».
     *
     * ⚠️ `null` FUORI DALLE PROPRIE SEDI, ed è la stessa minimizzazione del `GET`
     * del registro: il nome di un minore è arricchimento identificante e si
     * mostra solo per i plessi di chi guarda. La riga bancaria invece resta
     * visibile — l'estratto conto è uno solo per le tre sedi.
     * `null` anche quando la voce non si è potuta leggere: due assenze diverse
     * che per chi disegna una riga sono la stessa cosa — non c'è niente da
     * mostrare.
     */
    voce: string | null
    motivi: MotivoAbbinamentoUi[]
    /** Il codice voce riconosciuto in causale (`#K7MXN3P`), o `null`. */
    codice: string | null
    /** Ha saldato una transazione a più voci. */
    composita: boolean
    /** La sede di questa riga non è dell'operatore: lui non può stornarla. */
    fuori_perimetro: boolean
}

export const GET = withRoute('pagamenti/riconciliazione/annulla-import:GET', async (request: NextRequest) => {
    try {
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        const q = parseQuery(request, getQuerySchema)
        if ('response' in q) return q.response
        const importId = q.data.import_id

        const supabase = await createAdminClient()
        const lettura = await leggiRigheAutomatiche(supabase, importId, OPERAZIONE_GET)
        if ('errore' in lettura) return NextResponse.json(lettura.errore.body, { status: lettura.errore.status })
        if ('marcaAssente' in lettura) {
            // 200 con `disponibile: false`, non un errore: su questo ambiente la
            // funzione non c'è e il pannello deve semplicemente non offrirla. È la
            // stessa forma con cui il registro dichiara di non esistere.
            return NextResponse.json({ success: true, disponibile: false, data: null })
        }
        const righe = lettura.righe

        const sediAttive = new Set(await resolveScuoleAttive(request, supabase, auth.user))
        const dentro = (r: RigaAuto) => r.scuola_id !== null && sediAttive.has(r.scuola_id)

        // ── LE VOCI E I CODICI FISCALI, IN UNA LETTURA SOLA ───────────────────
        // Servono a due cose diverse: la descrizione (col nome del bambino) è ciò
        // che l'operatrice legge — «su quale voce» — mentre il codice fiscale
        // serve solo al CONFRONTO che ricostruisce il perché, e non esce di qui.
        // Mai una query per riga: duecento movimenti farebbero duecento
        // round-trip su una schermata che oggi ne fa una.
        //
        // 🔴 FILTRATE PER SEDE IN QUERY, e non solo alla fine. Il nome del minore
        // di un altro plesso non si mostra comunque (v. `RigaRiepilogo.voce`), ma
        // finché il filtro stava solo nel `.map()` finale quei nomi — e i CODICI
        // FISCALI — venivano comunque LETTI dal database e portati nel processo,
        // per essere buttati una riga dopo. Sono dati di minori: la minimizzazione
        // che vale è quella che non li legge affatto.
        //
        // ⚠️ IL PREZZO, dichiarato: sulle righe fuori perimetro il «perché» resta
        // ricostruibile solo dal CODICE VOCE (che nasce dall'uuid del pagamento e
        // non richiede nessuna lettura), mai dal codice fiscale — quindi su quelle
        // può uscire `non_ricostruito`. È il verso giusto: sono righe che
        // l'operatore non può comunque annullare da qui.
        // ⚠️ IL TAGLIO AL TETTO VIENE PRIMA DELLA LETTURA, non dopo. Oltre il
        // tetto `leggiRigheAutomatiche` restituisce esattamente `TETTO_ANNULLO + 1`
        // righe — la riga in più è quella che DIMOSTRA il superamento, ed è così
        // che dichiara `troppe` — e quella riga non esce nella risposta: leggerne
        // l'anagrafica vorrebbe dire portare nel processo nome, cognome e codice
        // fiscale di un minore **per buttarli una riga dopo**. È esattamente la
        // minimizzazione rivendicata qui sopra — «quella che vale è quella che
        // non li legge affatto» — e finché il taglio stava solo sul `.map()`
        // finale non era applicata proprio alla riga che nessuno vedrà mai.
        //
        // ⚠️ IL TAGLIO A `TETTO+1` LO FA IL LETTORE, e la frase qui sopra è vera
        // solo per quello: si pagina a blocchi di cento, quindi senza quel taglio
        // ciò che arriva qui sarebbe fino a `TETTO+100`. Il file lo dice perché
        // la differenza fra una riga e cento, su una rotta che rivendica la
        // minimizzazione, non è una sfumatura di prosa — ed è la stessa stima
        // sbagliata che aveva lasciato la notifica differita ferma al tetto
        // dell'annullo (v. `riepilogo-visto/route.ts`).
        const visibili = righe.slice(0, TETTO_ANNULLO)
        const pagIds = [...new Set(visibili.map((r) => r.pagamento_id).filter((v): v is string => !!v))]
        const vociDi = new Map<string, { etichetta: string | null; cf: string | null }>()
        // ⚠️ NESSUN `plessi.length > 0` nella condizione qui sotto, e il lock
        // `scope-vuoto-nega` esiste apposta: uno scope VUOTO deve NEGARE, non
        // saltare il filtro. Con l'elenco vuoto `.in('scuola_id', [])` non
        // restituisce nessuna riga — che è la risposta giusta per chi non ha
        // nessun plesso — mentre una guardia sulla lunghezza avrebbe prodotto,
        // un giorno, la tentazione di leggere tutto «visto che non c'è scope».
        const plessi = [...sediAttive]
        if (pagIds.length > 0) {
            // ⚠️ A blocchi di 100 come il `GET` del registro, e non perché là la
            // finestra sia più larga: gli uuid finiscono nella QUERY STRING, e 200
            // di essi (il tetto di questa rotta) fanno ~8 KB di sola request line
            // — cioè esattamente il muro oltre il quale nginx risponde 431. Il
            // tetto di questa rotta e quel muro sono troppo vicini per fidarsi.
            for (let i = 0; i < pagIds.length; i += 100) {
                const blocco = pagIds.slice(i, i + 100)
                const { data: pag, error: errPag } = await supabase
                    .from('pagamenti')
                    .select('id, descrizione, alunni:alunno_id ( nome, cognome, codice_fiscale )')
                    .in('id', blocco)
                    .in('scuola_id', plessi)
                if (errPag) {
                    // Non ferma niente — l'elenco esce comunque, con `voce: null` e
                    // il perché non ricostruito — ma tacere trasformerebbe un guasto
                    // di lettura in «questa riga non ha una voce», che è un'altra
                    // affermazione. PostgREST non lancia: l'errore sta nel valore.
                    logEvento('pagamento', 'warn', {
                        operazione: OPERAZIONE_GET,
                        esito: 'voci-del-riepilogo-non-lette',
                        import_id: importId,
                        n: blocco.length,
                        error_code: (errPag as { code?: string }).code ?? 'sconosciuto',
                    }, errPag)
                    continue
                }
                for (const p of (pag ?? []) as unknown as {
                    id: string
                    descrizione?: string | null
                    alunni?: { nome?: string | null; cognome?: string | null; codice_fiscale?: string | null } | null
                }[]) {
                    const nome = [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ').trim()
                    const desc = (p.descrizione ?? '').trim()
                    vociDi.set(p.id, {
                        etichetta: [nome || null, desc || null].filter(Boolean).join(' · ') || null,
                        cf: p.alunni?.codice_fiscale ?? null,
                    })
                }
            }
        }

        const dati: RigaRiepilogo[] = visibili.map((r) => {
            const voce = r.pagamento_id ? vociDi.get(r.pagamento_id) : undefined
            const perche = percheAbbinato({
                causale: r.causale,
                controparte: r.controparte,
                pagamentoId: r.pagamento_id,
                cfAlunno: voce?.cf ?? null,
                composita: r.transazione_id !== null,
            })
            const mio = dentro(r)
            return {
                id: r.id,
                data_operazione: r.data_operazione,
                importo: r.importo,
                causale: r.causale,
                // Il nome del minore solo per le proprie sedi (v. `RigaRiepilogo.voce`).
                voce: mio ? (voce?.etichetta ?? null) : null,
                motivi: perche.motivi,
                codice: perche.codice,
                composita: r.transazione_id !== null,
                fuori_perimetro: !mio,
            }
        })

        // ⚠️ Su TUTTE le righe, non solo sulle `visibili`, e apposta: questo
        // conteggio risponde a «l'annullo in blocco è offribile?», e il `POST`
        // guarda l'import intero — una sede altrui nascosta oltre il tetto lo
        // farebbe comunque rifiutare. Leggere `scuola_id` non costa nessuna
        // anagrafica: è una colonna che la query del registro ha già portato.
        const fuori = righe.filter((r) => !dentro(r)).length
        // Log di LETTURA, e non è rumore: la notifica differita parte da «il
        // riepilogo è stato guardato», e senza questa riga «nessuno l'ha aperto» e
        // «nessuno l'ha guardato» sarebbero lo stesso silenzio. Conteggi e uuid.
        logEvento('pagamento', 'info', {
            operazione: OPERAZIONE_GET,
            esito: 'riepilogo-import-letto',
            import_id: importId,
            n: righe.length,
            fuori_perimetro: fuori,
            troncato: lettura.troppe,
        })

        return NextResponse.json({
            success: true,
            disponibile: true,
            data: {
                import_id: importId,
                righe: dati,
                n: dati.length,
                /** Ci sono più righe del tetto: l'annullo in blocco rifiuterà. */
                oltre_tetto: lettura.troppe,
                tetto: TETTO_ANNULLO,
                /**
                 * ⚠️ Il pulsante si offre SOLO se tutto è annullabile, e il campo
                 * esce SEMPRE: `undefined` significherebbe insieme «si può» e «non
                 * lo so». Zero righe ⇒ niente da annullare ⇒ `false`.
                 */
                annullabile: dati.length > 0 && fuori === 0 && !lettura.troppe,
                fuori_perimetro: fuori,
            },
        })
    } catch (err) {
        // `withRoute` non vede le eccezioni catturate: senza questo log il 500
        // sarebbe muto.
        logErrore({ operazione: OPERAZIONE_GET, stato: 500 }, err)
        return NextResponse.json(
            {
                error: 'Non è stato possibile leggere il riepilogo di questo import.',
                // Il `GET` non scrive niente, quindi qui la frase «nessuna riga è
                // stata toccata» è vera per costruzione: è lo stesso codice della
                // lettura fallita, non uno nuovo.
                codice: 'ANNULLO_IMPORT_NON_LETTO',
            },
            { status: 500 },
        )
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST — l'annullo in blocco.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `conferma` è un `z.literal(true)`, non un booleano.
 *
 * Un `z.boolean()` avrebbe accettato `false` e obbligato il corpo della rotta a
 * ricontrollarlo — cioè un gate scritto due volte, di cui uno si dimentica. Qui
 * un corpo senza conferma è un **400 di validazione** e non arriva mai vicino a
 * una scrittura.
 *
 * ⚠️ La conferma DIGITATA (il numero delle righe) vive nella schermata e NON si
 * manda qui: un numero spedito dal client non dimostrerebbe niente — chi può
 * mandare `conferma: true` può mandare anche il numero giusto. A dimostrare
 * qualcosa è la query che segue, che quel numero lo ricalcola dal database. Il
 * campo serve a far guardare l'elenco a una PERSONA, ed è lì che deve restare.
 */
const postBodySchema = z.object({
    import_id: zUuid,
    conferma: z.literal(true),
})

/** Una riga che non è tornata in coda, col suo codice. */
interface Fallita {
    movimento_id: string
    stato: number
    codice: string
}

export const POST = withRoute('pagamenti/riconciliazione/annulla-import:POST', async (request: NextRequest) => {
    try {
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        const b = await parseBody(request, postBodySchema)
        if ('response' in b) return b.response
        const importId = b.data.import_id

        const supabase = await createAdminClient()
        const lettura = await leggiRigheAutomatiche(supabase, importId, OPERAZIONE_POST)
        if ('errore' in lettura) return NextResponse.json(lettura.errore.body, { status: lettura.errore.status })
        if ('marcaAssente' in lettura) {
            return NextResponse.json(
                {
                    error:
                        'L’annullamento in blocco non è disponibile su questo ambiente: ' +
                        'riapri i movimenti uno per uno dal registro.',
                    codice: 'ANNULLO_IMPORT_NON_DISPONIBILE',
                },
                { status: 503 },
            )
        }
        const righe = lettura.righe

        // ── IL TETTO, PRIMA DI QUALUNQUE SCRITTURA ────────────────────────────
        if (lettura.troppe) {
            logEvento('pagamento', 'warn', {
                operazione: OPERAZIONE_POST,
                esito: 'annullo-import-oltre-tetto',
                import_id: importId,
                n: righe.length,
            })
            return NextResponse.json(
                {
                    error:
                        `Questo import ha chiuso da solo più di ${TETTO_ANNULLO} movimenti: sono troppi per ` +
                        'annullarli in un colpo. Aprili dal registro filtrato per import e riaprili a gruppi.',
                    codice: 'ANNULLO_IMPORT_TROPPE_RIGHE',
                },
                { status: 422 },
            )
        }

        // Niente da disfare. Non è un errore, ed è anche il secondo `POST` di un
        // ritentativo riuscito: le righe già riaperte non sono più `confermato` e
        // non rientrano nella query. Si risponde 200 con gli zeri, che è la verità.
        if (righe.length === 0) {
            logEvento('pagamento', 'info', {
                operazione: OPERAZIONE_POST,
                esito: 'annullo_import_eseguito',
                import_id: importId,
                n: 0,
                riaperti: 0,
                falliti: 0,
                credito_gia_speso: 0,
                incassi_stornati: 0,
                transazioni_annullate: 0,
                fatture_vive: 0,
            })
            return NextResponse.json({
                success: true,
                data: {
                    riaperti: 0,
                    falliti: [],
                    credito_gia_speso: 0,
                    incassi_stornati: 0,
                    transazioni_annullate: 0,
                    fatture: [],
                },
            })
        }

        // ── IL GATE DI SEDE: TUTTO O NIENTE, PRIMA DI OGNI SCRITTURA ──────────
        //
        // Il perimetro torna quello dell'OPERATORE (v. il riquadro in testata):
        // l'automatismo ha lavorato su tutte e tre le sedi, disfare è uno storno e
        // si fa solo sulle proprie. Una riga senza sede non passa: `scuola_id` sul
        // movimento lo scrive la conferma — è la sede del pagamento, o quella del
        // documento sul ramo composito — quindi su una riga `confermato` è sempre
        // valorizzato, e un `null` qui vuol dire che non sappiamo dove quel denaro
        // sia stato registrato. «Non lo so» non è «è mia».
        const sediAttive = new Set(await resolveScuoleAttive(request, supabase, auth.user))
        const fuori = righe.filter((r) => r.scuola_id === null || !sediAttive.has(r.scuola_id))
        if (fuori.length > 0) {
            // Solo CONTEGGI: quante righe su quante. Mai le causali, che portano i
            // nomi delle famiglie, e nessun uuid di sede altrui.
            logEvento('pagamento', 'warn', {
                operazione: OPERAZIONE_POST,
                esito: 'annullo-import-fuori-perimetro',
                import_id: importId,
                n: fuori.length,
                totali: righe.length,
            })
            return NextResponse.json(
                {
                    error:
                        `${fuori.length} di questi movimenti sono stati chiusi su sedi che non gestisci: ` +
                        'annullarli è uno storno, e si fa dalla propria sede. Nessuna riga è stata toccata.',
                    codice: 'ANNULLO_IMPORT_FUORI_PERIMETRO',
                },
                { status: 403 },
            )
        }

        // ── LE TRANSAZIONI: «GIÀ ANNULLATA?», IN UNA LETTURA SOLA ─────────────
        //
        // È il verdetto che `riapriMovimento` si aspetta dal chiamante
        // (`transazioneGiaAnnullata`): con la transazione già annullata gli storni
        // ci sono già e la RPC non va richiamata — risponderebbe `KV409` — ma la
        // riapertura resta da fare. Sul pulsante singolo questa domanda la fa
        // `assertTransazioneInScope`, una riga alla volta; qui si fa a blocchi.
        //
        // ⚠️ FAIL-CLOSED: se non si riesce a leggere non si storna niente. Stessa
        // scelta del gate del pulsante singolo, e per lo stesso motivo — un
        // verdetto indovinato qui manda una RPC su una transazione di cui non
        // sappiamo lo stato.
        const txIds = [...new Set(righe.map((r) => r.transazione_id).filter((v): v is string => !!v))]
        const txAnnullate = new Set<string>()
        if (txIds.length > 0) {
            const { data: tx, error: errTx } = await supabase
                .from('pagamenti_transazioni')
                .select('id, scuola_id, annullata_il')
                .in('id', txIds)
            if (errTx || !tx) {
                logErrore(
                    { operazione: OPERAZIONE_POST, evento: 'annullo_import_transazioni_non_lette', stato: 503 },
                    errTx,
                )
                return NextResponse.json(
                    {
                        error:
                            'Non è stato possibile verificare le transazioni di questi bonifici: ' +
                            'l’annullamento è stato fermato e nessuna riga è stata toccata.',
                        codice: 'ANNULLO_IMPORT_NON_LETTO',
                    },
                    { status: 503 },
                )
            }
            const lette = tx as unknown as { id: string; scuola_id: string | null; annullata_il: string | null }[]
            // ⚠️ IL GATE DI SEDE SI RIPETE SULLA TRANSAZIONE, e non è un doppione
            // di quello qui sopra: la sede del DOCUMENTO può legittimamente
            // differire da quella della voce àncora (un bonifico può pagare figli
            // di plessi diversi, e il documento è uno solo), e
            // `annulla_transazione_contabile` è `SECURITY DEFINER` — nessun filtro
            // le arriva addosso. È lo stesso controllo che il pulsante singolo fa
            // in `assertTransazioneInScope`.
            const txFuori = lette.filter((t) => t.scuola_id === null || !sediAttive.has(t.scuola_id))
            // Una transazione citata da una riga e non trovata affatto: la riga
            // esiste, il suo documento no. Non si indovina — si rifiuta, perché
            // proseguire manderebbe la RPC su una transazione che non abbiamo letto.
            const mancanti = txIds.length - lette.length
            if (txFuori.length > 0 || mancanti > 0) {
                logEvento('pagamento', 'warn', {
                    operazione: OPERAZIONE_POST,
                    esito: 'annullo-import-transazione-non-annullabile',
                    import_id: importId,
                    n: txFuori.length,
                    totali: txIds.length,
                })
                return NextResponse.json(
                    {
                        error:
                            'Alcuni di questi bonifici hanno prodotto un documento intestato a una sede che non ' +
                            'gestisci: annullarli è uno storno, e si fa dalla propria sede. Nessuna riga è stata toccata.',
                        codice: 'ANNULLO_IMPORT_FUORI_PERIMETRO',
                    },
                    { status: 403 },
                )
            }
            for (const t of lette) if (t.annullata_il !== null) txAnnullate.add(t.id)
        }

        // ── IL CICLO: N STORNI INDIPENDENTI ───────────────────────────────────
        let riaperti = 0
        let incassiStornati = 0
        let transazioniAnnullate = 0
        let creditoGiaSpeso = 0
        const falliti: Fallita[] = []
        /** L'avviso AGGREGATO sulle fatture: un elenco, non un avviso per riga. */
        const fatture: { movimento_id: string; numeri: string[] }[] = []

        for (const r of righe) {
            const esito = await riapriMovimento(supabase, {
                movimento: {
                    id: r.id,
                    pagamento_id: r.pagamento_id,
                    incasso_id: r.incasso_id,
                    transazione_id: r.transazione_id,
                },
                transazioneGiaAnnullata: r.transazione_id !== null && txAnnullate.has(r.transazione_id),
                // Le due colonne ci sono per costruzione: `transazione_id` sta nella
                // SELECT che è appena riuscita, e la marca sta nel suo `WHERE` — se
                // non ci fosse, non saremmo qui. È lo stesso ragionamento del
                // pulsante singolo (la risposta viene dalla lettura che si fa
                // comunque), non una sonda a parte che risponderebbe `false` anche
                // sui guasti transitori lasciando ACCESA la marca che mente.
                colonnaTransazione: true,
                colonnaMarca: true,
                attoreId: auth.user.id,
                operazione: OPERAZIONE_POST,
            })

            const codice = String((esito.body as { codice?: unknown }).codice ?? 'NESSUNO')
            if (!esito.ok) {
                // ⚠️ IL CREDITO GIÀ SPESO HA UN CONTATORE SUO, e non è pignoleria:
                // su quella riga `riapriMovimento` esce PRIMA di qualunque storno
                // (la RPC risponde `KV410` senza scrivere niente), quindi non è una
                // riapertura a metà — è una riga INTATTA che richiede un lavoro
                // diverso, cioè recuperare il credito speso. Le altre proseguono.
                if (codice === 'RIAPERTURA_CREDITO_GIA_SPESO') creditoGiaSpeso++
                falliti.push({ movimento_id: r.id, stato: esito.status, codice })
                // `error` e non `warn`: su ognuna di queste righe è rimasto denaro
                // attaccato a un bonifico che l'operatrice credeva di aver disfatto.
                // Sono poche per costruzione — il tetto è 200 — quindi una riga per
                // fallimento non è rumore: è l'elenco di ciò che resta da fare.
                logEvento('pagamento', 'error', {
                    operazione: OPERAZIONE_POST,
                    esito: 'annullo-import-riga-fallita',
                    import_id: importId,
                    movimento_id: r.id,
                    stato: esito.status,
                    error_code: codice,
                })
                continue
            }

            riaperti += esito.ok.movimentiRiaperti
            incassiStornati += esito.ok.incassiStornati
            if (esito.ok.transazioneAnnullata) transazioniAnnullate++

            // L'avviso sulle fatture vive si RACCOGLIE, non si emette per riga: su
            // un blocco, N avvisi identici sono rumore che nessuno legge.
            const avviso = (esito.body as { avviso?: { numeri?: unknown } }).avviso
            const numeri = Array.isArray(avviso?.numeri) ? (avviso.numeri as string[]) : []
            if (numeri.length > 0) fatture.push({ movimento_id: r.id, numeri })

            // Audit PER RIGA: la riapertura cancella `confermato_da`/`confermato_il`,
            // e senza questa riga nessuno saprebbe più chi ha disfatto che cosa.
            await logScrittura(supabase, {
                attore: auth.user,
                entitaTipo: 'riconciliazione_movimenti',
                entitaId: r.id,
                azione: 'update',
                scuolaId: r.scuola_id ?? undefined,
                valoreDopo: {
                    stato: 'da_abbinare',
                    transazione_annullata: esito.ok.transazioneAnnullata,
                    incassi_stornati: esito.ok.incassiStornati,
                    annullo_import: true,
                    import_id: importId,
                },
            })
        }

        // ── L'AVVISO SULLE FATTURE, E IL FATTO CHE DEVE ESSERE ZERO ───────────
        //
        // 🔴 L'automatismo NON emette fatture e non ne mette in coda (decisione
        // del titolare, scritta nella testata di `riconciliazione-auto-import`).
        // Quindi una fattura VIVA su una riga chiusa dalla macchina può esistere
        // solo se qualcuno l'ha emessa FRA l'import e questo annullo: quel
        // conteggio dovrebbe essere **zero**, e se non lo è la notizia non è «ci
        // sono delle fatture» — è che l'annullo sta arrivando TARDI, su righe che
        // qualcuno ha già lavorato. Per questo ha una riga sua invece di viaggiare
        // solo dentro i contatori del successo.
        if (fatture.length > 0) {
            logEvento('pagamento', 'warn', {
                operazione: OPERAZIONE_POST,
                esito: 'annullo-import-fatture-emesse-nel-frattempo',
                import_id: importId,
                n: fatture.length,
                totali: righe.length,
            })
        }

        // Una riga d'INSIEME accanto a quelle per movimento: l'annullo in blocco è
        // un gesto solo, e nel registro deve poterlo cercare chi sa che «quel
        // giorno è stato annullato un import», non quale movimento guardare.
        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'riconciliazione_import',
            entitaId: importId,
            azione: 'update',
            // La sede è quella delle righe, e sono tutte dell'operatore (il gate
            // qui sopra lo ha appena imposto): si prende la prima invece di
            // inventarne una.
            scuolaId: righe[0]?.scuola_id ?? undefined,
            valoreDopo: {
                annullo_import: true,
                movimenti: righe.length,
                riaperti,
                falliti: falliti.length,
                incassi_stornati: incassiStornati,
                transazioni_annullate: transazioniAnnullate,
            },
        })

        // Il log di SUCCESSO dell'evento critico (regola 5 di AGENTS.md): con i
        // soli errori, «nessun log» non distinguerebbe «non c'era niente da
        // annullare» da «l'annullo non è mai partito». Conteggi e uuid soltanto:
        // mai causali, mai nomi, mai codici fiscali.
        logEvento('pagamento', 'info', {
            operazione: OPERAZIONE_POST,
            esito: 'annullo_import_eseguito',
            import_id: importId,
            n: righe.length,
            riaperti,
            falliti: falliti.length,
            credito_gia_speso: creditoGiaSpeso,
            incassi_stornati: incassiStornati,
            transazioni_annullate: transazioniAnnullate,
            fatture_vive: fatture.length,
        })

        return NextResponse.json({
            success: true,
            data: {
                riaperti,
                /** Ogni riga rimasta indietro, col suo codice: è l'elenco di ciò che resta da fare. */
                falliti,
                credito_gia_speso: creditoGiaSpeso,
                incassi_stornati: incassiStornati,
                transazioni_annullate: transazioniAnnullate,
                /** Le fatture rimaste vive, aggregate per movimento. Dovrebbe essere vuoto. */
                fatture,
            },
        })
    } catch (err) {
        logErrore({ operazione: OPERAZIONE_POST, stato: 500 }, err)
        // ⚠️ UN CODICE DIVERSO DA QUELLO DELLA LETTURA, e la differenza è tutta
        // nella frase che l'operatrice legge: qui l'eccezione può essere arrivata
        // DOPO che il ciclo era partito, quindi «nessuna riga è stata toccata»
        // sarebbe falso. Una parte dei bonifici può essere già tornata in coda,
        // coi suoi storni registrati — e il rimedio non è ripetere alla cieca, è
        // guardare il registro filtrato per questo import.
        return NextResponse.json(
            {
                error: 'L’annullamento si è interrotto: controlla il registro filtrato per questo import.',
                codice: 'ANNULLO_IMPORT_INTERROTTO',
            },
            { status: 500 },
        )
    }
})
