import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireStaff } from '@/lib/auth/require-staff';
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "eFamiglia" export is defined on the mock`.
import { agisceComeGenitore, eFamiglia } from '@/lib/auth/predicati-ruolo';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami';
import { resolveScuoleAttive, resolveScuolaScrittura, scuoleDiUtente } from '@/lib/auth/scope';
import { sezioniDiNome } from '@/lib/sezioni/risoluzione';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { alunniSenzaConsenso } from '@/lib/gallery/privacy';
import { assertTagStudentsInScope } from '@/lib/gallery/tag-scope';
import { firmaMediaGalleria, percorsoNelBucket } from '@/lib/gallery/storage';
import { alunniTaggatiDellaSede, assertAlunnoNellaSede, risolviSedeDellaVista } from '@/lib/gallery/vista-sede';
import { proiettaPerGenitore } from './proiezione';
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede';
// IL CESTINO — la regola sta in UN posto, e non è questo file.
// `soloVive` / `soloNelCestino` / `ancheNelCestino` sono le tre domande che si
// possono porre a `galleria_media_v2` dopo il 2026-09-11, e `colonnaCestinoAssente`
// riconosce l'impianto su cui quelle colonne non ci sono ancora (il DB E2E della
// CI). Riscriverle qui a mano — un `.is('eliminato_il', null)` per ogni lettura —
// sarebbe la sesta copia di una condizione di visibilità in una rotta che ne ha
// già perse due per strada (il filtro di sede nella POST, poi nel PATCH).
import { ancheNelCestino, colonnaCestinoAssente, soloNelCestino, soloVive } from '@/lib/gallery/cestino';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
import { logScrittura } from '@/lib/audit/scrittura';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getQuerySchema = z.object({
    studentId: zUuid.optional(),
    // Fallback storico senza vincolo di formato: se il legame non esiste → 403.
    parentId: z.string().optional(),
    classe: z.string().optional(),
    // Storicamente senza vincolo di formato (concatenata in un timestamp ISO).
    date: z.string().optional(),
    // Clamp storico preservato nell'handler (default 30, max 100, garbage → 30):
    // NON zPaginazione, che cambierebbe default e limiti.
    limit: z.string().optional(),
    offset: z.string().optional(),
    // ─── LA VISTA DI SEDE (segreteria) ───────────────────────────────────────
    // `scope=sede` è l'unica modalità che legge la galleria di un PLESSO INTERO,
    // ed è riservata a `requireStaff`. `z.literal` e non `z.string()`: un valore
    // sconosciuto («scope=tutto») deve essere un 400 esplicito, non un ripiego
    // silenzioso sul comportamento storico.
    scope: z.literal('sede').optional(),
    scuolaId: zUuid.optional(),
    // ─── IL CESTINO, E UN SOLO PARAMETRO PER DIRLO ────────────────────────────
    // `stato=cestino` è la stessa lettura di `scope=sede` con una condizione
    // rovesciata: le foto messe nel cestino invece di quelle vive. UN parametro
    // e non una quarta modalità, perché tutto il resto — isolamento di sede,
    // firma dei link, `alunni_taggati`, paginazione, degrado — deve restare lo
    // STESSO codice: su questa rotta ogni copia di una regola di visibilità è
    // già costata una falla (il filtro di sede dei tag, corretto due volte in
    // tre giorni perché viveva in due posti).
    //
    // `.default('vive')` e non `.optional()`: così il ramo «vive» è una scelta
    // dichiarata in ogni chiamata, e nessuna lettura resta senza filtro per
    // omissione. `z.enum` chiude la porta ai valori inventati: `stato=tutti`
    // è un 400, non un ripiego silenzioso su ciò che fa più comodo.
    stato: z.enum(['vive', 'cestino']).default('vive'),
});

/**
 * `scope` e `scuolaId` viaggiano INSIEME, o il 400 lo dice.
 *
 * ⚠️ `z.object` NON è strict: i campi fuori schema li scarta **in silenzio**, ed
 * è già costato tre incidenti in questo repo. Senza questa regola uno
 * `?scuolaId=<uuid>` scritto senza `scope=sede` verrebbe letto, ignorato e
 * dimenticato: il chiamante crederebbe di aver dichiarato una sede, il server
 * risponderebbe 400 «specificare la classe o l'alunno» — o peggio, con `classe`
 * accanto, un 200 su un perimetro diverso da quello chiesto.
 *
 * L'altro verso è la porta stessa: `scope=sede` senza `scuolaId` è la richiesta
 * «dammi tutte le foto» senza dire di dove, cioè esattamente ciò che il 400
 * storico di questa rotta esiste per impedire.
 */
const getQuerySchemaCoerente = getQuerySchema.superRefine((q, ctx) => {
    if (q.scope === 'sede' && !q.scuolaId) {
        ctx.addIssue({
            code: 'custom',
            path: ['scuolaId'],
            message: 'Con scope=sede la sede va dichiarata: manca scuolaId',
        });
    }
    if (q.scuolaId && q.scope !== 'sede') {
        ctx.addIssue({
            code: 'custom',
            path: ['scope'],
            message: 'scuolaId si usa solo con scope=sede',
        });
    }
    // `parentId` è il fallback storico della vista FAMIGLIA (e serve solo a
    // farsi negare 403 se il legame non esiste). Nella vista di sede non filtra
    // niente: accettarlo e ignorarlo sarebbe la stessa bugia di `scuolaId`
    // scartato in silenzio, un parametro in meno.
    if (q.parentId && q.scope === 'sede') {
        ctx.addIssue({
            code: 'custom',
            path: ['parentId'],
            message: 'parentId non si usa con scope=sede',
        });
    }
    // IL CESTINO SI GUARDA SOLO DALLA VISTA DI SEDE, e la porta è questa riga.
    // `scope=sede` porta con sé `requireStaff` (non `requireDocente`: una maestra
    // resta alle sue classi), la sede DICHIARATA e il 403 `SEDE_NON_ACCESSIBILE`
    // di `risolviSedeDellaVista`. Il cestino contiene foto di minori che qualcuno
    // ha deciso di togliere dalla vista — fra cui, per definizione, quelle
    // rimosse dopo una segnalazione — quindi è la lettura che va guardata meno di
    // tutte: farla passare dal ramo del genitore (`studentId`) o da quello della
    // classe (`classe`) vorrebbe dire mostrare a una famiglia, o a una collega,
    // esattamente ciò che è stato nascosto. Senza `scope=sede` è un 400 di
    // validazione, prima del gate e prima del database.
    if (q.stato === 'cestino' && q.scope !== 'sede') {
        ctx.addIssue({
            code: 'custom',
            path: ['stato'],
            message: 'stato=cestino si usa solo con scope=sede',
        });
    }
});

const postBodySchema = z.object({
    // `uploaded_by` dal client è volutamente ignorato (si usa l'utente del gate).
    file_url: z.string().min(1, 'file_url è obbligatorio'),
    file_type: z.string().nullish(),
    caption: z.string().nullish(),
    // `zUuid` e non `z.string()` (2026-08-03). Era «lasco: oggi nessun vincolo
    // uuid sugli id taggati», e la conseguenza non era estetica: un id
    // malformato arrivava intatto a `.in('id', ['pippo'])`, Postgres esplodeva
    // sul cast (`22P02`), il gate lo raccoglieva su `{ error }` e rispondeva
    // **500**. Fail-closed — nessuna fuga — ma un 500 dice «guasto nostro» su
    // una richiesta sbagliata: sposta la colpa e sporca il segnale che serve a
    // trovare i guasti veri. Il posto giusto per un id malformato è un 400 di
    // validazione, prima di toccare il database.
    tag_students: z.array(zUuid).nullish(),
    is_broadcast: z.boolean().nullish(),
    target_classes: z.array(z.string()).nullish(),
    // Sede (tenant) di pubblicazione. Facoltativa nello schema perché chi ha un
    // solo plesso non ha niente da scegliere: è `resolveScuolaScrittura` a
    // renderla obbligatoria — e a rispondere 400 — quando i plessi sono più
    // d'uno e nessuno è indicato né selezionato nel SedeSelector.
    scuola_id: zUuid.nullish(),
});

const deleteQuerySchema = z.object({
    id: zUuid,
    // Retro-compatibilità: i client storici lo mandano ancora in query, ma
    // l'identità viene SOLO dal gate (`requireDocente`). Il valore è tollerato
    // ma IGNORATO come identità (anti-spoof): un `?userId=` arbitrario non può
    // più impersonare un admin per cancellare foto di minori.
    userId: z.string().optional(),
});

const patchBodySchema = z.object({
    id: zUuid,
    // Retro-compatibilità: i client storici lo mandano ancora, ma l'identità
    // viene SOLO dal gate (il valore del body è ignorato, anti-spoof).
    userId: zUuid.optional(),
    // Gemello dello schema della POST: gli id taggati sono uuid, e un id
    // malformato è un 400 di validazione, non un 500 dal cast di Postgres.
    tag_students: z.array(zUuid).nullish(),
    is_broadcast: z.boolean().nullish(),
    target_classes: z.array(z.string()).nullish(),
    caption: z.string().nullish(),
});

// GET /api/gallery?studentId=xxx&classe=xxx&date=YYYY-MM-DD&limit=30&offset=0
// Lista media con filtri (studentId per genitore, classe per insegnante).
// Filtri e paginazione applicati in SQL (.or + .range): niente scarico dell'intera
// tabella con filtro/slice in memoria. Contratto risposta: { media, total, limit, offset }
// (`limit`/`offset` aggiunti il 2026-09-05: il clamp qui sotto è SILENZIOSO, e un
// client che chiede 5000 righe e ne riceve 100 deve poterlo sapere).
//
// ─── E DAL 2026-09-05 ANCHE LA GALLERIA DI UNA SEDE INTERA ───────────────────
// `?scope=sede&scuolaId=<uuid>` — la vista della segreteria: tutte le foto del
// proprio plesso, filtrabili per classe, per bambino e per data, dalla più
// recente. Gate `requireStaff` (admin/coordinatore/segreteria: chi insegna resta
// alla propria classe) e sede **dichiarata**, mai dedotta. Il resto della lettura
// — filtri, paginazione, degrado, firma dei link — è lo STESSO codice delle due
// modalità storiche: una terza copia sarebbe la terza occasione di correggerne
// una e dimenticarne due.
export const GET = withRoute('gallery:GET', async (request: Request) => {
    try {
        const q = parseQuery(request, getQuerySchemaCoerente);
        if ('response' in q) return q.response;
        const { studentId, classe, date, scuolaId, stato } = q.data;
        // Lo schema garantisce che `scope === 'sede'` implichi `scuolaId`, e
        // viceversa: da qui in giù `vistaSede` è l'unica domanda da porsi.
        const vistaSede = q.data.scope === 'sede';
        // …e lo schema garantisce anche che `stato === 'cestino'` implichi
        // `scope === 'sede'`: `vistaCestino` è sempre un sottoinsieme di
        // `vistaSede`, gate e isolamento compresi.
        const vistaCestino = stato === 'cestino';
        const limit = Math.min(Math.max(parseInt(q.data.limit ?? '30') || 30, 1), 100);
        const offset = Math.max(parseInt(q.data.offset ?? '0') || 0, 0);

        // Gate identità: mai più lettura anonima. Con studentId il gate verifica
        // anche che quel bambino sia raggiungibile da chi chiede — legame di
        // famiglia per il genitore, plesso e sezione per tutti gli altri (401
        // anonimo / 403 figlio altrui o bambino di un'altra sede); senza
        // studentId (lista/classe) la lettura è riservata a staff/docente.
        //
        // La vista di sede ha il SUO gate, e viene per primo: `requireStaff`.
        // Non `requireDocente`, che ammette anche `educator`: una maestra vede le
        // sue classi, non l'intero plesso — e non `requireParentOfStudent`
        // nemmeno quando arriva `studentId`, perché lì quel parametro non è
        // «mio figlio», è un FILTRO su un elenco di lavoro.
        const auth = vistaSede
            ? await requireStaff(request)
            : studentId
                ? await requireParentOfStudent(request, studentId)
                : await requireDocente(request);
        if (auth.response) return auth.response;

        // Genitore: il parentId storico in query deve coincidere con l'identità
        // reale del gate (anti-IDOR sul parametro; il legame è già verificato).
        //
        // PRESENTAZIONE, non autorizzazione: la domanda è «stai facendo
        // self-service dal telefono, in veste di famiglia?». In quella vista il
        // `parentId` non può che essere il proprio. Chi guarda in veste di lavoro
        // usa lo stesso parametro come FILTRO legittimo, e resta coperto dal
        // controllo di legame `genitoreHasFiglio(parentId, studentId)` poche righe
        // più sotto: con `eFamiglia` qui si toglierebbe a una docente-genitore un
        // filtro del suo mestiere senza guadagnare un grammo di sicurezza.
        if (agisceComeGenitore(auth.user) && q.data.parentId && q.data.parentId !== auth.user.id) {
            return NextResponse.json(
                { error: 'Non sei autorizzato a visualizzare i media di questo studente' },
                { status: 403 }
            );
        }

        const supabase = await createAdminClient();

        // Validazione genitore-studente PRIMA di leggere i media.
        // `genitoreHasFiglio` fa l'UNIONE delle due sorgenti storiche: la sola
        // `legame_genitori_alunni` rispondeva 403 ai genitori arrivati dall'import
        // iscrizioni, che hanno il legame solo in `student_parents` (anagrafica).
        // Il gate non si allenta: chi non è collegato in NESSUNA delle due resta 403.
        if (studentId) {
            const parentId = q.data.parentId;
            if (parentId) {
                const collegato = await genitoreHasFiglio(supabase, parentId, studentId);
                if (!collegato) {
                    return NextResponse.json(
                        { error: 'Non sei autorizzato a visualizzare i media di questo studente' },
                        { status: 403 }
                    );
                }
            }
        }

        // Scope per sede (tenant) — fix D3: la galleria è isolata per plesso.
        //  - docente (classe): le sedi ATTIVE dell'utente (SedeSelector → cookie,
        //    ri-validate server-side contro le sedi accessibili; mai cross-tenant).
        //  - genitore (studentId): la sede del FIGLIO, così vede solo i broadcast e
        //    i media della sua sede (classi omonime di sedi diverse non collidono).
        //
        // ⚠️ SENZA UNO DEI DUE PARAMETRI LO SCOPE NON ESISTE, e non esiste
        // nemmeno una «lista di default». Tutti i campi dello schema zod sono
        // opzionali, quindi fino al 2026-07-31 `GET /api/gallery` nudo passava la
        // validazione, superava il gate (basta un educator), lasciava `plessi`
        // a `[]` e — per via della guardia `if (plessi.length > 0)` più sotto —
        // usciva SENZA NESSUN filtro: i 30 media più recenti di TUTTE le sedi,
        // con `tag_students` e `caption`. Scope non calcolato ⇒ si nega.
        //
        // ⚠️ E RESTA IN PIEDI: `!vistaSede` non è un'esenzione, è il modo in cui
        // la terza modalità paga il pedaggio invece di aggirarlo. Il muro
        // esisteva perché senza classe né alunno lo scope di sede non si poteva
        // CALCOLARE; `scope=sede` non lo calcola nemmeno lui — se lo fa
        // DICHIARARE, e `risolviSedeDellaVista` lo verifica contro i plessi di
        // chi chiede. Chi non dichiara niente continua a prendersi il 400.
        if (!vistaSede && !classe && !studentId) {
            return NextResponse.json(
                { error: 'Specificare la classe (classe) o l\'alunno (studentId)' },
                { status: 400 }
            );
        }
        let plessi: string[] = [];
        if (vistaSede) {
            // La sede dichiarata, intersecata con i plessi di chi chiede. Il
            // ramo NON è condizionato a `classe`/`studentId`: nella vista di
            // sede quei due sono FILTRI dentro un perimetro già stabilito, non
            // il perimetro stesso.
            const sede = await risolviSedeDellaVista(supabase, auth.user, scuolaId);
            if (sede.response) return sede.response;
            plessi = sede.plessi;
            // Un bambino di un altro plesso non porterebbe indietro niente
            // comunque (i media sono già ristretti a `plessi`), ma tacere
            // vorrebbe dire rispondere «questo bambino non ha foto» a chi sta
            // guardando nel plesso sbagliato. Qui il 200 vuoto costa troppo.
            if (studentId) {
                const fuori = await assertAlunnoNellaSede(supabase, studentId, plessi);
                if (fuori) return fuori;
            }
        } else if (classe) {
            plessi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user);
        } else if (studentId) {
            const { data: alunno, error: alErr } = await supabase
                .from('alunni')
                .select('scuola_id')
                .eq('id', studentId)
                .maybeSingle();
            if (alErr) {
                logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, alErr);
                return NextResponse.json({ error: alErr.message }, { status: 500 });
            }
            const sedeFiglio = (alunno?.scuola_id as string | null | undefined) ?? null;
            if (!sedeFiglio) {
                // Un alunno senza plesso non è isolabile: non c'è modo di dire di
                // quale sede siano le sue foto. `warn` → persistito, perché è un
                // dato anagrafico rotto, non una richiesta sbagliata dell'utente.
                logEvento('galleria', 'warn', {
                    operazione: 'gallery:GET',
                    esito: 'alunno-senza-sede',
                });
                return NextResponse.json(
                    { error: 'Alunno senza plesso: galleria non disponibile' },
                    { status: 403 }
                );
            }
            plessi = [sedeFiglio];
            // Per lo STAFF la sede del BAMBINO non è lo scope dell'operatore: va
            // intersecata con le sue. Questa riga è nata il 2026-07-31 come
            // tampone locale, quando `requireParentOfStudent` verificava il
            // legame SOLO al genitore e la segreteria di un plesso leggeva le
            // foto di un minore di un altro chiedendone l'uuid; il gate ora fa
            // quel controllo per tutte e venti le route, ma l'intersezione qui
            // NON è ridondante e resta: `scuoleDiUtente` (dentro il gate) dice
            // quali plessi l'operatore PUÒ vedere, `resolveScuoleAttive` quali ha
            // effettivamente SELEZIONATO nel SedeSelector. Sono due domande
            // diverse, e questa route deve rispettare anche la seconda.
            // Il genitore resta fuori: la sua sede sono i FIGLI, non il plesso
            // scritto sul suo record.
            //
            // ⚠️ AUTORIZZAZIONE, NON PRESENTAZIONE — e la differenza si misura in
            // foto che spariscono. Qui c'era `auth.user.role !== 'genitore'`, cioè
            // la VESTE (cookie `kv-active-role`), mentre il gate a monte
            // (`requireParentOfStudent`) biforca sul LEGAME: fa passare una
            // docente-genitore sul PROPRIO figlio anche fuori dalle sezioni che
            // insegna e anche in un'altra sede. Con i due criteri disallineati il
            // permesso veniva concesso e poi svuotato qui sotto:
            // `attive = [sede dove insegno]`, `sedeFiglio = [altra sede]`,
            // intersezione vuota, `plessi = []`, risposta **200 con `media: []`**.
            // In produzione esiste un legame di questa forma, e un 200 vuoto non
            // lascia né un errore né un log: solo una galleria vuota.
            //
            // `agisceComeGenitore` NON sarebbe stato un rimedio: è la stessa
            // condizione, scritta con un nome più bello. «Essere famiglia» è una
            // proprietà del DATABASE — `eFamiglia`, che legge i ruoli reali.
            //
            // Il prezzo, dichiarato: chi ha il ponte `parents` non vede più
            // applicato il proprio SedeSelector su QUESTA lettura. È una
            // preferenza di visualizzazione, non un permesso — i permessi li ha
            // già decisi il gate — e riguarda le quattro persone con il doppio
            // profilo. Per chi famiglia non è, l'intersezione resta identica: è
            // ciò che impedisce alla segreteria di un plesso di leggere le foto di
            // un minore di un altro, e ha una controprova sua in
            // `gallery-scope.test.ts` (f).
            if (!eFamiglia(auth.user)) {
                const attive = await resolveScuoleAttive(request as NextRequest, supabase, auth.user);
                plessi = attive.includes(sedeFiglio) ? [sedeFiglio] : [];
            }
        }

        // Insegnante: alunni della classe RISTRETTI ai plessi accessibili. Senza
        // questo scope `.eq('classe_sezione', classe)` prendeva anche gli omonimi
        // di un'altra sede → tag cross-tenant nella `.or()` dei media (bug D3).
        // Il filtro è INCONDIZIONATO: `plessi` vuoto significa «nessuna sede in
        // scope», e `.in('scuola_id', [])` risponde giustamente niente. La
        // guardia `if (plessi.length > 0)` che stava qui faceva l'opposto —
        // scope vuoto ⇒ nessun filtro ⇒ tutte le sedi.
        //
        // ⚠️ Qui la classe resta identificata per NOME in ingresso, e non è una
        // dimenticanza: poche righe più sotto lo stesso `classe` serve a
        // `target_classes.cs.{…}` — i destinatari di un broadcast, che per
        // progetto sono NOMI e restano tali. Quello che cambia è come si trovano
        // i BAMBINI: il nome si traduce in uuid con `sezioniDiNome`, e la
        // lettura filtra `section_id`. Prima confrontava `alunni.classe_sezione`
        // per uguaglianza esatta, e uno spazio di differenza dal nome della
        // sezione bastava a non taggare nessuno.
        let studentIds: string[] = [];
        if (classe) {
            const sezioni = await sezioniDiNome(supabase, classe, plessi);
            if (sezioni.length === 0) {
                // Il nome non corrisponde a nessuna sezione dei plessi in scope.
                // Non è un errore del server e non cambia la risposta (resta la
                // condizione broadcast, che per progetto viaggia per NOME), ma
                // non può restare muto: il 2026-09-02 cinque classi di Giugliano
                // sono uscite vuote o parziali proprio così — 200, nessun log, e
                // una schermata bianca che sembrava «non ci sono foto».
                logEvento('galleria', 'warn', {
                    operazione: 'gallery:GET',
                    esito: 'classe-non-risolta',
                    // Il nome della classe NON si logga: la redazione è a lista
                    // bianca e non la si allarga «perché sarebbe comodo
                    // vederlo». Per ritrovare la riga bastano il conteggio dei
                    // plessi in scope e l'ora.
                    sedi: plessi.length,
                });
            }
            const alunniQ = supabase
                .from('alunni')
                .select('id')
                .in('section_id', sezioni)
                .in('scuola_id', plessi);
            const { data: students, error: stErr } = await alunniQ;
            if (stErr) {
                logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, stErr);
                return NextResponse.json({ error: stErr.message }, { status: 500 });
            }
            studentIds = (students?.map(s => s.id) ?? []).filter(id => UUID_RE.test(id));
        }

        // Builder dei media. Due interruttori, e servono ENTRAMBI al degrado del
        // DB E2E della CI, che non è migrato: `conScuola=false` toglie il filtro
        // di sede (colonna `scuola_id` assente → 42703), `conCestino=false`
        // toglie il filtro del cestino (colonne `eliminato_il`/`file_rimosso_il`
        // assenti → 42703). Sono due degradi distinti perché sono due colonne
        // distinte, e perché sbagliare a indovinare quale manca significa
        // spegnere un isolamento che invece c'era.
        const buildMedia = (conScuola: boolean, conCestino: boolean) => {
            // LE FOTO VIVE, O QUELLE NEL CESTINO: mai le due cose insieme, e mai
            // per omissione. `soloVive` è ciò che rende «Elimina» immediato in
            // TUTTE E TRE le modalità di lettura (famiglia, classe, sede) con una
            // riga sola; la policy RLS della migrazione fa la stessa cosa per chi
            // legge la tabella senza passare da qui.
            //
            // ⚠️ La tabella è nominata TRE VOLTE, e non è una svista da accorpare
            // in un `if` dopo la catena: il lock
            // `__tests__/architecture/cestino-galleria-ogni-lettura-dichiara.test.ts`
            // misura la SINGOLA query, e un filtro applicato «da qualche parte più
            // sotto» è per lui indistinguibile da un filtro dimenticato. Ha
            // ragione: è esattamente così che si perde una lettura su otto.
            let query = !conCestino
                ? ancheNelCestino(
                    supabase.from('galleria_media_v2').select('*', { count: 'exact' }),
                    'degrado del DB E2E della CI, che non e migrato: le colonne del cestino non esistono e un filtro senza via duscita spegnerebbe la galleria intera invece di mostrare meno',
                )
                : vistaCestino
                    ? soloNelCestino(supabase.from('galleria_media_v2').select('*', { count: 'exact' }))
                    : soloVive(supabase.from('galleria_media_v2').select('*', { count: 'exact' }));

            // L'ORDINE DEL CESTINO È QUELLO DELL'ELIMINAZIONE, non dello scatto.
            // Chi apre il cestino cerca «la foto che ho appena buttato», e su
            // 1318 righe una foto di settembre eliminata oggi finirebbe sotto
            // decine di foto di ottobre eliminate la settimana scorsa.
            query = vistaCestino && conCestino
                ? query.order('eliminato_il', { ascending: false })
                : query.order('created_at', { ascending: false });

            if (date) {
                query = query
                    .gte('created_at', `${date}T00:00:00.000Z`)
                    .lte('created_at', `${date}T23:59:59.999Z`);
            }

            // Isolamento per sede (in AND con i filtri broadcast/tag sotto).
            // Incondizionato: `conScuola=false` esiste SOLO per il degrado su
            // colonna assente, e quel degrado ora è a sua volta condizionato.
            if (conScuola) {
                query = query.in('scuola_id', plessi);
            }

            // Genitore: media broadcast (semantica storica) o con il figlio taggato.
            //
            // ⚠️ NELLA VISTA DI SEDE NO, e la differenza non è estetica: lì
            // `studentId` è un FILTRO scelto in una tendina («fammi vedere le
            // foto di questo bambino»), e i broadcast — che sono comunicazioni
            // a un'intera classe o all'intera sede, per progetto senza tag —
            // non sono foto di quel bambino. Tenere la semantica di famiglia
            // riempirebbe il filtro di righe che il bambino non ritraggono, cioè
            // farebbe mentire il filtro.
            if (studentId) {
                query = vistaSede
                    ? query.contains('tag_students', [studentId])
                    : query.or(`is_broadcast.eq.true,tag_students.cs.{${studentId}}`);
            }

            // Insegnante: broadcast destinati alla classe o media con alunni della classe taggati.
            if (classe) {
                const classeSafe = classe.replace(/[(){}",\\]/g, '');
                const broadcastCond = `and(is_broadcast.eq.true,target_classes.cs.{"${classeSafe}"})`;
                query = query.or(
                    studentIds.length > 0
                        ? `${broadcastCond},tag_students.ov.{${studentIds.join(',')}}`
                        : broadcastCond
                );
            }

            return query.range(offset, offset + limit - 1);
        };

        // ─── I DUE DEGRADI, E PERCHÉ NON SI DISTINGUONO A OCCHIO ─────────────
        //
        // Su questa lettura possono mancare DUE colonne diverse: `scuola_id` (il
        // filtro di sede) e `eliminato_il` (il cestino). PostgREST le annuncia
        // con lo STESSO codice — `42703` in SELECT, `PGRST204` in scrittura — che
        // dice «una colonna non c'è», mai QUALE: `colonnaSedeAssente` e
        // `colonnaCestinoAssente` guardano lo stesso insieme di codici, quindi
        // sono lo stesso predicato con due nomi, e nessuno dei due può decidere
        // da solo cosa togliere.
        //
        // Perciò qui non si indovina: si MISURA. Si toglie un filtro alla volta e
        // si guarda se la query smette di fallire. Indovinare avrebbe un costo
        // preciso in entrambi i versi: togliere il filtro di sede quando mancava
        // il cestino è il fail-open peggiore di questa rotta (una segreteria
        // legge le foto di un altro plesso — è già successo, fix D3); togliere il
        // filtro del cestino quando mancava la sede rimette in galleria le foto
        // che qualcuno ha eliminato, magari dopo una segnalazione.
        let mediaRes = await buildMedia(true, true);
        let cestinoDegradato = false;
        const colonnaAssente = (e: unknown) => {
            const err = e as { code?: string } | null;
            return colonnaCestinoAssente(err) || colonnaSedeAssente(err);
        };

        if (colonnaAssente(mediaRes.error)) {
            // Primo sospettato: le colonne del cestino, che sono le più nuove (e
            // in CI sono quelle che mancano davvero). Si toglie SOLO quel filtro e
            // si tiene la sede: se la query guarisce, la colonna mancante era
            // quella — misurato, non dedotto — e l'isolamento di sede non è stato
            // toccato.
            const senzaCestino = await buildMedia(true, false);
            if (!colonnaAssente(senzaCestino.error)) {
                cestinoDegradato = true;
                mediaRes = senzaCestino;
            } else {
                // Manca (anche) `scuola_id`: da qui in giù è la regola storica,
                // col suo guard. Si rileggeva SEMPRE senza il filtro di sede: su
                // un impianto multi-sede è il fail-open peggiore, perché scatta
                // proprio quando l'isolamento non è disponibile. Vale la stessa
                // regola della modulistica (`degradoSedeLecito`): si prosegue
                // senza filtro SOLO se non c'è niente da isolare (al più una sede
                // reale), altrimenti si NEGA.
                if (!(await degradoSedeLecito(supabase, 'gallery:GET'))) {
                    // Configurazione d'isolamento mancante su impianto multi-sede:
                    // è un incidente, quindi `error`, mai `info`.
                    logEvento('galleria', 'error', {
                        operazione: 'gallery:GET',
                        esito: 'colonna-sede-assente-degrado-negato',
                    });
                    return NextResponse.json(
                        { error: 'Isolamento per sede non disponibile' },
                        { status: 500 }
                    );
                }
                logEvento('galleria', 'info', {
                    operazione: 'gallery:GET',
                    esito: 'degrado-scuola-id-assente',
                });
                mediaRes = await buildMedia(false, true);
                // …e se anche senza la sede fallisce, allora mancano entrambe: è
                // esattamente il DB E2E della CI.
                if (colonnaAssente(mediaRes.error)) {
                    cestinoDegradato = true;
                    mediaRes = await buildMedia(false, false);
                }
            }
        }

        if (cestinoDegradato) {
            // `warn` e non `info`: su un impianto migrato non deve succedere, e
            // se succede significa che le righe nel cestino NON sono filtrate —
            // cioè che una foto eliminata può tornare a schermo.
            logEvento('galleria', 'warn', {
                operazione: 'gallery:GET',
                esito: 'degrado-cestino-colonna-assente',
                stato,
            });
            // IL CESTINO DI UN IMPIANTO SENZA CESTINO È VUOTO, e dirlo è l'unica
            // risposta vera. Rileggere senza filtro restituirebbe le foto VIVE
            // spacciate per cestinate: un elenco di foto in vista «eliminate», su
            // cui la segreteria premerebbe «Ripristina» — o «Elimina
            // definitivamente» — credendo di agire su ciò che aveva buttato.
            if (vistaCestino) {
                return NextResponse.json({ media: [], total: 0, limit, offset });
            }
        }
        const { data: pageMedia, count, error } = mediaRes;

        if (error) {
            logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Arricchisci con info uploader in blocco (niente N+1 sulla pagina)
        const page = pageMedia ?? [];
        const uploaderIds = [...new Set(page.map(m => m.uploaded_by).filter(Boolean))];
        const { data: uploaders } = uploaderIds.length > 0
            ? await supabase
                .from('utenti')
                .select('id, nome, cognome, first_name, last_name')
                .in('id', uploaderIds)
            : { data: [] };
        const uploaderById = new Map((uploaders ?? []).map(u => [u.id, u]));

        // ⚠️ «C'È `studentId`» NON VUOL PIÙ DIRE «CHI LEGGE È UN GENITORE», e da
        // quando esiste la terza modalità la differenza si misura in un campo che
        // sparisce. Nella vista di FAMIGLIA `studentId` è il figlio (il gate sopra
        // è `requireParentOfStudent`), e `tag_students` — gli uuid degli ALTRI
        // minori ritratti nella stessa foto di gruppo — non serve e non deve
        // uscire: GDPR art. 5.1.c, vedi `./proiezione`. Nella vista di SEDE lo
        // stesso parametro è un FILTRO scelto in una tendina da una segreteria che
        // quel plesso lo amministra: togliere lì `tag_students` non protegge
        // nessuno — i bambini sono i suoi, e li vede già senza filtro — mentre
        // spegne `alunniTaggatiDellaSede`, che legge proprio quel campo poche
        // righe più sotto.
        //
        // Misurato con `Boolean(studentId)` da solo: `?scope=sede&studentId=…`
        // rispondeva righe SENZA `tag_students` e con `alunni_taggati: []` su ogni
        // foto, mentre il commento qui sotto ne prometteva nomi e classe. Non è
        // una fuga (usciva meno, non di più): è una promessa che si spegneva in
        // silenzio, cioè il difetto che su questa rotta è già costato di più.
        const perGenitore = !vistaSede && Boolean(studentId);
        const enriched = page.map((media) => {
            const uploader = uploaderById.get(media.uploaded_by);
            return proiettaPerGenitore(
                {
                    ...media,
                    uploader_name: uploader
                        ? `${uploader.first_name || uploader.nome} ${uploader.last_name || uploader.cognome}`
                        : 'Sconosciuto',
                },
                perGenitore,
            );
        });

        // Vista di sede: ai media si attaccano i bambini taggati DELLA SEDE, coi
        // loro nomi e la loro classe. Senza, la schermata della segreteria
        // mostrerebbe uuid, o dovrebbe interrogare l'anagrafica una volta per
        // foto. Non si fa per le altre due modalità: al genitore `tag_students`
        // viene tolto del tutto (`proiettaPerGenitore`, GDPR art. 5.1.c), e la
        // vista di classe della maestra i nomi ce li ha già dal suo elenco.
        const conAlunni = vistaSede
            ? await alunniTaggatiDellaSede(supabase, enriched, plessi, 'gallery:GET')
            : enriched;

        // Il bucket `gallery` è PRIVATO: in tabella c'è il percorso del file, e
        // l'indirizzo con cui la foto si guarda nasce QUI, firmato e a scadenza
        // breve, solo per chi ha superato il gate e lo scope di sede appena
        // applicati. Una chiamata sola per l'intera pagina.
        //
        // ⚠️ La vista di sede NON allarga il TTL (600 s, `@/lib/gallery/storage`):
        // è una schermata di lavoro, non un varco. Un link firmato che dura di
        // più è un link che, inoltrato o copiato per sbaglio, continua a mostrare
        // la foto di un minore più a lungo.
        const conLink = await firmaMediaGalleria(supabase, conAlunni, 'gallery:GET');

        if (vistaSede) {
            // Evento critico ⇒ si logga anche il SUCCESSO: questa è la lettura di
            // un plesso INTERO di foto di minori, e senza una riga per il caso
            // buono «nessun log» non distinguerebbe «tutto ok» da «non è mai
            // partito niente». Solo uuid, conteggi e booleani: mai un id di
            // bambino, mai un nome.
            logEvento('galleria', 'info', {
                operazione: 'gallery:GET',
                // Il cestino è una lettura DIVERSA, e va distinta nei log: è
                // l'elenco di ciò che qualcuno ha deciso di nascondere, e «chi lo
                // ha aperto e quando» è la sola traccia che ne resta (la riga
                // dell'eliminazione dice chi ha buttato, non chi ha guardato).
                esito: vistaCestino ? 'vista-cestino' : 'vista-sede',
                stato,
                sede_id: plessi[0],
                utente: auth.user.id,
                ruolo: auth.user.role,
                n: conLink.length,
                total: count ?? 0,
                offset,
                limit,
                con_classe: Boolean(classe),
                con_alunno: Boolean(studentId),
                con_data: Boolean(date),
            });
        }

        // `limit`/`offset` nella risposta: il clamp qui sopra è silenzioso (per
        // scelta storica di questa rotta, che non risponde 400 su un limite
        // fuori scala), e un chiamante che ne chiede 5000 e ne riceve 100 deve
        // poter capire che è stato tagliato invece di credere che le righe
        // fossero finite.
        return NextResponse.json({ media: conLink, total: count ?? 0, limit, offset });
    } catch (error) {
        logErrore({ operazione: 'gallery:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// POST /api/gallery
// Body: { uploaded_by, file_url, file_type?, caption?, tag_students?, is_broadcast?, target_classes? }
export const POST = withRoute('gallery:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const {
            file_url,
            file_type,
            caption,
            tag_students,
            is_broadcast,
            target_classes,
            scuola_id,
        } = b.data;

        // L'uploader è l'utente del gate (no spoofing del campo uploaded_by).
        const uploaded_by = auth.user.id;

        // Broadcast = comunicazione istituzionale: riservata alla Direzione
        // (admin/coordinatore). La UI lo nasconde già agli educatori; qui lo
        // impone anche il server.
        if (is_broadcast === true && !['admin', 'coordinator'].includes(auth.user.role)) {
            return NextResponse.json(
                { error: 'Solo la Direzione (admin o coordinatore) può pubblicare in broadcast.' },
                { status: 403 }
            );
        }

        // BROADCAST ⇒ NESSUN TAG, e ora lo dice il server.
        // `tag_students` sono i bambini RITRATTI; il broadcast manda la foto a
        // un'intera classe o all'intera sede. La regola esisteva già, ma viveva
        // SOLO nel client (`teacher/gallery/page.tsx:304` e `:345`, che mandano
        // `tag_students: []` quando il broadcast è attivo): chi chiamava questa
        // rotta direttamente la scavalcava, e il Privacy Lock qui sotto non lo
        // fermava perché in broadcast usciva prima ancora di leggere
        // l'anagrafica. Risultato misurato dal collaudo privacy del 2026-07-31
        // (rilievo F5): `is_broadcast:true` + tre bambini senza liberatoria →
        // 201, foto di gruppo pubblicata a tutta la sede.
        // Una regola di privacy applicata dal client non è una regola.
        const tagUnici = [...new Set((tag_students ?? []) as string[])];
        if (is_broadcast === true && tagUnici.length > 0) {
            // `warn`: non è un errore del sistema, è una richiesta respinta — ma
            // va vista, perché l'interfaccia questa combinazione non la produce.
            // Solo conteggi: gli id sono di minori.
            logEvento('galleria', 'warn', {
                operazione: 'gallery:POST',
                esito: 'broadcast-con-tag',
                tipo: 'broadcast-con-tag',
                taggati: tagUnici.length,
            });
            return NextResponse.json(
                {
                    error: 'Una foto in broadcast non può taggare bambini: va a tutta la classe o a tutta la sede. Pubblicala senza tag, oppure togli il broadcast e tagga solo chi ha la liberatoria foto.',
                },
                { status: 400 }
            );
        }

        const supabase = await createAdminClient();

        // Sede (tenant) del media: DICHIARATA dal client (`scuola_id`), oppure
        // dedotta dal SedeSelector / dall'unico plesso dell'utente.
        //
        // ⚠️ Qui c'era `sw.scuolaId ?? auth.user.scuola_id ?? null`, cioè la
        // risposta del resolver veniva IGNORATA: `sw.response` non era nemmeno
        // guardata. Per l'admin multi-plesso il 400 «specificare la sede» non
        // arrivava mai — arrivava una foto archiviata nella sua sede PRIMARIA,
        // qualunque plesso avesse in mente. E la sede sbagliata non resta sulla
        // riga: comanda anche i destinatari della notifica più in basso, cioè
        // annuncia le foto ai genitori dell'altro plesso e non a quelli giusti.
        // Chi ha un solo plesso non cambia comportamento.
        //
        // ⚠️ E SI RISOLVE QUI, PRIMA DEI TAG (2026-08-03). Stava dopo, ed è la
        // ragione per cui il gate dei tag guardava la cosa sbagliata: non avendo
        // ancora la sede del media, poteva solo confrontare i tag con TUTTI i
        // plessi di chi opera. Vedi il blocco qui sotto.
        const sw = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, scuola_id ?? undefined);
        if (sw.response) return sw.response;
        const scuolaId = sw.scuolaId as string;

        // LO SCOPE DI SEDE VIENE PRIMA DEL PRIVACY LOCK, e non è un dettaglio
        // d'ordine. Fino al 2026-07-31 `alunniSenzaConsenso` interrogava `alunni`
        // con `.in('id', ids)` senza filtro di sede, e il 422 che ne usciva
        // portava NOMI E COGNOMI dei minori taggati più l'informazione che a loro
        // manca la liberatoria fotografica. Il collaudo privacy l'ha misurato con
        // la controprova su tre sedi: la risposta era IDENTICA per la segreteria
        // che ne aveva titolo e per quella di un altro plesso. Bastava conoscere
        // gli uuid — e un uuid non è un segreto.
        //
        // ⚠️ Il gate NON è più scritto qui dentro (2026-08-03). Vent'anni di
        // buone intenzioni non fanno quello che fa una funzione sola: la copia
        // che stava in questo handler proteggeva la POST e lasciava scoperto il
        // PATCH, che i tag li accetta esattamente allo stesso modo. Ora la regola
        // vive in `@/lib/gallery/tag-scope` ed è chiamata da entrambi.
        //
        // ⚠️ E LA SEDE CHE SI DICHIARA È QUELLA DEL MEDIA, NON I PLESSI DI CHI
        // OPERA (2026-08-03, rilievo W4/W3 del verificatore adversariale). Qui
        // c'era `resolveScuoleAttive(...)`, cioè «tutte le sedi selezionate
        // dall'utente», e per un admin di due plessi quell'elenco ne conteneva
        // due. Misurato: admin con le sedi A+B attive,
        // `POST {"scuola_id":"<A>","tag_students":["<uuid di un minore di B>"]}`
        // ⇒ **201**, riga con `scuola_id: A` e dentro `tag_students` l'uuid di un
        // bambino di B. Nessuno eccede il proprio titolo — le due sedi le ha
        // entrambe — ma l'identificatore di un minore finisce nella galleria di
        // un plesso il cui personale su quel bambino titolo non ne ha, e da lì lo
        // vede chiunque legga quella sede (`proiettaPerGenitore` nasconde
        // `tag_students` ai GENITORI, non ai colleghi).
        // La proprietà giusta è una sola: **i tag appartengono alla sede DEL
        // MEDIA**. La sede del media è `scuolaId`, ed è appena stata risolta.
        const plessi = [scuolaId];
        const fuoriSede = await assertTagStudentsInScope(supabase, tagUnici, plessi, 'gallery:POST');
        if (fuoriSede) return fuoriSede;

        // Privacy Lock (DL-041): inibisce il tagging di alunni senza consenso
        // privacy (liberatoria foto) sulle foto di GRUPPO. Il canale non lo
        // spegne più: `alunniSenzaConsenso` non accetta nemmeno l'argomento con
        // cui prima lo si spegneva (vedi la nota in `@/lib/gallery/privacy`), e
        // le sedi ora gliele si DICHIARA — la sede del media, per la stessa
        // ragione del gate qui sopra: con l'elenco dei plessi dell'operatore il
        // 422 potrebbe pronunciare il nome di un bambino di un ALTRO plesso su
        // una foto che in quel plesso non finirà mai.
        const senza = await alunniSenzaConsenso(supabase, tag_students, plessi);
        if (senza.length > 0) {
            // Privacy Lock scattato: nel log SOLO conteggi (mai nomi/id dei bambini,
            // che restano nel corpo della risposta per la UI dell'insegnante).
            logEvento('galleria', 'info', {
                operazione: 'gallery:POST',
                esito: 'liberatoria-mancante',
                taggati: new Set(tag_students ?? []).size,
                senzaConsenso: senza.length,
            });
            return NextResponse.json(
                {
                    error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).',
                    nomi: senza.map((s) => s.nome),
                    ids: senza.map((s) => s.id),
                },
                { status: 422 }
            );
        }

        // In tabella si archivia il PERCORSO nel bucket, mai un indirizzo.
        // `gallery/upload` ormai restituisce già il percorso, ma un client
        // vecchio (o un telefono col bundle in cache) può ancora rimandare
        // l'URL pubblico di quando il bucket era aperto: quell'indirizzo oggi
        // risponde 400, e salvarlo com'è vorrebbe dire archiviare un link morto
        // che nessuna firma successiva saprebbe recuperare. Ciò che NON
        // appartiene a questo bucket resta invece intatto: non si riscrive un
        // dato che non si è certi di saper interpretare.
        const fileUrlDaSalvare = percorsoNelBucket(file_url) ?? file_url;

        const baseRecord: Record<string, unknown> = {
            uploaded_by,
            file_url: fileUrlDaSalvare,
            file_type: file_type ?? 'foto',
            caption: caption ?? null,
            tag_students: tag_students ?? [],
            is_broadcast: is_broadcast ?? false,
            target_classes: target_classes ?? null,
        };

        // `ancheNelCestino` su un INSERT non filtra niente e non può: dichiara. Il
        // lock del cestino misura OGNI `from('galleria_media_v2')`, scritture
        // comprese, e ha ragione a non fare eccezioni per forma — `insert` e
        // `update` sono la stessa catena di `select`, e il giorno in cui una
        // scrittura dovesse guardare il cestino non ci sarebbe niente a ricordarlo.
        let insRes = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .insert({ ...baseRecord, scuola_id: scuolaId })
                .select()
                .single(),
            'una riga che nasce adesso non puo essere nel cestino: qui non c-e niente da filtrare, e dirlo è il modo di non confondere questa query con una lettura a cui il filtro è stato dimenticato',
        );
        // DB E2E CI non migrato: colonna scuola_id assente → PGRST204 (o 42703).
        // Riprova senza scuola_id così la pubblicazione resta possibile (degrado).
        if (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '')) {
            logEvento('galleria', 'info', {
                operazione: 'gallery:POST',
                esito: 'degrado-scuola-id-assente',
            });
            insRes = await ancheNelCestino(
                supabase
                    .from('galleria_media_v2')
                    .insert(baseRecord)
                    .select()
                    .single(),
                'ritentativo della pubblicazione senza scuola_id: come il tentativo qui sopra, una riga appena creata non puo essere nel cestino',
            );
        }
        const { data, error } = insRes;

        if (error) {
            logErrore({ operazione: 'gallery:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Notifica ai genitori interessati (best-effort): alunni taggati →
        // classi target → broadcast a tutta la scuola. Buffer 30' + debounce
        // per uploader: gli upload a raffica collassano in una notifica sola.
        //
        // Il conteggio dei destinatari si tiene FUORI dal try perché è il dato del
        // log di successo qui sotto. `null` significa «non si è arrivati a
        // calcolarlo»: in quel caso la riga `error` del catch dice già perché.
        let nDestinatari: number | null = null;
        try {
            // Riusa la sede risolta sopra (rispetta il SedeSelector), invece di
            // ricadere sempre sulla sede primaria dell'utente.
            const tagged = (tag_students ?? []) as string[];
            const classi = Array.isArray(target_classes) ? (target_classes as string[]).filter(Boolean) : [];
            const destinatari = tagged.length > 0
                ? await genitoriDiAlunni(supabase, tagged)
                : classi.length > 0
                    ? await genitoriDiClassi(supabase, scuolaId, classi)
                    : await genitoriDiScuola(supabase, scuolaId);
            nDestinatari = destinatari.length;
            await notificaEvento(supabase, {
                tipo: 'galleria',
                scuolaId,
                utenteIds: destinatari,
                titolo: 'Nuove foto in galleria',
                corpo: caption ? `«${caption}»` : 'Sono state pubblicate nuove foto.',
                link: '/parent/gallery',
                entitaTipo: 'galleria',
                entitaId: uploaded_by,
                bufferMin: 30,
                debounce: true,
            });
        } catch (e) {
            // `error` benché il media sia pubblicato (201): la notifica non è mai stata accodata,
            // quindi i genitori non sapranno delle foto nuove. Il contenuto è salvo, il suo
            // annuncio è perso — e nessuno se ne accorgerebbe senza questa riga.
            logEvento('notifica', 'error', {
                operazione: 'gallery:POST',
                esito: 'notifica-genitori-non-accodata',
            }, e);
        }

        // Evento critico → si logga anche il SUCCESSO (solo conteggi/flag, nessun
        // dato personale): senza, "nessun log" non distinguerebbe "pubblicata" da
        // "non è mai partito niente".
        //
        // `n_destinatari` accanto a `nTag` è la coppia che conta: la foto è il
        // contenuto, la notifica è il suo recapito. «Due bambini nella foto, zero
        // famiglie avvisate» è un guasto vivo — in produzione ci sono alunni senza
        // nessun tutore collegato — e con il solo `nTag` si leggeva come un successo.
        logEvento('galleria', 'info', {
            operazione: 'gallery:POST',
            esito: 'pubblicata',
            // La sede è un uuid (passa la redazione) e senza di essa il log non
            // direbbe DOVE è finita la foto: con tre plessi è metà del fatto.
            sede_id: scuolaId,
            nTag: (tag_students ?? []).length,
            broadcast: is_broadcast ?? false,
            n_destinatari: nDestinatari,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'gallery:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

/**
 * Il minimo che `soloVive` chiede a una query, scritto a mano.
 *
 * `soloVive<Q extends Filtrabile<Q>>` è un vincolo RICORSIVO, e applicarlo al tipo
 * di un `PostgrestFilterBuilder` costruito con `select('tag_students').eq(…).not(…)`
 * fa rispondere a TypeScript **TS2589 «Type instantiation is excessively deep and
 * possibly infinite»**: misurato, non supposto. Con `select('*')` l'inferenza regge
 * (vedi `buildMedia`), qui no. Il parametro di tipo esplicito la interrompe senza
 * togliere niente al controllo che conta: `is`, `not` e `lt` ci sono, e il risultato
 * ha la forma che questo file legge davvero.
 */
type EsitoTagVivi = {
    data: Array<{ tag_students: string[] | null }> | null;
    error: { code?: string } | null;
};
interface QueryTagVivi extends PromiseLike<EsitoTagVivi> {
    is(colonna: string, valore: boolean | null): QueryTagVivi;
    not(colonna: string, operatore: string, valore: unknown): QueryTagVivi;
    lt(colonna: string, valore: unknown): QueryTagVivi;
}

/**
 * Gli alunni che questo docente ha taggato nei propri media — SOLO quelli VIVI.
 *
 * È la lettura da cui DELETE e PATCH deducono «quali sono le classi di questa
 * maestra», e da lì se può toccare il media di un'altra. Filtrarla col cestino
 * non è un dettaglio di coerenza: una foto eliminata è una foto che la scuola ha
 * deciso di non avere più, e continuare a dedurne dei PERMESSI significa che un
 * tag sbagliato — cancellato proprio per quello — resta a concedere accessi per
 * sempre. Nei 30 giorni del cestino la riga c'è ancora, quindi senza questo
 * filtro il comportamento non cambierebbe di un giorno: cambierebbe per sempre,
 * perché la purga cancella la riga ma non il permesso già concesso nel frattempo.
 *
 * Stava scritta due volte, identica, in due handler: ora è una funzione, come il
 * gate dei tag (`assertTagStudentsInScope`) dopo che la sua copia nella POST ha
 * lasciato il PATCH scoperto per tre giorni.
 *
 * ⚠️ E CONTROLLA `{ error }`, che prima nessuna delle due copie faceva.
 * PostgREST non lancia: un guasto di lettura usciva come `data: null`, cioè
 * «questo docente non ha classi», cioè un **403 senza una riga di log** — il
 * silenzio che non distingue «non ne ha titolo» da «non sono riuscito a
 * chiederlo».
 */
async function alunniTaggatiNeiMieiMediaVivi(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    userId: string,
    operazione: string,
): Promise<string[]> {
    // Si RICOSTRUISCE, non si riusa: `is()` ritorna `this`, quindi il primo
    // tentativo ha già mutato il builder e il filtro è già dentro l'URL. È la
    // stessa ragione per cui `buildMedia` qui sopra nomina la tabella tre volte.
    //
    // ⚠️ Qui NON si usa `leggiVive` di `@/lib/gallery/cestino`, che fa esattamente
    // questo ritentativo — e non per scelta di stile: il suo tipo
    // (`<T>(costruisci: (vive: FiltroVive) => PromiseLike<T>)`) combina una
    // generica di ordine superiore con il vincolo ricorsivo `Q extends
    // Filtrabile<Q>`, e su un `PostgrestFilterBuilder` reale TypeScript ci
    // risponde **TS2589 «Type instantiation is excessively deep»**. Misurato, non
    // supposto — ed è lo stesso motivo per cui `soloVive` qui sotto riceve il
    // parametro di tipo `QueryTagVivi` scritto a mano: su `select('*')` l'inferenza
    // regge (`buildMedia`), su `select('tag_students').eq(…).not(…)` no.
    // ⚠️ Il tipo si dichiara con un CAST sull'argomento, non con `soloVive<…>(…)`:
    // il riconoscitore del lock legge il nome della funzione a ritroso da `(` e su
    // `soloVive<QueryTagVivi>(` trova `>`, non `soloVive` — cioè la query risulta
    // NON dichiarata. Con l'inferenza dall'argomento il nome resta attaccato alla
    // parentesi e la garanzia è identica.
    let res: EsitoTagVivi = await soloVive(
        supabase
            .from('galleria_media_v2')
            .select('tag_students')
            .eq('uploaded_by', userId)
            .not('tag_students', 'is', null) as unknown as QueryTagVivi,
    );
    // DB E2E della CI non migrato: le colonne del cestino non esistono (42703).
    // Qui si degrada senza guard di sede perché questa lettura non isola niente —
    // è l'elenco dei tag di CHI CHIEDE, non di un plesso — ma `warn`, perché su un
    // impianto migrato vorrebbe dire che un media cestinato concede ancora permessi.
    if (colonnaCestinoAssente(res.error)) {
        logEvento('galleria', 'warn', {
            operazione,
            esito: 'degrado-cestino-colonna-assente',
        });
        res = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .select('tag_students')
                .eq('uploaded_by', userId)
                .not('tag_students', 'is', null),
            'ritentativo senza filtro dopo un 42703: su un database senza le colonne del cestino non esiste nessuna riga cestinata da escludere',
        );
    }
    if (res.error) {
        logEvento('galleria', 'warn', {
            operazione,
            esito: 'classi-docente-illeggibili',
        }, res.error);
        return [];
    }
    return ((res.data ?? []) as Array<{ tag_students: string[] | null }>)
        .flatMap((m) => m.tag_students ?? [])
        .filter(Boolean);
}

// DELETE /api/gallery?id=xxx&userId=yyy
// ─── NON CANCELLA PIÙ: METTE NEL CESTINO (2026-09-11) ────────────────────────
// `Elimina` nasconde la foto SUBITO a tutti — genitori compresi, per la policy
// RLS della migrazione — la lascia recuperabile 30 giorni, e solo dopo la purga
// la distrugge davvero, riga E file.
//
// Prima questa route faceva `.delete()` sulla riga e **non toccava lo Storage**:
// il file restava nel bucket per sempre, senza più nessuna riga che lo nominasse
// — cioè la foto di un minore diventava un oggetto irraggiungibile e
// incancellabile, perché il suo percorso non era più scritto da nessuna parte. Il
// PRD (riga 20619) promette «eliminare … dal database e dal feed», ed era
// esattamente ciò che faceva: dal database e dal feed, non dall'archivio.
//
// Lo Storage NON si tocca qui, e non è una dimenticanza: è l'unico verso in cui
// si può sbagliare senza perdere niente. Una riga nascosta si recupera con un
// UPDATE; un file cancellato dal bucket non torna. La rimozione definitiva è il
// solo momento in cui va fatta — la purga a 30 giorni — e lì c'è
// `file_rimosso_il` a renderla idempotente.
//
// E LE `segnalazioni` NON SI TOCCANO, né qui né dopo. Questa route non le ha mai
// cancellate (verificato: `segnalazioni` non compare in tutto il file) e non deve
// iniziare. Una segnalazione è la traccia di una moderazione: cancellarla insieme
// alla foto cancellerebbe **la ragione** per cui la foto è stata rimossa, cioè
// proprio il documento che serve se un giorno qualcuno chiede conto di quella
// rimozione. Le orfane le ripulirà la purga, quando la riga non esisterà più.
export const DELETE = withRoute('gallery:DELETE', async (request: Request) => {
    try {
        // Gate identità: l'utente arriva SOLO dal gate, MAI dal parametro `?userId=`.
        // Prima, senza sessione, si ricadeva sul param → spoofing admin (cancellazione
        // di foto di minori). `requireDocente` esclude genitore/cuoca (401 anonimo,
        // 403 ruolo non ammesso): nessun ruolo genitore ha titolo a cancellare, e la
        // successiva logica per ruolo/plesso (isAdmin/isCoordinator/isEducator) resta
        // invariata — cambia solo la FONTE dell'identità.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const userId = auth.user.id;

        const q = parseQuery(request, deleteQuerySchema);
        if ('response' in q) return q.response;
        const id = q.data.id;

        const supabase = await createAdminClient();

        // 1. Recupera il record del media — CESTINO COMPRESO, ed è l'unica
        // lettura di questo file che lo fa.
        //
        // Tutte le altre viste filtrano `soloVive`: una foto nel cestino non si
        // elenca, non si firma e non si ritagga. Qui invece va LETTA, perché la
        // riga che serve sapere è proprio «è già nel cestino?». Con `soloVive`
        // questa select risponderebbe `null`, cioè **404 Media non trovato**, e
        // due persone della segreteria che premono Elimina sulla stessa foto —
        // una dal telefono, una dal computer, cosa che in una scuola succede —
        // vedrebbero la seconda un errore che non descrive niente di rotto:
        // l'operazione che voleva è già fatta.
        const { data: media, error: mediaErr } = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .select('*')
                .eq('id', id),
            'gallery:DELETE deve poter rispondere «già eliminato» invece di 404',
        ).maybeSingle();

        if (mediaErr || !media) {
            return NextResponse.json({ error: 'Media non trovato' }, { status: 404 });
        }

        // Isolamento per sede, PRIMA di qualunque valutazione dei permessi.
        // L'autorizzazione qui sotto si basa sull'INTERSEZIONE DEI NOMI di classe
        // fra il media e le classi del docente: con tre sedi «2 ANNI» esiste sia
        // ad Aversa sia a Cesa, quindi la maestra di Aversa risultava autorizzata
        // a modificare (e cancellare) le foto dei bambini di Cesa. Il media ha la
        // sua `scuola_id`: si confronta quella, e i nomi contano solo dopo.
        const plessi = await scuoleDiUtente(supabase, auth.user);
        // `sedeMedia` vive FUORI dal blocco (prima ci stava dentro) perché adesso
        // serve anche più in basso: è la sede che l'audit registra sulla riga di
        // `audit_scritture_docente` e che il log di successo scrive. Dedurla una
        // seconda volta da `auth.user.scuola_id` significherebbe attribuire
        // l'eliminazione alla sede PRIMARIA di chi opera invece che a quella della
        // foto — e per un admin di tre plessi sono cose diverse.
        const sedeMedia = (media as { scuola_id?: string | null }).scuola_id ?? null;
        {
            // Sede assente ⇒ si NEGA, come in `assertPagamentoInScope`: una riga
            // senza plesso non è attribuibile a nessuno. Il test era
            // `sedeMedia !== null && !plessi.includes(sedeMedia)`, cioè il
            // contrario del commento che gli stava sopra: con `scuola_id` nullo
            // la condizione è falsa e il controllo NON scattava per nessuno,
            // rimandando l'autorizzazione all'intersezione dei nomi di classe —
            // esattamente il meccanismo che questo blocco esiste per sostituire.
            if (sedeMedia === null || !plessi.includes(sedeMedia)) {
                logEvento('galleria', 'warn', {
                    operazione: 'gallery:DELETE',
                    esito: sedeMedia === null ? 'media-senza-sede' : 'media-fuori-sede',
                });
                return NextResponse.json({ error: 'Media fuori dal tuo plesso' }, { status: 403 });
            }
        }

        // 2. Recupera il ruolo dell'utente da utenti
        const { data: utentiRecord } = await supabase
            .from('utenti')
            .select('ruolo, scuola_id')
            .eq('id', userId)
            .maybeSingle();

        const role = utentiRecord?.ruolo;
        const userScuolaId = utentiRecord?.scuola_id;

        const isAdmin = ['admin', 'segreteria', 'direzione', 'segretaria'].includes(role ?? '');
        const isCoordinator = ['coordinator', 'coordinatore'].includes(role ?? '');
        const isEducator = ['educator', 'maestra'].includes(role ?? '');

        let authorized = false;

        if (isAdmin) {
            // Admin/Segreteria/Direzione possono eliminare qualsiasi media
            authorized = true;
        } else if (isCoordinator) {
            // I coordinatori possono eliminare i media nel proprio plesso/scuola
            const { data: uploaderRecord } = await supabase
                .from('utenti')
                .select('scuola_id')
                .eq('id', media.uploaded_by)
                .maybeSingle();

            if (uploaderRecord?.scuola_id === userScuolaId) {
                authorized = true;
            }
        } else if (isEducator) {
            // L'insegnante può eliminare se l'ha caricato lui stesso
            if (media.uploaded_by === userId) {
                authorized = true;
            } else {
                // Oppure se il media riguarda le sue classi
                // Ricaviamo le sezioni del docente dagli alunni che ha taggato nei suoi media precedenti
                // (solo dai media VIVI: vedi `alunniTaggatiNeiMieiMediaVivi`).
                const myTaggedStudentIds = await alunniTaggatiNeiMieiMediaVivi(
                    supabase, userId, 'gallery:DELETE',
                );

                let myClassNames: string[] = [];

                if (myTaggedStudentIds.length > 0) {
                    // `.in('scuola_id', plessi)`: un vecchio tag su un bambino di
                    // un altro plesso faceva entrare il NOME della SUA classe fra
                    // «le classi del docente», e da lì autorizzava sull'omonima.
                    // Stesso presidio già in `educator-sections`.
                    const { data: myStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', myTaggedStudentIds)
                        .in('scuola_id', plessi);

                    myClassNames = [...new Set(
                        (myStudents ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
                    )];
                }

                // Verifica se la classe del media interseca con quelle del docente
                const hasClassIntersection = media.target_classes?.some((c: string) => myClassNames.includes(c));

                let hasStudentIntersection = false;
                if (media.tag_students && media.tag_students.length > 0) {
                    const { data: taggedStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', media.tag_students)
                        .in('scuola_id', plessi);

                    hasStudentIntersection = taggedStudents?.some(
                        (s: { classe_sezione: string }) => myClassNames.includes(s.classe_sezione)
                    ) ?? false;
                }

                if (hasClassIntersection || hasStudentIntersection) {
                    authorized = true;
                }
            }
        }

        if (!authorized) {
            return NextResponse.json(
                { error: 'Non sei autorizzato a eliminare questo media' },
                { status: 403 }
            );
        }

        // ─── GIÀ NEL CESTINO? ALLORA È GIÀ FATTO ─────────────────────────────
        //
        // E il controllo sta QUI, dopo il gate di sede e dopo l'autorizzazione,
        // non appena letta la riga: un 200 dato prima dei permessi sarebbe un
        // oracolo — chiunque, con un uuid, saprebbe che quel media esiste e che è
        // stato eliminato. Chi non ha titolo continua a prendersi 403/404 come
        // prima; chi ce l'ha scopre che l'operazione che voleva è già avvenuta.
        const giaNelCestino = ((media as { eliminato_il?: string | null }).eliminato_il ?? null) !== null;
        if (giaNelCestino) {
            // `info`, non `warn`: non è niente di rotto. Due persone della
            // segreteria che premono Elimina sulla stessa foto — una dal telefono
            // in sezione, una dal computer in ufficio — sono la normalità di una
            // scuola, e l'unica cosa che serve saperne è che è capitato.
            logEvento('galleria', 'info', {
                operazione: 'gallery:DELETE',
                esito: 'gia-eliminato',
                sede_id: sedeMedia,
                ruolo_attore: role ?? auth.user.role ?? null,
            });
            return NextResponse.json({ success: true, esito: 'gia-eliminato' });
        }

        // ─── L'ARCHIVIAZIONE ─────────────────────────────────────────────────
        //
        // `.is('eliminato_il', null)` non è una cintura in più sul controllo qui
        // sopra: è l'unico punto in cui la corsa fra due richieste si decide
        // davvero. Fra la lettura e questa scrittura passa il tempo di quattro
        // query, e in quella finestra l'altra impiegata può aver già premuto. Con
        // la condizione dentro l'UPDATE, il secondo arrivato non riscrive niente —
        // e soprattutto non fa ripartire da zero i 30 giorni del cestino, che è il
        // modo silenzioso in cui una foto verrebbe distrutta più tardi del dovuto,
        // o ripristinata da chi non l'aveva buttata.
        //
        // La condizione la mette `soloVive`, che è la stessa funzione usata dalle
        // letture: scritta a mano (`.is('eliminato_il', null)`) sarebbe una sesta
        // copia della regola, e la sesta copia è quella che un giorno si dimentica.
        const oraCestino = new Date().toISOString();
        const cestinaRes = await soloVive(
            supabase
                .from('galleria_media_v2')
                .update({ eliminato_il: oraCestino, eliminato_da: userId })
                .eq('id', id),
        ).select('id');

        // DB E2E della CI non migrato: le colonne del cestino non ci sono
        // (`PGRST204` in UPDATE, `42703` in SELECT). Qui non si degrada
        // cancellando: un `.delete()` di ripiego distruggerebbe la riga — e
        // renderebbe il file del bucket irraggiungibile per sempre — proprio
        // nell'impianto in cui il cestino non c'è per accoglierla. Si risponde
        // 501 con una riga di log a livello `error`: l'operazione NON è avvenuta,
        // e dirlo è meglio che farne una diversa.
        if (colonnaCestinoAssente(cestinaRes.error as { code?: string } | null)) {
            logEvento('galleria', 'error', {
                operazione: 'gallery:DELETE',
                esito: 'cestino-colonna-assente',
                sede_id: sedeMedia,
            });
            // Il `codice` accanto alla prosa NON è decorazione: chi lavora con
            // l'interfaccia in inglese lo riceve al posto di questa frase italiana
            // (`messaggioErrore` → `CODICI_ERRORE` → catalogo). Senza, la galleria
            // mostrerebbe italiano dentro un'interfaccia inglese — il fallimento F1
            // del collaudo del 2026-07-31.
            return NextResponse.json(
                {
                    error: 'Cestino della galleria non disponibile su questo impianto',
                    codice: 'GALLERIA_CESTINO_NON_DISPONIBILE',
                },
                { status: 501 }
            );
        }

        if (cestinaRes.error) {
            logErrore({ operazione: 'gallery:DELETE', stato: 500, evento: 'db' }, cestinaRes.error);
            return NextResponse.json({ error: cestinaRes.error.message }, { status: 500 });
        }

        // Zero righe toccate ⇒ qualcun altro ha vinto la corsa nel frattempo.
        // Stessa risposta del controllo qui sopra: l'esito per chi chiama è
        // identico, ed è vero.
        if ((cestinaRes.data ?? []).length === 0) {
            logEvento('galleria', 'info', {
                operazione: 'gallery:DELETE',
                esito: 'gia-eliminato',
                sede_id: sedeMedia,
                ruolo_attore: role ?? auth.user.role ?? null,
            });
            return NextResponse.json({ success: true, esito: 'gia-eliminato' });
        }

        // ─── L'AUDIT, che per la galleria non c'è MAI STATO ───────────────────
        // Misurato il 2026-09-11: `audit_scritture_docente` ha **0 righe** con
        // `entita_tipo` della galleria, mentre 63 route la scrivono. Chi ha
        // eliminato la foto di quel pomeriggio, e quando, non era scritto da
        // nessuna parte — e `eliminato_da` sulla riga dura quanto la riga: dopo la
        // purga non resta niente. L'audit è il posto che ha una retention e dei
        // permessi suoi, e non muore con la foto.
        // `azione: 'delete'` e non `'update'`: per chi legge l'audit questo è
        // l'atto di eliminare, non la modifica di un campo. Come la scrittura
        // avviene è un dettaglio di questa tabella, non un fatto da registrare.
        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'galleria_media',
            entitaId: id,
            azione: 'delete',
            scuolaId: sedeMedia,
        });

        // ─── QUANTE NOTIFICHE RESTANO IN VOLO ────────────────────────────────
        //
        // Si CONTANO, non si cancellano — e la differenza è una decisione presa,
        // non una pigrizia. `gallery:POST` accoda le notifiche con
        // `entitaId: uploaded_by` (l'INSEGNANTE, non il media): è la chiave del
        // debounce per insegnante, corretta il 07-08/09 dopo che 168 notifiche su
        // 298 erano andate perse e 153 genitori non erano mai stati avvisati.
        // Ritirare «le notifiche di QUESTA foto» richiederebbe di cambiare quella
        // chiave nell'id del media, e trasformerebbe 37 foto in un pomeriggio in
        // 37 notifiche per famiglia: il rimedio, sullo stesso percorso che ha già
        // prodotto l'incidente, sarebbe peggiore del buco.
        //
        // Il costo del non ritirare è misurato e accettato: la notifica dice
        // «Nuove foto in galleria» e non nomina nessun media, quindi il
        // collegamento continua a funzionare e mostra le foto rimaste. Ma il
        // NUMERO va saputo, perché è l'unica cosa che dice quanti annunci
        // sopravvivono alla foto che li ha generati.
        let nNotifichePendenti: number | null = null;
        {
            const contate = await supabase
                .from('notifiche')
                .select('id', { count: 'exact', head: true })
                .eq('tipo', 'galleria')
                .eq('entita_id', media.uploaded_by)
                .is('push_inviata_il', null);
            if (contate.error) {
                // PostgREST non lancia: senza questo controllo il conteggio
                // sarebbe uscito `null` nel log senza dire perché.
                logEvento('galleria', 'warn', {
                    operazione: 'gallery:DELETE',
                    esito: 'notifiche-pendenti-non-contate',
                }, contate.error);
            } else {
                nNotifichePendenti = contate.count ?? 0;
            }
        }

        // ─── IL LOG DI SUCCESSO (AGENTS, regola 5) ────────────────────────────
        // Non c'era: questa route registrava solo i fallimenti, quindi «nessun
        // log» non distingueva «la foto è nel cestino» da «non è mai partito
        // niente». Solo conteggi, uuid e flag.
        //
        // ⚠️ MAI LA DIDASCALIA. `caption` della galleria È il nome del file
        // scelto da chi carica, e nella pratica di questa scuola è «Marco al
        // parco.jpg»: il nome di un bambino. Non è redatta «per prudenza» — è il
        // dato che questo log non deve contenere, e la lista bianca di
        // `@/lib/logging/redact` non la farebbe passare comunque.
        logEvento('galleria', 'info', {
            operazione: 'gallery:DELETE',
            esito: 'nel-cestino',
            sede_id: sedeMedia,
            ruolo_attore: role ?? auth.user.role ?? null,
            era_broadcast: media.is_broadcast === true,
            n_tag: Array.isArray(media.tag_students) ? media.tag_students.length : 0,
            n_notifiche_pendenti: nNotifichePendenti,
        });

        return NextResponse.json({ success: true, esito: 'nel-cestino' });
    } catch (error) {
        logErrore({ operazione: 'gallery:DELETE', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// PATCH /api/gallery
// Body: { id, tag_students, is_broadcast, target_classes, caption }
// (il campo `userId` nel body è tollerato per retro-compatibilità ma ignorato)
export const PATCH = withRoute('gallery:PATCH', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, tag_students, is_broadcast, target_classes, caption } = b.data;

        // Identità dal gate (sessione o header), MAI dal body: un userId
        // arbitrario nel body non può più impersonare un altro utente.
        const userId = auth.user.id;

        const supabase = await createAdminClient();

        // 1. Recupera il record del media — anche se è nel cestino, per poterlo
        // DIRE. Con `soloVive` questa select risponderebbe `null` e la PATCH su
        // una foto cestinata sarebbe un **404 Media non trovato**: la foto esiste,
        // è nel cestino, e per 30 giorni si può ancora ripristinare. Un 404
        // manderebbe l'interfaccia a dire «non esiste» di una cosa che esiste.
        const { data: media, error: mediaErr } = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .select('*')
                .eq('id', id),
            'gallery:PATCH deve distinguere «nel cestino» (409) da «non esiste» (404)',
        ).maybeSingle();

        if (mediaErr || !media) {
            return NextResponse.json({ error: 'Media non trovato' }, { status: 404 });
        }

        // Isolamento per sede, PRIMA di qualunque valutazione dei permessi.
        // Gemello del blocco della DELETE, stessa regola: sede assente ⇒ si NEGA
        // (`assertPagamentoInScope`), perché una riga senza plesso non è
        // attribuibile a nessuno e l'autorizzazione ricadrebbe sull'intersezione
        // dei NOMI di classe — con tre sedi «2 ANNI» esiste sia ad Aversa sia a
        // Cesa, ed era così che la maestra di Aversa poteva riscrivere (e
        // cancellare) le foto dei bambini di Cesa.
        const plessi = await scuoleDiUtente(supabase, auth.user);
        const sedeMedia = (media as { scuola_id?: string | null }).scuola_id ?? null;
        if (sedeMedia === null || !plessi.includes(sedeMedia)) {
            logEvento('galleria', 'warn', {
                operazione: 'gallery:PATCH',
                esito: sedeMedia === null ? 'media-senza-sede' : 'media-fuori-sede',
            });
            return NextResponse.json({ error: 'Media fuori dal tuo plesso' }, { status: 403 });
        }
        // Da qui in giù `sedeMedia` è una sede REALE e accessibile a chi opera:
        // è LEI la sede del media, ed è con lei — non con `plessi` — che si
        // misurano i tag e il consenso (vedi il blocco più in basso).

        // 2. Recupera il ruolo dell'utente da utenti
        const { data: utentiRecord } = await supabase
            .from('utenti')
            .select('ruolo, scuola_id')
            .eq('id', userId)
            .maybeSingle();

        const role = utentiRecord?.ruolo;
        const userScuolaId = utentiRecord?.scuola_id;

        const isAdmin = ['admin', 'segreteria', 'direzione', 'segretaria'].includes(role ?? '');
        const isCoordinator = ['coordinator', 'coordinatore'].includes(role ?? '');
        const isEducator = ['educator', 'maestra'].includes(role ?? '');

        let authorized = false;

        if (isAdmin) {
            authorized = true;
        } else if (isCoordinator) {
            const { data: uploaderRecord } = await supabase
                .from('utenti')
                .select('scuola_id')
                .eq('id', media.uploaded_by)
                .maybeSingle();

            if (uploaderRecord?.scuola_id === userScuolaId) {
                authorized = true;
            }
        } else if (isEducator) {
            if (media.uploaded_by === userId) {
                authorized = true;
            } else {
                // Oppure se il media riguarda le sue classi — dedotte dai suoi
                // media VIVI (vedi `alunniTaggatiNeiMieiMediaVivi`: una foto
                // eliminata non concede più permessi).
                const myTaggedStudentIds = await alunniTaggatiNeiMieiMediaVivi(
                    supabase, userId, 'gallery:PATCH',
                );

                let myClassNames: string[] = [];

                if (myTaggedStudentIds.length > 0) {
                    // `.in('scuola_id', plessi)`: gemello del presidio della
                    // DELETE, che il 30/07 era stato messo su una copia sola del
                    // frammento. Senza, un vecchio tag su un bambino di un altro
                    // plesso fa entrare il NOME della SUA classe fra «le classi
                    // del docente», e da lì autorizza a RISCRIVERE l'omonima.
                    const { data: myStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', myTaggedStudentIds)
                        .in('scuola_id', plessi);

                    myClassNames = [...new Set(
                        (myStudents ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
                    )];
                }

                const hasClassIntersection = media.target_classes?.some((c: string) => myClassNames.includes(c));

                let hasStudentIntersection = false;
                if (media.tag_students && media.tag_students.length > 0) {
                    const { data: taggedStudents } = await supabase
                        .from('alunni')
                        .select('classe_sezione')
                        .in('id', media.tag_students)
                        .in('scuola_id', plessi);

                    hasStudentIntersection = taggedStudents?.some(
                        (s: { classe_sezione: string }) => myClassNames.includes(s.classe_sezione)
                    ) ?? false;
                }

                if (hasClassIntersection || hasStudentIntersection) {
                    authorized = true;
                }
            }
        }

        if (!authorized) {
            return NextResponse.json(
                { error: 'Non sei autorizzato a modificare questo media' },
                { status: 403 }
            );
        }

        // ─── UNA FOTO NEL CESTINO NON SI MODIFICA ────────────────────────────
        //
        // Non si ritagga, non si ridenomina e non si rende broadcast una foto che
        // qualcuno ha eliminato. Il PATCH è l'unica strada con cui si scrivono i
        // TAG, cioè gli uuid dei minori ritratti, e aggiungerne uno a una riga nel
        // cestino significherebbe legare un bambino a una foto che nessuno vede
        // più: non la annuncia a nessuno, non compare da nessuna parte, e resta
        // scritta in tabella e nel diff dell'audit. Un dato su un minore scritto in
        // un posto che nessuno guarda è la definizione del dato che non si doveva
        // raccogliere.
        //
        // ⚠️ 409 e non 403: non è una questione di titolo — chi chiede ce l'ha, il
        // gate è appena passato — è lo STATO della riga a rendere l'operazione
        // senza senso. Prima si ripristina, poi si modifica.
        //
        // ⚠️ E DOPO il gate di sede e l'autorizzazione, non appena letta la riga:
        // «409 nel cestino» è un'informazione sullo stato di un media, e chi non ha
        // titolo su quel plesso deve continuare a vedere 403/404 come prima. Lo
        // stesso ordine della DELETE, per la stessa ragione.
        if (((media as { eliminato_il?: string | null }).eliminato_il ?? null) !== null) {
            logEvento('galleria', 'warn', {
                operazione: 'gallery:PATCH',
                esito: 'media-nel-cestino',
                sede_id: sedeMedia,
            });
            return NextResponse.json(
                {
                    error: 'Questa foto è nel cestino: ripristinala prima di modificarla.',
                    codice: 'GALLERIA_MEDIA_NEL_CESTINO',
                },
                { status: 409 }
            );
        }

        // Broadcast è operazione di Direzione (admin/coordinatore): un
        // non-direzione non può né impostare/mantenere broadcast=true né
        // cambiare il flag su un media esistente.
        const isDirezione = ['admin', 'coordinator'].includes(auth.user.role);
        const broadcastEffettivo = (is_broadcast !== undefined ? is_broadcast : media.is_broadcast) === true;
        const cambiaBroadcast = is_broadcast !== undefined && (is_broadcast === true) !== (media.is_broadcast === true);
        if (!isDirezione && (broadcastEffettivo || cambiaBroadcast)) {
            return NextResponse.json(
                { error: 'Solo la Direzione (admin o coordinatore) può gestire i media in broadcast.' },
                { status: 403 }
            );
        }

        // BROADCAST ⇒ NESSUN TAG, dall'altro lato della porta (gemello del
        // presidio della POST, rilievo privacy F5 del 2026-07-31). Si guardano i
        // valori EFFETTIVI, non quelli del body: il client manda `tag_students`
        // da solo (`teacher/gallery/page.tsx:402`, `handleUpdateTags`), quindi
        // senza leggere `media.is_broadcast` si potrebbero appiccicare i tag a
        // una foto già istituzionale — cioè ottenere per modifica esattamente
        // ciò che la POST rifiuta.
        // Le due correzioni restano possibili: `{tag_students: []}` svuota i tag
        // e `{is_broadcast: false}` toglie il broadcast, e nessuna delle due
        // passa di qui. (In produzione, al 2026-07-31, `galleria_media_v2` è
        // vuota: nessun media storico da sanare.)
        const tagEffettivi = [...new Set(
            ((tag_students !== undefined ? tag_students : media.tag_students) ?? []) as string[]
        )];
        if (broadcastEffettivo && tagEffettivi.length > 0) {
            logEvento('galleria', 'warn', {
                operazione: 'gallery:PATCH',
                esito: 'broadcast-con-tag',
                tipo: 'broadcast-con-tag',
                taggati: tagEffettivi.length,
            });
            return NextResponse.json(
                {
                    error: 'Una foto in broadcast non può taggare bambini: va a tutta la classe o a tutta la sede. Togli i tag, oppure togli il broadcast e tagga solo chi ha la liberatoria foto.',
                },
                { status: 400 }
            );
        }

        // LO SCOPE DI SEDE DEI TAG, gemello di quello della POST — e per tre
        // giorni è mancato proprio qui (rilievo T05-F1 del 2026-08-03).
        // `PATCH {"id":"<un mio media>","tag_students":["<uuid di un minore di
        // un'altra sede>"]}` arrivava dritto al Privacy Lock, che rispondeva 422
        // con NOME e COGNOME del bambino e l'informazione che gli manca la
        // liberatoria. Il presidio esisteva, ma era una COPIA dentro l'handler
        // della POST invece che una primitiva: ora è uno solo, e lo chiamano
        // tutti e due.
        //
        // Si guardano i tag EFFETTIVI, come per il broadcast qui sopra: il client
        // rimanda `tag_students` anche quando cambia solo la didascalia
        // (`teacher/gallery/page.tsx`, `handleUpdateTags`), e un media che porta
        // già un tag fuori sede non si tocca finché quel tag c'è — è
        // un'anomalia, e su un'anomalia si nega (in produzione, al 2026-08-03,
        // `galleria_media_v2` è vuota: nessun media storico da sanare).
        // Le correzioni restano possibili: `{tag_students: []}` svuota i tag e
        // non passa di qui.
        //
        // ⚠️ LA SEDE È QUELLA DEL MEDIA, NON I PLESSI DI CHI OPERA (2026-08-03,
        // rilievo W3 del verificatore adversariale). Qui c'era `plessi`, cioè
        // `scuoleDiUtente`: per un admin di due sedi quell'elenco ne conteneva
        // due, e `PATCH {"id":"<un media della sede A>","tag_students":["<uuid
        // di un minore della sede B>"]}` rispondeva **200**, scrivendo l'uuid di
        // un bambino di B dentro una riga di A. Il gate verificava che chi opera
        // avesse titolo su quel bambino — e ce l'aveva — ma la domanda giusta è
        // un'altra: **questo bambino è della sede in cui il media vive?** La
        // risposta la dà `sedeMedia`, già letta e già verificata accessibile.
        const sediDelMedia = [sedeMedia];
        const tagFuoriSede = await assertTagStudentsInScope(supabase, tagEffettivi, sediDelMedia, 'gallery:PATCH');
        if (tagFuoriSede) return tagFuoriSede;

        // 3. Esegui l'aggiornamento
        // Privacy Lock (DL-041): valida i tag EFFETTIVI quando si modificano tag/broadcast.
        if (tag_students !== undefined || is_broadcast !== undefined) {
            const effTags = tag_students !== undefined ? tag_students : media.tag_students;
            // Anche qui la sede del MEDIA, gemella della POST: con l'elenco dei
            // plessi dell'operatore il 422 potrebbe pronunciare il nome di un
            // bambino di un altro plesso.
            const senza = await alunniSenzaConsenso(supabase, effTags, sediDelMedia);
            if (senza.length > 0) {
                // Come nel POST: nel log solo conteggi, mai nomi/id dei bambini.
                logEvento('galleria', 'info', {
                    operazione: 'gallery:PATCH',
                    esito: 'liberatoria-mancante',
                    taggati: Array.isArray(effTags) ? new Set(effTags).size : 0,
                    senzaConsenso: senza.length,
                });
                return NextResponse.json(
                    {
                        error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).',
                        nomi: senza.map((s) => s.nome),
                        ids: senza.map((s) => s.id),
                    },
                    { status: 422 }
                );
            }
        }

        const updateData: Record<string, unknown> = {};
        if (tag_students !== undefined) updateData.tag_students = tag_students;
        if (is_broadcast !== undefined) updateData.is_broadcast = is_broadcast;
        if (target_classes !== undefined) updateData.target_classes = target_classes;
        if (caption !== undefined) updateData.caption = caption;

        // `ancheNelCestino` e non `soloVive`, ed è la forma che il modulo stesso
        // prevede per «le scritture per id su una riga già letta»: chi decide se
        // questa riga si può toccare è il 409 poche decine di righe più su, che ha
        // letto `eliminato_il` sulla riga vera. Aggiungere qui la condizione
        // significherebbe, in caso di corsa, un `.single()` a zero righe — cioè un
        // **500** al posto del 409 che l'utente deve leggere.
        // ⚠️ La corsa residua è dichiarata e non chiusa: se qualcuno cestina la
        // foto negli istanti fra quel controllo e questa scrittura, i tag finiscono
        // su una riga destinata alla purga. Non è una fuga (nessuno la vede) e non
        // è un dato in più su un minore che non fosse già in quella riga, ma è il
        // verso in cui questo handler può sbagliare, e va scritto dove sta il codice.
        const { data: updatedMedia, error: updateErr } = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .update(updateData)
                .eq('id', id)
                .select()
                .single(),
            'la riga e appena stata letta e il 409 «media-nel-cestino» ha già deciso che è viva: ripetere qui la condizione trasformerebbe una corsa in un 500 invece del 409 giusto',
        );

        if (updateErr) {
            logErrore({ operazione: 'gallery:PATCH', stato: 500, evento: 'db' }, updateErr);
            return NextResponse.json({ error: updateErr.message }, { status: 500 });
        }

        return NextResponse.json(updatedMedia);
    } catch (error) {
        logErrore({ operazione: 'gallery:PATCH', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

