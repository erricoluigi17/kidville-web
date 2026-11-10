import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
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
import { annoAttivoDiSede, campiFrequenzaDaAlunno } from '@/lib/anno/frequenze';
import { scriviAlunnoEFrequenza, sezioneDelNome } from '@/lib/anno/scrittura';
import { erroreAnno, rispostaFrequenzaNonScritta, rispostaScritturaIncompleta } from '@/lib/anno/errori';
import { classeDellaFrequenzaChiusa, archiviatoDalPassaggio, classeRicordataDelloStessoAnno, frequenzeDellaFinestra, iscrizioniDelBambino, riapriFrequenzaNuovaDellaFinestra, riapriFrequenzaProssima, ricreaQuotaProssima } from '@/lib/anno/iscrizione-anno';
import { PATCH_RITORNO_IN_ARRIVO } from '@/lib/anno/domanda-anno-prossimo';

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
            .select('id, scuola_id, stato, classe_sezione, archiviato_il, archiviato_da, archiviato_motivo, archiviato_section_id, archiviato_classe_sezione, spazio_liberato_il')
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
        /**
         * ⚠️ ECCEZIONE: una riattivazione a metà. Senza transazione (fino alla PR 5) la frequenza `iscritto` può essere
         * scritta e `alunni` no: lo specchio ha già messo `stato = 'iscritto'`, ma le tracce dell'archiviazione
         * (`archiviato_da`, `archiviato_motivo`, la memoria della classe) sono ancora lì. Uno stato `iscritto` con quelle
         * tracce NON è un bambino davvero iscritto: è il lavoro da completare, e riprovare lo completa.
         */
        const tracceArchiviazione =
            prima.archiviato_da != null || prima.archiviato_motivo != null ||
            prima.archiviato_section_id != null || prima.archiviato_classe_sezione != null;
        // ⚠️ Le stesse tracce le lascia anche un'ARCHIVIAZIONE fallita a metà (la memoria è scritta prima della frequenza):
        // un iscritto VERO con la memoria addosso. Lì la classe attuale è quella ricordata e riattivare completa senza
        // spostare nessuno. Se invece la classe attuale è DIVERSA dalla ricordata la memoria è stantia: riscriverla
        // sposterebbe il bambino, quindi NON la si riscrive: si tolgono le tracce (ramo `tracceStantie`, con audit) e si
        // risponde 200 `conservata`. Senza classe attuale non c'è nessuno da spostare.
        const attuale = ((prima.classe_sezione as string | null) ?? '').trim();
        const ricordataPrima = ((prima.archiviato_classe_sezione as string | null) ?? '').trim();
        const classeCompatibile = attuale === '' || attuale === ricordataPrima;
        const mezzaRiattivata = prima.stato === STATO_ISCRITTO && tracceArchiviazione && classeCompatibile;
        // (quinto giro, E2) Un iscritto con le tracce di un'archiviazione E una classe diversa dalla ricordata: la riattivazione era rimasta a metà e il
        // bambino è andato avanti (la ricopia del 01/09 gli ha dato la classe nuova), oppure la memoria è stantia. La classe attuale è giusta e non si tocca:
        // si tolgono le tracce e si risponde il vero (è già fra gli iscritti, con la sua classe).
        const tracceStantie = prima.stato === STATO_ISCRITTO && tracceArchiviazione && !classeCompatibile;
        const sede0 = (prima.scuola_id as string | null) ?? null;
        if (tracceStantie) {
            const { error: errTracce } = await supabase
                .from('alunni')
                .update({ archiviato_da: null, archiviato_motivo: null, archiviato_section_id: null, archiviato_classe_sezione: null })
                .eq('id', alunnoId)
                .in('scuola_id', plessi)
                .select('id')
                .single();
            if (errTracce) {
                if (colonnaAssente(errTracce)) return archivioNonDisponibile('scrittura', alunnoId);
                logEvento('gdpr', 'error', {
                    operazione: 'admin/students/riattiva:POST', esito: 'tracce-non-tolte', alunno: alunnoId, error_code: (errTracce as { code?: string }).code,
                }, errTracce);
                return NextResponse.json(
                    { error: 'Il bambino è già fra gli iscritti, ma non è stato possibile ripulire la scheda. Riprova.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            await logScrittura(supabase, {
                attore: auth.user,
                entitaTipo: 'alunni',
                entitaId: alunnoId,
                azione: 'update',
                scuolaId: sede0,
                valorePrima: { stato: prima.stato ?? null, archiviato_da: prima.archiviato_da ?? null, archiviato_motivo: prima.archiviato_motivo ?? null, archiviato_classe_sezione: ricordataPrima || null },
                valoreDopo: { archiviato_da: null, archiviato_motivo: null, archiviato_section_id: null, archiviato_classe_sezione: null },
            });
            logEvento('gdpr', 'info', {
                operazione: 'admin/students/riattiva:POST', azione: 'alunno-riattivato', esito: 'riattivato-tracce-tolte', alunno: alunnoId, ruolo: auth.user.role,
            });
            return NextResponse.json({
                success: true, alunno_id: alunnoId, esito_classe: 'conservata', classe_sezione: attuale !== '' ? attuale : null, classe_mancante: null,
                gruppo_mensa_da_riassegnare: false, spazio_gia_liberato: prima.spazio_liberato_il != null, conferma_da_rifare: false,
            });
        }
        if (eAncoraIscritto(prima.stato as string | null) && !mezzaRiattivata) {
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
        let candidata = classeChiesta ?? (ricordata && ricordata.trim() !== '' ? ricordata.trim() : null);
        const annoSedeId = await annoAttivoDiSede(supabase, sede);

        /**
         * ─── RIATTIVARE È IL CONTRARIO DI ARCHIVIARE (4.5.15, I3) ─────────────────────────────────────────────
         * Un bambino che non ha MAI avuto la frequenza dell'anno attivo e ne ha una in un anno che viene (la sua iscrizione, chiusa
         * dall'archiviazione o ancora viva) arrivava come «in arrivo»: tornare `iscritto` lo metterebbe fra i frequentanti di oggi
         * senza classe e senza frequenza (l'invariante 11-bis suona ogni notte). Torna `in_arrivo`, e la sua iscrizione si riapre
         * con la quota. Chi invece una frequenza dell'anno attivo ce l'ha torna `iscritto` come sempre, e la conferma dell'anno
         * prossimo NON si riapre da sola: chiusa dall'archiviazione, si rifà (la risposta lo dice).
         */
        // (chiusura 4.8) NELLA FINESTRA fra la conferma e l'inizio l'anno attivo è il nuovo e l'anno che si vede è il vecchio, e l'archiviazione di
        // quei giorni ha chiuso le frequenze vive di tutti e due. «Riattiva» DISFA ESATTAMENTE QUELLA: riapre solo le frequenze che quell'archiviazione
        // ha chiuso (`ritirato` con la data d'uscita del suo giorno), con la classe che avevano, senza cercare nessuna classe per nome.
        //  · la frequenza che si vede è stata chiusa da lei → la scheda torna `iscritto` su QUELL'anno (così ad agosto la famiglia lo vede e il diario
        //    lo elenca) e, se c'era, la frequenza nuova si riapre (così il 01/09 la ricopia lo porta nella classe nuova);
        //  · una riattivazione RIMASTA A METÀ (frequenze già riaperte, scheda no: `archiviato_il` è già vuoto) finisce il lavoro su QUELL'anno e non
        //    tocca la frequenza nuova, già viva con la sua classe: nessun nome si cerca nell'anno attivo;
        //  · la scheda è ANCORA archiviata dal passaggio (`archiviatoDalPassaggio`: il passaggio confermato ha chiuso la sua frequenza `uscito` e
        //    `archiviato_il` è della conferma, non di dopo) → 409 che rimanda alla «Conferma tardiva», che crea anche la quota (questa no). Vale nella
        //    finestra e dopo il 01/09, con la conferma nuova chiusa o no. Chi è uscito col passaggio, è tornato con una domanda ed è stato archiviato
        //    DOPO dalla segreteria non è «archiviato dal passaggio»: la sua archiviazione si disfa come sempre (torna `in_arrivo`, o `iscritto` dopo il 01/09);
        //  · la frequenza che si vede non è viva né sua (un «in arrivo»: non ne ha, o l'ha chiusa mesi prima) e la nuova è sua o ancora viva → torna
        //    `in_arrivo` con la sua iscrizione, anche se la scheda l'ha chiusa la sola tendina;
        //  · nient'altro → la strada di sempre (che rimanda alla «Conferma tardiva» se non c'è nessuna iscrizione).
        const finestra = await frequenzeDellaFinestra(supabase, { alunnoId, scuolaId: sede, archiviatoIl: (prima.archiviato_il as string | null) ?? null });
        if (!finestra.ok) {
            return NextResponse.json(
                { error: 'Non è stato possibile leggere le iscrizioni del bambino: non è stato riportato fra gli iscritti.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }
        const riapreNellaFinestra = finestra.nellaFinestra && finestra.visibileChiusaDallArchiviazione;
        // Una riattivazione rimasta a metà: la frequenza che si vede è già viva, la scheda è `iscritto` con le tracce addosso e `archiviato_il` è già
        // vuoto. Riprovare finisce il lavoro su quell'anno, come la prima volta.
        const ripresaNellaFinestra = finestra.nellaFinestra && !riapreNellaFinestra && mezzaRiattivata && prima.archiviato_il == null && finestra.visibileViva;
        const suAnnoVisibile = riapreNellaFinestra || ripresaNellaFinestra;
        const annoDiScrittura = finestra.nellaFinestra && suAnnoVisibile ? finestra.annoVisibileId : annoSedeId;
        if (!suAnnoVisibile && annoSedeId && prima.archiviato_il != null) {
            const dalPassaggio = await archiviatoDalPassaggio(supabase, { alunnoId, annoAttivoId: annoSedeId });
            if (!dalPassaggio.ok) {
                return NextResponse.json(
                    { error: 'Non è stato possibile leggere le iscrizioni del bambino: non è stato riportato fra gli iscritti.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            if (dalPassaggio.si) {
                logEvento('anno-scolastico', 'warn', {
                    tipo: 'riattiva-senza-iscrizione', operazione: 'admin/students/riattiva:POST', alunno: alunnoId, error_code: 'ALUNNO_SENZA_ISCRIZIONE',
                });
                return erroreAnno({ message: 'ALUNNO_SENZA_ISCRIZIONE' }, 'admin/students/riattiva:POST')!;
            }
        }
        if (finestra.nellaFinestra && !suAnnoVisibile) {
            const daRiprendere = finestra.nuovaChiusaDallArchiviazione ?? (finestra.visibileViva ? null : finestra.nuovaViva);
            if (daRiprendere) {
                return await riportaInArrivo({
                    supabase, plessi, alunnoId, ruolo: auth.user.role, attoreId: auth.user.id, attore: auth.user,
                    prima: prima as unknown as Record<string, unknown>, frequenza: daRiprendere,
                });
            }
        }
        const iscrizioni = suAnnoVisibile
            ? { ok: true as const, haFrequenzaAttiva: true, prossime: [] }
            : await iscrizioniDelBambino(supabase, { alunnoId, annoAttivoId: annoSedeId, archiviatoIl: (prima.archiviato_il as string | null) ?? null });
        if (!iscrizioni.ok) {
            return NextResponse.json(
                { error: 'Non è stato possibile leggere le iscrizioni del bambino: non è stato riportato fra gli iscritti.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                { status: 500 },
            );
        }
        const prossimaDaRiprendere = iscrizioni.haFrequenzaAttiva
            ? null
            : (iscrizioni.prossime.find((f) => f.chiusa) ?? iscrizioni.prossime[0] ?? null);
        if (prossimaDaRiprendere) {
            return await riportaInArrivo({
                supabase, plessi, alunnoId, ruolo: auth.user.role, attoreId: auth.user.id, attore: auth.user,
                prima: prima as unknown as Record<string, unknown>, frequenza: prossimaDaRiprendere,
            });
        }
        // (giro 1, B7) Nessuna frequenza nell'anno in corso e nessuna che viene: è il bambino uscito col passaggio d'anno. Rimetterlo
        // `iscritto` lo lascerebbe senza frequenza, fuori dall'app delle famiglie e dall'elenco della maestra, con un esito positivo.
        // Si dice dove farlo: la «Conferma tardiva» del passaggio.
        if (annoSedeId && !iscrizioni.haFrequenzaAttiva) {
            logEvento('anno-scolastico', 'warn', {
                tipo: 'riattiva-senza-iscrizione', operazione: 'admin/students/riattiva:POST', alunno: alunnoId, error_code: 'ALUNNO_SENZA_ISCRIZIONE',
            });
            return erroreAnno({ message: 'ALUNNO_SENZA_ISCRIZIONE' }, 'admin/students/riattiva:POST')!;
        }
        // (terzo giro, h) FUORI dalla finestra, se la frequenza dell'anno attivo l'ha chiusa l'archiviazione e tiene ancora la sua classe (archiviato
        // nella finestra), si riapre con QUELLA: il nome ricordato, cercato nell'anno nuovo, può essere un'altra classe con lo stesso nome.
        let classeDellaFrequenzaTrovata = false;
        if (!suAnnoVisibile && classeChiesta === null && annoSedeId) {
            const dellaFrequenza = await classeDellaFrequenzaChiusa(supabase, { alunnoId, annoSedeId, archiviatoIl: (prima.archiviato_il as string | null) ?? null });
            if (!dellaFrequenza.ok) {
                return NextResponse.json(
                    { error: 'Non è stato possibile leggere le iscrizioni del bambino: non è stato riportato fra gli iscritti.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            if (dellaFrequenza.nome !== null) {
                candidata = dellaFrequenza.nome;
                classeDellaFrequenzaTrovata = true;
            }
        }
        // (quarto giro, k) Il ripiego per NOME vale solo dentro lo stesso anno della classe ricordata: altrimenti non si cerca nessun nome e si dà il
        // segnale «classe da assegnare» (esito `sparita`, con il nome ricordato), come per una classe che non c'è più.
        let classeMancanteDiAltroAnno: string | null = null;
        if (candidata !== null && classeChiesta === null && !classeDellaFrequenzaTrovata && annoDiScrittura) {
            const stesso = await classeRicordataDelloStessoAnno(supabase, { sectionId: (prima.archiviato_section_id as string | null) ?? null, annoSedeId: annoDiScrittura });
            if (!stesso.ok) {
                return NextResponse.json(
                    { error: 'Non è stato possibile leggere le iscrizioni del bambino: non è stato riportato fra gli iscritti.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            if (!stesso.stesso) {
                classeMancanteDiAltroAnno = candidata;
                candidata = null;
                logEvento('multi_sede', 'warn', {
                    operazione: 'admin/students/riattiva:POST', esito: 'classe-ricordata-di-altro-anno', alunno: alunnoId, sezione: classeMancanteDiAltroAnno,
                });
            }
        }
        // Ogni iscrizione RITIRATA di un anno che viene (conferma, domanda, segreteria, import) si riapre dalla pagina delle conferme
        // con «Conferma»; una trasferita o uscita no, e non si dice (4.5.16, C).
        const confermaDaRifare = iscrizioni.prossime.some((f) => f.stato === 'ritirato');

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
        let classeMancante: string | null = classeMancanteDiAltroAnno;

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
            // Nella finestra la classe si verifica sull'anno su cui si scrive (il visibile), non sull'attivo: lì la stessa classe può non avere continuazione.
            const esito = suAnnoVisibile && finestra.nellaFinestra
                ? await classeNellAnno(supabase, candidata, finestra.annoVisibileId)
                : await classeEsisteInOgniSede(supabase, candidata, [sede], 'admin/students/riattiva:POST');
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

        // Fase B (§4.19): prima la frequenza dell'anno attivo (`archiviato_il` NULL → `iscritto` senza uscita; la sezione
        // della classe ripristinata la risolve `scriviAlunnoEFrequenza` dal nome), poi `alunni`. Se la frequenza non si
        // scrive, la scheda resta com'era. In fase A: `alunni` e poi la frequenza, fail-open.
        const campiFreq = campiFrequenzaDaAlunno(aggiornamento);
        // Nella finestra, PRIMA la frequenza dell'anno nuovo, con la classe che aveva (come `riportaInArrivo`: se la scheda poi non si scrive, la
        // riprova rifà la stessa strada, perché la frequenza nuova viva non si tocca due volte).
        let nuovaRiaperta = false;
        let nuovaSenzaClasse = false;
        if (riapreNellaFinestra && finestra.nellaFinestra && finestra.nuovaChiusaDallArchiviazione) {
            const nuova = await riapriFrequenzaNuovaDellaFinestra(supabase, { alunnoId, frequenza: finestra.nuovaChiusaDallArchiviazione });
            if (!nuova.ok) {
                return NextResponse.json(
                    { error: 'Il bambino non è stato riportato fra gli iscritti: la sua iscrizione all\'anno nuovo non si è riaperta, la scheda è rimasta com\'era. Riprova.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            nuovaRiaperta = true;
            nuovaSenzaClasse = nuova.senzaClasse;
            logEvento('anno-scolastico', 'info', { tipo: 'riattiva-finestra-frequenza-nuova-riaperta', operazione: 'admin/students/riattiva:POST', alunno: alunnoId });
            if (nuovaSenzaClasse) {
                // Non dovrebbe succedere (l'archiviazione le lascia la classe): se succede, la segreteria deve saperlo, mai il silenzio.
                logEvento('anno-scolastico', 'warn', { tipo: 'riattiva-finestra-frequenza-nuova-senza-classe', operazione: 'admin/students/riattiva:POST', alunno: alunnoId });
            }
        }
        const esitoScrittura = await scriviAlunnoEFrequenza(
            supabase,
            { alunnoId, annoSedeId: annoDiScrittura, campi: campiFreq, classeSezione: classeDaScrivere },
            () => supabase
                .from('alunni')
                .update(aggiornamento)
                .eq('id', alunnoId)
                .in('scuola_id', plessi)
                .select('id')
                .single(),
        );
        if (!esitoScrittura.scritto) {
            // L'iscrizione dell'anno nuovo è già stata riaperta: non è vero che «è rimasto tutto com'era». Riprovare completa.
            if (nuovaRiaperta) return rispostaScritturaIncompleta();
            return rispostaFrequenzaNonScritta(esitoScrittura.codice, 'admin/students/riattiva:POST');
        }
        const { data: dopo, error: errScrittura } = esitoScrittura.risultato;

        // La frequenza è già scritta e `alunni` no: non è vero che «la scheda è rimasta com'era». Riprovare completa.
        if (errScrittura && esitoScrittura.frequenzaGiaScritta) return rispostaScritturaIncompleta();

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
            /** (quinto giro, k) La classe ricordata esiste ma è di un ALTRO anno: non si è cercata per nome, va scelta a mano. */
            ...(classeMancanteDiAltroAnno !== null ? { classe_di_altro_anno: true } : {}),
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
            /**
             * L'iscrizione dell'anno prossimo (conferma, domanda, inserimento, import), chiusa dall'archiviazione, NON si riapre: il
             * bambino torna fra gli iscritti di oggi e la segreteria la riapre dalla pagina delle conferme con «Conferma».
             */
            conferma_da_rifare: confermaDaRifare,
            /** Nella finestra: la frequenza dell'anno nuovo è tornata viva MA senza classe (non dovrebbe succedere): la segreteria gliela assegna. */
            ...(nuovaSenzaClasse ? { avviso_classe_nuova: AVVISO_CLASSE_NUOVA } : {}),
        });
    } catch (err) {
        logErrore({ operazione: 'admin/students/riattiva:POST', stato: 500 }, err);
        return NextResponse.json(
            { error: 'Il bambino non è stato riportato fra gli iscritti: la scheda è rimasta com\'era.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
            { status: 500 },
        );
    }
});

/**
 * La classe `nome` esiste, nella sede, nell'anno `annoSedeId`? Come `classeEsisteInOgniSede` (stessa risposta: `null` se c'è, 400 se non c'è, 500 se la
 * verifica non è riuscita) ma sull'anno che si scrive: nella finestra non è l'anno attivo.
 */
async function classeNellAnno(supabase: SupabaseClient, nome: string, annoSedeId: string): Promise<NextResponse | null> {
    const r = await sezioneDelNome(supabase, annoSedeId, nome);
    if (!r.ok) return NextResponse.json({ error: 'Verifica della classe non riuscita', codice: 'RIATTIVAZIONE_NON_RIUSCITA' }, { status: 500 });
    if (r.id === null) {
        logEvento('multi_sede', 'warn', { operazione: 'admin/students/riattiva:POST', esito: 'classe-inesistente-nella-sede', sezione: nome, sedi_mancanti: 1 });
        return NextResponse.json({ error: `La classe «${nome}» non esiste nella sede di tutti gli alunni selezionati`, codice: 'RIATTIVAZIONE_NON_RIUSCITA' }, { status: 400 });
    }
    return null;
}

const AVVISO_CLASSE_NUOVA = 'L\'iscrizione dell\'anno nuovo è stata riaperta ma senza una classe: assegnala dalla pagina delle conferme, altrimenti il 1° settembre il bambino non entra in nessuna classe.';


/**
 * Il ritorno di un bambino «in arrivo» (4.5.15, I3): l'iscrizione dell'anno che viene si riapre (e la quota rinasce), poi la scheda
 * torna `in_arrivo` — senza classe, non archiviata, con le tracce dell'archiviazione azzerate. L'ordine è questo perché se la
 * scheda non si scrive la riprova rifà la stessa strada (l'iscrizione è già viva: si riprende solo la voce); nel verso opposto
 * il bambino sarebbe `in_arrivo` senza arrivo (invariante 11-ter). La voce della quota nasce per ultima, a scheda scritta: per una
 * scheda archiviata non nasce. La frequenza dell'anno attivo NON si tocca.
 */
async function riportaInArrivo(a: {
    supabase: SupabaseClient;
    plessi: string[];
    alunnoId: string;
    ruolo: string | undefined;
    attoreId: string;
    attore: Parameters<typeof logScrittura>[1]['attore'];
    prima: Record<string, unknown>;
    frequenza: Parameters<typeof riapriFrequenzaProssima>[1]['frequenza'] & { section_id?: string | null };
}): Promise<NextResponse> {
    const { supabase, plessi, alunnoId } = a;
    const rip = await riapriFrequenzaProssima(supabase, { alunnoId, frequenza: a.frequenza });
    if (!rip.ok) return rispostaFrequenzaNonScritta(rip.codice, 'admin/students/riattiva:POST');
    // Nella finestra la frequenza nuova arriva letta con la sua classe: se non ne ha (non dovrebbe), lo stesso segnale degli altri rami, mai il silenzio.
    const senzaClasse = 'section_id' in a.frequenza && a.frequenza.section_id === null;
    if (senzaClasse) {
        logEvento('anno-scolastico', 'warn', { tipo: 'riattiva-finestra-frequenza-nuova-senza-classe', operazione: 'admin/students/riattiva:POST', alunno: alunnoId });
    }

    const aggiornamento: Record<string, unknown> = {
        ...PATCH_RITORNO_IN_ARRIVO,
        archiviato_da: null,
        archiviato_motivo: null,
        archiviato_section_id: null,
        archiviato_classe_sezione: null,
    };
    const scritta = await scriviAlunnoEFrequenza(
        supabase,
        { alunnoId, annoSedeId: null, campi: {} },
        () => supabase.from('alunni').update(aggiornamento).eq('id', alunnoId).in('scuola_id', plessi).select('id').single(),
    );
    if (!scritta.scritto) return rispostaFrequenzaNonScritta(scritta.codice, 'admin/students/riattiva:POST');
    const { data: dopo, error: errScrittura } = scritta.risultato;
    if (errScrittura) {
        if (colonnaAssente(errScrittura)) return archivioNonDisponibile('scrittura', alunnoId);
        if ((errScrittura as { code?: string }).code === 'PGRST116') {
            return NextResponse.json(
                { error: 'Questo bambino non è più nell\'elenco di questa postazione.', codice: 'ALUNNO_NON_APRIBILE' },
                { status: 404 },
            );
        }
        logEvento('gdpr', 'error', {
            operazione: 'admin/students/riattiva:POST', esito: 'riattivazione-in-arrivo-non-scritta',
            alunno: alunnoId, error_code: (errScrittura as { code?: string }).code,
        }, errScrittura);
        return NextResponse.json(
            { error: 'Il bambino non è stato riportato fra gli iscritti: la scheda è rimasta com\'era.', codice: 'RIATTIVAZIONE_NON_RIUSCITA' },
            { status: 500 },
        );
    }

    // Solo ora la scheda non è più archiviata, e la voce della quota può nascere.
    const quota = await ricreaQuotaProssima(supabase, { alunnoId, frequenza: a.frequenza, attoreId: a.attoreId });

    await logScrittura(supabase, {
        attore: a.attore,
        entitaTipo: 'alunni',
        entitaId: alunnoId,
        azione: 'update',
        scuolaId: (a.prima.scuola_id as string | null) ?? null,
        valorePrima: { stato: a.prima.stato ?? null, archiviato_il: a.prima.archiviato_il ?? null },
        valoreDopo: { stato: PATCH_RITORNO_IN_ARRIVO.stato },
    });
    logEvento('gdpr', 'info', {
        operazione: 'admin/students/riattiva:POST',
        azione: 'alunno-riattivato',
        esito: 'riattivato-in-arrivo',
        alunno: alunnoId,
        ruolo: a.ruolo,
    });
    return NextResponse.json({
        success: true,
        alunno_id: (dopo?.id as string | undefined) ?? alunnoId,
        /** Torna fra i bambini che arrivano l'anno prossimo, non fra i frequentanti di oggi: niente classe da assegnare. */
        torna_in_arrivo: true,
        iscrizione_riaperta: rip.riaperta,
        /** `creata` / `collegata` / … ; NULL = nessuna voce (il listino non la prevede, o l'anno non ha le iscrizioni aperte). */
        quota,
        classe_sezione: null,
        classe_mancante: null,
        gruppo_mensa_da_riassegnare: false,
        spazio_gia_liberato: a.prima.spazio_liberato_il != null,
        conferma_da_rifare: false,
        ...(senzaClasse ? { avviso_classe_nuova: AVVISO_CLASSE_NUOVA } : {}),
    });
}

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
