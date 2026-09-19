import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAvvisoInScope } from '@/lib/auth/scope-avvisi';
import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate';
import { classiMancantiNellaSede, classiTargetValide } from '@/lib/avvisi/classi-sede';
import {
    zTitoloAvviso, zContenutoAvviso, zTipoAvviso, zTargetScopeAvviso,
    zScadenzaAvvisoDataOra, zTargetClassesAvviso, formaAdesioneAvviso,
    ETICHETTA_NUMERO_PREDEFINITA,
} from '@/lib/validation/avvisi';
import { intervallo, MIN_PREDEFINITO, MAX_PREDEFINITO } from '@/lib/avvisi/partecipanti';
import { risolviScadenze } from '@/lib/avvisi/scadenze';
import { riepilogoPosti } from '@/lib/avvisi/posti';
import { dataCivile } from '@/i18n/config';
import { oraCivile } from '@/lib/format/confini-giorno';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { firmaAllegatiAvvisi, normalizzaAllegatoAvviso } from '@/lib/allegati/storage';
import { percorsoAllegatoArchiviatoAvviso, percorsoAllegatoAvviso, rimuoviAllegatoAvvisoSeOrfano } from '@/lib/allegati/rimozione';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

interface RouteParams {
    params: Promise<{ id: string }>;
}

/**
 * PostgREST torna `42703` (SELECT) / `PGRST204` (INSERT/UPDATE) quando una colonna
 * manca: è il linguaggio del DB E2E della CI, che è un progetto separato e NON è
 * migrato. Stessa funzione, stesso nome e stessa ragione del gemello in
 * `src/app/api/avvisi/route.ts`.
 */
function colonnaMancante(err: { code?: string } | null | undefined): boolean {
    return !!err && ['PGRST204', '42703'].includes(err.code ?? '');
}

/**
 * Quante colonne il degrado dell'UPDATE può sfilare prima di arrendersi. Stesso
 * numero e stessa ragione del gemello nel POST: PostgREST ne nomina UNA per volta,
 * e il cantiere A2 ne ha aggiunte sette a `avvisi`. Resta un TETTO perché un ciclo
 * che sfila senza fine, il giorno in cui `42703` arrivasse per un'altra ragione,
 * girerebbe finché la richiesta non scade.
 */
const MAX_COLONNE_SFILATE = 12;

// ─── I RESTI DI UN AVVISO ────────────────────────────────────────────────────
//
// Un avviso non è solo la sua riga. Quando si pubblica, lascia due cose dietro
// di sé che la cancellazione fino al 2026-08-01 non toccava:
//
//  · le NOTIFICHE già consegnate in campanella a ogni genitore destinatario
//    (`notifiche.entita_tipo='avviso'`, `entita_id=<id>`). Misurato in produzione
//    dal collaudo del 31/07: dopo `DELETE /api/avvisi/<id>` la riga restava, e al
//    genitore restava una notifica che porta a un avviso inesistente — la tocca,
//    arriva su `/parent/avvisi` e non trova niente. Il tester l'ha dovuta togliere
//    a mano in SQL;
//  · il FILE nel bucket privato `avvisi_allegati`, che restava archiviato per
//    sempre: il collaudo ne ha trovato già uno che nessuna riga referenziava.
//
// Nessuna delle due operazioni può far fallire la cancellazione: quando ci si
// arriva, l'avviso è già stato cancellato davvero, e un 500 direbbe a chi ha
// premuto «Elimina» una cosa falsa (lo farebbe riprovare, ottenendo un 404).
// Perciò best-effort — ma mai in silenzio: ogni guasto lascia la sua riga, e il
// successo lascia i conteggi.

// Le due operazioni stanno in `@/lib/allegati/rimozione`
// (`percorsoAllegatoArchiviatoAvviso`, `rimuoviAllegatoAvvisoSeOrfano`), accanto
// alla firma dei link a cui fanno da contrappeso. Non è per nasconderle: la
// verifica «lo sta usando qualcun altro?» interroga il bucket, che è UNO per
// tutte e tre le sedi, e va perciò fatta SENZA filtro di plesso — là c'è scritto
// perché, per esteso. Entrambe si chiamano solo dietro ad `assertAvvisoInScope`.

const putBodySchema = z.object({
    // Stessi massimi del POST, dallo stesso modulo: il PUT riscrive le medesime
    // colonne, e un limite copiato a mano qui si sarebbe disallineato al primo
    // cambio di DDL — che è come il difetto S34 è sopravvissuto sugli avvisi
    // mentre veniva chiuso sui promemoria.
    titolo: zTitoloAvviso,
    contenuto: zContenutoAvviso,
    tipo: zTipoAvviso.nullish(),
    target_scope: zTargetScopeAvviso.nullish(),
    target_classes: zTargetClassesAvviso.optional(),
    /**
     * `.nullish()` e non obbligatoria come sul POST: qui «assente» vuol dire **non
     * toccare**, e la colonna è `NOT NULL` — un avviso senza istante di uscita non
     * esiste, quindi non lo si può nemmeno cancellare. Il valore che conta per i
     * controlli non è questo: è lo STATO RISULTANTE, vedi più sotto.
     */
    scadenza_avviso: zScadenzaAvvisoDataOra.nullish(),
    // Lo stesso blocco del POST, dalla stessa definizione: è il presidio contro il
    // difetto che questo file porta già scritto due volte — una regola chiusa su
    // una strada e lasciata aperta su quella accanto.
    ...formaAdesioneAvviso,
    attachment_url: z.string().nullish(),
});

/**
 * ─── DALL'ISTANTE IN COLONNA ALLE CIFRE CHE `risolviScadenze` SA LEGGERE ─────
 *
 * `risolviScadenze` riceve la forma LOCALE italiana (`YYYY-MM-DDTHH:MM`), quella
 * che produce `<input type="datetime-local">`; in tabella c'è invece un istante
 * `timestamptz`. Per valutare lo stato RISULTANTE — cioè quello che resterà dopo
 * questo PUT — le due scadenze già archiviate vanno riportate a quella forma, e si
 * fa con `dataCivile` + `oraCivile`, che esistono esattamente per chiudere questo
 * giro (`istanteDaLocale` → colonna → campo).
 *
 * ⚠️ IL RITORNO PERDE I SECONDI, e va detto invece di lasciarlo scoprire: un
 * istante archiviato alle `23:59:59.999` torna indietro come `…T23:59`, cioè
 * 59,999 secondi PRIMA. La troncatura cade dalla parte conservativa — la scadenza
 * usata per il confronto è al più un minuto più PRECOCE di quella vera, quindi un
 * ordine «adesione ≤ avviso» che passa qui passa anche in colonna.
 *
 * ⚠️ E DAL 2026-09-19 QUEL VALORE **VIENE RISCRITTO**. Questo riquadro sosteneva
 * che la troncatura toccasse i soli CONFRONTI, perché «`scadenza_avviso` si
 * aggiorna solo quando il corpo ne manda una nuova»: la mitigazione non esiste
 * più, il modulo `AvvisoForm` manda `scadenza_avviso` a OGNI salvataggio (è
 * obbligatoria per poter inviare), quindi la riga scatta sempre e il valore
 * archiviato si accorcia davvero. Misurato: `…T21:59:59.999Z` (backfill a grana
 * giorno) → `−59,999 s`; `…T14:23:47.123Z` (backfill `created_at + 30gg`) →
 * `−47,123 s`; `…T21:59:00.000Z` (già arrotondato) → `0`. Cioè: vale **< 60 s**,
 * è **una tantum** (il secondo giro è stabile, perché i secondi sono già a zero) e
 * cade sempre dalla parte conservativa. Non si corregge qui perché il valore
 * salvato resta quello che l'operatore LEGGE nel campo, che è la cosa difendibile;
 * si scrive perché un commento che mente in questo repo è già costato una
 * giornata.
 *
 * Una `date` pura (la vecchia colonna `scadenza`, che resta in tabella e che il DB
 * E2E non migrato è l'unico ad avere) diventa `…T23:59`: la FINE del giorno civile,
 * che è l'unica lettura che qualcuno abbia mai dato a quel campo — nessuna
 * segreteria che ha scritto «scadenza: 19 settembre» intendeva «fino all'01:59 del
 * 19».
 */
function aFormaLocale(valore: string | null | undefined): string | null {
    if (!valore) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(valore)) return `${valore}T23:59`;
    const d = new Date(valore);
    if (Number.isNaN(d.getTime())) return null;
    const ora = oraCivile(valore);
    if (!ora) return null;
    return `${dataCivile(d)}T${ora}`;
}

/**
 * IL RIFIUTO DELLE SCADENZE — gemello di quello in `src/app/api/avvisi/route.ts`.
 *
 * ⚠️ Quattro rami e `codice` LETTERALE, non `codice: esito.codice`: il lock
 * `__tests__/architecture/errori-con-codice.test.ts` legge il sorgente e un valore
 * che non sa leggere smette di essere confrontato con `CODICI_ERRORE` e con i due
 * cataloghi. Le frasi sono quelle di `messages/{it,en}/shared.json`: due versioni
 * diverse dello stesso rifiuto sono il difetto F1 del collaudo del 2026-07-31.
 */
function rifiutoScadenze(
    codice: 'SCADENZE_INCOERENTI' | 'SCADENZA_ADESIONE_MANCANTE' | 'SCADENZA_AVVISO_MANCANTE' | 'SCADENZA_NEL_PASSATO',
    campi: Record<string, string | number | boolean | null>,
): NextResponse {
    const esito = {
        SCADENZE_INCOERENTI: 'scadenze-incoerenti',
        SCADENZA_ADESIONE_MANCANTE: 'scadenza-adesione-mancante',
        SCADENZA_AVVISO_MANCANTE: 'scadenza-avviso-mancante',
        SCADENZA_NEL_PASSATO: 'scadenza-nel-passato',
    }[codice];
    // `warn` → persistito, come `classe-fuori-sede` qui sotto e per la stessa
    // ragione: è quasi sempre un modulo da correggere, non un tentativo.
    logEvento('avvisi', 'warn', { operazione: 'avvisi/[id]:PUT', esito, ...campi });

    switch (codice) {
        case 'SCADENZE_INCOERENTI':
            return NextResponse.json(
                {
                    error: 'La data entro cui si può aderire viene dopo la scadenza dell’avviso: correggi una delle due. L’avviso non è stato salvato.',
                    codice: 'SCADENZE_INCOERENTI',
                },
                { status: 400 },
            );
        case 'SCADENZA_ADESIONE_MANCANTE':
            return NextResponse.json(
                {
                    error: 'Controlla entro quando si può aderire: se quella data e ora manca o non è valida, l’avviso non viene salvato.',
                    codice: 'SCADENZA_ADESIONE_MANCANTE',
                },
                { status: 400 },
            );
        case 'SCADENZA_NEL_PASSATO':
            return NextResponse.json(
                {
                    error: 'Una delle due scadenze è già passata: correggila. L’avviso non è stato salvato.',
                    codice: 'SCADENZA_NEL_PASSATO',
                },
                { status: 400 },
            );
        default:
            return NextResponse.json(
                {
                    error: 'Controlla fino a quando l’avviso resta visibile in bacheca: se quella data e ora manca o non è valida, l’avviso non viene salvato.',
                    codice: 'SCADENZA_AVVISO_MANCANTE',
                },
                { status: 400 },
            );
    }
}

// Il controllo di sede sta in `@/lib/auth/scope-avvisi`: fino al 2026-07-31 era
// una copia locale che non guardava `{ error }` di PostgREST, e rispondeva 403
// «fuori dal tuo plesso» anche su un guasto di lettura e su un id inesistente.

// GET /api/avvisi/[id]
// Singolo avviso (deep-link del dettaglio cockpit /admin/avvisi/[id]).
export const GET = withRoute('avvisi/[id]:GET', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const p = parseData(zUuid, rawParams.id);
        if ('response' in p) return p.response;
        const id = p.data;

        const supabase = await createAdminClient();
        const scopeErr = await assertAvvisoInScope(supabase, auth.user, id);
        if (scopeErr) return scopeErr;

        const { data, error } = await supabase
            .from('avvisi')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) {
            // Il testo di PostgREST (nomi di colonna e di vincolo) resta nel log,
            // dove serve alla diagnosi: al client non dice nulla di utile e
            // descrive lo schema a chi non deve conoscerlo.
            logErrore({ operazione: 'avvisi/[id]:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Lettura dell\'avviso non riuscita' }, { status: 500 });
        }
        if (!data) {
            return NextResponse.json({ error: 'Avviso non trovato' }, { status: 404 });
        }

        // Autore con query separata (nessun FK embed, come la route lista).
        const { data: author } = await supabase
            .from('utenti')
            .select('nome, cognome, ruolo, first_name, last_name, role')
            .eq('id', data.author_id)
            .maybeSingle();

        // Il bucket degli allegati è PRIVATO (2026-07-31): l'indirizzo si firma
        // qui, dietro al gate della route, e vale dieci minuti.
        const [conAllegato] = await firmaAllegatiAvvisi(
            supabase,
            [{
                ...data,
                author: author ? {
                    first_name: author.first_name || author.nome || '?',
                    last_name: author.last_name || author.cognome || '?',
                    role: author.role || author.ruolo || 'unknown',
                } : { first_name: '?', last_name: '?', role: 'unknown' },
            }],
            'avvisi/[id]:GET',
        );
        return NextResponse.json(conAllegato);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// PUT /api/avvisi/[id]
// Body: { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url }
export const PUT = withRoute('avvisi/[id]:PUT', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const p = parseData(zUuid, rawParams.id);
        if ('response' in p) return p.response;
        const id = p.data;

        const b = await parseBody(request, putBodySchema);
        if ('response' in b) return b.response;
        const {
            titolo, contenuto, tipo, target_scope, target_classes, attachment_url,
            scadenza_avviso, scadenza_adesione, chiedi_numero, etichetta_numero,
            numero_min, numero_max, posti_totali,
        } = b.data;

        const supabase = await createAdminClient();
        const scopeErr = await assertAvvisoInScope(supabase, auth.user, id);
        if (scopeErr) return scopeErr;

        // Gate sul TARGET (come nel POST): un educator può riassegnare l'avviso
        // solo alle proprie classi, mai a tutto il plesso o a classi altrui.
        const targetErr = await verificaTargetAvvisoDocente(supabase, auth.user, {
            scope: target_scope,
            classi: target_classes,
        });
        if (targetErr) return targetErr;

        // ── IL GATE DI SEDE SUL TARGET, CHE QUI NON C'ERA MAI STATO (2026-08-01) ──
        //
        // Il POST ce l'ha dal 30 luglio; questa strada no. Aveva il gate di RUOLO
        // qui sopra («un educator riassegna solo alle proprie classi») e si fermava
        // lì, poi scriveva `target_classes` GREZZO. Bastava modificare un avviso per
        // assegnarlo a una classe di un altro plesso — o a un id di sezione invece
        // che a un nome — ricevendo **200 con la riga aggiornata**. L'avviso poi non
        // arrivava a nessuno, ma quel silenzio è dalla parte delle famiglie e nessuno
        // lo collega alla modifica.
        //
        // È lo stesso difetto C8 del piano — «il ramo del cookie non ha avuto lo
        // stesso trattamento del ramo dichiarato» — applicato alla coppia
        // creazione/modifica. Per questo la regola vive ora in
        // `@/lib/avvisi/classi-sede` invece che dentro una delle due route.
        // ── SI GUARDA LO STATO RISULTANTE, NON IL CORPO DELLA RICHIESTA ──
        //
        // Regressione trovata dal collaudo del 2026-08-01 e introdotta dalla prima
        // versione di questo gate: la guardia leggeva `target_scope` dal BODY e, se il
        // campo mancava, ricadeva su `'globale'` senza pretendere nessuna classe —
        // mentre la scrittura mandava `target_classes: … ?? null`, che è SEMPRE
        // definito e quindi AZZERAVA la colonna. Un PUT di solo titolo su un avviso
        // di classe lo lasciava `scope='classe'` con zero destinatari: HTTP 200,
        // nessun log, e l'avviso spariva da ogni bacheca.
        //
        // Il difetto vero era l'asimmetria: per tutti gli altri campi «assente» vuol
        // dire «non toccare», per questo era diventato «cancella». Perciò lo scope e
        // le classi si ricavano dalla riga quando il corpo tace, e la guardia decide
        // su ciò che resterà in tabella.
        //
        // ⚠️ LA PRE-LETTURA SI È ALLARGATA il 2026-09-19, e non per comodità: con
        // due scadenze, un contatore e un tetto, «lo stato risultante» smette di
        // essere solo lo scope e le classi. `tipo` decide se `scadenza_adesione` è
        // obbligatoria, le due scadenze si confrontano fra loro anche quando il
        // corpo ne manda una sola, `posti_totali` serve a sapere se il tetto è
        // CAMBIATO e `chiedi_numero` a non spegnerlo per sbaglio.
        const COLONNE_PRIMA =
            'scuola_id, target_scope, target_classes, tipo, scadenza, scadenza_avviso, scadenza_adesione, posti_totali, chiedi_numero';
        const COLONNE_PRIMA_STORICHE = 'scuola_id, target_scope, target_classes, tipo, scadenza';
        let letturaPrima = await supabase
            .from('avvisi')
            .select(COLONNE_PRIMA)
            .eq('id', id)
            .maybeSingle();
        // DB E2E della CI, non migrato: `42703` sulle colonne nuove. Si rilegge con
        // la proiezione storica invece di rispondere 500 su una modifica legittima.
        if (colonnaMancante(letturaPrima.error as { code?: string } | null)) {
            letturaPrima = await supabase
                .from('avvisi')
                .select(COLONNE_PRIMA_STORICHE)
                .eq('id', id)
                .maybeSingle();
            // ⚠️ E ANCHE QUESTO DEGRADO SI DICHIARA, come gli altri del cantiere.
            // Da qui in poi «lo stato risultante» torna a essere quello di prima
            // del 2026-09-19: sede, scope, classi e la vecchia `scadenza`. Le due
            // scadenze nuove, `posti_totali` e `chiedi_numero` valgono `undefined`,
            // quindi il PUT decide come se il corpo fosse l'unica verità — le
            // scadenze non si confrontano più fra loro quando il corpo ne manda
            // una sola, e «il tetto è CAMBIATO?» risponde sempre sì. È un 200 che
            // salva, non un errore: senza questa riga sarebbe indistinguibile da
            // una modifica andata come doveva.
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi/[id]:PUT',
                esito: 'degrado-prelettura-colonne-storiche',
                entitaId: id,
            });
        }
        const { data: rigaPrima, error: erroreRiga } = letturaPrima;
        if (erroreRiga) {
            logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500, evento: 'db' }, erroreRiga);
            return NextResponse.json(
                { error: 'Verifica delle classi destinatarie non riuscita', codice: 'VERIFICA_CLASSI_NON_RIUSCITA' },
                { status: 500 },
            );
        }
        const prima = rigaPrima as {
            scuola_id?: string; target_scope?: string; target_classes?: string[] | null;
            tipo?: string | null; scadenza?: string | null;
            scadenza_avviso?: string | null; scadenza_adesione?: string | null;
            posti_totali?: number | null; chiedi_numero?: boolean | null;
        } | null;
        const scopeEffettivo = target_scope ?? prima?.target_scope ?? 'globale';
        // `undefined` = il campo non è stato mandato → si conservano le classi che
        // l'avviso ha già. Un array vuoto, invece, è una richiesta esplicita di
        // svuotare, e come tale deve incontrare la guardia.
        const classiInvariate = target_classes === undefined;
        const classiTarget = classiInvariate
            ? (prima?.target_classes ?? [])
            : classiTargetValide(target_classes);

        if (scopeEffettivo === 'classe' && classiTarget.length === 0) {
            return NextResponse.json(
                { error: 'Seleziona almeno una classe destinataria per un avviso di classe.', codice: 'CLASSE_DESTINATARIA_MANCANTE' },
                { status: 400 },
            );
        }
        // Si valida contro la sede SOLO ciò che arriva di nuovo: rivalidare le classi
        // già in tabella farebbe fallire con 400 la modifica del solo titolo di un
        // avviso la cui sezione è stata nel frattempo rinominata — un rifiuto che
        // accusa l'operatore di qualcosa che non ha fatto.
        if (!classiInvariate && classiTarget.length > 0) {
            // La sede è quella DELL'AVVISO, non quella di chi lo modifica: una
            // modifica non sposta un avviso di plesso, e leggerla dall'utente
            // rimetterebbe in gioco proprio l'ambiguità che il gate deve chiudere.
            const scuolaId = prima?.scuola_id ?? null;
            if (!scuolaId) {
                // Nessuna sede sulla riga: non si indovina. Un avviso senza plesso non
                // si può validare, e validarlo «contro tutte» equivarrebbe a non farlo.
                logEvento('avvisi', 'warn', {
                    operazione: 'avvisi/[id]:PUT',
                    esito: 'avviso-senza-sede',
                    entitaId: id,
                });
                return NextResponse.json(
                    { error: 'Verifica delle classi destinatarie non riuscita', codice: 'VERIFICA_CLASSI_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            const esito = await classiMancantiNellaSede(supabase, scuolaId, classiTarget);
            if (!esito.ok) {
                logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500, evento: 'db' }, esito.errore);
                return NextResponse.json(
                    { error: 'Verifica delle classi destinatarie non riuscita', codice: 'VERIFICA_CLASSI_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            if (esito.mancanti.length > 0) {
                // `warn` → persistito, come nel POST: riassegnare a una classe che non
                // è in questa sede è o un errore d'interfaccia o un tentativo. Solo
                // metadati non personali (i nomi di sezione sono in lista bianca).
                logEvento('avvisi', 'warn', {
                    operazione: 'avvisi/[id]:PUT',
                    esito: 'classe-fuori-sede',
                    tipo: 'target-non-nella-sede',
                    uid: auth.user.id,
                    entitaId: id,
                    n_classi: esito.mancanti.length,
                    sezione: esito.mancanti.join(','),
                });
                return NextResponse.json(
                    {
                        error:
                            'Classi non presenti nella sede dell\'avviso: ' +
                            `${esito.mancanti.join(', ')}. Controlla i destinatari.`,
                        codice: 'CLASSI_FUORI_SEDE',
                    },
                    { status: 400 },
                );
            }
        }

        // ─── LE DUE SCADENZE: SI VALUTA LO STATO RISULTANTE, MAI IL CORPO ─────
        //
        // 🔴 È IL PUNTO PIÙ PROBABILE DI BUG DI QUESTA FUNZIONE, e la cicatrice sta
        // in QUESTO STESSO FILE, venti righe più su: la prima versione del gate
        // delle classi leggeva `target_scope` dal BODY e, quando il campo mancava,
        // ricadeva su `'globale'` senza pretendere nessuna classe — mentre la
        // scrittura azzerava `target_classes`. Un PUT di solo titolo su un avviso di
        // classe lo lasciava `scope='classe'` con ZERO destinatari, rispondendo 200.
        //
        // Qui la stessa asimmetria produrrebbe un danno peggiore: un PUT di solo
        // titolo su un avviso di adesione, letto dal corpo, non avrebbe nessuna
        // scadenza e verrebbe rifiutato — oppure, sfilando il controllo, potrebbe
        // scriverne una incoerente con quella già archiviata. Perciò ogni valore che
        // il corpo non manda si prende DALLA RIGA, e `risolviScadenze` vede ciò che
        // resterà in tabella.
        //
        // ⚠️ `vietaPassato: false`, e NON è una dimenticanza del POST. Una scadenza
        // nel passato, qui, è il gesto legittimo con cui la segreteria chiude SUBITO
        // un avviso — la gita è annullata, le adesioni si fermano adesso. Vietarlo
        // le lascerebbe solo la strada di cancellare l'avviso, cioè di buttare via
        // anche le adesioni già raccolte e le prese visione.
        const tipoRisultante = tipo ?? prima?.tipo ?? null;
        const scadenzaAvvisoLocale =
            scadenza_avviso ?? aFormaLocale(prima?.scadenza_avviso ?? prima?.scadenza);
        // `undefined` = campo non mandato → si conserva quella archiviata.
        // `null` esplicito = «togli il termine per aderire», ed è legittimo.
        const scadenzaAdesioneLocale =
            scadenza_adesione !== undefined
                ? scadenza_adesione
                : aFormaLocale(prima?.scadenza_adesione);
        const scad = risolviScadenze({
            tipo: tipoRisultante,
            scadenzaAvvisoLocale,
            scadenzaAdesioneLocale,
            vietaPassato: false,
            adessoISO: new Date().toISOString(),
        });
        if (!scad.ok) return rifiutoScadenze(scad.codice, { uid: auth.user.id, entitaId: id });

        // L'intervallo del contatore: un vincolo fra DUE campi, che zod non può
        // esprimere e che il `CHECK` della colonna respingerebbe con un 23514 → 500.
        // Si valuta lo stato RISULTANTE anche qui, con i predefiniti della colonna.
        const numeri = intervallo({ numero_min, numero_max });
        if (numeri.min > numeri.max) {
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi/[id]:PUT',
                esito: 'numero-intervallo-non-valido',
                uid: auth.user.id,
                entitaId: id,
            });
            return NextResponse.json(
                {
                    error: 'L’intervallo di persone indicato non è valido: controlla il minimo, il massimo e il valore proposto. L’avviso non è stato salvato.',
                    codice: 'NUMERO_INTERVALLO_NON_VALIDO',
                },
                { status: 400 },
            );
        }

        // In tabella il PERCORSO nel bucket, mai l'indirizzo firmato che il modulo
        // di modifica rimanda indietro dopo averlo riletto.
        const allegatoNuovo = normalizzaAllegatoAvviso(attachment_url);
        // Va letto PRIMA dell'update: dopo, quale file ci fosse non lo sa più
        // nessuno. Se l'allegato viene sostituito o tolto, il vecchio è a tutti
        // gli effetti un orfano — l'avviso non lo nomina più.
        const allegatoPrima = await percorsoAllegatoArchiviatoAvviso(supabase, id, 'avvisi/[id]:PUT');

        // ── COSA SI SCRIVE, E COSA NON SI TOCCA MAI ──────────────────────────
        //
        // ⚠️ `scadenza` (la vecchia `date`) NON compare più: la deriva il trigger
        // `trg_avvisi_scadenza_compat` da `scadenza_avviso`, a ogni UPDATE. Il
        // `scadenza: scadenza || null` che c'era qui avrebbe ora due sorgenti per la
        // stessa colonna, ed è la coppia che quel trigger esiste per tenere unita.
        //
        // ⚠️ E QUESTA ROTTA NON TOCCA **MAI** `avvisi_risposte`. Lo scrivo a chiare
        // lettere perché il prossimo che passa penserà di «fare pulizia»: spegnere
        // `chiedi_numero` con adesioni già raccolte è PERMESSO — decisione esplicita
        // del committente — e i numeri già dichiarati restano dove sono e continuano
        // a contare nel tetto. Riaccendere la bandierina non deve invalidare le
        // adesioni arrivate prima; spegnerla non deve cancellarle. Una `update` su
        // `avvisi_risposte` da qui butterebbe via dati di famiglie per una
        // bandierina cambiata in un modulo.
        const patch: Record<string, unknown> = {
            titolo,
            contenuto,
            tipo,
            target_scope,
            // L'insieme VALIDATO, mai l'array grezzo: fino al 2026-08-01 qui
            // finivano duplicati e stringhe vuote, mai confrontati con niente.
            target_classes: classiTarget.length > 0 ? classiTarget : null,
            attachment_url: allegatoNuovo,
        };
        // Solo ciò che il corpo ha MANDATO: per ogni altro campo «assente» vuol dire
        // «non toccare», ed è l'asimmetria che il 2026-08-01 aveva già azzerato i
        // destinatari di un avviso rispondendo 200.
        if (scadenza_avviso !== undefined && scadenza_avviso !== null) {
            patch.scadenza_avviso = scad.scadenzaAvviso;
        }
        if (scadenza_adesione !== undefined) patch.scadenza_adesione = scad.scadenzaAdesione;
        if (chiedi_numero !== undefined && chiedi_numero !== null) {
            patch.chiedi_numero = chiedi_numero;
            // A contatore spento i tre campi sono rumore e non si archiviano — ma
            // `numero_min`/`numero_max` sono `NOT NULL`: si scrivono i predefiniti.
            patch.etichetta_numero = chiedi_numero
                ? ((etichetta_numero ?? '').trim() || ETICHETTA_NUMERO_PREDEFINITA)
                : null;
            patch.numero_min = chiedi_numero ? numeri.min : MIN_PREDEFINITO;
            patch.numero_max = chiedi_numero ? numeri.max : MAX_PREDEFINITO;
        } else {
            if (etichetta_numero !== undefined) {
                patch.etichetta_numero = (etichetta_numero ?? '').trim() || null;
            }
            if (numero_min !== undefined && numero_min !== null) patch.numero_min = numeri.min;
            if (numero_max !== undefined && numero_max !== null) patch.numero_max = numeri.max;
        }
        if (posti_totali !== undefined) patch.posti_totali = posti_totali ?? null;

        // Update resiliente alle colonne nuove mancanti (DB E2E della CI, non
        // migrato): PostgREST risponde `PGRST204` nominando la colonna che non ha e
        // si riprova senza. Ogni colonna sfilata lascia la sua riga — `colonna` è
        // fuori dalla lista bianca di `redact`, quindi il nome viaggia anche dentro
        // `msg`, che finisce in `app_log.messaggio` in chiaro e sanificato.
        //
        // ⚠️ Qui NON c'è il caso `scuola_id` del POST, e non è una dimenticanza:
        // questa patch non contiene la chiave di tenancy — un PUT non sposta un
        // avviso di plesso — quindi non esiste il degrado pericoloso da negare.
        let updRes = await supabase.from('avvisi').update(patch).eq('id', id).select().single();
        let sfilate = 0;
        while (updRes.error && colonnaMancante(updRes.error as { code?: string } | null) && sfilate < MAX_COLONNE_SFILATE) {
            const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(updRes.error.message);
            const col = m?.[1] ?? m?.[2];
            if (!col || !(col in patch)) break;
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi/[id]:PUT',
                esito: 'degrado-colonna-sfilata',
                colonna: col,
                msg: `avvisi/[id]:PUT: colonna "${col}" assente sul DB, sfilata dalla modifica`,
            });
            delete patch[col];
            updRes = await supabase.from('avvisi').update(patch).eq('id', id).select().single();
            sfilate++;
        }
        const { data, error } = updRes;

        if (error) {
            logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Aggiornamento dell\'avviso non riuscito' }, { status: 500 });
        }

        // ── IL TETTO ABBASSATO SOTTO L'OCCUPATO: PERMESSO, E REGISTRATO ──────
        //
        // Decisione esplicita del committente: la sala si è rimpicciolita, la
        // segreteria deve poterlo scrivere subito e poi decidere con calma chi esce.
        // **Nessuno viene espulso** — né qui né da un vincolo del database, che
        // apposta non esiste (§ 5 della migrazione, terzo vincolo non scritto).
        //
        // Ma un fatto del genere non può restare solo DIPINTO A SCHERMO: la
        // «segnalazione sopra capienza» della card la vede chi guarda quella card in
        // quel momento, e nessun altro, mai più. Una lettura in più — solo quando il
        // tetto è CAMBIATO davvero, non a ogni salvataggio del titolo — e la riga
        // resta in `app_log`, dove si può chiedere «su quali avvisi è successo».
        if (posti_totali !== undefined && posti_totali !== null && posti_totali !== prima?.posti_totali) {
            const { data: righeAdesioni, error: erroreAdesioni } = await supabase
                .from('avvisi_risposte')
                .select('numero_partecipanti, stato_adesione, parent_id')
                .eq('avviso_id', id);
            if (erroreAdesioni) {
                // PostgREST non lancia: senza questo ramo il guasto diventerebbe
                // «zero persone ammesse», cioè un tetto che sembra capiente. Non fa
                // fallire il PUT — la modifica è già scritta — ma non resta muto.
                logEvento('avvisi', 'warn', {
                    operazione: 'avvisi/[id]:PUT',
                    esito: 'tetto-occupato-non-verificato',
                    entitaId: id,
                    posti_totali,
                }, erroreAdesioni);
            } else {
                const riepilogo = riepilogoPosti(
                    (righeAdesioni ?? []) as Array<{ numero_partecipanti?: number | null; stato_adesione?: string | null; parent_id?: string | null }>,
                    posti_totali,
                );
                if (riepilogo.sopraCapienza) {
                    logEvento('avvisi', 'warn', {
                        operazione: 'avvisi/[id]:PUT',
                        esito: 'tetto-sotto-occupato',
                        entitaId: id,
                        uid: auth.user.id,
                        posti_totali,
                        persone_ammesse: riepilogo.persone,
                        n_famiglie: riepilogo.famiglie,
                    });
                }
            }
        }

        // Solo DOPO che l'update è riuscito: se fallisse, l'avviso conserverebbe
        // il vecchio allegato e averlo già cancellato lo lascerebbe rotto.
        if (allegatoPrima && allegatoPrima !== percorsoAllegatoAvviso(allegatoNuovo)) {
            await rimuoviAllegatoAvvisoSeOrfano(supabase, id, allegatoPrima, 'avvisi/[id]:PUT');
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: id, azione: 'update', valoreDopo: { id, titolo },
        });

        return NextResponse.json(data);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// DELETE /api/avvisi/[id]
export const DELETE = withRoute('avvisi/[id]:DELETE', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const p = parseData(zUuid, rawParams.id);
        if ('response' in p) return p.response;
        const id = p.data;
        const supabase = await createAdminClient();
        const scopeErr = await assertAvvisoInScope(supabase, auth.user, id);
        if (scopeErr) return scopeErr;

        // Prima della cancellazione, perché dopo il dato non c'è più.
        const allegato = await percorsoAllegatoArchiviatoAvviso(supabase, id, 'avvisi/[id]:DELETE');

        const { error } = await supabase
            .from('avvisi')
            .delete()
            .eq('id', id);

        if (error) {
            logErrore({ operazione: 'avvisi/[id]:DELETE', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Cancellazione dell\'avviso non riuscita' }, { status: 500 });
        }

        // LE NOTIFICHE GIÀ CONSEGNATE. Si ritirano SOLO dopo che l'avviso è
        // sparito davvero: se la delete qui sopra fosse fallita, l'avviso sarebbe
        // ancora vivo e togliere le notifiche lascerebbe le famiglie senza il
        // messaggio di una comunicazione che c'è.
        //
        // I due filtri sono il contratto: senza `entita_id` si svuoterebbe la
        // campanella di tutta la scuola, senza `entita_tipo` si prenderebbero le
        // notifiche di un'altra entità che per caso avesse lo stesso uuid.
        // `.select('id')` serve al conteggio: PostgREST restituisce le righe
        // cancellate, ed è l'unico modo di sapere QUANTE famiglie sono state
        // toccate.
        let nNotifiche = 0;
        const { data: notificheRimosse, error: errNotifiche } = await supabase
            .from('notifiche')
            .delete()
            .eq('entita_tipo', 'avviso')
            .eq('entita_id', id)
            .select('id');

        if (errNotifiche) {
            // `error`: l'avviso non esiste più e le sue notifiche sì. È lo stato
            // che questo intervento serve a evitare, e nessuno se ne accorgerebbe
            // altrimenti — la risposta resta 200. Il corpo del guasto si passa
            // intero: su un database non migrato è un `42703` sul nome della
            // colonna, e senza quel codice il degrado non si distingue da un bug.
            logEvento('notifica', 'error', {
                operazione: 'avvisi/[id]:DELETE',
                esito: 'notifiche-orfane-non-rimosse',
                avviso: id,
            }, errNotifiche);
        } else {
            // `.select()` restituisce sempre un array; il controllo di forma evita
            // che un conteggio inventato finisca nel log di successo.
            nNotifiche = Array.isArray(notificheRimosse) ? notificheRimosse.length : 0;
        }

        const nAllegati = await rimuoviAllegatoAvvisoSeOrfano(supabase, id, allegato, 'avvisi/[id]:DELETE');

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: id, azione: 'delete',
        });

        // IL SUCCESSO SI LOGGA, COI CONTEGGI (AGENTS, regola 5): con i soli
        // errori, «nessun log» non distingue «ripulito tutto» da «non è mai
        // partito niente». Solo uuid e numeri: mai il titolo, mai un destinatario.
        logEvento('avvisi', 'info', {
            operazione: 'avvisi/[id]:DELETE',
            esito: 'cancellato',
            avviso: id,
            n_notifiche_rimosse: nNotifiche,
            n_allegati_rimossi: nAllegati,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]:DELETE', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
