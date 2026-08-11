import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
    role: z.string().optional(),
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

// ─────────────────────────────────────────────────────────────────────────────
// QUI STAVA `POST /api/admin/adults`. TOLTO IL 2026-08-11, con la sua scheda
// `AdultRegistryForm.tsx`. Chi sta per riscriverlo legga prima queste tre righe:
// da fuori sembrava «la rotta che crea un account del personale», e non lo era.
//
//  1. IRRAGGIUNGIBILE — il suo unico chiamante era `AdultRegistryForm.tsx`, che
//     nessuna pagina montava (`grep -rn AdultRegistryForm src/`, 11 agosto: solo
//     il file stesso). Zero utenti, zero chiamate, zero collaudi possibili.
//  2. ROTTO — faceva `upsert` su `utenti` scrivendo ANCHE `first_name`,
//     `last_name` e `role`, che lì sono `GENERATED ALWAYS AS (…) STORED`
//     (`nome`/`cognome`/`ruolo` sono le colonne vere). Postgres rifiuta con
//     `428C9` e la rotta rispondeva 500 — ma `inviteUserByEmail` era GIÀ passato:
//     ogni tentativo lasciava un account `auth.users` senza riga `utenti`.
//  3. PERICOLOSO SE RIPARATO ALLA CIECA — `role` era uno `z.string()` libero e il
//     gate è `requireStaff`, che comprende la segreteria. Sistemare solo il punto
//     2 avrebbe dato alla segreteria la creazione di un `admin`: una scalata di
//     privilegi servita da una rotta che, non funzionando, nessuno guardava.
//
// DOVE SI CREA DAVVERO UN ACCOUNT DEL PERSONALE, per chi era arrivato qui a
// farlo: `ensureStaffIdentity()` in `src/lib/auth/staff-identity.ts`. È l'unica
// funzione che apre un account `auth.users` (o riusa quello che c'è) e scrive la
// riga `utenti` con `nome`/`cognome`/`ruolo` — cioè le colonne VERE. Oggi la
// chiama l'approvazione delle candidature (`PATCH /api/admin/candidature-insegnanti`),
// e sarà la stessa strada per l'approvazione delle pratiche di `/anagrafica-personale`.
//
// NON `/api/admin/staff`: fino all'11 agosto queste righe ci mandavano, ed era
// falso. Misurato lo stesso giorno, quel modulo esporta soltanto `GET` e `PATCH`
// — legge e modifica account che esistono GIÀ, non ne crea nessuno. Un rimando
// sbagliato in un commento come questo è peggio del silenzio: chi lo segue trova
// una strada che non c'è, conclude che nessuna esiste e riscrive proprio la porta
// che qui si è chiusa.
//
// Il lock che tiene ferma questa decisione: `__tests__/api/admin-adults-senza-post.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────
