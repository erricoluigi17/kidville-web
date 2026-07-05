// Config PUBBLICA del progetto Supabase (URL + anon key).
//
// Questi due valori finiscono comunque nel bundle servito al browser: NON sono
// segreti. Li teniamo qui con un fallback hard-coded perché su Vercel le env
// `NEXT_PUBLIC_SUPABASE_*` si sono rivelate fragili (a volte non inlinate, a
// volte valorizzate con le chiavi di UN ALTRO progetto). Un URL/anon incoerenti
// tra client e server rompono la propagazione della sessione via cookie
// (`sb-<ref>-auth-token`): il client salva la sessione ma il middleware/le
// guardie non la riconoscono → loop di redirect al login.
//
// Usare SEMPRE questi export (client, server, middleware) garantisce che tutti
// puntino allo STESSO progetto. La env, se presente e valorizzata, ha la
// precedenza; altrimenti si usa il valore corretto del progetto.
//
// Il SERVICE_ROLE_KEY (segreto) NON è qui: resta letto da
// `process.env.SUPABASE_SERVICE_ROLE_KEY` (va configurato correttamente su Vercel).

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  'https://uimulkjyekgemjakmepp.supabase.co';

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbXVsa2p5ZWtnZW1qYWttZXBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTcwMjQsImV4cCI6MjA5MzMzMzAyNH0.n63CdfsBQ14_orSmnrYUdp4uu6JCBtsUnsMZJRy88iM';
