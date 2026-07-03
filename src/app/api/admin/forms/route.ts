import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireStaff } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';

const DEFAULT_SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id restano stringhe libere (niente zUuid): oggi il codice non impone
// alcun formato e nei test/dati seed circolano id non-UUID.

const getQuerySchema = z.object({
  scuola_id: z.string().optional(), // '' o assente → DEFAULT_SCUOLA_ID (come oggi)
});

const postBodySchema = z.object({
  title: z.string().min(1, 'Titolo e campi obbligatori'),
  // oggi basta che sia truthy (nessun vincolo di forma): refine, non z.array
  fields: z.unknown().refine((v) => !!v, 'Titolo e campi obbligatori'),
  description: z.string().nullish(), // falsy → '' nell'handler (come oggi)
  target_scope: z.string().nullish(), // falsy → 'class' nell'handler (come oggi)
  target_classes: z.unknown().optional(), // falsy → [] nell'handler (come oggi)
  expiration_date: z.string().nullish(), // falsy → null nell'handler (come oggi)
  scuola_id: z.string().nullish(), // falsy → DEFAULT_SCUOLA_ID (come oggi)
  // Un form_type non ammesso NON viene rifiutato: oggi il codice lo normalizza
  // silenziosamente ad 'autorizzazione' → .catch() replica quel fallback.
  form_type: z.enum(['sondaggio', 'gradimento', 'autorizzazione']).catch('autorizzazione'),
});

// PATCH: i campi presenti nel body (anche null) vengono inclusi nell'update
// come oggi; i valori restano senza vincoli di forma (z.unknown).
// NB zod v4: z.unknown() nudo rende la chiave obbligatoria → sempre .optional().
const patchBodySchema = z.object({
  id: z.string({ error: 'ID obbligatorio' }).min(1, 'ID obbligatorio'),
  expiration_date: z.unknown().optional(),
  title: z.unknown().optional(),
  description: z.unknown().optional(),
  target_classes: z.unknown().optional(),
});

const deleteBodySchema = z.object({
  id: z.string({ error: 'ID obbligatorio' }).min(1, 'ID obbligatorio'),
});

// GET: Recupera tutti i moduli creati
export async function GET(request: NextRequest) {
  // Gap auth segnalato in M3, chiuso in M9. La lista è letta anche dalla
  // modulistica DOCENTE (semaforo autorizzazioni) → requireDocente, non Staff.
  const auth = await requireDocente(request);
  if (auth.response) return auth.response;

  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const scuolaId = q.data.scuola_id || DEFAULT_SCUOLA_ID;
    const supabase = await createAdminClient();

    const { data, error } = await supabase
      .from('forms_templates')
      .select('*')
      .eq('scuola_id', scuolaId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST: Crea un nuovo modulo
export async function POST(request: NextRequest) {
  // Gap auth segnalato in M3, chiuso in M9: mutazioni riservate allo staff.
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const b = await parseBody(request, postBodySchema);
  if ('response' in b) return b.response;

  try {
    const { title, description, fields, target_scope, target_classes, expiration_date, scuola_id, form_type } = b.data;

    const supabase = await createAdminClient();

    const record = {
      scuola_id: scuola_id || DEFAULT_SCUOLA_ID,
      title,
      description: description || '',
      form_type,
      fields: fields || [],
      target_scope: target_scope || 'class',
      target_classes: target_classes || [],
      expiration_date: expiration_date || null
    };

    const { data, error } = await supabase
      .from('forms_templates')
      .insert(record)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH: Aggiorna la data di scadenza o altri campi
export async function PATCH(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const b = await parseBody(request, patchBodySchema);
  if ('response' in b) return b.response;

  try {
    const { id, expiration_date, title, description, target_classes } = b.data;

    const supabase = await createAdminClient();
    const updates: Record<string, unknown> = {};

    if (expiration_date !== undefined) updates.expiration_date = expiration_date;
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (target_classes !== undefined) updates.target_classes = target_classes;

    const { data, error } = await supabase
      .from('forms_templates')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE: Elimina un modulo
export async function DELETE(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const b = await parseBody(request, deleteBodySchema);
  if ('response' in b) return b.response;

  try {
    const supabase = await createAdminClient();

    const { error } = await supabase
      .from('forms_templates')
      .delete()
      .eq('id', b.data.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
