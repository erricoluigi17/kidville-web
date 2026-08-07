import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, assertClasseNomeInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { restringiASedeRichiesta } from '@/lib/auth/sede-richiesta';
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
    // La sede scelta nel cockpit (W3-A). Il nome-classe da solo non identifica
    // più una classe: «2 ANNI» esiste ad Aversa E a Cesa, e senza questo l'appello
    // usciva UNITO fra le due, senza dirlo.
    scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
});

const STATI_VALIDI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const;

const postBodySchema = z.object({
    alunno_id: zUuid,
    data: zDataYMD,
    stato: z.enum(STATI_VALIDI),
    orario_entrata: z.string().nullable().optional(),
    orario_uscita: z.string().nullable().optional(),
});

/**
 * Il 500 «non è colpa tua» della POST, in un posto solo.
 *
 * Esiste per due ragioni, e la seconda non è cosmetica: (1) il guasto di lettura
 * dell'anagrafica e l'eccezione generica raccontano al docente la stessa cosa e
 * devono dirla con le stesse parole; (2) il debito misurato da
 * `errori-con-codice.test.ts` è congelato e può solo essere PAGATO — una quarta
 * copia letterale della stessa risposta lo farebbe crescere dentro il lock che
 * esiste per impedirlo.
 *
 * Il `message` di PostgREST non compare qui: è prosa inglese con dentro nomi di
 * colonne, e resta nel log — che è dove dice *perché*.
 */
const erroreInterno = () =>
    NextResponse.json({ error: 'Errore interno del server.' }, { status: 500 });

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

        // Sezione assente → risposta vuota, come da contratto storico di questa
        // route (nessun 400: la UI la chiama anche prima di risolvere la classe).
        if (!sezione) return NextResponse.json([]);

        // Scope di sede: `requireDocente` verifica il RUOLO, non il tenant, e la
        // route gira in service-role. Con tre sedi «2 ANNI» esiste sia ad Aversa
        // sia a Cesa: senza questo, chi ne indovinava il nome otteneva nomi e
        // presenze dei bambini dell'altra sede.
        //
        // `soloSezioniAssegnate` (aggiunto il 2026-07-31, R108): il gate senza
        // opzioni risponde a «di quale sede è questa classe?», non a «questa
        // classe è tua?» — e questa route era citata come il «gemello corretto»
        // pur avendo lo stesso buco. Educator → solo le sue sezioni.
        const scopeErr = await assertClasseNomeInScope(supabase, auth.user, sezione, { soloSezioniAssegnate: true });
        if (scopeErr) return scopeErr;
        const attive = await resolveScuoleAttive(request, supabase, auth.user);
        // Sede dichiarata dal client ⇒ una sola sede. Dichiararne una non
        // accessibile è un 403 loggato, mai un elenco allargato.
        const sede = restringiASedeRichiesta(attive, q.data.scuola_id, {
            azione: 'attendance/daily:GET', utente: auth.user.id, ruolo: auth.user.role,
        });
        if (sede.response) return sede.response;
        const plessi = sede.plessi ?? [];

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
            // Difesa in profondità sul join: il gate impedisce di NOMINARE una
            // classe altrui, il filtro impedisce che l'omonimia ne porti dentro
            // gli alunni comunque.
            .in('alunni.scuola_id', plessi)
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

        // LO SCOPE VALE ANCHE QUI, e prima di ogni scrittura. Fino al 2026-07-31
        // questo handler aveva il solo gate di ruolo: la segreteria di una sede
        // poteva segnare presenze e assenze sui bambini di un'altra, e con
        // `stato:'assente'` partiva pure la notifica «tuo figlio è stato segnato
        // assente» ai genitori dell'altro plesso. Dimostrato in produzione dal
        // collaudo backend (rilievo F1, bloccante).
        // Il lock non l'aveva visto perché cercava l'import a livello di FILE: la
        // GET qui sopra lo scope ce l'aveva, e amnistiava la POST.
        const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id);
        if (fuoriScope) return fuoriScope;

        // Il record nasce completo di scuola/sezione (fonte: anagrafica alunno):
        // le policy scolastiche su presenze e l'aggregato realtime li richiedono.
        //
        // «NON C'È» E «NON L'HO POTUTO LEGGERE» NON SONO LA STESSA COSA.
        // PostgREST non lancia: l'errore torna nel valore (AGENTS.md, regola 7),
        // e il `try/catch` che avvolge questo handler su quel ramo non scatta
        // mai. Senza il controllo, un guasto di lettura usciva dalla porta del
        // 404 qui sotto: al DOCENTE si diceva che il bambino non esiste. E la
        // riga non veniva scritta affatto — cioè veniva a mancare in silenzio
        // proprio `registrato_da`, che è il presidio a cui è appeso
        // l'annullamento dell'assenza comunicata dal genitore.
        const { data: alunno, error: alunnoErr } = await supabase
            .from('alunni')
            .select('nome, scuola_id, section_id')
            .eq('id', alunno_id)
            .maybeSingle();
        if (alunnoErr) {
            logErrore({ operazione: 'attendance/daily:POST', stato: 500, evento: 'db' }, alunnoErr);
            return erroreInterno();
        }
        if (!alunno) {
            return NextResponse.json({ error: 'Alunno non trovato.' }, { status: 404 });
        }

        // Stato precedente del giorno: la notifica di assenza allo 0-6 scatta
        // solo alla PRIMA marcatura 'assente' (i ri-salvataggi non duplicano).
        //
        // Anche qui `{ error }` va guardato, e la conseguenza è DIVERSA da quella
        // sopra: su errore `prima` resta `null`, la condizione
        // `prima?.stato !== 'assente'` diventa vera e la notifica «tuo figlio è
        // stato segnato assente» riparte a OGNI ri-salvataggio dell'appello. Non
        // una notifica mancata: una notifica DUPLICATA su un dato di un minore.
        const { data: prima, error: primaErr } = await supabase
            .from('presenze')
            .select('stato')
            .eq('alunno_id', alunno_id)
            .eq('data', data)
            .maybeSingle();
        if (primaErr) {
            // `warn` e non `error`: il salvataggio prosegue e riesce — degrada la
            // sola notifica. Muto no: senza questa riga «la maestra ha salvato e
            // il genitore non ha ricevuto niente» non ha nessuna spiegazione.
            logEvento('registro', 'warn', {
                operazione: 'attendance/daily:POST',
                esito: 'stato-precedente-non-letto',
                alunno_id,
            }, primaErr);
        }

        const record = {
            alunno_id,
            data,
            stato,
            orario_entrata: orario_entrata ?? null,
            orario_uscita: orario_uscita ?? null,
            scuola_id: alunno.scuola_id,
            section_id: alunno.section_id,
            aggiornato_il: new Date().toISOString(),
            // CHI ha fatto l'appello. Provenienza operativa, non una firma —
            // come nella primaria (`primaria/appello/route.ts`, `registrato_da: userId`).
            //
            // Perché serve, e perché proprio qui: la riga che il genitore scrive
            // comunicando un'assenza porta `giustificata_da`, MAI `registrato_da`.
            // Con questa riga `registrato_da IS NULL` diventa il criterio uniforme
            // su tutti i gradi per «l'insegnante non ha ancora lavorato questa
            // presenza» — la condizione a cui è appeso l'annullamento della
            // comunicazione da parte del genitore. Fino a oggi lo 0-6 non lo
            // scriveva: misurato in produzione il 2026-08-07, 13 righe su 49
            // avevano `registrato_da`, ed erano tutte e sole quelle della primaria.
            //
            // `aggiornato_il` non poteva servire allo scopo: ha `DEFAULT now()` e
            // si valorizza anche sull'INSERT del genitore, quindi non separa i due casi.
            //
            // L'id viene dal GATE, mai dalla richiesta: `presenze.registrato_da` ha
            // una FK verso `utenti(id)`, e `requireDocente` → `loadAppUser` restituisce
            // l'`id` letto DALLA riga di `utenti`. Se il gate è passato, la chiave
            // esterna è per costruzione soddisfatta.
            registrato_da: auth.user.id,
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
        //
        // ─── IN DUBBIO NON SI SPEDISCE, IN DUBBIO SI REVOCA ─────────────────
        //
        // Quando lo stato precedente non si è potuto leggere (`primaErr`) le due
        // direzioni NON si trattano allo stesso modo, ed è una decisione, non
        // una svista:
        //  · non si SPEDISCE — una seconda «tuo figlio è stato segnato assente»
        //    per lo stesso giorno è peggio di nessuna: il genitore non ha modo di
        //    capire quale delle due sia vera, e la riga di `warn` qui sopra dice
        //    perché non è partita;
        //  · si REVOCA lo stesso — togliere dalla coda una notifica che sarebbe
        //    FALSA (l'appello è stato corretto) non costa niente su una coda
        //    vuota, e su una coda piena salva un genitore da un allarme già
        //    rientrato.
        // L'asimmetria è tutta qui: sbagliare per eccesso di silenzio costa una
        // notifica, sbagliare per eccesso di zelo costa la fiducia in tutte.
        try {
            if (stato === 'assente' && !primaErr && prima?.stato !== 'assente') {
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
            } else if (stato !== 'assente' && (primaErr || prima?.stato === 'assente')) {
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
        return erroreInterno();
    }
});
