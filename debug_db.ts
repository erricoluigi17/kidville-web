import { createAdminClient } from './src/lib/supabase/server-client';

async function debug() {
    const supabase = await createAdminClient();
    
    // PostgREST only exposes the public schema tables, so pg_tables cannot be queried directly.
    // Instead, we check which tables are queryable by trying to select from them:
        
    const tablesToTry = ['schools', 'utenti', 'alunni', 'eventi_diario', 'legame_genitori_alunni', 'valutazioni', 'galleria_media_v2', 'armadietto', 'ticket_mensa', 'pagamenti', 'adults', 'educator_sections', 'chat_threads', 'chat_messages', 'avvisi', 'avvisi_risposte', 'task_interni'];
    
    for (const table of tablesToTry) {
        const { error } = await supabase.from(table).select('*').limit(1);
        if (error) {
            console.log(`❌ Table '${table}' error:`, error.message);
        } else {
            console.log(`✅ Table '${table}' exists!`);
        }
    }
}

debug();






