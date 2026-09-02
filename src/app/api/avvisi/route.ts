import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { getModuleConfig } from '@/lib/settings/module-config';
import { requireUser, requireDocente } from '@/lib/auth/require-staff';
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "agisceComeGenitore" export is defined on the mock`.
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami';
import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { degradoSedeLecito } from '@/lib/forms/degrado-sede';
import { firmaAllegatiAvvisi, normalizzaAllegatoAvviso } from '@/lib/allegati/storage';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { RUOLI_PUBBLICAZIONE_DEFAULT } from '@/lib/scuole/admin-settings-default';
import { zTitoloAvviso, zContenutoAvviso, zTipoAvviso, zTargetScopeAvviso, zScadenzaAvviso, zTargetClassesAvviso } from '@/lib/validation/avvisi';
import { classiMancantiNellaSede, classiTargetValide } from '@/lib/avvisi/classi-sede';
import {
    statistichePerAvviso, autoriDegliAvvisi, rispostePerAvvisoDelGenitore,
    AUTORE_IGNOTO, STATS_ZERO,
} from '@/lib/avvisi/statistiche';

// Il ramo STAFF filtra ancora per scope/classe (dashboard cockpit). Il ramo
// GENITORE è SERVER-DERIVED (G3): i parametri client sono ignorati, figli e
// classi si ricavano dalla sessione — quindi qui non c'è più parentId/studentId.
const getQuerySchema = z.object({
    scope: z.string().optional(),
    classe: z.string().optional(),
});

const postBodySchema = z.object({
    // NB: `author_id` NON è più nel body (M7): l'autore è sempre la sessione.
    // I massimi vengono dal DDL e stanno in `@/lib/validation/avvisi`: senza,
    // un titolo lungo usciva come 500 col tipo della colonna dentro (S34).
    titolo: zTitoloAvviso,
    contenuto: zContenutoAvviso,
    tipo: zTipoAvviso.nullish(),
    target_scope: zTargetScopeAvviso.nullish(),
    target_classes: zTargetClassesAvviso.optional(),
    scadenza: zScadenzaAvviso.nullish(),
    attachment_url: z.string().nullish(),
    // Modulo firmabile FEA collegato (gita): opzionale (item 19).
    form_model_id: zUuid.nullish(),
    // Sede su cui si PUBBLICA (multi-sede, 2026-07-31). Il cockpit la manda
    // esplicitamente; se manca la deduce `resolveScuolaScrittura` dal selettore
    // di sede, e se resta ambigua risponde 400. Mai la sede primaria dell'autore.
    scuola_id: zUuid.nullish(),
});

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>;

const AVVISO_COLS =
    'id, author_id, titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url, created_at';

type AvvisoRow = {
    id: string; author_id: string; titolo: string; contenuto: string;
    tipo: string | null; target_scope: string | null; target_classes: string[] | null;
    scadenza: string | null; attachment_url: string | null; created_at: string;
    form_model_id?: string | null;
};

type Figlio = { id: string; nome: string | null; classe_sezione: string | null; scuola_id: string | null };
type RispostaFiglio = { letto_il: string | null; risposta: string | null; risposto_il: string | null };

// PostgREST torna 42703 (SELECT) / PGRST204 (INSERT) quando `form_model_id` manca
// nel DB E2E CI non migrato: si riprova senza la colonna.
function colonnaMancante(err: { code?: string } | null | undefined): boolean {
    return !!err && ['PGRST204', '42703'].includes(err.code ?? '');
}

/**
 * Conteggi risposte + info autore per UN ELENCO di avvisi, in blocco (T11-F2).
 *
 * Qui prima c'era `autoreEStats(supabase, avviso)`, chiamata dentro un `.map()`:
 * tre `count` su `avvisi_risposte` e una `maybeSingle()` su `utenti` per OGNI
 * avviso. Il `Promise.all` che l'avvolgeva le mandava in parallelo — e questo è
 * esattamente ciò che rendeva il difetto invisibile: con dieci avvisi in tabella
 * il cronometro non se ne accorge, con duecento sono ottocento round-trip verso
 * Postgres per aprire una bacheca.
 *
 * Il numero di query ora è indipendente da quanti avvisi ci sono. Il conteggio
 * resta ESATTO: vedi `@/lib/avvisi/statistiche`, dove la lettura pagina finché il
 * `count` esatto del server non è coperto — un'aggregazione fatta su righe
 * troncate mostrerebbe «hanno letto in 3» invece di «in 47», che è peggio di un
 * errore perché sembra un dato.
 */
async function autoriEStatistiche(supabase: SupabaseAdmin, avvisi: readonly AvvisoRow[]) {
    const [stats, autori] = await Promise.all([
        statistichePerAvviso(supabase, avvisi.map((a) => a.id), 'avvisi:GET'),
        autoriDegliAvvisi(supabase, avvisi.map((a) => a.author_id), 'avvisi:GET'),
    ]);
    return (avviso: AvvisoRow) => ({
        author: autori.get(avviso.author_id) ?? AUTORE_IGNOTO,
        stats: stats.get(avviso.id) ?? { ...STATS_ZERO },
    });
}

// Aggrega le risposte per-figlio di UN avviso in un singolo `my_response` (il
// contratto di AvvisoCard). Un figlio solo → è esattamente la sua risposta.
// Più figli (avviso globale) → "letto" solo se TUTTI hanno letto, "risposto"
// solo se tutti hanno dato la STESSA risposta (altrimenti i bottoni riappaiono).
function aggregaRisposta(
    studentIds: string[],
    perFiglio: Map<string, RispostaFiglio>,
): RispostaFiglio | null {
    if (studentIds.length === 0) return null;
    const righe = studentIds.map((id) => perFiglio.get(id) ?? null);

    const tuttiLetti = righe.every((r) => !!r?.letto_il);
    const letti = righe.map((r) => r?.letto_il).filter((x): x is string => !!x).sort();
    const letto_il = tuttiLetti ? letti[letti.length - 1] ?? null : null;

    const risposte = righe.map((r) => r?.risposta ?? null);
    const tuttiRisposto = risposte.every((x) => x != null);
    const uguali = tuttiRisposto && new Set(risposte).size === 1;
    const rispostiIl = righe.map((r) => r?.risposto_il).filter((x): x is string => !!x).sort();

    return {
        letto_il,
        risposta: uguali ? risposte[0] : null,
        risposto_il: uguali ? (rispostiIl[rispostiIl.length - 1] ?? null) : null,
    };
}

// ── Ramo STAFF/DOCENTE: cockpit /admin|/teacher avvisi, isolato per plesso. ──
async function listaAvvisiStaff(
    request: NextRequest,
    supabase: SupabaseAdmin,
    plessiScope: string[],
): Promise<NextResponse> {
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { scope, classe } = q.data;

    const buildQuery = (cols: string) => {
        let query = supabase.from('avvisi').select(cols).order('created_at', { ascending: false })
            .in('scuola_id', plessiScope);
        if (scope) query = query.eq('target_scope', scope);
        return query;
    };
    let res = await buildQuery(`${AVVISO_COLS}, form_model_id`);
    if (colonnaMancante(res.error as { code?: string } | null)) res = await buildQuery(AVVISO_COLS);
    if (res.error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, res.error);
        return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
    let filtered = (res.data ?? []) as unknown as AvvisoRow[];
    if (classe) {
        filtered = filtered.filter(
            (a) => a.target_scope === 'globale' || (a.target_classes?.includes(classe) ?? false),
        );
    }

    // Due query in tutto, non quattro per avviso: il `.map()` qui sotto non tocca
    // più il database.
    const arricchisci = await autoriEStatistiche(supabase, filtered);
    const enriched = filtered.map((avviso) => ({
        ...avviso, ...arricchisci(avviso), my_response: null,
    }));
    // Il bucket degli allegati è PRIVATO (2026-07-31): l'indirizzo si firma qui,
    // dietro a questo gate, e vale dieci minuti. Una sola chiamata per pagina.
    return NextResponse.json(await firmaAllegatiAvvisi(supabase, enriched, 'avvisi:GET'));
}

// ── Ramo GENITORE (G3+m3): parentId dalla SESSIONE, feed unificato dei figli. ─
async function listaAvvisiGenitore(supabase: SupabaseAdmin, parentId: string): Promise<NextResponse> {
    const figliIds = await getFigliDiGenitore(supabase, parentId);
    if (figliIds.length === 0) return NextResponse.json([]);

    const { data: figliRows, error: figliErr } = await supabase
        .from('alunni')
        .select('id, nome, classe_sezione, scuola_id')
        .in('id', figliIds);
    if (figliErr) {
        logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, figliErr);
        return NextResponse.json({ error: figliErr.message }, { status: 500 });
    }
    const figli = (figliRows ?? []) as unknown as Figlio[];
    const classiFigli = new Set(figli.map((f) => f.classe_sezione).filter((c): c is string => !!c));
    // Isolamento di plesso anche lato genitore: un globale di un'altra sede non compare.
    const scuoleFigli = [...new Set(figli.map((f) => f.scuola_id).filter((s): s is string => !!s))];
    // Fail-closed: se nessun figlio ha un plesso determinabile non si mostra nulla,
    // così un globale cross-tenant non appare quando scuola_id manca sull'anagrafica.
    if (scuoleFigli.length === 0) return NextResponse.json([]);

    const buildQuery = (cols: string) => {
        let query = supabase.from('avvisi').select(cols).order('created_at', { ascending: false });
        query = query.in('scuola_id', scuoleFigli);
        return query;
    };
    let res = await buildQuery(`${AVVISO_COLS}, form_model_id`);
    if (colonnaMancante(res.error as { code?: string } | null)) res = await buildQuery(AVVISO_COLS);
    if (res.error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, res.error);
        return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
    const avvisi = (res.data ?? []) as unknown as AvvisoRow[];

    const oggi = new Date().toISOString().split('T')[0];
    const rilevanti = avvisi.filter((a) => {
        if (a.scadenza && a.scadenza < oggi) return false; // scaduti fuori dal feed
        if (a.target_scope === 'globale') return true;
        return (a.target_classes ?? []).some((c) => classiFigli.has(c));
    });

    // Il percorso PIÙ CALDO dell'applicazione: è la home del genitore, e prima
    // costava CINQUE query per avviso (le quattro di `autoreEStats` più le
    // risposte del genitore, qui sotto). Ora sono tre in tutto, qualunque sia il
    // numero di avvisi, e il `.map()` che segue è puro calcolo in memoria.
    const [arricchisci, mieRisposte] = await Promise.all([
        autoriEStatistiche(supabase, rilevanti),
        rispostePerAvvisoDelGenitore(supabase, rilevanti.map((a) => a.id), parentId, 'avvisi:GET'),
    ]);

    const enriched = rilevanti.map((avviso) => {
        // m3: i FIGLI cui si riferisce (globale=tutti, classe=chi è in quella classe).
        const figliRiferiti = avviso.target_scope === 'globale'
            ? figli
            : figli.filter(
                (f) => f.classe_sezione && (avviso.target_classes ?? []).includes(f.classe_sezione),
            );
        const figliOut = figliRiferiti.map((f) => ({ student_id: f.id, nome: f.nome ?? '' }));

        // Risposte del genitore per QUESTO avviso, una riga per figlio: la mappa
        // è già in memoria, indicizzata per avviso e poi per alunno.
        const perFiglio: Map<string, RispostaFiglio> = mieRisposte.get(avviso.id) ?? new Map();
        const my_response = aggregaRisposta(figliRiferiti.map((f) => f.id), perFiglio);

        return { ...avviso, ...arricchisci(avviso), figli: figliOut, my_response };
    });

    // Stessa firma del ramo staff: il genitore riceve un link a tempo, non un
    // indirizzo pubblico che resterebbe valido per chiunque, per sempre.
    return NextResponse.json(await firmaAllegatiAvvisi(supabase, enriched, 'avvisi:GET'));
}

// GET /api/avvisi
// Ramo deciso sul RUOLO di sessione (non su un parametro client, G3):
//  - genitore → feed unificato dei propri figli, server-derived.
//  - docente/staff → cockpit isolato per plesso.
export const GET = withRoute('avvisi:GET', async (request: NextRequest) => {
    try {
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const supabase = await createAdminClient();

        // PRESENTAZIONE: quale delle due bacheche si sta guardando. `eFamiglia`
        // qui toglierebbe a una docente-genitore il cockpit di plesso — la sua
        // bacheca di lavoro — ogni volta che apre gli avvisi.
        if (agisceComeGenitore(auth.user)) {
            return await listaAvvisiGenitore(supabase, auth.user.id);
        }

        // Personale docente/staff: il genitore è già uscito sopra; cuoca e altri
        // ruoli non hanno una bacheca avvisi.
        const ruoliStaff = ['educator', 'admin', 'coordinator', 'segreteria'];
        if (!ruoliStaff.includes(auth.user.role)) {
            return NextResponse.json({ error: 'Accesso negato' }, { status: 403 });
        }
        // Sedi ATTIVE (cookie SedeSelector) ∩ sedi accessibili, ri-validate server-side.
        const plessiScope = await resolveScuoleAttive(request, supabase, auth.user);
        if (plessiScope.length === 0) return NextResponse.json([]);
        return await listaAvvisiStaff(request, supabase, plessiScope);
    } catch (error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// ── Le classi destinatarie devono esistere NELLA SEDE su cui si pubblica. ──
//
// `assertClasseNomeInScope` (lib/auth/scope) risolve il nome dentro TUTTI i
// plessi dell'utente: risponde «questa classe è tua», non «questa classe è nel
// plesso su cui stai pubblicando». Per la Direzione, che ha tre sedi, le due
// domande hanno risposte diverse, ed è la seconda che conta: «3 ANNI» esiste
// solo ad Aversa, quindi un avviso pubblicato su Giugliano che la nomina non
// raggiunge nessuno e non lo scopre nessuno (in produzione, il 2026-07-31, due
// avvisi erano già finiti così — con l'uuid della sezione al posto del nome).
//
// La sede arriva da `resolveScuolaScrittura`, cioè è già dentro il perimetro
// dell'utente: questo controllo è quindi **più stretto** dello scope, e vale da
// gate per TUTTI i ruoli (il gate dell'educator, `verificaTargetAvvisoDocente`,
// resta e risponde prima: «non è una tua classe» è un 403, non un 400).
// Una query sola, mai una per classe.
// L'esito è un'unione DISCRIMINATA su `ok`. Il campo dell'errore non può fare
// da discriminante: `errore: unknown` non è un tipo unitario, quindi
// `if (esito.errore)` non restringe l'unione e a valle `esito.mancanti` resta
// `string[] | null` — cioè il compilatore, giustamente, non crede al controllo.
// Lo dicono `tsc --noEmit` e `next build`; i test no, perché a runtime il ramo
// si comporta bene: è il tipo a non reggere, ed è il tipo che tiene onesto chi
// aggiungerà il prossimo controllo qui dentro.
// ─── Chi può pubblicare, e come si dice a chi non può (S24) ──────────────────
//
// `avvisi_config.ruoli_pubblicazione` non elenca RUOLI, elenca due GRUPPI:
// `admin` e `teacher`. È il vocabolario della schermata Impostazioni → Avvisi,
// dove la pillola `admin` si chiama letteralmente «Segreteria/Admin»
// (AvvisiSettings.tsx:24). Fino al 2026-07-31 la route metteva `segreteria` nel
// gruppo `teacher`: la segreteria veniva negata da una configurazione che, letta
// sullo schermo, la autorizzava. Il resto dell'applicazione non ha mai avuto
// questo dubbio — `areaForRole('segreteria') = 'admin'` (active-role.ts:24),
// `requireStaff` la ammette per default (require-staff.ts:253),
// `vedeTutteLeClassi` la include (scope.ts:240).
const RUOLI_GRUPPO_GESTIONE = ['admin', 'coordinator', 'segreteria'];

function gruppoPubblicazione(ruolo: string): string {
    return RUOLI_GRUPPO_GESTIONE.includes(ruolo) ? 'admin' : 'teacher';
}

/** Come si chiama un gruppo sullo schermo; un gruppo ignoto si mostra com'è. */
const ETICHETTA_GRUPPO: Record<string, string> = {
    admin: 'Segreteria e Direzione',
    teacher: 'Docenti',
};
const etichettaGruppo = (g: string) => ETICHETTA_GRUPPO[g] ?? g;

/**
 * Il messaggio del 403 dice la CONFIGURAZIONE, non un'ipotesi.
 *
 * Il testo precedente — «La pubblicazione di avvisi è riservata alla segreteria»
 * — era scritto per un caso solo e nominava come autorizzato proprio il ruolo
 * che stava ricevendo il diniego: la segreteria di Aversa lo ha letto per due
 * giorni. Un messaggio d'errore che afferma il contrario di quel che succede
 * costa più del silenzio, perché manda a cercare il guasto dove non è.
 */
function messaggioRuoliAbilitati(abilitati: readonly string[], gruppo: string): string {
    if (abilitati.length === 0) {
        return 'In questa sede nessun ruolo è abilitato a pubblicare avvisi — Impostazioni → Avvisi.';
    }
    return (
        `In questa sede possono pubblicare avvisi: ${abilitati.map(etichettaGruppo).join(', ')}. ` +
        `Il tuo ruolo (${etichettaGruppo(gruppo)}) non è fra questi — Impostazioni → Avvisi.`
    );
}

// POST /api/avvisi
// Body: { titolo, contenuto, tipo?, target_scope?, target_classes?, scadenza?, attachment_url?, form_model_id?, scuola_id? }
export const POST = withRoute('avvisi:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url, form_model_id } = b.data;

        // M7: l'autore è SEMPRE l'utente di sessione. `author_id` del client non esiste più.
        const authorId = auth.user.id;
        const ruolo = (auth.user.role || '').toLowerCase();

        const supabase = await createAdminClient();

        // La sede si DICHIARA (multi-sede, 2026-07-31). Fino a oggi era
        // `auth.user.scuola_id`: la sede PRIMARIA di chi scrive, che con tre
        // plessi non ha nessun rapporto con la sede su cui sta lavorando. Quel
        // valore si propagava a tutto — riga `avvisi`, audit, destinatari della
        // notifica — quindi un avviso per Aversa nasceva a Giugliano, lo
        // ricevevano le famiglie sbagliate (o nessuna) e l'autore non lo
        // ritrovava nemmeno nel cockpit. Se la sede resta ambigua il resolver
        // risponde 400: «dimmi dove stai pubblicando» è la risposta giusta, un
        // ripiego silenzioso no.
        const sw = await resolveScuolaScrittura(
            request as NextRequest, supabase, auth.user, b.data.scuola_id ?? undefined,
        );
        if (sw.response) return sw.response;
        const scuolaId = sw.scuolaId as string;

        // Ruoli abilitati alla pubblicazione: la configurazione è PER SEDE, e
        // quella che conta è la sede su cui si pubblica, non quella dell'autore.
        // Se la sede non ha ancora la configurazione (sede nuova, o DB E2E non
        // migrato) vale il default con cui la sede NASCE: una copia sola, non
        // due che divergono.
        const gruppo = gruppoPubblicazione(ruolo);
        const avvisiCfg = await getModuleConfig<{ ruoli_pubblicazione: string[] }>(
            supabase, 'avvisi_config', scuolaId,
        );
        const abilitati = avvisiCfg.ruoli_pubblicazione ?? [...RUOLI_PUBBLICAZIONE_DEFAULT];
        if (!abilitati.includes(gruppo)) {
            // `warn` → persistito. Un diniego di pubblicazione è quasi sempre una
            // configurazione da correggere, non un tentativo: senza questa riga
            // «la segreteria di Aversa non riesce a pubblicare» resta una
            // segnalazione telefonica invece di un dato. Solo metadati.
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi:POST',
                esito: 'pubblicazione-non-abilitata',
                tipo: 'ruolo-fuori-configurazione',
                ruolo,
                uid: auth.user.id,
                scuola_id: scuolaId,
                n_abilitati: abilitati.length,
            });
            return NextResponse.json(
                { error: messaggioRuoliAbilitati(abilitati, gruppo) },
                { status: 403 },
            );
        }

        // M8: 'classe' senza classi VALIDE → 400 (per TUTTI i ruoli). Niente più
        // degradazione implicita a globale: notifica e feed coincidono sempre.
        const classiTarget = classiTargetValide(target_classes);
        if ((target_scope ?? 'globale') === 'classe' && classiTarget.length === 0) {
            return NextResponse.json(
                { error: 'Seleziona almeno una classe destinataria per un avviso di classe.', codice: 'CLASSE_DESTINATARIA_MANCANTE' },
                { status: 400 },
            );
        }

        // Gate sul TARGET: un educator scrive solo alle proprie classi (mai globale,
        // mai classi altrui). Staff/direzione/segreteria non sono limitati.
        const targetErr = await verificaTargetAvvisoDocente(supabase, auth.user, {
            scope: target_scope,
            classi: target_classes,
        });
        if (targetErr) return targetErr;

        // Gate di SEDE sul target, per TUTTI i ruoli: ogni nome di classe deve
        // esistere nella sede risolta. Il nome-classe non è più una chiave
        // univoca (da quando le sedi sono tre, «2 ANNI» esiste in due plessi):
        // senza questo controllo si pubblica in una sede una classe che sta in
        // un'altra, e l'avviso non arriva a nessuno rispondendo 201.
        if (classiTarget.length > 0) {
            const esito = await classiMancantiNellaSede(supabase, scuolaId, classiTarget);
            if (!esito.ok) {
                logErrore({ operazione: 'avvisi:POST', stato: 500, evento: 'db' }, esito.errore);
                return NextResponse.json(
                    { error: 'Verifica delle classi destinatarie non riuscita', codice: 'VERIFICA_CLASSI_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            if (esito.mancanti.length > 0) {
                // `warn` → persistito: «pubblicare a una classe che non è in
                // questa sede» è o un errore d'interfaccia o un tentativo. Solo
                // metadati non personali (i nomi di sezione sono in lista bianca).
                logEvento('avvisi', 'warn', {
                    operazione: 'avvisi:POST',
                    esito: 'classe-fuori-sede',
                    tipo: 'target-non-nella-sede',
                    ruolo,
                    uid: auth.user.id,
                    n_classi: esito.mancanti.length,
                    sezione: esito.mancanti.join(','),
                });
                return NextResponse.json(
                    {
                        error:
                            'Classi non presenti nella sede selezionata: ' +
                            `${esito.mancanti.join(', ')}. Controlla la sede di pubblicazione.`,
                        codice: 'CLASSI_FUORI_SEDE',
                    },
                    { status: 400 },
                );
            }
        }

        // Insert resiliente alla colonna form_model_id mancante (DB E2E CI non migrato).
        const avvisoRecord: Record<string, unknown> = {
            author_id: authorId,
            titolo,
            contenuto,
            tipo: tipo ?? 'presa_visione',
            target_scope: target_scope ?? 'globale',
            // Si archivia l'insieme VALIDATO (`classiTarget`), non l'array grezzo:
            // validare una lista e scriverne un'altra rende il gate una formalità —
            // duplicati, stringhe vuote e valori non-testuali entrerebbero senza
            // essere mai stati confrontati con le sezioni della sede.
            target_classes: classiTarget.length > 0 ? classiTarget : null,
            scadenza: scadenza ?? null,
            // In tabella si archivia il PERCORSO nel bucket. Il modulo rilegge un
            // avviso già firmato e rimanda quell'indirizzo tale e quale: senza
            // questa normalizzazione resterebbe salvato un URL col token scaduto.
            attachment_url: normalizzaAllegatoAvviso(attachment_url),
            form_model_id: form_model_id ?? null,
            scuola_id: scuolaId, // tenant
        };
        // ── IL DEGRADO SI DICHIARA, E LA TENANCY NON SI SFILA MAI IN SILENZIO. ──
        //
        // Questo ciclo esiste per il DB E2E della CI, che non è migrato: PostgREST
        // risponde `PGRST204`/`42703` nominando la colonna che non ha, e si riprova
        // senza. Il difetto era che `scuola_id` È NEL RECORD: bastava che PostgREST la
        // nominasse (una migrazione a metà, una cache dello schema stantia, una colonna
        // rimossa per errore) perché l'avviso venisse inserito SENZA CHIAVE DI TENANCY,
        // senza una riga di log, con 201 al chiamante. Con tre plessi quella riga non è
        // di nessuno: non compare nel cockpit di nessuna sede e nel feed di nessuna
        // famiglia — cioè l'avviso "esiste" e non lo legge nessuno.
        //
        // Il gemello `gallery:GET` per lo stesso degrado NEGA già (`degradoSedeLecito`):
        // si prosegue senza isolamento SOLO se non c'è niente da isolare (al più una
        // sede reale). Qui vale la stessa regola, e per la stessa ragione: il fallback
        // scatta proprio quando l'isolamento non è disponibile, cioè nel momento in cui
        // è più pericoloso assecondarlo.
        //
        // Ogni colonna sfilata lascia comunque la sua riga: il nome viaggia sia come
        // campo (`colonna`, leggibile su Vercel) sia dentro `msg` — `redact()` è a lista
        // bianca PER CHIAVE e `colonna` non è in lista, quindi in `app_log` uscirebbe
        // come `[redatto:str/N]` e la riga direbbe «ho sfilato una colonna» senza dire
        // quale. `msg` finisce invece in `app_log.messaggio`, in chiaro e sanificato.
        let insRes = await supabase.from('avvisi').insert(avvisoRecord).select().single();
        let attempts = 0;
        while (insRes.error && colonnaMancante(insRes.error as { code?: string } | null) && attempts < 4) {
            const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(insRes.error.message);
            const col = m?.[1] ?? m?.[2];
            if (!col || !(col in avvisoRecord)) break;
            if (col === 'scuola_id' && !(await degradoSedeLecito(supabase, 'avvisi:POST'))) {
                // Isolamento di sede non disponibile su impianto multi-sede: è un
                // incidente, quindi `error`, mai `info`. E si NEGA prima di riprovare:
                // un avviso senza tenant è peggio di un avviso non pubblicato.
                logEvento('avvisi', 'error', {
                    operazione: 'avvisi:POST',
                    esito: 'colonna-sede-assente-degrado-negato',
                    msg: 'avvisi:POST: colonna "scuola_id" assente su impianto multi-sede, pubblicazione negata',
                });
                return NextResponse.json(
                    { error: 'Isolamento per sede non disponibile' },
                    { status: 500 },
                );
            }
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi:POST',
                esito: 'degrado-colonna-sfilata',
                colonna: col,
                msg: `avvisi:POST: colonna "${col}" assente sul DB, sfilata dal record`,
            });
            delete avvisoRecord[col];
            insRes = await supabase.from('avvisi').insert(avvisoRecord).select().single();
            attempts++;
        }
        const { data, error } = insRes;

        if (error) {
            // Il corpo del guasto sta nel LOG, non nella risposta: `error.message`
            // rigirato al client raccontava il tipo esatto della colonna
            // (`value too long for type character varying(255)`) a chiunque sapesse
            // mandare una stringa lunga — e a chi lavora in segreteria non diceva
            // niente di utile. Il massimo ora è dichiarato in zod, quindi un `22001`
            // che arrivasse comunque fin qui non è più un errore del chiamante: è la
            // prova che il DDL e `@/lib/validation/avvisi` hanno divergiuto, e resta
            // un 500 perché quella è la verità.
            logErrore({ operazione: 'avvisi:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Pubblicazione dell\'avviso non riuscita' }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: (data as { id?: string })?.id ?? null,
            azione: 'insert', scuolaId,
            valoreDopo: { id: (data as { id?: string })?.id, titolo, target_scope },
        });

        // Notifica ai genitori destinatari (best-effort). UN solo enqueue con
        // tipo per priorità: modulo firmabile > richiesta adesione > avviso.
        const tipoNotifica = form_model_id
            ? 'modulo_da_compilare'
            : (tipo === 'adesione' ? 'consenso_uscita' : 'avviso');
        // Il conteggio si tiene FUORI dal try perché è il dato del log di successo qui
        // sotto. `null` significa «non si è arrivati a calcolarlo»: in quel caso la riga
        // `error` del catch dice già perché, e un conteggio inventato mentirebbe.
        let nDestinatari: number | null = null;
        try {
            const globale = (target_scope ?? 'globale') === 'globale';
            const destinatari = globale
                ? await genitoriDiScuola(supabase, scuolaId)
                : await genitoriDiClassi(supabase, scuolaId, classiTarget);
            nDestinatari = destinatari.length;
            const titoloNotifica =
                tipoNotifica === 'modulo_da_compilare' ? `Modulo da compilare: ${titolo}`
                : tipoNotifica === 'consenso_uscita' ? `Richiesta di consenso: ${titolo}`
                : `Nuovo avviso: ${titolo}`;
            await notificaEvento(supabase, {
                tipo: tipoNotifica,
                scuolaId,
                utenteIds: destinatari,
                titolo: titoloNotifica,
                corpo: contenuto.length > 140 ? `${contenuto.slice(0, 140)}…` : contenuto,
                link: '/parent/avvisi',
                entitaTipo: 'avviso',
                entitaId: (data as { id?: string })?.id ?? null,
                bufferMin: 10,
                debounce: true,
            });
        } catch (e) {
            // `error` benché l'avviso sia pubblicato (201): la notifica non è mai stata accodata,
            // quindi le famiglie non sapranno dell'avviso — e se era un consenso o un modulo
            // firmabile, la segreteria aspetterà risposte che nessuno sa di dover dare. L'avviso
            // c'è, il suo recapito no: è una scrittura persa, non un dettaglio saltato.
            logEvento('notifica', 'error', {
                operazione: 'avvisi:POST',
                esito: 'notifica-genitori-non-accodata',
            }, e);
        }

        // IL SUCCESSO SI LOGGA, COL NUMERO DI FAMIGLIE RAGGIUNTE (AGENTS, regola 5).
        // Prima questa route rispondeva 201 e non lasciava NIENTE: né l'esito, né la
        // sede, né quante famiglie avesse davvero avvisato. Con i soli errori, «nessun
        // log» non distingue «tutto ok» da «non è partito niente» — ed è la condizione
        // in cui il sistema si trova adesso, perché in produzione ci sono alunni senza
        // alcun tutore collegato: un avviso di classe raggiunge meno famiglie di quante
        // ce ne siano, e nessuno può accorgersene. `n_destinatari: 0` è il dato che
        // rende visibile quel caso; solo conteggi, uuid e chiavi in lista bianca.
        logEvento('avvisi', 'info', {
            operazione: 'avvisi:POST',
            esito: 'pubblicato',
            sede_id: scuolaId,
            tipo: tipoNotifica,
            n_destinatari: nDestinatari,
            n_classi: classiTarget.length,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'avvisi:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
