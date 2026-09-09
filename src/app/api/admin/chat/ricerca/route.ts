import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD, zOpzionale, zLimite } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { schemaAssente } from '@/lib/news/schema-assente';
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit';

// GET /api/admin/chat/ricerca?q=&da=&a=&scuolaId=&limite=
//
// Cerca una parola nel TESTO di tutte le conversazioni genitore↔insegnante della
// sede attiva. È il gesto più invasivo della vigilanza — attraversa ogni
// conversazione in una volta, non una sola — e per questo si registra col
// termine cercato, e si rifiuta se non lo si riesce a registrare.
//
// Il filtro di sede vive dentro l'SQL, nella funzione `chat_vigilanza_ricerca`:
// `chat_threads` non ha `scuola_id` e la sede si deriva dall'alunno, quindi da
// PostgREST servirebbe un `.in('thread_id', […])` con 409 uuid — ~15 KB di query
// string — oppure un filtro in JavaScript dopo aver letto tutto, che è
// esattamente ciò che `isolamento-sede-coverage` vieta.
//
// ⚠️ Il parametro si chiama `q` e NON va rinominato in `tipo`, `stato`, `esito` o
// `azione`: quelle chiavi sono nella lista bianca di `@/lib/logging/redact`, e il
// termine cercato — che può essere il nome di un bambino o un'allergia —
// uscirebbe IN CHIARO in `app_log` attraverso il payload che `parseQuery`
// deposita nel contesto. Sotto `q` esce `[redatto:str/N]`.
const getQuerySchema = z.object({
  q: z.string().min(3, 'Cerca almeno tre caratteri').max(200, 'Testo di ricerca troppo lungo'),
  da: zOpzionale(zDataYMD),
  a: zOpzionale(zDataYMD),
  scuolaId: zOpzionale(zUuid),
  limite: zLimite({ predefinito: 50, max: 200 }),
});

interface RigaRicerca {
  messaggio_id: string;
  thread_id: string;
  contenuto: string;
  creato_il: string;
  mittente_id: string;
  docente_id: string;
  genitore_id: string;
  alunno_id: string;
  alunno_nome: string;
  classe: string | null;
  scuola_id: string;
}

export const GET = withRoute('admin/chat/ricerca:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const supabase = await createAdminClient();

    const attive = await resolveScuoleAttive(request, supabase, auth.user);
    // `restringiSedi` distingue i due vuoti: `[]` è «non hai plessi», `null` è
    // «hai chiesto un plesso che non è tuo». Il primo non è un errore, il secondo sì.
    const scope = restringiSedi(attive, q.data.scuolaId);
    if (!scope) return rifiutoSede('SEDE_NON_ACCESSIBILE');
    if (scope.length === 0) {
      return NextResponse.json({ success: true, data: [], totale: 0 });
    }

    const { data, error } = await supabase.rpc('chat_vigilanza_ricerca', {
      p_scuola_ids: scope,
      p_termine: q.data.q,
      p_da: q.data.da ? `${q.data.da}T00:00:00.000Z` : null,
      // L'estremo destro è ESCLUSIVO nella funzione (`created_at < p_a`): si passa
      // la mezzanotte del giorno DOPO, così «al 9 settembre» comprende il 9.
      p_a: q.data.a ? `${q.data.a}T00:00:00.000Z` : null,
      p_limite: q.data.limite,
    });

    if (error) {
      // Sul DB E2E della CI la funzione non esiste (PGRST202): elenco vuoto, non 500.
      if (schemaAssente(error)) {
        return NextResponse.json({ success: true, disponibile: false, data: [], totale: 0 });
      }
      // PostgREST non lancia: il `catch` sotto non vede questo ramo (AGENTS §7).
      logErrore({ operazione: 'admin/chat/ricerca:GET', stato: 500, evento: 'db' }, error);
      return NextResponse.json(
        { error: 'La ricerca non è riuscita. Riprova fra poco.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      );
    }

    const righe = (data ?? []) as RigaRicerca[];

    // ── Il registro PRIMA della risposta, e bloccante ────────────────────────
    // Qui la riga si scrive DOPO la query e non prima, ed è l'unica volta: fino a
    // questo punto la funzione ha prodotto un CONTEGGIO in memoria, nessun testo
    // ha lasciato il server. Registrare prima vorrebbe dire scrivere «ha cercato»
    // anche quando la ricerca fallisce, cioè sovra-registrare.
    const { tracciato } = await registraAccessoVigilanza(supabase, {
      operatore: auth.user,
      azione: 'ricerca',
      // La sede è una sola quando il filtro è esplicito; con più sedi attive si
      // registra quella dei risultati se è unica, altrimenti resta nulla — meglio
      // vuota che arbitraria.
      scuolaId: scope.length === 1 ? scope[0] : null,
      nMessaggi: righe.length,
      termine: q.data.q,
      request,
    });
    if (!tracciato) {
      return NextResponse.json(
        {
          error: 'La ricerca non si è potuta registrare: i risultati non vengono mostrati.',
          codice: 'VIGILANZA_NON_TRACCIABILE',
        },
        { status: 503 },
      );
    }

    return NextResponse.json({ success: true, data: righe, totale: righe.length });
  } catch (err) {
    logErrore({ operazione: 'admin/chat/ricerca:GET', stato: 500 }, err);
    return NextResponse.json(
      { error: 'La ricerca non è riuscita. Riprova fra poco.', codice: 'LETTURA_FALLITA' },
      { status: 500 },
    );
  }
});
