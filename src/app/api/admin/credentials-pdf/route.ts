import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertParentInScope, assertUtenteInScope } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { requireEnv } from '@/lib/security/require-env';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff';

// GET /api/admin/credentials-pdf?key=<uuid>-<timestamp>.pdf
// Scarica il PDF credenziali dal bucket privato. Riservato allo staff (il link è
// consegnato nel centro notifiche della segreteria dopo la rigenerazione).
//
// ⚠️ DUE CONTROLLI, NON UNO (2026-09-03). La SEDE dice se quel destinatario è tuo;
// il RUOLO dice se la sua password è cosa tua. Sono domande diverse, e ad Aversa
// davano già risposte diverse: l'admin è nello stesso plesso della segreteria,
// quindi la sola sede non separava niente. Il gate di ruolo è lo STESSO di
// `admin/regenerate-credentials` — `puoRigenerareCredenzialiStaff` — perché due
// porte sulla stessa stanza si chiudono insieme o non si chiudono.
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
    .select('id, scuola_id, ruolo')
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

    /* ── LA STESSA REGOLA DI `regenerate-credentials`, e per la stessa ragione ──
     * Qui dentro c'è la password IN CHIARO. Chiudere il reset e lasciare aperto
     * il download non è chiudere: la chiave viaggia in una notifica, e una
     * notifica si inoltra, si legge su uno schermo condiviso, e resta nel centro
     * notifiche per sempre.
     *
     * Fino al 2026-09-03 l'unica difesa era la SEDE — e ad Aversa e a Giugliano
     * l'admin sta nello stesso plesso della segreteria, quindi la sede non
     * separava niente. La riserva sul ruolo non poteva vivere solo sull'altra
     * route: due porte sulla stessa stanza si chiudono insieme o non si chiudono.
     *
     * PRIMA del download, non dopo: un 403 su un file già letto sarebbe un
     * diniego a cose fatte.
     */
    const ruoloBersaglio = (utente.ruolo as string | null) ?? null;
    if (!puoRigenerareCredenzialiStaff(auth.user.role, ruoloBersaglio)) {
      // `warn` → persistito: è un segnale di sicurezza. Né l'uuid né il ruolo del
      // bersaglio: basta sapere che è successo, e a chi (AGENTS.md regola 8).
      logEvento('auth', 'warn', {
        tipo: 'credenziali-staff-riservate',
        azione: 'admin/credentials-pdf:GET',
        utente: auth.user.id,
        ruolo: auth.user.role,
      });
      return NextResponse.json(
        {
          error: 'Le credenziali di un account di Direzione si rigenerano dalla Direzione',
          codice: 'CREDENZIALI_STAFF_RISERVATE',
        },
        { status: 403 },
      );
    }

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
