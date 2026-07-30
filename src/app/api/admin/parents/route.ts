import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, assertParentInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { linkOrCreateParent } from '@/lib/anagrafiche/parents';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ============================================================
// Anagrafica genitori — gated Segreteria+Direzione (DL-036) + audit
// immutabile su ogni mutazione (DL-037).
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
    // '' oggi equivale a "nessun filtro" (truthy check nel codice): preservato.
    student_id: z.union([zUuid, z.literal('')]).optional(),
});

// POST — unica azione: `create_parent`. (La vecchia azione `invite` è stata
// rimossa: creava un auth.users orfano — nessun ponte, nessuna riga `utenti` —
// e nessuna UI la usava più; l'identità di accesso ora nasce completa dentro
// linkOrCreateParent, vedi S6bis.)
// `create_parent` spalma il resto del body nell'insert (...parentData):
// .loose() preserva le chiavi extra (fiscal_code, first_name, ecc.).
// I campi mappati a mano restano liberi: oggi accettano qualunque valore.
const postBodySchema = z
    .object({
        action: z.literal('create_parent'),
        // ''/null oggi saltano il collegamento allo studente: preservati.
        student_id: z.union([zUuid, z.literal('')]).nullish(),
        emails: z.unknown().optional(),
        phones: z.unknown().optional(),
        role: z.unknown().optional(),
        birth_nation: z.unknown().optional(),
        birth_place: z.unknown().optional(),
        birth_province: z.unknown().optional(),
        address: z.unknown().optional(),
        zip_code: z.unknown().optional(),
        residence_city: z.unknown().optional(),
    })
    .loose();

// Il body (meno id) viene spalmato in update(dataToUpdate): .loose() preserva le chiavi extra.
const patchBodySchema = z
    .object({
        id: zUuid, // obbligatorio (sostituisce il 400 manuale 'ID genitore mancante')
    })
    .loose();

export const GET = withRoute('admin/parents:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    try {
        const studentId = q.data.student_id;

        const supabase = await createAdminClient();

        // Isolamento per sede. `parents` non ha `scuola_id` e non deve averlo (un
        // genitore può avere figli in due sedi): lo scope passa dai FIGLI. Senza
        // questo, `select('*')` restituiva l'anagrafica completa dei genitori
        // delle tre sedi — codice fiscale, numero e percorso del documento
        // d'identità, indirizzo, telefoni, email.
        if (studentId) {
            // Chiesto per un alunno preciso: si verifica l'alunno, e il filtro
            // sul legame fa il resto.
            const fuoriScope = await assertAlunnoInScope(supabase, auth.user, studentId);
            if (fuoriScope) return fuoriScope;
            const { data, error } = await supabase
                .from('parents')
                .select('*, student_parents!inner (student_id)')
                .eq('student_parents.student_id', studentId);
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json(data);
        }

        // Elenco completo: si parte dagli alunni dei propri plessi e si risale ai
        // genitori. Tre query esplicite invece di un embed a due livelli: è la
        // forma che i test possono verificare davvero, e non dipende da come
        // PostgREST annida i filtri.
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);
        const { data: alunniScope, error: errAlunni } = await supabase
            .from('alunni')
            .select('id')
            .in('scuola_id', plessi);
        if (errAlunni) return NextResponse.json({ error: errAlunni.message }, { status: 500 });
        const alunniIds = (alunniScope ?? []).map((a) => a.id as string);
        if (alunniIds.length === 0) return NextResponse.json([]);

        const { data: legami, error: errLegami } = await supabase
            .from('student_parents')
            .select('parent_id')
            .in('student_id', alunniIds);
        if (errLegami) return NextResponse.json({ error: errLegami.message }, { status: 500 });
        const parentIds = [...new Set((legami ?? []).map((l) => l.parent_id as string))];
        if (parentIds.length === 0) return NextResponse.json([]);

        const { data, error } = await supabase.from('parents').select('*').in('id', parentIds);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'admin/parents:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

export const POST = withRoute('admin/parents:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const parsed = await parseBody(request, postBodySchema);
    if ('response' in parsed) return parsed.response;
    const body = parsed.data;
    try {
        const supabase = await createAdminClient();

        // Isolamento per sede sulla SCRITTURA: `student_id` arriva dal client, e
        // senza verifica si collegava (o si creava) un genitore su un bambino di
        // un'altra sede — con tanto di account e credenziali inviate per email.
        const studentIdBody = (body.student_id as string) || null;
        if (studentIdBody) {
            const fuoriScope = await assertAlunnoInScope(supabase, auth.user, studentIdBody);
            if (fuoriScope) return fuoriScope;
        }

        try {
            const { parentId, created, credenzialiEmail, identitaErrore } = await linkOrCreateParent(supabase, auth.user, {
                studentId: (body.student_id as string) || null,
                payload: body as Record<string, unknown>,
            });
            // L'esito dell'invio automatico delle credenziali NON resta silenzioso:
            // un fallimento diventa warning esplicito (con motivo) nella risposta.
            const warning = credenzialiEmail && !credenzialiEmail.inviata
                ? `Anagrafica salvata e account creato, ma email credenziali NON inviata a ${credenzialiEmail.email}: ${credenzialiEmail.errore ?? 'motivo sconosciuto'}. Usare "Rigenera credenziali" dopo aver risolto.`
                : identitaErrore
                    ? `Anagrafica salvata, ma account di accesso non creato: ${identitaErrore}`
                    : undefined;
            return NextResponse.json({
                success: true,
                parent_id: parentId,
                created,
                credenziali_email: credenzialiEmail ?? null,
                ...(warning ? { warning } : {}),
            });
        } catch (e) {
            logErrore({ operazione: 'admin/parents:POST', stato: 500 }, e);
            return NextResponse.json({ error: (e as Error).message }, { status: 500 });
        }
    } catch (err) {
        logErrore({ operazione: 'admin/parents:POST', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

export const PATCH = withRoute('admin/parents:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    const parsed = await parseBody(request, patchBodySchema);
    if ('response' in parsed) return parsed.response;
    try {
        const supabase = await createAdminClient();

        const { id, ...dataToUpdate } = parsed.data;

        // Isolamento per sede: senza questo si modificava l'anagrafica (CF,
        // documento, indirizzo, recapiti) di un genitore di un'altra sede
        // conoscendone l'uuid. Lo scope passa dai figli — vedi `assertParentInScope`.
        const fuoriScope = await assertParentInScope(supabase, auth.user, id as string);
        if (fuoriScope) return fuoriScope;

        // Stato precedente per l'audit.
        const { data: prima } = await supabase.from('parents').select('*').eq('id', id).maybeSingle();

        const updates: Record<string, unknown> = { ...dataToUpdate };
        let { data, error } = await supabase.from('parents').update(updates).eq('id', id).select();
        // Resilienza pre-migration: rimuove le colonne non ancora esistenti (42703) e riprova.
        let attempts = 0;
        while (error && (error as { code?: string }).code === '42703' && attempts < 6) {
            const col = /column "?([a-z_]+)"? of relation/i.exec(error.message)?.[1];
            if (!col || !(col in updates)) break;
            delete updates[col];
            ({ data, error } = await supabase.from('parents').update(updates).eq('id', id).select());
            attempts++;
        }

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'genitori',
            entitaId: id,
            azione: 'update',
            valorePrima: prima ?? null,
            valoreDopo: dataToUpdate,
        });

        return NextResponse.json({ success: true, data });
    } catch (err) {
        logErrore({ operazione: 'admin/parents:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
