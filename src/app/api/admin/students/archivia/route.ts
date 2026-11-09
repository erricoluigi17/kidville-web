import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { STATO_RITIRATO } from '@/lib/alunni/stato';
import { MOTIVI_ARCHIVIAZIONE, colonnaAssente } from '@/lib/alunni/archiviazione';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { annoAttivoDiSede, campiFrequenzaDaAlunno } from '@/lib/anno/frequenze';
import { chiudiFrequenzeAperte } from '@/lib/anno/iscrizione-anno';
import { conFaseB, scriviAlunnoEFrequenza } from '@/lib/anno/scrittura';
import { rispostaAlunnoAnonimizzato, rispostaFrequenzaNonScritta, rispostaScritturaIncompleta } from '@/lib/anno/errori';

// ============================================================================
// ARCHIVIA UN ALUNNO — «non più iscritto», con l'anagrafica INTATTA.
//
// ─── IL DIFETTO CHE QUESTA ROTTA CHIUDE ─────────────────────────────────────
// «Elimina Alunno (GDPR)» falliva. Non a volte: quasi sempre. Tre tentativi veri
// il 2026-08-12 (11:17:24 · 11:17:53 · 11:18:07 UTC, ruolo admin) → PostgREST
// `23503` su `valutazioni_alunno_id_fkey` → HTTP 409. `alunni` ha 28 chiavi
// esterne entranti e SETTE non hanno `ON DELETE CASCADE`; sui dati veri 28 alunni
// su 33 avevano almeno un pagamento o un legame con un genitore. Il bottone era
// una promessa che il database non poteva mantenere — e non DEVE mantenere:
// registri didattici e pagamenti si conservano dieci anni, e il nome del bambino
// esiste in un posto solo (`alunni.nome`/`cognome`), quindi cancellarlo rende
// illeggibili in un colpo i registri di OGNI anno, passati compresi.
//
// ─── COSA FA, E QUAL È LA LEVA ──────────────────────────────────────────────
// L'anagrafica NON si tocca: nome, cognome e codice fiscale restano. Il bambino
// esce dagli ELENCHI, ed è reversibile (`admin/students/riattiva:POST`).
//
// La leva NON è lo stato. Misurato: `from('alunni')` compare 181 volte in 117
// file e solo 12 filtrano `.eq('stato','iscritto')` — contare sullo stato
// lascerebbe l'app cieca in un centinaio di punti. La leva è lo SGANCIAMENTO
// DALLA CLASSE: `section_id` e `classe_sezione` a NULL fanno sparire il bambino
// da tutte le query per sezione, che sono la maggioranza, con un UPDATE solo.
// Lo stato si scrive lo stesso, e serve a un'altra domanda — è `stato` che
// AUTORIZZA l'oblio (`eNonPiuIscritto`, vedi la testata di `@/lib/alunni/stato`).
//
// ⚠️ `section_id` VA AZZERATO ESPLICITAMENTE. Il trigger `sync_alunno_section_id`
// agisce solo quando `NEW.classe_sezione IS NOT NULL` (baseline, riga 881):
// azzerare il NOME della classe non azzera l'ID, e senza questa riga il bambino
// resterebbe agganciato alla sezione mentre l'elenco lo dà per archiviato.
//
// ─── COSA QUESTA ROTTA NON FA ───────────────────────────────────────────────
// Non cancella niente: né foto, né messaggi, né righe. Quello è il secondo
// tempo del modello, e ha una rotta sua (`admin/students/libera-spazio:POST`),
// raggiungibile SOLO da questo elenco.
//
// ⚠️ E C'È UN EFFETTO CHE VA DETTO ALL'OPERATORE, non nascosto qui dentro:
// l'automa `presenze-giustificazioni-retention` (migrazione 20260807211157) ogni
// notte alle 04:59 UTC azzera `presenze.giustificazione_testo` e
// `presenze.note_appello` di chi NON è più iscritto. Archiviare fa quindi
// sparire entro 24 ore il motivo dell'assenza scritto dalle famiglie — le RIGHE
// di presenza restano, il testo no. È una promessa già pubblicata in `/privacy`,
// non un difetto: non si cambia, si DICE nel riquadro di conferma.
// ============================================================================

const bodySchema = z.object({
    alunno_id: z.string().min(1),
    /**
     * Insieme CHIUSO, mai testo libero — e l'elenco vive in un posto solo
     * (`@/lib/alunni/archiviazione`), perché la tendina della scheda e questo
     * `z.enum` devono dire la stessa cosa del `CHECK` del database. Con due
     * elenchi paralleli l'operatore sceglie una voce che gli è stata offerta e
     * riceve «Dati non validi».
     */
    motivo: z.enum(MOTIVI_ARCHIVIAZIONE).optional(),
});

export const POST = withRoute('admin/students/archivia:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, bodySchema);
    if ('response' in b) return b.response;
    const { alunno_id: alunnoId, motivo } = b.data;

    try {
        const supabase = await createAdminClient();

        // Gate di tenant PRIMA di qualunque lettura: `requireStaff` dice che
        // RUOLO hai, non su QUALE SEDE, e qui il client è service-role (la RLS
        // non interviene). Senza, la segreteria di un plesso potrebbe far
        // sparire dagli elenchi il bambino di un altro.
        const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId);
        if (scopeErr) return scopeErr;

        const plessi = await scuoleDiUtente(supabase, auth.user);

        // ─── Lettura MINIMA, e mai un `select *` ────────────────────────────
        // Il `select *` di `admin/students:DELETE` è il difetto che ha lasciato
        // in produzione tre copie integrali dell'anagrafica di un minore dentro
        // `registro_modifiche`. Qui escono sei colonne, nessuna delle quali
        // nomina il bambino: sono quelle che servono a decidere e a ricordare.
        //
        // Il filtro di sede affianca il gate e non lo sostituisce: il gate
        // impedisce di NOMINARE la riga altrui, il filtro impedisce che una
        // corsa fra il gate e la lettura ne faccia rientrare una.
        const { data: prima, error: errLettura } = await supabase
            .from('alunni')
            .select('id, scuola_id, section_id, classe_sezione, gruppo_mensa_id, stato, archiviato_il, archiviato_da, archiviato_motivo, archiviato_section_id, archiviato_classe_sezione, anonimizzato_il')
            .eq('id', alunnoId)
            .in('scuola_id', plessi)
            .maybeSingle();

        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «zero righe», cioè un 404 che AFFERMA che il bambino non
        // esiste — su un dato che non si è riusciti a leggere.
        if (errLettura) {
            if (colonnaAssente(errLettura)) return archivioNonDisponibile('lettura', alunnoId);
            logEvento('gdpr', 'error', {
                operazione: 'admin/students/archivia:POST', esito: 'lettura-non-riuscita',
                alunno: alunnoId, error_code: (errLettura as { code?: string }).code,
            }, errLettura);
            return NextResponse.json(
                { error: 'Non è stato possibile leggere la scheda: nessuna modifica è stata registrata.', codice: 'ARCHIVIAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }
        if (!prima) {
            // Il gate è passato e la riga non c'è più: è uscita dallo scope fra
            // il gate e la lettura. Un 404 onesto, non un 200 che dichiara
            // un'archiviazione mai avvenuta.
            logEvento('multi_sede', 'warn', {
                operazione: 'admin/students/archivia:POST', esito: 'alunno-non-piu-in-scope', alunno: alunnoId,
            });
            return NextResponse.json(
                { error: 'Questo bambino non è più nell\'elenco di questa postazione.', codice: 'ALUNNO_NON_APRIBILE' },
                { status: 404 },
            );
        }

        /**
         * ⚠️ IL 409 GUARDA `archiviato_il`, NON LO STATO, ed è una decisione.
         *
         * `stato = 'ritirato'` con `archiviato_il` NULL esiste ed è frequente:
         * è il bambino messo a «Ritirato» dalla tendina della scheda, che però
         * NON è mai passato di qui — quindi `section_id` è ancora valorizzato e
         * lui compare ancora in registro, appello e mensa. Rifiutarlo con un 409
         * lo lascerebbe bloccato in quello stato per sempre, ed è esattamente il
         * caso per cui questa rotta serve. Chi è già archiviato davvero ha
         * `archiviato_il`: quello, e solo quello, è «l'ho già fatto».
         *
         * ⚠️ MA «già archiviato» vuol dire anche `archiviato_da`. Senza transazione (fino alla PR 5) la frequenza dell'anno
         * può essere scritta e `alunni` no: lo specchio ha già messo `archiviato_il` ma l'autore, il motivo e l'audit non ci
         * sono. Un `archiviato_il` valorizzato con `archiviato_da` NULL è un'archiviazione DA COMPLETARE, non un 409:
         * riprovare scrive autore, motivo e audit, e NON tocca la memoria della classe (che il primo giro ha già scritto,
         * e che dalla scheda sganciata non si può più ricavare). Vale anche per gli alunni archiviati prima di questa
         * regola con `archiviato_da` NULL e la memoria già piena.
         */
        // Una scheda ANONIMIZZATA (oblio) non si archivia e non riceve scritture, nemmeno come «da completare»: la funzione di
        // copia della migrazione la salta, e archiviarla scriverebbe autore, motivo e audit su una riga svuotata di proposito.
        if (prima.anonimizzato_il != null) {
            logEvento('gdpr', 'info', {
                operazione: 'admin/students/archivia:POST', esito: 'anonimizzato', alunno: alunnoId,
            });
            return rispostaAlunnoAnonimizzato();
        }
        const daCompletare = prima.archiviato_il != null && prima.archiviato_da == null;
        if (prima.archiviato_il != null && !daCompletare) {
            // 4.5.16 (E): «Riprova». Se la prima archiviazione non è riuscita a chiudere un'iscrizione dell'anno prossimo (la scheda
            // era già scritta), il secondo giro la chiude. Se ha chiuso o tolto qualcosa, o ha di nuovo dei guasti, risponde 200 con i
            // conteggi e `gia_archiviato: true`, SENZA riscrivere la scheda né l'audit. Se non c'era niente da fare, il 409 di sempre.
            const riprova = await chiudiFrequenzeAperte(supabase, { alunnoId, attore: auth.user });
            if (riprova.chiuse > 0 || riprova.voci_tolte > 0 || riprova.non_riuscite > 0) {
                logEvento('gdpr', riprova.non_riuscite > 0 ? 'error' : 'info', {
                    operazione: 'admin/students/archivia:POST',
                    azione: 'archiviazione-riprovata',
                    esito: riprova.non_riuscite > 0 ? 'iscrizioni-non-chiuse' : 'iscrizioni-chiuse',
                    entita_id: alunnoId,
                    n_non_chiuse: riprova.non_riuscite,
                    n_chiuse: riprova.chiuse,
                });
                return NextResponse.json({
                    success: true,
                    gia_archiviato: true,
                    alunno_id: alunnoId,
                    archiviato_il: prima.archiviato_il,
                    frequenze_chiuse: riprova.chiuse,
                    voci_pagate_rimaste: riprova.voci_pagate_rimaste,
                    iscrizioni_non_chiuse: riprova.non_riuscite,
                });
            }
            logEvento('gdpr', 'info', {
                operazione: 'admin/students/archivia:POST', esito: 'gia-archiviato', alunno: alunnoId,
            });
            return NextResponse.json(
                { error: 'Questo bambino è già fra i «non più iscritti».', codice: 'ALUNNO_GIA_ARCHIVIATO' },
                { status: 409 },
            );
        }
        if (daCompletare) {
            logEvento('gdpr', 'info', {
                operazione: 'admin/students/archivia:POST', esito: 'archiviazione-da-completare', alunno: alunnoId,
            });
        }

        // Se `alunni` è già archiviato a metà, l'istante dell'archiviazione resta quello del primo giro (l'uscita della
        // frequenza lo segue); altrimenti è adesso.
        const adesso = daCompletare ? String(prima.archiviato_il) : new Date().toISOString();
        // UN SOLO UPDATE, dove la frequenza non si scrive prima. Due scritture separate (prima lo sgancio, poi la
        // memoria di dov'era) lascerebbero una finestra in cui il bambino è fuori dalla sua sezione e nessuna riga dice
        // quale fosse. L'eccezione è la fase B, qui sotto: la memoria si scrive PRIMA della frequenza, quindi la finestra
        // è all'incontrario (memoria scritta, bambino ancora in classe) ed è innocua.
        const aggiornamento: Record<string, unknown> = {
            stato: STATO_RITIRATO,
            archiviato_il: adesso,
            archiviato_da: auth.user.id,
            // Su un'archiviazione da completare il motivo già scritto non si perde: la riprova (la UI manda solo l'alunno)
            // lo riscriverebbe a NULL. Si scrive solo se manca.
            archiviato_motivo: daCompletare ? ((prima.archiviato_motivo as string | null) ?? motivo ?? null) : (motivo ?? null),
            // Lo sganciamento: è QUESTO che lo fa sparire dagli elenchi.
            section_id: null,
            classe_sezione: null,
            // Il gruppo mensa è un'assegnazione operativa dell'anno: un bambino
            // archiviato che resta in una lista di cucina è un pasto contato.
            gruppo_mensa_id: null,
        };
        // La memoria del ritorno: si scrive PRIMA di azzerare, nello stesso UPDATE, quindi legge i valori di `prima` e non
        // quelli già persi. Su un'archiviazione da completare `prima.section_id` è già NULL: riscriverla cancellerebbe la
        // memoria vera, e la memoria NON si tocca mai.
        if (!daCompletare) {
            aggiornamento.archiviato_section_id = (prima.section_id as string | null) ?? null;
            aggiornamento.archiviato_classe_sezione = (prima.classe_sezione as string | null) ?? null;
        }

        // Fase B (§4.19): prima la frequenza dell'anno attivo (`archiviato_il` → `ritirato` + uscita; `section_id` e
        // `gruppo_mensa_id` a NULL), poi `alunni`. Se la frequenza non si scrive, la scheda resta com'era. In fase A:
        // `alunni` e poi la frequenza, fail-open.
        const campiFreq = campiFrequenzaDaAlunno(aggiornamento);
        const annoSedeId = await annoAttivoDiSede(supabase, (prima.scuola_id as string | null) ?? null);

        // La frequenza si scrive per prima, e lo specchio ricopia in `alunni` stato, archiviato_il e il distacco dalla
        // classe: se poi l'UPDATE di `alunni` fallisse, la memoria di dov'era il bambino andrebbe persa (la scheda non ha
        // più la classe da cui ricavarla). Quindi la memoria si scrive in un UPDATE proprio, PRIMA.
        // ⚠️ Se poi è la FREQUENZA a non scriversi, la memoria resta: il bambino è ancora iscritto e in classe, con la
        // memoria addosso (innocua: `riattiva` la riconosce, e `archivia` la riscrive alla prossima archiviazione).
        // Il messaggio «la scheda è rimasta com'era» è vero per la classe e lo stato, non per questa memoria.
        if (!daCompletare && annoSedeId && await conFaseB(supabase)) {
            const { error: errMemoria } = await supabase
                .from('alunni')
                .update({
                    archiviato_section_id: aggiornamento.archiviato_section_id,
                    archiviato_classe_sezione: aggiornamento.archiviato_classe_sezione,
                })
                .eq('id', alunnoId)
                .in('scuola_id', plessi)
                .select('id')
                .single();
            if (errMemoria) {
                if (colonnaAssente(errMemoria)) return archivioNonDisponibile('scrittura', alunnoId);
                if ((errMemoria as { code?: string }).code === 'PGRST116') {
                    logEvento('multi_sede', 'warn', {
                        operazione: 'admin/students/archivia:POST', esito: 'nessuna-riga-aggiornata', alunno: alunnoId,
                    });
                    return NextResponse.json(
                        { error: 'Questo bambino non è più nell\'elenco di questa postazione.', codice: 'ALUNNO_NON_APRIBILE' },
                        { status: 404 },
                    );
                }
                logEvento('gdpr', 'error', {
                    operazione: 'admin/students/archivia:POST', esito: 'memoria-non-scritta',
                    alunno: alunnoId, error_code: (errMemoria as { code?: string }).code,
                }, errMemoria);
                return NextResponse.json(
                    { error: 'L\'archiviazione non è stata registrata: la scheda è rimasta com\'era.', codice: 'ARCHIVIAZIONE_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
        }

        const esitoScrittura = await scriviAlunnoEFrequenza(
            supabase,
            { alunnoId, annoSedeId, campi: campiFreq },
            () => supabase
                .from('alunni')
                .update(aggiornamento)
                .eq('id', alunnoId)
                .in('scuola_id', plessi)
                .select('id')
                .single(),
        );
        if (!esitoScrittura.scritto) {
            return rispostaFrequenzaNonScritta(esitoScrittura.codice, 'admin/students/archivia:POST');
        }
        const { data: dopo, error: errScrittura } = esitoScrittura.risultato;

        // La frequenza è già scritta (e lo specchio ha già sganciato il bambino dalla classe) e `alunni` no: non è vero che
        // «la scheda è rimasta com'era». Il log dedicato è già partito dall'helper; la memoria della classe è al sicuro
        // (scritta prima), e riprovare completa autore e audit.
        if (errScrittura && esitoScrittura.frequenzaGiaScritta) return rispostaScritturaIncompleta();

        if (errScrittura) {
            // ⚠️ QUI NON SI DEGRADA. Il ciclo «togli la colonna e riprova» del
            // resto del repo, applicato a questo UPDATE, eseguirebbe lo
            // sganciamento e NON la memoria: il bambino uscirebbe dalla sua
            // sezione e nessuna riga direbbe più quale fosse. Vedi il perché per
            // esteso in `@/lib/alunni/archiviazione`.
            if (colonnaAssente(errScrittura)) return archivioNonDisponibile('scrittura', alunnoId);
            if ((errScrittura as { code?: string }).code === 'PGRST116') {
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/students/archivia:POST', esito: 'nessuna-riga-aggiornata', alunno: alunnoId,
                });
                return NextResponse.json(
                    { error: 'Questo bambino non è più nell\'elenco di questa postazione.', codice: 'ALUNNO_NON_APRIBILE' },
                    { status: 404 },
                );
            }
            logEvento('gdpr', 'error', {
                operazione: 'admin/students/archivia:POST', esito: 'archiviazione-non-scritta',
                alunno: alunnoId, error_code: (errScrittura as { code?: string }).code,
            }, errScrittura);
            return NextResponse.json(
                { error: 'L\'archiviazione non è stata registrata: la scheda è rimasta com\'era.', codice: 'ARCHIVIAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }

        // Audit DOPO il successo, e con i soli campi toccati: `registro_modifiche`
        // non si usa (è il posto in cui finivano le copie integrali) e
        // `valorePrima` porta la classe di provenienza, che è l'informazione che
        // rende l'operazione reversibile anche a partire dal registro d'audit.
        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: alunnoId,
            azione: 'update',
            scuolaId: (prima.scuola_id as string | null) ?? null,
            sectionId: (prima.section_id as string | null) ?? null,
            valorePrima: {
                stato: prima.stato ?? null,
                section_id: prima.section_id ?? null,
                classe_sezione: prima.classe_sezione ?? null,
                // ⚠️ Il gruppo mensa entra nell'audit perché è l'UNICA delle cose
                // che questo UPDATE azzera a non avere una colonna che se la
                // ricordi: `section_id` e `classe_sezione` finiscono negli
                // `archiviato_*`, il gruppo no. Senza questa riga, «reversibile
                // anche a partire dal registro d'audit» sarebbe vero per la classe
                // e falso per la mensa — e nessuna riga direbbe più a quale turno
                // il bambino mangiava.
                gruppo_mensa_id: prima.gruppo_mensa_id ?? null,
            },
            valoreDopo: aggiornamento,
        });

        /**
         * IL BATTITO DI SUCCESSO — su `gdpr`, che è in `EVENTI_PERSISTITI`.
         *
         * Serve perché nessuna schermata si riempie a vista quando un bambino
         * esce dagli elenchi: se non si logga il successo, «nessun log» non
         * distingue «non ha archiviato nessuno» da «l'archiviazione non parte
         * più» — l'ambiguità esatta che ha tenuto nascosto per mesi il guasto
         * delle email di credenziali (AGENTS.md, regola 5).
         *
         * ⚠️ NON su `anagrafica`, che sarebbe stata la scorciatoia: quel canale
         * sta in `DEROGHE_INFO_NON_PERSISTITI` perché i suoi `info` sono note
         * tecniche, quindi il successo non arriverebbe in `app_log` — cioè non
         * sarebbe interrogabile in SQL proprio quando serve. `gdpr` è il canale
         * giusto anche nel merito: questo è l'atto che ferma il trattamento
         * operativo dei dati di un minore e avvia i termini di conservazione.
         *
         * A log solo uuid, ruolo, un enumerato chiuso e il nome della classe
         * (`sezione`, in lista bianca). Mai nome, cognome o codice fiscale.
         */
        // Le frequenze VIVE degli anni non ancora in corso (una conferma aperta, un'iscrizione dell'anno prossimo) si chiudono con la
        // stessa regola di «Ritira la conferma»: la voce della quota si toglie solo se non è pagata. Non blocca l'archiviazione
        // (la scheda è già scritta): ne riporta il conteggio, e il pannello dice quante voci pagate sono rimaste. Vale anche per
        // un bambino `in_arrivo`, che non ha una frequenza dell'anno in corso ma ne ha una nell'anno aperto.
        const chiusura = await chiudiFrequenzeAperte(supabase, { alunnoId, attore: auth.user });
        if (chiusura.non_riuscite > 0) {
            // La scheda è archiviata ma almeno un'iscrizione dell'anno prossimo (o la lettura che la trova) non si è chiusa: la quota
            // può restare visibile alla famiglia. Livello `error`: il solo conteggio e l'uuid (4.5.16, E).
            logEvento('gdpr', 'error', {
                operazione: 'admin/students/archivia:POST',
                azione: 'alunno-archiviato',
                esito: 'iscrizioni-non-chiuse',
                entita_id: alunnoId,
                n_non_chiuse: chiusura.non_riuscite,
            });
        }

        logEvento('gdpr', 'info', {
            operazione: 'admin/students/archivia:POST',
            azione: 'alunno-archiviato',
            esito: 'archiviato',
            alunno: alunnoId,
            ruolo: auth.user.role,
            tipo: motivo ?? 'non_dichiarato',
            sezione: (prima.classe_sezione as string | null) ?? undefined,
        });

        return NextResponse.json({
            success: true,
            alunno_id: (dopo?.id as string | undefined) ?? alunnoId,
            archiviato_il: adesso,
            /** La classe da cui è stato sganciato: la scheda la mostra come «Era in: …». */
            era_in: (prima.classe_sezione as string | null) ?? (daCompletare ? (prima.archiviato_classe_sezione as string | null) : null) ?? null,
            /** Le iscrizioni dell'anno prossimo chiuse con l'archiviazione, e le voci di quota rimaste perché già pagate (4.5.15). */
            frequenze_chiuse: chiusura.chiuse,
            voci_pagate_rimaste: chiusura.voci_pagate_rimaste,
            /** Le iscrizioni dell'anno prossimo che NON si sono chiuse (guasto): la scheda lo dice e propone «Riprova» (4.5.16, E). */
            iscrizioni_non_chiuse: chiusura.non_riuscite,
        });
    } catch (err) {
        logErrore({ operazione: 'admin/students/archivia:POST', stato: 500 }, err);
        return NextResponse.json(
            { error: 'L\'archiviazione non è stata registrata: la scheda è rimasta com\'era.', codice: 'ARCHIVIAZIONE_NON_RIUSCITA' },
            { status: 500 },
        );
    }
});

/**
 * Le sei colonne dell'archiviazione non esistono in questo database.
 *
 * È lo stato del DB E2E della CI, che è un progetto SEPARATO e non migrato. La
 * risposta è 503 e non 500 perché il rimedio non è «riprova fra un minuto»: è
 * applicare la migrazione. E soprattutto NON è un 200 su una scrittura fatta a
 * metà — vedi `colonnaAssente`.
 */
function archivioNonDisponibile(fase: 'lettura' | 'scrittura', alunnoId: string): NextResponse {
    logEvento('gdpr', 'error', {
        operazione: 'admin/students/archivia:POST',
        esito: 'colonne-archiviazione-assenti',
        azione: fase,
        alunno: alunnoId,
    });
    return NextResponse.json(
        {
            error: 'L\'archivio dei «non più iscritti» non è disponibile su questo ambiente: nessuna modifica è stata registrata.',
            codice: 'ARCHIVIO_NON_DISPONIBILE',
        },
        { status: 503 },
    );
}
