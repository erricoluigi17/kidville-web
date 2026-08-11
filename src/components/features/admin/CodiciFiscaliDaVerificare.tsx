'use client';

/**
 * «CODICI FISCALI DA VERIFICARE» — la linguetta di /admin/students che elenca le
 * persone in archivio il cui codice fiscale non torna, dice PERCHÉ, e propone
 * quello che l'anagrafica implica.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * I TRE STATI SONO IL CUORE DELLA SCHERMATA, e non una raffinatezza grafica.
 *
 * Misurato in produzione l'11 agosto: su 33 alunni **18 non hanno il codice
 * fiscale** (e altrettanti non hanno il comune di nascita, 17 non hanno il sesso
 * registrato); su 50 genitori **27 non hanno il codice fiscale**. Se «manca»
 * venisse dipinto come «sbagliato», questo pannello aprirebbe con 45 righe rosse
 * su 83 — per un dato che nessuno ha mai inserito. Un pannello che segnala tutto
 * non segnala niente: si impara a ignorarlo in una settimana, e da quel momento
 * non segnala nemmeno le cose vere.
 *
 *   · `incoerente`       ROSSO, azionabile — c'è un codice e non torna;
 *   · `non-verificabile` GIALLO — c'è un codice ma manca un dato per confrontarlo;
 *   · `da-compilare`     NEUTRO — il codice non c'è. Non è un errore.
 *
 * La distinzione la fa già la route (`verificaCoerenza`, `motivi` vs
 * `nonVerificabili`): qui NON si ricalcola niente, si presenta. Ogni stato porta
 * un'icona e una parola, mai il solo colore: chi non distingue il rosso dal
 * giallo deve poter leggere quale dei tre è.
 *
 * ⚠️ MA IL NUMERO SULLA PILLOLA DELLA LINGUETTA NON È «QUANTI SONO I ROSSI».
 * Il colore risponde a «questo dato è sbagliato?», il badge a «quanto lavoro c'è
 * di là?»: sono due domande diverse, e confonderle è costato un difetto per parte.
 * Il badge conta i rossi PIÙ le righe su cui questo pannello mostra il comando di
 * scrittura — comprese quelle `da-compilare` con la proposta già pronta, che si
 * chiudono in un gesto e che la rotta mette in cima (`priorita: 0`). La regola sta
 * in `contaAzionabili`/`scrivibile`, in un posto solo, ed è la STESSA che decide
 * se «Applica» compare: due espressioni per la stessa domanda le fanno divergere,
 * e l'hanno fatto (1 alunno e 1 genitore veri, misurati l'11 agosto).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NESSUN «APPLICA A TUTTI», ed è una decisione, non una funzione mancante.
 *
 * Un aggiornamento di massa qui sarebbe un `UPDATE` sui codici fiscali di dei
 * minori, partito senza che nessun essere umano abbia letto che cosa stava per
 * essere scritto — e in questo progetto (CLAUDE.md, 2026-08-03) nessuno chiede
 * più conferma prima che una scrittura parta. Si applica **un record alla
 * volta**, e prima si legge per esteso ciò che si sta per scrivere: quale codice,
 * al posto di quale, su chi.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ORDINE PER AZIONABILITÀ. In cima chi ha un codice proposto (si chiude in un
 * gesto), poi chi chiede di sistemare prima il luogo di nascita, poi i non
 * verificabili. È il campo `priorita` che la route calcola; qui si riordina lo
 * stesso, perché l'ordine è una proprietà DI QUESTA SCHERMATA e va potuto
 * misurare senza chiamare la rete.
 *
 * ⚠️ `proposta_combacia` — la priorità 0 contiene DUE gesti opposti. Ci finisce
 * anche la riga che non ha niente di sbagliato: codice corretto, colonna
 * `codice_belfiore_nascita` vuota, comune scritto a mano che si risolve, e quindi
 * una proposta IDENTICA al codice registrato. È la forma più comune in produzione
 * (la colonna è NULL su tutte le righe vere). Lì «applica» riscriverebbe lo stesso
 * valore e non chiuderebbe niente: il gesto giusto è aprire la scheda e scegliere
 * il comune dalla tendina. Per questo il comando di scrittura NON compare quando
 * la proposta combacia.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    AlertTriangle,
    CheckCircle2,
    CircleDashed,
    HelpCircle,
    Info,
    RotateCcw,
    Search,
    ShieldCheck,
} from 'lucide-react';
import { CockpitSelect, Drawer, SectionTitle, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit';
import { btnClass } from '@/components/ui/Btn';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { cx } from '@/lib/ui/cx';

/* ─────────────────────────────────────────────────────────────────────────────
 * Il contratto della route, ricopiato QUI e non importato: `route.ts` è codice di
 * server (importa `createAdminClient`, il dataset dei comuni, il logger di Node)
 * e tirarlo dentro un file `'use client'` porterebbe il dataset dei comuni nel
 * bundle del browser — che è esattamente ciò che il lock
 * `dataset-comuni-fuori-dal-bundle` vieta.
 * ────────────────────────────────────────────────────────────────────────────*/

export type StatoCodiceFiscale = 'incoerente' | 'non-verificabile' | 'da-compilare';

export interface RigaCodiceFiscale {
    tipo: 'alunno' | 'genitore';
    id: string;
    nome: string | null;
    cognome: string | null;
    /** Per un alunno la sua struttura; per un genitore quelle dei suoi figli. */
    scuole_ids: string[];
    stato: StatoCodiceFiscale;
    codice_attuale: string | null;
    motivi: string[];
    non_verificabili: string[];
    codice_proposto: string | null;
    proposta_bloccata_da: 'luogo' | 'anagrafica' | null;
    /** La proposta coincide col codice registrato: resta solo da completare l'anagrafica. */
    proposta_combacia: boolean;
    /** 0 = si chiude in un gesto · 1 = prima si corregge il luogo · 2 = manca altro. */
    priorita: 0 | 1 | 2;
}

export interface EsitoCodiciFiscali {
    fase: 'caricamento' | 'pronto' | 'errore';
    righe: RigaCodiceFiscale[];
    /** Quante ne ha trovate il server: può superare `righe.length` (una pagina). */
    totale: number;
    /** Il server dichiara di aver fermato la scansione al proprio tetto. */
    troncato: boolean;
    /**
     * Una RILETTURA è in corso sopra un elenco già a schermo.
     *
     * È un campo separato da `fase` e non un suo valore: `fase === 'caricamento'`
     * significa «non ho ancora niente da mostrare» e fa comparire lo spinner a
     * tutta pagina, che SOSTITUISCE il pannello — drawer, esito della scrittura e
     * fuoco compresi. Una rilettura chiesta da una scrittura non ha questo
     * diritto: l'elenco resta, e il fatto che si stia aggiornando si dice con una
     * riga discreta. Vedi il commento di `ricarica`.
     */
    ricaricando: boolean;
    /**
     * Quante righe CHIEDONO UN GESTO ADESSO — il numero della pillola.
     *
     * La definizione sta in una funzione sola, `contaAzionabili`, e non è
     * «`stato === 'incoerente'`»: quella dizione — che questo commento ha
     * dichiarato fino all'11 agosto — lasciava fuori le righe su cui il pannello
     * mostra il comando di SCRITTURA. Misurato in produzione lo stesso giorno, in
     * sola lettura e a soli conteggi: **1 alunno** (su 29, 14 senza codice) e **1
     * genitore** (su 50, 27 senza codice) hanno nome, cognome, data, sesso e
     * comune di nascita, quindi una proposta pronta, `priorita: 0` e il comando
     * «Applica» a schermo — e non comparivano in questo numero. Un badge che sta
     * SOTTO al lavoro che il pannello offre è lo stesso difetto del badge gonfio,
     * girato: la prima volta portava dentro per niente, questa lascia fuori un
     * codice fiscale che si poteva scrivere in un gesto.
     *
     * Resta fermo ciò che il badge NON deve fare: sommare i tre stati. Con i
     * numeri dell'11 agosto `totale` vale ~83, di cui ~45 sono soltanto «mai
     * compilato», e un badge a 83 è la confusione fra «manca» e «sbagliato» che
     * questo file combatte sui colori, spostata sul numero.
     *
     * ⚠️ Si conta su `righe`, cioè su ciò che è ARRIVATO: quando la pagina è
     * parziale o la scansione è troncata il pannello lo dichiara (`cfParziale`,
     * `cfTroncato`), e il numero sulla pillola può solo essere per difetto.
     */
    azionabili: number;
    /**
     * Una RILETTURA è fallita, sopra un elenco che era già stato letto.
     *
     * È l'ultima faccia dello stesso difetto: se un `fase = 'errore'` arrivasse
     * mentre a schermo c'è già qualcosa, il pannello si smonterebbe lo stesso —
     * e chi ha appena scritto vedrebbe l'esito della propria scrittura sostituito
     * da un cartello d'errore, senza sapere se la scrittura è passata. Un
     * fallimento non si nasconde: si dice CON i dati sotto, vecchi di un attimo
     * ma veri, invece che AL POSTO loro.
     */
    riletturaFallita: boolean;
    errore: string | null;
    ricarica: () => void;
}

/**
 * Quante righe si chiedono in una volta.
 *
 * NON è un numero inventato: è il massimo che lo schema `zPaginazione` accetta
 * (`src/lib/validation/common.ts`, `.max(200)`), e chiederne di più farebbe
 * rispondere 400 invece di dare più righe. Con 83 persone in archivio all'11
 * agosto il tetto è latente; quando morderà, il pannello lo DICE (vedi
 * `cfParziale`), perché un elenco tagliato presentato come completo non produce
 * nessun errore — produce meno bambini in una lista.
 */
const RIGHE_PER_PAGINA = 200;

/**
 * `true` quando su questa riga il pannello mostra il comando di SCRITTURA.
 *
 * ⚠️ ESISTE PERCHÉ IL NUMERO E IL COMANDO NON POSSANO PIÙ DIVERGERE. Il pannello
 * decideva se mostrare «Applica» con un'espressione (`codice_proposto !== null &&
 * !proposta_combacia`) e la pillola contava con un'altra (`stato ===
 * 'incoerente'`): due regole per la stessa domanda, in due punti del file, ed è
 * bastato questo perché due persone vere — un alunno e un genitore, misurati in
 * produzione l'11 agosto — avessero il comando a schermo e non fossero contate.
 * Da qui in avanti la regola è una: chi conta e chi disegna chiamano QUESTA.
 *
 * NON dipende dallo stato: ci passa l'`incoerente` con la proposta (si sostituisce
 * un codice), il `da-compilare` con la proposta (si scrive dove non c'è niente —
 * i due record di cui sopra) e il `non-verificabile` la cui proposta NON combacia
 * (22 genitori su 50 hanno codice, comune scritto a mano e colonna Belfiore vuota:
 * quasi sempre la proposta conferma il codice, e allora `proposta_combacia` la
 * tiene fuori di qui). Chi ha una proposta IDENTICA al codice registrato non
 * scrive niente: il suo gesto è scegliere il comune dalla tendina, nella scheda.
 */
export function scrivibile(r: RigaCodiceFiscale): boolean {
    return r.codice_proposto !== null && !r.proposta_combacia;
}

/**
 * Quante righe chiedono un gesto adesso: il numero della pillola.
 *
 * Due famiglie, in unione — e l'unione è voluta, non una svista:
 *  · `incoerente` — c'è un codice e non torna. È un errore in archivio anche
 *    quando la proposta non c'è (il gesto, lì, è aprire la scheda): lasciarlo
 *    fuori vorrebbe dire un rosso a schermo che il badge non conta.
 *  · `scrivibile(r)` — il pannello offre di scrivere. Un `da-compilare` con la
 *    proposta pronta si chiude in un gesto: è il lavoro più veloce che ci sia, ed
 *    è esattamente ciò che il badge deve far trovare a chi apre la linguetta.
 *
 * Restano FUORI, e devono: `da-compilare` senza proposta (~45 righe in
 * produzione: «mai compilato» non è un errore) e `non-verificabile` la cui
 * proposta conferma il codice (la forma più comune sui dati veri).
 *
 * ⚠️ IL CASO DA GUARDARE PRIMA DI CAMBIARE QUESTA RIGA — perché il ramo
 * `scrivibile` NON guarda lo stato, ci entra anche il `non-verificabile` la cui
 * proposta DISCORDA: la riga in cui il sistema dichiara di non poter verificare è
 * anche quella su cui si offre di sovrascrivere in un gesto il codice fiscale
 * registrato di una persona, e da qui in avanti il badge ce la porta dentro. È
 * voluto — il gesto esiste per il comune soppresso, e prima della PATCH c'è la
 * conferma in due tempi con il riepilogo che nomina per esteso codice attuale e
 * codice proposto. Se un giorno la decisione cambia, il posto è QUI (escludere
 * `r.stato === 'non-verificabile'` dal ramo `scrivibile`) e il test che diventa
 * rosso è «la SESTA riga di prova», in
 * `__tests__/components/CodiciFiscaliDaVerificare.test.tsx`.
 */
export function contaAzionabili(righe: readonly RigaCodiceFiscale[]): number {
    return righe.filter((r) => r.stato === 'incoerente' || scrivibile(r)).length;
}

/** L'ordine di lavoro: priorità, poi cognome, nome, id. Stabile su ogni macchina. */
export function ordinaPerAzionabilita(righe: readonly RigaCodiceFiscale[]): RigaCodiceFiscale[] {
    return [...righe].sort((a, b) => {
        if (a.priorita !== b.priorita) return a.priorita - b.priorita;
        const cognomi = (a.cognome ?? '').localeCompare(b.cognome ?? '', 'it');
        if (cognomi !== 0) return cognomi;
        const nomi = (a.nome ?? '').localeCompare(b.nome ?? '', 'it');
        if (nomi !== 0) return nomi;
        return a.id.localeCompare(b.id);
    });
}

/** `true` quando la riga è forma valida di `RigaCodiceFiscale`. Un corpo inatteso è un GUASTO. */
function sembraUnaRiga(v: unknown): v is RigaCodiceFiscale {
    if (v === null || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return (
        typeof r.id === 'string' &&
        (r.tipo === 'alunno' || r.tipo === 'genitore') &&
        (r.stato === 'incoerente' || r.stato === 'non-verificabile' || r.stato === 'da-compilare')
    );
}

/**
 * L'ELENCO, una volta sola per pagina.
 *
 * Sta in un hook — e non dentro il pannello — perché il CONTEGGIO va sulla
 * linguetta, cioè va saputo anche prima che qualcuno apra la scheda: un pannello
 * che si carica solo quando lo guardi non può dire a nessuno che c'è da
 * guardarlo. Una fetch sola serve tutte e due le cose.
 *
 * ⚠️ NIENTE blocco `catch`, e il `try { … } finally { … }` RESTA: è la forma che
 * `react-hooks/set-state-in-effect` (qui è un ERRORE del gate) riconosce. Il ramo
 * d'errore vive su `.catch()` della promise e ritorna `null`; il motivo non si
 * perde, si logga. È lo stesso vincolo, misurato, di `caricaElenco` in
 * `/admin/students`.
 */
export function useCodiciFiscaliDaVerificare(): EsitoCodiciFiscali {
    const { reFetchKey } = useSediAttive();
    const [fase, setFase] = useState<'caricamento' | 'pronto' | 'errore'>('caricamento');
    const [righe, setRighe] = useState<RigaCodiceFiscale[]>([]);
    const [totale, setTotale] = useState(0);
    const [troncato, setTroncato] = useState(false);
    const [errore, setErrore] = useState<string | null>(null);
    const [ricaricando, setRicaricando] = useState(false);
    const [riletturaFallita, setRiletturaFallita] = useState(false);
    const [epoca, setEpoca] = useState(0);

    /**
     * «A schermo c'è già un elenco letto per intero». È un ref e non uno stato
     * perché lo legge `carica()`, che non deve rilanciarsi quando cambia: metterlo
     * fra le dipendenze della callback che l'effetto invoca è un ciclo di fetch.
     */
    const giaCaricato = useRef(false);

    /**
     * L'EPOCA DELLA RICHIESTA IN CORSO. Serve a che la risposta VECCHIA non vinca
     * su quella nuova: al cambio delle sedi attive (`reFetchKey` cambia, l'effetto
     * rilancia) o su «Riprova» premuto due volte ci sono due fetch in volo, e la
     * prima può atterrare per ultima. Senza guardia sovrascriverebbe l'elenco —
     * e siccome è la stessa fetch a riempire il CONTEGGIO sulla pillola, il numero
     * sbagliato resterebbe a schermo anche fuori da questa linguetta.
     * Ogni `set*` di questa funzione sta dietro a `mia === ultimaRichiesta.current`.
     */
    const ultimaRichiesta = useRef(0);

    /**
     * ⚠️ NIENTE `catch` e NIENTE `t` fra le dipendenze. `useTranslations`
     * restituisce una funzione NUOVA a ogni render: metterla nelle deps di una
     * callback che un effetto invoca è un ciclo di fetch infinito. Il testo
     * generico d'errore lo mette il pannello al momento del render (`errore` qui
     * resta `null` quando il server non ha detto niente di leggibile).
     */
    const carica = useCallback(async () => {
        const mia = ultimaRichiesta.current + 1;
        ultimaRichiesta.current = mia;
        let motivo = '';
        // Il default è `errore`, non `pronto`: qualunque strada esca da qui senza
        // aver letto un elenco è un GUASTO, e va detta. Un default ottimista
        // trasformerebbe un ramo dimenticato in «non c'è niente da verificare».
        let prossima: 'pronto' | 'errore' = 'errore';
        try {
            const res = await fetch(`/api/admin/anagrafiche/codici-fiscali?limit=${RIGHE_PER_PAGINA}`, {
                headers: { 'x-sedi': reFetchKey },
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            // Sorpassata da una richiesta più nuova: questa risposta non esiste più.
            if (mia !== ultimaRichiesta.current) return;

            if (res === null) {
                // La fetch non è mai arrivata: rete giù, DNS, CORS. È il caso che
                // nessun log del server vedrà mai.
                setErrore(null);
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `codici-fiscali-non-caricati: ${motivo}`,
                    route: '/admin/students',
                });
                return;
            }
            if (!res.ok) {
                const detto = await messaggioErrore(res, '');
                if (mia !== ultimaRichiesta.current) return;
                setErrore(detto);
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'codici-fiscali-non-caricati',
                    route: '/admin/students',
                    stato: res.status,
                });
                return;
            }
            const corpo: unknown = await res.json().catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (mia !== ultimaRichiesta.current) return;
            const dati = corpo as { righe?: unknown; totale?: unknown; troncato?: unknown } | null;
            if (!dati || !Array.isArray(dati.righe)) {
                // 200 con un corpo che non è un elenco: è un GUASTO, non «non c'è
                // nessuno». Trattarlo come elenco vuoto direbbe «tutto a posto».
                setErrore(null);
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `codici-fiscali-corpo-inatteso: ${motivo || 'forma'}`,
                    route: '/admin/students',
                    stato: res.status,
                });
                return;
            }
            const arrivate = dati.righe as unknown[];
            const valide = arrivate.filter(sembraUnaRiga);
            // ⚠️ RIGHE SCARTATE = GUASTO, non «una in meno».
            //
            // È lo STESSO errore del ramo qui sopra, spostato di un livello: lì
            // l'elenco non era un array, qui l'array c'è ma le sue righe non si
            // leggono. Un rename di `stato` o di `tipo` nella rotta basta a far
            // passare `sembraUnaRiga` a zero: senza questa guardia il pannello
            // conserverebbe `totale` dal server e mostrerebbe il cartello VERDE
            // «Nessun codice fiscale da verificare — è una buona notizia» con
            // accanto la fascia gialla «parziale». Una buona notizia FALSA su
            // dati di minori è peggio di un errore: nessuno ci torna sopra.
            // Vale anche per UNA sola riga persa: «meno bambini in una lista» non
            // produce nessun errore, produce meno bambini in una lista.
            if (valide.length < arrivate.length) {
                setErrore(null);
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    // I due numeri nel messaggio, non in campi propri: `EventoClient`
                    // ha uno schema chiuso, e sono conteggi (nessun dato personale).
                    messaggio: `codici-fiscali-righe-illeggibili: ${arrivate.length - valide.length} scartate su ${arrivate.length}`,
                    route: '/admin/students',
                    stato: res.status,
                });
                return;
            }
            setRighe(valide);
            setTotale(typeof dati.totale === 'number' ? dati.totale : valide.length);
            setTroncato(dati.troncato === true);
            setErrore(null);
            setRiletturaFallita(false);
            giaCaricato.current = true;
            prossima = 'pronto';
        } finally {
            // ⚠️ IL `try { … } finally { setFase(…) }` RESTA, ed è una forma
            // imposta — non uno stile. Spostare questa riga nel corpo lineare
            // (stesso codice, stessi rami) fa scattare
            // `react-hooks/set-state-in-effect`, che qui è un ERRORE del gate.
            // Misurato, non supposto: senza il `finally` `npx eslint` è rosso.
            if (mia === ultimaRichiesta.current) {
                // Un guasto SOPRA un elenco già letto non cancella l'elenco: si
                // dice in una fascia d'allarme e i dati restano. Vedi
                // `riletturaFallita`. Al primo caricamento, invece, non c'è niente
                // da conservare e la schermata d'errore è quella giusta.
                const sopraUnElenco = prossima === 'errore' && giaCaricato.current;
                setFase(sopraUnElenco ? 'pronto' : prossima);
                setRiletturaFallita(sopraUnElenco);
                setRicaricando(false);
            }
        }
    }, [reFetchKey]);

    useEffect(() => {
        void carica();
    }, [carica, epoca]);

    /**
     * RILEGGERE NON È RICOMINCIARE.
     *
     * Qui c'era `setFase('caricamento')` incondizionato, e costava questo: dopo
     * una scrittura andata a buon fine `applica()` chiama `ricarica()`, la fase
     * tornava a `caricamento`, e il primo `return` del pannello sostituiva TUTTO
     * con lo spinner a tutta pagina. Il messaggio «Codice fiscale aggiornato»
     * (`role="status"`) non faceva in tempo a essere letto, il drawer si chiudeva
     * da solo, il fuoco finiva su `<body>` — e chi lavora da tastiera o con uno
     * screen reader perdeva il posto senza sapere se la scrittura era passata.
     * Poi, al ritorno dell'elenco, `selezionata` era ancora valorizzata e il
     * drawer si RIAPRIVA su una copia stantia della riga appena corretta.
     *
     * Perciò: lo spinner a tutta pagina resta al PRIMO caricamento, quando non
     * c'è ancora niente a schermo da conservare. Se un elenco c'è già, la
     * rilettura non smonta niente e si annuncia con `ricaricando`.
     * ⚠️ `fase` resta `pronto` anche mentre la rilettura è in volo: è vero, i dati
     * a schermo sono quelli di un attimo fa e non una bugia.
     */
    const ricarica = useCallback(() => {
        setErrore(null);
        setRicaricando(true);
        setFase((f) => (f === 'pronto' ? f : 'caricamento'));
        setEpoca((e) => e + 1);
    }, []);

    // Il numero della pillola. La regola sta in `contaAzionabili`, che è la
    // STESSA cosa che decide se il comando di scrittura compare (`scrivibile`):
    // vedi `EsitoCodiciFiscali.azionabili` per il perché non sono più due.
    const azionabili = useMemo(() => contaAzionabili(righe), [righe]);

    return { fase, righe, totale, troncato, ricaricando, azionabili, riletturaFallita, errore, ricarica };
}

/* ── Aspetto dei tre stati: icona + parola + coppia di token misurata ───────── */

/**
 * ⚠️ ESPORTATA DI PROPOSITO, perché sia collaudabile come DATO.
 *
 * L'invariante di questa schermata — «manca» non deve diventare «sbagliato» —
 * viveva solo nelle parole: i test verificavano le tre etichette, e nessuno
 * teneva ferme le tre COPPIE DI TOKEN. Misurato dal revisore: mettendo qui
 * `bg-kidville-error-soft text-kidville-error-strong` su `da-compilare` — cioè
 * dipingendo di rosso i 45 record che nessuno ha mai compilato — la suite restava
 * verde su 35 test su 35. Adesso non più: vedi «i tre stati non si somigliano»
 * in `__tests__/components/CodiciFiscaliDaVerificare.test.tsx`.
 */
export const ASPETTO: Record<
    StatoCodiceFiscale,
    { icona: typeof AlertTriangle; classi: string; chiave: 'cfStatoIncoerente' | 'cfStatoNonVerificabile' | 'cfStatoDaCompilare' }
> = {
    // `error-strong` su `error-soft` = 4,92:1 (`__tests__/a11y/contrasto-token.test.ts`).
    incoerente: {
        icona: AlertTriangle,
        classi: 'bg-kidville-error-soft text-kidville-error-strong',
        chiave: 'cfStatoIncoerente',
    },
    // `warn-strong` su `warn-soft` = 4,95:1 (dichiarato in globals.css).
    'non-verificabile': {
        icona: HelpCircle,
        classi: 'bg-kidville-warn-soft text-kidville-warn-strong',
        chiave: 'cfStatoNonVerificabile',
    },
    // `sub` su `neutral-soft` = 5,75:1. Neutro: non è un errore.
    'da-compilare': {
        icona: CircleDashed,
        classi: 'bg-kidville-neutral-soft text-kidville-sub',
        chiave: 'cfStatoDaCompilare',
    },
};

/** Le chiavi di catalogo dei motivi d'incoerenza, per codice della route. */
const MOTIVO: Record<string, string> = {
    'cf-assente': 'cfMotivoCfAssente',
    'cf-lunghezza': 'cfMotivoCfLunghezza',
    'cf-forma': 'cfMotivoCfForma',
    'cf-giorno': 'cfMotivoCfGiorno',
    'cf-data-inesistente': 'cfMotivoCfDataInesistente',
    'cf-checksum': 'cfMotivoCfChecksum',
    cognome: 'cfMotivoCognome',
    nome: 'cfMotivoNome',
    'data-nascita': 'cfMotivoDataNascita',
    sesso: 'cfMotivoSesso',
    'luogo-nascita': 'cfMotivoLuogoNascita',
};

/** Le chiavi di catalogo dei campi che mancano per poter confrontare. */
const MANCANTE: Record<string, string> = {
    cognome: 'cfMancaCognome',
    nome: 'cfMancaNome',
    'data-nascita': 'cfMancaDataNascita',
    sesso: 'cfMancaSesso',
    'luogo-nascita': 'cfMancaLuogoNascita',
};

type FiltroStato = 'tutti' | StatoCodiceFiscale;
type FiltroTipo = 'tutti' | 'alunni' | 'genitori';

export interface CodiciFiscaliDaVerificareProps {
    esito: EsitoCodiciFiscali;
    /** Passa avanti l'identità nell'URL della scheda, come fa il resto del cockpit. */
    userId?: string | null;
}

export function CodiciFiscaliDaVerificare({ esito, userId }: CodiciFiscaliDaVerificareProps) {
    const t = useTranslations('adminStudents');
    const router = useRouter();
    const { sedi } = useSediAttive();
    const idBase = useId();

    const [filtroStato, setFiltroStato] = useState<FiltroStato>('tutti');
    const [filtroTipo, setFiltroTipo] = useState<FiltroTipo>('tutti');
    const [cerca, setCerca] = useState('');
    /**
     * CHI si sta guardando — l'IDENTITÀ, non i suoi dati.
     *
     * Di questa copia si usano `tipo`, `id` e il nominativo (il titolo del
     * drawer, che deve restare leggibile anche quando la riga esce dall'elenco).
     * Tutto il resto — stato, codice attuale, motivi, proposta — si rilegge da
     * `esito.righe`: vedi `sceltaAttiva`.
     */
    const [selezionata, setSelezionata] = useState<RigaCodiceFiscale | null>(null);

    // Lo stato della SCRITTURA vive accanto alla riga scelta, e si azzera con lei:
    // un riepilogo rimasto aperto da un'altra persona è il modo di scrivere il
    // codice giusto sul bambino sbagliato.
    const [conferma, setConferma] = useState(false);
    const [scrivendo, setScrivendo] = useState(false);
    const [scritto, setScritto] = useState(false);
    const [erroreScrittura, setErroreScrittura] = useState<string | null>(null);

    /**
     * LA GUARDIA DI RIENTRO DEL DOPPIO INVIO, e perché è un `ref` e non lo stato.
     *
     * `scrivendo` è stato di React: due click nello STESSO tick leggono tutti e
     * due `false` e partono tutte e due. Qui il prezzo di quel doppio invio è due
     * `PATCH` e due righe di audit sul codice fiscale di un bambino, su un
     * progetto dove — per decisione esplicita (CLAUDE.md, 2026-08-03) — nessun
     * essere umano vede la scrittura prima che parta. Il ref cambia valore
     * SUBITO, nello stesso giro di eventi, ed è l'unica cosa che regge lì.
     */
    const scrivendoRef = useRef(false);
    /** Dove torna il fuoco quando la scrittura è finita: vedi l'effetto più sotto. */
    const esitoScritturaRef = useRef<HTMLParagraphElement>(null);

    const scegli = useCallback((r: RigaCodiceFiscale) => {
        setSelezionata(r);
        setConferma(false);
        setScritto(false);
        setErroreScrittura(null);
    }, []);

    const chiudi = useCallback(() => {
        setSelezionata(null);
        setConferma(false);
        setScritto(false);
        setErroreScrittura(null);
    }, []);

    /**
     * LA RIGA SCELTA, RILETTA DALL'ELENCO CHE C'È ADESSO. `null` = non c'è più.
     *
     * ⚠️ È il difetto che questa schermata ha già pagato due volte, in altre due
     * forme: un valore vecchio presentato come vero. Prima della scrittura non si
     * vedeva; dopo sì — `applica()` chiama `ricarica()`, l'elenco torna senza
     * quella riga, e il drawer restava aperto sulla COPIA di prima: sotto la riga
     * verde «Codice fiscale aggiornato.» continuava a leggersi «Stato:
     * Incoerente», il vecchio codice attuale e «Perché non torna» — mentre la
     * riga era già sparita dalla tabella dietro. L'esito e il dettaglio si
     * contraddicevano nella stessa schermata.
     *
     * Perciò il dettaglio non ha una copia propria: guarda `esito.righe` a ogni
     * render. Se la riga non c'è più, il corpo del drawer lo DICE e resta l'esito
     * — che è l'unica cosa vera rimasta a schermo su quella persona.
     */
    const sceltaAttiva = useMemo(() => {
        if (selezionata === null) return null;
        return esito.righe.find((r) => r.tipo === selezionata.tipo && r.id === selezionata.id) ?? null;
    }, [esito.righe, selezionata]);

    const nomeSedi = useCallback(
        (ids: readonly string[]): string => {
            const nomi = ids
                .map((id) => sedi.find((s) => s.id === id)?.nome)
                .filter((n): n is string => typeof n === 'string' && n !== '');
            return nomi.length > 0 ? nomi.join(', ') : t('cfStrutturaSconosciuta');
        },
        [sedi, t],
    );

    const visibili = useMemo(() => {
        const testo = cerca.trim().toLowerCase();
        const filtrate = esito.righe.filter((r) => {
            if (filtroStato !== 'tutti' && r.stato !== filtroStato) return false;
            if (filtroTipo === 'alunni' && r.tipo !== 'alunno') return false;
            if (filtroTipo === 'genitori' && r.tipo !== 'genitore') return false;
            if (testo === '') return true;
            const campi = [r.cognome, r.nome, r.codice_attuale, r.codice_proposto];
            return campi.some((c) => typeof c === 'string' && c.toLowerCase().includes(testo));
        });
        return ordinaPerAzionabilita(filtrate);
    }, [esito.righe, filtroStato, filtroTipo, cerca]);

    const nominativo = (r: RigaCodiceFiscale) =>
        [r.cognome, r.nome].filter((v) => typeof v === 'string' && v !== '').join(' ') || t('cfSenzaNome');

    const apriScheda = useCallback(
        (r: RigaCodiceFiscale) => {
            const qs = new URLSearchParams({ kind: r.tipo === 'alunno' ? 'child' : 'adult' });
            if (userId) qs.set('userId', userId);
            router.push(`/admin/students/${r.id}?${qs.toString()}`);
        },
        [router, userId],
    );

    /**
     * SCRITTURA DI UN SOLO RECORD. Non esiste, e non deve esistere, la versione
     * che ne tocca più di uno: vedi il blocco in testa al file.
     */
    const applica = useCallback(async () => {
        // La riga RILETTA, non la copia di quando è stata scelta: se nel frattempo
        // l'elenco è cambiato sotto (rilettura, cambio di sedi), si scrive ciò che
        // il server dice adesso — o non si scrive affatto.
        const r = sceltaAttiva;
        if (r === null || !scrivibile(r)) return;
        // ⚠️ PRIMA di qualunque altra cosa: un secondo click mentre la PATCH è in
        // volo non deve produrre una seconda PATCH. Vedi `scrivendoRef`.
        if (scrivendoRef.current) return;
        scrivendoRef.current = true;
        setScrivendo(true);
        setErroreScrittura(null);
        let motivo = '';
        try {
            const url = r.tipo === 'alunno' ? '/api/admin/students' : '/api/admin/parents';
            const corpo =
                r.tipo === 'alunno'
                    ? { id: r.id, codice_fiscale: r.codice_proposto }
                    : { id: r.id, fiscal_code: r.codice_proposto };
            const res = await fetch(url, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(corpo),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });

            if (res === null) {
                setErroreScrittura(t('cfScritturaErrore'));
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `codice-fiscale-non-scritto: ${motivo}`,
                    route: '/admin/students',
                });
                return;
            }
            if (!res.ok) {
                setErroreScrittura(await messaggioErrore(res, t('cfScritturaErrore')));
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'codice-fiscale-non-scritto',
                    route: '/admin/students',
                    stato: res.status,
                });
                return;
            }
            setScritto(true);
            setConferma(false);
            // La rilettura NON smonta il pannello: `ricarica()` conserva l'elenco a
            // schermo quando ce n'è già uno (vedi il commento su `ricarica`). Il
            // drawer resta aperto sull'esito, e l'effetto qui sotto ci porta il fuoco.
            esito.ricarica();
        } finally {
            scrivendoRef.current = false;
            setScrivendo(false);
        }
    }, [sceltaAttiva, esito, t]);

    /**
     * IL FUOCO NON CADE SUL VUOTO.
     *
     * Appena la scrittura riesce, i due comandi «Conferma»/«Annulla» spariscono:
     * chi aveva premuto da tastiera si ritroverebbe con `document.activeElement`
     * su `<body>`, cioè all'inizio della pagina e senza sapere com'è andata. Il
     * fuoco va sull'esito, che è un `role="status"`: uno screen reader lo legge
     * comunque come regione live, e chi naviga da tastiera riparte da lì.
     */
    useEffect(() => {
        if (scritto) esitoScritturaRef.current?.focus();
    }, [scritto]);

    /* ── Caricamento ────────────────────────────────────────────────────────── */
    if (esito.fase === 'caricamento') {
        return (
            <div role="status" className="flex min-h-[40vh] flex-1 flex-col items-center justify-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
                <p className="font-maven text-kidville-sub">{t('cfCaricamento')}</p>
            </div>
        );
    }

    /* ── La fetch non è arrivata ────────────────────────────────────────────── */
    if (esito.fase === 'errore') {
        return (
            <div role="alert" className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <AlertTriangle size={34} strokeWidth={1.8} />
                </div>
                <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('cfErroreTitolo')}</h2>
                <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{esito.errore || t('cfErroreTesto')}</p>
                <button
                    type="button"
                    onClick={esito.ricarica}
                    className={btnClass('primary', 'sm', 'mt-4')}
                >
                    <RotateCcw size={15} strokeWidth={2} /> {t('cfRiprova')}
                </button>
            </div>
        );
    }

    const parziale = !esito.troncato && esito.totale > esito.righe.length;
    // La ripartizione dei tre stati, sulle righe ARRIVATE. Sta qui e non sulla
    // pillola della linguetta perché è qui che convive con la spiegazione dei tre
    // stati: la pillola porta il solo numero AZIONABILE (vedi `azionabili`).
    const perStato = {
        incoerenti: esito.righe.filter((r) => r.stato === 'incoerente').length,
        nonVerificabili: esito.righe.filter((r) => r.stato === 'non-verificabile').length,
        daCompilare: esito.righe.filter((r) => r.stato === 'da-compilare').length,
    };
    // Lo stesso predicato che conta la pillola (`contaAzionabili`): il comando e
    // il numero non possono più dire due cose diverse.
    const applicabile = sceltaAttiva !== null && scrivibile(sceltaAttiva);

    return (
        <div className="flex flex-col">
            <div className="mb-4 rounded-card bg-kidville-white p-4 shadow-sm">
                <SectionTitle icon={ShieldCheck} title={t('cfTitolo')} sub={t('cfSottotitolo')} />

                {/* LA RIPARTIZIONE, che è la cosa che la pillola della linguetta non
                    può dire: quanti sono davvero da correggere e quanti sono soltanto
                    da compilare. Senza, «83» è un numero che non aiuta a decidere. */}
                {esito.righe.length > 0 && (
                    <p className="mb-3 font-maven text-[13px] text-kidville-sub">
                        {t('cfRipartizione', perStato)}
                    </p>
                )}

                {/* La rilettura è FALLITA: i dati sotto restano, vecchi di un
                    attimo, e il guasto si dice forte. Non è la schermata d'errore
                    — quella sostituisce tutto, e ha senso solo quando sotto non
                    c'è niente da conservare. */}
                {esito.riletturaFallita && (
                    <div
                        role="alert"
                        className="mb-3 flex flex-wrap items-center gap-2 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong"
                    >
                        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
                        <span className="flex-1">{esito.errore || t('cfRiletturaFallita')}</span>
                        <button type="button" onClick={esito.ricarica} className={btnClass('ghost', 'sm')}>
                            <RotateCcw size={14} strokeWidth={2} /> {t('cfRiprova')}
                        </button>
                    </div>
                )}

                {/* La rilettura NON smonta l'elenco (vedi `ricarica`): si dice, e
                    basta. `aria-live="polite"` e non `role="status"`: gli avvisi
                    forti di questa schermata sono altri, e un aggiornamento in
                    corso non deve interromperli. */}
                {esito.ricaricando && (
                    <p
                        aria-live="polite"
                        className="mb-3 flex items-center gap-2 font-maven text-[13px] text-kidville-sub"
                    >
                        <RotateCcw size={14} className="animate-spin" aria-hidden="true" />
                        {t('cfRicaricando')}
                    </p>
                )}

                {/* Un elenco troncato presentato come completo è una bugia silenziosa:
                    il server lo dichiara, e qui si dice. */}
                {esito.troncato && (
                    <p
                        role="status"
                        className="mb-3 flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                    >
                        <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {t('cfTroncato')}
                    </p>
                )}
                {parziale && (
                    <p
                        role="status"
                        className="mb-3 flex items-start gap-2 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                    >
                        <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {t('cfParziale')}
                    </p>
                )}

                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                    <label className="relative w-full flex-1">
                        <span className="sr-only">{t('cfCercaEtichetta')}</span>
                        <Search
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub"
                            size={18}
                            aria-hidden="true"
                        />
                        <input
                            type="search"
                            value={cerca}
                            onChange={(e) => setCerca(e.target.value)}
                            placeholder={t('cfCerca')}
                            className="w-full rounded-input border-2 border-kidville-line py-2.5 pl-10 pr-4 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:outline-none focus:ring-2 focus:ring-kidville-green/15"
                        />
                    </label>

                    <label className="flex items-center gap-2">
                        <span className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                            {t('cfFiltroStato')}
                        </span>
                        <CockpitSelect
                            value={filtroStato}
                            onChange={(v) => setFiltroStato(v as FiltroStato)}
                            options={[
                                { value: 'tutti', label: t('cfStatoTutti') },
                                { value: 'incoerente', label: t('cfStatoIncoerente') },
                                { value: 'non-verificabile', label: t('cfStatoNonVerificabile') },
                                { value: 'da-compilare', label: t('cfStatoDaCompilare') },
                            ]}
                        />
                    </label>

                    <label className="flex items-center gap-2">
                        <span className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                            {t('cfFiltroTipo')}
                        </span>
                        <CockpitSelect
                            value={filtroTipo}
                            onChange={(v) => setFiltroTipo(v as FiltroTipo)}
                            options={[
                                { value: 'tutti', label: t('cfTipoTutti') },
                                { value: 'alunni', label: t('cfTipoAlunni') },
                                { value: 'genitori', label: t('cfTipoGenitori') },
                            ]}
                        />
                    </label>
                </div>
            </div>

            {/* ── Archivio pulito: è una BUONA notizia, e si scrive come tale ──── */}
            {esito.righe.length === 0 ? (
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-success-soft text-kidville-success-strong">
                        <CheckCircle2 size={34} strokeWidth={1.8} />
                    </div>
                    <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('cfVuotoTitolo')}</h3>
                    <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{t('cfVuotoTesto')}</p>
                </div>
            ) : visibili.length === 0 ? (
                /* I filtri non trovano niente ≠ non c'è niente da verificare. */
                <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h3 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('cfFiltriVuotoTitolo')}</h3>
                    <p className="font-maven mt-1 max-w-md text-sm text-kidville-sub">{t('cfFiltriVuotoTesto')}</p>
                </div>
            ) : (
                <div className="rounded-card bg-kidville-white p-4 shadow-sm">
                    <p aria-live="polite" className="mb-3 font-maven text-[13px] text-kidville-sub">
                        {t('cfConteggio', { n: visibili.length })}
                    </p>
                    <div className={TABLE_WRAP}>
                        <table className={TABLE}>
                            <caption className="sr-only">{t('cfTabellaDidascalia')}</caption>
                            <thead>
                                <tr>
                                    <th scope="col" className={TH}>{t('cfColPersona')}</th>
                                    <th scope="col" className={TH}>{t('cfColTipo')}</th>
                                    <th scope="col" className={TH}>{t('cfColStato')}</th>
                                    <th scope="col" className={TH}>{t('cfColCodice')}</th>
                                    <th scope="col" className={TH}>{t('cfColProposta')}</th>
                                    <th scope="col" className={TH}>{t('cfColComando')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibili.map((r) => {
                                    const aspetto = ASPETTO[r.stato];
                                    const Icona = aspetto.icona;
                                    return (
                                        <tr
                                            key={`${r.tipo}-${r.id}`}
                                            className={cx(TROW, 'cursor-pointer')}
                                            onClick={() => scegli(r)}
                                        >
                                            <td className={cx(TD, 'font-maven text-sm font-semibold text-kidville-ink')}>
                                                {nominativo(r)}
                                            </td>
                                            <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>
                                                {r.tipo === 'alunno' ? t('cfTipoAlunno') : t('cfTipoGenitore')}
                                            </td>
                                            <td className={TD}>
                                                {/* Icona E parola: il colore da solo non dice niente
                                                    a chi non lo distingue. */}
                                                <span
                                                    className={cx(
                                                        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-barlow text-[12px] font-extrabold uppercase tracking-[0.03em]',
                                                        aspetto.classi,
                                                    )}
                                                >
                                                    <Icona size={14} strokeWidth={2.2} aria-hidden="true" />
                                                    {t(aspetto.chiave)}
                                                </span>
                                            </td>
                                            <td className={cx(TD, 'font-maven text-sm tracking-[0.04em] text-kidville-ink')}>
                                                {r.codice_attuale ?? (
                                                    <span className="text-kidville-sub">{t('cfSenzaCodice')}</span>
                                                )}
                                            </td>
                                            <td className={cx(TD, 'font-maven text-sm tracking-[0.04em]')}>
                                                {r.codice_proposto === null ? (
                                                    <span className="text-kidville-sub">{t('cfSenzaProposta')}</span>
                                                ) : (
                                                    <span className="text-kidville-ink">
                                                        {r.codice_proposto}
                                                        {r.proposta_combacia && (
                                                            <span className="ml-2 font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">
                                                                {t('cfPropostaCombacia')}
                                                            </span>
                                                        )}
                                                    </span>
                                                )}
                                            </td>
                                            <td className={TD}>
                                                {/* Il click sulla riga è la comodità del mouse; QUESTO
                                                    è il comando vero, ed è un tab stop (lock
                                                    `righe-tabella-con-comando`). */}
                                                <button
                                                    type="button"
                                                    // `stopPropagation`: senza, il click
                                                    // risale alla riga e `scegli(r)` parte
                                                    // due volte. Oggi è innocuo (il comando
                                                    // è uno e idempotente); il giorno in cui
                                                    // la riga porta un secondo comando,
                                                    // quello aprirebbe anche il dettaglio.
                                                    // ⚠️ In questo commento non entra nessuna
                                                    // parentesi angolare: il lock
                                                    // `righe-tabella-con-comando` legge il
                                                    // SORGENTE, e risalendo da qui prende la
                                                    // prima che trova per il tag di questo
                                                    // comando — smettendo di vederlo.
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        scegli(r);
                                                    }}
                                                    className={btnClass('ghost', 'sm')}
                                                >
                                                    {t('cfApri')}
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ── Il dettaglio, e l'unico posto da cui si scrive ──────────────── */}
            <Drawer
                // Il drawer sta aperto finché è aperto: lo chiude chi lo chiude,
                // non una rilettura che porta via la riga da sotto (era il modo di
                // far sparire l'esito della scrittura appena fatta).
                open={selezionata !== null}
                onClose={chiudi}
                title={t('cfDettaglioTitolo')}
                subtitle={selezionata ? nominativo(selezionata) : undefined}
                width={520}
                footer={
                    selezionata ? (
                        <div className="flex flex-col gap-3">
                            {/* IL RIEPILOGO PRECEDE LA SCRITTURA, sempre. */}
                            {conferma && sceltaAttiva !== null && (
                                <p
                                    id={`${idBase}-riepilogo`}
                                    role="status"
                                    className="rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong"
                                >
                                    {sceltaAttiva.codice_attuale === null
                                        ? t('cfRiepilogoNuovo', {
                                            proposto: sceltaAttiva.codice_proposto ?? '',
                                            tipo:
                                                sceltaAttiva.tipo === 'alunno'
                                                    ? t('cfTipoAlunno')
                                                    : t('cfTipoGenitore'),
                                            struttura: nomeSedi(sceltaAttiva.scuole_ids),
                                        })
                                        : t('cfRiepilogoSostituzione', {
                                            proposto: sceltaAttiva.codice_proposto ?? '',
                                            attuale: sceltaAttiva.codice_attuale,
                                            tipo:
                                                sceltaAttiva.tipo === 'alunno'
                                                    ? t('cfTipoAlunno')
                                                    : t('cfTipoGenitore'),
                                            struttura: nomeSedi(sceltaAttiva.scuole_ids),
                                        })}
                                </p>
                            )}
                            {erroreScrittura !== null && (
                                <p
                                    role="alert"
                                    className="rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong"
                                >
                                    {erroreScrittura}
                                </p>
                            )}
                            {scritto && (
                                <p
                                    ref={esitoScritturaRef}
                                    role="status"
                                    // `tabIndex={-1}`: non entra nella tabulazione, ma
                                    // può RICEVERE il fuoco. È il punto stabile su cui
                                    // atterrare quando i comandi di scrittura spariscono.
                                    tabIndex={-1}
                                    className="rounded-input bg-kidville-success-soft px-3 py-2.5 font-maven text-[13px] text-kidville-success-strong outline-none focus-visible:ring-2 focus-visible:ring-kidville-green"
                                >
                                    {t('cfScritturaOk')}
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {/* Passa da `selezionata`: la scheda della persona
                                    esiste anche quando la riga è uscita
                                    dall'elenco da verificare — anzi, è proprio lì
                                    che si va a guardare com'è finita. */}
                                <button
                                    type="button"
                                    onClick={() => apriScheda(selezionata)}
                                    className={btnClass('ghost', 'sm')}
                                >
                                    {t('cfAzioneApriScheda')}
                                </button>
                                {applicabile && !scritto && !conferma && (
                                    <button
                                        type="button"
                                        onClick={() => setConferma(true)}
                                        className={btnClass('primary', 'sm')}
                                    >
                                        {t('cfAzioneApplica')}
                                    </button>
                                )}
                                {applicabile && !scritto && conferma && (
                                    <>
                                        {/* ⚠️ `aria-disabled`, NON `disabled`, ed è la
                                            regola di casa scritta in `Btn.tsx:27-32`:
                                            «`disabled` non è il modo di dire "sto
                                            lavorando"» — marcarlo spegne il fuoco, che
                                            in Chrome torna su `<body>`, e sbiadisce
                                            l'unico segnale che il gesto sia partito.
                                            Il doppio invio lo ferma la GUARDIA dentro
                                            `applica()` (`scrivendoRef`), che è
                                            sincrona e regge anche il doppio click
                                            nello stesso tick — cosa che `disabled`,
                                            passando per lo stato di React, non fa. */}
                                        <button
                                            type="button"
                                            onClick={() => void applica()}
                                            aria-disabled={scrivendo}
                                            aria-describedby={`${idBase}-riepilogo`}
                                            className={btnClass('primary', 'sm')}
                                        >
                                            {scrivendo ? t('cfScrittura') : t('cfAzioneConferma')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setConferma(false)}
                                            className={btnClass('ghost', 'sm')}
                                        >
                                            {t('cfAzioneAnnulla')}
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    ) : undefined
                }
            >
                {/* LA RIGA NON C'È PIÙ nell'elenco (di solito: la scrittura appena
                    fatta l'ha chiusa). Il posto del dettaglio non lo prende la sua
                    copia di un minuto fa — lo prende una frase che dice com'è
                    andata. L'esito della scrittura resta nel piede, dov'è sempre
                    stato, e il fuoco è già lì sopra. */}
                {selezionata !== null && sceltaAttiva === null && (
                    <p className="font-maven text-sm text-kidville-sub">{t('cfRigaNonPiuInElenco')}</p>
                )}
                {sceltaAttiva && (
                    <dl className="flex flex-col gap-4">
                        <div>
                            <dt className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                                {t('cfColTipo')}
                            </dt>
                            <dd className="font-maven text-sm text-kidville-ink">
                                {sceltaAttiva.tipo === 'alunno' ? t('cfTipoAlunno') : t('cfTipoGenitore')}
                                {' · '}
                                {nomeSedi(sceltaAttiva.scuole_ids)}
                            </dd>
                        </div>
                        <div>
                            <dt className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                                {t('cfColStato')}
                            </dt>
                            <dd className="font-maven text-sm text-kidville-ink">
                                {t(ASPETTO[sceltaAttiva.stato].chiave)}
                                {' — '}
                                {t(
                                    sceltaAttiva.stato === 'incoerente'
                                        ? 'cfStatoIncoerenteAiuto'
                                        : sceltaAttiva.stato === 'non-verificabile'
                                            ? 'cfStatoNonVerificabileAiuto'
                                            : 'cfStatoDaCompilareAiuto',
                                )}
                            </dd>
                        </div>
                        <div>
                            <dt className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                                {t('cfDettaglioCodiceAttuale')}
                            </dt>
                            <dd className="font-maven text-sm tracking-[0.05em] text-kidville-ink">
                                {sceltaAttiva.codice_attuale ?? t('cfSenzaCodice')}
                            </dd>
                        </div>
                        {sceltaAttiva.motivi.length > 0 && (
                            <div>
                                <dt className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                                    {t('cfDettaglioMotivi')}
                                </dt>
                                <dd>
                                    <ul className="list-disc pl-5 font-maven text-sm text-kidville-ink">
                                        {sceltaAttiva.motivi.map((m) => (
                                            <li key={m}>{MOTIVO[m] ? t(MOTIVO[m]) : m}</li>
                                        ))}
                                    </ul>
                                </dd>
                            </div>
                        )}
                        {sceltaAttiva.non_verificabili.length > 0 && (
                            <div>
                                <dt className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                                    {t('cfDettaglioMancanti')}
                                </dt>
                                <dd>
                                    <ul className="list-disc pl-5 font-maven text-sm text-kidville-ink">
                                        {sceltaAttiva.non_verificabili.map((c) => (
                                            <li key={c}>{MANCANTE[c] ? t(MANCANTE[c]) : c}</li>
                                        ))}
                                    </ul>
                                </dd>
                            </div>
                        )}
                        <div>
                            <dt className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                                {t('cfDettaglioProposta')}
                            </dt>
                            <dd className="font-maven text-sm tracking-[0.05em] text-kidville-ink">
                                {sceltaAttiva.codice_proposto ?? t('cfSenzaProposta')}
                            </dd>
                            {sceltaAttiva.codice_proposto !== null && sceltaAttiva.proposta_combacia && (
                                <p className="mt-1 font-maven text-[13px] text-kidville-sub">
                                    {t('cfDettaglioCombacia')}
                                </p>
                            )}
                            {sceltaAttiva.codice_proposto === null && (
                                <p className="mt-1 font-maven text-[13px] text-kidville-sub">
                                    {t(
                                        sceltaAttiva.proposta_bloccata_da === 'luogo'
                                            ? 'cfDettaglioBloccoLuogo'
                                            : 'cfDettaglioBloccoAnagrafica',
                                    )}
                                </p>
                            )}
                        </div>
                    </dl>
                )}
            </Drawer>
        </div>
    );
}
