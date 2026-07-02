import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaTitolariScrittura, enqueueDiarioGenitori } from '@/lib/primaria/notifiche';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';

// Modalità genitore: default from = 14 giorni fa, to = oggi (dinamici, calcolati nel codice).
const getParentQuerySchema = z.object({
    alunno_id: zUuid,
    from: zDataYMD.optional(),
    to: zDataYMD.optional(),
});

// Modalità insegnante/staff: default date = oggi (dinamico, calcolato nel codice).
const getTeacherQuerySchema = z.object({
    sezione: z.string().default('Girasoli'),
    date: zDataYMD.optional(),
});

// Un evento diario: campi pass-through verso il DB lasciati permissivi
// (il comportamento attuale non impone vincoli su orari/dettagli/nota).
const entrySchema = z.object({
    alunno_id: zUuid,
    // Nessun vincolo di non-vuoto: il codice attuale non lo impone su questa route.
    tipo_evento: z.string(),
    // Default dinamico (adesso) calcolato nel codice.
    orario_inizio: z.unknown().optional(),
    orario_fine: z.unknown().optional(),
    dettagli: z.unknown().optional(),
    nota_libera: z.unknown().optional(),
});

// Il body può essere un singolo evento o un array di eventi.
const postBodySchema = z.union([z.array(entrySchema), entrySchema]);

// GET /api/diary/entries
// Modalità insegnante: ?sezione=Girasoli&date=2026-05-12
// Modalità genitore:   ?alunno_id=xxx&from=2026-04-28
//
// P0/S9b (DL-040): tutti gli accessi a `eventi_diario` usano service-role +
// scoping applicativo (End-state X, DL-035), così le policy permissive anon
// sono droppate. NB: lo scoping di proprietà del ramo genitore (un genitore solo
// i propri figli) è rinviato all'onboarding/sigillo S13 — finché l'identità è via
// header (spoofabile) il gate non aggiunge sicurezza reale e romperebbe l'accesso
// demo; la lettura passa comunque via service-role (anon = default-deny).
export async function GET(request: NextRequest) {
    const admin = await createAdminClient();
    const params = request.nextUrl.searchParams;

    // ── Modalità genitore: per singolo alunno in un range di date ──
    if (params.get('alunno_id')) {
        const q = parseQuery(request, getParentQuerySchema);
        if ('response' in q) return q.response;
        const fromDate = q.data.from ?? (() => {
            const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().split('T')[0];
        })();
        const toDate = q.data.to ?? new Date().toISOString().split('T')[0];

        const { data, error } = await admin
            .from('eventi_diario')
            .select('id, tipo_evento, orario_inizio, dettagli, nota_libera')
            .eq('alunno_id', q.data.alunno_id)
            .gte('orario_inizio', `${fromDate}T00:00:00.000Z`)
            .lte('orario_inizio', `${toDate}T23:59:59.999Z`)
            .order('orario_inizio', { ascending: false });

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        const mapped = (data ?? []).map(e => ({
            id:                   e.id,
            tipo_evento:          e.tipo_evento,
            timestamp_evento:     e.orario_inizio,
            dettagli:             e.dettagli,
            note:                 e.nota_libera,
            activity_description: null,
        }));
        return NextResponse.json(mapped);
    }

    // ── Modalità insegnante/staff: per sezione + data ──
    // Gate ruolo + isolamento per plesso (nome classe risolto DENTRO i propri plessi).
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;
    const plessi = await scuoleDiUtente(admin, auth.user);
    if (plessi.length === 0) return NextResponse.json([]);

    const q = parseQuery(request, getTeacherQuerySchema);
    if ('response' in q) return q.response;
    const sezione = q.data.sezione;
    const date = q.data.date ?? new Date().toISOString().split('T')[0];

    const { data: alunni } = await admin
        .from('alunni')
        .select('id')
        .eq('classe_sezione', sezione)
        .in('scuola_id', plessi);

    if (!alunni || alunni.length === 0) return NextResponse.json([]);

    const ids = alunni.map(a => a.id);
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay   = `${date}T23:59:59.999Z`;

    const { data, error } = await admin
        .from('eventi_diario')
        .select('*')
        .in('alunno_id', ids)
        .gte('orario_inizio', startOfDay)
        .lte('orario_inizio', endOfDay)
        .order('orario_inizio', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(data);
}

// POST /api/diary/entries — salva (upsert) eventi diario
// Per ogni alunno+tipo_evento: se già esiste oggi → UPDATE, altrimenti → INSERT
export async function POST(request: NextRequest) {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const admin = await createAdminClient();

    const entries = Array.isArray(b.data) ? b.data : [b.data];

    // Scope: ogni alunno deve essere nello scope dell'attore (tenant + classe).
    const alunnoIds = [...new Set(entries.map((e) => e.alunno_id).filter(Boolean))];
    for (const aid of alunnoIds) {
        const scopeErr = await assertAlunnoInScope(admin, auth.user, aid);
        if (scopeErr) return scopeErr;
    }

    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    const results = [];
    const errors = [];

    for (const entry of entries) {
        // Cerca se esiste già un evento per questo alunno+tipo oggi
        const { data: existing } = await admin
            .from('eventi_diario')
            .select('id')
            .eq('alunno_id', entry.alunno_id)
            .eq('tipo_evento', entry.tipo_evento)
            .gte('orario_inizio', startOfDay)
            .lte('orario_inizio', endOfDay)
            .order('orario_inizio', { ascending: false })
            .limit(1);

        if (existing && existing.length > 0) {
            // UPDATE
            const { data, error } = await admin
                .from('eventi_diario')
                .update({
                    dettagli: entry.dettagli ?? null,
                    orario_fine: entry.orario_fine ?? null,
                    nota_libera: entry.nota_libera ?? null,
                    // activity_description escluso: colonna non ancora migrata
                })
                .eq('id', existing[0].id)
                .select('id, alunno_id, tipo_evento');

            if (error) errors.push({ alunno_id: entry.alunno_id, error: error.message });
            else if (data) results.push(...data);
        } else {
            // INSERT
            const { data, error } = await admin
                .from('eventi_diario')
                .insert({
                    alunno_id: entry.alunno_id,
                    // Provenienza operativa = chi registra (anche la segreteria). Non è una firma valutativa.
                    maestra_id: auth.user.id,
                    tipo_evento: entry.tipo_evento,
                    orario_inizio: entry.orario_inizio ?? new Date().toISOString(),
                    orario_fine: entry.orario_fine ?? null,
                    dettagli: entry.dettagli ?? null,
                    nota_libera: entry.nota_libera ?? null,
                    // activity_description escluso: colonna non ancora migrata su Supabase
                    pubblicato: false,
                })
                .select('id, alunno_id, tipo_evento');

            if (error) errors.push({ alunno_id: entry.alunno_id, error: error.message });
            else if (data) results.push(...data);
        }

        // #9 — Scalo automatico pannolino: ad ogni evento "bagno" scala 1 pannolino
        // dall'armadietto, SOLO per i bambini con flag "usa_pannolino" in anagrafica.
        // Best-effort e idempotente per giorno: non blocca mai il salvataggio del diario.
        if (entry.tipo_evento === 'bagno') {
            try {
                const { data: al } = await admin
                    .from('alunni')
                    .select('usa_pannolino')
                    .eq('id', entry.alunno_id)
                    .maybeSingle();

                if (al?.usa_pannolino === true) {
                    // Evita doppio scalo nello stesso giorno (idempotenza su update ripetuti)
                    const { data: giaScalato } = await admin
                        .from('armadietto')
                        .select('id')
                        .eq('alunno_id', entry.alunno_id)
                        .eq('materiale', 'Pannolini')
                        .eq('date', today)
                        .eq('portato', false)
                        .limit(1);

                    if (!giaScalato || giaScalato.length === 0) {
                        await admin.from('armadietto').insert({
                            alunno_id: entry.alunno_id,
                            nome_oggetto: 'Pannolini',
                            materiale: 'Pannolini',
                            quantita: 1,
                            quantita_residua: 0,
                            date: today,
                            portato: false, // consumo: sottrae dallo stock aggregato
                            livello_allerta: 5,
                            livello_emergenza: 2,
                        });
                    }
                }
            } catch (e) {
                console.warn('[diary/entries] scalo pannolino saltato:', (e as Error).message);
            }
        }
    }

    // Audit (diff) + notifica al docente titolare se scrive segreteria/direzione.
    if (results.length > 0) {
        const { data: al } = await admin.from('alunni').select('section_id, scuola_id').eq('id', results[0].alunno_id).maybeSingle();
        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'diario', azione: 'update',
            scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null, valoreDopo: results,
        });
        if (al?.section_id) {
            await notificaTitolariScrittura(admin, { attore: auth.user, sectionId: al.section_id, scuolaId: al?.scuola_id, area: 'diario' });
        }

        // Push genitori per aggiornamento diario (buffer 10' + debounce) — 1 per figlio.
        const figliIds = [...new Set(results.map((r) => r.alunno_id).filter(Boolean))];
        const { data: nomi } = await admin.from('alunni').select('id, nome').in('id', figliIds);
        const nomeById = new Map((nomi ?? []).map((n) => [n.id, n.nome as string | null]));
        for (const aid of figliIds) {
            await enqueueDiarioGenitori(admin, { alunnoId: aid, nome: nomeById.get(aid) });
        }
    }

    if (errors.length > 0) {
        return NextResponse.json({ saved: results, errors }, { status: 207 });
    }

    return NextResponse.json(results);
}
