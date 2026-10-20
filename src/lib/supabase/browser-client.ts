import { createBrowserClient } from '@supabase/ssr';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './public-config';
import { fetchConAttesaLimitata } from './attesa-ritentativi';

let supabaseInstance: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabase() {
    if (!supabaseInstance) {
        // Il `fetch` porta solo il tetto sull'attesa fra i tentativi di postgrest (fase 11 della
        // robustezza): senza, un 503 con `Retry-After` lungo lasciava la pagina a caricare minuti.
        supabaseInstance = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { fetch: fetchConAttesaLimitata() },
        });
    }
    return supabaseInstance;
}
