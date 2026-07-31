import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zDataYMD, zUuid } from '@/lib/validation/common';
import { assertClasseNomeInScope, assertSezioneInScope, resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope';
import { CHIAVE_REGISTRO, CHIAVE_REGISTRO_LEGACY, vincoloConflittoAssente } from '@/lib/registro/chiave-orario';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiClassi } from '@/lib/notifiche/destinatari';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

const getQuerySchema = z.object({
    classeSezione: z.string().min(1),
    data: zDataYMD,
});

const postBodySchema = z.object({
    // Identità della sezione: la forma CORRETTA (la stessa di `primaria/registro`).
    // Con `sectionId` il nome-classe e la sede si leggono dalla sezione e non c'è
    // niente da indovinare.
    sectionId: zUuid.optional(),
    // Nome-classe: ammesso per compatibilità, ma NON è più una chiave (con tre
    // sedi «2 ANNI» esiste ad Aversa e a Cesa). Si risolve entro le sedi in
    // perimetro e, se resta ambiguo, si risponde 400.
    classeSezione: z.string().min(1).optional(),
    // Sede DICHIARATA dal client: ha la precedenza sul SedeSelector (stessa
    // precedenza di `resolveScuolaScrittura`). '' = non dichiarata.
    scuolaId: z.union([zUuid, z.literal('')]).nullish(),
    data: zDataYMD,
    // oggi: qualsiasi valore truthy (numero ≠ 0 o stringa non vuota); il CHECK 1..8 resta al DB
    oraLezione: z.union([z.number().refine((n) => n !== 0), z.string().min(1)]),
    materia: z.string().min(1),
    argomento: z.string().nullish(),
    compiti: z.string().nullish(),
    dataConsegnaCompiti: z.union([zDataYMD, z.literal('')]).nullish(),
}).refine((b) => Boolean(b.sectionId || b.classeSezione), {
    error: 'Indicare sectionId (preferito) oppure classeSezione',
    path: ['sectionId'],
});

// GET /api/register/lessons?classeSezione=3A&data=2026-05-13
// Gate docente (M5.6): la route era raggiungibile senza identità post-M4.
export const GET = withRoute('register/lessons:GET', async (request: NextRequest) => {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { classeSezione, data } = q.data;

        const supabase = await createAdminClient();

        // Scope di sede — la POST lo faceva già, la GET no: con tre sedi il nome
        // classe non è una chiave («2 ANNI» sta ad Aversa e a Cesa) e il registro
        // dell'altra sede (argomenti, compiti, firme) era leggibile a chi lo
        // indovinava. Gate + filtro, come nelle route alunni.
        const classeScope = await assertClasseNomeInScope(supabase, auth.user, classeSezione);
        if (classeScope) return classeScope;
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);

        const { data: registroRows, error } = await supabase
            .from('registro_orario')
            .select(`
                id,
                ora_lezione,
                materia,
                argomento,
                compiti,
                data_consegna_compiti,
                media_url,
                firme_docenti (
                    id,
                    maestra_id,
                    tipo_compresenza,
                    firmato_il
                )
            `)
            .eq('classe_sezione', classeSezione)
            .eq('data', data)
            .in('scuola_id', plessi)
            .order('ora_lezione', { ascending: true });

        if (error) {
            logErrore({ operazione: 'register/lessons:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Errore nel recupero delle lezioni', details: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data: registroRows });

    } catch (error) {
        logErrore({ operazione: 'register/lessons:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
})

// POST /api/register/lessons
// Body: { classeSezione, scuolaId, data, oraLezione, materia, argomento, compiti, dataConsegnaCompiti }
// Gate docente (M5.6): scrittura su registro_orario; la firma usa l'identità
// risolta dal gate (niente fallback dev post-M4).
export const POST = withRoute('register/lessons:POST', async (request: NextRequest) => {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    try {
        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { sectionId, classeSezione, scuolaId, data, oraLezione, materia, argomento, compiti, dataConsegnaCompiti } = b.data;

        // Admin client per bypassare RLS (stesso pattern delle altre API del progetto)
        const supabase = await createAdminClient();

        // ── La SEZIONE: un'identità, non un nome ────────────────────────────
        // Fino al 2026-07-31 la sede usciva da `.eq('name', …).limit(1)` — un
        // LIMIT senza ORDER BY, cioè «una qualsiasi» delle omonime — con ultimo
        // ripiego `plessi[0]`. Argomento, compiti e FIRMA della lezione potevano
        // così essere archiviati nel plesso sbagliato, in silenzio: la GET
        // (`resolveScuoleAttive`, cookie-aware) poi non li mostrava nemmeno.
        // Ora: `sectionId` risolve tutto; col solo nome si risolve DENTRO il
        // perimetro e l'ambiguità si NEGA.
        let sezione: { id: string; name: string; scuola_id: string };
        if (sectionId) {
            const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId);
            if (scopeErr) return scopeErr;
            const { data: row, error: sezErr } = await supabase
                .from('sections')
                .select('id, name, scuola_id')
                .eq('id', sectionId)
                .maybeSingle();
            if (sezErr) {
                // PostgREST non lancia: senza questo controllo un guasto di lettura
                // diventerebbe una scrittura senza sede.
                logEvento('registro', 'error', {
                    operazione: 'register/lessons:POST', esito: 'sezione-non-risolta',
                }, sezErr);
                return NextResponse.json({ error: 'Verifica della sezione non riuscita' }, { status: 500 });
            }
            if (!row?.scuola_id) {
                return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 });
            }
            sezione = { id: row.id as string, name: row.name as string, scuola_id: row.scuola_id as string };
        } else {
            // La classe deve appartenere ai plessi del docente (niente scritture su classi altrui)
            const classeScope = await assertClasseNomeInScope(supabase, auth.user, classeSezione);
            if (classeScope) return classeScope;

            // Perimetro di risoluzione del nome. Stessa precedenza di
            // `resolveScuolaScrittura`: la sede DICHIARATA dal client vince (se è
            // fra le sue), altrimenti valgono le sedi attive del SedeSelector —
            // le stesse che usa la GET, così non si scrive dove non si legge.
            const perimetro = scuolaId && (await scuoleDiUtente(supabase, auth.user)).includes(scuolaId)
                ? [scuolaId]
                : await resolveScuoleAttive(request, supabase, auth.user);

            const { data: omonime, error: sezErr } = await supabase
                .from('sections')
                .select('id, name, scuola_id')
                .eq('name', classeSezione as string)
                .in('scuola_id', perimetro);
            if (sezErr) {
                logEvento('registro', 'error', {
                    operazione: 'register/lessons:POST', esito: 'sezione-non-risolta', sezione: classeSezione,
                }, sezErr);
                return NextResponse.json({ error: 'Verifica della sezione non riuscita' }, { status: 500 });
            }
            if ((omonime ?? []).length !== 1) {
                // `warn` → persistito: una scrittura RIFIUTATA sul registro va
                // letta senza risalire al corpo della richiesta. Zero righe =
                // la classe non è nelle sedi selezionate (prima ci si finiva
                // dentro col ripiego `plessi[0]`); più righe = omonimia.
                logEvento('registro', 'warn', {
                    operazione: 'register/lessons:POST',
                    esito: (omonime ?? []).length === 0 ? 'classe-fuori-sedi-attive' : 'classe-omonima-ambigua',
                    sezione: classeSezione,
                    utente: auth.user.id,
                    candidate: (omonime ?? []).length,
                    sedi: perimetro.length,
                });
                return NextResponse.json(
                    { error: 'Specificare la sede (scuola_id o sectionId): il nome della classe non la identifica' },
                    { status: 400 }
                );
            }
            const row = omonime[0];
            sezione = { id: row.id as string, name: row.name as string, scuola_id: row.scuola_id as string };
        }

        const maestraId = auth.user.id;
        const finalScuolaId = sezione.scuola_id;

        // UPSERT su registro_orario. La chiave di conflitto include la SEDE: senza,
        // il «2 ANNI» di Aversa e quello di Cesa scrivevano sulla stessa riga.
        // Vedi `src/lib/registro/chiave-orario.ts` per il perché e per il ripiego
        // sul DB E2E non migrato.
        const riga = {
            scuola_id: finalScuolaId,
            classe_sezione: sezione.name,
            data,
            ora_lezione: oraLezione,
            materia,
            argomento: argomento || null,
            compiti: compiti || null,
            data_consegna_compiti: dataConsegnaCompiti || null,
        };
        let upsertRes = await supabase
            .from('registro_orario')
            .upsert(riga, { onConflict: CHIAVE_REGISTRO })
            .select()
            .single();
        if (vincoloConflittoAssente(upsertRes.error)) {
            logEvento('registro', 'info', {
                operazione: 'register/lessons:POST',
                esito: 'vincolo-per-sede-assente-ripiego-legacy',
            });
            upsertRes = await supabase
                .from('registro_orario')
                .upsert(riga, { onConflict: CHIAVE_REGISTRO_LEGACY })
                .select()
                .single();
        }
        const { data: registroRow, error: registroError } = upsertRes;

        if (registroError) {
            logErrore({ operazione: 'register/lessons:POST', stato: 500, evento: 'db' }, registroError);
            return NextResponse.json({ error: 'Errore nel salvataggio della lezione', details: registroError.message }, { status: 500 });
        }

        // INSERT firma del docente (UPSERT per gestire duplicati)
        const { error: firmaError } = await supabase
            .from('firme_docenti')
            .upsert({
                registro_id: registroRow.id,
                maestra_id: maestraId,
                tipo_compresenza: 'principale',
            }, {
                onConflict: 'registro_id,maestra_id',
            });

        if (firmaError) {
            // Non blocchiamo il flusso: il registro è già salvato — ma il livello è `error`, non
            // `warn`. La FIRMA del docente sulla lezione non è un accessorio: è il dato che
            // certifica chi ha tenuto quell'ora, e la sua assenza si scopre a mesi di distanza,
            // quando il registro va chiuso e una lezione risulta non firmata da nessuno. La
            // richiesta risponde 200, ma una scrittura è andata perduta in silenzio.
            logEvento('db', 'error', {
                operazione: 'register/lessons:POST',
                esito: 'firma-docente-non-registrata',
            }, firmaError);
        }

        // Notifica ai genitori della classe (best-effort) SOLO se ci sono
        // compiti assegnati (l'argomento da solo non è un evento per famiglie).
        // Stesso tipo/toggle del registro primaria; debounce sull'uuid della
        // sezione: i salvataggi ora-per-ora collassano in una notifica sola
        // (entita_id è uuid: niente chiavi sintetiche).
        if (compiti) {
            try {
                const destinatari = await genitoriDiClassi(supabase, finalScuolaId, [sezione.name]);
                await notificaEvento(supabase, {
                    tipo: 'compiti',
                    scuolaId: finalScuolaId,
                    utenteIds: destinatari,
                    titolo: `Compiti assegnati — ${sezione.name}`,
                    corpo: compiti.slice(0, 140),
                    link: '/parent/compiti',
                    entitaTipo: 'registro',
                    entitaId: sezione.id,
                    bufferMin: 10,
                    debounce: true,
                });
            } catch (e) {
                // `error` benché la lezione sia salvata: i compiti sono sul registro ma le
                // famiglie non ricevono l'avviso — cioè il bambino "non aveva compiti". La
                // scrittura principale è salva, l'annuncio è perso.
                logEvento('notifica', 'error', {
                    operazione: 'register/lessons:POST',
                    esito: 'notifica-compiti-non-accodata',
                    tipo: 'compiti',
                }, e);
            }
        }

        return NextResponse.json({ success: true, data: registroRow });

    } catch (error) {
        logErrore({ operazione: 'register/lessons:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
})
