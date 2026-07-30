import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertClasseNomeInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// form_id è forms_templates.id (PK uuid); class_name è la sezione (testo libero).
const getQuerySchema = z.object({
  form_id: zUuid,
  class_name: z.string().min(1, 'class_name è obbligatorio'),
});

export const GET = withRoute('admin/documents-merge:GET', async (request: NextRequest) => {
  try {
    // B1 — questo endpoint restituisce nome/cognome/CF/firme dell'intera classe:
    // dati di minori. La route usa service-role (RLS bypassata), quindi il gate
    // applicativo è l'unico presidio. Solo lo staff (pannello admin modulistica).
    // Il ruolo però non dice NIENTE sulla sede: lo scope di tenant è sotto.
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { form_id: formId, class_name: className } = q.data;

    const supabase = await createAdminClient();

    // 0. SCOPE DI SEDE — prima di qualunque lettura. `requireStaff` verifica il
    //    RUOLO, non il tenant: senza questo, una segreteria di Giugliano poteva
    //    chiedere una classe di Cesa e ottenere nome, cognome e CODICE FISCALE
    //    di quei bambini. Il nome-classe si risolve SOLO entro i propri plessi.
    const scopeErr = await assertClasseNomeInScope(supabase, auth.user, className);
    if (scopeErr) return scopeErr;

    // Difesa in profondità: il gate impedisce di nominare una classe altrui, ma
    // «2 ANNI» esiste sia ad Aversa sia a Cesa — con la sola `classe_sezione` la
    // query prenderebbe comunque gli OMONIMI dell'altra sede. Le sedi sono
    // quelle attive del SedeSelector (cookie), ri-validate contro le accessibili.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user);

    // 1. Carica il template del form
    const { data: template, error: tempErr } = await supabase
      .from('forms_templates')
      .select('*')
      .eq('id', formId)
      .maybeSingle();

    if (tempErr || !template) {
      // PostgREST non lancia: senza questa riga «template non trovato» e
      // «lettura fallita» sarebbero la stessa 404 muta.
      if (tempErr) logErrore({ operazione: 'admin/documents-merge:GET', stato: 404, evento: 'db' }, tempErr);
      return NextResponse.json({ error: 'Template del form non trovato' }, { status: 404 });
    }

    // 2. Carica gli alunni della classe — ristretti alle sedi consentite
    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, codice_fiscale')
      .eq('classe_sezione', className)
      .in('scuola_id', plessi);

    if (studErr || !students) {
      if (studErr) logErrore({ operazione: 'admin/documents-merge:GET', stato: 500, evento: 'db' }, studErr);
      return NextResponse.json({ error: 'Errore nel caricamento degli alunni' }, { status: 500 });
    }

    // 3. Carica le sottomissioni per questo form
    const { data: submissions, error: subErr } = await supabase
      .from('forms_submissions')
      .select('*')
      .eq('form_id', formId);

    if (subErr || !submissions) {
      if (subErr) logErrore({ operazione: 'admin/documents-merge:GET', stato: 500, evento: 'db' }, subErr);
      return NextResponse.json({ error: 'Errore nel caricamento delle sottomissioni' }, { status: 500 });
    }

    // 4. Mappa ogni alunno alla propria sottomissione
    const mergedData = students.map(student => {
      const submission = submissions.find(sub => sub.student_id === student.id);
      
      if (submission) {
        return {
          student_id: student.id,
          nome_alunno: student.nome,
          cognome_alunno: student.cognome,
          codice_fiscale_alunno: student.codice_fiscale,
          signed: true,
          submission_id: submission.id,
          answers: submission.answers,
          is_signed: submission.is_signed,
          signature_log: submission.signature_log,
          pdf_path: submission.pdf_path,
          origine: submission.origine ?? 'online',
          created_at: submission.created_at
        };
      } else {
        return {
          student_id: student.id,
          nome_alunno: student.nome,
          cognome_alunno: student.cognome,
          codice_fiscale_alunno: student.codice_fiscale,
          signed: false
        };
      }
    });

    return NextResponse.json({
      form: {
        id: template.id,
        title: template.title,
        description: template.description,
        fields: template.fields
      },
      class_name: className,
      results: mergedData
    });
  } catch (err) {
    logErrore({ operazione: 'admin/documents-merge:GET', stato: 500 }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    );
  }
});
