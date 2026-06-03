import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

const DEFAULT_SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

// GET: Recupera tutti i moduli creati
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const scuolaId = searchParams.get('scuola_id') || DEFAULT_SCUOLA_ID;
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
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// POST: Crea un nuovo modulo
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, fields, target_scope, target_classes, expiration_date, scuola_id, form_type } = body;

    if (!title || !fields) {
      return NextResponse.json({ error: 'Titolo e campi obbligatori' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    const ALLOWED_TYPES = ['sondaggio', 'gradimento', 'autorizzazione'];
    const safeType = ALLOWED_TYPES.includes(form_type) ? form_type : 'autorizzazione';

    const record = {
      scuola_id: scuola_id || DEFAULT_SCUOLA_ID,
      title,
      description: description || '',
      form_type: safeType,
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
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// PATCH: Aggiorna la data di scadenza o altri campi
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, expiration_date, title, description, target_classes } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID obbligatorio' }, { status: 400 });
    }

    const supabase = await createAdminClient();
    const updates: Record<string, any> = {};

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
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// DELETE: Elimina un modulo
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID obbligatorio' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    const { error } = await supabase
      .from('forms_templates')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
