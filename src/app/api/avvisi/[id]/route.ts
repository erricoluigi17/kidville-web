import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAvvisoInScope } from '@/lib/auth/scope-avvisi';
import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate';
import { classiMancantiNellaSede, classiTargetValide } from '@/lib/avvisi/classi-sede';
import { zTitoloAvviso, zContenutoAvviso, zTipoAvviso, zTargetScopeAvviso, zScadenzaAvviso, zTargetClassesAvviso } from '@/lib/validation/avvisi';
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
    scadenza: zScadenzaAvviso.nullish(),
    attachment_url: z.string().nullish(),
});

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
        const { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url } = b.data;

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
        const { data: rigaPrima, error: erroreRiga } = await supabase
            .from('avvisi')
            .select('scuola_id, target_scope, target_classes')
            .eq('id', id)
            .maybeSingle();
        if (erroreRiga) {
            logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500, evento: 'db' }, erroreRiga);
            return NextResponse.json(
                { error: 'Verifica delle classi destinatarie non riuscita', codice: 'VERIFICA_CLASSI_NON_RIUSCITA' },
                { status: 500 },
            );
        }
        const prima = rigaPrima as { scuola_id?: string; target_scope?: string; target_classes?: string[] | null } | null;
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

        // In tabella il PERCORSO nel bucket, mai l'indirizzo firmato che il modulo
        // di modifica rimanda indietro dopo averlo riletto.
        const allegatoNuovo = normalizzaAllegatoAvviso(attachment_url);
        // Va letto PRIMA dell'update: dopo, quale file ci fosse non lo sa più
        // nessuno. Se l'allegato viene sostituito o tolto, il vecchio è a tutti
        // gli effetti un orfano — l'avviso non lo nomina più.
        const allegatoPrima = await percorsoAllegatoArchiviatoAvviso(supabase, id, 'avvisi/[id]:PUT');

        const { data, error } = await supabase
            .from('avvisi')
            .update({
                titolo,
                contenuto,
                tipo,
                target_scope,
                // L'insieme VALIDATO, mai l'array grezzo: fino al 2026-08-01 qui
                // finivano duplicati e stringhe vuote, mai confrontati con niente.
                target_classes: classiTarget.length > 0 ? classiTarget : null,
                scadenza: scadenza || null,
                attachment_url: allegatoNuovo,
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Aggiornamento dell\'avviso non riuscito' }, { status: 500 });
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
