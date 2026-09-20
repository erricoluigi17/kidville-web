import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { formatEuro } from '@/lib/format/valuta'
// Lo stesso PREDICATO dell'elenco e dell'annullo — tre porte, una domanda sola —
// ma la finestra qui è l'altra: v. `TETTO_FINESTRA` e il riquadro qui sotto. Il
// perché della query condivisa sta per esteso nella testata di quel modulo.
import { leggiRigheAutomatiche, TETTO_FINESTRA, type RigaAuto } from '@/lib/pagamenti/righe-automatiche'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * «IL RIEPILOGO È STATO GUARDATO E NON ANNULLATO»: ORA SI AVVISANO LE FAMIGLIE.
 *
 * ─── PERCHÉ LA NOTIFICA NON È PARTITA ALL'IMPORT ────────────────────────────
 *
 * Decisione esplicita del titolare, già scritta nella testata di
 * `@/lib/pagamenti/riconciliazione-auto-import` prima che questa rotta
 * esistesse: la fase automatica **non avvisa nessuno**. Il motivo sta tutto in
 * una frase di quel file — «un avviso mandato non si disfa: è l'unica cosa, in
 * tutta questa fase, che nessun rollback può riprendersi». Se la macchina
 * sbaglia e la segreteria annulla in blocco, la famiglia avrebbe già ricevuto
 * «Pagamento registrato» per un pagamento che l'applicazione sta per disfare.
 *
 * Quindi l'avviso aspetta il GESTO UMANO che oggi non c'era: qualcuno ha aperto
 * il riepilogo, l'ha letto, e ha chiuso senza annullare. È quel gesto che questa
 * rotta registra, ed è per questo che si chiama così invece di
 * `notifica-abbinamenti`: la notifica è la CONSEGUENZA, non l'azione.
 *
 * ─── 🔴 L'IDEMPOTENZA, E PERCHÉ NON SERVE UNA COLONNA NUOVA ─────────────────
 *
 * Chiamarla due volte non deve avvisare due volte, e il riepilogo si può
 * riaprire quante volte si vuole (è un pulsante della fascia). La consegna
 * chiedeva di cercare PRIMA un modo che esista già, e ce n'è uno esatto:
 * **la tabella `notifiche`**, che porta `tipo`, `entita_id` e `creato_il`.
 *
 * La domanda diventa: «esiste già un avviso `pagamento_registrato` su questa
 * entità, creato DOPO che la macchina ha chiuso questa riga?». La data del
 * confronto è `abbinato_auto_il`, cioè la marca stessa: non un «oggi», non una
 * finestra a occhio. Così:
 *  · due click sul riepilogo ⇒ il secondo non manda niente;
 *  · un pagamento avvisato MESI FA per un'altra rata non blocca questo avviso,
 *    perché quella notifica è più vecchia della marca;
 *  · una riga riaperta e riconfermata a mano non passa nemmeno di qui — la
 *    riapertura spegne la marca e la query non la restituisce più.
 *
 * ⚠️ E NON SI USA IL `debounce` di `notificaEvento` per questo. Quello cancella
 * le notifiche ancora PENDING (push non spedita) e collassa le raffiche: dopo
 * che la push è partita — dieci minuti, il buffer di default — non impedisce
 * proprio niente. È una comodità, non un'idempotenza, e scambiare le due cose
 * qui vorrebbe dire una seconda «Pagamento registrato» a una famiglia vera.
 *
 * ⚠️ FAIL-CLOSED sulla lettura: se `notifiche` non si legge, non si manda
 * niente. Un avviso doppio non si ritira; un avviso non ancora partito si manda
 * riaprendo il riepilogo. Il verso in cui si sbaglia è quello recuperabile.
 *
 * ─── IL PERIMETRO QUI **NON** SI RESTRINGE, ed è l'opposto dell'annullo ─────
 *
 * L'annullo in blocco torna alle sole sedi dell'operatore, perché è uno storno.
 * L'avviso no: è la coda della fase automatica, che ha lavorato su tutte e tre
 * le sedi per decisione del titolare (l'estratto conto è uno solo). Restringerlo
 * al perimetro di chi ha importato lascerebbe le famiglie degli altri due plessi
 * senza avviso per sempre — nessun altro aprirà mai il riepilogo di quell'import.
 * Chi opera non sta decidendo nulla sul denaro di un'altra sede: sta lasciando
 * che arrivi un avviso su un incasso che l'applicazione ha già registrato.
 *
 * ⚠️ È una conseguenza della deroga di sede della fase automatica, non una
 * decisione nuova presa qui. Sta scritta perché il giorno in cui la deroga
 * venisse ristretta, questa riga vada ristretta con lei.
 *
 * ─── 🔴 E NEMMENO LA FINESTRA SI RESTRINGE, PER LO STESSO MOTIVO ────────────
 *
 * Questa rotta legge con `TETTO_FINESTRA`, non col tetto dell'annullo.
 * Riusare quello — come faceva la prima stesura — produceva esattamente
 * l'esito che il riquadro qui sopra dichiara di voler evitare, solo più in
 * là: la fase automatica può chiudere fino a 500 righe, la finestra
 * dell'annullo si ferma a 200, l'ordine di lettura è STABILE
 * (`data_operazione, id`) e notificare non cambia lo stato della riga. Ogni
 * riapertura del riepilogo ripescava quindi le stesse prime 200 — già
 * avvisate, quindi «già notificate» — e dalla 201ª in poi non entrava mai
 * nessuno. In silenzio, e senza rimedio: su quell'import anche l'annullo in
 * blocco rifiuta (`troppe` ⇒ 422), quindi quelle righe restavano confermate,
 * mute, e senza nemmeno la via d'uscita di disfarle.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Lo stesso tetto delle altre due porte dell'import, e qui serve più che là:
 * questa rotta legge l'import INTERO, quindi il ciclo può arrivare a un
 * `notificaEvento` per ognuna delle 500 righe che la fase automatica può
 * chiudere — ognuno con la sua risoluzione di destinatari.
 *
 * ⚠️ E se il tempo finisse lo stesso, il verso in cui si sbaglia è quello
 * recuperabile: gli avvisi già partiti restano, e la rotta è IDEMPOTENTE —
 * riaprire il riepilogo manda solo quelli che mancano. È l'opposto dell'annullo
 * in blocco, che per la stessa ragione si ferma a 200 invece di provarci.
 */
export const maxDuration = 300

const OPERAZIONE = 'pagamenti/riconciliazione/riepilogo-visto:POST'

/** Il tipo canonico dell'avviso: lo stesso del percorso manuale, mai uno nuovo. */
const TIPO_NOTIFICA = 'pagamento_registrato'

/** uuid per `.in()`: la request line di PostgREST muore sopra gli 8 KB (431). */
const BLOCCO_ID = 100

const postBodySchema = z.object({ import_id: zUuid })

/** Il bersaglio di un avviso: una voce singola, o l'intera transazione composita. */
interface Bersaglio {
    riga: RigaAuto
    /** `pagamento` sul ramo singolo, `transazione` sul composito: come il percorso manuale. */
    entitaTipo: 'pagamento' | 'transazione'
    entitaId: string
    alunni: string[]
    /** Solo sul ramo singolo: decide fra «Pagamento registrato» e «Acconto registrato». */
    saldato: boolean
    descrizione: string | null
}

export const POST = withRoute('pagamenti/riconciliazione/riepilogo-visto:POST', async (request: NextRequest) => {
    try {
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        const b = await parseBody(request, postBodySchema)
        if ('response' in b) return b.response
        const importId = b.data.import_id

        const supabase = await createAdminClient()
        // L'IMPORT INTERO, non il bersaglio dell'annullo: v. il riquadro sulla
        // finestra in testata. Ci si ferma sulla pagina vuota.
        const lettura = await leggiRigheAutomatiche(supabase, importId, OPERAZIONE, { tetto: TETTO_FINESTRA })
        if ('errore' in lettura) return NextResponse.json(lettura.errore.body, { status: lettura.errore.status })
        if ('marcaAssente' in lettura) {
            // Su questo ambiente non esiste l'abbinamento automatico, quindi non
            // esiste niente da notificare. Non è un errore: è un 200 con zero.
            return NextResponse.json({ success: true, disponibile: false, data: { notificati: 0, gia_notificati: 0 } })
        }
        // ⚠️ `troppe` NON ferma questa rotta, a differenza dell'annullo. Là il tetto
        // protegge da un ciclo di STORNI che può morire a metà lasciando denaro a
        // pezzi; qui il ciclo manda avvisi, e fermarsi lascerebbe senza avviso
        // proprio le famiglie di un import grande.
        //
        // 🔴 CON QUESTA FINESTRA IL TRONCAMENTO NON È PIÙ UNA NOTA A PIÈ DI PAGINA.
        // Si arriva qui solo con duemila righe automatiche in un import — quattro
        // volte il tetto della fase automatica — e vuol dire che le righe oltre la
        // finestra NON verranno avvisate riaprendo il riepilogo: l'ordine è stabile
        // e la lettura ripescherebbe sempre le stesse. È un guasto che nessuno
        // vedrebbe mai (non c'è nessun errore, e le famiglie mancanti non si
        // lamentano di un avviso che non sanno di aspettare), quindi si dichiara
        // due volte: `error` nel log, e `troncato` nella risposta — che il pannello
        // LEGGE e mostra, invece di guardare solo `r.ok`.
        const righe = lettura.righe
        if (lettura.troppe) {
            logEvento('pagamento', 'error', {
                operazione: OPERAZIONE,
                esito: 'riepilogo-visto-finestra-troncata',
                import_id: importId,
                n: righe.length,
            })
        }

        if (righe.length === 0) {
            // La riga di successo si scrive anche a zero: senza, «nessun log» non
            // distinguerebbe «non c'era niente da notificare» da «la rotta non è
            // mai partita» (regola 5 di AGENTS.md).
            logEvento('pagamento', 'info', {
                operazione: OPERAZIONE,
                esito: 'riepilogo_visto_notifiche',
                import_id: importId,
                n: 0,
                notificati: 0,
                gia_notificati: 0,
                falliti: 0,
            })
            return NextResponse.json({
                success: true,
                data: { letti: 0, notificati: 0, gia_notificati: 0, falliti: 0, senza_alunno: 0, troncato: false },
            })
        }

        // ── LE VOCI DI OGNI RIGA ──────────────────────────────────────────────
        //
        // Sul ramo SINGOLO la voce è una sola: `pagamento_id` sul movimento.
        // Sul ramo COMPOSITO quello è l'ÀNCORA — una voce sola di un bonifico che
        // ne ha saldate più d'una, magari di fratelli diversi — e avvisare solo la
        // famiglia dell'àncora lascerebbe fuori gli altri figli. Le voci vere si
        // leggono dagli INCASSI che la RPC ha scritto con quel `transazione_id`:
        // è la stessa strada del percorso manuale, che notifica «gli alunni
        // coinvolti» e non quello dell'àncora.
        const txIds = [...new Set(righe.map((r) => r.transazione_id).filter((v): v is string => !!v))]
        /** `transazione_id` → i pagamenti che ha saldato. */
        const pagDiTx = new Map<string, string[]>()
        if (txIds.length > 0) {
            for (let i = 0; i < txIds.length; i += BLOCCO_ID) {
                const blocco = txIds.slice(i, i + BLOCCO_ID)
                const { data: inc, error: errInc } = await supabase
                    .from('incassi')
                    .select('pagamento_id, transazione_id')
                    .in('transazione_id', blocco)
                if (errInc) {
                    // PostgREST non lancia. Qui si esce invece di proseguire: senza
                    // gli incassi, le composite avviserebbero il solo alunno
                    // dell'àncora — cioè un avviso che sembra completo e non lo è, e
                    // che l'idempotenza qui sotto renderebbe DEFINITIVO (al secondo
                    // giro risulterebbe «già notificato»). Meglio nessun avviso, che
                    // si rimanda riaprendo il riepilogo.
                    logErrore({ operazione: OPERAZIONE, evento: 'incassi_transazione_non_letti', stato: 503 }, errInc)
                    return NextResponse.json(
                        {
                            error:
                                'Non è stato possibile leggere le voci dei bonifici composti: ' +
                                'nessun avviso è stato inviato. Riapri il riepilogo per riprovare.',
                            codice: 'RIEPILOGO_NOTIFICHE_NON_INVIATE',
                        },
                        { status: 503 },
                    )
                }
                for (const riga of (inc ?? []) as { pagamento_id: string | null; transazione_id: string | null }[]) {
                    if (!riga.pagamento_id || !riga.transazione_id) continue
                    const gia = pagDiTx.get(riga.transazione_id) ?? []
                    if (!gia.includes(riga.pagamento_id)) gia.push(riga.pagamento_id)
                    pagDiTx.set(riga.transazione_id, gia)
                }
            }
        }

        // ── I PAGAMENTI: alunno, stato e descrizione ──────────────────────────
        const pagIds = [...new Set([
            ...righe.map((r) => r.pagamento_id).filter((v): v is string => !!v),
            ...[...pagDiTx.values()].flat(),
        ])]
        const pagDi = new Map<string, { alunno_id: string | null; stato: string | null; descrizione: string | null }>()
        for (let i = 0; i < pagIds.length; i += BLOCCO_ID) {
            const blocco = pagIds.slice(i, i + BLOCCO_ID)
            const { data: pag, error: errPag } = await supabase
                .from('pagamenti')
                .select('id, alunno_id, stato, descrizione')
                .in('id', blocco)
            if (errPag || !pag) {
                logErrore({ operazione: OPERAZIONE, evento: 'pagamenti_del_riepilogo_non_letti', stato: 503 }, errPag)
                return NextResponse.json(
                    {
                        error:
                            'Non è stato possibile leggere le voci pagate: nessun avviso è stato inviato. ' +
                            'Riapri il riepilogo per riprovare.',
                        codice: 'RIEPILOGO_NOTIFICHE_NON_INVIATE',
                    },
                    { status: 503 },
                )
            }
            for (const p of pag as { id: string; alunno_id: string | null; stato: string | null; descrizione: string | null }[]) {
                pagDi.set(p.id, { alunno_id: p.alunno_id, stato: p.stato, descrizione: p.descrizione })
            }
        }

        // ── I BERSAGLI, uno per riga ──────────────────────────────────────────
        const bersagli: Bersaglio[] = []
        /** Righe senza nessun alunno da avvisare: si contano, non si tacciono. */
        let senzaAlunno = 0
        for (const r of righe) {
            if (r.transazione_id) {
                const alunni = [...new Set(
                    (pagDiTx.get(r.transazione_id) ?? [])
                        .map((pid) => pagDi.get(pid)?.alunno_id ?? null)
                        .filter((v): v is string => !!v),
                )]
                if (alunni.length === 0) { senzaAlunno++; continue }
                bersagli.push({
                    riga: r,
                    entitaTipo: 'transazione',
                    entitaId: r.transazione_id,
                    alunni,
                    saldato: true,
                    descrizione: null,
                })
                continue
            }
            const pag = r.pagamento_id ? pagDi.get(r.pagamento_id) : undefined
            if (!r.pagamento_id || !pag?.alunno_id) { senzaAlunno++; continue }
            bersagli.push({
                riga: r,
                entitaTipo: 'pagamento',
                entitaId: r.pagamento_id,
                alunni: [pag.alunno_id],
                saldato: pag.stato === 'pagato',
                descrizione: pag.descrizione,
            })
        }

        // ── L'IDEMPOTENZA: chi è già stato avvisato DOPO la marca ─────────────
        //
        // Una lettura sola per tutti i bersagli. Si chiede anche `creato_il`
        // perché il confronto è con `abbinato_auto_il` della SINGOLA riga: un
        // avviso più vecchio della marca riguarda un'altra rata, non questa.
        const entitaIds = [...new Set(bersagli.map((x) => x.entitaId))]
        /** `entita_id` → la data dell'avviso più RECENTE trovato. */
        const avvisataIl = new Map<string, string>()
        for (let i = 0; i < entitaIds.length; i += BLOCCO_ID) {
            const blocco = entitaIds.slice(i, i + BLOCCO_ID)
            const { data: notif, error: errNotif } = await supabase
                .from('notifiche')
                .select('entita_id, creato_il')
                .eq('tipo', TIPO_NOTIFICA)
                .in('entita_id', blocco)
            if (errNotif || !notif) {
                // FAIL-CLOSED, e questa è la riga che lo impone: senza sapere chi è
                // già stato avvisato, mandare vorrebbe dire rischiare un secondo
                // «Pagamento registrato» a una famiglia vera — e un avviso mandato
                // non si disfa. Non si manda niente e lo si dice.
                logErrore({ operazione: OPERAZIONE, evento: 'notifiche_gia_inviate_non_lette', stato: 503 }, errNotif)
                return NextResponse.json(
                    {
                        error:
                            'Non è stato possibile verificare quali avvisi fossero già partiti: ' +
                            'nessun avviso è stato inviato. Riapri il riepilogo per riprovare.',
                        codice: 'RIEPILOGO_NOTIFICHE_NON_INVIATE',
                    },
                    { status: 503 },
                )
            }
            for (const n of (notif ?? []) as { entita_id: string | null; creato_il: string | null }[]) {
                if (!n.entita_id || !n.creato_il) continue
                const prec = avvisataIl.get(n.entita_id)
                if (!prec || n.creato_il > prec) avvisataIl.set(n.entita_id, n.creato_il)
            }
        }

        // ── IL CICLO: un avviso per riga, best-effort ─────────────────────────
        let notificati = 0
        let giaNotificati = 0
        let falliti = 0
        for (const x of bersagli) {
            const marca = x.riga.abbinato_auto_il
            const ultima = avvisataIl.get(x.entitaId)
            // ⚠️ `>=` e non `>`: `creato_il` ha default `now()` e la marca è scritta
            // nello stesso istante logico dell'abbinamento. Un avviso nato nello
            // stesso millisecondo della marca è questo stesso avviso, non un altro.
            if (marca !== null && ultima !== undefined && ultima >= marca) {
                giaNotificati++
                continue
            }
            try {
                await notificaEvento(supabase, {
                    tipo: TIPO_NOTIFICA,
                    // Il toggle si valuta sulla sede in cui il denaro è stato
                    // registrato: è quella che il movimento porta addosso.
                    scuolaId: x.riga.scuola_id,
                    alunnoIds: x.alunni,
                    // Le stesse due frasi del percorso manuale, mai una terza: la
                    // famiglia non deve poter distinguere un incasso registrato a
                    // mano da uno riconosciuto dall'applicazione — è lo stesso
                    // fatto, e una frase diversa sarebbe una spiegazione che nessuno
                    // ha chiesto.
                    titolo: x.saldato ? 'Pagamento registrato' : 'Acconto registrato',
                    corpo:
                        x.entitaTipo === 'transazione'
                            ? 'È stato registrato un pagamento. La ricevuta è disponibile nella sezione Pagamenti.'
                            : `${x.descrizione ?? 'Pagamento'}: registrato un bonifico di ${formatEuro(x.riga.importo)}.`,
                    link: '/parent/pagamenti',
                    entitaTipo: x.entitaTipo,
                    entitaId: x.entitaId,
                    // Il debounce resta: collassa una raffica di avvisi sulla stessa
                    // entità ancora in buffer. Non è l'idempotenza — quella è la
                    // lettura qui sopra — ed è scritto perché nessuno lo scambi per
                    // tale (v. il riquadro in testata).
                    debounce: true,
                })
                notificati++
            } catch (e) {
                // `notificaEvento` non lancia per contratto, ma un `catch` che non
                // logga è un bug e il contratto può cambiare. `error`: questa
                // famiglia non riceverà l'avviso, e nessun altro se ne accorgerà.
                falliti++
                logEvento('notifica', 'error', {
                    operazione: OPERAZIONE,
                    esito: 'avviso-abbinamento-automatico-non-inviato',
                    tipo: TIPO_NOTIFICA,
                    import_id: importId,
                    movimento_id: x.riga.id,
                }, e)
            }
        }

        if (senzaAlunno > 0) {
            // Righe chiuse su una voce senza alunno (o di cui non si è potuta
            // leggere la voce): nessuno da avvisare. Non è un errore, ma se
            // diventasse un numero grosso vorrebbe dire che l'insieme dei bersagli
            // si sta svuotando per un difetto di lettura, e allora nessuno lo
            // saprebbe.
            logEvento('pagamento', 'warn', {
                operazione: OPERAZIONE,
                esito: 'riepilogo-righe-senza-alunno',
                import_id: importId,
                n: senzaAlunno,
                totali: righe.length,
            })
        }

        // Il log di SUCCESSO dell'evento critico (regola 5): gli avvisi alle
        // famiglie sono il caso da manuale — senza la riga del successo, «nessun
        // log» non distingue «tutti già avvisati» da «non è mai partito niente»,
        // che è esattamente l'ambiguità che ha nascosto il guasto delle email.
        logEvento('pagamento', 'info', {
            operazione: OPERAZIONE,
            esito: 'riepilogo_visto_notifiche',
            import_id: importId,
            n: righe.length,
            notificati,
            gia_notificati: giaNotificati,
            falliti,
            senza_alunno: senzaAlunno,
            troncato: lettura.troppe,
        })

        return NextResponse.json({
            success: true,
            data: {
                /**
                 * Quante righe la finestra ha portato. Esce perché è il numero che
                 * il pannello mostra quando `troncato` è vero: «gli avvisi sono
                 * partiti per i primi N» è un'informazione, «l'elenco è troncato»
                 * da solo non lo è.
                 */
                letti: righe.length,
                notificati,
                gia_notificati: giaNotificati,
                falliti,
                senza_alunno: senzaAlunno,
                /**
                 * La finestra si è chiusa prima dell'import: le righe oltre non
                 * sono state avvisate, e RIAPRIRE IL RIEPILOGO NON LE RECUPERA —
                 * la lettura ripesca sempre le stesse. Il pannello lo dice.
                 */
                troncato: lettura.troppe,
            },
        })
    } catch (err) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
        // ⚠️ NON `RIEPILOGO_NOTIFICHE_NON_INVIATE`, che è il fail-closed e dice
        // «nessuna famiglia ha ricevuto niente». Qui l'eccezione può essere
        // arrivata a ciclo avviato, quindi una parte degli avvisi può essere già
        // partita: dire il contrario sarebbe una bugia su un messaggio che non si
        // ritira. Riaprire il riepilogo resta giusto — la rotta è idempotente —
        // ma va detto che qualcosa è uscito.
        return NextResponse.json(
            {
                error: 'L’invio degli avvisi si è interrotto: una parte può essere già partita.',
                codice: 'RIEPILOGO_NOTIFICHE_INTERROTTE',
            },
            { status: 500 },
        )
    }
})
