import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { risolviSezione } from '@/lib/sezioni/risoluzione';
import { restringiASedeRichiesta } from '@/lib/auth/sede-richiesta';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zDataYMD, zOraHHMM, zUuid } from '@/lib/validation/common';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { colonneConMotivo } from '@/lib/presenze/motivo-visibile';
import { aOrarioIso } from '@/lib/presenze/orario';
import { logScrittura } from '@/lib/audit/scrittura';

/**
 * GET /api/attendance/daily?data=YYYY-MM-DD&sezione=<classe>
 * Restituisce le presenze del giorno per la sezione indicata.
 *
 * POST /api/attendance/daily
 * Body: { alunno_id, data, stato, orario_entrata?, orario_uscita? }
 * Upsert diretto su Supabase — bypassa Dexie per dati live nel registro mensile.
 */

/**
 * Le colonne dell'appello del giorno. `giustificazione_testo` è l'unica che non arriva a
 * tutti: la toglie `colonneConMotivo` per chi vede tutte le classi del plesso (vedi
 * `src/lib/presenze/motivo-visibile.ts`).
 */
const COLONNE_APPELLO = [
    'id',
    'alunno_id',
    'data',
    'stato',
    'orario_entrata',
    'orario_uscita',
    'panic_alert',
    'giustificazione_testo',
    'alunni!inner ( id, nome, cognome, classe_sezione )',
] as const;

const getQuerySchema = z.object({
    // default dinamico (oggi) calcolato nell'handler
    data: zDataYMD.optional(),
    // Nessun default a un nome sezione reale: param omesso → '' → risposta vuota.
    sezione: z.string().default(''),
    // L'identità VERA della classe. Il nome resta accettato (shell native già
    // installate, URL salvati) ma porta allo stesso filtro per uuid.
    sectionId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
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
 * dell'anagrafica, il guasto di SCRITTURA e l'eccezione generica raccontano al
 * docente la stessa cosa e devono dirla con le stesse parole; (2) il debito
 * misurato da `errori-con-codice.test.ts` è congelato e può solo essere PAGATO —
 * una quarta copia letterale della stessa risposta lo farebbe crescere dentro il
 * lock che esiste per impedirlo.
 *
 * Il `message` di PostgREST non compare qui: è prosa inglese con dentro nomi di
 * colonne, e resta nel log — che è dove dice *perché*.
 */
const erroreInterno = () =>
    NextResponse.json({ error: 'Errore interno del server.' }, { status: 500 });

/**
 * LE SEI COLONNE CHE LA SCHERMATA DELL'APPELLO USA DAVVERO.
 *
 * `.select()` NUDO È `select *`, e su un UPDATE PostgREST non restituisce ciò che
 * hai scritto: restituisce ciò che C'ERA. La riga di `presenze` ne ha
 * venticinque, e tre non devono uscire da qui:
 *  · `giustificazione_testo` — il motivo che il genitore ha scritto: testo
 *    libero di natura sanitaria di un MINORE (art. 9 GDPR);
 *  · `giustificazione_firma` — il log della firma elettronica del genitore, che
 *    porta la sua email, il suo indirizzo IP e il suo user-agent;
 *  · `note_appello` — la nota interna del docente sul bambino.
 * Nessuno dei tre è mostrato dalla schermata: viaggiavano sul filo e si
 * fermavano nello stato React di chiunque superi `requireDocente` con l'alunno
 * nel proprio scope — quindi anche segreteria e Direzione del plesso.
 *
 * È la TERZA volta che questo ciclo scrive la stessa correzione: `COLONNE_ESITO`
 * in `comunica-assenza`, `.select('id')` in `giustifica`, e ora qui — nel file
 * in cui era già scritto «la correzione era stata applicata al genitore e non al
 * docente… Divulgazione per omissione».
 *
 * Il motivo dell'assenza NON sparisce dal prodotto: arriva alla GET, che è la
 * schermata dove il docente della sezione lo LEGGE (vedi la `select` della GET).
 * Esce dall'eco di un salvataggio, dove nessuno lo guardava.
 */
const COLONNE_ESITO = 'id, alunno_id, data, stato, orario_entrata, orario_uscita';

export const GET = withRoute('attendance/daily:GET', async (request: NextRequest) => {
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    // «Oggi» è quello ITALIANO: il runtime gira in UTC e fra mezzanotte e le
    // due del mattino `toISOString()` restituisce ancora ieri — la maestra
    // aprirebbe l'appello sul giorno precedente e, salvando, ci scriverebbe
    // sopra. Stesso difetto (e stesso rimedio) del cockpit, rilievo T27.
    const data = q.data.data ?? oggiFiscaleISO();
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
        if (!sezione && !q.data.sectionId) return NextResponse.json([]);

        const attive = await resolveScuoleAttive(request, supabase, auth.user);
        // Sede dichiarata dal client ⇒ una sola sede. Dichiararne una non
        // accessibile è un 403 loggato, mai un elenco allargato.
        const sede = restringiASedeRichiesta(attive, q.data.scuola_id, {
            azione: 'attendance/daily:GET', utente: auth.user.id, ruolo: auth.user.role,
        });
        if (sede.response) return sede.response;
        const plessi = sede.plessi ?? [];

        // Scope di sede + identità della classe. `requireDocente` verifica il
        // RUOLO, non il tenant, e la route gira in service-role. Con tre sedi
        // «2 ANNI» esiste sia ad Aversa sia a Cesa: senza il gate, chi ne
        // indovinava il nome otteneva nomi e presenze dei bambini dell'altra sede.
        //
        // `soloSezioniAssegnate` (aggiunto il 2026-07-31, R108): il gate senza
        // opzioni risponde a «di quale sede è questa classe?», non a «questa
        // classe è tua?» — e questa route era citata come il «gemello corretto»
        // pur avendo lo stesso buco. Educator → solo le sue sezioni.
        //
        // Il gate passava e la lettura restava vuota lo stesso: filtrava per
        // NOME su `alunni.classe_sezione`, che il 2026-09-02 divergeva dal nome
        // della sezione su cinque classi di Giugliano. Ora la classe si risolve a
        // uuid una volta sola, in `risolviSezione`.
        const classe = await risolviSezione(supabase, auth.user, { sectionId: q.data.sectionId, nome: sezione }, plessi);
        if (classe.response) return classe.response;
        if (classe.sectionIds.length === 0) return NextResponse.json([]);

        // ─── IL MOTIVO DELL'ASSENZA ARRIVA A CHI LA FAMIGLIA CREDE LO LEGGA ──
        //
        // Sotto il campo «Motivo» il modulo del genitore dichiara: «Il motivo lo
        // leggono le insegnanti della sezione e viene cancellato dopo dodici
        // mesi». Per la PRIMARIA era vero (l'appello lo mostra da sempre); per
        // NIDO e INFANZIA — i due gradi che questo ciclo ha aperto per la prima
        // volta — no: questa `select` non lo restituiva affatto, e nessuna
        // schermata del personale lo mostrava. Si raccoglieva un dato particolare
        // di un minore (art. 9) per una finalità che su due gradi su tre non era
        // realizzabile, e la si dichiarava al momento della raccolta.
        //
        // Delle due strade possibili — mostrarlo, oppure non raccoglierlo dove
        // nessuno lo legge — si è scelta la prima: il motivo SERVE a chi accoglie
        // il bambino la mattina dopo. Arriva quindi qui, dove la riga dell'alunno
        // lo mostra (`StudentAttendanceRow`), e NON nell'eco della POST, dove
        // nessuno lo guardava (vedi `COLONNE_ESITO`).
        //
        // Restano fuori `giustificazione_firma` (email, IP e user-agent del
        // genitore) e `note_appello` (nota interna): non servono a questa
        // schermata, e ciò che non serve non viaggia.
        //
        // ─── E NON ARRIVA A CHIUNQUE (rilievo Q1) ───────────────────────────
        //
        // La frase dice «le insegnanti DELLA SEZIONE», ma `requireDocente`
        // ammette anche admin, coordinator e segreteria, e per loro
        // `soloSezioniAssegnate` non restringe niente: `vedeTutteLeClassi` li
        // fa passare su OGNI classe del plesso. Misurato con un `coordinator`
        // non assegnato: 200, motivo per intero. La colonna si chiede quindi
        // solo per chi la frase nomina — la regola sta in
        // `src/lib/presenze/motivo-visibile.ts`, perché vale identica sulla
        // rotta gemella `primaria/appello:GET`.
        const { data: rows, error } = await supabase
            .from('presenze')
            .select(colonneConMotivo(COLONNE_APPELLO, auth.user))
            .eq('data', data)
            // Per UUID sulla risorsa embedded, non per nome: `classe_sezione` è
            // testo scritto dall'import e può divergere da `sections.name` senza
            // che niente lo dica.
            .in('alunni.section_id', classe.sectionIds)
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
            .select(COLONNE_ESITO)
            .single();

        if (error) {
            // IL `message` DI POSTGREST NON ESCE DA QUI, e fino al 2026-08-08 usciva:
            // la risposta era `{ error: 'Errore salvataggio presenza.', details:
            // error.message }`. Quel messaggio porta nomi di colonna, nomi di VINCOLO
            // (`unique_presenza_giornaliera`), `details` e `hint`: una mappa dello schema
            // consegnata a chiunque superi `requireDocente` — che include la segreteria.
            //
            // Ed è esattamente ciò che la rotta gemella dello stesso lavoro dichiarava di
            // aver tolto («prosa inglese con dentro nomi di colonne, mostrata a un
            // genitore», `parent/presenze/comunica-assenza`): la correzione era stata
            // applicata al genitore e non al docente, in un file che quel commit aveva
            // toccato. Divulgazione per omissione, non per scelta.
            //
            // Il messaggio non si perde: sta tutto intero nel `logErrore` qui sopra, che è
            // dove dice PERCHÉ.
            logErrore({ operazione: 'attendance/daily:POST', stato: 500, evento: 'db' }, error);
            return erroreInterno();
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

        // IL SUCCESSO SI LOGGA — anche dal lato del DOCENTE.
        //
        // Il genitore che comunica un'assenza lascia una riga `info` in
        // `app_log`; il docente che registra l'appello no, e questa è la
        // controparte esatta di quel gesto (AGENTS.md, regola 5: gli eventi
        // critici loggano anche il successo). È la riga che serve quando la POST
        // del genitore risponde 409 «l'appello è già stato fatto»: senza, di
        // quella corsa si vede solo la metà che ha perso.
        //
        // Solo uuid, enumerati e conteggi: `stato` è un enumerato in lista bianca
        // di `redact`, gli uuid passano per forma. Il MOTIVO dell'assenza non
        // compare qui e non deve comparirci mai.
        //
        // `distingui`: `app_log` deduplica per impronta, e l'impronta non
        // contiene il contesto. Senza, l'appello di una classe intera lascerebbe
        // UNA riga a nome del primo bambino segnato — che è esattamente il
        // difetto appena chiuso sulla rotta del genitore. Il volume è quello
        // dell'appello: una riga per (docente, alunno, giorno).
        logEvento('registro', 'info', {
            operazione: 'attendance/daily:POST',
            esito: 'appello-registrato',
            alunno_id,
            presenza_id: (result as { id?: string } | null)?.id ?? null,
            attore_id: auth.user.id,
            stato,
        }, undefined, { distingui: ['alunno_id'] });

        // LA RISPOSTA SI COMPONE, NON SI INOLTRA. Difesa in profondità, non
        // ridondanza: `COLONNE_ESITO` decide cosa viaggia sul filo, questa riga
        // decide cosa esce dall'API — e il giorno in cui qualcuno riallarga la
        // `select` per un motivo suo, la risposta non cambia. La forma è quella
        // che `AttendanceRecord` (StudentAttendanceRow) dichiara.
        const riga = (result ?? {}) as Record<string, unknown>;
        return NextResponse.json({
            id: riga.id ?? null,
            alunno_id: riga.alunno_id ?? alunno_id,
            data: riga.data ?? data,
            stato: riga.stato ?? stato,
            orario_entrata: riga.orario_entrata ?? null,
            orario_uscita: riga.orario_uscita ?? null,
        }, { status: 200 });
    } catch (err) {
        logErrore({ operazione: 'attendance/daily:POST', stato: 500 }, err);
        return erroreInterno();
    }
});


/**
 * ─── PATCH /api/attendance/daily — LA RETTIFICA DI UN ORARIO ─────────────────
 *
 * Body: `{ alunno_id, data, orario_entrata?: 'HH:MM', orario_uscita?: 'HH:MM' }`.
 *
 * ── PERCHÉ NON LA `POST` QUI SOPRA ──────────────────────────────────────────
 *
 * Fino a oggi, nel nido e nell'infanzia, l'orario si poteva solo GUARDARE: il
 * registro scriveva l'ora del TOCCO (`new Date().toISOString()` sul tablet) e non
 * c'era modo di dire che il bambino era arrivato alle 09:40 e non alle 10:15. La
 * primaria lo fa da sempre.
 *
 * La strada corta sarebbe stata riusare la `POST`. Non si può, e non per gusto:
 * quella è un **upsert della riga intera**, e la pagina che la chiama calcola
 * `orario_uscita = stato === 'uscita_anticipata' ? now : null`. Ripassare di lì per
 * cambiare l'ingresso significherebbe AZZERARE l'uscita — e viceversa — oltre a
 * rientrare nel ramo che revoca le notifiche d'assenza già mandate ai genitori.
 * Tre effetti collaterali per un'operazione che ne vuole zero.
 *
 * Una `.update()` non può azzerare la colonna che non nomina. È tutta qui la
 * ragione della porta nuova.
 *
 * ── COSA NON FA ─────────────────────────────────────────────────────────────
 *
 * Non CREA la presenza: un orario senza appello non significa niente, e inventare
 * la riga vorrebbe dire registrare un bambino come presente perché qualcuno ha
 * toccato un campo ora. Riga assente ⇒ 409, con il rimedio scritto nel messaggio.
 */
const patchBodySchema = z
    .object({
        alunno_id: zUuid,
        data: zDataYMD,
        orario_entrata: zOraHHMM.optional(),
        orario_uscita: zOraHHMM.optional(),
    })
    // Un corpo che non nomina nessuno dei due orari non è una rettifica: è una
    // richiesta senza oggetto, e va respinta prima di leggere qualunque cosa.
    .refine(
        (b) => b.orario_entrata !== undefined || b.orario_uscita !== undefined,
        { message: 'Indicare almeno un orario da correggere' },
    );

/** Le sei colonne dell'appello + i due campi che servono a scrivere in sicurezza. */
const COLONNE_RETTIFICA = 'id, alunno_id, data, stato, orario_entrata, orario_uscita, scuola_id, section_id';

export const PATCH = withRoute('attendance/daily:PATCH', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { alunno_id, data } = b.data;

        const supabase = await createAdminClient();

        // LO SCOPE PRIMA DI TUTTO, e prima di qualunque lettura: dopo un diniego
        // `presenze` non deve nemmeno comparire fra le tabelle toccate.
        const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id);
        if (fuoriScope) return fuoriScope;

        const { data: prima, error: erroreLettura } = await supabase
            .from('presenze')
            .select(COLONNE_RETTIFICA)
            .eq('alunno_id', alunno_id)
            .eq('data', data)
            .maybeSingle();

        // «NON C'È» E «NON L'HO POTUTO LEGGERE» NON SONO LA STESSA COSA.
        // PostgREST non lancia (AGENTS.md, regola 7): senza questo ramo un guasto
        // di lettura uscirebbe dalla porta del 409 qui sotto, e al docente si
        // direbbe che l'appello non è stato fatto quando invece non si è potuto
        // leggere. È lo stesso rilievo già scritto nella POST di questo file.
        if (erroreLettura) {
            logErrore({ operazione: 'attendance/daily:PATCH', stato: 500, evento: 'db' }, erroreLettura);
            return erroreInterno();
        }
        if (!prima) {
            return NextResponse.json(
                {
                    error: 'Appello non ancora registrato per questo giorno.',
                    codice: 'APPELLO_NON_REGISTRATO',
                },
                { status: 409 },
            );
        }

        const riga = prima as unknown as Record<string, unknown>;
        const stato = riga.stato as string;

        // Coerenza fra orario e stato. Non è una validazione di FORMA (quella l'ha
        // già fatta zod): è un'incoerenza che si vede solo avendo letto la riga.
        const vuoleEntrata = b.data.orario_entrata !== undefined;
        const vuoleUscita = b.data.orario_uscita !== undefined;
        const entrataAmmessa = stato === 'presente' || stato === 'ritardo' || stato === 'uscita_anticipata';
        const uscitaAmmessa = stato === 'uscita_anticipata';
        if ((vuoleEntrata && !entrataAmmessa) || (vuoleUscita && !uscitaAmmessa)) {
            return NextResponse.json(
                {
                    error: 'Orario non compatibile con lo stato registrato.',
                    codice: 'ORARIO_INCOERENTE',
                },
                { status: 422 },
            );
        }

        // `in` e non `?? null`: è LA differenza fra una patch e un upsert. La
        // colonna che il corpo non nomina non compare nell'aggiornamento, quindi
        // non può essere azzerata.
        const aggiornamento: Record<string, unknown> = { aggiornato_il: new Date().toISOString() };
        if (vuoleEntrata) aggiornamento.orario_entrata = aOrarioIso(data, b.data.orario_entrata as string);
        if (vuoleUscita) aggiornamento.orario_uscita = aOrarioIso(data, b.data.orario_uscita as string);

        const { data: result, error } = await supabase
            .from('presenze')
            .update(aggiornamento)
            .eq('id', riga.id as string)
            // La sede viene dalla riga appena LETTA e verificata, non dalla
            // richiesta: è la forma che `isolamento-sede-coverage` riconosce.
            .eq('scuola_id', riga.scuola_id as string)
            .select(COLONNE_ESITO)
            .single();

        if (error) {
            // Il `message` di PostgREST resta nel log, dove dice PERCHÉ: porta nomi
            // di colonna e di vincolo, cioè una mappa dello schema.
            logErrore({ operazione: 'attendance/daily:PATCH', stato: 500, evento: 'db' }, error);
            return erroreInterno();
        }

        const dopo = (result ?? {}) as Record<string, unknown>;

        /**
         * LA TRACCIA DI CHI HA CORRETTO.
         *
         * La primaria scrive in `audit_scritture_docente` da sempre; lo 0-6 no.
         * Correggere a mano l'orario di un registro — e per i giorni passati — è
         * una **rettifica**: senza questa riga, «l'orario dice 09:10 ma mio figlio
         * era arrivato alle 08:30» non ha risposta.
         *
         * Il diff è pulito PER COSTRUZIONE, non per disciplina: `COLONNE_RETTIFICA`
         * non chiede `giustificazione_testo` né `giustificazione_firma`, quindi non
         * possono finirci — che è l'errore già pagato dalla rotta gemella.
         *
         * Non si audita la POST in questo giro: sono centinaia di righe al giorno di
         * appello ordinario, e mescolarle alle rettifiche renderebbe la tabella meno
         * leggibile proprio per la domanda a cui deve rispondere.
         */
        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'presenze',
            entitaId: riga.id as string,
            azione: 'update',
            scuolaId: riga.scuola_id as string | null,
            sectionId: riga.section_id as string | null,
            valorePrima: {
                stato: riga.stato,
                orario_entrata: riga.orario_entrata,
                orario_uscita: riga.orario_uscita,
            },
            valoreDopo: {
                stato: dopo.stato ?? riga.stato,
                orario_entrata: dopo.orario_entrata ?? null,
                orario_uscita: dopo.orario_uscita ?? null,
            },
        });

        /**
         * ⚠️ `tipo:` e non `campo:`. `campo` NON è in `CHIAVI_IN_CHIARO`
         * (`@/lib/logging/redact`) e uscirebbe come `[redatto:str/…]`; `tipo` sì. E
         * non si allarga quella lista bianca per comodità: è anche il canale con cui
         * `parseBody` registra il corpo grezzo, quindi allargarla aprirebbe testo
         * libero proveniente da qualunque richiesta.
         *
         * L'ORARIO NON COMPARE, in nessun campo: è il dato, non il metadato.
         */
        logEvento('registro', 'info', {
            operazione: 'attendance/daily:PATCH',
            esito: 'orario-rettificato',
            alunno_id,
            entita_id: riga.id as string,
            tipo: vuoleEntrata && vuoleUscita ? 'entrambi' : vuoleEntrata ? 'orario_entrata' : 'orario_uscita',
        });

        // La risposta si COMPONE, non si inoltra: stessa forma della POST, così il
        // client fonde l'una o l'altra senza sapere quale porta ha usato.
        return NextResponse.json({
            id: dopo.id ?? riga.id,
            alunno_id: dopo.alunno_id ?? alunno_id,
            data: dopo.data ?? data,
            stato: dopo.stato ?? stato,
            orario_entrata: dopo.orario_entrata ?? null,
            orario_uscita: dopo.orario_uscita ?? null,
        }, { status: 200 });
    } catch (err) {
        logErrore({ operazione: 'attendance/daily:PATCH', stato: 500 }, err);
        return erroreInterno();
    }
});
