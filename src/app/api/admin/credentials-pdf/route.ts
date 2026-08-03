import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertParentInScope, assertUtenteInScope } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { requireEnv } from '@/lib/security/require-env';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// GET /api/admin/credentials-pdf?key=<uuid>-<timestamp>.pdf
// Scarica il PDF credenziali dal bucket privato. Riservato allo staff (il link è
// consegnato nel centro notifiche della segreteria dopo la rigenerazione).
//
// ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). Fino a oggi l'autorizzazione era delegata
// alla FORMA della chiave: la regex impediva il path traversal, e l'entropia di
// `<uuid>-<epoch_ms>` faceva il resto. È autorizzazione per oscurità, non
// controllo d'accesso — e i link vivono per sempre nel centro notifiche, quindi
// chi si sposta di sede continua a scaricare le credenziali (password IN CHIARO)
// dei genitori del plesso che ha lasciato. Ora la chiave viene DECOMPOSTA: la
// parte uuid è il destinatario, e da lì si risolve la sede.
//
// La regex è ora ancorata all'uuid (era `[0-9a-fA-F-]+`, che accettava qualunque
// sequenza di esadecimali e trattini): serve un uuid vero per poterci risolvere
// sopra un'identità.
const CHIAVE_PDF = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-\d+\.pdf$/;

const getQuerySchema = z.object({
  key: z.string().regex(CHIAVE_PDF, 'key non valida'),
});

export const GET = withRoute('admin/credentials-pdf:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;
  const key = q.data.key;
  // La regex ha già superato zod: il gruppo esiste. Il fallback c'è perché una
  // non-corrispondenza qui sarebbe un difetto silenzioso, e va negata.
  const targetId = CHIAVE_PDF.exec(key)?.[1] ?? null;
  if (!targetId) return NextResponse.json({ error: 'PDF non trovato' }, { status: 404 });

  // Factory STRUMENTATO (tetto di tempo + `{ error }` visibile anche quando il codice lo
  // ignora), non `createClient` di supabase-js. Qui si scarica un PDF con una password IN
  // CHIARO: se lo Storage accetta e tace, senza tetto la richiesta resta appesa e chi ha
  // premuto «scarica» non riceve né il file né un errore. Vedi
  // `src/lib/supabase/server-client.ts` e il lock
  // `__tests__/architecture/supabase-client-strumentato.test.ts`.
  //
  // Solo `SUPABASE_SERVICE_ROLE_KEY`: l'URL lo dà `public-config.ts`, che ha un ripiego.
  const missingEnv = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (missingEnv) return missingEnv;
  const admin = await createAdminClient();

  // Chi è il destinatario del PDF? La chiave è generata da
  // `admin/regenerate-credentials` come `${targetId}-${Date.now()}.pdf`, dove
  // `targetId` è `utenti.id` per lo staff e `parents.id` per un genitore. I due
  // insiemi sono disgiunti (un genitore ha un `utenti.id` diverso dal proprio
  // `parents.id`), quindi la discriminazione è per esistenza.
  const { data: utente, error: errUtente } = await admin
    .from('utenti')
    .select('id, scuola_id')
    .eq('id', targetId)
    .maybeSingle();
  if (errUtente) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe «non è staff» e si finirebbe sul ramo genitore.
    logErrore({ operazione: 'admin/credentials-pdf:GET', stato: 500, evento: 'db' }, errUtente);
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
  }

  let sedeTarget: string | null = null;
  if (utente) {
    const fuoriScope = await assertUtenteInScope(admin, auth.user, targetId);
    if (fuoriScope) return fuoriScope;
    sedeTarget = (utente.scuola_id as string | null) ?? null;
  } else {
    const { data: genitore, error: errParent } = await admin
      .from('parents')
      .select('id')
      .eq('id', targetId)
      .maybeSingle();
    if (errParent) {
      logErrore({ operazione: 'admin/credentials-pdf:GET', stato: 500, evento: 'db' }, errParent);
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
    }
    // Chiave che non corrisponde a nessuna identità: si nega PRIMA di toccare lo
    // storage. Senza destinatario non c'è sede, e senza sede non c'è permesso.
    if (!genitore) return NextResponse.json({ error: 'PDF non trovato' }, { status: 404 });
    const fuoriScope = await assertParentInScope(admin, auth.user, targetId);
    if (fuoriScope) return fuoriScope;
  }

  const { data, error } = await admin.storage.from('credenziali').download(key);
  if (error || !data) {
    if (error) logErrore({ operazione: 'admin/credentials-pdf:GET', stato: 404, evento: 'storage' }, error);
    return NextResponse.json({ error: 'PDF non trovato' }, { status: 404 });
  }

  // Il download di una password in chiaro è un accesso che deve restare a
  // registro: senza, «chi ha scaricato le credenziali di quel genitore» non è
  // una domanda a cui si può rispondere. `azione` ha solo insert/update/delete
  // (`AzioneScrittura`): `insert` significa qui «è stata registrata una nuova
  // riga di accesso», ed è il valore meno fuorviante dei tre.
  await logScrittura(admin, {
    attore: auth.user,
    entitaTipo: 'credenziali_pdf',
    entitaId: targetId,
    azione: 'insert',
    scuolaId: sedeTarget ?? auth.user.scuola_id ?? null,
    valoreDopo: { operazione: 'download', destinatario: utente ? 'staff' : 'genitore' },
  });

  return new NextResponse(data, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="credenziali-kidville.pdf"',
      'Cache-Control': 'no-store',
    },
  });
});
