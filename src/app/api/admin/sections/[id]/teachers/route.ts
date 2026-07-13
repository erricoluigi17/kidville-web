import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { docentiDiSezione } from '@/lib/sezioni/docenti';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ============================================================
// Insegnanti di riferimento di una sezione — gate Direzione.
// Riusa la tabella-ponte `utenti_sezioni` (fonte di verità del legame
// docente↔sezione): aggiungere/rimuovere un insegnante qui si riflette
// automaticamente nelle "Classi assegnate" del docente (StaffPanel).
// Semantica add/remove (non replace) per non toccare i legami creati dalle
// associazioni materia-docente (utenti_sezioni_materie).
// ============================================================

const DIREZIONE = ['admin', 'coordinator'] as const;
const bodySchema = z.object({ utente_id: zUuid });

interface StaffRow { id: string; nome: string; cognome: string; ruolo: string; scuola_id: string | null }

async function resolveSectionId(context: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await context.params;
  return parseData(zUuid, rawId);
}

export const GET = withRoute('admin/sections/[id]/teachers:GET', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireStaff(request, [...DIREZIONE]);
  if (auth.response) return auth.response;
  const idP = await resolveSectionId(context);
  if ('response' in idP) return idP.response;
  const sectionId = idP.data;

  try {
    const supabase = await createAdminClient();
    const { data: section } = await supabase.from('sections').select('id, scuola_id').eq('id', sectionId).maybeSingle();
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 });

    const { data: staff } = await supabase
      .from('utenti')
      .select('id, nome, cognome, ruolo, scuola_id')
      .neq('ruolo', 'genitore')
      .eq('scuola_id', section.scuola_id)
      .order('cognome', { ascending: true });

    const assignedIds = await docentiDiSezione(supabase, sectionId);
    const assignedSet = new Set(assignedIds);
    const staffList = (staff ?? []) as StaffRow[];

    const assigned: StaffRow[] = staffList.filter(u => assignedSet.has(u.id));
    // Nomi anche per docenti assegnati non appartenenti alla sede corrente.
    const missing = assignedIds.filter(aid => !staffList.some(u => u.id === aid));
    if (missing.length) {
      const { data: extra } = await supabase
        .from('utenti')
        .select('id, nome, cognome, ruolo, scuola_id')
        .in('id', missing);
      for (const u of (extra ?? []) as StaffRow[]) assigned.push(u);
    }
    const available = staffList.filter(u => !assignedSet.has(u.id));

    return NextResponse.json({ success: true, assigned, available });
  } catch (err) {
    logErrore({ operazione: 'admin/sections/[id]/teachers:GET', stato: 500 }, err);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
});

export const POST = withRoute('admin/sections/[id]/teachers:POST', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireStaff(request, [...DIREZIONE]);
  if (auth.response) return auth.response;
  const idP = await resolveSectionId(context);
  if ('response' in idP) return idP.response;
  const sectionId = idP.data;
  const parsed = await parseBody(request, bodySchema);
  if ('response' in parsed) return parsed.response;
  const { utente_id } = parsed.data;

  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from('utenti_sezioni')
      .upsert({ utente_id, section_id: sectionId }, { onConflict: 'utente_id,section_id', ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sezione_docente',
      entitaId: `${sectionId}:${utente_id}`,
      azione: 'insert',
      sectionId,
      valoreDopo: { section_id: sectionId, utente_id },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    logErrore({ operazione: 'admin/sections/[id]/teachers:POST', stato: 500 }, err);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
});

export const DELETE = withRoute('admin/sections/[id]/teachers:DELETE', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireStaff(request, [...DIREZIONE]);
  if (auth.response) return auth.response;
  const idP = await resolveSectionId(context);
  if ('response' in idP) return idP.response;
  const sectionId = idP.data;
  const parsed = await parseBody(request, bodySchema);
  if ('response' in parsed) return parsed.response;
  const { utente_id } = parsed.data;

  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from('utenti_sezioni')
      .delete()
      .eq('section_id', sectionId)
      .eq('utente_id', utente_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sezione_docente',
      entitaId: `${sectionId}:${utente_id}`,
      azione: 'delete',
      sectionId,
      valorePrima: { section_id: sectionId, utente_id },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    logErrore({ operazione: 'admin/sections/[id]/teachers:DELETE', stato: 500 }, err);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
});
