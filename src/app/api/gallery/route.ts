import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami';
import { resolveScuoleAttive, resolveScuolaScrittura, scuoleDiUtente } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { alunniSenzaConsenso } from '@/lib/gallery/privacy';
import { firmaMediaGalleria, percorsoNelBucket } from '@/lib/gallery/storage';
import { proiettaPerGenitore } from './proiezione';
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
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
});

const postBodySchema = z.object({
    // `uploaded_by` dal client è volutamente ignorato (si usa l'utente del gate).
    file_url: z.string().min(1, 'file_url è obbligatorio'),
    file_type: z.string().nullish(),
    caption: z.string().nullish(),
    // Lasco: oggi nessun vincolo uuid sugli id taggati.
    tag_students: z.array(z.string()).nullish(),
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
    tag_students: z.array(z.string()).nullish(),
    is_broadcast: z.boolean().nullish(),
    target_classes: z.array(z.string()).nullish(),
    caption: z.string().nullish(),
});

// GET /api/gallery?studentId=xxx&classe=xxx&date=YYYY-MM-DD&limit=30&offset=0
// Lista media con filtri (studentId per genitore, classe per insegnante).
// Filtri e paginazione applicati in SQL (.or + .range): niente scarico dell'intera
// tabella con filtro/slice in memoria. Contratto risposta invariato: { media, total }.
export const GET = withRoute('gallery:GET', async (request: Request) => {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { studentId, classe, date } = q.data;
        const limit = Math.min(Math.max(parseInt(q.data.limit ?? '30') || 30, 1), 100);
        const offset = Math.max(parseInt(q.data.offset ?? '0') || 0, 0);

        // Gate identità: mai più lettura anonima. Con studentId il gate verifica
        // anche che quel bambino sia raggiungibile da chi chiede — legame di
        // famiglia per il genitore, plesso e sezione per tutti gli altri (401
        // anonimo / 403 figlio altrui o bambino di un'altra sede); senza
        // studentId (lista/classe) la lettura è riservata a staff/docente.
        const auth = studentId
            ? await requireParentOfStudent(request, studentId)
            : await requireDocente(request);
        if (auth.response) return auth.response;

        // Genitore: il parentId storico in query deve coincidere con l'identità
        // reale del gate (anti-IDOR sul parametro; il legame è già verificato).
        if (auth.user.role === 'genitore' && q.data.parentId && q.data.parentId !== auth.user.id) {
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
        if (!classe && !studentId) {
            return NextResponse.json(
                { error: 'Specificare la classe (classe) o l\'alunno (studentId)' },
                { status: 400 }
            );
        }
        let plessi: string[] = [];
        if (classe) {
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
            if (auth.user.role !== 'genitore') {
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
        let studentIds: string[] = [];
        if (classe) {
            const alunniQ = supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classe)
                .in('scuola_id', plessi);
            const { data: students, error: stErr } = await alunniQ;
            if (stErr) {
                logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, stErr);
                return NextResponse.json({ error: stErr.message }, { status: 500 });
            }
            studentIds = (students?.map(s => s.id) ?? []).filter(id => UUID_RE.test(id));
        }

        // Builder dei media: `conScuola=false` toglie il SOLO filtro sede per il
        // degrado sul DB E2E CI non migrato (colonna scuola_id assente → 42703).
        const buildMedia = (conScuola: boolean) => {
            let query = supabase
                .from('galleria_media_v2')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false });

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
            if (studentId) {
                query = query.or(`is_broadcast.eq.true,tag_students.cs.{${studentId}}`);
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

        let mediaRes = await buildMedia(true);
        // DB E2E CI non migrato: scuola_id assente → 42703 (o PGRST204). Qui si
        // rileggeva SEMPRE senza il filtro di sede: su un impianto multi-sede è
        // il fail-open peggiore, perché scatta proprio quando l'isolamento non è
        // disponibile. Ora vale la stessa regola della modulistica
        // (`degradoSedeLecito`): si prosegue senza filtro SOLO se non c'è niente
        // da isolare (al più una sede reale), altrimenti si NEGA.
        if (colonnaSedeAssente(mediaRes.error as { code?: string } | null)) {
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
            mediaRes = await buildMedia(false);
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

        // `studentId` presente ⇒ chi legge è un GENITORE (il gate sopra è
        // `requireParentOfStudent`). A lui `tag_students` — gli uuid degli altri
        // minori ritratti nella stessa foto di gruppo — non serve e non deve
        // uscire: GDPR art. 5.1.c. Vedi `./proiezione`.
        const enriched = page.map((media) => {
            const uploader = uploaderById.get(media.uploaded_by);
            return proiettaPerGenitore(
                {
                    ...media,
                    uploader_name: uploader
                        ? `${uploader.first_name || uploader.nome} ${uploader.last_name || uploader.cognome}`
                        : 'Sconosciuto',
                },
                Boolean(studentId),
            );
        });

        // Il bucket `gallery` è PRIVATO: in tabella c'è il percorso del file, e
        // l'indirizzo con cui la foto si guarda nasce QUI, firmato e a scadenza
        // breve, solo per chi ha superato il gate e lo scope di sede appena
        // applicati. Una chiamata sola per l'intera pagina.
        const conLink = await firmaMediaGalleria(supabase, enriched, 'gallery:GET');

        return NextResponse.json({ media: conLink, total: count ?? 0 });
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

        // LO SCOPE DI SEDE VIENE PRIMA DEL PRIVACY LOCK, e non è un dettaglio
        // d'ordine. Fino al 2026-07-31 `alunniSenzaConsenso` interrogava `alunni`
        // con `.in('id', ids)` senza filtro di sede, e il 422 che ne usciva
        // portava NOMI E COGNOMI dei minori taggati più l'informazione che a loro
        // manca la liberatoria fotografica. Il collaudo privacy l'ha misurato con
        // la controprova su tre sedi: la risposta era IDENTICA per la segreteria
        // che ne aveva titolo e per quella di un altro plesso. Bastava conoscere
        // gli uuid — e un uuid non è un segreto.
        //
        // `tag_students` era l'unico ingresso rimasto che accettava
        // identificatori di minori senza chiedersi di chi fossero: GET, PATCH e
        // DELETE di questa stessa route lo scope l'avevano già.
        if (tagUnici.length > 0) {
            const plessi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user);
            // Scope vuoto ⇒ NEGA: è la regola del progetto, e qui vale doppio.
            if (plessi.length === 0) {
                return NextResponse.json({ error: 'Nessuna sede selezionata' }, { status: 403 });
            }
            const { data: alunniInScope, error: errScope } = await supabase
                .from('alunni')
                .select('id')
                .in('id', tagUnici)
                .in('scuola_id', plessi);
            // PostgREST non lancia: senza questo controllo un errore di lettura
            // diventerebbe «nessun alunno in scope» e poi, peggio, un permesso.
            if (errScope) {
                logErrore({ operazione: 'gallery:POST', stato: 500, evento: 'db' }, errScope);
                return NextResponse.json({ error: 'Verifica dei tag non riuscita' }, { status: 500 });
            }
            const ammessi = new Set((alunniInScope ?? []).map((a) => a.id as string));
            if (tagUnici.some((id) => !ammessi.has(id))) {
                // Solo conteggi nel log, e NIENTE nel corpo: dire quali sono
                // confermerebbe l'esistenza di quei bambini a chi non ha titolo.
                logEvento('galleria', 'warn', {
                    operazione: 'gallery:POST',
                    esito: 'tag-fuori-sede',
                    tipo: 'tag-fuori-sede',
                    taggati: tagUnici.length,
                    fuoriSede: tagUnici.filter((id) => !ammessi.has(id)).length,
                });
                return NextResponse.json(
                    { error: 'Uno o più bambini taggati non appartengono ai tuoi plessi.' },
                    { status: 403 }
                );
            }
        }

        // Privacy Lock (DL-041): inibisce il tagging di alunni senza consenso
        // privacy (liberatoria foto) sulle foto di GRUPPO. Il canale non lo
        // spegne più: `alunniSenzaConsenso` non accetta nemmeno l'argomento con
        // cui prima lo si spegneva (vedi la nota in `@/lib/gallery/privacy`).
        const senza = await alunniSenzaConsenso(supabase, tag_students);
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

        // Sede (tenant) del media: DICHIARATA dal client (`scuola_id`), oppure
        // dedotta dal SedeSelector / dall'unico plesso dell'utente.
        //
        // ⚠️ Qui c'era `sw.scuolaId ?? auth.user.scuola_id ?? null`, cioè la
        // risposta del resolver veniva IGNORATA: `sw.response` non era nemmeno
        // guardata. Per l'admin multi-plesso il 400 «specificare la sede» non
        // arrivava mai — arrivava una foto archiviata nella sua sede PRIMARIA,
        // qualunque plesso avesse in mente. E la sede sbagliata non resta sulla
        // riga: comanda anche i destinatari della notifica qui sotto, cioè
        // annuncia le foto ai genitori dell'altro plesso e non a quelli giusti.
        // Chi ha un solo plesso non cambia comportamento.
        const sw = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, scuola_id ?? undefined);
        if (sw.response) return sw.response;
        const scuolaId = sw.scuolaId as string;

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

        let insRes = await supabase
            .from('galleria_media_v2')
            .insert({ ...baseRecord, scuola_id: scuolaId })
            .select()
            .single();
        // DB E2E CI non migrato: colonna scuola_id assente → PGRST204 (o 42703).
        // Riprova senza scuola_id così la pubblicazione resta possibile (degrado).
        if (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '')) {
            logEvento('galleria', 'info', {
                operazione: 'gallery:POST',
                esito: 'degrado-scuola-id-assente',
            });
            insRes = await supabase
                .from('galleria_media_v2')
                .insert(baseRecord)
                .select()
                .single();
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

// DELETE /api/gallery?id=xxx&userId=yyy
// Cancella un media con controllo granularizzato dei ruoli
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

        // 1. Recupera il record del media
        const { data: media, error: mediaErr } = await supabase
            .from('galleria_media_v2')
            .select('*')
            .eq('id', id)
            .maybeSingle();

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
        {
            const sedeMedia = (media as { scuola_id?: string | null }).scuola_id ?? null;
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
                const { data: myMedia } = await supabase
                    .from('galleria_media_v2')
                    .select('tag_students')
                    .eq('uploaded_by', userId)
                    .not('tag_students', 'is', null);

                const myTaggedStudentIds = (myMedia ?? [])
                    .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                    .filter(Boolean);

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

        // Esegui la cancellazione
        const { error: deleteErr } = await supabase
            .from('galleria_media_v2')
            .delete()
            .eq('id', id);

        if (deleteErr) {
            logErrore({ operazione: 'gallery:DELETE', stato: 500, evento: 'db' }, deleteErr);
            return NextResponse.json({ error: deleteErr.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
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

        // 1. Recupera il record del media
        const { data: media, error: mediaErr } = await supabase
            .from('galleria_media_v2')
            .select('*')
            .eq('id', id)
            .maybeSingle();

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
        {
            const sedeMedia = (media as { scuola_id?: string | null }).scuola_id ?? null;
            if (sedeMedia === null || !plessi.includes(sedeMedia)) {
                logEvento('galleria', 'warn', {
                    operazione: 'gallery:PATCH',
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
                // Oppure se il media riguarda le sue classi
                const { data: myMedia } = await supabase
                    .from('galleria_media_v2')
                    .select('tag_students')
                    .eq('uploaded_by', userId)
                    .not('tag_students', 'is', null);

                const myTaggedStudentIds = (myMedia ?? [])
                    .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                    .filter(Boolean);

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

        // 3. Esegui l'aggiornamento
        // Privacy Lock (DL-041): valida i tag EFFETTIVI quando si modificano tag/broadcast.
        if (tag_students !== undefined || is_broadcast !== undefined) {
            const effTags = tag_students !== undefined ? tag_students : media.tag_students;
            const senza = await alunniSenzaConsenso(supabase, effTags);
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

        const { data: updatedMedia, error: updateErr } = await supabase
            .from('galleria_media_v2')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

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

