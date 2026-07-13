import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
    role: z.string().optional(),
});

const postBodySchema = z.object({
    // La presenza della prima email resta verificata nell'handler (400 dedicato);
    // nessun vincolo di formato, come oggi.
    emails: z.array(z.string()).optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    scuola_id: z.string().nullable().optional(),
});

// GET /api/admin/adults?role=educator
// Returns staff from utenti table (adults table not available in public schema)
export const GET = withRoute('admin/adults:GET', async (request: NextRequest) => {
    // Gap auth segnalato in M3, chiuso in M9: anagrafica staff (nomi+email)
    // riservata allo staff di gestione.
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const role = q.data.role;

    try {
        const supabase = await createAdminClient();

        let query = supabase
            .from('utenti')
            .select('id, first_name, last_name, nome, cognome, ruolo, email, scuola_id')
            .in('ruolo', ['maestra', 'educator', 'admin', 'coordinator', 'coordinatore', 'insegnante']);

        if (role) {
            // Map role param to ruolo values
            const ruoloMap: Record<string, string[]> = {
                'educator': ['maestra', 'educator', 'insegnante'],
                'coordinator': ['coordinator', 'coordinatore'],
                'admin': ['admin'],
            };
            const ruoloValues = ruoloMap[role] || [role];
            query = supabase
                .from('utenti')
                .select('id, first_name, last_name, nome, cognome, ruolo, email, scuola_id')
                .in('ruolo', ruoloValues);
        }

        // Scope multi-sede: mai lista cross-tenant — filtra per i plessi attivi.
        query = query.in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user));

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        const normalized = (data ?? []).map(u => ({
            id: u.id,
            first_name: u.first_name || u.nome || '',
            last_name: u.last_name || u.cognome || '',
            role: u.ruolo || 'educator',
            emails: u.email ? [u.email] : [],
            scuola_id: u.scuola_id,
        }));

        return NextResponse.json(normalized);
    } catch (err: unknown) {
        logErrore({ operazione: 'admin/adults:GET', stato: 500 }, err);
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: 'Errore interno del server', details: msg }, { status: 500 });
    }
});

// POST /api/admin/adults
// Creates a new staff user in auth + utenti
export const POST = withRoute('admin/adults:POST', async (request: NextRequest) => {
    // Gap auth segnalato in M3, chiuso in M9: creava utenze staff (auth+utenti)
    // SENZA gate — privilege escalation. Riservato allo staff di gestione
    // (la creazione staff con RBAC completo resta su /api/admin/staff, P3.4a).
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const { emails, first_name, last_name, role, scuola_id } = b.data;

    try {
        const primaryEmail = emails && emails.length > 0 ? emails[0] : null;

        if (!primaryEmail) {
            return NextResponse.json({ error: 'Primary Email is required' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        // scuola_id: risolto dallo scope dell'admin (una sola sede per la scrittura).
        const sw = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id ?? undefined);
        if (sw.response) return sw.response;

        // 1. Crea l'utente in Auth
        const { data: authData, error: authError } = await supabase.auth.admin.inviteUserByEmail(primaryEmail, {
            data: { first_name, last_name, role }
        });

        if (authError) {
            return NextResponse.json({ error: authError.message }, { status: 400 });
        }

        const userId = authData.user.id;

        // 2. Inserisci in utenti
        const { data: utentiData, error: utentiError } = await supabase
            .from('utenti')
            .upsert({
                id: userId,
                email: primaryEmail,
                nome: first_name,
                cognome: last_name,
                first_name,
                last_name,
                ruolo: role || 'educator',
                scuola_id: sw.scuolaId,
                attivo: true,
            })
            .select()
            .single();

        if (utentiError) {
            console.error('Error creating utenti record:', utentiError);
            return NextResponse.json({ error: utentiError.message }, { status: 500 });
        }

        return NextResponse.json({
            ...utentiData,
            first_name: utentiData.first_name || utentiData.nome,
            last_name: utentiData.last_name || utentiData.cognome,
            role: utentiData.ruolo,
        }, { status: 201 });

    } catch (err: unknown) {
        logErrore({ operazione: 'admin/adults:POST', stato: 500 }, err);
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: 'Errore interno del server', details: msg }, { status: 500 });
    }
});
