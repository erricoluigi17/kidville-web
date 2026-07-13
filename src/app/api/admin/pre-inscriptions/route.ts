import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso

// Falsy (es. '' dal form) trattato come assente: preserva il fallback
// pre-esistente `scuola_id || DEFAULT_SCUOLA_ID`.
const zScuolaIdOpzionale = z.preprocess((v) => v || undefined, zUuid.optional());

// Campi facoltativi permissivi (il codice normalizza solo i falsy a null);
// students è JSONB libero: array di oggetti figlio senza vincoli sul contenuto.
const postBodySchema = z.object({
  parent_first_name: z.string().min(1),
  parent_last_name: z.string().min(1),
  parent_email: z.string().min(1),
  parent_phone: z.string().nullish(),
  parent_fiscal_code: z.string().nullish(),
  parent_address: z.string().nullish(),
  students: z.array(z.unknown()),
  scuola_id: zScuolaIdOpzionale,
});

// Stati ammessi dal flusso attuale: 'rejected' | 'approved' (altro → 400).
// assigned_class è obbligatoria solo per 'approved': resta il check nell'handler.
const patchBodySchema = z.object({
  id: zUuid,
  status: z.enum(['rejected', 'approved']),
  assigned_class: z.string().nullish(),
});

// GET: Recupera tutte le pre-iscrizioni (Sala d'attesa)
export const GET = withRoute('admin/pre-inscriptions:GET', async (request: NextRequest) => {
  try {
    // Gap auth segnalato in M3, chiuso in M9: la sala d'attesa (PII dei
    // richiedenti) è dello staff. Il POST resta PUBBLICO: è la sottomissione
    // del portale onboarding.
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from('pre_inscriptions')
      .select('*')
      .in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user))
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    logErrore({ operazione: 'admin/pre-inscriptions:GET', stato: 500 }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 });
  }
});

// POST: Sottomissione da parte del genitore (Portale Onboarding Pubblico)
export const POST = withRoute('admin/pre-inscriptions:POST', async (request: NextRequest) => {
  try {
    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const {
      parent_first_name,
      parent_last_name,
      parent_email,
      parent_phone,
      parent_fiscal_code,
      parent_address,
      students,
      scuola_id
    } = b.data;

    const supabase = await createAdminClient();

    // Scuola: dal form se indicata; altrimenti l'unica scuola esistente.
    let scuolaId = scuola_id || undefined;
    if (!scuolaId) {
      const { data: scuole } = await supabase.from('schools').select('id').limit(2);
      if (scuole && scuole.length === 1) scuolaId = scuole[0].id as string;
    }
    if (!scuolaId) {
      return NextResponse.json({ error: 'Specificare la scuola' }, { status: 400 });
    }

    const record = {
      scuola_id: scuolaId,
      parent_first_name,
      parent_last_name,
      parent_email,
      parent_phone: parent_phone || null,
      parent_fiscal_code: parent_fiscal_code || null,
      parent_address: parent_address || null,
      students: students,
      status: 'pending'
    };

    const { data, error } = await supabase
      .from('pre_inscriptions')
      .insert(record)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    logErrore({ operazione: 'admin/pre-inscriptions:POST', stato: 500 }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 });
  }
});

// PATCH: Approvazione (Sala d'attesa) o Rifiuto
export const PATCH = withRoute('admin/pre-inscriptions:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, patchBodySchema);
    if ('response' in b) return b.response;
    const { id, status, assigned_class } = b.data;

    const supabase = await createAdminClient();

    // Se si tratta di rifiuto, cambiamo solo lo stato
    if (status === 'rejected') {
      const { data, error } = await supabase
        .from('pre_inscriptions')
        .update({ status: 'rejected' })
        .eq('id', id)
        .select()
        .single();
      
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json(data);
    }

    // Se si tratta di approvazione
    if (status === 'approved') {
      if (!assigned_class) {
        return NextResponse.json({ error: 'Assegnare una classe è obbligatorio per l\'approvazione' }, { status: 400 });
      }

      // Recupera la pre-iscrizione
      const { data: pre, error: fetchErr } = await supabase
        .from('pre_inscriptions')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr || !pre) {
        return NextResponse.json({ error: 'Pre-iscrizione non trovata' }, { status: 404 });
      }

      // 1. Crea l'utente parent in Supabase Auth (simulando o eseguendo)
      // Generiamo una password temporanea per il genitore
      const tempPassword = 'KidvilleParent_' + Math.random().toString(36).substring(2, 8);
      
      let userId: string;
      const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
        email: pre.parent_email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          first_name: pre.parent_first_name,
          last_name: pre.parent_last_name,
          role: 'parent'
        }
      });

      if (authErr) {
        // Se l'utente esiste già, cerchiamo di recuperare l'ID
        if (authErr.message.includes('already exists') || authErr.message.includes('email_exists')) {
          const { data: listData } = await supabase.from('utenti').select('id').eq('email', pre.parent_email).maybeSingle();
          if (listData?.id) {
            userId = listData.id;
          } else {
            return NextResponse.json({ error: 'Errore durante la creazione dell\'utente auth: email già registrata.' }, { status: 400 });
          }
        } else {
          return NextResponse.json({ error: 'Errore Auth: ' + authErr.message }, { status: 500 });
        }
      } else {
        userId = authData.user.id;
      }

      // 2. Inserisci il genitore in utenti (compatibilità legacy)
      const utentiRecord = {
        id: userId,
        email: pre.parent_email,
        password_segreta: tempPassword, // Salvata in chiaro per comodità della demo burocratica/visualizzazione credenziali
        nome: pre.parent_first_name,
        cognome: pre.parent_last_name,
        cellulare: pre.parent_phone || null,
        ruolo: 'genitore',
        scuola_id: pre.scuola_id,
        attivo: true
      };

      const { error: utentiErr } = await supabase
        .from('utenti')
        .upsert(utentiRecord);

      if (utentiErr) {
        console.error('Errore inserimento utenti:', utentiErr.message);
      }

      // Inserisci in adults (schema esteso) se la tabella esiste. 
      // Useremo rpc exec_sql_kidville o directly try-catch
      try {
        const adultsRecord = {
          id: userId,
          first_name: pre.parent_first_name,
          last_name: pre.parent_last_name,
          fiscal_code: pre.parent_fiscal_code || null,
          address: pre.parent_address || null,
          emails: [pre.parent_email],
          phones: pre.parent_phone ? [pre.parent_phone] : [],
          role: 'parent'
        };
        await supabase.from('adults').upsert(adultsRecord);
      } catch {
        console.log('Tabella adults non presente o non interrogabile direttamente, skippo...');
      }

      // 3. Inserisci tutti i bambini
      const childrenList = pre.students || [];
      for (const child of childrenList) {
        const childRecord = {
          scuola_id: pre.scuola_id,
          nome: child.nome,
          cognome: child.cognome,
          data_nascita: child.data_nascita,
          codice_fiscale: child.codice_fiscale || null,
          classe_sezione: assigned_class,
          stato: 'iscritto',
          note_mediche: child.note_mediche || null,
          consenso_privacy: false
        };

        const { data: newChild, error: childErr } = await supabase
          .from('alunni')
          .insert(childRecord)
          .select()
          .single();

        if (childErr) {
          console.error('Errore inserimento alunno:', childErr.message);
          continue;
        }

        // Inserisci il legame genitore-alunno
        if (newChild) {
          const legameRecord = {
            genitore_id: userId,
            alunno_id: newChild.id,
            intestatario_fattura: true,
            percentuale_pagamento: 100
          };
          const { error: legameErr } = await supabase
            .from('legame_genitori_alunni')
            .insert(legameRecord);
          
          if (legameErr) {
            console.error('Errore inserimento legame:', legameErr.message);
          }
        }
      }

      // 4. Aggiorna lo stato della pre-iscrizione
      const { data: updatedPre, error: updatePreErr } = await supabase
        .from('pre_inscriptions')
        .update({
          status: 'approved',
          assigned_class
        })
        .eq('id', id)
        .select()
        .single();

      if (updatePreErr) {
        return NextResponse.json({ error: updatePreErr.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        pre_inscription: updatedPre,
        credentials: {
          email: pre.parent_email,
          password: tempPassword
        }
      });
    }

    return NextResponse.json({ error: 'Stato non valido' }, { status: 400 });
  } catch (err) {
    logErrore({ operazione: 'admin/pre-inscriptions:PATCH', stato: 500 }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 });
  }
});
