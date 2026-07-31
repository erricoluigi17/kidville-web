import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertSezioneInScope, assertUtenteInScope } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { docentiDiSezione } from '@/lib/sezioni/docenti';
import { staffScuola } from '@/lib/notifiche/destinatari';
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
//
// ⚠️ SCOPE DI SEDE SU TUTTI E TRE GLI HANDLER (audit 2026-07-31). `DIREZIONE`
// dice CHI può assegnare un docente, non SU QUALE plesso: fino a quella data
// POST e DELETE non leggevano mai `sections`, quindi il coordinator di un plesso
// poteva agganciare un proprio educator a una sezione di un altro — o sfilarne
// il titolare. Non è un dettaglio di permessi: `docentiDiSezione` legge
// `utenti_sezioni` per `section_id` SENZA filtro di sede ed è la sorgente dei
// destinatari di sei notifiche che citano il NOME di un minore (assenze,
// giustifiche, pagelle, armadietto). Un legame cross-sede creato qui manda il
// nome di un bambino di un plesso nel centro notifiche di un'insegnante di un
// altro. Servono entrambi gli assert: la SEZIONE (che non sia di un'altra sede)
// e il DOCENTE (che non sia personale di un'altra sede).
// ============================================================

const DIREZIONE = ['admin', 'coordinator'] as const;
const bodySchema = z.object({ utente_id: zUuid });

// Tutto il personale, genitori esclusi: sostituisce il vecchio
// `.neq('ruolo', 'genitore')`. I nomi storici (`maestra`, `insegnante`,
// `coordinatore`) convivono a database con quelli di `RUOLI_VALIDI` e vanno
// tenuti, altrimenti sparirebbero dall'elenco insegnanti di mezza anagrafica.
const RUOLI_PERSONALE = [
  'admin', 'coordinator', 'coordinatore', 'segreteria',
  'educator', 'maestra', 'insegnante', 'cuoca',
];

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
    // Anche in LETTURA: l'elenco contiene nome, cognome, email e ruolo del
    // personale della sede della sezione — dati di lavoratori, più la mappa
    // delle assegnazioni, che è l'inventario con cui si sfruttano gli altri
    // rilievi. `assertSezioneInScope` risponde 404 se la sezione non esiste,
    // esattamente come faceva il controllo qui sotto.
    const fuoriSezione = await assertSezioneInScope(supabase, auth.user, sectionId);
    if (fuoriSezione) return fuoriSezione;

    const { data: section } = await supabase.from('sections').select('id, scuola_id').eq('id', sectionId).maybeSingle();
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 });

    // CHI LAVORA IN QUESTA SEDE NON È `utenti.scuola_id`: è l'unione fra quella
    // colonna e il ponte `utenti_scuole` (audit 2026-07-31 — quinta occorrenza
    // della stessa forma, dopo mensa/notify, panic-alert, locker/notify e
    // fattura/sync). Qui c'era una `.eq('scuola_id', section.scuola_id)` nuda:
    // il personale agganciato alla sede dal solo ponte non compariva
    // nell'elenco, quindi non era assegnabile alla classe — e la Direzione
    // vedeva una tendina corta senza il minimo errore. `staffScuola` fa
    // l'unione, regge il ponte assente sul DB E2E non migrato e logga i
    // destinatari zero: è l'unico posto del repo autorizzato a quella query.
    const idsSede = await staffScuola(supabase, (section.scuola_id as string | null) ?? null, RUOLI_PERSONALE);
    const { data: staff, error: errStaff } = await supabase
      .from('utenti')
      .select('id, nome, cognome, ruolo, scuola_id')
      .in('id', idsSede)
      .order('cognome', { ascending: true });
    // PostgREST non lancia: senza questo controllo una lettura fallita usciva
    // come «nessun insegnante disponibile», indistinguibile da una sede vuota.
    if (errStaff) {
      logErrore({ operazione: 'admin/sections/[id]/teachers:GET', stato: 500, evento: 'db' }, errStaff);
      return NextResponse.json({ error: 'Errore nel caricamento del personale' }, { status: 500 });
    }

    const assignedIds = await docentiDiSezione(supabase, sectionId);
    const assignedSet = new Set(assignedIds);
    const staffList = (staff ?? []) as StaffRow[];

    const assigned: StaffRow[] = staffList.filter(u => assignedSet.has(u.id));
    // Nomi anche per docenti assegnati non appartenenti alla sede corrente.
    const missing = assignedIds.filter(aid => !staffList.some(u => u.id === aid));
    if (missing.length) {
      const { data: extra, error: errExtra } = await supabase
        .from('utenti')
        .select('id, nome, cognome, ruolo, scuola_id')
        .in('id', missing);
      if (errExtra) logErrore({ operazione: 'admin/sections/[id]/teachers:GET', stato: 200, evento: 'db' }, errExtra);
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
    const fuoriSezione = await assertSezioneInScope(supabase, auth.user, sectionId);
    if (fuoriSezione) return fuoriSezione;
    const fuoriUtente = await assertUtenteInScope(supabase, auth.user, utente_id);
    if (fuoriUtente) return fuoriUtente;

    const { error } = await supabase
      .from('utenti_sezioni')
      .upsert({ utente_id, section_id: sectionId }, { onConflict: 'utente_id,section_id', ignoreDuplicates: true });
    if (error) {
      logErrore({ operazione: 'admin/sections/[id]/teachers:POST', stato: 500 }, error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sezione_docente',
      // L'entità è la RELAZIONE: l'uuid interrogabile è il docente, la sezione
      // ha già la sua colonna. La coppia resta per intero in `valoreDopo`.
      entitaId: utente_id,
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
    // Anche la RIMOZIONE va vincolata: sfilare il docente titolare di una
    // sezione di un altro plesso gli toglie l'accesso alla propria classe.
    const fuoriSezione = await assertSezioneInScope(supabase, auth.user, sectionId);
    if (fuoriSezione) return fuoriSezione;
    const fuoriUtente = await assertUtenteInScope(supabase, auth.user, utente_id);
    if (fuoriUtente) return fuoriUtente;

    const { error } = await supabase
      .from('utenti_sezioni')
      .delete()
      .eq('section_id', sectionId)
      .eq('utente_id', utente_id);
    if (error) {
      logErrore({ operazione: 'admin/sections/[id]/teachers:DELETE', stato: 500 }, error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sezione_docente',
      entitaId: utente_id,
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
