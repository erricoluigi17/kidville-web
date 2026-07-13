import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { getModuleConfig } from '@/lib/settings/module-config';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// Uuid opzionale da query string: stringa vuota trattata come assente
// (preserva i check truthy `if (parentId)` / `if (studentId)` pre-esistenti).
const zUuidQueryOpzionale = z.preprocess(
    (v) => (v === '' ? undefined : v),
    zUuid.optional()
);

const getQuerySchema = z.object({
    scope: z.string().optional(),
    classe: z.string().optional(),
    parentId: zUuidQueryOpzionale,
    studentId: zUuidQueryOpzionale,
});

const postBodySchema = z.object({
    author_id: zUuid,
    titolo: z.string().min(1, 'author_id, titolo e contenuto sono obbligatori'),
    contenuto: z.string().min(1, 'author_id, titolo e contenuto sono obbligatori'),
    tipo: z.string().nullish(),
    target_scope: z.string().nullish(),
    target_classes: z.unknown().optional(),
    scadenza: z.string().nullish(),
    attachment_url: z.string().nullish(),
    // Modulo firmabile FEA collegato (gita): opzionale (item 19).
    form_model_id: zUuid.nullish(),
});

// GET /api/avvisi?scope=globale|classe&classe=xxx&parentId=xxx
// Lista avvisi con filtri
export const GET = withRoute('avvisi:GET', async (request: Request) => {
    try {
        // Il ramo (staff vs genitore) si decide sul valore grezzo di parentId,
        // così il gate auth resta PRIMA della validazione (come oggi).
        const parentIdGrezzo = new URL(request.url).searchParams.get('parentId');

        const supabase = await createAdminClient();

        // Ramo STAFF (no parentId): gate ruolo + isolamento per plesso.
        // Ramo GENITORE (?parentId): resta aperto (scoping per classe del figlio).
        let plessiScope: string[] | null = null;
        if (!parentIdGrezzo) {
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            plessiScope = await scuoleDiUtente(supabase, auth.user);
            if (plessiScope.length === 0) return NextResponse.json([]);
        }

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { scope, classe, parentId, studentId } = q.data;

        const baseCols = 'id, author_id, titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url, created_at';
        const buildQuery = (cols: string) => {
            let query = supabase.from('avvisi').select(cols).order('created_at', { ascending: false });
            if (plessiScope) query = query.in('scuola_id', plessiScope);
            if (scope) query = query.eq('target_scope', scope);
            return query;
        };
        // Prova con form_model_id (item 19); se la colonna manca (DB E2E CI non
        // migrato) PostgREST torna 42703/PGRST204 → riprova senza.
        let res = await buildQuery(`${baseCols}, form_model_id`);
        if (res.error && ['PGRST204', '42703'].includes((res.error as { code?: string }).code ?? '')) {
            res = await buildQuery(baseCols);
        }
        if (res.error) {
            logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, res.error);
            return NextResponse.json({ error: res.error.message }, { status: 500 });
        }
        const avvisi = (res.data ?? []) as unknown as Array<{
            id: string; author_id: string; titolo: string; contenuto: string;
            tipo: string | null; target_scope: string | null; target_classes: string[] | null;
            scadenza: string | null; attachment_url: string | null; created_at: string;
            form_model_id?: string | null;
        }>;

        // Filtra lato server per la classe se specificata
        let filtered = avvisi ?? [];
        if (classe) {
            filtered = filtered.filter(a =>
                a.target_scope === 'globale' ||
                (a.target_classes && a.target_classes.includes(classe))
            );
        }

        // Filtra per scadenza solo se è un genitore (parentId presente)
        if (parentId) {
            const todayStr = new Date().toISOString().split('T')[0];
            filtered = filtered.filter(a => !a.scadenza || a.scadenza >= todayStr);
        }

        // Arricchisci con conteggi risposte e info autore
        const enriched = await Promise.all(
            filtered.map(async (avviso) => {
                // Conta risposte
                const { count: lettiCount } = await supabase
                    .from('avvisi_risposte')
                    .select('*', { count: 'exact', head: true })
                    .eq('avviso_id', avviso.id)
                    .not('letto_il', 'is', null);

                const { count: adesioni_si } = await supabase
                    .from('avvisi_risposte')
                    .select('*', { count: 'exact', head: true })
                    .eq('avviso_id', avviso.id)
                    .eq('risposta', 'si');

                const { count: adesioni_no } = await supabase
                    .from('avvisi_risposte')
                    .select('*', { count: 'exact', head: true })
                    .eq('avviso_id', avviso.id)
                    .eq('risposta', 'no');

                // Info autore
                const { data: author } = await supabase
                    .from('utenti')
                    .select('nome, cognome, ruolo, first_name, last_name, role')
                    .eq('id', avviso.author_id)
                    .maybeSingle();

                // Se è un genitore, controlla se ha letto
                let myResponse = null;
                if (parentId) {
                    let rQuery = supabase
                        .from('avvisi_risposte')
                        .select('letto_il, risposta, risposto_il')
                        .eq('avviso_id', avviso.id)
                        .eq('parent_id', parentId);

                    if (studentId) {
                        rQuery = rQuery.eq('student_id', studentId);
                    }

                    const { data: resp } = await rQuery.limit(1).maybeSingle();
                    myResponse = resp;
                }

                return {
                    ...avviso,
                    author: author ? {
                        first_name: author.first_name || author.nome || '?',
                        last_name: author.last_name || author.cognome || '?',
                        role: author.role || author.ruolo || 'unknown',
                    } : { first_name: '?', last_name: '?', role: 'unknown' },
                    stats: {
                        letti: lettiCount ?? 0,
                        adesioni_si: adesioni_si ?? 0,
                        adesioni_no: adesioni_no ?? 0,
                    },
                    my_response: myResponse,
                };
            })
        );

        return NextResponse.json(enriched);
    } catch (error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// POST /api/avvisi
// Body: { author_id, titolo, contenuto, tipo, target_scope, target_classes?, scadenza?, attachment_url? }
export const POST = withRoute('avvisi:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { author_id, titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url, form_model_id } = b.data;

        const supabase = await createAdminClient();

        // Ruoli abilitati alla pubblicazione, configurabili da Impostazioni → Avvisi.
        const { data: autore } = await supabase
            .from('utenti')
            .select('id, role, ruolo, scuola_id')
            .eq('id', author_id)
            .maybeSingle();
        const ruolo = (autore?.role || autore?.ruolo || '').toLowerCase();
        const gruppo = ['admin', 'coordinator'].includes(ruolo) ? 'admin' : 'teacher';
        const avvisiCfg = await getModuleConfig<{ ruoli_pubblicazione: string[] }>(
            supabase, 'avvisi_config', autore?.scuola_id
        );
        const abilitati = avvisiCfg.ruoli_pubblicazione ?? ['admin'];
        if (!abilitati.includes(gruppo)) {
            return NextResponse.json(
                { error: 'La pubblicazione di avvisi è riservata alla segreteria (vedi Impostazioni → Avvisi)' },
                { status: 403 }
            );
        }

        // Insert resiliente alla colonna mancante: su DB E2E CI privo della
        // migrazione 20260708174440 (form_model_id) → PGRST204/42703 → la rimuove
        // e riprova. In prod la colonna esiste → nessun retry.
        const avvisoRecord: Record<string, unknown> = {
            author_id,
            titolo,
            contenuto,
            tipo: tipo ?? 'presa_visione',
            target_scope: target_scope ?? 'globale',
            target_classes: target_classes ?? null,
            scadenza: scadenza ?? null,
            attachment_url: attachment_url ?? null,
            form_model_id: form_model_id ?? null,
            scuola_id: autore?.scuola_id ?? auth.user.scuola_id ?? null, // tenant
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
            azione: 'insert', scuolaId: autore?.scuola_id ?? auth.user.scuola_id ?? null,
            valoreDopo: { id: (data as { id?: string })?.id, titolo, target_scope },
        });

        // Notifica ai genitori destinatari (best-effort). UN solo enqueue con
        // tipo per priorità: modulo firmabile > richiesta adesione > avviso —
        // avviso, consenso e modulo sono lo stesso evento, mai doppioni.
        try {
            const scuolaId = (autore?.scuola_id ?? auth.user.scuola_id ?? null) as string | null;
            const classiTarget = Array.isArray(target_classes) ? (target_classes as string[]).filter(Boolean) : [];
            const globale = (target_scope ?? 'globale') === 'globale' || classiTarget.length === 0;
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
