import { createBrowserClient } from '@supabase/ssr';

// URL e anon key sono valori PUBBLICI del progetto Supabase: finiscono comunque
// nel bundle servito al browser, quindi non sono segreti. Li teniamo come
// fallback hard-coded perché su Vercel le variabili NEXT_PUBLIC_* possono
// arrivare vuote/non inlinate al build (es. se marcate "Sensitive"), lasciando
// il client senza configurazione e rompendo il login. Se la env è presente e
// valorizzata ha comunque la precedenza. Il SERVICE_ROLE_KEY (segreto) NON è qui.
const SUPABASE_URL =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    'https://uimulkjyekgemjakmepp.supabase.co';

const SUPABASE_ANON_KEY =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbXVsa2p5ZWtnZW1qYWttZXBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTcwMjQsImV4cCI6MjA5MzMzMzAyNH0.n63CdfsBQ14_orSmnrYUdp4uu6JCBtsUnsMZJRy88iM';

let supabaseInstance: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabase() {
    if (!supabaseInstance) {
        supabaseInstance = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabaseInstance;
}
