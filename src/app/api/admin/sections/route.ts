import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// ============================================================
// Anagrafica sezioni/classi — gated Segreteria+Direzione (DL-036) + audit (DL-037).
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    // Filtro eq su sections.scuola_id: uuid se presente ('' = nessun filtro, come prima).
    scuola_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
});

const postBodySchema = z.object({
    name: z.string().min(1, 'Il nome della sezione è obbligatorio'),
    // Grado scuola validato (niente valori spazzatura); se assente → 'infanzia' nel codice.
    school_type: z.preprocess(vuotoComeAssente, z.enum(['nido', 'infanzia', 'primaria']).nullish()),
    scuola_id: z.preprocess(vuotoComeAssente, zUuid.nullish()), // default sede principale nel codice
});

// ⚠️ ALLOWLIST ESPLICITA — niente `.loose()`, e la ragione è la più grave del
// lotto (audit 2026-07-31). Fino a quella data lo schema era
// `z.object({ id }).loose()` e l'handler faceva `const { id, ...updates } = b.data`:
// QUALUNQUE colonna era scrivibile, `scuola_id` compresa. Una PATCH
// `{ id: <sezione di Cesa>, scuola_id: <Giugliano> }` spostava la classe di
// plesso, e da quell'istante `assertSezioneInScope`, `assertClasseNomeInScope` e
// `sezioniVisibili` la consideravano legittimamente propria — insieme, per via
// dei join, a tutto ciò che vi è agganciato (alunni, registro, armadietto).
// Non era un IDOR: era la primitiva che DISARMA gli altri controlli.
// Qui si aggiornano solo il nome e il grado. Lo spostamento di una classe fra
// sedi non è un campo di form: sarebbe un trasferimento, e dovrebbe muovere
// anche gli alunni.
// id stringa libera e NON zUuid (nei test circolano id non-uuid): un id sconosciuto
// continua a fallire a DB, come prima.
const patchBodySchema = z.object({
    id: z.string().min(1, 'id è obbligatorio'), // sostituisce il 400 manuale
    name: z.string().min(1, 'Il nome della sezione non può essere vuoto').optional(),
    school_type: z.preprocess(vuotoComeAssente, z.enum(['nido', 'infanzia', 'primaria']).optional()),
});

/**
 * «Esiste già una classe con questo nome in QUESTA sede?»
 *
 * Il nome-classe è la chiave con cui agenda, registro, armadietto e
 * `assertClasseNomeInScope` risolvono una sezione (`.eq('name', …)`), e
 * l'invariante «unico dentro la sede» viveva solo nelle docstring: due click sul
 * pulsante «crea sezione» bastavano a creare due «2 ANNI» nello stesso plesso, e
 * da lì il filtro di sede non protegge più nessuno — i due `.limit(1)` senza
 * ORDER BY scelgono fra due gruppi di bambini diversi.
 *
 * Dal 2026-07-31 l'invariante è anche un indice unico (`sections_nome_per_sede`).
 * Questo controllo preventivo resta perché (a) dà un 409 leggibile invece di uno
 * SQLSTATE, e (b) il database E2E della CI NON è migrato: lì l'unico presidio è
 * questo. PostgREST non lancia: un errore di lettura NON si interpreta come
 * «nessun omonimo» — si nega, altrimenti un guasto di rete diventerebbe il
 * permesso di duplicare.
 */
async function nomeGiaUsatoNellaSede(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    scuolaId: string,
    nome: string,
    escludiId?: string,
): Promise<{ occupato: boolean } | { response: NextResponse }> {
    const { data, error } = await supabase
        .from('sections')
        .select('id')
        .eq('scuola_id', scuolaId)
        .eq('name', nome);
    if (error) {
        logEvento('db', 'error', { operazione: 'admin/sections', esito: 'controllo-omonimia-fallito' }, error);
        return { response: NextResponse.json({ error: 'Verifica del nome della classe non riuscita' }, { status: 500 }) };
    }
    return { occupato: (data ?? []).some((r) => r.id !== escludiId) };
}

/** 23505 = violazione di unicità: qui può essere solo `sections_nome_per_sede`. */
const NOME_DUPLICATO = 'Esiste già una classe con questo nome in questa sede';
function violazioneUnicita(error: { code?: string | null } | null): boolean {
    return error?.code === '23505';
}

// ============================================================
// GET /api/admin/sections — Lista sezioni
// ============================================================
export const GET = withRoute('admin/sections:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const scuolaId = q.data.scuola_id;
    try {
        const supabase = await createAdminClient();

        let query = supabase
            .from('sections')
            .select('*')
            .order('name', { ascending: true })
            .in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user));

        if (scuolaId) query = query.eq('scuola_id', scuolaId);

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data || []);
    } catch (err) {
        logErrore({ operazione: 'admin/sections:GET', stato: 500 }, err);
        return NextResponse.json(
            { error: (err instanceof Error && err.message) || 'Errore interno' },
            { status: 500 }
        );
    }
});

// ============================================================
// POST /api/admin/sections — Crea nuova sezione
// ============================================================
export const POST = withRoute('admin/sections:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    try {
        const supabase = await createAdminClient();

        const { name, school_type, scuola_id } = b.data;

        const sw = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id ?? undefined);
        if (sw.response) return sw.response;
        const sede = sw.scuolaId as string;

        const omonimia = await nomeGiaUsatoNellaSede(supabase, sede, name);
        if ('response' in omonimia) return omonimia.response;
        if (omonimia.occupato) {
            logEvento('multi_sede', 'warn', {
                operazione: 'admin/sections:POST',
                esito: 'nome-gia-usato-nella-sede',
                sede_id: sede,
                sezione: name,
            });
            return NextResponse.json({ error: NOME_DUPLICATO }, { status: 409 });
        }

        const record = {
            name,
            school_type: school_type || 'infanzia',
            scuola_id: sede,
        };

        const { data, error } = await supabase
            .from('sections')
            .insert(record)
            .select()
            .single();

        if (error) {
            // La corsa fra due click arriva fin qui: il controllo preventivo non
            // vede nulla, l'indice unico sì. Un 409 leggibile, non uno SQLSTATE.
            if (violazioneUnicita(error)) {
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/sections:POST',
                    esito: 'nome-duplicato-respinto-dal-vincolo',
                    sede_id: sede,
                });
                return NextResponse.json({ error: NOME_DUPLICATO }, { status: 409 });
            }
            logEvento('db', 'error', { operazione: 'admin/sections:POST', esito: 'insert-sezione-fallito', sede_id: sede }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'sezioni',
            entitaId: data?.id ?? null,
            azione: 'insert',
            scuolaId: record.scuola_id,
            valoreDopo: data,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (err) {
        logErrore({ operazione: 'admin/sections:POST', stato: 500 }, err);
        return NextResponse.json(
            { error: (err instanceof Error && err.message) || 'Errore interno' },
            { status: 500 }
        );
    }
});

// ============================================================
// PATCH /api/admin/sections — Aggiorna sezione
// ============================================================
export const PATCH = withRoute('admin/sections:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, patchBodySchema);
    if ('response' in b) return b.response;
    const { id } = b.data;
    // Costruito a mano dalle sole chiavi consentite: `...resto` rimetterebbe in
    // gioco tutto ciò che lo schema, un domani, aggiungesse.
    const updates: Record<string, unknown> = {};
    if (b.data.name !== undefined) updates.name = b.data.name;
    if (b.data.school_type !== undefined && b.data.school_type !== null) updates.school_type = b.data.school_type;
    if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Nessun campo aggiornabile: indicare name o school_type' }, { status: 400 });
    }
    try {
        const supabase = await createAdminClient();

        // Stato precedente: serve all'audit E al gate di sede. Il gate di ruolo
        // (`requireStaff` = anche segreteria) dice CHE COSA puoi fare, non SU
        // QUALE plesso: la sede la dice questa riga.
        const { data: prima, error: erroreLettura } = await supabase
            .from('sections')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (erroreLettura) {
            // PostgREST non lancia: senza questo controllo un guasto di lettura
            // proseguirebbe con `prima = null` e diventerebbe un 404 bugiardo.
            logEvento('db', 'error', { operazione: 'admin/sections:PATCH', esito: 'lettura-sezione-fallita' }, erroreLettura);
            return NextResponse.json({ error: 'Lettura della classe non riuscita' }, { status: 500 });
        }
        if (!prima) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 });

        const sede = (prima.scuola_id as string | null) ?? null;
        const plessi = await scuoleDiUtente(supabase, auth.user);
        if (!sede || !plessi.includes(sede)) {
            // Solo uuid e metadati: nessun nome di classe altrui nel log.
            logEvento('multi_sede', 'warn', {
                operazione: 'admin/sections:PATCH',
                esito: 'sezione-di-altra-sede',
                utente: auth.user.id,
                ruolo: auth.user.role,
            });
            return NextResponse.json(
                { error: 'Questa classe appartiene a un\'altra sede: selezionala nel menù delle sedi per modificarla.' },
                { status: 403 }
            );
        }

        // Rinomina: il nome resta unico DENTRO la sede della classe (mai quella
        // di chi scrive: le due possono differire per un admin multi-plesso).
        if (typeof updates.name === 'string' && updates.name !== prima.name) {
            const omonimia = await nomeGiaUsatoNellaSede(supabase, sede, updates.name, id);
            if ('response' in omonimia) return omonimia.response;
            if (omonimia.occupato) {
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/sections:PATCH',
                    esito: 'nome-gia-usato-nella-sede',
                    sede_id: sede,
                    sezione: updates.name,
                });
                return NextResponse.json({ error: NOME_DUPLICATO }, { status: 409 });
            }
        }

        const { data, error } = await supabase
            .from('sections')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            if (violazioneUnicita(error)) {
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/sections:PATCH',
                    esito: 'nome-duplicato-respinto-dal-vincolo',
                    sede_id: sede,
                });
                return NextResponse.json({ error: NOME_DUPLICATO }, { status: 409 });
            }
            logEvento('db', 'error', { operazione: 'admin/sections:PATCH', esito: 'update-sezione-fallito', sede_id: sede }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'sezioni',
            entitaId: id,
            azione: 'update',
            scuolaId: (data?.scuola_id as string) ?? null,
            valorePrima: prima ?? null,
            valoreDopo: updates,
        });

        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'admin/sections:PATCH', stato: 500 }, err);
        return NextResponse.json(
            { error: (err instanceof Error && err.message) || 'Errore interno' },
            { status: 500 }
        );
    }
});
