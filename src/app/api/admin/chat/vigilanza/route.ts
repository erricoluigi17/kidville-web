import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { RUOLI_DIREZIONE } from '@/lib/auth/predicati-ruolo';
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD, zOpzionale, zLimite } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { schemaAssente } from '@/lib/news/schema-assente';

// GET /api/admin/chat/vigilanza?operatoreId=&threadId=&azione=&da=&a=&limite=&offset=
//
// Il registro delle letture di vigilanza sulle conversazioni genitore↔insegnante.
//
// ⚠️ IL GATE È PIÙ STRETTO DI QUELLO DELLA VIGILANZA STESSA, ED È IL PUNTO.
// Le conversazioni le può leggere anche la `segreteria` (`requireStaff` con la
// lista predefinita). Il registro di CHI le ha lette no: lo legge solo la
// Direzione. La segreteria è la parte sorvegliata, e un controllore che consulta
// il registro di sé stesso non è un controllo. Nessuna esenzione al contrario:
// anche le letture della Direzione stanno in questo elenco.
const getQuerySchema = z.object({
  operatoreId: zOpzionale(zUuid),
  threadId: zOpzionale(zUuid),
  azione: zOpzionale(z.enum(['lettura', 'ricerca'])),
  da: zOpzionale(zDataYMD),
  a: zOpzionale(zDataYMD),
  scuolaId: zOpzionale(zUuid),
  limite: zLimite({ predefinito: 100, max: 500 }),
  offset: z.coerce.number().int().min(0).default(0),
});

interface RigaRegistro {
  id: string;
  operatore_id: string;
  operatore_ruolo: string;
  azione: string;
  esito: string;
  thread_id: string | null;
  alunno_id: string | null;
  scuola_id: string | null;
  n_messaggi: number | null;
  termine: string | null;
  ip: string | null;
  letto_il: string;
}

const nomeDi = (u?: { nome?: string | null; cognome?: string | null }) =>
  `${u?.cognome ?? ''} ${u?.nome ?? ''}`.trim() || '—';

export const GET = withRoute('admin/chat/vigilanza:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request, RUOLI_DIREZIONE);
  if (auth.response) return auth.response;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const supabase = await createAdminClient();

    const attive = await resolveScuoleAttive(request, supabase, auth.user);
    const scope = restringiSedi(attive, q.data.scuolaId);
    if (!scope) return rifiutoSede('SEDE_NON_ACCESSIBILE');
    if (scope.length === 0) return NextResponse.json({ success: true, data: [], totale: 0 });

    // Il filtro di sede è DIRETTO sulla colonna, non su un join con `alunni`: è
    // ciò che si compra con `scuola_id` congelato alla scrittura. Una lettura
    // fatta a Giugliano resta nel registro di Giugliano anche se il bambino
    // viene poi trasferito.
    let query = supabase
      .from('chat_vigilanza_accessi')
      .select(
        'id, operatore_id, operatore_ruolo, azione, esito, thread_id, alunno_id, scuola_id, n_messaggi, termine, ip, letto_il',
        { count: 'exact' },
      )
      .in('scuola_id', scope)
      .order('letto_il', { ascending: false })
      .range(q.data.offset, q.data.offset + q.data.limite - 1);

    if (q.data.operatoreId) query = query.eq('operatore_id', q.data.operatoreId);
    if (q.data.threadId) query = query.eq('thread_id', q.data.threadId);
    if (q.data.azione) query = query.eq('azione', q.data.azione);
    if (q.data.da) query = query.gte('letto_il', `${q.data.da}T00:00:00.000Z`);
    // Estremo destro INCLUSIVO sul giorno: si confronta con la fine della giornata.
    if (q.data.a) query = query.lte('letto_il', `${q.data.a}T23:59:59.999Z`);

    const { data, error, count } = await query;
    if (error) {
      // Sul DB E2E della CI la tabella non esiste: elenco vuoto, non 500.
      if (schemaAssente(error)) {
        return NextResponse.json({ success: true, disponibile: false, data: [], totale: 0 });
      }
      logErrore({ operazione: 'admin/chat/vigilanza:GET', stato: 500, evento: 'db' }, error);
      return NextResponse.json(
        { error: 'Il registro non si è potuto leggere. Riprova fra poco.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      );
    }

    const righe = (data ?? []) as RigaRegistro[];

    // Arricchimento in DUE query batched, mai una per riga.
    const operatoriIds = [...new Set(righe.map((r) => r.operatore_id).filter(Boolean))];
    const alunniIds = [...new Set(righe.map((r) => r.alunno_id).filter(Boolean) as string[])];
    const [{ data: utenti }, { data: alunni }] = await Promise.all([
      operatoriIds.length
        ? supabase.from('utenti').select('id, nome, cognome').in('id', operatoriIds)
        : Promise.resolve({ data: [] as { id: string; nome?: string; cognome?: string }[] }),
      alunniIds.length
        ? supabase.from('alunni').select('id, nome, cognome, classe_sezione').in('id', alunniIds)
        : Promise.resolve({ data: [] as { id: string; nome?: string; cognome?: string; classe_sezione?: string | null }[] }),
    ]);
    const uMap = new Map((utenti ?? []).map((u) => [u.id, u]));
    const aMap = new Map((alunni ?? []).map((a) => [a.id, a]));

    const arricchite = righe.map((r) => ({
      id: r.id,
      lettoIl: r.letto_il,
      azione: r.azione,
      esito: r.esito,
      operatore: { id: r.operatore_id, nome: nomeDi(uMap.get(r.operatore_id)), ruolo: r.operatore_ruolo },
      threadId: r.thread_id,
      alunno: r.alunno_id
        ? { nome: nomeDi(aMap.get(r.alunno_id)), classe: aMap.get(r.alunno_id)?.classe_sezione ?? null }
        : null,
      scuolaId: r.scuola_id,
      nMessaggi: r.n_messaggi,
      termine: r.termine,
      ip: r.ip,
    }));

    return NextResponse.json({
      success: true,
      data: arricchite,
      totale: count ?? arricchite.length,
      limite: q.data.limite,
      offset: q.data.offset,
    });
  } catch (err) {
    logErrore({ operazione: 'admin/chat/vigilanza:GET', stato: 500 }, err);
    return NextResponse.json(
      { error: 'Il registro non si è potuto leggere. Riprova fra poco.', codice: 'LETTURA_FALLITA' },
      { status: 500 },
    );
  }
});
