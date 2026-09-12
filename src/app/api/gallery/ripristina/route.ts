import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
// IL CESTINO — la regola sta in UN posto, e non è questo file.
// `ancheNelCestino` per la lettura (qui la domanda È «in che stato è questa
// riga?», quindi filtrarla vorrebbe dire non poterla rispondere),
// `soloNelCestino` per la scrittura (è la condizione che decide la corsa fra due
// impiegate), `colonnaCestinoAssente` per l'impianto che quelle colonne non le ha
// (il DB E2E della CI), `GIORNI_CESTINO_GALLERIA` perché il 30 non si riscrive.
import {
    ancheNelCestino,
    colonnaCestinoAssente,
    GIORNI_CESTINO_GALLERIA,
    soloNelCestino,
} from '@/lib/gallery/cestino';
import { logScrittura } from '@/lib/audit/scrittura';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

/* ════════════════════════════════════════════════════════════════════════════
 * POST /api/gallery/ripristina — la foto torna dal cestino
 *
 * ─── PERCHÉ UNA ROTTA SUA, E NON UN RAMO DELLA PATCH ────────────────────────
 *
 * Perché è l'operazione INVERSA di `gallery:DELETE`, e l'unica cosa che le due
 * hanno in comune è la tabella. Un ramo dentro la PATCH — che accetta tag,
 * didascalia, broadcast e classi — avrebbe messo il ripristino dietro lo schema
 * zod di un'altra operazione (`{ id, tag_students?, caption?, … }`), dentro lo
 * stesso `withRoute`, quindi sotto la STESSA riga di `app_log`: «chi ha
 * ripristinato quella foto e quando» sarebbe stato indistinguibile da «chi ne ha
 * cambiato la didascalia». Qui il nome nei log è suo (`gallery/ripristina:POST`),
 * lo schema è di due campi meno tre, e il gate è più stretto di quello della
 * PATCH — che è il punto successivo.
 *
 * ─── IL GATE È `requireStaff`, E L'INSEGNANTE È ESCLUSO PER PROGETTO ────────
 *
 * `requireDocente` (il gate di DELETE e PATCH) ammette anche `educator`: una
 * maestra può eliminare le foto delle proprie classi, ed è giusto — è lei che sa
 * quale scatto è venuto male o ritrae un bambino che non doveva esserci.
 * Ripristinare no, e non è una gerarchia: è il modo in cui «Elimina» resta un
 * gesto a basso rischio. Se chi elimina potesse anche annullare, l'eliminazione
 * sarebbe un interruttore, e un interruttore lo si preme due volte; con la
 * segreteria di mezzo, un ripristino è una richiesta che qualcuno valuta — ed è
 * esattamente ciò che il dialogo promette all'insegnante («la segreteria può
 * ripristinarla entro 30 giorni», `DialogoEliminaMedia.tsx`).
 *
 * `requireStaff` col suo elenco di serie — `admin`, `coordinator`, `segreteria` —
 * è quell'insieme. I due nomi storici che si incontrano leggendo `gallery:DELETE`
 * (`direzione`, `segretaria`, nella sua lista `isAdmin`) NON sono un buco lasciato
 * aperto qui: sono valori di `utenti.ruolo` che in produzione non esistono più
 * — misurato il 2026-09-12, `utenti` ha soltanto `genitore` (776), `educator`
 * (67), `segreteria` (7), `admin` (4), `coordinator` (1), `cuoca` (1) — e che non
 * arriverebbero comunque fin dentro il corpo di quegli handler, perché
 * `requireDocente` li respinge prima con un 403. Un alias che nessun gate ammette
 * non è un permesso: è una riga di codice che non viene mai presa.
 * ════════════════════════════════════════════════════════════════════════════ */

const bodySchema = z.object({ id: zUuid });

/**
 * Le sole colonne che questa rotta legge, e il perché di ogni assenza.
 *
 * `select('*')` sarebbe stato più comodo e più corto — è ciò che fanno DELETE e
 * PATCH, che di quella riga hanno bisogno per intero — e porterebbe qui dentro
 * `caption` e `tag_students`: la didascalia della galleria È il nome del file
 * scelto da chi carica, e nella pratica di questa scuola è «Marco al parco.jpg»,
 * cioè il nome di un bambino. Per decidere un ripristino non serve, e un dato che
 * non si legge non può finire in un log per distrazione: la lista bianca di
 * `@/lib/logging/redact` è la seconda difesa, questa è la prima.
 */
const COLONNE = 'id, scuola_id, eliminato_il, file_rimosso_il';

interface RigaCestino {
    id: string;
    scuola_id: string | null;
    eliminato_il: string | null;
    file_rimosso_il: string | null;
}

/**
 * Il cestino non c'è su questo impianto: la riga NON è stata ripristinata.
 *
 * È il degrado del DB E2E della CI, che è un progetto separato e non migrato: là
 * `eliminato_il`/`file_rimosso_il` non esistono e PostgREST risponde `42703` in
 * SELECT, `PGRST204` in UPDATE.
 *
 * ⚠️ Gli stessi due codici li produce anche `scuola_id` assente, e distinguerli è
 * impossibile — PostgREST dice «una colonna non c'è», mai QUALE. Qui, a
 * differenza di `gallery:GET`, non serve indovinare: senza `scuola_id` la sede del
 * media non è verificabile e senza le colonne del cestino non c'è niente da
 * ripristinare, quindi la risposta è la stessa in entrambi i casi — non si scrive.
 * È anche il verso giusto in cui sbagliare: un ripristino negato non perde niente
 * (la riga resta nel cestino e si riprova), mentre negare una LETTURA come fa il
 * GET lascerebbe a schermo una galleria vuota.
 *
 * 501 e non 500, ed è la differenza che l'utente deve leggere: non è un guasto
 * passeggero da riprovare fra un minuto, è una funzione che su questo impianto non
 * c'è. Il `codice` accanto alla prosa non è decorazione: chi lavora con
 * l'interfaccia in inglese riceve la frase del catalogo al posto di questa
 * italiana (`messaggioErrore` → `CODICI_ERRORE`), e senza di esso leggerebbe
 * italiano dentro un'interfaccia inglese.
 */
function cestinoNonDisponibile(sedeMedia: string | null): NextResponse {
    logEvento('galleria', 'error', {
        operazione: 'gallery/ripristina:POST',
        esito: 'cestino-colonna-assente',
        sede_id: sedeMedia,
    });
    return NextResponse.json(
        {
            error: 'Cestino della galleria non disponibile su questo impianto: la foto non è stata ripristinata',
            codice: 'GALLERIA_RIPRISTINO_NON_DISPONIBILE',
        },
        { status: 501 },
    );
}

export const POST = withRoute('gallery/ripristina:POST', async (request: Request) => {
    try {
        // 1. CHI SEI, prima di tutto il resto — e prima di leggere il corpo
        // (`corpo-letto-dopo-il-gate`): un anonimo non deve poter far
        // deserializzare niente al server.
        const auth = await requireStaff(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, bodySchema);
        if ('response' in b) return b.response;
        const { id } = b.data;

        const supabase = await createAdminClient();

        // 2. LA RIGA, CESTINO COMPRESO — ed è l'unico verso possibile.
        //
        // `soloNelCestino` qui sembrerebbe la scelta ovvia («ripristino solo ciò
        // che è nel cestino») e sarebbe sbagliata: farebbe rispondere `null` a una
        // foto VIVA, cioè **404 «Media non trovato»** su una foto che esiste e che
        // la segreteria sta guardando. Il 409 qui sotto esiste proprio per dire
        // «questa non è nel cestino», e per dirlo bisogna poterla leggere.
        const { data, error: letturaErr } = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .select(COLONNE)
                .eq('id', id),
            'il ripristino deve distinguere «era nel cestino» da «non esiste» e da «il suo file è uscito dallo Storage»: sono tre risposte diverse, e un filtro sul cestino le ridurrebbe tutte e tre a un 404 che mente',
        ).maybeSingle();
        const media = data as RigaCestino | null;

        // Il degrado viene PRIMA del controllo dell'errore generico: su un
        // impianto senza le colonne non c'è nessun guasto da segnalare come 500,
        // c'è una funzione che non esiste.
        if (colonnaCestinoAssente(letturaErr)) return cestinoNonDisponibile(null);

        if (letturaErr) {
            // PostgREST non lancia: ritorna `{ error }`, e senza questo controllo
            // un guasto di lettura sarebbe uscito come `data: null`, cioè come un
            // 404 «non esiste» su una riga che c'è.
            logErrore({ operazione: 'gallery/ripristina:POST', stato: 500, evento: 'db' }, letturaErr);
            return NextResponse.json(
                { error: 'Non è stato possibile leggere questa foto. Riprova fra poco.', codice: 'LETTURA_FALLITA' },
                { status: 500 },
            );
        }

        if (!media) {
            // La prosa è la STESSA frase del catalogo italiano
            // (`erroreGalleriaMediaNonTrovato`), non il «Media non trovato» di
            // `gallery:DELETE`: chi traduce il codice legge il catalogo, chi non lo
            // traduce legge questa riga, e le due non devono dire cose diverse.
            return NextResponse.json(
                {
                    error: 'Questa foto non esiste più: aggiorna l’elenco del cestino.',
                    codice: 'GALLERIA_MEDIA_NON_TROVATO',
                },
                { status: 404 },
            );
        }

        // 3. ISOLAMENTO DI SEDE, PRIMA DI QUALUNQUE ALTRA VALUTAZIONE.
        //
        // La sede è quella DEL MEDIA (`scuola_id`), verificata contro i plessi di
        // chi opera. Sede nulla ⇒ si NEGA: una riga senza plesso non è
        // attribuibile a nessuno (in produzione non ce n'è nessuna — misurato il
        // 2026-09-12 su 1327 righe — e il giorno che ne comparisse una, nessun
        // operatore avrebbe titolo a dire che è sua).
        //
        // ⚠️ QUI `resolveScuolaScrittura` SAREBBE SBAGLIATA, e va scritto perché è
        // il tipo di cosa che qualcuno «correggerà» in futuro vedendo una scrittura
        // senza il resolver di sede. Quel resolver serve quando la sede della riga
        // la deve SCEGLIERE chi scrive (la POST che pubblica una foto: senza una
        // sede dichiarata, l'archivierebbe nel plesso sbagliato in silenzio). Qui
        // la riga esiste già e la sua sede è un fatto scritto in tabella: chiedere
        // all'operatore di dichiararla vorrebbe dire fargli scegliere un dato che
        // non è suo, e per chi ha più di un plesso `resolveScuolaScrittura`
        // risponderebbe **400 «specificare la sede»** su un gesto che di ambiguità
        // non ne ha nessuna — c'è UNA riga, e ha UNA sede.
        const plessi = await scuoleDiUtente(supabase, auth.user);
        const sedeMedia = media.scuola_id;
        if (sedeMedia === null || !plessi.includes(sedeMedia)) {
            logEvento('galleria', 'warn', {
                operazione: 'gallery/ripristina:POST',
                esito: sedeMedia === null ? 'media-senza-sede' : 'media-fuori-sede',
            });
            return rifiutoSede('SEDE_NON_ACCESSIBILE');
        }

        // 4. SI PUÒ RIPRISTINARE? Due stati dicono no, e per ragioni diverse.
        //
        // Il controllo sta QUI, DOPO il gate di sede: un 409 dato prima sarebbe un
        // oracolo — chiunque, con un uuid, saprebbe che quel media esiste e che
        // qualcuno l'ha eliminato. Chi non ne ha titolo continua a prendersi
        // 403/404 come prima.
        //
        //  · `eliminato_il IS NULL` — non era nel cestino. E qui NON si risponde
        //    «già fatto» con un 200, che è la scelta opposta a quella di
        //    `gallery:DELETE` («già eliminato» → 200) e non è un'incoerenza da
        //    appianare: due persone che premono Elimina sulla stessa foto vogliono
        //    la stessa cosa e la ottengono, mentre chi preme Ripristina su una foto
        //    viva sta guardando un elenco del cestino che non è più vero — e
        //    dirglielo è l'unico modo perché ricarichi la pagina invece di credere
        //    di aver recuperato qualcosa;
        //  · `file_rimosso_il IS NOT NULL` — il file è uscito dallo Storage. La riga
        //    si potrebbe riportare in vita in un millisecondo, e sarebbe la cosa
        //    peggiore: ai genitori comparirebbe in galleria una foto ROTTA, con la
        //    firma dello Storage che risponde 404 sul contenuto. In produzione oggi
        //    nessuna riga è in questo stato (0 su 1327, misurato il 2026-09-12,
        //    perché la purga non ha ancora mai girato): questo ramo nasce prima del
        //    caso che lo richiede, ed è il verso giusto — quando la purga girerà,
        //    non ci sarà da ricordarsene.
        //
        // ⚠️ LIMITE DICHIARATO: i due stati condividono UN codice
        // (`MEDIA_NON_RIPRISTINABILE`), quindi chi traduce il codice legge una frase
        // che li nomina entrambi. La prosa italiana qui sotto distingue, ma la vede
        // solo un client che il codice non lo traduce. Ciò che distingue sempre è
        // l'`esito` del log (`non-era-nel-cestino` / `file-gia-rimosso`): è lì che
        // guarda chi deve capire cosa è successo, e i due esiti non vanno unificati
        // «perché la risposta HTTP è la stessa».
        // L'istante dell'eliminazione si prende PRIMA della scrittura che lo
        // cancella, e si usa quello anche dopo: il log di successo qui sotto ne ha
        // bisogno, e rileggerlo da `media` funzionerebbe soltanto perché PostgREST
        // restituisce uno scatto invece della riga viva. Un valore usato dopo una
        // scrittura che lo azzera si cattura prima — costa una riga.
        const eliminatoIl = media.eliminato_il;
        const eraNelCestino = eliminatoIl !== null;
        const fileRimosso = media.file_rimosso_il !== null;
        if (!eraNelCestino || fileRimosso) {
            logEvento('galleria', 'info', {
                operazione: 'gallery/ripristina:POST',
                esito: fileRimosso ? 'file-gia-rimosso' : 'non-era-nel-cestino',
                sede_id: sedeMedia,
                ruolo_attore: auth.user.role,
            });
            return NextResponse.json(
                {
                    error: fileRimosso
                        ? 'Questa foto non si può più ripristinare: il suo file è stato distrutto allo scadere dei 30 giorni.'
                        : 'Questa foto non è nel cestino: è già visibile in galleria. Ricarica l’elenco.',
                    codice: 'MEDIA_NON_RIPRISTINABILE',
                },
                { status: 409 },
            );
        }

        // 5. IL RIPRISTINO.
        //
        // Tre condizioni dentro l'UPDATE, e nessuna delle tre è una cintura di
        // troppo sui controlli qui sopra:
        //
        //  · `soloNelCestino` — `eliminato_il IS NOT NULL` e `file_rimosso_il IS
        //    NULL`, cioè le stesse due domande del 409, poste però nell'istante
        //    della scrittura. Fra la lettura e questa riga passa il tempo di una
        //    query, e in quella finestra un'altra impiegata può aver già premuto
        //    Ripristina, oppure la purga può aver portato via il file. La
        //    condizione la mette la funzione del modulo e non un `.not()` scritto a
        //    mano: una copia in più della regola è la copia che un giorno si
        //    dimentica;
        //  · `.in('scuola_id', plessi)` — l'isolamento di sede scritto DENTRO la
        //    query invece che solo nell'`if` venti righe sopra. Un perimetro nel
        //    testo della query non si può perdere spostando un blocco, e questa
        //    rotta scrive su una tabella di foto di minori di tre plessi diversi.
        const ripristinoRes = await soloNelCestino(
            supabase
                .from('galleria_media_v2')
                .update({ eliminato_il: null, eliminato_da: null })
                .eq('id', id)
                .in('scuola_id', plessi),
        ).select('id');

        if (colonnaCestinoAssente(ripristinoRes.error as { code?: string } | null)) {
            return cestinoNonDisponibile(sedeMedia);
        }

        if (ripristinoRes.error) {
            logErrore({ operazione: 'gallery/ripristina:POST', stato: 500, evento: 'db' }, ripristinoRes.error);
            return NextResponse.json(
                { error: 'La foto non è stata ripristinata. Riprova fra poco.', codice: 'MEDIA_NON_RIPRISTINATO' },
                { status: 500 },
            );
        }

        // Zero righe toccate ⇒ qualcun altro ha vinto la corsa fra la lettura e
        // questa scrittura. La risposta è la stessa del controllo di stato qui
        // sopra, perché lo stato è quello: la foto non è (più) nel cestino.
        if ((ripristinoRes.data ?? []).length === 0) {
            logEvento('galleria', 'info', {
                operazione: 'gallery/ripristina:POST',
                esito: 'corsa-persa',
                sede_id: sedeMedia,
                ruolo_attore: auth.user.role,
            });
            return NextResponse.json(
                {
                    error: 'Questa foto non è nel cestino: è già visibile in galleria. Ricarica l’elenco.',
                    codice: 'MEDIA_NON_RIPRISTINABILE',
                },
                { status: 409 },
            );
        }

        // ─── L'AUDIT, che è la sola traccia che sopravvive alla foto ──────────
        //
        // `eliminato_da` sulla riga viene azzerato proprio da questa operazione, e
        // dopo la purga la riga stessa non esisterà più: se «chi ha ripristinato
        // che cosa» non viene scritto qui, non è scritto in nessun posto.
        // `audit_scritture_docente` ha una retention e dei permessi suoi.
        //
        // `azione: 'update'`, non `'delete'` come nella DELETE: là il gesto ERA
        // un'eliminazione (e come venga eseguita è un dettaglio della tabella), qui
        // è la rimessa in vita di una riga — un aggiornamento, che è anche ciò che
        // il database fa. `valoreDopo` porta l'istante da cui la foto era via, che
        // è il solo dato che l'audit non potrebbe più ricostruire dopo lo `UPDATE`:
        // uuid e date, mai la didascalia (che questa rotta non legge nemmeno).
        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'galleria_media',
            entitaId: id,
            azione: 'update',
            scuolaId: sedeMedia,
            valorePrima: { eliminato_il: eliminatoIl },
            valoreDopo: { eliminato_il: null },
        });

        // ─── IL LOG DI SUCCESSO (AGENTS, regola 5) ────────────────────────────
        //
        // Un evento critico logga anche il caso BUONO: senza, «nessun log» non
        // distinguerebbe «la foto è tornata in galleria» da «il ripristino non è
        // mai partito». Solo uuid, numeri ed enumerati — e nessuna didascalia, che
        // questa rotta non ha nemmeno letto (vedi `COLONNE`).
        //
        // `giorni_nel_cestino` è il dato che dice se il cestino sta funzionando come
        // promesso: è la distanza fra l'eliminazione e il ripristino, e su quella si
        // misura se i 30 giorni di grazia servono a qualcuno o se i ripristini
        // arrivano tutti nello stesso pomeriggio.
        const giorniNelCestino = Math.floor(
            (Date.now() - new Date(eliminatoIl as string).getTime()) / 86_400_000,
        );

        // ⚠️ `ruolo_attore` ARRIVA REDATTO IN TABELLA, ed è misurato e non supposto:
        // `redact()` è a lista bianca PER CHIAVE e confronta i nomi normalizzati,
        // quindi `ruolo` passa e `ruolo_attore` (→ `ruoloattore`) no. Eseguito il
        // 2026-09-12 su questo stesso contesto: `"ruolo_attore":"[redatto:str/10]"`,
        // mentre `sede_id` (uuid) e i numeri escono in chiaro.
        //
        // La chiave resta questa comunque, per due ragioni: è la stessa che
        // `gallery:DELETE` scrive sulle sue tre righe — una `grep` sola trova i due
        // gesti opposti — e il dato NON è perduto, perché il gate lo deposita nel
        // contesto della richiesta (`impostaUtente`) e finisce nella COLONNA
        // `app_log.utente_ruolo`, in chiaro (misurato: 3160 `educator`, 427
        // `segreteria`, 191 `admin` negli ultimi sette giorni). Chi volesse leggerlo
        // anche qui dentro deve aggiungere la chiave a `CHIAVI_IN_CHIARO` in
        // `@/lib/logging/redact`: è un file condiviso e allargare quella lista apre
        // anche il canale anonimo di `/api/logs`, quindi è una decisione sua, non un
        // effetto collaterale di questa rotta.
        logEvento('galleria', 'info', {
            operazione: 'gallery/ripristina:POST',
            esito: 'ripristinato',
            sede_id: sedeMedia,
            giorni_nel_cestino: giorniNelCestino,
            ruolo_attore: auth.user.role,
        });

        // ⚠️ UNA FOTO RIPRISTINATA OLTRE I 30 GIORNI È UNA PURGA CHE NON HA GIRATO,
        // e non è un dettaglio da dedurre dal log qui sopra guardando un numero: se
        // questa riga era nel cestino da più giorni di quanti `GIORNI_CESTINO_GALLERIA`
        // ne conceda, allora il suo file doveva già essere stato distrutto — e chi
        // l'ha appena ripristinata ha recuperato qualcosa che il sistema aveva
        // promesso di non avere più. Il numero viene dalla costante del modulo, non
        // da un 30 scritto qui: due copie dello stesso 30 divergono il giorno in cui
        // qualcuno lo cambia in una.
        if (giorniNelCestino > GIORNI_CESTINO_GALLERIA) {
            logEvento('galleria', 'warn', {
                operazione: 'gallery/ripristina:POST',
                esito: 'ripristino-oltre-la-grazia',
                sede_id: sedeMedia,
                giorni_nel_cestino: giorniNelCestino,
                giorni_di_grazia: GIORNI_CESTINO_GALLERIA,
            });
        }

        // ─── LA NOTIFICA NON SI RIFÀ, ED È UNA DECISIONE ──────────────────────
        //
        // `gallery:POST` annuncia le foto nuove con «Nuove foto in galleria»: un
        // testo che non nomina nessun media, con un collegamento a
        // `/parent/gallery` che mostra le foto vive in quel momento. Quell'annuncio
        // per questa foto è già arrivato (o arriverà comunque, dal buffer di 30'), e
        // continua a funzionare: riaprendolo, la famiglia vede anche questa.
        //
        // Rifarne uno costerebbe tre cose e non ne comprerebbe nessuna:
        //  (a) annuncerebbe come NUOVA una foto di giorni prima;
        //  (b) collasserebbe comunque nel debounce per insegnante — la chiave di
        //      quell'accodamento è `entitaId: uploaded_by`, cioè l'INSEGNANTE, non
        //      il media: è la correzione del 7-8/09, quando 168 notifiche su 298
        //      erano andate perse e 153 genitori non erano mai stati avvisati;
        //  (c) direbbe a una famiglia che qualcosa è andato storto con la foto di
        //      suo figlio, che è esattamente l'informazione che il ripristino
        //      esiste per NON dover dare.
        // Il ripristino è la correzione di un errore interno: sta nell'audit e nei
        // log, non nella campanella di casa di nessuno.
        return NextResponse.json({ success: true, esito: 'ripristinato' });
    } catch (error) {
        logErrore({ operazione: 'gallery/ripristina:POST', stato: 500 }, error);
        return NextResponse.json(
            { error: 'La foto non è stata ripristinata. Riprova fra poco.', codice: 'MEDIA_NON_RIPRISTINATO' },
            { status: 500 },
        );
    }
});
