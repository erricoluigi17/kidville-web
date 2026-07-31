import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { getModuleConfig } from '@/lib/settings/module-config';
import { requireUser, requireDocente } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami';
import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// Il ramo STAFF filtra ancora per scope/classe (dashboard cockpit). Il ramo
// GENITORE è SERVER-DERIVED (G3): i parametri client sono ignorati, figli e
// classi si ricavano dalla sessione — quindi qui non c'è più parentId/studentId.
const getQuerySchema = z.object({
    scope: z.string().optional(),
    classe: z.string().optional(),
});

const postBodySchema = z.object({
    // NB: `author_id` NON è più nel body (M7): l'autore è sempre la sessione.
    titolo: z.string().min(1, 'titolo e contenuto sono obbligatori'),
    contenuto: z.string().min(1, 'titolo e contenuto sono obbligatori'),
    tipo: z.string().nullish(),
    target_scope: z.string().nullish(),
    target_classes: z.unknown().optional(),
    scadenza: z.string().nullish(),
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

// Conteggi risposte + info autore: identico per staff e genitore.
async function autoreEStats(supabase: SupabaseAdmin, avviso: AvvisoRow) {
    const [lettiRes, siRes, noRes, autoreRes] = await Promise.all([
        supabase.from('avvisi_risposte').select('*', { count: 'exact', head: true })
            .eq('avviso_id', avviso.id).not('letto_il', 'is', null),
        supabase.from('avvisi_risposte').select('*', { count: 'exact', head: true })
            .eq('avviso_id', avviso.id).eq('risposta', 'si'),
        supabase.from('avvisi_risposte').select('*', { count: 'exact', head: true })
            .eq('avviso_id', avviso.id).eq('risposta', 'no'),
        supabase.from('utenti')
            .select('nome, cognome, ruolo, first_name, last_name, role')
            .eq('id', avviso.author_id).maybeSingle(),
    ]);
    const author = autoreRes.data as {
        nome?: string | null; cognome?: string | null; ruolo?: string | null;
        first_name?: string | null; last_name?: string | null; role?: string | null;
    } | null;
    return {
        author: author
            ? {
                first_name: author.first_name || author.nome || '?',
                last_name: author.last_name || author.cognome || '?',
                role: author.role || author.ruolo || 'unknown',
            }
            : { first_name: '?', last_name: '?', role: 'unknown' },
        stats: {
            letti: lettiRes.count ?? 0,
            adesioni_si: siRes.count ?? 0,
            adesioni_no: noRes.count ?? 0,
        },
    };
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

    const enriched = await Promise.all(
        filtered.map(async (avviso) => {
            const { author, stats } = await autoreEStats(supabase, avviso);
            return { ...avviso, author, stats, my_response: null };
        }),
    );
    return NextResponse.json(enriched);
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

    const enriched = await Promise.all(
        rilevanti.map(async (avviso) => {
            const { author, stats } = await autoreEStats(supabase, avviso);

            // m3: i FIGLI cui si riferisce (globale=tutti, classe=chi è in quella classe).
            const figliRiferiti = avviso.target_scope === 'globale'
                ? figli
                : figli.filter(
                    (f) => f.classe_sezione && (avviso.target_classes ?? []).includes(f.classe_sezione),
                );
            const figliOut = figliRiferiti.map((f) => ({ student_id: f.id, nome: f.nome ?? '' }));

            // Risposte del genitore per QUESTO avviso, una riga per figlio.
            const { data: risposteRows } = await supabase
                .from('avvisi_risposte')
                .select('student_id, letto_il, risposta, risposto_il')
                .eq('avviso_id', avviso.id)
                .eq('parent_id', parentId);
            const perFiglio = new Map<string, RispostaFiglio>();
            for (const r of (risposteRows ?? []) as Array<{ student_id: string } & RispostaFiglio>) {
                perFiglio.set(r.student_id, { letto_il: r.letto_il, risposta: r.risposta, risposto_il: r.risposto_il });
            }
            const my_response = aggregaRisposta(figliRiferiti.map((f) => f.id), perFiglio);

            return { ...avviso, author, stats, figli: figliOut, my_response };
        }),
    );

    return NextResponse.json(enriched);
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

        if (auth.user.role === 'genitore') {
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
type EsitoClassi =
    | { ok: true; mancanti: string[] }
    | { ok: false; errore: unknown };

async function classiMancantiNellaSede(
    supabase: SupabaseAdmin,
    scuolaId: string,
    classi: string[],
): Promise<EsitoClassi> {
    const { data, error } = await supabase
        .from('sections')
        .select('name')
        .eq('scuola_id', scuolaId)
        .in('name', classi);
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe «nessuna classe trovata», cioè un 400 che accusa l'operatore
    // di un errore che non ha commesso.
    if (error) return { ok: false, errore: error };
    const presenti = new Set(
        (data ?? []).map((r) => String((r as { name?: unknown }).name ?? '')),
    );
    return { ok: true, mancanti: classi.filter((c) => !presenti.has(c)) };
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
        const gruppo = ['admin', 'coordinator'].includes(ruolo) ? 'admin' : 'teacher';
        const avvisiCfg = await getModuleConfig<{ ruoli_pubblicazione: string[] }>(
            supabase, 'avvisi_config', scuolaId,
        );
        const abilitati = avvisiCfg.ruoli_pubblicazione ?? ['admin'];
        if (!abilitati.includes(gruppo)) {
            return NextResponse.json(
                { error: 'La pubblicazione di avvisi è riservata alla segreteria (vedi Impostazioni → Avvisi)' },
                { status: 403 },
            );
        }

        // M8: 'classe' senza classi VALIDE → 400 (per TUTTI i ruoli). Niente più
        // degradazione implicita a globale: notifica e feed coincidono sempre.
        const classiTarget = Array.isArray(target_classes)
            ? [...new Set((target_classes as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== ''))]
            : [];
        if ((target_scope ?? 'globale') === 'classe' && classiTarget.length === 0) {
            return NextResponse.json(
                { error: 'Seleziona almeno una classe destinataria per un avviso di classe.' },
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
                    { error: 'Verifica delle classi destinatarie non riuscita' },
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
            attachment_url: attachment_url ?? null,
            form_model_id: form_model_id ?? null,
            scuola_id: scuolaId, // tenant
        };
        let insRes = await supabase.from('avvisi').insert(avvisoRecord).select().single();
        let attempts = 0;
        while (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '') && attempts < 4) {
            const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(insRes.error.message);
            const col = m?.[1] ?? m?.[2];
            if (!col || !(col in avvisoRecord)) break;
            delete avvisoRecord[col];
            insRes = await supabase.from('avvisi').insert(avvisoRecord).select().single();
            attempts++;
        }
        const { data, error } = insRes;

        if (error) {
            logErrore({ operazione: 'avvisi:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: (data as { id?: string })?.id ?? null,
            azione: 'insert', scuolaId,
            valoreDopo: { id: (data as { id?: string })?.id, titolo, target_scope },
        });

        // Notifica ai genitori destinatari (best-effort). UN solo enqueue con
        // tipo per priorità: modulo firmabile > richiesta adesione > avviso.
        try {
            const globale = (target_scope ?? 'globale') === 'globale';
            const destinatari = globale
                ? await genitoriDiScuola(supabase, scuolaId)
                : await genitoriDiClassi(supabase, scuolaId, classiTarget);
            const tipoNotifica = form_model_id
                ? 'modulo_da_compilare'
                : (tipo === 'adesione' ? 'consenso_uscita' : 'avviso');
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

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'avvisi:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
