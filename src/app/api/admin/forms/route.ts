import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id restano stringhe libere (niente zUuid): oggi il codice non impone
// alcun formato e nei test/dati seed circolano id non-UUID.

const getQuerySchema = z.object({
  scuola_id: z.string().optional(), // ignorato: la lista filtra sulle sedi attive risolte
});

const postBodySchema = z.object({
  title: z.string().min(1, 'Titolo e campi obbligatori'),
  // oggi basta che sia truthy (nessun vincolo di forma): refine, non z.array
  fields: z.unknown().refine((v) => !!v, 'Titolo e campi obbligatori'),
  description: z.string().nullish(), // falsy → '' nell'handler (come oggi)
  target_scope: z.string().nullish(), // falsy → 'class' nell'handler (come oggi)
  target_classes: z.unknown().optional(), // falsy → [] nell'handler (come oggi)
  expiration_date: z.string().nullish(), // falsy → null nell'handler (come oggi)
  scuola_id: z.string().nullish(), // preferita per resolveScuolaScrittura; falsy → sede risolta
  // Un form_type non ammesso NON viene rifiutato: oggi il codice lo normalizza
  // silenziosamente ad 'autorizzazione' → .catch() replica quel fallback.
  form_type: z.enum(['sondaggio', 'gradimento', 'autorizzazione']).catch('autorizzazione'),
  // Flag «essenziale: sempre firmabile» — firmabile anche da genitore sospeso.
  sempre_firmabile: z.unknown().optional(),
});

// Colonna nuova assente sul DB E2E CI non migrato → si omette (best-effort).
const COLONNA_NUOVA_ASSENTE = new Set(['PGRST204', '42703']);

// PATCH: i campi presenti nel body (anche null) vengono inclusi nell'update
// come oggi; i valori restano senza vincoli di forma (z.unknown).
// NB zod v4: z.unknown() nudo rende la chiave obbligatoria → sempre .optional().
const patchBodySchema = z.object({
  id: z.string({ error: 'ID obbligatorio' }).min(1, 'ID obbligatorio'),
  expiration_date: z.unknown().optional(),
  title: z.unknown().optional(),
  description: z.unknown().optional(),
  target_classes: z.unknown().optional(),
  sempre_firmabile: z.unknown().optional(),
});

const deleteBodySchema = z.object({
  id: z.string({ error: 'ID obbligatorio' }).min(1, 'ID obbligatorio'),
});

// GET: Recupera tutti i moduli creati
export const GET = withRoute('admin/forms:GET', async (request: NextRequest) => {
    // Gap auth segnalato in M3, chiuso in M9. La lista è letta anche dalla
    // modulistica DOCENTE (semaforo autorizzazioni) → requireDocente, non Staff.
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    try {
      const supabase = await createAdminClient();
      const sedi = await resolveScuoleAttive(request, supabase, auth.user);

      const { data, error } = await supabase
        .from('forms_templates')
        .select('*')
        .in('scuola_id', sedi)
        .order('created_at', { ascending: false });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json(data);
    } catch (err) {
      logErrore({ operazione: 'admin/forms:GET', stato: 500 }, err);
      const message = err instanceof Error && err.message ? err.message : 'Errore interno';
      return NextResponse.json({ error: message }, { status: 500 });
    }
});

// POST: Crea un nuovo modulo
export const POST = withRoute('admin/forms:POST', async (request: NextRequest) => {
    // Gap auth segnalato in M3, chiuso in M9: mutazioni riservate allo staff.
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;

    try {
      const { title, description, fields, target_scope, target_classes, expiration_date, scuola_id, form_type, sempre_firmabile } = b.data;

      const supabase = await createAdminClient();

      const sw = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id ?? undefined);
      if (sw.response) return sw.response;

      const record = {
        scuola_id: sw.scuolaId,
        title,
        description: description || '',
        form_type,
        fields: fields || [],
        target_scope: target_scope || 'class',
        target_classes: target_classes || [],
        expiration_date: expiration_date || null
      };

      let res = await supabase
        .from('forms_templates')
        .insert({ ...record, sempre_firmabile: sempre_firmabile === true })
        .select()
        .single();
      // DB non migrato (colonna assente): riprova senza il flag.
      if (res.error && COLONNA_NUOVA_ASSENTE.has(res.error.code ?? '')) {
        res = await supabase.from('forms_templates').insert(record).select().single();
      }

      if (res.error) {
        return NextResponse.json({ error: res.error.message }, { status: 500 });
      }

      return NextResponse.json(res.data, { status: 201 });
    } catch (err) {
      logErrore({ operazione: 'admin/forms:POST', stato: 500 }, err);
      const message = err instanceof Error && err.message ? err.message : 'Errore interno';
      return NextResponse.json({ error: message }, { status: 500 });
    }
});

// PATCH: Aggiorna la data di scadenza o altri campi
export const PATCH = withRoute('admin/forms:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, patchBodySchema);
    if ('response' in b) return b.response;

    try {
      const { id, expiration_date, title, description, target_classes, sempre_firmabile } = b.data;

      const supabase = await createAdminClient();
      const updates: Record<string, unknown> = {};

      if (expiration_date !== undefined) updates.expiration_date = expiration_date;
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (target_classes !== undefined) updates.target_classes = target_classes;
      if (sempre_firmabile !== undefined) updates.sempre_firmabile = sempre_firmabile === true;

      // Isolamento per sede sulla RIGA, non solo sui campi. L'allowlist qui sopra
      // impedisce di riscrivere `scuola_id`, ma non diceva nulla su QUALE riga si
      // tocca: `.eq('id', id)` nudo modificava il template di un altro plesso.
      // `forms_templates.scuola_id` è NOT NULL, quindi il filtro non ha bisogno di
      // degradare. Scope vuoto ⇒ nessuna riga colpita ⇒ 404.
      const sedi = await resolveScuoleAttive(request, supabase, auth.user);
      const aggiorna = (patch: Record<string, unknown>) =>
        supabase.from('forms_templates').update(patch).eq('id', id).in('scuola_id', sedi).select();

      let res = await aggiorna(updates);
      // DB non migrato: se la PATCH portava `sempre_firmabile` e la colonna manca,
      // riprova senza — gli altri campi devono comunque salvarsi.
      if (res.error && COLONNA_NUOVA_ASSENTE.has(res.error.code ?? '') && 'sempre_firmabile' in updates) {
        const rest = { ...updates };
        delete rest.sempre_firmabile;
        res = await aggiorna(rest);
      }

      if (res.error) {
        return NextResponse.json({ error: res.error.message }, { status: 500 });
      }
      // Zero righe colpite: o il modulo non esiste, o non è di un plesso in scope.
      // 404 in entrambi i casi — un 403 direbbe «esiste, ma non è tuo».
      const colpite = (res.data ?? []) as Record<string, unknown>[];
      if (colpite.length === 0) {
        logEvento('modulistica', 'warn', {
          operazione: 'admin/forms:PATCH', esito: 'modulo-fuori-sede-o-inesistente',
          utente: auth.user.id, ruolo: auth.user.role,
        });
        return NextResponse.json({ error: 'Modulo non trovato' }, { status: 404 });
      }

      return NextResponse.json(colpite[0]);
    } catch (err) {
      logErrore({ operazione: 'admin/forms:PATCH', stato: 500 }, err);
      const message = err instanceof Error && err.message ? err.message : 'Errore interno';
      return NextResponse.json({ error: message }, { status: 500 });
    }
});

// DELETE: Elimina un modulo
export const DELETE = withRoute('admin/forms:DELETE', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, deleteBodySchema);
    if ('response' in b) return b.response;

    try {
      const supabase = await createAdminClient();

      // Stesso vincolo della PATCH: la DELETE si porta via anche le compilazioni
      // collegate, quindi il template dev'essere di un plesso in scope.
      const sedi = await resolveScuoleAttive(request, supabase, auth.user);
      const { data, error } = await supabase
        .from('forms_templates')
        .delete()
        .eq('id', b.data.id)
        .in('scuola_id', sedi)
        .select('id');

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (((data ?? []) as unknown[]).length === 0) {
        logEvento('modulistica', 'warn', {
          operazione: 'admin/forms:DELETE', esito: 'modulo-fuori-sede-o-inesistente',
          utente: auth.user.id, ruolo: auth.user.role,
        });
        return NextResponse.json({ error: 'Modulo non trovato' }, { status: 404 });
      }

      // Cancellazione di un modulo (e delle compilazioni collegate): evento da
      // vedere anche quando riesce. Solo uuid e ruolo.
      logEvento('modulistica', 'info', {
        operazione: 'admin/forms:DELETE', esito: 'modulo-eliminato',
        utente: auth.user.id, ruolo: auth.user.role,
      });
      return NextResponse.json({ success: true });
    } catch (err) {
      logErrore({ operazione: 'admin/forms:DELETE', stato: 500 }, err);
      const message = err instanceof Error && err.message ? err.message : 'Errore interno';
      return NextResponse.json({ error: message }, { status: 500 });
    }
});
