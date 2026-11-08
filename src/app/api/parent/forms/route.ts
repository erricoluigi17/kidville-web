import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami';
import { figliAttiviDi, idDeiFigli } from '@/lib/anno/visibilita-genitore';
import { rispostaGuastoGiaRegistrato } from '@/lib/db/guasto';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3/M4) ─────────────────────────────────────
// L'identità viene dal gate (requireUser: sessione, o header legacy finché
// ALLOW_HEADER_IDENTITY≠false). Il `parent_id` legacy in query è ignorato:
// nessun fallback demo (M4).
const getQuerySchema = z.object({});

export const GET = withRoute('parent/forms:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const parentId = auth.user.id;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const supabase = await createAdminClient();

    // 1. Recupera gli alunni collegati al genitore — unione runtime
    //    (`legame_genitori_alunni`) + anagrafica (`student_parents` via ponte
    //    `parents.auth_user_id`). Con la sola runtime i genitori arrivati dal
    //    form pubblico non vedevano NESSUN modulo da firmare: né l'autorizzazione
    //    all'uscita, né i consensi — e nessuno se ne accorgeva, perché una lista
    //    vuota è indistinguibile da «non c'è niente da firmare».
    //
    // PR 4.4: dove c'è lo schema dell'anno i bambini sono quelli attivi per la
    // funzione SQL, e il modulo li raggiunge per uuid di sezione nella sede della
    // frequenza. Il nome di classe resta per lo schema indietro: omonimo fra anni
    // e fra sedi, darebbe il modulo al bambino sbagliato. Un guasto non cade mai
    // sull'elenco largo: risponde errore come ogni lettura di questa route.
    const attivi = await figliAttiviDi(supabase, parentId);
    if (attivi.stato === 'guasto') return rispostaGuastoGiaRegistrato();
    const frequenze = attivi.stato === 'ok' ? attivi.righe : null;
    const studentIds = frequenze ? idDeiFigli(frequenze) : await getFigliDiGenitore(supabase, parentId);

    if (studentIds.length === 0) {
      return NextResponse.json([]);
    }

    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, scuola_id')
      .in('id', studentIds);

    if (studErr || !students) {
      return NextResponse.json({ error: studErr?.message || 'Errore nel caricamento degli alunni' }, { status: 500 });
    }

    // Sedi dei figli. Il genitore NON ha una sede propria (può avere figli in due
    // plessi): le sedi sono quelle dei suoi bambini, e sono l'unico perimetro
    // legittimo. Senza questo filtro i moduli venivano abbinati per SOLO NOME di
    // classe, e al genitore di Aversa comparivano quelli del «2 ANNI» di Cesa.
    // Con la funzione sono le sedi delle frequenze: un bambino può viverne due.
    const sediFigli = Array.from(new Set(
      frequenze ? frequenze.map(f => f.scuola_id) : students.map(s => s.scuola_id).filter(Boolean)
    ));

    // 2. Recupera i moduli (templates) assegnati a queste classi, nelle sole sedi
    //    in cui il genitore ha davvero un figlio.
    const { data: templates, error: tempErr } = await supabase
      .from('forms_templates')
      .select('*')
      .in('scuola_id', sediFigli)
      .eq('target_scope', 'class');

    if (tempErr || !templates) {
      return NextResponse.json({ error: tempErr?.message || 'Errore moduli' }, { status: 500 });
    }

    // A chi va il modulo. Il nome-classe da solo non basta più (è ambiguo fra sedi):
    // la query sopra ha già ristretto ai plessi dei figli, il confronto per nome
    // lavora dentro quel perimetro.
    const figliDelModulo = (t: { scuola_id: string; target_classes?: string[] | null; target_section_ids?: string[] | null }) =>
      students.filter(s => frequenze
        ? frequenze.some(f => f.alunno_id === s.id && f.scuola_id === t.scuola_id
            && !!f.section_id && (t.target_section_ids ?? []).includes(f.section_id))
        : (t.target_classes ?? []).includes(s.classe_sezione));

    // 3. Recupera le sottomissioni già effettuate da questo genitore
    const { data: submissions, error: subErr } = await supabase
      .from('forms_submissions')
      .select('form_id, student_id, is_signed, created_at, pdf_path')
      .eq('parent_id', parentId);

    if (subErr) {
      return NextResponse.json({ error: subErr.message }, { status: 500 });
    }

    // 4. Mappa lo stato di compilazione per ogni combinazione modulo-figlio
    const result: Array<Record<string, unknown>> = [];

    for (const temp of templates) {
      // Per ogni figlio a cui è destinato il modulo
      for (const student of figliDelModulo(temp)) {
        const sub = submissions?.find(s => s.form_id === temp.id && s.student_id === student.id);

        result.push({
          form_id: temp.id,
          title: temp.title,
          description: temp.description,
          form_type: temp.form_type ?? 'autorizzazione',
          fields: temp.fields,
          expiration_date: temp.expiration_date,
          student: {
            id: student.id,
            nome: student.nome,
            cognome: student.cognome,
            classe_sezione: student.classe_sezione
          },
          status: sub ? 'signed' : (temp.expiration_date && new Date(temp.expiration_date) < new Date() ? 'expired' : 'pending'),
          submission: sub ? {
            is_signed: sub.is_signed,
            created_at: sub.created_at,
            pdf_path: sub.pdf_path
          } : null
        });
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    logErrore({ operazione: 'parent/forms:GET', stato: 500 }, err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
})
