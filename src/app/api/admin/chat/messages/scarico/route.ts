import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope } from '@/lib/auth/scope';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { rispostaGuastoDb, rispostaGuastoGiaRegistrato } from '@/lib/db/guasto';
import { firmaAllegatiChat } from '@/lib/chat/allegati';
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit';

// POST /api/admin/chat/messages/scarico  { message_id }
//
// Lo SCARICO di una foto dalla supervisione della segreteria (scheda «Tutti» della pagina Messaggi).
// Risponde con un indirizzo FIRMATO e FRESCO della foto, e prima lascia la sua riga nel registro di
// vigilanza (`azione: 'scarico'`). Riservata allo staff.
//
// ⚠️ L'ORDINE È IL PUNTO. La vigilanza è silenziosa per decisione del titolare (2026-09-09): i due
// interlocutori non vedono niente, e `chat_vigilanza_accessi` è l'UNICO contrappeso. Portarsi via un file
// è più grave che leggerlo (`admin/chat/messages:GET`), quindi la riga si scrive PRIMA di firmare
// l'indirizzo e, se non si scrive, il file NON parte: 503 `VIGILANZA_NON_TRACCIABILE`, senza nessuna
// chiamata allo Storage. Se invece è la firma a fallire, la riga resta (lo scarico è stato chiesto e
// registrato) e si risponde 503 `FIRMA_NON_RIUSCITA`: preferibile a una firma fatta e non tracciata.
//
// Solo FOTO (`attachment_type = 'image'`): un documento dalla supervisione resta com'è oggi, fuori
// perimetro (decisione del 2026-11-03).
//
// Il registro: l'`INSERT` lo fa `registraAccessoVigilanza`; il `CHECK` di `azione` ammette `scarico` dalla
// migrazione `20261103131803_chat_vigilanza_azione_scarico.sql`, che applica l'integrazione al merge.
//
// Log: solo uuid ed enumerati. Mai l'indirizzo firmato, il percorso nel bucket o il nome del file.
const OPERAZIONE = 'admin/chat/messages/scarico:POST';

const postBodySchema = z.object({
  message_id: zUuid,
});

export const POST = withRoute('admin/chat/messages/scarico:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const b = await parseBody(request, postBodySchema);
  if ('response' in b) return b.response;

  try {
    const supabase = await createAdminClient();

    // 1. Il messaggio. Un guasto non è «messaggio non trovato».
    const { data: messaggio, error: errMessaggio } = await supabase
      .from('chat_messages')
      .select('id, thread_id, attachment_url, attachment_type')
      .eq('id', b.data.message_id)
      .maybeSingle();
    if (errMessaggio) return rispostaGuastoDb(OPERAZIONE, 'db:chat_messages', errMessaggio);
    if (!messaggio) {
      return NextResponse.json(
        { error: 'Il messaggio non è stato trovato. Riapri la conversazione e riprova.', codice: 'CHAT_MESSAGGIO_NON_TROVATO' },
        { status: 404 },
      );
    }

    // 2. Solo foto, e con un percorso da firmare. Prima di ogni altra lettura e prima del registro: un
    // documento non è uno scarico che questa route tracci, quindi non lascia nemmeno una riga.
    const percorso = typeof messaggio.attachment_url === 'string' ? messaggio.attachment_url.trim() : '';
    if (messaggio.attachment_type !== 'image' || percorso === '') {
      return NextResponse.json(
        { error: 'Questo allegato non è una foto: dalla supervisione si scaricano solo le foto.', codice: 'ALLEGATO_NON_FOTO' },
        { status: 400 },
      );
    }
    const threadId = messaggio.thread_id as string;

    // 3. La conversazione e il suo alunno: stesso schema di `admin/chat/messages:GET`.
    const { data: thread, error: errThread } = await supabase
      .from('chat_threads')
      .select('student_id')
      .eq('id', threadId)
      .maybeSingle();
    if (errThread) return rispostaGuastoDb(OPERAZIONE, 'db:chat_threads', errThread);
    if (!thread) {
      return NextResponse.json(
        { error: 'La conversazione non è stata trovata. Riaprila e riprova.', codice: 'CHAT_CONVERSAZIONE_NON_TROVATA' },
        { status: 404 },
      );
    }
    const alunnoId = thread.student_id as string;

    // 4. Isolamento per sede. `message_id` è un uuid preso dalla richiesta: senza questa verifica bastava
    // conoscerlo per scaricare la foto di una conversazione di un'altra sede. Un tentativo fuori sede si
    // REGISTRA (il gate ha già identificato la persona), ma non è bloccante: si sta già negando.
    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId);
    if (fuoriScope) {
      await registraAccessoVigilanza(supabase, {
        operatore: auth.user,
        azione: 'scarico',
        esito: 'fuori-scope',
        threadId,
        alunnoId,
        request,
      });
      return fuoriScope;
    }

    // 5. La sede del bambino si legge ADESSO e si scrive nel registro (se domani viene trasferito, la riga
    // continua a dire dove stava). Un guasto non diventa «sede sconosciuta» in un registro che è l'unico
    // contrappeso: si ferma qui, prima di scrivere e prima di firmare.
    const { data: alunno, error: errAlunno } = await supabase
      .from('alunni')
      .select('scuola_id')
      .eq('id', alunnoId)
      .maybeSingle();
    if (errAlunno) return rispostaGuastoDb(OPERAZIONE, 'db:alunni', errAlunno);

    // 6. ── Il registro PRIMA della firma, e bloccante ────────────────────────────────────────────────
    const { tracciato } = await registraAccessoVigilanza(supabase, {
      operatore: auth.user,
      azione: 'scarico',
      threadId,
      alunnoId,
      scuolaId: (alunno?.scuola_id as string | null) ?? null,
      nMessaggi: 1,
      request,
    });
    if (!tracciato) {
      return NextResponse.json(
        {
          error: 'Lo scarico non si è potuto registrare: la foto non è stata scaricata.',
          codice: 'VIGILANZA_NON_TRACCIABILE',
        },
        { status: 503 },
      );
    }

    // 7. La firma, solo adesso e sul solo messaggio chiesto. In tabella c'è il PERCORSO nel bucket privato:
    // la supervisione riceve un indirizzo firmato a tempo, generato dietro a questo gate. `firmaAllegatiChat`
    // risponde con `attachment_url: null` quando non riesce (e il guasto è già nel suo log).
    const firmati = await firmaAllegatiChat(
      supabase,
      [{ id: messaggio.id as string, attachment_url: percorso }],
      OPERAZIONE,
    );
    const url = firmati[0]?.attachment_url ?? null;
    if (!url) {
      logEvento('chat', 'error', {
        operazione: OPERAZIONE,
        esito: 'scarico-firma-non-riuscita',
        thread_id: threadId,
        operatore_id: auth.user.id,
      });
      return NextResponse.json(
        { error: 'Non è stato possibile preparare il file. Riprova fra qualche minuto.', codice: 'FIRMA_NON_RIUSCITA' },
        { status: 503 },
      );
    }

    // Il successo si logga: senza, «nessun log» non distingue «nessuno ha scaricato» da «non è arrivato niente».
    logEvento('chat', 'info', {
      operazione: OPERAZIONE,
      esito: 'scarico-registrato',
      thread_id: threadId,
      operatore_id: auth.user.id,
    });
    return NextResponse.json({ success: true, url });
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err);
    return rispostaGuastoGiaRegistrato();
  }
});
