import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zDataYMD, zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

/**
 * GET /api/attendance/daily?data=YYYY-MM-DD&sezione=<classe>
 * Restituisce le presenze del giorno per la sezione indicata.
 *
 * POST /api/attendance/daily
 * Body: { alunno_id, data, stato, orario_entrata?, orario_uscita? }
 * Upsert diretto su Supabase — bypassa Dexie per dati live nel registro mensile.
 */

const getQuerySchema = z.object({
    // default dinamico (oggi) calcolato nell'handler
    data: zDataYMD.optional(),
    // Nessun default a un nome sezione reale: param omesso → '' → risposta vuota.
    sezione: z.string().default(''),
});

const STATI_VALIDI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const;

const postBodySchema = z.object({
    alunno_id: zUuid,
    data: zDataYMD,
    stato: z.enum(STATI_VALIDI),
    orario_entrata: z.string().nullable().optional(),
    orario_uscita: z.string().nullable().optional(),
});

export const GET = withRoute('attendance/daily:GET', async (request: NextRequest) => {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const data = q.data.data ?? new Date().toISOString().split('T')[0];
    const sezione = q.data.sezione;

    try {
        // Pattern canonico delle route docente (cfr. diary/entries, agenda):
        // gate applicativo requireDocente + client admin. Con i cookie di
        // sessione il client SSR applicherebbe la RLS come utente, e le policy
        // scolastiche su presenze dipendono da un self-read su `utenti` che la
        // RLS nega → via sessione non funzionerebbero per nessuno.
        const supabase = await createAdminClient();

        const { data: rows, error } = await supabase
            .from('presenze')
            .select(`
                id,
                alunno_id,
                data,
                stato,
                orario_entrata,
                orario_uscita,
                panic_alert,
                alunni!inner ( id, nome, cognome, classe_sezione )
            `)
            .eq('data', data)
            .eq('alunni.classe_sezione', sezione)
            // bound difensivo: 1 riga per alunno/giorno, una sezione non supera mai 500
            .limit(500);

        if (error) {
            // `error` benché la risposta sia 200: il fallback a `[]` è esattamente il guasto
            // silenzioso che questo modulo esiste per impedire — l'appello si apre VUOTO e
            // sembra una classe senza presenze registrate, non un database che non risponde.
            // (Il vecchio `JSON.stringify(error)` per giunta restituiva `{}` su un Error nativo:
            // ora l'oggetto si passa intero e arrivano code, details e hint di PostgREST.)
            logEvento('db', 'error', {
                operazione: 'attendance/daily:GET',
                esito: 'presenze-non-lette',
            }, error);
            // Fallback: ritorna array vuoto invece di 500, per non bloccare la UI
            return NextResponse.json([]);
        }

        return NextResponse.json(rows ?? []);
    } catch (err) {
        logErrore({ operazione: 'attendance/daily:GET', stato: 200 }, err);
        return NextResponse.json([]);
    }
});

export const POST = withRoute('attendance/daily:POST', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunno_id, data, stato, orario_entrata, orario_uscita } = b.data;

        const supabase = await createAdminClient();

        // Il record nasce completo di scuola/sezione (fonte: anagrafica alunno):
        // le policy scolastiche su presenze e l'aggregato realtime li richiedono.
        const { data: alunno } = await supabase
            .from('alunni')
            .select('nome, scuola_id, section_id')
            .eq('id', alunno_id)
            .maybeSingle();
        if (!alunno) {
            return NextResponse.json({ error: 'Alunno non trovato.' }, { status: 404 });
        }

        // Stato precedente del giorno: la notifica di assenza allo 0-6 scatta
        // solo alla PRIMA marcatura 'assente' (i ri-salvataggi non duplicano).
        const { data: prima } = await supabase
            .from('presenze')
            .select('stato')
            .eq('alunno_id', alunno_id)
            .eq('data', data)
            .maybeSingle();

        const record = {
            alunno_id,
            data,
            stato,
            orario_entrata: orario_entrata ?? null,
            orario_uscita: orario_uscita ?? null,
            scuola_id: alunno.scuola_id,
            section_id: alunno.section_id,
            aggiornato_il: new Date().toISOString(),
        };

        // Upsert su (alunno_id, data) — un solo record per bambino per giorno
        const { data: result, error } = await supabase
            .from('presenze')
            .upsert(record, { onConflict: 'alunno_id,data' })
            .select()
            .single();

        if (error) {
            logErrore({ operazione: 'attendance/daily:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json(
                { error: 'Errore salvataggio presenza.', details: error.message },
                { status: 500 }
            );
        }

        // Notifica di assenza ai genitori (best-effort). Allo 0-6 il genitore
        // non può comunicare assenze in anticipo → si notifica SEMPRE la prima
        // marcatura assente (testo neutro); la correzione entro il buffer 10'
        // (assente → presente/ritardo) revoca la notifica pending.
        try {
            if (stato === 'assente' && prima?.stato !== 'assente') {
                await notificaEvento(supabase, {
                    tipo: 'assenza_non_comunicata',
                    scuolaId: (alunno.scuola_id as string | undefined) ?? null,
                    alunnoIds: [alunno_id],
                    titolo: 'Assenza registrata all’appello',
                    corpo: `${alunno.nome ?? 'Tuo figlio'} è stato segnato assente oggi.`,
                    link: '/parent/attendance',
                    entitaTipo: 'presenza',
                    entitaId: alunno_id,
                    bufferMin: 10,
                    debounce: true,
                });
            } else if (stato !== 'assente' && prima?.stato === 'assente') {
                // REVOCA: l'appello è stato corretto entro il buffer di 10' e la notifica
                // pending va tolta dalla coda prima che il cron la spedisca.
                //
                // PostgREST non lancia: la `delete` RITORNA `{ error }`. Scartarlo (com'era)
                // rendeva il catch qui sotto codice morto proprio sul ramo che pretendeva di
                // coprire — e il fallimento della revoca è il caso peggiore dei due: il genitore
                // riceve "tuo figlio è stato segnato assente" per un'assenza che la maestra ha
                // già corretto. Non una notifica mancata: una notifica FALSA.
                const { error: revocaErr } = await supabase
                    .from('notifiche')
                    .delete()
                    .eq('tipo', 'assenza_non_comunicata')
                    .eq('entita_id', alunno_id)
                    .is('push_inviata_il', null);

                if (revocaErr) {
                    // `error` benché la risposta sia 200: la riga resta in coda e la push
                    // partirà. Il dato è sbagliato e nessuno può più fermarlo.
                    logEvento('notifica', 'error', {
                        operazione: 'attendance/daily:POST',
                        esito: 'revoca-assenza-fallita',
                        tipo: 'assenza_non_comunicata',
                        stato,
                    }, revocaErr);
                }
            }
        } catch (e) {
            // Rete di sicurezza, non il presidio principale: i due rami qui sopra non lanciano
            // (`notificaEvento` è best-effort per contratto e logga per conto suo; la `delete`
            // ritorna `{ error }`, controllato lì dove nasce). Resta a coprire ciò che può
            // ancora esplodere davvero — un guasto di trasporto — e resta a livello `error`,
            // perché se salta il ramo il genitore non viene avvisato che il figlio non è
            // arrivato a scuola: dato perso, in silenzio, dietro un 200.
            logEvento('notifica', 'error', {
                operazione: 'attendance/daily:POST',
                esito: 'assenza-non-notificata',
                stato,
            }, e);
        }

        return NextResponse.json(result, { status: 200 });
    } catch (err) {
        logErrore({ operazione: 'attendance/daily:POST', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server.' }, { status: 500 });
    }
});
