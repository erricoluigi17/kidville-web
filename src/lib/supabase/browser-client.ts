import { createBrowserClient } from '@supabase/ssr';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './public-config';

let supabaseInstance: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabase() {
    if (!supabaseInstance) {
        supabaseInstance = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabaseInstance;
}
