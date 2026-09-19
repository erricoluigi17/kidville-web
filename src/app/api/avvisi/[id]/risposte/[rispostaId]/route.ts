import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAvvisoInScope } from '@/lib/auth/scope-avvisi';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { zNumeroPartecipanti } from '@/lib/validation/avvisi';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// =============================================================================
// PATCH /api/avvisi/[id]/risposte/[rispostaId] — la SEGRETERIA sull'adesione di
// una famiglia: ammettere dalla coda, correggere il numero, togliere.
//
// ── PERCHÉ UN FILE SEPARATO DAL POST DEL GENITORE ───────────────────────────
//
// Perché un file con un gate da genitore (`requireUser` + `genitoreHasFiglio`) e
// uno da staff (`requireStaff`) è esattamente la forma che ha fatto nascere il
// lock `gate-coverage`: due pubblici diversi nello stesso sorgente, e il gate
// giusto che finisce sotto il ramo `if` sbagliato. Qui il gate si legge in una
// riga, ed è la prima.
//
// ── `requireStaff` E NON `requireDocente` ───────────────────────────────────
//
// `requireDocente` comprende l'`educator`, e la decisione del committente è che i
// docenti restino in SOLA LETTURA sulle adesioni: chi va in gita lo decide la
// segreteria. Con `requireDocente` un'insegnante potrebbe ammettere dalla coda
// (cioè scegliere quale famiglia entra) senza che niente lo segnali.
//
// ── UNA CHIAMATA, TRE GESTI ─────────────────────────────────────────────────
//
// `avviso_adesione_gestisci` fa ammissione, correzione del numero e RIMOZIONE
// (`p_stato: 'nessuna'`) sotto lo STESSO lock su `avvisi`, perché condividono
// l'invariante: tutti e tre cambiano quante persone risultano dentro. Separarli
// significherebbe due funzioni che si misurano a vicenda senza vedersi — la
// forma di `varia_saldo_ticket`.
// =============================================================================

interface RouteParams {
    params: Promise<{ id: string; rispostaId: string }>;
}

/**
 * ⚠️ `forza` e `ignora_rifiuto` NON devono mai partire come `null`.
 *
 * Nella funzione di database sono difesi da `COALESCE(…, false)`, ma il
 * `{"p_forza": null}` che PostgREST manda per una spunta lasciata vuota è
 * precisamente la trappola che quella difesa chiude: `NOT NULL AND NOT false` è
 * `NULL`, e un `IF` con condizione `NULL` **non scatta** — il rifiuto per
 * capienza sparirebbe in silenzio. La seconda riga di difesa è che il client non
 * lo produca: qui sono `optional()`, e più sotto si mandano solo se definiti.
 *
 * `'nessuna'` è un valore del PARAMETRO, mai un valore della colonna: porta
 * `stato_adesione` a `NULL` e libera il posto senza toccare `risposta`.
 */
const patchBodySchema = z
    .object({
        stato: z.enum(['ammessa', 'in_attesa', 'nessuna']).optional(),
        numero_partecipanti: zNumeroPartecipanti.optional(),
        forza: z.boolean().optional(),
        ignora_rifiuto: z.boolean().optional(),
    })
    .refine((b) => b.stato !== undefined || b.numero_partecipanti !== undefined, {
        message: 'Indica lo stato dell’adesione o il numero di persone: senza nessuno dei due non c’è niente da cambiare',
    });

/** L'esito di `avviso_adesione_gestisci`, nella forma del suo `COMMENT ON FUNCTION`. */
interface EsitoGestisci {
    ok?: boolean;
    code?: string;
    stato?: string | null;
    numero?: number | null;
    occupati?: number | null;
    posti_totali?: number | null;
    sopra_capienza?: boolean;
    risposta_allineata?: boolean;
    risposta_precedente?: string | null;
    riga?: Record<string, unknown> | null;
}

/** Vedi la nota gemella nel POST del genitore: `PGRST202` e `42883` sono la stessa condizione, vista da due livelli. */
const RPC_ASSENTE = new Set(['PGRST202', '42883']);

function codiceDb(err: unknown): string | undefined {
    return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
}

const NON_DISPONIBILE = () =>
    NextResponse.json(
        { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
        { status: 503 },
    );

/**
 * I rifiuti della RPC → HTTP + catalogo. La tabella di corrispondenza sta nella
 * migrazione A2, accanto al `COMMENT ON FUNCTION`.
 *
 * 🔴 QUI IL LETTORE È LA SEGRETERIA, e cambia due cose rispetto alla strada del
 * genitore:
 *  · `POSTI_ESAURITI` porta `occupati`/`posti_totali`/`richiesti`. La decisione
 *    del committente promette proprio quella segnalazione a chi deve scegliere
 *    se forzare; al genitore, invece, i posti liberi non si mostrano mai.
 *  · `RISPOSTA_CONTRARIA` **non è un errore: è una domanda.** La famiglia aveva
 *    risposto «no», e la funzione si ferma invece di riscriverle quel «no» —
 *    che è un fatto suo, e sovrascriverlo lo farebbe sparire dal database.
 *    L'interfaccia deve CHIEDERE conferma e ripresentarsi con
 *    `ignora_rifiuto: true`, non mostrare «operazione fallita».
 */
function rifiutoGestione(esito: EsitoGestisci, avvisoId: string): NextResponse {
    switch (esito.code) {
        case 'STATO_NON_VALIDO':
            return NextResponse.json(
                { error: 'Valore non ammesso per questa adesione.', codice: 'ADESIONE_VALORE_NON_VALIDO' },
                { status: 400 },
            );
        case 'NUMERO_FUORI_INTERVALLO':
            return NextResponse.json(
                { error: 'Il numero indicato non rientra fra quelli ammessi.', codice: 'NUMERO_PARTECIPANTI_FUORI_INTERVALLO' },
                { status: 400 },
            );
        case 'RISPOSTA_INESISTENTE':
            return NextResponse.json(
                { error: 'Questa risposta non appartiene a questo avviso.', codice: 'RISPOSTA_NON_DELLAVVISO' },
                { status: 404 },
            );
        case 'AVVISO_INESISTENTE':
            return NextResponse.json(
                { error: 'Avviso non trovato.', codice: 'AVVISO_NON_TROVATO' },
                { status: 404 },
            );
        case 'RISPOSTA_CONTRARIA':
            return NextResponse.json(
                {
                    error: 'Questa famiglia aveva risposto NO.',
                    codice: 'RISPOSTA_CONTRARIA',
                    risposta_precedente: esito.risposta_precedente ?? null,
                },
                { status: 409 },
            );
        case 'POSTI_ESAURITI':
            return NextResponse.json(
                {
                    error: 'Non ci sono abbastanza posti liberi.',
                    codice: 'POSTI_ESAURITI',
                    occupati: esito.occupati ?? null,
                    posti_totali: esito.posti_totali ?? null,
                    richiesti: esito.numero ?? null,
                },
                { status: 409 },
            );
        case 'ISOLAMENTO_NON_SUPPORTATO':
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte/[rispostaId]:PATCH',
                esito: 'isolamento-non-supportato',
                avviso: avvisoId,
            });
            return NON_DISPONIBILE();
        default:
            logEvento('db', 'error', {
                operazione: 'avvisi/[id]/risposte/[rispostaId]:PATCH',
                esito: 'esito-rpc-sconosciuto',
                avviso: avvisoId,
                error_code: esito.code ?? null,
            });
            return NON_DISPONIBILE();
    }
}

export const PATCH = withRoute(
    'avvisi/[id]/risposte/[rispostaId]:PATCH',
    async (request: Request, { params }: RouteParams) => {
        try {
            // Il gate PRIMA di tutto, `createAdminClient()` compreso: la
            // service-role scavalca le RLS, e aprirla prima di sapere chi è
            // significa avere il client aperto in ogni ramo d'uscita.
            const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria']);
            if (auth.response) return auth.response;

            const rawParams = await params;
            const pAvviso = parseData(zUuid, rawParams.id);
            if ('response' in pAvviso) return pAvviso.response;
            const avvisoId = pAvviso.data;
            const pRisposta = parseData(zUuid, rawParams.rispostaId);
            if ('response' in pRisposta) return pRisposta.response;
            const rispostaId = pRisposta.data;

            const b = await parseBody(request, patchBodySchema);
            if ('response' in b) return b.response;
            const { stato, numero_partecipanti: numero, forza, ignora_rifiuto } = b.data;

            const supabase = await createAdminClient();

            // Tre sedi, un solo database: l'avviso deve stare in un plesso
            // dell'attore. 500/404/403 distinti, mai confusi.
            const fuoriScope = await assertAvvisoInScope(supabase, auth.user, avvisoId);
            if (fuoriScope) return fuoriScope;

            // La sede dell'avviso serve all'audit: una riga di
            // `audit_scritture_docente` senza plesso non risponde a «chi ha
            // cambiato cosa, a Giugliano».
            const { data: avviso } = await supabase
                .from('avvisi')
                .select('id, scuola_id')
                .eq('id', avvisoId)
                .maybeSingle();

            // Il valore PRIMA, per il registro immodificabile. Si legge con
            // `avviso_id` accanto a `id`: senza, una segreteria di Giugliano
            // leggerebbe PER ID la riga di Aversa — lo stesso confine che la
            // funzione di database mette dentro la propria `WHERE`.
            const { data: prima } = await supabase
                .from('avvisi_risposte')
                .select('id, parent_id, student_id, risposta, numero_partecipanti, stato_adesione')
                .eq('id', rispostaId)
                .eq('avviso_id', avvisoId)
                .maybeSingle();

            // ⚠️ L'OGGETTO DEI PARAMETRI STA QUI, IN LINEA, e non in una variabile
            // costruita sopra. Non è stile: `isolamento-sede-coverage` legge gli
            // ARGOMENTI della `.rpc(` per verificare che agisca su un oggetto già
            // passato da un gate — una funzione `SECURITY DEFINER` non ha filtri che
            // le arrivino addosso. Con `rpc('…', parametri)` il lock non vede
            // `avvisoId` fra gli argomenti e segnala `rpc-senza-sede`: aveva ragione,
            // perché da quel punto in poi nessuno può più dire, leggendo la riga, su
            // quale plesso si sta scrivendo.
            //
            // ⚠️ `p_forza` e `p_ignora_rifiuto` si spandono solo se DEFINITI. Un
            // `null` esplicito su quei due è il difetto che la migrazione ha già
            // dovuto chiudere due volte: `NOT NULL AND NOT false` è `NULL`, e un `IF`
            // con condizione `NULL` non scatta — il rifiuto per capienza sparirebbe.
            const { data: esitoRaw, error: erroreRpc } = await supabase.rpc('avviso_adesione_gestisci', {
                p_avviso_id: avvisoId,
                p_risposta_id: rispostaId,
                p_stato: stato ?? null,
                p_numero: numero ?? null,
                ...(forza !== undefined ? { p_forza: forza } : {}),
                ...(ignora_rifiuto !== undefined ? { p_ignora_rifiuto: ignora_rifiuto } : {}),
            });

            if (erroreRpc) {
                // Entrambe a `error`, e l'`esito` le tiene distinte: «la funzione
                // non c'è» (ambiente non migrato) e «la funzione è fallita» sono
                // due incidenti diversi, e vanno contati separatamente. Il livello
                // è lo stesso perché la conseguenza è la stessa: la segreteria non
                // riesce a gestire la coda.
                logEvento('db', 'error', {
                    operazione: 'avvisi/[id]/risposte/[rispostaId]:PATCH',
                    esito: RPC_ASSENTE.has(codiceDb(erroreRpc) ?? '') ? 'adesioni-rpc-assente' : 'adesioni-rpc-fallita',
                    avviso: avvisoId,
                }, erroreRpc);
                return NON_DISPONIBILE();
            }

            const esito = (esitoRaw ?? {}) as EsitoGestisci;
            if (esito.ok !== true) return rifiutoGestione(esito, avvisoId);

            const statoPrima = (prima?.stato_adesione as string | null) ?? null;
            const statoDopo = esito.stato ?? null;

            // L'esito è il GESTO, non lo stato finale: «ho tolto qualcuno» e «ho
            // corretto un numero» sono due domande diverse che la segreteria farà
            // ai log. Il quarto valore (`adesione-messa-in-attesa`) esiste perché
            // rimandare in coda non è né un'ammissione né una rimozione, e
            // schiacciarlo su uno dei due direbbe il falso.
            const esitoLog =
                stato === 'nessuna' ? 'adesione-rimossa'
                    : stato === 'ammessa' ? 'adesione-ammessa-a-mano'
                        : stato === 'in_attesa' ? 'adesione-messa-in-attesa'
                            : 'numero-corretto';

            logEvento('avvisi', 'info', {
                operazione: 'avvisi/[id]/risposte/[rispostaId]:PATCH',
                esito: esitoLog,
                avviso: avvisoId,
                sopra_capienza: esito.sopra_capienza === true,
                risposta_allineata: esito.risposta_allineata === true,
            });

            // Ammettere o togliere qualcuno cambia CHI VA IN GITA: sta nel registro
            // immodificabile, non solo nei log a 30 giorni.
            await logScrittura(supabase, {
                attore: auth.user,
                entitaTipo: 'avviso_risposta',
                entitaId: rispostaId,
                azione: 'update',
                scuolaId: (avviso?.scuola_id as string | null) ?? null,
                valorePrima: prima ?? null,
                valoreDopo: esito.riga ?? null,
            });

            // ── LA FAMIGLIA VA AVVISATA, e una volta sola ────────────────────
            //
            // Solo alla TRANSIZIONE verso `ammessa`: chi era già dentro e a cui si
            // corregge il numero non deve ricevere «sei stato ammesso» una seconda
            // volta. `adesione_ammessa` è il tipo che esiste apposta («quando si
            // libera un posto e la tua adesione passa da lista d'attesa a
            // confermata»), ed è sotto il controllo della famiglia nelle
            // impostazioni delle notifiche.
            if (statoDopo === 'ammessa' && statoPrima !== 'ammessa' && prima?.parent_id) {
                try {
                    await notificaEvento(supabase, {
                        tipo: 'adesione_ammessa',
                        scuolaId: (avviso?.scuola_id as string | null) ?? null,
                        utenteIds: [prima.parent_id as string],
                        titolo: 'Adesione confermata',
                        corpo: 'La tua adesione è stata confermata: ora c’è posto.',
                        link: '/parent/avvisi',
                        entitaTipo: 'avviso',
                        entitaId: avvisoId,
                    });
                } catch (e) {
                    // La riga è scritta, l'annuncio no: la famiglia risulta dentro e
                    // non lo sa. È un `error` proprio perché l'operazione è riuscita —
                    // nessuno la vedrà fallire da nessun'altra parte.
                    logEvento('notifica', 'error', {
                        operazione: 'avvisi/[id]/risposte/[rispostaId]:PATCH',
                        esito: 'notifica-ammissione-non-accodata',
                        avviso: avvisoId,
                    }, e);
                }
            }

            return NextResponse.json({
                stato: statoDopo,
                numero: esito.numero ?? null,
                occupati: esito.occupati ?? null,
                posti_totali: esito.posti_totali ?? null,
                sopra_capienza: esito.sopra_capienza === true,
                risposta_allineata: esito.risposta_allineata === true,
                risposta_precedente: esito.risposta_precedente ?? null,
                riga: esito.riga ?? null,
            });
        } catch (error) {
            logErrore({ operazione: 'avvisi/[id]/risposte/[rispostaId]:PATCH', stato: 500 }, error);
            return NextResponse.json(
                { error: 'Le adesioni non sono disponibili in questo momento.', codice: 'ADESIONI_NON_DISPONIBILI' },
                { status: 500 },
            );
        }
    },
);
