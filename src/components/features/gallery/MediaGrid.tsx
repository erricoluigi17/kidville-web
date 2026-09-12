'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { logClient } from '@/lib/logging/client';
import { nomeFileScarico, scarica, type RisultatoScarico } from '@/lib/native/scarica';
import { condividiLink } from '@/lib/native/share';
import { Download, Share2, Play, ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { SegnalaContenuto } from '@/components/features/segnalazioni/SegnalaContenuto';
import { DialogoEliminaMedia } from '@/components/features/gallery/DialogoEliminaMedia';
import { rendiInerteFuoriDaConFocus } from '@/lib/accessibility/inerti';

// Il traduttore va passato a timeAgo(), che è module-level (fuori dal componente).
type Traduttore = ReturnType<typeof useTranslations>;

export interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy?: boolean;
}

export interface MediaItem {
    id: string;
    /**
     * Indirizzo FIRMATO a tempo, generato dalla GET della galleria (il bucket è
     * privato). È `null` quando la firma non è riuscita: in quel caso la foto
     * non si può mostrare, e si mostra un segnaposto invece di un'immagine
     * rotta — il perché sta nel log lato server, a livello `error`.
     */
    file_url: string | null;
    file_type: string;
    caption: string | null;
    tag_students: string[];
    is_broadcast: boolean;
    created_at: string;
    uploader_name: string;
    /**
     * L'uuid di CHI ha caricato. Esce già da `GET /api/gallery` (la route legge
     * `select('*')` su `galleria_media_v2` e propaga `...media`): qui mancava solo
     * la dichiarazione, e senza di lei il predicato `eliminabile` non avrebbe
     * nulla su cui decidere — un'insegnante può eliminare SOLO i propri
     * caricamenti, la segreteria qualunque media della propria sede.
     *
     * Opzionale perché `.filter(Boolean)` nella route dice che la colonna può
     * essere vuota, e perché i fixture dei test che non la usano restano validi.
     * ⚠️ Non è un gate: il gate vero è nella route (`DELETE /api/gallery`). Questo
     * serve a non MOSTRARE un comando che il server rifiuterebbe.
     */
    uploaded_by?: string | null;
}

interface Props {
    items: MediaItem[];
    showActions?: boolean; // Download/Share per genitore
    /**
     * L'ELIMINAZIONE VERA — e adesso è una PROMISE, che è tutta la differenza.
     *
     * Era `(id) => void`, e il chiamante la usava così:
     * `onDelete(item.id); handleCloseLightbox();` — due righe, la seconda non
     * aspetta la prima. Il visore si chiudeva PRIMA della risposta del server, e
     * un rifiuto (403 di sede, 500) arrivava su una schermata che non mostrava più
     * la foto di cui parlava. Con una promise il dialogo può restare aperto
     * finché il server non ha risposto, che è l'unico modo di dire «non è andata»
     * mentre si vede ancora di che cosa si sta parlando.
     *
     * DEVE RIGETTARE quando il server rifiuta, con un `Error` dal `.message` GIÀ
     * TRADOTTO (`messaggioErrore`/`messaggioDaCorpo` di `@/lib/ui/esito-fetch`) e,
     * se possibile, con lo stato HTTP attaccato — `erroreElimina(testo, res.status)`
     * di `./DialogoEliminaMedia`, oppure `Object.assign(new Error(testo), { stato })`.
     * Senza lo stato i tre esiti non si distinguono e tutto viene trattato come
     * ritentabile, che è il ripiego prudente.
     *
     * ⚠️ IL RICARICO DELL'ELENCO RESTA DEL CHIAMANTE, dentro la propria
     * risoluzione: qui non si sa che cosa sia «l'elenco». Un 404 conviene
     * trattarlo come RIUSCITA (la riga non c'è più: l'esito voluto è raggiunto)
     * con un `warn` nel log, così anche in quel caso l'elenco si aggiorna.
     */
    onDelete?: (id: string) => Promise<void>; // Solo admin/staff
    /**
     * CHI può eliminare QUESTO media. Decisione del titolare: l'insegnante solo i
     * propri caricamenti, segreteria e direzione qualunque media della propria
     * sede, il genitore mai (il genitore non passa `onDelete` affatto).
     *
     * Il default è «tutti, quando `onDelete` c'è»: non stringe niente da sé, e le
     * tre superfici dichiarano la propria regola. Il gate che conta resta quello
     * della route; questo evita di MOSTRARE un comando destinato a un 403.
     */
    eliminabile?: (item: MediaItem) => boolean;
    students?: Student[]; // Tutti gli studenti della classe per il tagging
    onUpdateTags?: (id: string, newTags: string[]) => Promise<void>; // Salvataggio dei tag
    /**
     * Quante colonne ha la griglia. **Lo decide il chiamante, e non il viewport.**
     *
     * Fino al 2026-09-11 la griglia era `grid-cols-2 sm:grid-cols-3`, cioè due
     * colonne sotto i 640 px di VIEWPORT e tre sopra. Ma questo componente è
     * montato in tre contenitori larghi in modo molto diverso — `max-w-[460px]`
     * lato insegnante, ~358 px lato genitore, ~1088 px nella vista di sede — e il
     * breakpoint non ne sa niente: su un tablet in verticale prometteva tre
     * colonne a una colonna larga 358 px, cioè miniature da 110 px con i comandi
     * di scarico sopra.
     *
     * Il default è 2, il caso stretto: chi ha spazio lo dichiara.
     */
    colonne?: 2 | 3 | 4;
}

/**
 * LE CLASSI DELLE COLONNE SONO LETTERALI, E NON POTREBBERO NON ESSERLO.
 *
 * `grid-cols-${colonne}` non funziona: Tailwind 4 genera le utility leggendo il
 * SORGENTE, e una stringa composta a runtime non compare in nessun file. La
 * classe finirebbe nel `class` dell'elemento senza esistere nel CSS — cioè la
 * griglia resterebbe a una colonna, **in silenzio e col gate verde**. È lo stesso
 * difetto già misurato in questo repo con `bg-kidville-success-soft0` (lock
 * `utility-kidville-esistenti`): una classe che non c'è non dà nessun errore.
 */
const CLASSI_COLONNE: Record<NonNullable<Props['colonne']>, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
};

/**
 * Il nome accessibile della card. Il tipo PRIMA della didascalia, perché è la
 * differenza che il triangolino comunicava solo a chi vede: «Video: Recita di
 * fine anno» e «Foto: Laboratorio dei colori» si distinguono al primo carattere.
 *
 * La parola del tipo viene dal CATALOGO (`galleryVideo`, `galleryAltFoto`) e non
 * da un letterale: fino al 2026-09-11 «Video» era scritta qui dentro, unica parola
 * d'interfaccia del file fuori da `messages/`. La chiave ora esiste in `it` e in
 * `en` (il lock `messaggi-parita-cataloghi` pretende entrambi) e la misura di
 * questo passaggio è nel test dell'impaginazione: se la chiave sparisse, a schermo
 * comparirebbe `shared.galleryVideo` e il test lo dice.
 */
function etichettaCard(item: MediaItem, t: Traduttore): string {
    const tipo = item.file_type === 'video' ? t('galleryVideo') : t('galleryAltFoto');
    return item.caption ? `${tipo}: ${item.caption}` : tipo;
}

/*
 * ⚠️ QUI NON SI PASSA `route`, ED È UNA DECISIONE — non una dimenticanza.
 *
 * Fino al 2026-09-06 queste righe dichiaravano `route: '/gallery'`, una pagina che NON
 * ESISTE: sotto `src/app/` ci sono `parent/gallery`, `teacher/gallery`, `admin/gallery` e la
 * route API, mai una `/gallery` alla radice. E `MediaGrid` è montata in QUATTRO punti —
 * `/parent/gallery`, `/parent/diary`, `/teacher/gallery` e, dal 2026-09-05, `/admin/gallery`
 * attraverso `GalleriaSedeGiornate`.
 *
 * `logClient` la rotta se la riempie da sé quando il campo manca: `client.ts` fa
 * `redigiPathSicuro(e.route || pagina())`, e `pagina()` è `redigiPath(location.pathname)` —
 * il percorso vero, già ridotto. Passare una costante era quindi STRETTAMENTE PEGGIO che
 * ometterla: sovrascriveva il luogo dell'incidente con un luogo inventato, e in `app_log` lo
 * scarico fallito di un'insegnante, quello di un genitore in galleria e quello dal diario
 * diventavano indistinguibili — in un lavoro il cui scopo è proprio sapere dove è successo.
 *
 * Chi in futuro volesse rimettere un `route` fisso qui dentro: serve a distinguere QUATTRO
 * superfici, e il modo giusto è lasciar parlare la pagina.
 */

/**
 * L'ESITO DELLO SCARICO FINISCE SEMPRE IN `app_log` — successo compreso.
 *
 * ─── PERCHÉ ANCHE IL SUCCESSO ────────────────────────────────────────────────
 * Senza la riga del successo, «nessun log» non distingue «va tutto bene» da «il
 * pulsante non ha mai fatto partire niente» — ed è ESATTAMENTE così che questo
 * guasto è rimasto in piedi: in trenta giorni di `app_log` c'è UNA sola riga
 * sullo scarico della galleria (2026-09-05, iOS), e nessuna che dica che una
 * volta abbia funzionato. Il silenzio sembrava salute (§5 di AGENTS.md).
 *
 * ─── PERCHÉ `warn` PER UN SUCCESSO, che sembra sbagliato ─────────────────────
 * Perché il canale non ha di meglio: `/api/logs` accetta **solo** `warn|error`
 * (difesa n. 4 della route: «un client non può riempire la tabella di `info`»),
 * quindi un `info` non è spedibile e l'unico modo di NON conservare un evento è
 * non mandarlo. Il costo è misurato, non stimato: `app_log` deduplica per
 * `(fingerprint, giorno)` — una riga al giorno per utente, con `occorrenze` che
 * conta il resto — e `controlloTassoErrore` guarda **solo** `livello = 'error'`,
 * quindi un battito a `warn` non può far dire «degradato» a un'app sana.
 *
 * ─── PERCHÉ LO STATO HTTP STA NEL MESSAGGIO E NON IN `stato` ─────────────────
 * Perché `livelloEvento()` applica a ogni `stato` fra 400 e 599 la politica di
 * `livelloFetch`, che per un 403 o un 404 risponde `null` = «non spedire». Un
 * indirizzo firmato scaduto (403) è il caso più probabile di scarico fallito:
 * dichiararlo in `stato` significherebbe scartare in silenzio proprio la riga
 * che si sta aggiungendo. Come token dentro `messaggio` invece resta, e il
 * livello resta quello dichiarato qui.
 */
function registraEsitoScarico(risultato: RisultatoScarico): void {
    const coda = risultato.motivo ? `: ${risultato.motivo}` : '';
    if (risultato.esito === 'nativo-file' || risultato.esito === 'web-blob') {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `gallery-scarico-riuscito:${risultato.esito}`,
        });
        return;
    }
    if (risultato.esito === 'ripiego-condivisione' || risultato.esito === 'ripiego-appunti') {
        // Degradato, non guasto: l'utente ha ottenuto il link. Vale `warn`.
        //
        // I DUE RIPIEGHI RESTANO DUE TOKEN DIVERSI in tabella
        // (`gallery-scarico-ripiego-condivisione` e `gallery-scarico-ripiego-appunti`),
        // perché non sono la stessa degradazione: col foglio l'utente vede
        // qualcosa succedere, con gli appunti no. Contarli insieme nasconderebbe
        // proprio il ramo che si è dovuto rendere parlante.
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `gallery-scarico-${risultato.esito}${coda}`,
        });
        return;
    }
    // L'utente non ha ottenuto NIENTE: è il solo caso che merita un `error`.
    logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `gallery-scarico-non-riuscito${coda}`,
    });
}

function timeAgo(iso: string, t: Traduttore): string {
    const diff = Date.now() - new Date(iso).getTime();
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return t('galleryOra');
    if (hrs < 24) return t('galleryOreFa', { n: hrs });
    const days = Math.floor(hrs / 24);
    return t('galleryGiorniFa', { n: days });
}

export function MediaGrid({ items, showActions, onDelete, eliminabile, students, onUpdateTags, colonne = 2 }: Props) {
    const t = useTranslations('shared');
    const [lightbox, setLightbox] = useState<MediaItem | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [tempTagged, setTempTagged] = useState<string[]>([]);
    const [savingTags, setSavingTags] = useState(false);
    /**
     * IL MEDIA PER CUI SI STA CHIEDENDO CONFERMA — e non un booleano.
     *
     * Tenere l'OGGETTO e non un `true` è ciò che rende impossibile il caso
     * peggiore: col dialogo aperto si elimina il media che il dialogo nomina, non
     * «quello aperto nel visore adesso». Le due cose divergono al primo tocco di
     * una freccia, e la seconda cancellerebbe una foto che non si sta guardando.
     */
    const [daEliminare, setDaEliminare] = useState<MediaItem | null>(null);

    /**
     * UNO SCARICO ALLA VOLTA. Non è cosmesi: su iOS presentare un secondo foglio
     * di condivisione mentre il primo è aperto solleva, e su nativo la seconda
     * pressione riscriverebbe lo stesso file mentre lo si sta consegnando. Un
     * `ref` e non uno `state` perché non deve ridisegnare niente.
     */
    const scaricoInCorso = useRef(false);

    /**
     * LA DELETE DELLA CONFERMA È IN VOLO — e finché è vera il visore non si chiude.
     *
     * ─── IL BUCO CHE CHIUDE, misurato il 2026-09-12 ──────────────────────────
     * `DialogoEliminaMedia` ha la propria guardia per le tre strade che passano da
     * lui (`Escape`, il tasto Indietro di Android, «Annulla»). Ne restavano DUE, e
     * sono qui: la ✕ e lo scroller chiamano `handleCloseLightbox` DIRETTAMENTE, e
     * quella azzera `daEliminare`, cioè smonta il dialogo. Con la DELETE in volo il
     * 403 o il 500 che arrivava dopo faceva girare `setErrore` su un componente
     * morto — no-op silenzioso in React, nemmeno un avviso in console: la foto
     * restava e chi aveva premuto non vedeva niente. Lo stesso silenzio per cui il
     * dialogo esiste invece di un `confirm()`, rientrato dalla porta di servizio.
     *
     * Sono anche le DUE STRADE CHE RESTANO RAGGIUNGIBILI col dialogo aperto su iOS
     * 15.0–15.4: `inert` è di Safari 15.5, `IPHONEOS_DEPLOYMENT_TARGET` è 15.0,
     * quindi `rendiInerteFuoriDa` ripiega su `aria-hidden`, che non blocca i click.
     * È la stessa finestra di dispositivi con cui si giustifica l'azzeramento di
     * `daEliminare` in `handleCloseLightbox`: non può contare per una strada e non
     * per la sua gemella.
     *
     * ─── PERCHÉ UN `ref` E NON UNO `useState`, E COSA HO MISURATO ────────────
     * Il valore si legge dentro `handleCloseLightbox`, e di `handleCloseLightbox`
     * ce n'è una copia per render: al momento del successo ne sono vive ALMENO
     * DUE — quella catturata dalla ✕ al render in cui la bandiera era già alzata,
     * e quella che la `conferma()` in esecuzione tiene come `onEliminato`, nata al
     * render PRECEDENTE alla pressione. Con un `ref` la guardia risponde al TEMPO
     * (si scrive e si rilegge nella stessa riga); con uno `useState` risponde a
     * QUALE chiusura sta chiedendo, e le due cose divergono esattamente qui.
     *
     * ⚠️ Onestà su quanto è misurato, perché la prima stesura di questo commento
     * diceva di più: sostituito il `ref` con uno `useState`, i 42 test di
     * `__tests__/components/DialogoEliminaMedia.test.tsx` restano TUTTI VERDI
     * (mutazione eseguita il 2026-09-12). Il motivo è che la `conferma()` in volo
     * tiene la `onEliminato` creata PRIMA che la bandiera salisse, e quella legge
     * `false`: la versione con lo stato funziona per l'ordine in cui le chiusure
     * sono state catturate, non per una regola che si possa leggere sul posto.
     * Il `ref` resta la scelta perché toglie quella dipendenza invisibile — e
     * perché non ridisegna la griglia (fino a 40 card) due volte per pressione: è
     * la stessa ragione di `scaricoInCorso` qui sopra. Il segnale a schermo c'è
     * già, ed è lo spinner sul bottone della conferma.
     */
    const eliminaInVolo = useRef(false);

    /**
     * IL VISORE È UNA FINESTRA MODALE, E ADESSO SI COMPORTA COME TALE.
     *
     * ─── COSA MANCAVA, misurato il 2026-09-11 ────────────────────────────────
     * Rendere la card un comando da tastiera (WCAG 2.1.1) senza portarci il fuoco
     * ha spostato il difetto, non l'ha chiuso: premendo Invio il visore si apriva,
     * il fuoco restava sulla card — che da quell'istante sta DIETRO un velo opaco a
     * tutto schermo — e per raggiungere «Elimina Media» bisognava tabulare
     * attraverso l'intera griglia, perché il visore è reso DOPO di lei nel DOM: 30
     * tappe con 10 foto, 120 con 40. Sono WCAG 2.4.3 (ordine del fuoco) e 2.4.11
     * (fuoco non coperto) al posto di quella che si stava chiudendo.
     *
     * ─── PERCHÉ NON BASTA `aria-modal="true"` ────────────────────────────────
     * Perché su un `div` non esclude NIENTE: Chromium lo onora solo per il top
     * layer (`<dialog>` + `showModal()`). È scritto per esteso in testa a
     * `@/lib/accessibility/inerti`, e misurato su Android il 2026-07-31 — col dump
     * dell'albero di accessibilità che mostrava ancora i comandi della pagina sotto
     * la modale. L'attributo senza l'inerzia dello sfondo è decorazione.
     *
     * ─── IL PEZZO NON SI RISCRIVE: È GIÀ IN CASA ─────────────────────────────
     * `rendiInerteFuoriDaConFocus` è lo stesso di `Modal` e di `PageLoader` (e il
     * registro dei nodi marcati è CONDIVISO, che è ciò che regge il caso «visore
     * aperto mentre parte una navigazione»). Fa tre cose in una: marca `inert` tutto
     * fuori dal visore — da cui il contenimento del Tab, gratis e senza trappola
     * scritta a mano —, ricorda chi aveva il fuoco e glielo restituisce alla
     * chiusura, e non lo ruba se nel frattempo è finito altrove.
     *
     * ⚠️ LA DIPENDENZA È «È APERTO», NON «QUALE MEDIA». Con `[lightbox]` ogni
     * freccia avanti/indietro rifarebbe girare l'effetto e strapperebbe il fuoco
     * dalla freccia appena premuta, a ogni foto.
     */
    const visoreRef = useRef<HTMLDivElement>(null);
    const visoreAperto = lightbox !== null;

    useEffect(() => {
        const radice = visoreRef.current;
        if (!radice) return;
        const ripristina = rendiInerteFuoriDaConFocus(radice);
        // Il fuoco va sul CONTENITORE `role="dialog"` (che ha `tabIndex={-1}`, quindi
        // riceve il fuoco ma non è una tappa del ciclo): così l'annuncio è il nome
        // del dialogo — «Foto: Laboratorio dei colori, finestra di dialogo» — e non
        // il primo bottone che capita, che sarebbe una «✕» senza contesto.
        radice.focus();
        return ripristina;
    }, [visoreAperto]);

    /**
     * LO SCARICO, IN UN POSTO SOLO — ed è metà della correzione.
     *
     * Prima questa logica era scritta DUE VOLTE, sulla card e nel visore, e le
     * due copie erano già divergenti: quella della card non aveva nemmeno un
     * `logClient`. Due copie che divergono non sono un difetto di domani: erano
     * il difetto di ieri.
     */
    const scaricaMedia = useCallback(async (item: MediaItem, url: string) => {
        if (scaricoInCorso.current) {
            /**
             * NON UN `return` NUDO — e non è pignoleria.
             *
             * `scarica()` non lancia mai, ma può NON RISOLVERE: la `fetch` verso
             * l'indirizzo firmato è CROSS-ORIGIN e nella WebView può accettare e
             * tacere (è la riga di produzione con `stato_http = 0` citata in
             * `scarica.ts`). In quel caso il `finally` qui sotto non gira mai, il
             * ref resta `true` per tutta la vita della pagina, e da lì in avanti
             * OGNI pressione di «Scarica» esce da questa riga.
             *
             * Senza questa riga «il pulsante è incagliato» e «nessuno l'ha mai
             * premuto» sarebbero lo stesso identico silenzio in `app_log`: è
             * l'ambiguità che il §5 di AGENTS.md vieta, ed è precisamente il modo
             * in cui lo «Scarica» rotto è sopravvissuto per mesi.
             *
             * Il TETTO DI TEMPO su `scarica()` è una decisione separata e non si
             * prende qui: `MAI_OLTRE_MS` è 30 s, e trenta secondi sono pochi per
             * il video di un genitore su rete lenta. Loggare la pressione
             * scartata invece non richiede nessuna scelta sui tempi.
             */
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-scarico-gia-in-corso',
            });
            return;
        }
        scaricoInCorso.current = true;
        try {
            const risultato = await scarica({
                url,
                nomeFile: nomeFileScarico(item.caption, url, item.file_type),
                titolo: item.caption ?? t('galleryFotoDaKidville'),
            });
            // Prima la riga, poi l'avviso: `alert()` blocca il thread finché
            // l'utente non chiude, e un log che parte dopo è un log che si perde
            // se lui intanto se ne va dalla pagina.
            registraEsitoScarico(risultato);
            // L'UNICO RAMO MUTO, e va detto — esattamente come fa `condividiMedia`
            // qui sotto. Ci si arriva sul web senza Web Share (Firefox su desktop)
            // quando l'indirizzo firmato è scaduto: il file non c'è, negli appunti
            // c'è il link, e sullo schermo non è cambiato niente. Senza queste due
            // righe «Scarica» tornerebbe a essere un pulsante che sembra rotto,
            // che è il difetto da cui è nato tutto questo lavoro.
            if (risultato.esito === 'ripiego-appunti') alert(t('mediaLinkCopiato'));
        } finally {
            scaricoInCorso.current = false;
        }
    }, [t]);

    /**
     * LA CONDIVISIONE, dallo stesso modulo nativo di tutto il resto dell'app
     * (`@/lib/native/share`) invece che riscritta a mano due volte. Qui il ramo
     * nativo mancava del tutto: c'era solo `navigator.share`, che nella WebView
     * esiste ma non è il foglio di sistema di Capacitor.
     *
     * `avvisoAppunti` è il messaggio da mostrare QUANDO si finisce sugli appunti,
     * che è l'unico ramo muto: senza, la copia riuscita e il pulsante rotto si
     * assomigliano troppo. Lo decide `condividiLink`, non una condizione
     * ricopiata qui.
     */
    const condividiMedia = useCallback(async (item: MediaItem, url: string, avvisoAppunti: string) => {
        const esito = await condividiLink({
            url,
            title: item.caption ?? t('galleryFotoDaKidville'),
        });
        if (esito === 'appunti') {
            alert(avvisoAppunti);
            return;
        }
        if (esito === 'non-riuscita') {
            // Nessun canale: prima di oggi questo ramo taceva del tutto, e un
            // «Condividi» che non condivide non lasciava traccia da nessuna parte.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-condivisione-senza-canale',
            });
        }
    }, [t]);

    const handleCloseLightbox = () => {
        /*
         * ⚠️ LA GUARDIA GEMELLA DI QUELLA DEL DIALOGO, e sta qui perché qui si
         * smonta. Con la DELETE in volo non si chiude niente: il rifiuto che sta
         * arrivando ha bisogno di trovare il dialogo ancora montato, altrimenti
         * `setErrore` gira su un componente morto e non si vede da nessuna parte.
         * Il perché per esteso è sul `ref` `eliminaInVolo`, qui sopra.
         *
         * Non è un vicolo cieco: la bandiera scende in `conferma()` PRIMA di
         * qualunque richiamo al padre, quindi l'esito positivo (e il 404) chiudono
         * il visore da sé, e un rifiuto lascia la ✕ di nuovo funzionante. Due
         * test lo ripercorrono, perché una guardia incastrata sarebbe un visore
         * da cui non si esce più.
         */
        if (eliminaInVolo.current) {
            /*
             * La pressione scartata si LOGGA, come già fa `scaricaMedia` con lo
             * scarico doppio e per lo stesso motivo del §5 di AGENTS.md: senza
             * questa riga «la ✕ è incagliata» e «nessuno l'ha premuta» sarebbero
             * lo stesso silenzio in `app_log`. Il gesto non è muto a schermo —
             * lo spinner sulla conferma è lì —, ma quante volte accada si misura
             * solo se lo si scrive.
             */
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'gallery-chiusura-visore-rinviata',
            });
            return;
        }
        setLightbox(null);
        setEditMode(false);
        setTempTagged([]);
        /*
         * ⚠️ ANCHE IL MEDIA CATTURATO DALLA CONFERMA, e questa riga chiude il caso
         * peggiore per COSTRUZIONE invece di affidarlo al supporto di `inert`.
         *
         * Questo è l'UNICO imbuto che smonta il visore, e il visore è l'unico
         * contenitore del dialogo: se il visore cade e `daEliminare` resta, alla
         * riapertura di un ALTRO media la conferma ricompare da sé NOMINANDO quello
         * di prima — si legge la didascalia di una foto e si cancella un'altra.
         *
         * Non è un caso di scuola: lo scroller porta `onClick={handleCloseLightbox}`
         * e col dialogo aperto dovrebbe essere coperto da `inert`, ma `inert` è di
         * Safari 15.5 e `IPHONEOS_DEPLOYMENT_TARGET` è 15.0 — su iOS 15.0–15.4
         * `rendiInerteFuoriDa` ripiega su `aria-hidden`, che NON blocca i click (sta
         * scritto nel commento di `@/lib/accessibility/inerti`). Lo stesso vale per
         * la ✕ qui sotto e per il tasto Indietro di Android.
         */
        setDaEliminare(null);
    };

    /** L'apertura del visore, in un posto solo: la usano il click e la tastiera. */
    const apriVisore = (item: MediaItem) => {
        setLightbox(item);
        setEditMode(false);
        setTempTagged(item.tag_students ?? []);
    };

    /**
     * IL PREDICATO, IN UN POSTO SOLO. `onDelete` assente significa «questa
     * superficie non elimina» (il genitore): non è una regola di ruolo, è
     * l'assenza del comando. `eliminabile` assente significa «tutti quelli di
     * questa superficie», perché un default che stringe da sé spegnerebbe in
     * silenzio il comando delle due schermate che lo avevano già.
     */
    const puoEliminare = (item: MediaItem): boolean =>
        onDelete !== undefined && (eliminabile ? eliminabile(item) : true);

    /**
     * L'eliminazione legata al media della conferma. Costruirla qui — e non dentro
     * il dialogo — è ciò che tiene l'uuid FUORI dal dialogo: quel componente non
     * lo riceve, quindi non può stamparlo a schermo per distrazione.
     */
    const eliminaIlMedia = daEliminare && onDelete ? () => onDelete(daEliminare.id) : null;

    const currentIndex = lightbox ? items.findIndex(item => item.id === lightbox.id) : -1;
    // Indirizzo firmato del media aperto nel visore, in una const: `null` quando la
    // firma non è riuscita (bucket privato → link a tempo generato dalla GET).
    const urlVisore = lightbox?.file_url ?? null;

    const handlePrev = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (currentIndex > 0) {
            const prevItem = items[currentIndex - 1];
            setLightbox(prevItem);
            setEditMode(false);
            setTempTagged(prevItem.tag_students ?? []);
        }
    }, [currentIndex, items]);

    const handleNext = useCallback((e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (currentIndex < items.length - 1) {
            const nextItem = items[currentIndex + 1];
            setLightbox(nextItem);
            setEditMode(false);
            setTempTagged(nextItem.tag_students ?? []);
        }
    }, [currentIndex, items]);

    useEffect(() => {
        /**
         * ⚠️ `|| daEliminare` NON È UNA RIFINITURA. Con la conferma aperta, `Escape`
         * lo gestisce già `Modal` (che fa `stopPropagation()` su `document`, cioè
         * prima che l'evento arrivi a questo listener su `window`), ma le FRECCE no:
         * arrivavano fin qui e cambiavano il media dietro al dialogo. Il dialogo
         * nomina e cancella quello che ha catturato all'apertura — quindi da quel
         * momento si sarebbe letta una didascalia e cancellata un'altra foto.
         */
        if (!lightbox || daEliminare) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                handlePrev();
            } else if (e.key === 'ArrowRight') {
                handleNext();
            } else if (e.key === 'Escape') {
                handleCloseLightbox();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
        // handlePrev/handleNext sono memoizzate su [currentIndex, items] (già dipendenze):
        // l'effect gira esattamente quando girava prima.
    }, [lightbox, daEliminare, currentIndex, items, handlePrev, handleNext]);

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📷</div>
                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">{t('galleryVuotoTitolo')}</p>
                <p className="font-maven text-sm text-kidville-sub">{t('galleryVuotoCorpo')}</p>
            </div>
        );
    }

    return (
        <>
            <div data-testid="griglia-media" className={`grid ${CLASSI_COLONNE[colonne]} gap-3`}>
                {items.map((item, idx) => {
                    // `url` in una const locale: il restringimento di tipo su
                    // `item.file_url` non sopravvivrebbe dentro gli handler.
                    const url = item.file_url;
                    return (
                    <motion.div
                        key={item.id}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: idx * 0.04, duration: 0.25 }}
                        className="relative group aspect-square rounded-2xl overflow-hidden bg-kidville-neutral-soft shadow-sm border border-white/40"
                    >
                        {/*
                          IL COMANDO CHE APRE IL VISORE È UN FIGLIO DELLA CARD, NON LA CARD —
                          ed è una decisione, non una svista.

                          Prima il gesto viveva su questo `motion.div` con un `onClick` nudo:
                          nessun `role`, nessun `tabIndex`, nessuna tastiera. Da tastiera il
                          visore — dove si scarica, si condivide, si segnala e si elimina — non
                          si apriva in nessun modo (WCAG 2.1.1, livello A).

                          La correzione ovvia sarebbe mettere `role="button"` sulla card. Ma la
                          card CONTIENE due bottoni veri (Scarica, Condividi), e un comando
                          dentro un comando è `nested-interactive` per axe: lo screen reader
                          annuncia un solo bottone e i due che stanno dentro diventano
                          irraggiungibili. È la stessa lezione già scritta nel lock
                          `righe-tabella-con-comando`: «una riga trasformata in bottone prende
                          come nome accessibile tutto il suo contenuto e inghiotte i controlli
                          che ci vivono dentro».

                          Quindi il comando è questo strato — che copre la miniatura e porta
                          l'etichetta — e i due bottoni di scarico/condivisione restano FUORI da
                          lui, fratelli, dentro la card. Un comando, due comandi, nessuno
                          annidato.
                        */}
                        <div
                            role="button"
                            tabIndex={0}
                            aria-label={etichettaCard(item, t)}
                            onClick={() => apriVisore(item)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    // Spazio su un elemento non nativo fa scorrere la pagina:
                                    // qui la pressione è il gesto, non lo scorrimento.
                                    e.preventDefault();
                                    apriVisore(item);
                                }
                            }}
                            // L'anello di fuoco è DENTRO (offset negativo): la card ha
                            // `overflow-hidden` e un contorno disegnato fuori sarebbe tagliato.
                            className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-kidville-green"
                        >
                            {item.file_type === 'video' ? (
                                /* Un quadrato scuro con un triangolino non dice a nessuno che
                                   cos'è: Play in un cerchio chiaro + la parola. E NESSUN
                                   `<video>` qui dentro — quaranta miniature sono quaranta
                                   richieste di metadati su rete mobile. */
                                <div className="w-full h-full bg-kidville-ink flex flex-col items-center justify-center gap-1.5">
                                    <span className="w-11 h-11 rounded-full bg-white/90 flex items-center justify-center shadow-md">
                                        <Play size={20} className="text-kidville-green translate-x-[1px]" strokeWidth={2} fill="currentColor" />
                                    </span>
                                    <span className="font-barlow font-bold text-[10px] uppercase tracking-wide text-white/90">
                                        {t('galleryVideo')}
                                    </span>
                                </div>
                            ) : item.file_url ? (
                                /*
                                  LA MINIATURA È DECORATIVA, e `aria-hidden` lo dichiara.
                                  Sta DENTRO un comando che porta già il proprio nome
                                  (`aria-label={etichettaCard(...)}`): senza questo attributo
                                  uno screen reader annunciava «Foto: Laboratorio dei colori» e
                                  poi, dentro, «Laboratorio dei colori, immagine» — la stessa
                                  cosa due volte.
                                  ⚠️ PERCHÉ NON `alt=""`, che sarebbe la forma canonica: quattro
                                  file di test che non appartengono a questo lavoro individuano
                                  questa miniatura con `getByAltText` (`MediaGrid-segnala`,
                                  `MediaGrid-link-scaduto`, `scarica-media-grid`,
                                  `galleria-sede-pagina`). L'effetto sull'albero di accessibilità
                                  è lo stesso; chi passerà ad `alt=""` cambi anche quelle quattro
                                  righe. Nel VISORE l'`alt` resta descrittivo: lì è l'unica
                                  descrizione che esiste.
                                */
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={item.file_url} alt={item.caption ?? t('galleryAltFoto')} aria-hidden="true" className="w-full h-full object-cover" />
                            ) : (
                                /* Link non firmato: un `<img src="">` mostrerebbe l'icona di
                                   immagine rotta e ripartirebbe con una richiesta sulla pagina
                                   stessa. Meglio dirlo. */
                                <div className="w-full h-full bg-kidville-cream flex flex-col items-center justify-center gap-1 px-2 text-center">
                                    <ImageOff size={22} className="text-kidville-green/70" strokeWidth={1.5} />
                                    <span className="font-maven text-[10px] leading-tight text-kidville-green/60">
                                        {t('galleryAnteprimaNonDisponibile')}
                                    </span>
                                </div>
                            )}

                            {/* Overlay on hover */}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                                <div className="absolute bottom-0 left-0 right-0 p-3">
                                    <p className="font-maven text-xs text-white/90 truncate">{item.caption ?? ''}</p>
                                    {/* `truncate` come la didascalia sopra: «Maestra Annamaria
                                        Esposito • 3g fa» in una miniatura da 170 px sfonda. */}
                                    <p className="font-maven text-[10px] text-white/60 truncate">{item.uploader_name} • {timeAgo(item.created_at, t)}</p>
                                </div>
                            </div>
                        </div>

                        {/* Broadcast badge. `pointer-events-none`: è un'etichetta, non un
                            comando, e sta SOPRA il comando che apre il visore — senza questa
                            riga il suo angolo diventerebbe una zona morta. */}
                        {item.is_broadcast && (
                            <div className="absolute top-2 left-2 px-2 py-0.5 bg-kidville-yellow text-kidville-green font-barlow font-bold text-[9px] rounded-full uppercase pointer-events-none">
                                {t('galleryBadgeGenerale')}
                            </div>
                        )}

                        {/* Pulsanti Download e Condividi diretti sulla card.
                            Senza indirizzo firmato non possono fare nulla: si tolgono,
                            invece di offrire un bottone che scarica un errore. */}
                        {showActions && url && (
                            /*
                              SEMPRE VISIBILI, E ADESSO C'È SCRITTO.

                              Qui c'erano `opacity-0 group-hover:opacity-100
                              md:group-hover:opacity-100` e, sullo stesso elemento, uno
                              `style={{ opacity: 1 }}` inline. Lo stile inline VINCE su
                              qualunque classe: le tre classi erano codice morto, e l'unico
                              posto dove si leggeva l'intenzione era il commento dentro
                              l'oggetto di stile. Su touch l'hover non esiste, quindi la
                              scelta è giusta — ma va dichiarata dove un lettore la cerca.

                              I bottoni passano da 28 a 36 px: 28 è sotto il minimo di WCAG
                              2.5.8 (24 px) solo di poco e ben sotto i 44 di Apple, e sono
                              due bersagli a 6 px di distanza in un angolo da 170 px.
                            */
                            <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10 pointer-events-auto">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void scaricaMedia(item, url);
                                    }}
                                    className="h-9 w-9 rounded-lg bg-white/90 hover:bg-white text-kidville-green flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer border border-kidville-line"
                                    title={t('mediaScarica')}
                                >
                                    <Download size={14} strokeWidth={2.5} />
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void condividiMedia(item, url, t('mediaLinkCopiato'));
                                    }}
                                    className="h-9 w-9 rounded-lg bg-white/90 hover:bg-white text-kidville-green flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer border border-kidville-line"
                                    title={t('mediaCondividi')}
                                >
                                    <Share2 size={14} strokeWidth={2.5} />
                                </button>
                            </div>
                        )}
                    </motion.div>
                    );
                })}
            </div>

            {/*
              IL VISORE — TRE NODI, E OGNUNO CHIUDE UN DIFETTO MISURATO.

              ─── COM'ERA, E COSA COSTAVA ─────────────────────────────────────────
              Un nodo solo: `fixed inset-0` + `backdrop-blur-xl` + `flex
              justify-center` + `overflow-hidden`. Su iPhone 14 (390×844, meno le aree
              di sicurezza = 763 px utili) la colonna misura ~840 px — immagine 464 +
              didascalia 52 + pannello dei taggati 200 + «Elimina Media» 52 + margini
              72. Mancano ~80 px e l'ultimo figlio è proprio il bottone: finiva sotto
              il bordo, senza barra di scorrimento perché `overflow-hidden` non scorre
              e senza nessun gesto per raggiungerlo. Il titolare, dall'app, ha
              riferito che «Elimina non esiste». Esisteva.

              ─── (a) IL CONTENITORE è nudo ───────────────────────────────────────
              Solo posizione e z-index. Frecce e chiusura sono suoi figli diretti,
              FUORI dallo scroller: così non scorrono via col contenuto.

              ─── (b) IL VELO È UN FRATELLO, e non è estetica ─────────────────────
              Sulla WebView Chromium di Android un antenato con `backdrop-filter`
              CANCELLA l'intero sottoalbero dall'albero di accessibilità: col velo sul
              contenitore, `uiautomator dump` restituiva 120 nodi e nessuno era della
              modale — per TalkBack la finestra non esisteva. È una lezione già pagata
              in questo repo: sta scritta per esteso in `src/components/ui/Modal.tsx`,
              che per questo mette la sfocatura su un div fratello `aria-hidden`.

              ─── (c) LO SCROLLER ────────────────────────────────────────────────
              `absolute inset-0 overflow-y-auto overscroll-contain`, e dentro un
              `flex min-h-full items-center justify-center`: centrato quando il
              contenuto ci sta, ancorato in alto e scorrevole quando non ci sta —
              cosa che `items-center` da solo non fa (taglia il bordo di sopra).
              `overscroll-contain` perché su iOS, arrivati a fine corsa, il gesto
              proseguirebbe trascinando la pagina sotto.
              Il riempimento ingloba `env(safe-area-inset-*)`: nel browser e su
              Android valgono 0, su iPhone sono la Dynamic Island e la barra di casa.

              La chiusura al click fuori sta sullo SCROLLER e non sul velo: il velo
              gli è sotto, quindi nessun tocco lo raggiunge. La colonna ferma la
              propagazione, come prima.
            */}
            {lightbox && (
                <div
                    ref={visoreRef}
                    role="dialog"
                    aria-modal="true"
                    /* Il nome del dialogo è quello del media aperto: la STESSA funzione
                       che nomina la card, così l'annuncio all'apertura combacia con
                       quello del comando che si è premuto. */
                    aria-label={etichettaCard(lightbox, t)}
                    tabIndex={-1}
                    /* `z-[115]` E NON `z-50` — vedi il commento del dialogo di
                       eliminazione qui sotto, che questa riga chiude: misurato il
                       2026-09-12 su iPhone 16e, a pari livello la bottom-nav
                       (dichiarata DOPO `<main>`) dipingeva sopra il visore e
                       teneva l'ultimo comando della colonna sotto di sé, a
                       scroller finito. 115 è il livello che `ui/cockpit.tsx` usa
                       già per stare sopra tutto il chrome (topbar e sidebar
                       `z-[105]`, foglio «Menu» `z-[110]`, filtri `z-[112]`).
                       Lock: `__tests__/architecture/visore-media-sopra-la-bottom-nav`. */
                    className="fixed inset-0 z-[115] focus:outline-none"
                >
                    <motion.div
                        aria-hidden="true"
                        data-testid="visore-velo"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="absolute inset-0 bg-white/70 backdrop-blur-xl"
                    />

                    {/* Navigation Arrows */}
                    {currentIndex > 0 && (
                        <button
                            onClick={handlePrev}
                            className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/80 hover:bg-white text-kidville-green flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all z-20 cursor-pointer border border-kidville-line"
                            title={t('mediaPrecedente')}
                        >
                            <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.5} />
                        </button>
                    )}
                    {currentIndex < items.length - 1 && (
                        <button
                            onClick={handleNext}
                            className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/80 hover:bg-white text-kidville-green flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-all z-20 cursor-pointer border border-kidville-line"
                            title={t('mediaSuccessiva')}
                        >
                            <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.5} />
                        </button>
                    )}

                    <div
                        data-testid="visore-scorrimento"
                        className="absolute inset-0 overflow-y-auto overscroll-contain z-10"
                        onClick={handleCloseLightbox}
                    >
                    {/* ⚠️ I DUE INVOLUCRI QUI SOTTO NON SONO RIENTRATI DI PROPOSITO: rientrarli
                        vorrebbe dire spostare di quattro spazi le ~200 righe della colonna, e un
                        diff di 200 righe di spazi nasconde le tre che contano. La chiusura è
                        marcata in fondo. */}
                    <div className="flex min-h-full items-center justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
                    <div data-testid="visore-colonna" className="relative max-w-2xl w-full" onClick={e => e.stopPropagation()}>
                        <div className="relative bg-white rounded-2xl overflow-hidden shadow-xl p-3 border border-kidville-green/10">
                            {!urlVisore ? (
                                /* Firma non riuscita: si dice, non si mostra un riquadro rotto. */
                                <div className="w-full min-h-[35svh] rounded-xl bg-kidville-cream flex flex-col items-center justify-center gap-2 px-6 text-center">
                                    <ImageOff size={32} className="text-kidville-green/70" strokeWidth={1.5} />
                                    <span className="font-maven text-sm text-kidville-green/70">
                                        {t('galleryAnteprimaNonDisponibile')}
                                    </span>
                                </div>
                            ) : lightbox.file_type === 'video' ? (
                                /*
                                  VIDEO E IMMAGINE HANNO LA STESSA REGOLA, ed è un invariante:
                                  due media aperti nello stesso visore non possono comportarsi
                                  in due modi. Il video aveva `w-full max-h-[55vh]` e nessun
                                  rapporto d'aspetto — un video verticale (cioè tutti quelli
                                  girati col telefono) veniva allargato alla colonna e
                                  guarnito di due fasce nere ai lati.
                                  `w-auto max-w-full` lascia decidere al rapporto d'aspetto;
                                  `object-contain` non taglia niente.
                                  `svh` E NON `vh`: su Safari iOS `vh` è il viewport GRANDE,
                                  quello senza la barra degli indirizzi, quindi `70vh` vale più
                                  del 70% di ciò che si vede — di nuovo contenuto fuori campo.
                                  `playsInline` perché senza di lui iOS apre il video a schermo
                                  pieno da solo, `preload="metadata"` perché senza la WebView
                                  può tirarsi giù l'intero file.
                                  `bg-black` resta: è il letterbox di un player, ed è il caso
                                  che il lock `palette-di-serie` dichiara legittimo per scritto.
                                */
                                <video src={urlVisore} controls playsInline preload="metadata"
                                    className="mx-auto max-h-[70svh] w-auto max-w-full object-contain rounded-xl bg-black" />
                            ) : (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={urlVisore} alt={lightbox.caption ?? t('galleryAltFoto')}
                                    className="mx-auto max-h-[70svh] w-auto max-w-full object-contain rounded-xl" />
                            )}
                        </div>

                        {/* Caption */}
                        {lightbox.caption && (
                            <p className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide text-center mt-4 mb-2">{lightbox.caption}</p>
                        )}

                        {/* Tagged Students Info (Teacher Side) */}
                        {students && students.length > 0 && (
                            <div className="mt-3 bg-kidville-cream/40 border border-kidville-green/10 rounded-2xl p-4 text-kidville-green">
                                <div className="flex items-center justify-between mb-2 pb-2 border-b border-kidville-green/10">
                                    <h3 className="font-barlow font-bold text-xs uppercase tracking-wide text-kidville-green/70">
                                        {t('galleryTaggatiTitolo')}
                                    </h3>
                                    {onUpdateTags && !editMode && (
                                        <button
                                            onClick={() => {
                                                setEditMode(true);
                                                setTempTagged(lightbox.tag_students ?? []);
                                            }}
                                            className="px-3 py-1 bg-kidville-green/10 hover:bg-kidville-green/20 text-kidville-green rounded-lg text-xs font-semibold tracking-wide transition-colors"
                                        >
                                            ✏️ {t('galleryModificaTag')}
                                        </button>
                                    )}
                                </div>

                                {editMode ? (
                                    <div className="space-y-3">
                                        {/* Una colonna sul telefono, due quando c'è spazio: in
                                            vista di sede i nomi sono «Nome Cognome — SEZIONE» e
                                            in mezza colonna da 358 px non ci stanno. `max-h-40`
                                            invece di `max-h-32` perché con 32 si vedevano due
                                            righe e mezzo, e la mezza riga sembra la fine
                                            dell'elenco. */}
                                        <div data-testid="taggati-elenco" className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                                            {students.map((student) => {
                                                const isTagged = tempTagged.includes(student.id);
                                                return (
                                                    /* `min-w-0` sulla label: un figlio di flex/grid non
                                                       scende sotto la larghezza del proprio contenuto, e
                                                       senza di questo il `truncate` sul nome non ha
                                                       nessun effetto — il chip sfonda comunque. */
                                                    <label
                                                        key={student.id}
                                                        className={`flex min-w-0 items-center gap-2 px-3 py-1.5 rounded-xl border text-xs cursor-pointer select-none transition-all ${
                                                            isTagged
                                                                ? 'bg-kidville-success-soft border-kidville-success text-kidville-success font-semibold shadow-sm'
                                                                : 'bg-white border-kidville-line text-kidville-sub hover:bg-kidville-cream'
                                                        }`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={isTagged}
                                                            onChange={() => {
                                                                setTempTagged((prev) =>
                                                                    prev.includes(student.id)
                                                                        ? prev.filter((id) => id !== student.id)
                                                                        : [...prev, student.id]
                                                                );
                                                            }}
                                                            className="hidden"
                                                        />
                                                        <span className="truncate" title={`${student.nome} ${student.cognome}`}>
                                                            {student.nome} {student.cognome}
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-kidville-green/10">
                                            <button
                                                onClick={() => setEditMode(false)}
                                                className="px-3 py-1 bg-kidville-neutral-soft hover:bg-kidville-cream-dark rounded-lg text-xs font-semibold text-kidville-sub transition-colors"
                                            >
                                                {t('galleryAnnulla')}
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    setSavingTags(true);
                                                    try {
                                                        await onUpdateTags?.(lightbox.id, tempTagged);
                                                        setLightbox({ ...lightbox, tag_students: tempTagged });
                                                        setEditMode(false);
                                                    } catch {
                                                        logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-salva-tag-fallito', route: '/gallery' });
                                                    } finally {
                                                        setSavingTags(false);
                                                    }
                                                }}
                                                disabled={savingTags}
                                                className="px-3 py-1 bg-kidville-success hover:opacity-90 disabled:opacity-55 rounded-lg text-xs font-semibold text-white transition-colors"
                                            >
                                                {savingTags ? t('gallerySalvataggio') : t('gallerySalva')}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {(lightbox.tag_students ?? []).length === 0 ? (
                                            <span className="text-xs text-kidville-sub italic">{t('galleryNessunTaggato')}</span>
                                        ) : (
                                            (lightbox.tag_students ?? []).map((id) => {
                                                const student = students.find((s) => s.id === id);
                                                if (!student) return null;
                                                return (
                                                    /* `max-w-full truncate` + `title`: nella vista di
                                                       sede il nome è «Nome Cognome — SEZIONE», e un chip
                                                       senza tetto di larghezza sfonda la colonna. Il
                                                       nome intero resta leggibile al passaggio. */
                                                    <span
                                                        key={id}
                                                        title={`${student.nome} ${student.cognome}`}
                                                        className="px-2.5 py-1 bg-kidville-green/10 border border-kidville-green/20 rounded-full text-xs font-semibold max-w-full truncate"
                                                    >
                                                        {student.nome} {student.cognome}
                                                    </span>
                                                );
                                            })
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Actions.
                            `flex-wrap` e gap più stretto: le tre etichette italiane
                            («Scarica» ~126 px, «Condividi» ~144, «Segnala foto/video» ~200)
                            più i gap fanno ~494 px in 358 disponibili sul telefono, e con
                            `justify-center` l'eccesso si divide fra i due lati — ~68 px
                            tagliati a sinistra e ~68 a destra, cioè metà della prima pillola
                            e metà dell'ultima. Andare a capo costa una riga in più; non
                            andarci costa due comandi. */}
                        {showActions && (
                            <div data-testid="visore-comandi" className="flex flex-wrap items-center justify-center gap-2 mt-4">
                                {/* Gli STESSI due gesti della card, e nient'altro: la
                                    duplicazione fra questi due punti è ciò che aveva
                                    lasciato la card senza nemmeno un log. */}
                                {urlVisore && <button
                                    onClick={() => { void scaricaMedia(lightbox, urlVisore); }}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green hover:bg-kidville-green/90 text-white rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm">
                                    <Download size={14} strokeWidth={2.5} /> {t('mediaScarica')}
                                </button>}
                                {urlVisore && <button
                                    onClick={() => { void condividiMedia(lightbox, urlVisore, t('mediaLinkCopiatoLungo')); }}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-kidville-yellow hover:bg-kidville-yellow/90 text-kidville-green rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm">
                                    <Share2 size={14} strokeWidth={2.5} /> {t('mediaCondividi')}
                                </button>}
                                {/* Segnalazione contenuto (C5 §2): sempre etichettata, lato genitore. */}
                                <SegnalaContenuto
                                    tipoOggetto="media_galleria"
                                    oggettoId={lightbox.id}
                                    label={t('mediaSegnala')}
                                    variant="pill"
                                />
                            </div>
                        )}

                        {/*
                          ELIMINA — E IL COMANDO RESTA SOLO QUI, non sulla miniatura.
                          Una tessera da 171 px ha già due bersagli in un angolo
                          (Scarica, Condividi): un terzo, DISTRUTTIVO, significa
                          cancellare la foto di un minore con un pollice. Il gesto sta
                          dove si è già scelto di guardare quella foto.

                          E adesso non elimina: CHIEDE. Prima faceva
                          `onDelete(id); handleCloseLightbox();` — due righe di cui la
                          seconda non aspetta la prima.
                        */}
                        {puoEliminare(lightbox) && (
                            <button onClick={() => setDaEliminare(lightbox)}
                                className="mt-4 mx-auto flex items-center gap-1 px-4 py-2 bg-kidville-error hover:opacity-90 text-white rounded-full font-maven text-xs font-semibold transition-colors cursor-pointer">
                                🗑️ {t('galleryEliminaMedia')}
                            </button>
                        )}
                    </div>{/* /visore-colonna */}
                    </div>{/* /involucro flex centrante */}
                    </div>{/* /visore-scorrimento */}

                    {/* Close button. Fuori dallo scroller — non scorre via — e con la
                        safe-area in cima: a `top-4` fisso, su iPhone finisce sotto la
                        Dynamic Island. */}
                    <button onClick={handleCloseLightbox}
                        className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 w-10 h-10 rounded-full bg-kidville-green/10 text-kidville-green flex items-center justify-center hover:bg-kidville-green/20 transition-colors shadow-sm font-bold z-20">
                        ✕
                    </button>

                    {/*
                      LA CONFERMA È FIGLIA DEL VISORE, E FRATELLA DELLO SCROLLER —
                      non un nipote. Due ragioni misurate, non estetiche:

                      · lo scroller porta `onClick={handleCloseLightbox}` («clic
                        fuori = chiudi»). Un dialogo reso DENTRO di lui farebbe
                        risalire ogni clic sul proprio velo fin lì: il visore si
                        chiuderebbe portandosi via la conferma, cioè l'annullamento
                        per distrazione che `closeOnBackdrop={false}` esiste per
                        impedire;
                      · dentro il visore e non fuori perché l'effetto del visore
                        marca `inert` tutto ciò che gli sta FUORI: un dialogo là
                        nascerebbe inerte, cioè con i suoi due comandi
                        irraggiungibili. Il registro di `inerti` conta per elemento,
                        quindi l'inerzia che `Modal` aggiunge sopra si somma e si
                        sottrae senza scoprire lo sfondo del visore.

                      ⚠️ IL `z-[120]` DI `Modal`, ANNIDATO QUI, È CLAMPATO — va
                      saputo prima di fidarsene, e resta vero anche adesso. Il
                      visore è `fixed inset-0 z-[115]`: posizione più `z-index`
                      diverso da `auto` creano un CONTESTO D'IMPILAMENTO, quindi
                      il `z-[120]` del Modal si risolve DENTRO quel contesto e non
                      può superare il livello del visore rispetto ai suoi
                      FRATELLI. Non è un difetto: là dentro gli basta stare sopra
                      i figli del visore (`z-10` lo scroller, `z-20` le frecce e
                      la ✕), e ci sta.

                      ─── LA MISURA È ARRIVATA, E LA RIGA È STATA SCRITTA ────────
                      Questo commento, fino al 2026-09-12, diceva: «il visore è
                      `z-50`, la bottom-nav è `fixed bottom-0 … z-50` e nel layout
                      viene DOPO `<main>{children}</main>`, cioè stesso livello e
                      più avanti nel DOM — dipinge sopra il visore. NON È CORRETTO
                      A OCCHIO DI PROPOSITO: una sovrapposizione vera dei bottoni
                      non è dimostrata ai formati comuni, e jsdom non ha layout.
                      Si misura nel browser vero. Se la misura dirà che c'è, la
                      correzione è una riga: da `z-50` a `z-[115]`».

                      **La misura ha detto che c'è.** Simulatore iPhone 16e
                      (390×844, iOS 26.2), app nativa contro `app.kidville.it`, un
                      video VERTICALE aperto nel visore: lo scroller arriva a fine
                      corsa — due schermate dopo due gesti risultavano identiche
                      al byte — e di «Elimina Media» restava una striscia rossa di
                      ~4 px sotto la pastiglia della barra. Non era «non
                      dimostrata ai formati comuni»: era invisibile al formato più
                      comune che esista, un filmato ripreso col telefono in
                      verticale. Ciò che la nascondeva non era il dialogo compatto
                      di cui parla il paragrafo qui sopra — era la COLONNA del
                      visore, che con un video a `max-h-[70svh]` più didascalia,
                      taggati e comando supera l'altezza utile.

                      La riga è scritta (vedi il `className` della radice del
                      visore) e adesso la misura ha un lock che la tiene:
                      `__tests__/architecture/visore-media-sopra-la-bottom-nav`.
                      Effetto collaterale voluto: `rendiInerteFuoriDaConFocus`
                      marca inerte tutto ciò che sta FUORI dal visore, la barra
                      compresa — prima era inerte ma visibile e sopra, cioè il
                      peggio dei due mondi.
                    */}
                    {daEliminare && eliminaIlMedia && (
                        <DialogoEliminaMedia
                            tipoMedia={daEliminare.file_type}
                            didascalia={daEliminare.caption}
                            onElimina={eliminaIlMedia}
                            /* L'esito è raggiunto: via la conferma E via il visore.
                               Una chiamata sola: `handleCloseLightbox` azzera GIÀ il
                               media catturato, ed è giusto che la regola stia in un
                               posto solo — un `setDaEliminare(null)` anche qui
                               sarebbe un duplicato che nasconde la dipendenza.

                               ⚠️ QUI NON SI RICARICA NIENTE, e il contratto della prop
                               lo dice con le stesse parole: il ricarico è del
                               chiamante, dentro la risoluzione della propria
                               `onDelete`. Questa riga chiude, e basta. L'unico ramo in
                               cui l'elenco resta indietro è il 404 RIGETTATO — il
                               chiamante ha lanciato invece di ricaricare —, ed è
                               scritto nel contratto di `onEliminato` perché non lo
                               scopra qualcun altro a sue spese. */
                            onEliminato={handleCloseLightbox}
                            /* Annullare chiude SOLO la conferma: il visore resta, ed
                               è il posto da cui si è partiti. */
                            onChiudi={() => setDaEliminare(null)}
                            /* LA DELETE IN VOLO SALE FIN QUI, e serve alle due strade
                               che NON passano dal dialogo: la ✕ e lo scroller chiamano
                               `handleCloseLightbox` direttamente, e quella smonta la
                               conferma. `eliminaInVolo` è un `ref` e non uno stato: il
                               perché — e cosa di quel perché è misurato e cosa no —
                               sta sulla sua dichiarazione. */
                            onInVolo={(inVolo) => { eliminaInVolo.current = inVolo; }}
                        />
                    )}
                </div>
            )}
        </>
    );
}
