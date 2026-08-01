import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth/require-staff';

/**
 * Sigilla un endpoint pericoloso (seed/wipe/debug/migrazioni applicative): l'endpoint
 * "non esiste" — 404 — e la richiesta muore prima di qualunque gate, di qualunque
 * lettura di configurazione e di qualunque connessione al database.
 *
 * ─── PERCHÉ NON PIÙ «SOLO IN PRODUZIONE» ────────────────────────────────────
 *
 * Fino al 2026-08-01 la condizione era `process.env.NODE_ENV === 'production'`: fuori dalla
 * produzione l'endpoint restava vivo, protetto dal solo `requireStaff(['admin'])`. Sembra
 * prudente, e in QUESTO repo è il contrario, per una ragione scritta in AGENTS.md e vera da
 * mesi: **il dev server locale gira in `development` e parla col database di PRODUZIONE**
 * (`.env.local`). È la configurazione normale di chi sviluppa qui, ed è l'unica in cui
 * questi endpoint erano raggiungibili — cioè il sigillo si apriva da solo proprio
 * nell'ambiente meno controllato.
 *
 * Il collaudo del 2026-07-31 (sicurezza W11) l'ha misurato: anonimo, genitore, segreteria
 * ed educator erano respinti, quindi il presidio reggeva, «ma il margine è un solo account
 * admin». E `admin/wipe:POST` cancella `pagamenti`, `presenze`, `eventi_diario`,
 * `valutazioni` e `galleria_media` — in produzione ci sono i dati di 152 minori veri.
 *
 * ─── L'UNICA ECCEZIONE, E PERCHÉ ────────────────────────────────────────────
 *
 * `NODE_ENV === 'test'`, cioè vitest: lì non esiste nessun database — i client Supabase
 * sono mock — e l'unica cosa che una prova può dimostrare è che il gate di ruolo esiste
 * ancora. Su Vercel `NODE_ENV` vale `production` e non è sovrascrivibile, quindi
 * l'eccezione non è raggiungibile da un deploy.
 *
 * Se un domani servisse davvero eseguirne uno contro un database di sviluppo VERO (che
 * oggi non esiste), la via è aggiungere qui un opt-in esplicito e documentarlo in
 * `docs/env.md` — non riaprire il default.
 *
 * Lock: `__tests__/api/seal-fail-closed.test.ts`.
 *
 * Uso:
 *   const sealed = await sealDangerous(request);
 *   if (sealed) return sealed;
 */
export async function sealDangerous(request: Request): Promise<NextResponse | null> {
  if (process.env.NODE_ENV !== 'test') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const auth = await requireStaff(request, ['admin']);
  return auth.response ?? null;
}
