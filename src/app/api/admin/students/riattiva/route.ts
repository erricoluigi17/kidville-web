import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { STATO_ISCRITTO, eAncoraIscritto } from '@/lib/alunni/stato';
import { colonnaAssente } from '@/lib/alunni/archiviazione';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { classeEsisteInOgniSede } from '../route';

// ============================================================================
// RIPORTA UN ALUNNO FRA GLI ISCRITTI — il ritorno, che è metà del modello.
//
// L'archiviazione è REVERSIBILE, e questa è la strada del ritorno: lo stato
// torna `iscritto`, i tracciamenti (`archiviato_il`/`_da`/`_motivo`) si azzerano,
// e il bambino ritorna nella sua classe — se quella classe esiste ancora.
//
// ─── LA CLASSE NON SI RIPRISTINA ALLA CIECA ─────────────────────────────────
// `archiviato_classe_sezione` è un NOME, e può essere STANTIO: la classe può
// essere stata rinominata, cancellata, oppure il bambino è cresciuto di un anno
// mentre era fuori. E dal 2026-07-29 il nome non è nemmeno una chiave: «2 ANNI»
// esiste ad Aversa e a Cesa.
//
// Il trigger `sync_alunno_section_id` NON protegge da questo: se il nome nella
// sede non c'è, non produce nessun errore — lascia `section_id` a NULL, e il
// bambino risulta iscritto e invisibile a ogni elenco per sezione. Perciò il nome
// si VERIFICA prima, con la stessa funzione che usa `admin/students:PATCH`
// (`classeEsisteInOgniSede`, importata e non ricopiata: una regola valida per due
// strade deve vivere in un posto solo), e se non esiste più si riattiva SENZA
// classe DICENDOLO. Mai un `section_id` indovinato: un bambino nella sezione
// sbagliata è invisibile a chi lo cerca in quella giusta.
//
// ─── COSA NON TORNA INDIETRO, E DOVE ADESSO VIENE DETTO ─────────────────────
// ⚠️ Questo elenco è di tre voci, e fino al 2026-08-13 il riquadro di conferma
// dell'archiviazione ne diceva UNA. «È reversibile» era scritto senza le due
// eccezioni che rendono la frase parzialmente falsa, cioè l'operatore decideva
// senza sapere che cosa perdeva. Adesso ogni voce ha il suo posto, PRIMA (nel
// riquadro, `detailArchivia*`) e DOPO (nella risposta di questa rotta):
//
//  · `gruppo_mensa_id` — è un'assegnazione operativa dell'anno, non una proprietà
//    del bambino. Indovinarla lo farebbe ricomparire in una lista di cucina.
//    Prima: `detailArchiviaMensa`. Dopo: `gruppo_mensa_da_riassegnare`.
//  · LA CLASSE può non tornare: il nome ricordato è verificato nella sede, e se
//    non esiste più il bambino rientra senza. Prima: `detailArchiviaClasse`.
//    Dopo: `esito_classe` + `classe_mancante`.
//  · Il MOTIVO delle assenze scritto dalle famiglie: l'automa
//    `presenze-giustificazioni-retention` lo azzera ogni notte per chi non è più
//    iscritto, e il ritorno non lo riporta indietro. Prima:
//    `detailArchiviaMotivoAssenze`. Dopo: non c'è niente da dire, è già sparito.
//  · Foto, video e messaggi, se «libera spazio» è già passato: la riattivazione
//    RIESCE lo stesso — non ha senso tenere fuori dagli iscritti un bambino che
//    è tornato — ma la risposta lo dichiara (`spazio_gia_liberato`), perché chi
//    ha davanti la famiglia deve poterlo dire.
// ============================================================================

/**
 * CHE FINE HA FATTO LA CLASSE — quattro casi, non due.
 *
 * ⚠️ QUESTO TIPO NASCE DA UN CAMPO CHE MENTIVA. Fino al 2026-08-13 la risposta
 * portava `classe_ripristinata: boolean`, e il commento diceva «`false` = è
 * tornato fra gli iscritti SENZA classe: va assegnata a mano». Misurato eseguendo
 * la rotta sul ritiro fatto a mano dalla tendina — `stato='ritirato'`,
 * `section_id`/`classe_sezione` ANCORA valorizzati, `archiviato_*` NULL, che è il
 * caso che questa rotta dichiara essere «precisamente il caso in cui il ritorno
 * serve» — la risposta era `{classe_ripristinata:false, classe_sezione:'2 ANNI'}`.
 * Un booleano solo non distingue «non ho riscritto niente perché non c'era
 * niente da riscrivere» da «non ho riscritto niente perché la classe ce l'ha
 * già»: la scheda cadeva sul ramo «Assegna una classe dalla sua scheda» su un
 * bambino che era in «2 ANNI», e `app_log` registrava `riattivato-senza-classe`
 * sulla stessa riga.
 *
 * I quattro casi sono quattro perché portano a quattro gesti diversi:
 *  · `ripristinata` — la classe ricordata esisteva ancora e l'abbiamo riscritta;
 *  · `conservata`   — il bambino non era mai stato sganciato (ritiro a mano):
 *                     la classe è quella di sempre, e NON c'è niente da fare;
 *  · `sparita`      — la classe ricordata non esiste più: va scelta una nuova, e
 *                     la risposta NOMINA quella che non c'è più;
 *  · `assente`      — nessuna memoria e nessuna classe addosso: va assegnata.
 */
export type EsitoClasse = 'ripristinata' | 'conservata' | 'sparita' | 'assente';

const bodySchema = z.object({
    alunno_id: z.string().min(1),
    /**
     * La classe con cui rientra, quando l'operatore la sceglie: VINCE sempre su
     * quella ricordata. È il caso normale del bambino cresciuto di un anno.
     * `null`/assente = si usa la memoria dell'archiviazione.
     */
    classe_sezione: z.string().nullable().optional(),
});

export const POST = withRoute('admin/students/riattiva:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, bodySchema);
    if ('response' in b) return b.response;
    const { alunno_id: alunnoId } = b.data;
    const classeChiesta =
        typeof b.data.classe_sezione === 'string' && b.data.classe_sezione.trim() !== ''
            ? b.data.classe_sezione.trim()
            : null;

    try {
        const supabase = await createAdminClient();

        // Gate di tenant PRIMA di tutto, come sull'archiviazione: il client è
        // service-role e `requireStaff` dice il ruolo, non la sede.
        const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId);
        if (scopeErr) return scopeErr;

        const plessi = await scuoleDiUtente(supabase, auth.user);

        // Lettura minima: nessuna colonna che nomini il bambino.
        const { data: prima, error: errLettura } = await supabase
            .from('alunni')
            .select('id, scuola_id, stato, classe_sezione, archiviato_il, archiviato_classe_sezione, spazio_liberato_il')
            .eq('id', alunnoId)
            .in('scuola_id', plessi)
            .maybeSingle();

        if (errLettura) {
            if (colonnaAssente(errLettura)) return archivioNonDisponibile('lettura', alunnoId);
            // PostgREST non lancia: senza questo controllo il guasto diventerebbe
            // «zero righe», cioè un 404 che afferma qualcosa su un dato non letto.
            logEvento('gdpr', 'error', {
                operazione: 'admin/students/riattiva:POST', esito: 'lettura-non-riuscita',
                alunno: alunnoId, error_code: (errLettura as { code?: string }).code,
            }, errLettura);
            return NextResponse.json(
                { error: 'Non è stato possibile leggere la scheda: il bambino non è stato riportato fra gli iscritti.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }
        if (!prima) {
            logEvento('multi_sede', 'warn', {
                operazione: 'admin/students/riattiva:POST', esito: 'alunno-non-piu-in-scope', alunno: alunnoId,
            });
            return NextResponse.json(
                { error: 'Questo bambino non è più nell\'elenco di questa postazione.', codice: 'ALUNNO_NON_APRIBILE' },
                { status: 404 },
            );
        }

        /**
         * ⚠️ IL 409 GUARDA LO STATO, NON `archiviato_il` — l'opposto esatto del
         * 409 dell'archiviazione, e per la stessa ragione letta dall'altro lato.
         *
         * L'operatore preme «Riporta fra gli iscritti»: se il bambino è GIÀ fra
         * gli iscritti, l'intento è già soddisfatto e c'è quasi sempre una
         * seconda scheda aperta — o un elenco stantìo — dietro quel click.
         * Guardare `archiviato_il` invece dello stato rifiuterebbe il ritiro
         * fatto a mano dalla tendina (`stato = 'ritirato'`, `archiviato_il` NULL),
         * che è precisamente il caso in cui il ritorno serve.
         */
        if (eAncoraIscritto(prima.stato as string | null)) {
            logEvento('gdpr', 'info', {
                operazione: 'admin/students/riattiva:POST', esito: 'gia-iscritto', alunno: alunnoId,
            });
            return NextResponse.json(
                { error: 'Questo bambino è già fra gli iscritti: ricarica l\'elenco.', codice: 'ALUNNO_NON_ARCHIVIATO' },
                { status: 409 },
            );
        }

        const sede = (prima.scuola_id as string | null) ?? null;
        const ricordata = (prima.archiviato_classe_sezione as string | null) ?? null;
        const candidata = classeChiesta ?? (ricordata && ricordata.trim() !== '' ? ricordata.trim() : null);

        /**
         * Senza sede sulla riga non c'è nessun perimetro entro cui validare la
         * classe: si nega, non si indovina. È la stessa guardia di
         * `admin/students:PATCH` («Alunno senza sede: impossibile assegnare la
         * classe»), e vale a maggior ragione qui, dove la classe la propone il
         * server e non l'operatore.
         */
        if (candidata !== null && !sede) {
            logEvento('multi_sede', 'error', {
                operazione: 'admin/students/riattiva:POST', esito: 'alunno-senza-sede', alunno: alunnoId,
            });
            return NextResponse.json(
                { error: 'Il bambino non è riportato fra gli iscritti: la sua scheda non dichiara una sede, quindi la classe non è assegnabile.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }

        /** La classe che verrà scritta; `null` = rientra senza classe. */
        let classeDaScrivere: string | null = null;
        /** La classe RICORDATA che non esiste più: la scheda deve nominarla. */
        let classeMancante: string | null = null;

        if (candidata !== null && sede) {
            /**
             * ⚠️ DUE DOMANDE DIVERSE SULLO STESSO CONTROLLO, e la differenza è
             * tutta in chi ha scelto il nome.
             *
             * `classeEsisteInOgniSede` è nata per RIFIUTARE: risponde `null` se la
             * classe c'è, un 400 se non c'è, un 500 se la verifica non è riuscita.
             *  · Classe CHIESTA dall'operatore → il 400 è la risposta giusta,
             *    identica a quella che riceverebbe dalla scheda: ha nominato una
             *    classe che in quella sede non esiste, e deve saperlo.
             *  · Classe RICORDATA → il 400 NON deve uscire: nessuno ha sbagliato
             *    niente, è il mondo che è cambiato mentre il bambino era fuori.
             *    Lì «non esiste più» significa «rientra senza classe, e dillo».
             *
             * Il 500 invece si propaga in ENTRAMBI i casi: «non ho potuto
             * verificare» non è «non c'è». Se lo si trattasse come un no, un
             * guasto di lettura toglierebbe la classe a un bambino che ce
             * l'aveva, e nessuno se ne accorgerebbe finché non lo cerca in
             * sezione. Si preferisce non riattivare e riprovare.
             */
            const esito = await classeEsisteInOgniSede(supabase, candidata, [sede], 'admin/students/riattiva:POST');
            if (esito === null) {
                classeDaScrivere = candidata;
            } else if (classeChiesta !== null || esito.status !== 400) {
                return esito;
            } else {
                classeMancante = candidata;
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/students/riattiva:POST',
                    esito: 'classe-ricordata-sparita',
                    alunno: alunnoId,
                    sezione: candidata,
                });
            }
        }

        const aggiornamento: Record<string, unknown> = {
            stato: STATO_ISCRITTO,
            // I tre tracciamenti si azzerano: `stato` dice COSA, `archiviato_il`
            // dice QUANDO, e lasciarla valorizzata su un bambino che frequenta
            // significherebbe tenerlo nell'elenco di un'operazione irreversibile
            // (vedi la tabella nella testata di `@/lib/alunni/stato`).
            archiviato_il: null,
            archiviato_da: null,
            archiviato_motivo: null,
            // Anche la memoria si azzera: ha esaurito il suo compito, e una
            // memoria che sopravvive al ritorno è un dato che il prossimo
            // ripristino leggerebbe come vero.
            archiviato_section_id: null,
            archiviato_classe_sezione: null,
        };
        // ⚠️ `section_id` NON si scrive: lo risolve il trigger
        // `sync_alunno_section_id`, che dopo l'archiviazione lo trova a NULL e
        // quindi entra nel suo ramo di risoluzione. Scriverlo a mano vorrebbe
        // dire calcolare qui la stessa cosa, con una regola in più da tenere
        // allineata — e il trigger risolve DENTRO la sede dell'alunno, che è
        // proprio la garanzia che serve. Se la classe non si ripristina, non si
        // tocca neanche `classe_sezione`: resta NULL, come l'ha lasciata
        // l'archiviazione.
        if (classeDaScrivere !== null) aggiornamento.classe_sezione = classeDaScrivere;

        const { data: dopo, error: errScrittura } = await supabase
            .from('alunni')
            .update(aggiornamento)
            .eq('id', alunnoId)
            .in('scuola_id', plessi)
            .select('id')
            .single();

        if (errScrittura) {
            if (colonnaAssente(errScrittura)) return archivioNonDisponibile('scrittura', alunnoId);
            if ((errScrittura as { code?: string }).code === 'PGRST116') {
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/students/riattiva:POST', esito: 'nessuna-riga-aggiornata', alunno: alunnoId,
                });
                return NextResponse.json(
                    { error: 'Questo bambino non è più nell\'elenco di questa postazione.', codice: 'ALUNNO_NON_APRIBILE' },
                    { status: 404 },
                );
            }
            logEvento('gdpr', 'error', {
                operazione: 'admin/students/riattiva:POST', esito: 'riattivazione-non-scritta',
                alunno: alunnoId, error_code: (errScrittura as { code?: string }).code,
            }, errScrittura);
            return NextResponse.json(
                { error: 'Il bambino non è stato riportato fra gli iscritti: la scheda è rimasta com\'era.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: alunnoId,
            azione: 'update',
            scuolaId: sede,
            valorePrima: {
                stato: prima.stato ?? null,
                archiviato_il: prima.archiviato_il ?? null,
                archiviato_classe_sezione: ricordata,
            },
            valoreDopo: aggiornamento,
        });

        /**
         * La classe che il bambino ha ADESSO — la sola cosa che la scheda e il log
         * devono dire. `classeDaScrivere` è quella riscritta ORA; se non se n'è
         * riscritta nessuna, resta quella che aveva addosso (che dopo
         * un'archiviazione è NULL, e dopo un ritiro a mano è la sua di sempre).
         */
        const addosso = (prima.classe_sezione as string | null) ?? null;
        const classeAttuale = classeDaScrivere ?? (addosso !== null && addosso.trim() !== '' ? addosso : null);
        // L'ordine dei rami è l'ordine in cui i casi si escludono: ciò che abbiamo
        // scritto noi vince su ciò che ricordavamo, e una classe sparita si dice
        // anche se per caso il bambino ne avesse un'altra addosso.
        const esitoClasse: EsitoClasse =
            classeDaScrivere !== null ? 'ripristinata'
                : classeMancante !== null ? 'sparita'
                    : classeAttuale !== null ? 'conservata'
                        : 'assente';

        // Il battito di successo, sullo stesso canale persistito
        // dell'archiviazione: le due metà dello stesso modello devono potersi
        // contare con una query sola.
        logEvento('gdpr', 'info', {
            operazione: 'admin/students/riattiva:POST',
            azione: 'alunno-riattivato',
            // ⚠️ Lo stesso enumerato della risposta, non una seconda etichetta
            // calcolata a parte: quando il log e la schermata raccontano la stessa
            // cosa in due modi, il giorno che divergono si crede a quello sbagliato.
            esito: `riattivato-classe-${esitoClasse}`,
            alunno: alunnoId,
            ruolo: auth.user.role,
            sezione: classeAttuale ?? undefined,
        });

        return NextResponse.json({
            success: true,
            alunno_id: (dopo?.id as string | undefined) ?? alunnoId,
            /** Che fine ha fatto la classe: vedi `EsitoClasse`, quattro casi. */
            esito_classe: esitoClasse,
            /** La classe con cui frequenta adesso; `null` quando non ne ha una. */
            classe_sezione: classeAttuale,
            /** La classe ricordata che non esiste più: la scheda la nomina. */
            classe_mancante: classeMancante,
            /**
             * Il gruppo mensa NON torna, e va detto anche dopo.
             *
             * `archivia` lo azzera di proposito — un bambino archiviato che resta
             * in una lista di cucina è un pasto contato — e questa rotta non lo
             * indovina. Fino al 2026-08-13 era la sola delle tre perdite a non
             * comparire da nessuna parte: né nel riquadro di conferma né qui,
             * mentre `spazio_gia_liberato` e la sorte della classe erano dichiarate.
             *
             * Si deriva da `archiviato_il` e non si finge di sapere di più: chi è
             * passato dall'archiviazione ha avuto il gruppo azzerato: se ne aveva
             * uno, va rimesso. Chi era stato solo messo a «Ritirato» dalla tendina
             * non è mai passato di lì, e il suo gruppo non è stato toccato.
             */
            gruppo_mensa_da_riassegnare: prima.archiviato_il != null,
            /**
             * Foto, video e messaggi erano già stati cancellati: il ritorno non
             * li riporta indietro, e chi ha la famiglia davanti deve dirlo.
             */
            spazio_gia_liberato: prima.spazio_liberato_il != null,
        });
    } catch (err) {
        logErrore({ operazione: 'admin/students/riattiva:POST', stato: 500 }, err);
        return NextResponse.json(
            { error: 'Il bambino non è stato riportato fra gli iscritti: la scheda è rimasta com\'era.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
            { status: 500 },
        );
    }
});

/** Gemella di quella dell'archiviazione: vedi `colonnaAssente` per il perché non si degrada. */
function archivioNonDisponibile(fase: 'lettura' | 'scrittura', alunnoId: string): NextResponse {
    logEvento('gdpr', 'error', {
        operazione: 'admin/students/riattiva:POST',
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
