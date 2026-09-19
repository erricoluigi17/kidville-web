import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireUser } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami';
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { staffScuola } from '@/lib/notifiche/destinatari';
import { alunniDelleRisposte, nomiGenitoriDelleRisposte } from '@/lib/avvisi/nomi-risposte';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { zNumeroPartecipanti } from '@/lib/validation/avvisi';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

interface RouteParams {
    params: Promise<{ id: string }>;
}

// `parent_id` NON è più nel body (G4): l'autore della risposta è la SESSIONE.
// `risposta` è vincolata a si/no (adesione); assente = sola presa visione.
const postBodySchema = z.object({
    student_id: zUuid,
    risposta: z.enum(['si', 'no']).optional(),
    numero_partecipanti: zNumeroPartecipanti.optional(),
});

/**
 * L'esito di `avviso_adesione_registra`. È la forma dichiarata dal
 * `COMMENT ON FUNCTION` della migrazione A2, non una deduzione: `{ok, code?,
 * stato, numero, prima_lettura, prima_risposta, posti_liberati, in_attesa,
 * riga}`.
 *
 * `posti_liberati` e `in_attesa` sono i due fatti che decidono la notifica
 * `posti_liberati` alla segreteria, e arrivano dalla funzione invece che da una
 * query di questa route per una ragione sola: la funzione li calcola DOPO la
 * scrittura e DENTRO il lock su `avvisi`. Un conteggio fatto qui girerebbe dopo
 * il commit, e fra la scrittura e la lettura ci sta un'altra adesione.
 *
 * ⚠️ Entrambi sono OPZIONALI nel tipo, e non è pigrizia: finché la migrazione
 * non è applicata (il DB E2E della CI non lo è) la funzione può essere quella
 * vecchia, che non li restituisce. `undefined` vale zero e la notifica non
 * parte — mai `NaN`, mai una notifica mandata su un numero che non c'è.
 */
interface EsitoRegistra {
    ok?: boolean;
    code?: string;
    stato?: string | null;
    numero?: number | null;
    prima_lettura?: boolean;
    prima_risposta?: boolean;
    posti_liberati?: number | null;
    in_attesa?: number | null;
    riga?: Record<string, unknown> | null;
}

/**
 * LA FUNZIONE DI DATABASE NON C'È — e i due modi in cui succede.
 *
 * `PGRST202`: PostgREST non trova la funzione nella schema cache (è il codice che
 * torna il DB E2E della CI, che non è migrato). `42883`: Postgres stesso dice
 * «undefined function». Sono la stessa condizione vista da due livelli.
 *
 * ⚠️ NON si comprende qui `PGRST203` (ambiguous function): quello significa che
 * ne esistono DUE con firme diverse — un guasto di schema vero, che deve uscire
 * come guasto e non come «non disponibile».
 */
const RPC_ASSENTE = new Set(['PGRST202', '42883']);

/**
 * LA COLONNA NON C'È — gli stessi due codici che `@/lib/avvisi/statistiche` e
 * `GET /api/avvisi` già riconoscono: `42703` quando è Postgres a dire «column
 * does not exist» sulla `select`, `PGRST204` quando è la schema cache di
 * PostgREST a non conoscerla. È il linguaggio del DB E2E della CI, che è un
 * progetto separato e **non è migrato**.
 *
 * ⚠️ Insieme SEPARATO da `RPC_ASSENTE`: una funzione mancante e una colonna
 * mancante sono due guasti diversi, con due ripieghi diversi (là si RIFIUTA
 * l'adesione, qui si legge di meno). Un solo insieme per entrambi farebbe
 * scattare il ripiego sbagliato al primo codice fuori posto.
 */
const PROIEZIONE_MANCANTE = new Set(['42703', 'PGRST204']);

/** Il codice di un errore PostgREST, quando c'è. */
function codiceDb(err: unknown): string | undefined {
    return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
}

/**
 * UNA RIGA DEL RIEPILOGO ADESIONI, COM'ESCE DA QUESTA ROTTA.
 *
 * 🔴 `numero_partecipanti` e `stato_adesione` SONO FACOLTATIVI, e non è pigrizia
 * di tipizzazione: sono i due campi che il ripiego qui sotto NON può fornire
 * quando il database non è migrato, e `undefined` deve continuare a valere «non
 * misurato». Dichiararli `number`/`string` con un `?? 0` o un `?? 'ammessa'`
 * scriverebbe un valore che nessuno ha calcolato — è la forma del `?? 0` che ha
 * congelato per sempre lo stato SDI di una fattura: lo zero scritto una volta non
 * si distingue più dallo zero misurato.
 *
 * Il client (`AvvisoDetailsContent`) li dichiara già facoltativi dall'altro lato
 * del filo: questi due tipi sono la stessa promessa scritta due volte.
 */
interface RigaRispostaAvviso {
    id: string;
    parent_id: string;
    student_id: string;
    letto_il: string | null;
    risposta: string | null;
    risposto_il: string | null;
    /** Quante PERSONE ha dichiarato questa famiglia. Assente ⇒ non misurato. */
    numero_partecipanti?: number | null;
    /** `'ammessa'` · `'in_attesa'` · `null`. Assente ⇒ non misurato. */
    stato_adesione?: string | null;
}

/** La riga come la riceve la segreteria: i campi archiviati più i due nomi. */
type RigaRispostaConNomi = RigaRispostaAvviso & { parent_name: string; student_name: string };

/**
 * LE DUE PROIEZIONI DEL RIEPILOGO.
 *
 * Quella piena porta le due colonne della migrazione
 * `20260919132612_avvisi_scadenze_posti_e_partecipanti` — le stesse che la rotta
 * di esportazione legge già. Quella storica è il ripiego: le sei colonne che
 * esistono da sempre.
 */
const PROIEZIONE_RISPOSTE = 'id, parent_id, student_id, letto_il, risposta, risposto_il, numero_partecipanti, stato_adesione';
const PROIEZIONE_RISPOSTE_STORICA = 'id, parent_id, student_id, letto_il, risposta, risposto_il';

/**
 * I RIFIUTI DELLA RPC → HTTP + catalogo applicativo.
 *
 * La tabella di corrispondenza sta nella migrazione, accanto al
 * `COMMENT ON FUNCTION` di `avviso_adesione_registra`, ed è scritta apposta
 * perché chi scrive questa route non debba INDOVINARE — su una voce
 * indovinerebbe male, con la famiglia sbagliata che legge la frase sbagliata.
 *
 * 🔴 I DUE `POSTI_ESAURITI` NON SONO LA STESSA COSA, e i nomi uguali sono una
 * trappola. Il catalogo lo descrive come «il tetto non lascia spazio per questa
 * adesione». Ma a chi non ha posto questa RPC non lo restituisce MAI: quel
 * genitore va in coda con `ok:true, stato:'in_attesa'`, che è un 200. L'unico
 * caso in cui arriva qui è **chi è GIÀ ammesso e non riesce ad aumentare il
 * numero** — e per quel caso il testo di catalogo («non ci sono abbastanza posti
 * liberi: l'adesione resta com'era») è esatto, perché l'adesione resta davvero
 * com'era. Usare la stessa stringa anche per l'altro caso direbbe a una famiglia
 * che è FUORI proprio mentre il sistema la sta tenendo DENTRO.
 *
 * 🔴 E al genitore non si restituiscono MAI i posti liberi (decisione vincolante
 * del committente): il corpo porta lo stato e il numero che la famiglia HA GIÀ,
 * non `occupati`/`posti_totali`/`richiesti`, che la RPC pure restituisce. Quelli
 * sono per la segreteria, su `[rispostaId]:PATCH`, dove il lettore è un altro.
 */
function rifiutoAdesione(esito: EsitoRegistra, avvisoId: string): NextResponse {
    switch (esito.code) {
        case 'TERMINE_SCADUTO':
            return NextResponse.json(
                { error: 'Le adesioni per questo avviso sono chiuse.', codice: 'ADESIONE_SCADUTA' },
                { status: 409 },
            );
        case 'NUMERO_RICHIESTO':
            return NextResponse.json(
                { error: 'Indica quante persone parteciperanno.', codice: 'NUMERO_PARTECIPANTI_RICHIESTO' },
                { status: 400 },
            );
        case 'NUMERO_FUORI_INTERVALLO':
            return NextResponse.json(
                { error: 'Il numero indicato non rientra fra quelli ammessi.', codice: 'NUMERO_PARTECIPANTI_FUORI_INTERVALLO' },
                { status: 400 },
            );
        case 'POSTI_ESAURITI':
            return NextResponse.json(
                {
                    error: 'Non ci sono abbastanza posti liberi: l’adesione resta com’era.',
                    codice: 'POSTI_ESAURITI',
                    stato: esito.stato ?? null,
                    numero: esito.numero ?? null,
                },
                { status: 409 },
            );
        case 'AVVISO_INESISTENTE':
            return NextResponse.json(
                { error: 'Avviso non trovato.', codice: 'AVVISO_NON_TROVATO' },
                { status: 404 },
            );
        case 'RISPOSTA_NON_VALIDA':
            return NextResponse.json(
                { error: 'Valore non ammesso per questa adesione.', codice: 'ADESIONE_VALORE_NON_VALIDO' },
                { status: 400 },
            );
        case 'ISOLAMENTO_NON_SUPPORTATO':
            // Non è un rifiuto di merito: il conteggio dei posti non è protetto
            // fuori da `READ COMMITTED`, e la funzione si ferma invece di contare
            // su uno snapshot vecchio. `error` perché è una configurazione del
            // database che nessuno ha voluto, non una risposta all'utente.
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'isolamento-non-supportato',
                avviso: avvisoId,
            });
            return NextResponse.json(
                { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                { status: 503 },
            );
        default:
            // Un codice che questa route non conosce è un contratto cambiato sotto
            // i piedi: si registra il nome trovato e si degrada, invece di
            // rispondere 200 a un rifiuto.
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'esito-rpc-sconosciuto',
                avviso: avvisoId,
                error_code: esito.code ?? null,
            });
            return NextResponse.json(
                { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                { status: 503 },
            );
    }
}

// GET /api/avvisi/[id]/risposte
// Lista risposte per un avviso specifico (dashboard monitoraggio = staff). Gatato.
export const GET = withRoute('avvisi/[id]/risposte:GET', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const pId = parseData(zUuid, rawParams.id);
        if ('response' in pId) return pId.response;
        const avvisoId = pId.data;

        const supabase = await createAdminClient();

        // Isolamento per sede: l'avviso appartiene a un plesso (`avvisi.scuola_id`)
        // e le risposte portano nome dei genitori e dei bambini. Senza questo si
        // leggevano le adesioni di un avviso di un'altra sede.
        const { data: avviso } = await supabase
            .from('avvisi').select('id, scuola_id').eq('id', avvisoId).maybeSingle();
        if (!avviso) return NextResponse.json({ error: 'Avviso non trovato' }, { status: 404 });
        const plessiAvviso = await scuoleDiUtente(supabase, auth.user);
        if (!avviso.scuola_id || !plessiAvviso.includes(avviso.scuola_id as string)) {
            return NextResponse.json({ error: 'Avviso fuori dal tuo plesso' }, { status: 403 });
        }

        const leggiRisposte = async (colonne: string) => {
            const res = await supabase
                .from('avvisi_risposte')
                .select(colonne)
                .eq('avviso_id', avvisoId);
            return {
                righe: (res.data ?? []) as unknown as RigaRispostaAvviso[],
                error: res.error as { code?: string; message: string } | null,
            };
        };

        // ─────────────────────────────────────────────────────────────────────
        // 🔴 IL DEGRADO, E PERCHÉ NON PUÒ RESTARE MUTO.
        //
        // Senza il ripiego, un `42703` su questa `select` allargata non tornerebbe
        // come un guasto leggibile: tornerebbe come **zero righe**, cioè un
        // riepilogo «0 persone · 0 in lista d'attesa» e un elenco vuoto, su una
        // schermata che non ha modo di dire «non lo so». È lo stesso silenzio che
        // `statistiche-proiezione-ridotta` e `degrado-proiezione-capienza-spenta`
        // esistono per rompere, ed è per questo che la forma è la loro: un solo
        // ritentativo, SOLO sui due codici di colonna mancante, e un `warn` che
        // dichiara il degrado. Su ogni altro codice il comportamento resta quello
        // di prima — un guasto di lettura non diventa un ripiego silenzioso.
        //
        // Ciò che si perde con il ripiego è dichiarato: i due campi restano
        // ASSENTI (non zero), quindi niente chip «N persone», niente «In lista
        // d'attesa», nessun bottone «Ammetti». Ciò che si salva sono le sei
        // colonne storiche, cioè chi ha letto e chi ha risposto sì/no — il verso
        // giusto in cui perdere qualcosa.
        // ─────────────────────────────────────────────────────────────────────
        let { righe: data, error } = await leggiRisposte(PROIEZIONE_RISPOSTE);
        if (error && PROIEZIONE_MANCANTE.has(codiceDb(error) ?? '')) {
            const codice = codiceDb(error) ?? null;
            ({ righe: data, error } = await leggiRisposte(PROIEZIONE_RISPOSTE_STORICA));
            logEvento('db', 'warn', {
                operazione: 'avvisi/[id]/risposte:GET',
                esito: 'degrado-proiezione-adesioni-spenta',
                avviso: avvisoId,
                // Quante righe sono uscite senza i due campi: «è degradato» e «è
                // degradato su 40 famiglie» non sono la stessa riga di log.
                n: data.length,
                error_code: codice,
            });
        }

        if (error) {
            // ─────────────────────────────────────────────────────────────────
            // 🔴 IL `message` DI POSTGREST RESTA NEL LOG E NON ESCE DI QUI.
            //
            // Fino al 2026-09-19 questa riga era `{ error: error.message }`, cioè
            // il messaggio GREZZO del database rimandato al client. Due difetti in
            // uno, e il secondo è il grave:
            //
            //  · senza `codice` non è localizzabile — `messaggioDaCorpo` non ha
            //    niente da cercare in catalogo e ricade sulla prosa del server,
            //    quindi una segretaria con l'interfaccia in inglese leggeva una
            //    frase inglese-tecnica scritta per chi legge i log;
            //  · quel messaggio PUÒ NOMINARE UNA COLONNA. È già successo in questo
            //    repo: `500 {"error":"value too long for type character
            //    varying(255)"}` raccontava al client il tipo esatto della colonna,
            //    ed è il rilievo da cui è nato `src/lib/validation/avvisi.ts`.
            //
            // ⚠️ E il lock `errori-con-codice` NON poteva vederlo: vieta i nomi di
            // colonna nei LETTERALI e nel catalogo, non in una stringa costruita a
            // runtime. È una fuga di schema che nessun gate vede — la si chiude
            // togliendo la sorgente, non aggiungendo una regola.
            //
            // `LETTURA_FALLITA` e non un codice nuovo: è esattamente ciò che è
            // successo (una lettura non è riuscita), la sua frase di catalogo dice
            // il vero in entrambe le lingue, e il rimedio — riprovare — è quello
            // giusto. Un codice proprio direbbe la stessa cosa con altre parole.
            //
            // ⚠️ LO STATUS RESTA 500: è un guasto nostro, e degradarlo a 503
            // racconterebbe una indisponibilità temporanea che nessuno ha misurato.
            // ─────────────────────────────────────────────────────────────────
            logErrore({ operazione: 'avvisi/[id]/risposte:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json(
                {
                    error: 'Non è stato possibile leggere le risposte a questo avviso. Riprova fra poco.',
                    codice: 'LETTURA_FALLITA',
                },
                { status: 500 },
            );
        }

        // ─────────────────────────────────────────────────────────────────────
        // I NOMI, IN BLOCCO E IN UN POSTO SOLO.
        //
        // Fino al 2026-09-19 qui giravano `utenti` e `alunni` DENTRO il `.map()`,
        // cioè due letture per ogni risposta. Su un avviso di plesso con
        // trecento adesioni sono seicento richieste per una sola apertura di
        // schermata — la forma esatta di N+1 che `avvisi-niente-n-piu-uno` ha già
        // chiuso su `GET /api/avvisi`, lasciata aperta qui. Il `Promise.all`
        // esterno le parallelizzava, che è il motivo per cui il cronometro non se
        // ne accorgeva con dieci righe e il pool di connessioni se ne accorgerà
        // con trecento.
        //
        // 🔴 E POI LE DUE COPIE SONO DIVENTATE UNA. La stessa risoluzione stava
        // scritta qui e nella rotta di esportazione accanto, e le due copie NON
        // dicevano la stessa cosa: là gli alunni si filtravano per la sede
        // dell'avviso, qui no. Una riga che punta a un minore di un altro plesso
        // spariva dal file e compariva su questa schermata, col nome e contata
        // nel riepilogo — la stessa gita, due elenchi diversi, e nessuno dei due
        // che dicesse perché. Ora la regola vive in `@/lib/avvisi/nomi-risposte`,
        // che entrambe importano: stesso filtro, stessa forma del nome, stessi
        // `aBlocchi`/`ID_PER_QUERY` (`.in()` non viaggia nel corpo ma nell'URL, e
        // mille uuid fanno ~38 kB di riga di richiesta, cioè un 414).
        //
        // Il fallback `'?'` resta di questa rotta: il CSV accanto lascia la cella
        // VUOTA, ed è giusto che lo faccia — un `'?'` stampato in un elenco da
        // portare in gita è rumore, qui è l'unico modo di dire «riga presente,
        // nome no».
        // ─────────────────────────────────────────────────────────────────────
        const genitori = await nomiGenitoriDelleRisposte(supabase, data.map((r) => r.parent_id));
        for (const b of genitori.nonLetti) {
            // 🔴 PostgREST non lancia: prima questo errore veniva DESTRUTTURATO
            // VIA insieme al resto (`const { data: parent } = …`) e la riga
            // usciva con un `'?'` indistinguibile da «quel genitore non c'è».
            // Il `'?'` resta — un elenco senza nomi è meglio di un 500 su una
            // schermata che regge — ma adesso lascia una traccia.
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte:GET',
                esito: 'nomi-genitori-non-letti',
                avviso: avvisoId,
                n: b.n,
                error_code: b.error.code ?? null,
            }, b.error);
        }

        const alunni = await alunniDelleRisposte(supabase, data.map((r) => r.student_id), avviso.scuola_id as string);
        for (const b of alunni.nonLetti) {
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte:GET',
                esito: 'nomi-alunni-non-letti',
                avviso: avvisoId,
                n: b.n,
                error_code: b.error.code ?? null,
            }, b.error);
        }

        // ⚠️ IL NOME CHE MANCA NON DEVE ESSERE MUTO. Un id presente nella riga e
        // non risolto produce un `'?'` a schermo e una cella vuota nel CSV: senza
        // questa riga, «quel bambino non è più in anagrafica» e «quel bambino è
        // di un altro plesso» sono lo stesso buco, e nessuno dei due si vede. Il
        // log sopra copre soltanto l'errore di QUERY, che è un'altra cosa: lì la
        // domanda è fallita, qui ha risposto «niente».
        if (alunni.nonRisolti > 0) {
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi/[id]/risposte:GET',
                esito: 'alunni-non-risolti',
                avviso: avvisoId,
                n: alunni.nonRisolti,
            });
        }

        const enriched: RigaRispostaConNomi[] = data.map((r) => ({
            ...r,
            parent_name: genitori.valori.get(r.parent_id) ?? '?',
            student_name: alunni.valori.get(r.student_id)?.nome ?? '?',
        }));

        return NextResponse.json(enriched);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]/risposte:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// POST /api/avvisi/[id]/risposte
// Body: { student_id, risposta?, numero_partecipanti? } — parent_id è la SESSIONE
// (G4), risposta ∈ {si,no}, assente = sola presa visione.
// Registra presa visione o adesione del genitore per un proprio figlio: termine,
// numero, tetto dei posti e lista d'attesa li decide `avviso_adesione_registra`.
export const POST = withRoute('avvisi/[id]/risposte:POST', async (request: Request, { params }: RouteParams) => {
    try {
        const rawParams = await params;
        const pId = parseData(zUuid, rawParams.id);
        if ('response' in pId) return pId.response;
        const avvisoId = pId.data;

        // G4: identità DALLA SESSIONE. Il `parent_id` non arriva più dal client
        // (era forgiabile in anonimo → adesioni/prese-visione false su minori).
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const parent_id = auth.user.id;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { student_id, risposta, numero_partecipanti: numero } = b.data;

        const supabase = await createAdminClient();

        // IDOR: si risponde SOLO per i propri figli. `genitoreHasFiglio` unisce
        // le due sorgenti (runtime `legame_genitori_alunni` + anagrafica
        // `student_parents` via ponte `parents.auth_user_id`), quindi vale anche
        // per i genitori arrivati dall'import iscrizioni; lo staff non compare in
        // nessuna delle due → 403: non forgia prese-visione delle famiglie.
        const suoFiglio = await genitoreHasFiglio(supabase, parent_id, student_id);
        if (!suoFiglio) {
            return NextResponse.json({ error: 'Accesso negato' }, { status: 403 });
        }

        // ═════════════════════════════════════════════════════════════════════
        // 🔴 L'ALUNNO DEVE APPARTENERE ALL'AVVISO, NON SOLO ALLA FAMIGLIA.
        //
        // Fino al 2026-09-19 questa rotta verificava `genitoreHasFiglio` E NULLA
        // ALTRO — né qui né dentro `avviso_adesione_registra`, che non tocca mai
        // `alunni` e non guarda mai `target_classes`. Quindi un genitore con due
        // figli in due plessi (caso reale: il commento della rotta di
        // esportazione accanto lo dichiara per non filtrare i genitori per sede)
        // poteva rispondere a un avviso di UNA sede mandando lo `student_id` del
        // figlio dell'ALTRA. La riga veniva scritta, occupava un posto vero, e da
        // lì in poi le due letture non erano più d'accordo: l'export la faceva
        // sparire (filtra per sede), la schermata della segreteria la mostrava
        // col nome e la contava nel riepilogo.
        //
        // ⚠️ IL GATE STA QUI, NON DENTRO LA RPC, ed è una scelta e non una
        // comodità: quella funzione serializza i posti sotto
        // `SELECT … FROM avvisi WHERE id = … FOR UPDATE` e non deve leggere
        // `alunni` sotto il lock — ogni query in più dentro la sezione critica è
        // tempo in cui ogni altra famiglia aspetta. Qui invece il costo è fuori
        // dal lock, e la domanda («questo bambino è destinatario di questo
        // avviso?») non ha bisogno di serializzazione: la sede e la classe di un
        // alunno non cambiano fra questa riga e la RPC in un modo che conti.
        //
        // ⚠️ SOLO COLONNE STORICHE (`scuola_id`, `classe_sezione`, `target_scope`,
        // `target_classes`): esistono anche sul DB E2E della CI, che è un progetto
        // separato e NON è migrato. Un gate che avesse bisogno di una colonna del
        // cantiere A2 si spegnerebbe proprio là dove nessuno guarda, ed è il verso
        // sbagliato in cui degradare per un controllo di accesso.
        //
        // 🔑 `target_classes` SI CONFRONTA PER NOME, e il perché va scritto.
        // Quella colonna è ETEROGENEA in produzione: porta nomi di sezione, ma il
        // 2026-08-01 sono stati trovati due avvisi che ci avevano messo l'UUID
        // della sezione. Un helper che sappia leggere ENTRAMBE le forme per
        // decidere l'APPARTENENZA **non esiste** in `src/lib/avvisi/` — e va
        // detto invece di inventarne uno: `etichettaDestinatario`
        // (`@/lib/avvisi/destinatari`) è uuid-aware ma serve a STAMPARE
        // un'etichetta, non a decidere chi è destinatario; `classiMancantiNellaSede`
        // valida il target in SCRITTURA contro `sections.name`. La sola regola di
        // appartenenza che il repo applica oggi è per NOME, e sta in due punti:
        // la bacheca del genitore (`GET /api/avvisi`, che filtra gli avvisi sui
        // `classe_sezione` dei figli) e i destinatari delle notifiche
        // (`genitoriDiClassi`, che fa `.in('classe_sezione', classi)`). Questo
        // gate riusa quella, testualmente: **non è più stretto della bacheca** —
        // un avviso con l'uuid in `target_classes` non compare già oggi a nessun
        // genitore, quindi nessuno perde un bottone che vedeva. Il giorno in cui
        // l'appartenenza imparerà a leggere gli uuid dovrà impararlo in UN posto
        // solo, e quel posto oggi non c'è.
        // ═════════════════════════════════════════════════════════════════════
        const { data: avviso, error: erroreAvviso } = await supabase
            .from('avvisi')
            .select('author_id, titolo, scuola_id, target_scope, target_classes')
            .eq('id', avvisoId)
            .maybeSingle();
        if (erroreAvviso) {
            // PostgREST non lancia: senza questo controllo il guasto uscirebbe
            // come «l'avviso non c'è», cioè un 404 che accusa il genitore di aver
            // aperto un avviso ritirato mentre il database non ha risposto.
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'avviso-non-letto-per-gate',
                avviso: avvisoId,
            }, erroreAvviso);
            return NextResponse.json(
                { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                { status: 503 },
            );
        }
        if (!avviso) {
            return NextResponse.json(
                { error: 'Avviso non trovato.', codice: 'AVVISO_NON_TROVATO' },
                { status: 404 },
            );
        }

        const { data: alunno, error: erroreAlunno } = await supabase
            .from('alunni')
            .select('scuola_id, classe_sezione')
            .eq('id', student_id)
            .maybeSingle();
        if (erroreAlunno) {
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'alunno-non-letto-per-gate',
                avviso: avvisoId,
                alunno: student_id,
            }, erroreAlunno);
            return NextResponse.json(
                { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                { status: 503 },
            );
        }

        const sedeAvviso = (avviso.scuola_id as string | null) ?? null;
        const sedeAlunno = (alunno?.scuola_id as string | null) ?? null;
        const classeAlunno = (alunno?.classe_sezione as string | null) ?? null;
        const classiTarget = ((avviso.target_classes as string[] | null) ?? [])
            .filter((c): c is string => typeof c === 'string' && c.trim() !== '');
        // `target_scope = 'classe'` con l'elenco VUOTO vale globale, ed è la
        // stessa lettura che fanno `POST /api/avvisi` (archivia `null` quando le
        // classi valide sono zero) e il promemoria delle adesioni. Trattarlo come
        // «nessuno è destinatario» chiuderebbe l'adesione a tutti su avvisi che
        // oggi arrivano a tutti.
        const perClasse = ((avviso.target_scope as string | null) ?? 'globale') === 'classe'
            && classiTarget.length > 0;

        // Fail-closed: un alunno che l'anagrafica non restituisce, o senza sede,
        // non è destinatario di niente. `genitoreHasFiglio` ha già detto che il
        // legame c'è: se la riga non si legge, il dato è incoerente e una
        // scrittura su un dato incoerente è esattamente ciò che si sta chiudendo.
        const fuoriSede = !sedeAvviso || !sedeAlunno || sedeAlunno !== sedeAvviso;
        const fuoriClasse = perClasse && (!classeAlunno || !classiTarget.includes(classeAlunno));
        if (fuoriSede || fuoriClasse) {
            // Solo uuid, un enumerato e un conteggio: mai il nome del bambino, mai
            // il titolo dell'avviso, mai il nome della classe — `sezione` sarebbe
            // in lista bianca, ma qui non serve a diagnosticare e nomina il posto
            // in cui sta un minore.
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'adesione-alunno-fuori-avviso',
                avviso: avvisoId,
                alunno: student_id,
                uid: parent_id,
                tipo: fuoriSede ? 'sede' : 'classe',
                n_classi: classiTarget.length,
            });
            return NextResponse.json(
                { error: 'Questo avviso non riguarda il bambino indicato.', codice: 'ADESIONE_ALUNNO_FUORI_AVVISO' },
                { status: 403 },
            );
        }

        // Morosità: l'adesione all'avviso è un'azione di servizio → bloccata se sospeso.
        const sospeso = await assertGenitoreNonSospeso(supabase, parent_id);
        if (sospeso) return sospeso;

        // ─────────────────────────────────────────────────────────────────────
        // TUTTO IL LAVORO DELICATO STA NELLA FUNZIONE DI DATABASE, e non qui.
        //
        // Termine, numero, tetto dei posti contato in PERSONE e lista d'attesa
        // si decidono in `avviso_adesione_registra`, che serializza su
        // `SELECT … FROM avvisi WHERE id = … FOR UPDATE` e conta DOPO quel lock.
        // Rifarlo in TypeScript è esattamente il difetto che la migrazione A2
        // esiste per chiudere: due genitori che leggono «occupati 8» nello stesso
        // istante e vengono ammessi entrambi contro un tetto di 10 — la forma di
        // `varia_saldo_ticket`, incasso doppio e saldo singolo, senza un errore e
        // senza un log.
        //
        // Con la RPC sparisce anche una QUERY: `prima_lettura`/`prima_risposta`
        // tornano dalla funzione, calcolate sotto lo stesso lock, invece che da
        // una pre-lettura. Con la pre-lettura c'era una finestra TOCTOU in cui due
        // richieste dello stesso genitore concludevano entrambe «è la prima volta»
        // e notificavano due volte.
        //
        // `p_ora` NON si manda: il default della funzione è `now()`, cioè
        // l'orologio del DATABASE — lo stesso che ha scritto le scadenze. Mandare
        // l'ora del processo Node significherebbe misurare un termine con due
        // orologi diversi.
        // ─────────────────────────────────────────────────────────────────────
        const { data: esitoRaw, error: erroreRpc } = await supabase.rpc('avviso_adesione_registra', {
            p_avviso_id: avvisoId,
            p_parent_id: parent_id,
            p_student_id: student_id,
            p_risposta: risposta ?? null,
            p_numero: numero ?? null,
        });

        if (erroreRpc) {
            const code = codiceDb(erroreRpc);
            if (RPC_ASSENTE.has(code ?? '')) {
                // 🔴 NESSUN RIPIEGO CHE ACCETTA. Il punto dell'intera funzione è che
                // il server RIFIUTI le adesioni tardive e conti i posti sotto lock:
                // un upsert di ripiego che registrasse comunque un `si` ricreerebbe
                // il buco proprio sulla strada che nessuno guarda — l'ambiente in cui
                // la migrazione non è arrivata. Si degrada in modo pulito e si dice.
                if (risposta !== undefined) {
                    logEvento('db', 'error', {
                        operazione: 'avvisi/[id]/risposte:POST',
                        esito: 'adesioni-rpc-assente',
                        avviso: avvisoId,
                    }, erroreRpc);
                    return NextResponse.json(
                        { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                        { status: 503 },
                    );
                }
                // PURA PRESA VISIONE: nessun posto da contare, nessun termine da far
                // valere (leggere tardi non è aderire). Qui il ripiego non allenta
                // niente, e rifiutarlo renderebbe falso l'elenco «chi non ha letto».
                //
                // `warn` e non `info`: la riga è scritta, ma NON sotto il lock — e
                // chi legge i log deve poter distinguere le prese visione atomiche da
                // quelle passate di qui. `info` le avrebbe confuse con le prime.
                logEvento('db', 'warn', {
                    operazione: 'avvisi/[id]/risposte:POST',
                    esito: 'presa_visione_non_atomica_rpc_assente',
                    avviso: avvisoId,
                });
                const { data: esistente } = await supabase
                    .from('avvisi_risposte')
                    .select('letto_il, risposta, risposto_il')
                    .eq('avviso_id', avvisoId)
                    .eq('parent_id', parent_id)
                    .eq('student_id', student_id)
                    .maybeSingle();
                const { data: rigaRipiego, error: erroreRipiego } = await supabase
                    .from('avvisi_risposte')
                    .upsert(
                        {
                            avviso_id: avvisoId,
                            parent_id,
                            student_id,
                            letto_il: (esistente?.letto_il as string | null) ?? new Date().toISOString(),
                            risposta: (esistente?.risposta as string | null) ?? null,
                            risposto_il: (esistente?.risposto_il as string | null) ?? null,
                        },
                        { onConflict: 'avviso_id,parent_id,student_id' },
                    )
                    .select()
                    .single();
                if (erroreRipiego) {
                    logErrore({ operazione: 'avvisi/[id]/risposte:POST', stato: 503, evento: 'db' }, erroreRipiego);
                    return NextResponse.json(
                        { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                        { status: 503 },
                    );
                }
                return NextResponse.json({ ...rigaRipiego, stato: null });
            }
            logErrore({ operazione: 'avvisi/[id]/risposte:POST', stato: 503, evento: 'db' }, erroreRpc);
            return NextResponse.json(
                { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                { status: 503 },
            );
        }

        const esito = (esitoRaw ?? {}) as EsitoRegistra;

        if (esito.ok !== true) return rifiutoAdesione(esito, avvisoId);

        const stato = esito.stato ?? null;
        const data = { ...(esito.riga ?? {}), stato };

        // I due numeri che la RPC ha calcolato sotto il proprio lock. `Number.isFinite`
        // e non `?? 0`: se un giorno la funzione restituisse una stringa, `?? 0` la
        // lascerebbe passare e `'3' > 0` sarebbe vero per il motivo sbagliato.
        const postiLiberati = typeof esito.posti_liberati === 'number' && Number.isFinite(esito.posti_liberati)
            ? esito.posti_liberati : 0;
        const inCoda = typeof esito.in_attesa === 'number' && Number.isFinite(esito.in_attesa)
            ? esito.in_attesa : 0;

        // 🔴 IL SUCCESSO SI LOGGA. Fino a oggi questa route rispondeva 200 e non
        // lasciava niente: «nessun log» non distingueva «tutto ok» da «non è mai
        // partito niente» (AGENTS, regola 5). E «quante adesioni sono finite in
        // lista d'attesa» è la prima domanda che farà la segreteria.
        //
        // ⚠️ L'esito sta in `esito`, NON in un campo `stato`: `stato` in `logErrore`
        // significa già lo status HTTP, e due tassonomie sulla stessa colonna
        // spezzano la query in silenzio — è il difetto che `eventi-log` racconta
        // per `evento`, applicato a un campo diverso.
        logEvento('avvisi', 'info', {
            operazione: 'avvisi/[id]/risposte:POST',
            esito: stato === 'ammessa' ? 'adesione-ammessa'
                : stato === 'in_attesa' ? 'adesione-in-attesa'
                    : risposta === 'no' ? 'adesione-ritirata' : 'presa-visione',
            avviso: avvisoId,
            con_numero: numero != null,
            // Quante PERSONE questa chiamata ha rilasciato. È un intero e passa la
            // lista bianca di `redact`; senza, «il posto si è liberato e nessuno è
            // stato avvisato» e «non c'era niente da liberare» hanno lo stesso log.
            //
            // 🔴 `null` QUANDO LA RPC NON LO DICE AFFATTO, e non è pedanteria: lo
            // zero di `postiLiberati` copre DUE fatti diversi — «non c'era niente
            // da liberare» e «la funzione è quella vecchia, che questo numero non
            // lo restituisce» (il DB E2E della CI non è migrato). Scritti tutti e
            // due come `0` non si distinguono più, ed è la forma esatta del `?? 0`
            // che ha congelato per sempre lo stato SDI di una fattura: lo zero
            // scritto una volta non si separa più dallo zero misurato. `null`
            // significa «non misurato», che è l'unica cosa vera in quel caso.
            posti_liberati: esito.posti_liberati === undefined ? null : postiLiberati,
            atomico: true,
        });

        // ─────────────────────────────────────────────────────────────────────
        // LE DUE NOTIFICHE DEL BLOCCO DI SUCCESSO, E UNA SOLA LETTURA DELL'AVVISO.
        //
        // Hanno destinatari diversi (l'autore · la segreteria della sede) e
        // condizioni diverse, ma leggono la STESSA riga di `avvisi`: la si prende
        // una volta sola. Due letture dello stesso avviso nello stesso istante
        // sarebbero una query pagata per niente su una strada che ogni famiglia
        // percorre.
        //
        // ⚠️ QUELLA LETTURA ORA STA IN CIMA, accanto al gate: il gate ha bisogno
        // della STESSA riga (`scuola_id`, `target_scope`, `target_classes`), e
        // rileggerla qui avrebbe voluto dire due letture dell'avviso nella stessa
        // richiesta. Qui sotto si riusa `avviso`, con due conseguenze dichiarate:
        //   · la lettura non è più best-effort. Prima un guasto su di essa
        //     costava solo l'annuncio; ora la richiesta si ferma PRIMA della RPC
        //     con un 503, ed è il verso giusto — non si registra un'adesione che
        //     non si è potuta validare;
        //   · non serve più il `try/catch` attorno alla lettura (non c'è più
        //     lettura), ma quelli attorno alle DUE notifiche restano: un'eccezione
        //     lì diventerebbe un **500 a un genitore la cui adesione è già
        //     registrata**, e il 200 è dovuto — la riga c'è.
        //
        // Prima ancora, questa lettura stava DENTRO il ramo
        // `prima_lettura || prima_risposta`, cioè esattamente il ramo in cui un
        // RITIRO non entra mai (chi si ritira aveva già risposto «sì», quindi
        // `prima_risposta` è falso). La notifica dei posti liberati non avrebbe
        // mai avuto la `scuola_id` a cui mandarla.
        //
        // ⚠️ E ALLORA IL GATE NON COSTA «UNA LETTURA IN PIÙ» SEMPRE: il conto va
        // fatto per ramo, perché la riga sopra dice proprio che prima l'avviso
        // NON si leggeva su tutte le strade.
        //   · PRIMA presa visione, prima risposta, ritiro con coda — cioè i rami
        //     in cui una notifica sarebbe comunque partita: l'avviso si leggeva
        //     già, il gate aggiunge la sola `alunni`. **+1**.
        //   · PRESA VISIONE RIPETUTA (`prima_lettura` e `prima_risposta` falsi,
        //     nessun posto liberato): prima non si leggeva NIENTE qui, e ora si
        //     leggono `avvisi` e `alunni`. **+2**, non +1.
        // Scritto perché è il ramo più frequente di tutti — ogni riapertura di un
        // avviso già letto ci passa — e un costo dichiarato per difetto è il modo
        // in cui una strada calda smette di essere misurata.
        // ─────────────────────────────────────────────────────────────────────
        const vaNotificatoAutore = esito.prima_lettura === true || esito.prima_risposta === true;
        // 🔴 NIENTE CODA ⇒ NIENTE NOTIFICA. È il testo stesso dell'etichetta
        // («un ritiro libera posti su un avviso con persone in lista d'attesa»):
        // senza nessuno che aspetta non c'è niente da decidere, e un invito ad
        // agire dove non c'è azione è il rumore che fa spegnere le notifiche.
        const vaNotificatoPostiLiberati = postiLiberati > 0 && inCoda > 0;

        // Notifica all'autore dell'avviso (best-effort), solo alla PRIMA presa
        // visione/risposta di questo genitore (le riaperture non ri-notificano).
        // Buffer 60' + debounce per avviso → una notifica riassuntiva, non 30.
        try {
            if (vaNotificatoAutore && avviso?.author_id && avviso.author_id !== parent_id) {
                const { data: autore } = await supabase
                    .from('utenti')
                    .select('role, ruolo')
                    .eq('id', avviso.author_id)
                    .maybeSingle();
                const ruoloAutore = ((autore?.role as string) || (autore?.ruolo as string) || '').toLowerCase();
                const areaStaff = ['admin', 'coordinator', 'segreteria'].includes(ruoloAutore);
                await notificaEvento(supabase, {
                    tipo: 'avviso_risposta',
                    scuolaId: (avviso.scuola_id as string | undefined) ?? null,
                    utenteIds: [avviso.author_id as string],
                    titolo: 'Nuove risposte al tuo avviso',
                    corpo: `Ci sono nuove prese visione o adesioni per «${avviso.titolo}».`,
                    link: areaStaff ? `/admin/avvisi/${avvisoId}` : '/teacher/avvisi',
                    entitaTipo: 'avviso',
                    entitaId: avvisoId,
                    bufferMin: 60,
                    debounce: true,
                });
            }
        } catch (e) {
            // `error` benché la risposta del genitore sia registrata: l'autore dell'avviso non
            // saprà mai che è arrivata una presa visione o un'adesione. La riga di risposta c'è,
            // il suo annuncio no — ed è proprio il conteggio delle adesioni che chi ha pubblicato
            // l'avviso sta aspettando.
            logEvento('notifica', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'notifica-autore-non-accodata',
            }, e);
        }

        // ─────────────────────────────────────────────────────────────────────
        // «SI SONO LIBERATI DEI POSTI» — decisione n. 28 del committente.
        //
        // Un ritiro (o una riduzione del numero) ha rilasciato posti su un avviso
        // dove qualcuno aspetta in coda: nessuno viene promosso in automatico — la
        // migrazione A2 lo dichiara per esteso — quindi *una persona* deve decidere
        // chi entra, e va avvisata. Senza questa riga il posto liberato resta vuoto
        // fino a quando qualcuno riapre quella schermata per caso.
        //
        // 🔴 VA ALLA SEGRETERIA DELLA SEDE DELL'AVVISO, MAI AI DOCENTI. Le adesioni
        // il docente le vede in sola lettura: il bottone «ammetti dalla coda» non ce
        // l'ha, e una notifica che invita a premerlo è un invito a cercare un
        // comando che non esiste. `staffScuola` logga da sé `sede-non-risolta` e
        // `nessun-destinatario`.
        //
        // 🔴 IL TESTO NON NOMINA NESSUNO: né la famiglia che si è ritirata, né il
        // bambino, né il TITOLO dell'avviso. La notifica arriva sul telefono, in
        // notifica di sistema, e si legge a schermo bloccato: «Marco Rossi si è
        // ritirato dalla gita al museo» racconta a chiunque guardi quel telefono che
        // c'è un minore di nome Marco Rossi e dove doveva andare. Il link porta alla
        // schermata dove quei dati stanno, dietro la sessione di chi ha titolo.
        //
        // 🔴 IL PATCH (`stato: 'nessuna'`, la segreteria che toglie una famiglia)
        // NON EMETTE QUESTA NOTIFICA, ed è una decisione, non una dimenticanza:
        // quel ritiro l'ha appena fatto la segreteria stessa, e mandarle una
        // notifica per dirle ciò che ha appena fatto è rumore puro. Chi al giro
        // dopo volesse aggiungerla «per simmetria» tolga prima questa riga.
        //
        // Buffer 60' + debounce sull'avviso: dieci ritiri sullo stesso avviso nella
        // stessa ora collassano in UNA riga, non dieci.
        try {
            if (vaNotificatoPostiLiberati) {
                const destinatari = await staffScuola(
                    supabase,
                    (avviso?.scuola_id as string | null) ?? null,
                    ['admin', 'coordinator', 'segreteria'],
                );
                if (destinatari.length > 0) {
                    await notificaEvento(supabase, {
                        tipo: 'posti_liberati',
                        scuolaId: (avviso?.scuola_id as string | undefined) ?? null,
                        utenteIds: destinatari,
                        titolo: 'Si sono liberati dei posti',
                        corpo: 'Su un avviso con persone in lista d’attesa si sono liberati dei posti: qualcuno deve decidere chi entra.',
                        link: `/admin/avvisi/${avvisoId}`,
                        entitaTipo: 'avviso',
                        entitaId: avvisoId,
                        bufferMin: 60,
                        debounce: true,
                    });
                }
            }
        } catch (e) {
            // `error` e non `info`: il ritiro è registrato e il posto è libero, ma
            // nessuno lo sa. Un posto che resta vuoto mentre una famiglia aspetta in
            // coda è esattamente il guasto che questa notifica esiste per impedire, e
            // un catch muto lo renderebbe invisibile.
            logEvento('notifica', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'notifica-posti-liberati-non-accodata',
                avviso: avvisoId,
            }, e);
        }

        return NextResponse.json(data);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]/risposte:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
