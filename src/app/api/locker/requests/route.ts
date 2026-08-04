import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, assertClasseNomeInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { tabellaMancante } from '@/lib/db/tolleranza-schema';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' nei query param equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    alunno_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
    classe_sezione: z.string().optional(),
    stato: z.string().optional(), // filtro libero, come prima (nessun enum imposto sul GET)
});

// Stessi valori ammessi del check manuale pre-esistente.
const patchBodySchema = z.object({
    id: zUuid,
    stato: z.enum(['acknowledged', 'fulfilled']),
});

// La tabella `locker_requests` può non esistere in alcuni ambienti — e in
// PRODUZIONE non esiste affatto (misurato il 2026-08-04: ci sono `armadietto` e
// `locker_config`, e nessuna migrazione crea `locker_requests`). In quel caso si
// degrada a vuoto invece di rispondere 500.
//
// ⚠️ `tabellaMancante` ARRIVA DA UN MODULO CONDIVISO e non si riscrive qui. La
// copia che stava in queste righe decideva col REGEX SUL MESSAGGIO
// (`/does not exist|schema cache|could not find/i`), e dentro quel regex ci
// cadeva anche `42703 "column … does not exist"`: una COLONNA mancante — cioè
// una migrazione applicata a metà su un database vivo — diventava «nessuna
// richiesta armadietto». Un genitore vedeva zero righe e nessuno sapeva perché.
// La discriminante è il CODICE, non la prosa: vedi `@/lib/db/tolleranza-schema`.

/**
 * Il 500 di una query fallita: **loggato per intero, raccontato per niente**.
 *
 * Qui c'era `NextResponse.json({ error: error.message })` in quattro punti, e
 * `error.message` di PostgREST è testo interno — nome dello schema, nome della
 * tabella, nome della colonna. È la stessa fuga già chiusa in
 * `src/app/api/diary/route.ts`, e va chiusa insieme al regex: prima il 42703
 * finiva nel ramo tollerato e non arrivava mai qui, ora ci arriva.
 */
function erroreDb(error: unknown, operazione: string): NextResponse {
    logErrore({ operazione, stato: 500, evento: 'db' }, error);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
}

// ============================================================
// GET /api/locker/requests
// Query:
//   ?alunno_id=<id>     → richieste per un alunno (genitore)
//   ?classe_sezione=<s> → richieste per tutta la sezione (insegnante)
//   ?stato=pending      → filtra per stato (opzionale)
// ============================================================
export const GET = withRoute('locker/requests:GET', async (request: NextRequest) => {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunno_id: alunnoId, classe_sezione: classeSezione, stato } = q.data;

        const supabase = await createAdminClient();

        if (alunnoId) {
            // Ramo per singolo alunno: gate identità (sessione), poi legame
            // genitore↔alunno al genitore e plesso+sezione a tutti gli altri
            // ruoli (dal 2026-07-31: prima lo staff di qualunque sede passava).
            const auth = await requireParentOfStudent(request, alunnoId);
            if (auth.response) return auth.response;

            let query = supabase
                .from('locker_requests')
                .select(`
                    *,
                    locker_catalog (id, nome, icona, unita),
                    alunni (id, nome, cognome)
                `)
                .eq('alunno_id', alunnoId)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) {
                if (tabellaMancante(error)) return NextResponse.json([]);
                return erroreDb(error, 'locker/requests:GET');
            }
            return NextResponse.json(data);

        } else if (classeSezione) {
            // Ramo docente/staff: gate ruolo + gate classe + isolamento per plesso.
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            const admin = await createAdminClient();

            // GATE per SEZIONE ASSEGNATA (R108) prima di leggere gli alunni:
            // `requireDocente` verifica il ruolo, non la classe. Educator → solo
            // le sezioni assegnate (decisione di prodotto del 2026-07-30).
            const scopeErr = await assertClasseNomeInScope(admin, auth.user, classeSezione, { soloSezioniAssegnate: true });
            if (scopeErr) return scopeErr;

            const plessi = await scuoleDiUtente(admin, auth.user);
            if (plessi.length === 0) return NextResponse.json([]);

            // Ottieni gli alunni della sezione (solo dei propri plessi)
            const { data: alunni } = await supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classeSezione)
                .eq('stato', 'iscritto')
                .in('scuola_id', plessi);

            if (!alunni || alunni.length === 0) return NextResponse.json([]);
            const ids = alunni.map(a => a.id);

            let query = supabase
                .from('locker_requests')
                .select(`
                    *,
                    locker_catalog (id, nome, icona, unita),
                    alunni (id, nome, cognome)
                `)
                .in('alunno_id', ids)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) {
                if (tabellaMancante(error)) return NextResponse.json([]);
                return erroreDb(error, 'locker/requests:GET');
            }
            return NextResponse.json(data);
        }

        return NextResponse.json(
            { error: 'Parametro alunno_id o classe_sezione richiesto' },
            { status: 400 }
        );
    } catch (err) {
        logErrore({ operazione: 'locker/requests:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// PATCH /api/locker/requests — Genitore "Preso in carico"
// Body: { id, stato: 'acknowledged' | 'fulfilled' }
// ============================================================
export const PATCH = withRoute('locker/requests:PATCH', async (request: NextRequest) => {
    try {
        // M9 — CAMBIO STATO = azione della scuola (presa in carico/evasione): gate
        // ruolo docente/staff. Gating prima del caricamento della riga per non
        // esporre nemmeno l'esistenza dell'id a un anonimo.
        //
        // E prima anche della LETTURA DEL CORPO (2026-08-02, F1): questo gate non ha
        // bisogno di nessun campo del body per decidere — a differenza dei cinque
        // `requireParentOfStudent(request, idDalCorpo)` del repo, che il corpo devono
        // averlo — quindi non c'era ragione perché un anonimo facesse deserializzare al
        // server un JSON prima di sentirsi dire 401.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, stato } = b.data;

        const supabase = await createAdminClient();

        // Carica la riga per ricavarne il contesto (alunno → sezione/plesso) e
        // applicare lo scope: un docente non tocca richieste fuori dalla sua sezione.
        const { data: riga, error: rigaErr } = await supabase
            .from('locker_requests')
            .select('id, alunno_id')
            .eq('id', id)
            .maybeSingle();
        if (rigaErr) {
            if (tabellaMancante(rigaErr)) return NextResponse.json({ ok: true, degraded: true });
            return erroreDb(rigaErr, 'locker/requests:PATCH');
        }
        if (!riga) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 });

        const scopeErr = await assertAlunnoInScope(supabase, auth.user, riga.alunno_id);
        if (scopeErr) return scopeErr;

        const updates: Record<string, unknown> = { stato };
        if (stato === 'acknowledged') {
            updates.preso_in_carico_il = new Date().toISOString();
        }

        const { data, error } = await supabase
            .from('locker_requests')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            if (tabellaMancante(error)) return NextResponse.json({ ok: true, degraded: true });
            return erroreDb(error, 'locker/requests:PATCH');
        }
        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'locker/requests:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
