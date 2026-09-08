import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { risolviSezione } from '@/lib/sezioni/risoluzione';
import { restringiASedeRichiesta } from '@/lib/auth/sede-richiesta';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaTitolariScrittura, enqueueDiarioGenitori } from '@/lib/primaria/notifiche';
import { getModuleConfig } from '@/lib/settings/module-config';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento, logErrore } from '@/lib/logging/logger';
import { riconciliaRichieste } from '@/lib/armadietto/richieste';
import { voceDaMostrare } from '@/lib/diary/registrazione';

// Modalità genitore: default from = 14 giorni fa, to = oggi (dinamici, calcolati nel codice).
const getParentQuerySchema = z.object({
    alunno_id: zUuid,
    from: zDataYMD.optional(),
    to: zDataYMD.optional(),
});

// Modalità insegnante/staff: default date = oggi (dinamico, calcolato nel codice).
// Nessun default a un nome sezione reale: param omesso → '' → risposta vuota.
const getTeacherQuerySchema = z.object({
    sezione: z.string().default(''),
    // L'identità VERA della classe. Il nome resta accettato (shell native già
    // installate, URL salvati) ma porta allo stesso filtro per uuid.
    sectionId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
    date: zDataYMD.optional(),
    // La sede scelta nel SedeSelector (R70): il nome-classe da solo non basta più.
    scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
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
    // Nota di SEZIONE: broadcast, identica per tutti i genitori.
    nota_libera: z.unknown().optional(),
    // Nota per SINGOLO bambino (E1): visibile solo al genitore di quel bambino.
    // Colonna dedicata `nota_bambino`, distinta da nota_libera (per non essere
    // sovrascritta dalla nota di sezione). Senza questo campo zod la scarterebbe.
    nota_bambino: z.unknown().optional(),
});

// Il body può essere un singolo evento o un array di eventi.
const postBodySchema = z.union([z.array(entrySchema), entrySchema]);

// GET /api/diary/entries
// Modalità insegnante: ?sezione=<classe>&date=2026-05-12
// Modalità genitore:   ?alunno_id=xxx&from=2026-04-28
//
// P0/S9b (DL-040): tutti gli accessi a `eventi_diario` usano service-role +
// scoping applicativo (End-state X, DL-035), così le policy permissive anon
// sono droppate. Il ramo per alunno è gated con `requireParentOfStudent`:
// identità dalla SESSIONE, poi legame genitore↔figlio al genitore e
// plesso+sezione a chiunque altro.
//
// ⚠️ Il secondo pezzo è arrivato il 2026-07-31, e prima non c'era: questo è il
// ramo su cui la falla è stata MISURATA in produzione. Un educator di Aversa
// chiedeva `?alunno_id=<minore di Giugliano>` e riceveva 200 con quindici voci
// di diario — bagno, pranzo, attività. La query qui sotto filtra solo per
// `alunno_id`, che è un valore scelto dal client: senza il gate non esiste
// nessun altro presidio, perché il client è service-role e la RLS non si
// applica.
export const GET = withRoute('diary/entries:GET', async (request: NextRequest) => {
    const admin = await createAdminClient();
    const params = request.nextUrl.searchParams;

    // ── Modalità genitore: per singolo alunno in un range di date ──
    if (params.get('alunno_id')) {
        const q = parseQuery(request, getParentQuerySchema);
        if ('response' in q) return q.response;
        // Scoping di proprietà (privacy minori): il genitore del bambino, oppure
        // lo staff che ha quel bambino nel proprio plesso (e nella propria
        // sezione, se educator). Chiude la lettura anonima, quella dell'altro
        // genitore e quella cross-sede.
        const gate = await requireParentOfStudent(request, q.data.alunno_id);
        if (gate.response) return gate.response;
        const fromDate = q.data.from ?? (() => {
            const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().split('T')[0];
        })();
        const toDate = q.data.to ?? new Date().toISOString().split('T')[0];

        // Buffer visibilità (come le valutazioni primaria, PRD §4.5): il genitore
        // vede una voce solo trascorsi `buffer_visibilita_min` minuti dalla
        // creazione, così la maestra ha la finestra di correzione. Default 10'.
        const { data: alunno } = await admin
            .from('alunni')
            .select('scuola_id')
            .eq('id', q.data.alunno_id)
            .maybeSingle();
        const diarioCfg = await getModuleConfig<{ buffer_visibilita_min?: number }>(
            admin, 'diario_config', alunno?.scuola_id,
        );
        const bufferMin = diarioCfg.buffer_visibilita_min ?? 10;
        const soglia = new Date(Date.now() - bufferMin * 60_000).toISOString();

        // `nota_bambino` (E1) è la nota riservata al singolo bambino; `nota_libera`
        // resta la nota di sezione (broadcast). Il DB E2E CI non è migrato: se la
        // colonna non esiste la SELECT torna 42703 → riprova senza (degrado pulito).
        const buildParent = (conNotaBambino: boolean) => admin
            .from('eventi_diario')
            .select(conNotaBambino
                ? 'id, tipo_evento, orario_inizio, dettagli, nota_libera, nota_bambino'
                : 'id, tipo_evento, orario_inizio, dettagli, nota_libera')
            .eq('alunno_id', q.data.alunno_id)
            .gte('orario_inizio', `${fromDate}T00:00:00.000Z`)
            .lte('orario_inizio', `${toDate}T23:59:59.999Z`)
            // Nasconde le voci create da meno di `bufferMin` (finestra di correzione).
            .lte('creato_il', soglia)
            .order('orario_inizio', { ascending: false });

        let res = await buildParent(true);
        if (res.error && ['PGRST204', '42703'].includes((res.error as { code?: string }).code ?? '')) {
            logEvento('diary', 'info', {
                operazione: 'diary/entries:GET',
                esito: 'degrado-nota-bambino-assente',
            });
            res = await buildParent(false);
        }
        const { data, error } = res;

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        // Il type-parser di Supabase non modella la SELECT condizionale (degrado
        // nota_bambino → union di due literal) e inferisce un ParserError: la query
        // è corretta a runtime, si normalizza la riga a Record per il map.
        const mapped = ((data ?? []) as unknown as Record<string, unknown>[]).map((e) => ({
            id:                   e.id,
            tipo_evento:          e.tipo_evento,
            timestamp_evento:     e.orario_inizio,
            dettagli:             e.dettagli,
            note:                 e.nota_libera,
            // Solo la nota del PROPRIO bambino (il ramo è già filtrato per alunno_id).
            notaBambino:          (e.nota_bambino as string | null | undefined) ?? null,
            activity_description: null,
        }));
        return NextResponse.json(mapped);
    }

    // ── Modalità insegnante/staff: per sezione + data ──
    // Gate ruolo + gate classe + isolamento per plesso.
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getTeacherQuerySchema);
    if ('response' in q) return q.response;
    const sezione = q.data.sezione;
    const date = q.data.date ?? new Date().toISOString().split('T')[0];
    // Contratto storico: senza sezione la risposta è vuota, non un 400.
    if (!sezione && !q.data.sectionId) return NextResponse.json([]);

    // Rispetta la selezione del SedeSelector (cookie `sedi_attive`), ri-validata
    // contro le sedi accessibili, e la sede eventualmente dichiarata in query.
    const attive = await resolveScuoleAttive(request, admin, auth.user);
    const sede = restringiASedeRichiesta(attive, q.data.scuola_id, {
        azione: 'diary/entries:GET', utente: auth.user.id, ruolo: auth.user.role,
    });
    if (sede.response) return sede.response;
    const plessi = sede.plessi ?? [];
    if (plessi.length === 0) return NextResponse.json([]);

    // GATE per SEZIONE ASSEGNATA prima di leggere gli alunni: `requireDocente`
    // verifica il ruolo, non la classe (R108). Educator → solo le sue sezioni.
    // Il gate passava e l'elenco restava vuoto lo stesso: si filtrava per NOME.
    const classe = await risolviSezione(admin, auth.user, { sectionId: q.data.sectionId, nome: sezione }, plessi);
    if (classe.response) return classe.response;
    if (classe.sectionIds.length === 0) return NextResponse.json([]);

    const { data: alunni } = await admin
        .from('alunni')
        .select('id')
        .in('section_id', classe.sectionIds)
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
});

// POST /api/diary/entries — salva (upsert) eventi diario
// Per ogni alunno+tipo_evento: se già esiste oggi → UPDATE, altrimenti → INSERT
export const POST = withRoute('diary/entries:POST', async (request: NextRequest) => {
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

    // ─────────────────────────────────────────────────────────────────────────
    // LA VOCE MUTA NON ENTRA IN ARCHIVIO, E LA REGOLA STA ANCHE QUI.
    //
    // Non è ridondanza col filtro della schermata: è che quel filtro vive nel
    // CLIENT, e un client si può non aggiornare. Misurato il 2026-09-08, DUE ORE
    // dopo il rilascio del salvataggio selettivo: una maestra ha scritto 19 righe
    // di bagno di cui 17 vuote e senza note, perché il suo tablet aveva l'app
    // aperta da mattina e stava ancora eseguendo il bundle di prima. Tre colleghe,
    // nella stessa finestra, ne hanno scritte zero. La regola va dove nessuno può
    // scavalcarla: nella rotta che possiede la tabella.
    //
    // NON si RIFIUTA la richiesta: le altre righe sono legittime e vanno salvate.
    // Le mute si SALTANO — ed è per questo che il salto si logga: «17 righe non
    // scritte» in silenzio sarebbe il guasto opposto a quello che stiamo chiudendo.
    //
    // `voceDaMostrare` è la stessa funzione dei cinque lettori: una regola sola,
    // e fail-open sui tipi che non ne hanno una (nessun filtro inventato qui).
    // ─────────────────────────────────────────────────────────────────────────
    const daScrivere = entries.filter((e) => voceDaMostrare(
        e.tipo_evento,
        (e.dettagli ?? null) as Record<string, unknown> | null,
        { conNota: Boolean(String(e.nota_libera ?? '').trim() || String(e.nota_bambino ?? '').trim()) },
    ));
    if (daScrivere.length < entries.length) {
        logEvento('diary', 'warn', {
            operazione: 'diary/entries:POST',
            esito: 'voci-mute-saltate',
            n_ricevute: entries.length,
            n_saltate: entries.length - daScrivere.length,
        });
    }

    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    const results = [];
    const errors = [];

    for (const entry of daScrivere) {
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
            // UPDATE — resiliente alla colonna nota_bambino non ancora migrata (DB E2E CI):
            // PGRST204/42703 → rimuove la colonna mancante e riprova. In prod esiste → 0 retry.
            const updateRecord: Record<string, unknown> = {
                dettagli: entry.dettagli ?? null,
                orario_fine: entry.orario_fine ?? null,
                nota_libera: entry.nota_libera ?? null,   // nota di sezione (broadcast a tutti)
                nota_bambino: entry.nota_bambino ?? null, // nota del singolo bambino (E1)
                // activity_description escluso: colonna non ancora migrata
            };
            let updRes = await admin.from('eventi_diario').update(updateRecord).eq('id', existing[0].id).select('id, alunno_id, tipo_evento');
            let uAttempts = 0;
            while (updRes.error && ['PGRST204', '42703'].includes((updRes.error as { code?: string }).code ?? '') && uAttempts < 4) {
                const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(updRes.error.message);
                const col = m?.[1] ?? m?.[2];
                if (!col || !(col in updateRecord)) break;
                delete updateRecord[col];
                updRes = await admin.from('eventi_diario').update(updateRecord).eq('id', existing[0].id).select('id, alunno_id, tipo_evento');
                uAttempts++;
            }
            if (updRes.error) errors.push({ alunno_id: entry.alunno_id, error: updRes.error.message });
            else if (updRes.data) results.push(...updRes.data);
        } else {
            // INSERT — stessa resilienza alla colonna nota_bambino non ancora migrata.
            const insertRecord: Record<string, unknown> = {
                alunno_id: entry.alunno_id,
                // Provenienza operativa = chi registra (anche la segreteria). Non è una firma valutativa.
                maestra_id: auth.user.id,
                tipo_evento: entry.tipo_evento,
                orario_inizio: entry.orario_inizio ?? new Date().toISOString(),
                orario_fine: entry.orario_fine ?? null,
                dettagli: entry.dettagli ?? null,
                nota_libera: entry.nota_libera ?? null,   // nota di sezione (broadcast a tutti)
                nota_bambino: entry.nota_bambino ?? null, // nota del singolo bambino (E1)
                // activity_description escluso: colonna non ancora migrata su Supabase
                pubblicato: false,
            };
            let insRes = await admin.from('eventi_diario').insert(insertRecord).select('id, alunno_id, tipo_evento');
            let iAttempts = 0;
            while (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '') && iAttempts < 4) {
                const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(insRes.error.message);
                const col = m?.[1] ?? m?.[2];
                if (!col || !(col in insertRecord)) break;
                delete insertRecord[col];
                insRes = await admin.from('eventi_diario').insert(insertRecord).select('id, alunno_id, tipo_evento');
                iAttempts++;
            }
            if (insRes.error) errors.push({ alunno_id: entry.alunno_id, error: insRes.error.message });
            else if (insRes.data) results.push(...insRes.data);
        }

        // #9 — Scalo automatico pannolino: ad ogni evento "bagno" scala 1 pannolino
        // dall'armadietto, SOLO per i bambini con flag "usa_pannolino" in anagrafica.
        // Best-effort e idempotente per giorno: non blocca mai il salvataggio del diario.
        if (entry.tipo_evento === 'bagno') {
            try {
                // `scuola_id` insieme a `usa_pannolino`: lo scalo scrive su
                // `armadietto`, e ogni scrittura dichiara la sua sede. Fino al
                // 2026-07-31 questo insert — come gli altri due su `armadietto` —
                // la ometteva, e in produzione la colonna è NULL su tutte le righe.
                const { data: al } = await admin
                    .from('alunni')
                    .select('usa_pannolino, scuola_id')
                    .eq('id', entry.alunno_id)
                    .maybeSingle();

                const scuolaAlunno = (al?.scuola_id as string | undefined) ?? null;
                if (al?.usa_pannolino === true && !scuolaAlunno) {
                    // Sede non risolvibile: si SALTA lo scalo invece di scrivere una
                    // riga senza plesso. Va detto per lo stesso motivo del catch qui
                    // sotto: è una scorta che a fine mese non torna.
                    logEvento('diary', 'warn', {
                        operazione: 'diary/entries:POST',
                        esito: 'scalo-pannolino-saltato-senza-sede',
                    });
                }

                if (al?.usa_pannolino === true && scuolaAlunno) {
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
                            scuola_id: scuolaAlunno,
                            nome_oggetto: 'Pannolini',
                            materiale: 'Pannolini',
                            quantita: 1,
                            quantita_residua: 0,
                            date: today,
                            portato: false, // consumo: sottrae dallo stock aggregato
                            livello_allerta: 5,
                            livello_emergenza: 2,
                        });

                        // Lo scalo è il DATO, la richiesta è la CONSEGUENZA: la
                        // conseguenza non può far fallire il dato. Se la
                        // riconciliazione esplode, il movimento resta scritto e il
                        // cron delle 06:00 rimetterà le cose a posto. Un catch che
                        // non logga sarebbe un bug (AGENTS.md regola 6).
                        //
                        // Dentro il ramo dell'insert e non fuori: qui lo stock è
                        // appena cambiato. Se il pannolino era già stato scalato
                        // oggi (idempotenza per giorno) non c'è nessun movimento
                        // nuovo da riconciliare, e ripassare a ogni evento «bagno»
                        // di ogni bambino della sezione sarebbe solo lavoro inutile
                        // sul database.
                        try {
                            await riconciliaRichieste(admin, { alunnoId: entry.alunno_id });
                        } catch (e) {
                            logErrore({ operazione: 'diary/entries:POST', evento: 'db' }, e);
                        }
                    }
                }
            } catch (e) {
                // Lo scalo del pannolino è un effetto collaterale: se salta, il diario è comunque
                // salvato e la richiesta non deve fallire. Ma «saltato» va detto — è una scorta che
                // non viene scalata, cioè un armadietto che a fine mese non torna, e senza questa
                // riga la discrepanza sarebbe inspiegabile. `warn` e non `error`: il dato principale
                // è salvo. Va in tabella (vaPersistito persiste i warn), che è dove la si conta.
                logEvento('diary', 'warn', {
                    operazione: 'diary/entries:POST',
                    esito: 'scalo-pannolino-saltato',
                }, e);
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
});

// ─────────────────────────────────────────────────────────────────────────────────
// DELETE /api/diary/entries?alunno_id=…&tipo_evento=nanna_inizio&date=YYYY-MM-DD
//
// «Ho segnato la nanna a un bambino per errore.» Fino a oggi non c'era modo di
// disfarlo: nessun handler DELETE esisteva sotto /api/diary, e l'unica via per
// togliere una riga da `eventi_diario` era l'oblio GDPR dell'alunno o il wipe
// dell'ambiente.
//
// PERCHÉ IL VERBO STA QUI. `eventi_diario` è la risorsa di questa rotta. Aggiungere
// il verbo dove la risorsa già vive muove UN solo conteggio dell'inventario di
// `isolamento-sede-coverage` (handlerControllati) invece dei due che costerebbe una
// rotta nuova — e soprattutto tiene le regole di questa tabella in un posto solo.
//
// PERCHÉ NON UNA POST CON `dettagli` VUOTO, che di lock non ne avrebbe mossi affatto:
//  · la riga RESTEREBBE in archivio, invisibile solo perché tre lettori si ricordano
//    di filtrarla. Il quarto lettore che nascerà — un export, un prospetto, un
//    conteggio «quanti hanno dormito» — non se lo ricorderà: è il difetto che stiamo
//    chiudendo, rimandato di un anno;
//  · la POST accoda `enqueueDiarioGenitori`, cioè manderebbe al genitore un push
//    «il diario è aggiornato» per dirgli che una cosa non è successa;
//  · scriverebbe `azione: 'update'` su una cancellazione. `AzioneScrittura` ha già
//    `'delete'`: usare l'altro è una colonna d'audit che mente.
//
// PERIMETRO STRETTO, DI PROPOSITO. `tipo_evento` è un `z.enum`, non una stringa
// libera: il gesto che questa porta serve è «ho sbagliato a segnare», non «cancella
// una riga qualunque del diario».
//
// ⏭️ IL 2026-09-08 LA DECISIONE È PASSATA, ed è quella che la riga qui sotto
// prevedeva. Bagno, pranzo e merenda sono diventati selettivi come la nanna, e con
// il filtro «azzera e risalva» non cancella più niente: la riga resta in archivio
// mentre a schermo i contatori sono a zero e il toast è verde. Per il bagno è
// peggio che per la nanna, perché la riga sbagliata NON è vuota — porta
// `{pipi:2}` — quindi nemmeno il filtro di lettura la rende inerte, e il genitore
// continua a leggere «Ho fatto pipì 2 volte» del figlio di un altro.
//
// L'elenco vive in `@/lib/diary/registrazione` (`TIPI_ELIMINABILI`), insieme a
// quello dei tipi selettivi: sono due facce della stessa decisione e separarle
// significherebbe, un domani, renderne uno selettivo e dimenticare la porta.
// `attivita` è entrata insieme alla sua regola selettiva; `umore` resta fuori
// per una ragione scritta lì.
//
// L'enum si tiene comunque QUI, esplicito e letterale: il gate di una rotta che
// cancella non si legge da una costante importata.
//
// NESSUNA NOTIFICA AL GENITORE, e non è una comodità: il diario ha un buffer di
// visibilità di 10 minuti (vedi il ramo genitore della GET). Una correzione fatta
// subito — il caso reale — il genitore non l'ha mai vista, e avvisarlo significherebbe
// raccontargli un errore che non ha letto.
// ─────────────────────────────────────────────────────────────────────────────────

const deleteQuerySchema = z.object({
    alunno_id: zUuid,
    // Nanna, bagno e pasti: vedi «perimetro stretto» qui sopra. Deve restare
    // allineato a `TIPI_ELIMINABILI` — c'è un lock che lo verifica.
    tipo_evento: z.enum(['nanna_inizio', 'nanna_fine', 'bagno', 'pranzo', 'merenda', 'attivita']),
    // Default dinamico (oggi), calcolato nel codice come fa la GET.
    date: zDataYMD.optional(),
});

export const DELETE = withRoute('diary/entries:DELETE', async (request: NextRequest) => {
    // IL GATE PRIMA DI TUTTO, parametri compresi.
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, deleteQuerySchema);
    if ('response' in q) return q.response;

    const admin = await createAdminClient();

    // Scope: tenant + classe. Un educator può cancellare solo nelle sue sezioni.
    const scopeErr = await assertAlunnoInScope(admin, auth.user, q.data.alunno_id);
    if (scopeErr) return scopeErr;

    const date = q.data.date ?? new Date().toISOString().split('T')[0];
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    // Si legge PRIMA di cancellare: è l'unico momento in cui il valore di prima
    // esiste ancora, ed è ciò che l'audit deve conservare. Con `nota_bambino`
    // dentro: sta sulla stessa riga e sparisce con lei.
    const { data: prima, error: erroreLettura } = await admin
        .from('eventi_diario')
        .select('id, alunno_id, tipo_evento, dettagli, nota_bambino')
        .eq('alunno_id', q.data.alunno_id)
        .eq('tipo_evento', q.data.tipo_evento)
        .gte('orario_inizio', startOfDay)
        .lte('orario_inizio', endOfDay);

    if (erroreLettura) {
        // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo si
        // cancellerebbe alla cieca, e l'audit direbbe «niente c'era prima».
        logErrore({ operazione: 'diary/entries:DELETE', stato: 500, evento: 'diary' }, erroreLettura);
        return NextResponse.json({ error: 'Lettura non riuscita', codice: 'DIARIO_LETTURA_FALLITA' }, { status: 500 });
    }

    const righe = prima ?? [];
    if (righe.length === 0) {
        // Cancellare ciò che non c'è è il risultato voluto, non un errore: un 404
        // farebbe comparire un avviso alla maestra che tocca due volte il cestino.
        return NextResponse.json({ eliminati: 0 });
    }

    const { error } = await admin
        .from('eventi_diario')
        .delete()
        .eq('alunno_id', q.data.alunno_id)
        .eq('tipo_evento', q.data.tipo_evento)
        .gte('orario_inizio', startOfDay)
        .lte('orario_inizio', endOfDay);

    if (error) {
        logErrore({ operazione: 'diary/entries:DELETE', stato: 500, evento: 'diary' }, error);
        return NextResponse.json({ error: 'Cancellazione non riuscita', codice: 'DIARIO_NON_ELIMINATO' }, { status: 500 });
    }

    const { data: al } = await admin
        .from('alunni')
        .select('section_id, scuola_id')
        .eq('id', q.data.alunno_id)
        .maybeSingle();

    await logScrittura(admin, {
        attore: auth.user, entitaTipo: 'diario', azione: 'delete',
        scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null,
        valorePrima: righe, valoreDopo: null,
    });

    return NextResponse.json({ eliminati: righe.length });
});
