import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { getModuleConfig } from '@/lib/settings/module-config';
import { requireUser, requireDocente } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
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

// POST /api/avvisi
// Body: { titolo, contenuto, tipo?, target_scope?, target_classes?, scadenza?, attachment_url?, form_model_id? }
export const POST = withRoute('avvisi:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url, form_model_id } = b.data;

        // M7: l'autore è SEMPRE l'utente di sessione. `author_id` del client non esiste più.
        const authorId = auth.user.id;
        const scuolaId = auth.user.scuola_id ?? null;
        const ruolo = (auth.user.role || '').toLowerCase();

        const supabase = await createAdminClient();

        // Ruoli abilitati alla pubblicazione, configurabili da Impostazioni → Avvisi.
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

        // Insert resiliente alla colonna form_model_id mancante (DB E2E CI non migrato).
        const avvisoRecord: Record<string, unknown> = {
            author_id: authorId,
            titolo,
            contenuto,
            tipo: tipo ?? 'presa_visione',
            target_scope: target_scope ?? 'globale',
            target_classes: target_classes ?? null,
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
