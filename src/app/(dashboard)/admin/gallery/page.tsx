'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Images, RotateCcw } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { StatoElenco, type TestiStatoElenco } from '@/components/ui/StatoElenco';
import type { FiltroAttivo, StatoElencoTipo } from '@/lib/ui/filtri/tipi';
import { useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { HEADER_TOTALE, LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { STATO_ISCRITTO } from '@/lib/alunni/stato';
import {
    GalleriaSedeGiornate,
    contaTagSenzaNome,
    type FotoSede,
} from '@/components/features/gallery/GalleriaSedeGiornate';

/* ════════════════════════════════════════════════════════════════════════════
 * LA GALLERIA DI UN PLESSO INTERO — la schermata della segreteria.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Fino a oggi le foto si guardavano solo da `/teacher/gallery`, che è la vista di
 * UNA SEZIONE: nessun filtro per giorno, nessun filtro per bambino, e per vedere
 * il plesso intero bisognava aprire una classe alla volta. La segreteria, che una
 * famiglia la chiama al telefono («ci sono foto di mio figlio della gita?»), non
 * aveva una schermata da cui rispondere.
 *
 * Il lato server esiste già: `GET /api/gallery?scope=sede&scuolaId=<uuid>`, gate
 * `requireStaff`, sede DICHIARATA. Qui c'è solo l'interfaccia, e ADERISCE a quel
 * contratto — non a uno immaginato:
 *   · risposta `{ media, total, limit, offset }`, media dal più recente;
 *   · ogni foto porta `file_url` FIRMATO a tempo, `uploader_name` e
 *     `alunni_taggati` (i bambini della sede, con la loro classe) — che però
 *     **non è in corrispondenza 1:1 con `tag_students`**: un tag fuori sede non
 *     torna indietro, e se l'anagrafica non è leggibile l'elenco esce vuoto del
 *     tutto. `[]` vuol dire «non ho i nomi», mai «non c'è nessun bambino»: chi
 *     mostra i taggati parte da `tag_students` (vedi `GalleriaSedeGiornate`);
 *   · `classe` filtra per NOME di sezione, `studentId` per bambino, `date` per
 *     giornata, `limit`/`offset` paginano (default 30, tetto 100);
 *   · 403 `SEDE_NON_ACCESSIBILE` se la sede non è di chi chiede, 400 se la sede
 *     non è dichiarata (o se `scuolaId` viaggia senza `scope=sede`).
 *
 * ─── LA SEDE SI DICHIARA, NON SI INDOVINA ───────────────────────────────────
 * Con tre plessi in produzione una schermata che «sceglie da sola» mostra il
 * plesso sbagliato in silenzio — ed è la regola del progetto (AGENTS.md: ogni
 * scrittura, e ogni lettura di plesso, dichiara la sua sede). Qui: un plesso solo
 * ⇒ si usa quello senza chiedere; più d'uno ⇒ la tendina resta VUOTA finché
 * qualcuno sceglie, e fino ad allora **non parte nessuna richiesta**.
 *
 * ⚠️ Le sedi offerte sono `effettive`, cioè quelle che il SedeSelector del
 * cockpit sta guardando adesso — non tutte quelle accessibili. Non è una
 * restrizione di comodo: gli elenchi che riempiono le altre due tendine
 * (`/api/admin/sections` e `/api/admin/students`) sono a loro volta ristretti da
 * `resolveScuoleAttive`, cioè dallo stesso cookie. Offrire qui una sede che il
 * SedeSelector esclude darebbe una galleria piena e due filtri VUOTI, senza
 * nessun errore da nessuna parte: il modo esatto in cui in questo repo un elenco
 * ha già mentito. Per guardare un altro plesso si cambia sede in alto, che è il
 * posto in cui il cockpit intero cambia scope.
 *
 * ─── I FILTRI SONO DEL SERVER, TUTTI E TRE ──────────────────────────────────
 * Classe, bambino e giorno viaggiano nella query. Filtrarli a schermo
 * setaccerebbe la PAGINA CORRENTE — trenta foto su seicento — e chiamerebbe
 * «tutte» il risultato: è il difetto che `filtri-server-non-mentono` esiste per
 * impedire, e su una galleria che cresce ogni giorno si presenterebbe subito.
 *
 * ⚠️ LA CLASSE SI RISALE DAI TAG, e la rotta lo fa già: `?classe=<nome>` risolve
 * il nome in sezioni della sede, le sezioni in alunni e gli alunni nei
 * `tag_students` delle foto. Non esiste nessuna colonna «classe» sulla foto:
 * `target_classes` esiste ma è dei soli broadcast, e in produzione le 301 foto
 * misurate hanno tutte dei tag e nessuna un `target_classes`.
 * ════════════════════════════════════════════════════════════════════════════ */

/** La rotta della PAGINA: il luogo dell'incidente per ogni log di questo file. */
const ROTTA_LOG = '/admin/gallery';

/**
 * Foto per pagina. È il default della rotta (che clampa 1..100) ed è scritto qui
 * perché la paginazione va calcolata anche PRIMA della prima risposta.
 * La risposta rimanda comunque `limit`: se un giorno il clamp del server cambiasse,
 * a comandare le pagine resta il numero che il server dichiara, non questo.
 */
const FOTO_PER_PAGINA = 30;

/**
 * Una sezione della sede: **l'uuid è l'identità, il nome è solo ciò che si legge**.
 *
 * ⚠️ La tendina delle classi porta l'uuid nel `value` e il nome nell'etichetta, e
 * NON il contrario. Il motivo sta per esteso in `src/lib/sezioni/risoluzione.ts`
 * («L'IDENTITÀ DI UNA CLASSE È IL SUO UUID, MAI IL SUO NOME») e in questo file
 * conta per una ragione precisa: il filtro dei bambini deve restringersi con lo
 * STESSO criterio con cui la rotta filtra le foto, cioè `section_id`.
 */
interface VoceSezione {
    id: string;
    nome: string;
}

/** Un bambino della sede, ridotto a ciò che serve a una tendina. */
interface VoceBambino {
    id: string;
    etichetta: string;
    /**
     * `alunni.section_id` — l'uuid della sezione, ed è **con questo** che la
     * tendina si restringe. Vuoto quando il bambino non è agganciato a nessuna
     * sezione: in quel caso il SERVER non lo troverebbe comunque filtrando per
     * classe (`.in('section_id', …)`), e non offrirlo è l'unico modo di non
     * promettere un filtro che darebbe zero foto.
     */
    sectionId: string;
    /**
     * `alunni.classe_sezione` — il TESTO, e serve **solo** a scriverlo accanto al
     * nome in tendina. Mai a decidere chi appartiene a una classe: il trigger
     * `sync_alunno_section_id` va solo testo → uuid, quindi il testo può divergere
     * dal nome della sezione mentre `section_id` resta giusto. Vederlo scritto
     * accanto al bambino è anzi utile a chi opera: la divergenza si nota.
     */
    classe: string;
}

/** La riga grezza di `GET /api/admin/students`, di cui qui si legge il minimo. */
interface RigaAlunno {
    id?: unknown;
    nome?: unknown;
    cognome?: unknown;
    classe_sezione?: unknown;
    section_id?: unknown;
}

const testo = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Le CLASSI della sede, per la tendina — **con il loro uuid**.
 *
 * Dall'anagrafica delle sezioni e non dalle foto già caricate: una classe che in
 * questa pagina di risultati non compare esiste lo stesso, e non offrirla
 * significherebbe rispondere «non ci sono foto» a chi non ha nemmeno potuto
 * chiederle.
 *
 * ⚠️ SI TIENE L'UUID, non il solo nome, e non è un dettaglio di comodo. Al server
 * si manda `?classe=<nome>` (è ciò che la rotta accetta) ma la rotta quel nome lo
 * RISOLVE in `sections.id` e filtra le foto per `section_id`. Se questa pagina
 * restringesse la tendina dei bambini confrontando testo con testo
 * (`alunni.classe_sezione === sections.name`), il giorno in cui i due valori
 * divergono — una sezione rinominata da `PATCH /api/admin/sections` o da una
 * migrazione, cosa già fatta ad Aversa il 31/08 e a Cesa il 20/08 — la griglia
 * mostrerebbe le foto della classe e la tendina «Bambino» resterebbe VUOTA, senza
 * un errore e senza una riga di log. È il difetto misurato in produzione il
 * 2026-09-02 (17 bambini mostrati 0, 14 mostrati 1) e il modulo che esiste per
 * vietarlo è `src/lib/sezioni/risoluzione.ts`.
 *
 * Fuori dal componente perché non tocca nessuno stato: legge, logga i suoi guasti
 * e RESTITUISCE. Chi la chiama decide se il risultato è ancora attuale.
 */
async function leggiSezioniDellaSede(sedeId: string): Promise<VoceSezione[]> {
    const res = await fetch(`/api/admin/sections?scuola_id=${encodeURIComponent(sedeId)}`).catch((e: unknown) => {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `galleria-sede-classi-non-lette: ${nomeErrore(e)}`,
            route: ROTTA_LOG,
        });
        return null;
    });
    if (!res) return [];
    if (!res.ok) {
        // Un `!res.ok` NON lancia: senza questo ramo una tendina vuota per un 403
        // sarebbe indistinguibile da «questa sede non ha sezioni».
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'galleria-sede-classi-non-lette',
            route: ROTTA_LOG,
            stato: res.status,
        });
        return [];
    }
    const corpo: unknown = await res.json().catch(() => null);
    if (!Array.isArray(corpo)) {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'galleria-sede-classi-corpo-inatteso',
            route: ROTTA_LOG,
        });
        return [];
    }
    return (corpo as { id?: unknown; name?: unknown }[])
        .map((s) => ({ id: testo(s.id), nome: testo(s.name) }))
        // Una sezione senza uuid non è filtrabile: offrirla darebbe una tendina
        // dei bambini vuota e una griglia piena, che è il difetto di partenza.
        .filter((s) => s.id !== '' && s.nome !== '')
        .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

/**
 * I BAMBINI della sede, per la tendina.
 *
 * `?scuola_id=` filtra in AND con lo scope della rotta, quindi l'elenco è del
 * plesso dichiarato e di nessun altro. Di ogni riga si tengono solo id, cognome,
 * nome, `section_id` e il testo della classe: tutto il resto — codice fiscale
 * compreso — viene scartato appena letto e non entra in nessuno stato di React.
 *
 * ⚠️ Il troncamento si DICHIARA. `X-Total-Count` è l'unico modo che ha un
 * chiamante di accorgersi che l'elenco è stato tagliato al tetto: senza questo
 * controllo un plesso con più bambini del tetto avrebbe una tendina incompleta e
 * nessuno lo saprebbe — cioè un filtro che non può trovare un bambino che esiste.
 *
 * ⚠️ `stato=iscritto`, ED È UNA SCELTA MISURATA, non il default di comodo. Senza,
 * la risposta è la sede INTERA, archiviati compresi (lock
 * `elenchi-operativi-solo-iscritti`). Con, restano fuori due categorie, e sul
 * database di produzione oggi sono entrambe VUOTE:
 *   · i `sospeso` — bambini che frequentano, quindi fotografati: **0 righe**;
 *   · i `ritirato` che compaiono in una foto: **0 foto su 301** taggano un
 *     bambino non più iscritto (misurato il 2026-09-06; l'anagrafica è 631
 *     iscritti e 7 ritirati).
 * Il giorno in cui uno di quei due numeri non sarà più zero questa riga diventa
 * un filtro che non trova un bambino che esiste. La via d'uscita è dichiarata:
 * togliere `stato`, iscrivere questo file in `CHIAMANTI_SENZA_STATO` con la sua
 * ragione, e filtrare qui con `eAncoraIscritto` (`@/lib/alunni/stato`) — la
 * stessa strada già percorsa dal banco dei prestampati. Nel frattempo le foto di
 * un bambino uscito restano raggiungibili per classe e per giornata.
 */
async function leggiBambiniDellaSede(sedeId: string): Promise<VoceBambino[]> {
    const qs = new URLSearchParams({ scuola_id: sedeId, limit: String(LIMITE_ELENCO_ALUNNI) });
    // `stato=` sta per esteso NELL'INDIRIZZO e non dentro `qs`: il lock
    // `elenchi-operativi-solo-iscritti` legge il SORGENTE della riga, non la query
    // costruita a runtime. Una regola che non riesce a leggere il proprio oggetto
    // non è una regola — e nasconderle un parametro dentro un `URLSearchParams`
    // sarebbe passare il gate senza rispettarlo.
    const res = await fetch(`/api/admin/students?stato=${STATO_ISCRITTO}&${qs.toString()}`).catch((e: unknown) => {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `galleria-sede-bambini-non-letti: ${nomeErrore(e)}`,
            route: ROTTA_LOG,
        });
        return null;
    });
    if (!res) return [];
    if (!res.ok) {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'galleria-sede-bambini-non-letti',
            route: ROTTA_LOG,
            stato: res.status,
        });
        return [];
    }
    const dichiarato = Number(res.headers.get(HEADER_TOTALE) ?? '');
    const corpo: unknown = await res.json().catch(() => null);
    if (!Array.isArray(corpo)) {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'galleria-sede-bambini-corpo-inatteso',
            route: ROTTA_LOG,
        });
        return [];
    }
    if (Number.isFinite(dichiarato) && dichiarato > corpo.length) {
        // Solo CONTEGGI: nessun id, nessun nome. Sono minori.
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `galleria-sede-elenco-bambini-troncato:${corpo.length}/${dichiarato}`,
            route: ROTTA_LOG,
        });
    }
    return (corpo as RigaAlunno[])
        .map((r) => ({
            id: testo(r.id),
            etichetta: `${testo(r.cognome)} ${testo(r.nome)}`.trim(),
            // L'uuid della sezione decide, il testo si limita a farsi leggere.
            sectionId: testo(r.section_id),
            classe: testo(r.classe_sezione),
        }))
        .filter((v) => v.id !== '' && v.etichetta !== '')
        .sort((a, b) => a.etichetta.localeCompare(b.etichetta, 'it'));
}

export default function AdminGalleryPage() {
    const t = useTranslations('adminAltro');
    const { sedi, effettive, sedeCorrente, errore: sediErrore, loading: sediLoading, ricarica: ricaricaSedi } =
        useSediAttive();

    // ─── La sede: dichiarata, mai dedotta ────────────────────────────────────
    const [sedeScelta, setSedeScelta] = useState<string | null>(null);
    /**
     * Le sedi fra cui scegliere: `effettive` (∩ accessibili) con il loro nome.
     * `sedi` porta i nomi, `effettive` porta lo scope: servono tutte e due.
     */
    const opzioniSede = useMemo(
        () => sedi.filter((s) => effettive.includes(s.id)),
        [sedi, effettive],
    );
    /**
     * `sedeCorrente` è non-nullo SOLO quando lo scope è già un plesso solo: in
     * quel caso non c'è niente da scegliere, ed è la sede che tutto il cockpit
     * sta guardando. Con più plessi resta `null` finché l'utente non sceglie —
     * cioè non si indovina.
     */
    const sede = sedeScelta ?? sedeCorrente;

    // ─── I filtri ────────────────────────────────────────────────────────────
    /**
     * LA CLASSE HA DUE FACCE, e tenerle separate è il punto.
     *  · `classeId` è l'IDENTITÀ (`sections.id`): con questo si restringe la
     *    tendina dei bambini, perché è con `section_id` che il server sceglie le
     *    foto. Confrontare il testo `alunni.classe_sezione` col nome della sezione
     *    è l'identità-per-nome che questo repo ha già pagato (`risoluzione.ts`).
     *  · `classeNome` è ciò che si SCRIVE nella query (`?classe=<nome>`, l'unica
     *    forma che la rotta accetta) e nel chip del filtro attivo.
     * Si scrivono sempre insieme, e derivano dalla stessa voce di `sezioni`.
     */
    const [classeId, setClasseId] = useState('');
    const [classeNome, setClasseNome] = useState('');
    const [bambinoId, setBambinoId] = useState('');
    const [giorno, setGiorno] = useState('');
    const [offset, setOffset] = useState(0);

    // ─── Le tendine ──────────────────────────────────────────────────────────
    const [sezioni, setSezioni] = useState<VoceSezione[]>([]);
    const [bambini, setBambini] = useState<VoceBambino[]>([]);
    /**
     * Le tendine stanno ancora arrivando.
     *
     * Serve a schermo, non al codice: una tendina vuota mentre l'elenco è in volo
     * si legge «in questo plesso non ci sono classi», che è l'unica cosa che in
     * quel momento non si sa. Finché è vero i due filtri restano spenti.
     */
    const [tendineInCorso, setTendineInCorso] = useState(true);

    // ─── L'elenco ────────────────────────────────────────────────────────────
    const [foto, setFoto] = useState<FotoSede[]>([]);
    const [totale, setTotale] = useState(0);
    const [perPagina, setPerPagina] = useState(FOTO_PER_PAGINA);
    const [caricamento, setCaricamento] = useState(true);
    /**
     * `null` = nessun errore. `''` = guasto senza un messaggio leggibile (rete
     * giù, corpo illeggibile) → si mostra il testo generico. Una stringa = il
     * motivo detto dal SERVER, già tradotto da `messaggioErrore`.
     *
     * «Non ho potuto leggere» non è «non ci sono foto»: sono due schermate
     * diverse, e confonderle è il difetto più costoso di questo repo.
     */
    const [erroreFoto, setErroreFoto] = useState<string | null>(null);
    /** Numero d'ordine dell'ultima richiesta partita: vedi l'anti-sorpasso sotto. */
    const giroFoto = useRef(0);

    /**
     * L'ELENCO DELLE FOTO — e distingue i tre esiti.
     *
     * ⚠️ NIENTE blocco `catch`, e il `try { … } finally { … }` RESTA: è la forma
     * che `react-hooks/set-state-in-effect` (severità ERRORE nel gate di questo
     * repo) accetta. Il ramo d'errore vive sul `.catch()` della promise, che
     * restituisce `null` e lascia la gestione nel flusso lineare — dove il motivo
     * si può loggare invece di sparire.
     */
    const caricaFoto = useCallback(async () => {
        if (!sede) return;
        // ⚠️ ANTI-SORPASSO. Due cambi di filtro in rapida successione lasciano due
        // richieste in volo, e nulla garantisce che rispondano nell'ordine in cui
        // sono partite: senza questo numero d'ordine la risposta VECCHIA può
        // atterrare dopo la nuova e rimettere a schermo le foto del filtro
        // precedente — con i filtri aggiornati sopra, e nessun errore da nessuna
        // parte. Un `ref` e non uno `state`: non deve ridisegnare niente.
        const mio = giroFoto.current + 1;
        giroFoto.current = mio;
        let motivo = '';
        /**
         * Vero quando questa risposta non CHIUDE il giro ma ne apre un altro:
         * l'`offset` è finito oltre la fine dell'elenco e si ricomincia da capo
         * (vedi sotto). Lo spinner allora NON si spegne — spegnerlo mostrerebbe
         * come «finito» un elenco vuoto che sta già ricaricando, e per un istante
         * si leggerebbe «in questo plesso non c'è ancora nessuna foto» mentre le
         * foto ci sono.
         */
        let riparto = false;
        try {
            const qs = new URLSearchParams({
                // `scope` e `scuolaId` viaggiano INSIEME o la rotta risponde 400:
                // è la porta della vista di plesso, e nessuno dei due si omette.
                scope: 'sede',
                scuolaId: sede,
                limit: String(FOTO_PER_PAGINA),
                offset: String(offset),
            });
            // Al server va il NOME: è ciò che `?classe=` accetta, e la rotta lo
            // risolve lei in `sections.id`. L'uuid resta qui, per le tendine.
            if (classeNome) qs.set('classe', classeNome);
            if (bambinoId) qs.set('studentId', bambinoId);
            if (giorno) qs.set('date', giorno);

            const res = await fetch(`/api/gallery?${qs.toString()}`).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });

            if (mio !== giroFoto.current) return;
            if (res === null) {
                // La richiesta non è mai arrivata: rete giù, DNS, CORS. È il caso
                // che nessun log del server vedrà mai.
                setFoto([]);
                setTotale(0);
                setErroreFoto('');
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `galleria-sede-non-letta: ${motivo}`,
                    route: ROTTA_LOG,
                });
                return;
            }
            if (!res.ok) {
                setFoto([]);
                setTotale(0);
                // `messaggioErrore` traduce il `codice` (403 SEDE_NON_ACCESSIBILE,
                // 400 di validazione…): la prosa del server nasce italiana dentro
                // una route, e con l'interfaccia in inglese si leggerebbe così.
                setErroreFoto(await messaggioErrore(res, ''));
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'galleria-sede-non-letta',
                    route: ROTTA_LOG,
                    stato: res.status,
                });
                return;
            }
            const corpo = (await res.json().catch(() => null)) as
                | { media?: unknown; total?: unknown; limit?: unknown }
                | null;
            if (!corpo || !Array.isArray(corpo.media)) {
                // 200 con un corpo che non è la lista attesa: senza questo ramo
                // varrebbe «non ci sono foto», che è un'affermazione sui dati
                // fatta senza avere i dati.
                setFoto([]);
                setTotale(0);
                setErroreFoto('');
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'galleria-sede-corpo-inatteso',
                    route: ROTTA_LOG,
                    stato: res.status,
                });
                return;
            }
            const totaleServer =
                typeof corpo.total === 'number' ? corpo.total : (corpo.media as unknown[]).length;
            /**
             * L'OFFSET PUÒ TROVARSI OLTRE LA FINE DELL'ELENCO, e non per un errore
             * nostro: il totale DIMINUISCE quando una maestra cancella una foto
             * mentre la segreteria sta guardando la pagina 2. Restare a quell'offset
             * produce due bugie diverse, secondo cosa il server abbia consegnato:
             *  · con `media` vuoto la schermata dice «in questo plesso non c'è
             *    ancora nessuna foto» mentre invece ce n'è — e senza via d'uscita,
             *    perché i due pulsanti della paginazione vivono DENTRO il ramo
             *    `pronto` e in quello stato non vengono resi: un vicolo cieco;
             *  · con `media` non vuoto l'etichetta scrive «Pagina 2 di 1», perché
             *    `pagina` viene dall'offset e `pagine` dal totale, e nessuno dei
             *    due limita l'altro.
             * Si torna alla prima pagina e si rilegge. È la correzione alla CAUSA —
             * un offset che il totale nuovo non giustifica più — e non
             * all'etichetta: finché `offset < totale` vale
             * `floor(offset/p) ≤ ceil(totale/p) − 1`, cioè `pagina ≤ pagine` da
             * sola, e nessun `Math.min` sulla scritta serve più.
             * Si logga perché un elenco che si riavvolge da solo senza lasciare
             * traccia è esattamente il silenzio che questo repo paga caro: solo
             * NUMERI, mai un identificativo di foto o di bambino.
             */
            if (offset > 0 && totaleServer <= offset) {
                riparto = true;
                setFoto([]);
                setTotale(totaleServer);
                setOffset(0);
                logClient({
                    livello: 'warn',
                    evento: 'js',
                    messaggio: `galleria-sede-offset-oltre-la-fine:${offset}:${totaleServer}`,
                    route: ROTTA_LOG,
                });
                return;
            }
            setFoto(corpo.media as FotoSede[]);
            setTotale(totaleServer);
            // Il clamp del server è SILENZIOSO, e la risposta lo dichiara apposta:
            // le pagine si contano col numero che il server ha applicato davvero.
            setPerPagina(typeof corpo.limit === 'number' && corpo.limit > 0 ? corpo.limit : FOTO_PER_PAGINA);
            setErroreFoto(null);
        } finally {
            // Solo l'ULTIMA richiesta spegne lo spinner: una risposta sorpassata
            // che lo spegnesse mostrerebbe come «finito» un caricamento in corso.
            // E nemmeno quella che ha appena fatto RIPARTIRE il giro: il
            // caricamento non è finito, è ricominciato.
            if (mio === giroFoto.current && !riparto) setCaricamento(false);
        }
    }, [sede, classeNome, bambinoId, giorno, offset]);

    useEffect(() => {
        // ⚠️ `.catch()` E NON `void` NUDO. Una promise rifiutata lasciata cadere
        // esce come `unhandledrejection`, e nella WebView nativa quello diventa un
        // `pageerror` che accusa la pagina invece della causa vera: è già successo
        // in questo repo (vedi `SedeProvider`). Il ramo d'errore normale è dentro
        // `caricaFoto`; qui si RACCOGLIE ciò che nessuno si aspettava.
        caricaFoto().catch((e: unknown) => {
            logClient({
                livello: 'error',
                evento: 'js',
                messaggio: `galleria-sede-eccezione-inattesa: ${nomeErrore(e)}`,
                route: ROTTA_LOG,
            });
        });
    }, [caricaFoto]);

    /**
     * Le due tendine, riempite insieme a ogni cambio di sede.
     *
     * `annullato` non è prudenza: chi cambia plesso due volte in fretta lascia in
     * volo la lettura del primo, e senza questa guardia le classi di Cesa
     * atterrerebbero dentro la galleria di Aversa — due tendine che nominano un
     * plesso e una griglia che ne mostra un altro, senza nessun errore.
     *
     * Le due letture stanno DENTRO l'effetto e non in una `useCallback`: chiamare
     * di lì una funzione che scrive stato fa scattare
     * `react-hooks/set-state-in-effect` (severità ERRORE nel gate di questo repo).
     * Le funzioni fuori dal componente leggono e RESTITUISCONO; qui si assegna.
     */
    useEffect(() => {
        if (!sede) return;
        let annullato = false;
        const leggi = async () => {
            try {
                const [elencoSezioni, elenco] = await Promise.all([
                    leggiSezioniDellaSede(sede),
                    leggiBambiniDellaSede(sede),
                ]);
                if (annullato) return;
                setSezioni(elencoSezioni);
                setBambini(elenco);
            } finally {
                if (!annullato) setTendineInCorso(false);
            }
        };
        leggi().catch((e: unknown) => {
            logClient({
                livello: 'error',
                evento: 'js',
                messaggio: `galleria-sede-tendine-eccezione-inattesa: ${nomeErrore(e)}`,
                route: ROTTA_LOG,
            });
        });
        return () => {
            annullato = true;
        };
    }, [sede]);

    // ─── I gestori: qui lo spinner si può accendere ──────────────────────────
    /**
     * UN ELENCO NUOVO COMINCIA SGOMBRANDO QUELLO VECCHIO.
     *
     * Non è cosmesi. `stato` valuta `foto.length > 0 ? 'pronto'` PRIMA di
     * `caricamento`: finché la griglia ha dentro qualcosa lo spinner non compare
     * mai. Senza questo azzeramento, per tutta la durata della richiesta nuova
     * restano a schermo le foto della richiesta VECCHIA — e sopra di loro due
     * scritte che parlano già di quella nuova:
     *   · «{mostrate} foto · {totale} in tutto», che sono i numeri di prima;
     *   · «Pagina N/M», che è già la pagina appena chiesta.
     * Una schermata che si legge benissimo e dice il falso su foto di minori è
     * peggio di un errore, perché nessuno la mette in dubbio: la segreteria
     * quel conteggio lo legge al telefono a una famiglia.
     *
     * Vale per TUTTI e tre i gesti che cambiano elenco — plesso, filtro, pagina —
     * e non solo per il plesso: le due scritte mentono allo stesso modo in tutti
     * e tre i casi, ed è la stessa scritta. Nel primo giro di questo lavoro solo
     * il cambio di plesso lo faceva.
     *
     * `setErroreFoto(null)` sta qui per la stessa ragione: senza, il riquadro
     * rosso di un 403 sopravvive per tutta la richiesta nuova, sotto un filtro
     * che nel frattempo è cambiato (`riprova` lo azzerava, i filtri no).
     */
    const ricominciaElenco = () => {
        setFoto([]);
        setTotale(0);
        setErroreFoto(null);
        setCaricamento(true);
    };

    /** Ogni cambio di filtro riporta alla prima pagina: la pagina 7 di un altro elenco non esiste. */
    const cambiaFiltro = (applica: () => void) => {
        applica();
        setOffset(0);
        ricominciaElenco();
    };

    const cambiaSede = (id: string) => {
        setSedeScelta(id === '' ? null : id);
        // I filtri appartengono al plesso che si stava guardando: una classe di
        // Aversa dentro la galleria di Cesa è un elenco vuoto senza spiegazione.
        setClasseId('');
        setClasseNome('');
        setBambinoId('');
        setGiorno('');
        setSezioni([]);
        setBambini([]);
        // ⚠️ E SI AZZERA ANCHE CIÒ CHE È GIÀ A SCHERMO. Qui il danno è il più
        // grave dei tre: senza, per tutta la durata della richiesta nuova
        // resterebbero rese le foto del plesso PRECEDENTE — intestazioni di
        // giornata comprese — sotto un selettore che nomina già il plesso nuovo.
        // Non è una fuga di dati (il selettore offre solo plessi già accessibili),
        // è una schermata che attribuisce a un plesso le foto di un altro.
        // Il perché tecnico (`foto.length > 0` vince su `caricamento`) sta scritto
        // una volta sola, su `ricominciaElenco`.
        ricominciaElenco();
        // Le tendine del plesso vecchio non valgono per quello nuovo, e finché
        // non arrivano le sue restano spente: una tendina vuota e usabile
        // direbbe «questo plesso non ha classi» mentre l'elenco è ancora in volo.
        setTendineInCorso(true);
        setOffset(0);
    };

    const azzeraFiltri = () => cambiaFiltro(() => {
        setClasseId('');
        setClasseNome('');
        setBambinoId('');
        setGiorno('');
    });

    const riprova = () => {
        setErroreFoto(null);
        setCaricamento(true);
        caricaFoto().catch((e: unknown) => {
            logClient({
                livello: 'error',
                evento: 'js',
                messaggio: `galleria-sede-eccezione-inattesa: ${nomeErrore(e)}`,
                route: ROTTA_LOG,
            });
        });
    };

    /**
     * I bambini offerti seguono la classe scelta: con seicento voci in tendina,
     * una lista che non si restringe non è un filtro, è un elenco telefonico.
     *
     * ⚠️ SI CONFRONTANO DUE UUID, mai due nomi. È lo stesso criterio con cui il
     * server sceglie le foto (`sezioniDiNome` → `.in('section_id', …)`): così la
     * tendina offre ESATTAMENTE i bambini che quella classe, per la rotta,
     * contiene. Col confronto per testo (`b.classe === nomeSezione`) una sezione
     * rinominata dopo l'iscrizione — `sections.name` cambia, `alunni.classe_sezione`
     * no — darebbe griglia piena e tendina vuota, in silenzio.
     */
    const bambiniOfferti = useMemo(
        () => (classeId ? bambini.filter((b) => b.sectionId === classeId) : bambini),
        [bambini, classeId],
    );

    /**
     * …e se comunque non ne resta nessuno, LO SI DICE AL LOG.
     *
     * Con l'uuid la divergenza dei nomi non fa più danno, ma resta un caso in cui
     * la tendina si svuota lo stesso: bambini senza `section_id` (il trigger non
     * ha agganciato la sezione), oppure la colonna assente sul database. Per il
     * server sono bambini non filtrabili per classe, quindi la tendina vuota è la
     * risposta giusta — ma senza questa riga sarebbe indistinguibile da «questa
     * classe non ha bambini», che è il silenzio da cui è nato tutto.
     * Solo CONTEGGI: sono minori.
     */
    useEffect(() => {
        if (!classeId || bambini.length === 0 || bambiniOfferti.length > 0) return;
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: `galleria-sede-classe-senza-bambini:${bambini.length}`,
            route: ROTTA_LOG,
        });
    }, [classeId, bambini.length, bambiniOfferti.length]);

    /**
     * I BAMBINI TAGGATI DI CUI IL SERVER NON HA MANDATO IL NOME.
     *
     * `alunni_taggati` non è in corrispondenza 1:1 con `tag_students`, e la rotta
     * lo dichiara: un tag che punta a un bambino di un ALTRO plesso non torna
     * indietro (`vista-sede-tag-fuori-sede`), e se l'anagrafica non è leggibile
     * l'elenco esce vuoto del tutto (`vista-sede-nomi-non-letti`, `42703` sul DB
     * E2E della CI). A schermo la cosa si vede — ogni uuid senza nome entra col
     * suo segnaposto, vedi `alunniDellaPagina` — ma lo schermo della segreteria
     * non lo guarda nessuno di noi: senza questa riga il caso resterebbe muto
     * esattamente come le cinque classi di Giugliano del 2026-09-02.
     *
     * `warn` e non `error`: le foto ci sono, la galleria funziona, manca un nome.
     * Solo CONTEGGI — nessun uuid, nessun nome: sono minori, e la redazione di
     * `app_log` è a lista bianca.
     */
    useEffect(() => {
        const { taggati, senzaNome } = contaTagSenzaNome(foto);
        if (senzaNome === 0) return;
        logClient({
            livello: 'warn',
            evento: 'js',
            messaggio: `galleria-sede-tag-senza-nome:${senzaNome}/${taggati}`,
            route: ROTTA_LOG,
        });
    }, [foto]);

    const filtriAttivi = Boolean(classeId || bambinoId || giorno);

    /**
     * I quattro stati dell'elenco. `vuoto` NON nomina i filtri (accuserebbe i
     * filtri di una colpa che non hanno, su un plesso che di foto non ne ha mai
     * avute) e un guasto NON è mai `senzaRisultati` (manderebbe a togliere filtri
     * per un errore che non è dell'utente).
     *
     * Il conteggio arriva dal SERVER e riflette già i filtri, quindi la distinzione
     * fra «vuoto» e «senza risultati» la fa la presenza dei filtri, non un secondo
     * totale che non abbiamo.
     */
    const stato: StatoElencoTipo = erroreFoto !== null
        ? 'errore'
        : foto.length > 0
            ? 'pronto'
            : caricamento
                ? 'caricamento'
                : filtriAttivi
                    ? 'senzaRisultati'
                    : 'vuoto';

    const testiElenco: TestiStatoElenco = {
        caricamento: t('galSedeCaricamento'),
        vuotoTitolo: t('galSedeVuotoTitolo'),
        vuotoCorpo: t('galSedeVuotoCorpo'),
        senzaRisultatiTitolo: t('galSedeSenzaRisultatiTitolo'),
        senzaRisultatiCorpo: t('galSedeSenzaRisultatiCorpo'),
        pulisciFiltri: t('galSedeAzzeraFiltri'),
        erroreTitolo: t('galSedeErroreTitolo'),
        erroreCorpo: erroreFoto || t('galSedeErroreCorpo'),
        riprova: t('galSedeRiprova'),
    };

    const chipAttivi: FiltroAttivo[] = [
        ...(classeId ? [{ chiave: 'classe', etichetta: t('galSedeClasseLabel'), testo: classeNome }] : []),
        ...(bambinoId
            ? [{
                chiave: 'bambino',
                etichetta: t('galSedeBambinoLabel'),
                testo: bambini.find((b) => b.id === bambinoId)?.etichetta ?? t('galSedeBambinoSconosciuto'),
            }]
            : []),
        ...(giorno ? [{ chiave: 'giorno', etichetta: t('galSedeGiornoLabel'), testo: giorno }] : []),
    ];

    const pagina = perPagina > 0 ? Math.floor(offset / perPagina) + 1 : 1;
    const pagine = perPagina > 0 ? Math.max(1, Math.ceil(totale / perPagina)) : 1;
    const cePaginaPrecedente = offset > 0;
    const cePaginaSuccessiva = offset + foto.length < totale;

    // `block`: l'etichetta è VISIBILE e sta sopra il campo, non è un `aria-label`
    // nascosto. Un `<label>` inline lascerebbe la tendina sulla sua stessa riga.
    const ETICHETTA = 'block font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub';
    const CAMPO =
        'h-[42px] w-full cursor-pointer rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-[13.5px] text-kidville-ink outline-none transition-colors hover:border-kidville-green/50 focus:border-kidville-green focus-visible:ring-2 focus-visible:ring-kidville-green/30';
    const BOTTONE =
        'inline-flex items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-4 py-2 font-maven text-sm font-semibold text-kidville-ink transition-colors hover:border-kidville-green disabled:cursor-not-allowed disabled:opacity-50';

    return (
        <CockpitPage max={1152} className="flex flex-col">
            <PageHeader
                icon={Images}
                eyebrow={t('galSedeEyebrow')}
                title={t('galSedeTitolo')}
                subtitle={t('galSedeSottotitolo')}
            />

            {/* ─── Barra: sede + filtri ───────────────────────────────────── */}
            <div className="mb-6 rounded-card bg-kidville-white p-4 shadow-sm">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {/* La sede si sceglie solo quando c'è qualcosa da scegliere. */}
                    {opzioniSede.length > 1 && (
                        <div>
                            <label htmlFor="galleria-sede" className={ETICHETTA}>
                                {t('galSedeSedeLabel')}
                            </label>
                            <select
                                id="galleria-sede"
                                className={`${CAMPO} mt-1`}
                                value={sede ?? ''}
                                onChange={(e) => cambiaSede(e.target.value)}
                            >
                                <option value="">{t('galSedeSedeScegli')}</option>
                                {opzioniSede.map((s) => (
                                    <option key={s.id} value={s.id}>{s.nome}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div>
                        <label htmlFor="galleria-classe" className={ETICHETTA}>
                            {t('galSedeClasseLabel')}
                        </label>
                        <select
                            id="galleria-classe"
                            className={`${CAMPO} mt-1`}
                            value={classeId}
                            disabled={!sede || tendineInCorso}
                            onChange={(e) => cambiaFiltro(() => {
                                // Il `value` è l'UUID: il nome si ricava dalla voce,
                                // e se la voce non c'è non si sceglie niente — mai un
                                // nome inventato dentro la query del server.
                                const scelta = sezioni.find((sz) => sz.id === e.target.value);
                                setClasseId(scelta?.id ?? '');
                                setClasseNome(scelta?.nome ?? '');
                                // Il bambino scelto può non appartenere alla classe
                                // nuova: tenerlo darebbe un elenco vuoto e due filtri
                                // che si contraddicono a schermo.
                                setBambinoId('');
                            })}
                        >
                            <option value="">{t('galSedeClasseTutte')}</option>
                            {sezioni.map((sz) => (
                                <option key={sz.id} value={sz.id}>{sz.nome}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="galleria-bambino" className={ETICHETTA}>
                            {t('galSedeBambinoLabel')}
                        </label>
                        <select
                            id="galleria-bambino"
                            className={`${CAMPO} mt-1`}
                            value={bambinoId}
                            disabled={!sede || tendineInCorso}
                            onChange={(e) => cambiaFiltro(() => setBambinoId(e.target.value))}
                        >
                            <option value="">{t('galSedeBambinoTutti')}</option>
                            {bambiniOfferti.map((b) => (
                                <option key={b.id} value={b.id}>
                                    {b.classe ? `${b.etichetta} · ${b.classe}` : b.etichetta}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="galleria-giorno" className={ETICHETTA}>
                            {t('galSedeGiornoLabel')}
                        </label>
                        <input
                            id="galleria-giorno"
                            type="date"
                            className={`${CAMPO} mt-1`}
                            value={giorno}
                            disabled={!sede}
                            onChange={(e) => cambiaFiltro(() => setGiorno(e.target.value))}
                        />
                    </div>
                </div>

                {filtriAttivi && (
                    <div className="mt-3 flex justify-end">
                        <button type="button" onClick={azzeraFiltri} className={BOTTONE}>
                            <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                            {t('galSedeAzzeraFiltri')}
                        </button>
                    </div>
                )}
            </div>

            {/* ─── Contenuto ──────────────────────────────────────────────── */}
            {sediErrore ? (
                /* L'elenco delle sedi non è arrivato — che NON è «non hai sedi».
                   Chiedere di scegliere un plesso a chi non ha ricevuto l'elenco
                   sarebbe un'istruzione impossibile da eseguire. */
                <div role="alert" className="flex flex-col items-center gap-2 rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h2 className="font-barlow text-lg font-extrabold uppercase text-kidville-green">
                        {t('galSedeSediNonLetteTitolo')}
                    </h2>
                    <p className="max-w-md font-maven text-sm text-kidville-sub">{t('galSedeSediNonLetteCorpo')}</p>
                    <button type="button" onClick={ricaricaSedi} className={`${BOTTONE} mt-1`}>
                        <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                        {t('galSedeRiprova')}
                    </button>
                </div>
            ) : sediLoading ? (
                <StatoElenco stato="caricamento" testi={testiElenco} />
            ) : opzioniSede.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h2 className="font-barlow text-lg font-extrabold uppercase text-kidville-green">
                        {t('galSedeNessunaSedeTitolo')}
                    </h2>
                    <p className="max-w-md font-maven text-sm text-kidville-sub">{t('galSedeNessunaSedeCorpo')}</p>
                </div>
            ) : !sede ? (
                <div className="flex flex-col items-center gap-2 rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h2 className="font-barlow text-lg font-extrabold uppercase text-kidville-green">
                        {t('galSedeSceltaTitolo')}
                    </h2>
                    <p className="max-w-md font-maven text-sm text-kidville-sub">{t('galSedeSceltaCorpo')}</p>
                </div>
            ) : stato !== 'pronto' ? (
                <StatoElenco
                    stato={stato}
                    testi={testiElenco}
                    attivi={chipAttivi}
                    onPulisci={filtriAttivi ? azzeraFiltri : undefined}
                    onRiprova={riprova}
                />
            ) : (
                <>
                    <p className="mb-4 font-maven text-[13px] text-kidville-sub">
                        {t('galSedeConteggio', { mostrate: foto.length, totale })}
                    </p>

                    <GalleriaSedeGiornate
                        foto={foto}
                        testi={{
                            senzaData: t('galSedeGiornataSconosciuta'),
                            conteggio: (n: number) => t('galSedeFotoDelGiorno', { n }),
                            taggatoSenzaNome: t('galSedeTaggatoSenzaNome'),
                        }}
                    />

                    {(cePaginaPrecedente || cePaginaSuccessiva) && (
                        <nav
                            aria-label={t('galSedePaginazione')}
                            className="mt-8 flex flex-wrap items-center justify-center gap-3"
                        >
                            <button
                                type="button"
                                className={BOTTONE}
                                disabled={!cePaginaPrecedente || caricamento}
                                onClick={() => {
                                    setOffset((o) => Math.max(0, o - perPagina));
                                    ricominciaElenco();
                                }}
                            >
                                {t('galSedePiuRecenti')}
                            </button>
                            <span className="font-maven text-[13px] text-kidville-sub">
                                {t('galSedePaginaDi', { pagina, pagine })}
                            </span>
                            <button
                                type="button"
                                className={BOTTONE}
                                disabled={!cePaginaSuccessiva || caricamento}
                                onClick={() => {
                                    setOffset((o) => o + perPagina);
                                    ricominciaElenco();
                                }}
                            >
                                {t('galSedePiuVecchie')}
                            </button>
                        </nav>
                    )}
                </>
            )}
        </CockpitPage>
    );
}
