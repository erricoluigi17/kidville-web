import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { sealDangerous } from '@/lib/security/seal';
import { requireEnv } from '@/lib/security/require-env';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { tabellaMancante } from '@/lib/db/tolleranza-schema';
import { svuotaOblio } from '@/lib/gdpr/oblio-registro';

const querySchema = z.object({}); // nessun parametro in ingresso

export const POST = withRoute('admin/wipe:POST', async (request: Request) => {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const missingEnv = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (missingEnv) return missingEnv;
    const q = parseQuery(request, querySchema);
    if ('response' in q) return q.response;
    // Factory STRUMENTATO, non `createClient` di supabase-js. Qui sopra c'è un ciclo di DELETE su
    // 25 tabelle il cui `try/catch` non scatta mai (PostgREST ritorna `{ error }`, non lancia): il
    // `fetch` strumentato è l'unica cosa che vede quei fallimenti — un wipe «riuscito» che ha
    // lasciato righe dietro di sé è il modo peggiore di sbagliare. Vedi
    // `src/lib/supabase/server-client.ts` e il lock
    // `__tests__/architecture/supabase-client-strumentato.test.ts`.
    const supabase = await createAdminClient();
    try {
        const tablesToClear = [
            'student_parents', 'legame_genitori_alunni', 'student_adults', 
            'delegates', 'delegati', 'student_documents', 'educator_sections',
            'eventi_diario', 'valutazioni', 'galleria_media', 'armadietto',
            'locker_inventory', 'locker_requests', 'locker_loads',
            'ticket_mensa', 'pagamenti', 'registro_modifiche', 'firme_documenti',
            'daily_routines', 'presenze', 'firme_docenti', 'registro_orario', 'note_disciplinari'
        ];

        // ─── UNA TABELLA È PULITA SE ALMENO UNA DELLE DUE DELETE È RIUSCITA ─────────
        // Dal 3.6 lo svuotamento passa da `svuotaOblio` (RPC `anno_oblio_svuota`, con la lista
        // delle 26 tabelle ammesse); il ripiego diretto, sul DB della CI senza la funzione, tiene le
        // due forme di prima (per `id` e per `created_at`): non tutte le tabelle hanno entrambe le
        // colonne, e su una delle due il filtro può cadere su una colonna che non c'è, ed è atteso.
        // PostgREST NON lancia: una tabella che nessuna forma ha svuotato finisce in `nonPulite` e
        // la risposta è 500. La sola tabella ASSENTE (l'elenco è storico) resta «saltata», `info`.
        const nonPulite: string[] = [];
        const svuota = async (table: string) => {
            const esito = await svuotaOblio(supabase, table, 'admin/wipe:POST');
            if (esito.ok) return;
            const errori = esito.errori;
            if (errori.some((e) => tabellaMancante(e as { code?: string } | null))) {
                logEvento('db', 'info', { operazione: 'admin/wipe:POST', esito: 'tabella-saltata', tabella: table }, errori[0]);
                return;
            }
            nonPulite.push(table);
            logEvento('db', 'error', { operazione: 'admin/wipe:POST', esito: 'tabella-non-svuotata', tabella: table }, errori[errori.length - 1]);
        };

        for (const table of tablesToClear) {
            try {
                await svuota(table);
            } catch (e) {
                // Un'eccezione vera (rete, tempo scaduto) non è una tabella assente: la tabella
                // resta da svuotare, e la risposta lo dice.
                nonPulite.push(table);
                logEvento('db', 'error', {
                    operazione: 'admin/wipe:POST',
                    esito: 'tabella-non-svuotata',
                    tabella: table,
                }, e);
            }
        }

        // Tre chiamate scritte per esteso, non un ciclo: il nome della tabella resta un letterale
        // che i lock di sede sanno leggere.
        await svuota('alunni');
        await svuota('parents');
        await svuota('adults');

        if (nonPulite.length > 0) {
            // `tabelle` porta i soli NOMI delle tabelle rimaste sporche: nessun dato di persona.
            return NextResponse.json(
                { success: false, error: 'Scrittura sul database non riuscita', codice: 'SCRITTURA_FALLITA', tabelle: nonPulite },
                { status: 500 }
            );
        }
        return NextResponse.json({ success: true, message: 'Wipe completed' });
    } catch (err) {
        logErrore({ operazione: 'admin/wipe:POST', stato: 500 }, err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
});
