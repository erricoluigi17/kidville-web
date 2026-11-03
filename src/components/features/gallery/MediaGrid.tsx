'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { logClient } from '@/lib/logging/client';
import type { TipoMedia } from '@/lib/native/scarica';
import { Play, ImageOff } from 'lucide-react';
import { useState, useCallback, useMemo, useRef } from 'react';
import { SegnalaContenuto } from '@/components/features/segnalazioni/SegnalaContenuto';
import { DialogoEliminaMedia } from '@/components/features/gallery/DialogoEliminaMedia';
import { PulsantiCardMedia } from '@/components/features/gallery/PulsantiCardMedia';
import { ComandiMedia } from '@/components/features/media/ComandiMedia';
import { useAzioniMedia, type MediaAzionabile } from '@/components/features/media/useAzioniMedia';
import { VisoreMedia, type MediaVisore } from '@/components/features/media/VisoreMedia';

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
    /**
     * I comandi del GENITORE: Scarica, Condividi e — nel visore — «Segnala
     * foto/video» (C5 §2). Non si riusa per lo staff: la segnalazione di un
     * contenuto è un gesto della famiglia verso la scuola, non della scuola verso
     * sé stessa. Per docenti e Segreteria c'è `scaricabile`, qui sotto.
     */
    showActions?: boolean;
    /**
     * SOLO «Scarica», sulla card e nel visore — per docenti e Segreteria
     * (spec 2026-09-24 §7: «Scarica» in galleria anche per docenti e Segreteria).
     *
     * Una prop dedicata e non `showActions`, di proposito: `showActions` porta con sé
     * anche Condividi e Segnala, che sono gesti pensati per il genitore. Lo scarico è
     * lo STESSO del genitore (stessa funzione, stessa guardia, stessi log): cambia
     * soltanto quali comandi compaiono accanto. Con `showActions` è implicita.
     */
    scaricabile?: boolean;
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

/*
 * SCARICA E CONDIVIDI NON STANNO PIÙ QUI — stanno in `useAzioniMedia` (`../media/useAzioniMedia`),
 * che serve anche il visore della chat. Qui restano due cose: costruire il `MediaAzionabile` di
 * una riga (`mediaAzionabile`, sotto) e disegnare i pulsanti della card.
 *
 * Due perché stanno altrove: quello dell'esito che finisce SEMPRE in `app_log` (successo compreso,
 * `warn` anche per un successo perché `/api/logs` accetta solo `warn|error`, lo stato HTTP nel
 * messaggio e non in `stato`) è su `registraEsito` di `@/lib/native/scarica`, che lo scrive da sé;
 * quello della guardia «un'azione alla volta», che logga la pressione scartata
 * (`gallery-scarico-gia-in-corso`), è sull'hook.
 */

/**
 * Il tipo che l'helper vuole (`foto` | `video`), dal `file_type` della riga.
 * Tutto ciò che non è `video` è una foto: è la stessa regola di `estensioneMedia`
 * (un tipo sconosciuto diventa `.jpg`). Sbagliarlo non è innocuo: un video passato
 * come `foto` finisce in `savePhoto`, e la Galleria lo rifiuta.
 */
function tipoMedia(fileType: string): TipoMedia {
    return (fileType ?? '').trim().toLowerCase() === 'video' ? 'video' : 'foto';
}

/**
 * Ciò che serve ai due gesti (scarica, condividi) di una riga della galleria.
 *
 * `nomeFile` è la didascalia GREZZA: la ripulisce e le dà l'estensione `nomeFileScarico`, dentro
 * l'hook. `titolo` è la didascalia o, se manca, il neutro «Foto da Kidville» dell'hook: mai un
 * nome di persona. `chiave` per la condivisione è `id`: l'indirizzo firmato cambia a ogni
 * ricarico dell'elenco, l'id della riga no.
 */
function mediaAzionabile(item: MediaItem, url: string): MediaAzionabile {
    return {
        id: item.id,
        url,
        tipo: tipoMedia(item.file_type),
        nomeFile: item.caption,
        ...(item.caption !== null ? { titolo: item.caption } : {}),
    };
}

/**
 * Ciò che il visore chiede di un media: id, indirizzo, tipo e testo alternativo.
 * Il tipo è `video` SOLO per `file_type === 'video'`, alla lettera, come la card e come il
 * visore di prima: `tipoMedia` qui sopra è più largo (taglia gli spazi, ignora le maiuscole)
 * e farebbe aprire come video un media che la miniatura mostra come foto.
 */
function mediaDelVisore(item: MediaItem, t: Traduttore): MediaVisore {
    return {
        id: item.id,
        url: item.file_url,
        tipo: item.file_type === 'video' ? 'video' : 'foto',
        alt: item.caption ?? t('galleryAltFoto'),
    };
}

function timeAgo(iso: string, t: Traduttore): string {
    const diff = Date.now() - new Date(iso).getTime();
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return t('galleryOra');
    if (hrs < 24) return t('galleryOreFa', { n: hrs });
    const days = Math.floor(hrs / 24);
    return t('galleryGiorniFa', { n: days });
}

export function MediaGrid({ items, showActions, scaricabile, onDelete, eliminabile, students, onUpdateTags, colonne = 2 }: Props) {
    const t = useTranslations('shared');
    /** «Scarica» compare: col genitore (`showActions`) o con la prop del solo scarico. */
    const conScarica = Boolean(showActions || scaricabile);
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
     * SCARICA E CONDIVIDI: UN HOOK SOLO, CHIAMATO UNA VOLTA — è la guardia «un'azione alla volta» di
     * tutta la griglia. Le card e il visore ne ricevono lo STESSO risultato: due card diverse non
     * devono poter scaricare insieme (su iOS un secondo foglio di condivisione, mentre il primo è
     * aperto, solleva). Il perché per esteso, e gli avvisi d'esito, sono in `useAzioniMedia`.
     */
    const azioni = useAzioniMedia({ etichetta: 'gallery' });

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
     * (Dal 2026-11-03 le strade dirette sono QUATTRO: il visore è `VisoreMedia`, che per
     * ✕, tocco sullo scroller, `Escape` e tasto Indietro di Android chiama la `onChiudi`
     * che riceve da qui — `handleCloseLightbox`, con la sua guardia. La guardia non è
     * cambiata: sono arrivate due strade nuove, e passano dallo stesso imbuto.)
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
     * la stessa ragione della guardia di `useAzioniMedia`, qui sopra. Il segnale a schermo c'è
     * già, ed è lo spinner sul bottone della conferma.
     */
    const eliminaInVolo = useRef(false);

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
             * La pressione scartata si LOGGA, come già fa `useAzioniMedia` con lo
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
         * Non è un caso di scuola: lo scroller del visore chiama `handleCloseLightbox`
         * (è la sua `onChiudi`) e col dialogo aperto dovrebbe essere coperto da `inert`, ma `inert` è di
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

    // Indirizzo firmato del media aperto nel visore, in una const: `null` quando la
    // firma non è riuscita (bucket privato → link a tempo generato dalla GET).
    const urlVisore = lightbox?.file_url ?? null;

    /**
     * I MEDIA DEL VISORE: le card della griglia, nell'ordine in cui si scorrono.
     *
     * Due scelte che servono a lasciare il visore COM'ERA quando era qui dentro:
     *
     *  · il media APERTO si legge da `lightbox` (lo stato) e non da `items`: `lightbox`
     *    porta i tag appena salvati e, soprattutto, l'indirizzo firmato con cui il visore
     *    si è aperto. Se la pagina ricarica l'elenco a visore aperto (gli indirizzi
     *    vengono ri-firmati) l'immagine a schermo non cambia sotto gli occhi di chi la
     *    guarda, come prima;
     *  · se `lightbox` non è più in `items` (il ricarico dopo un'eliminazione arriva PRIMA
     *    della chiusura, e la conferma deve restare montata fino all'esito) lo si mette in
     *    testa: il visore resta aperto sul suo media, senza ‹, con › verso il primo
     *    dell'elenco — quello che faceva con l'indice a -1.
     */
    const elementiVisore = useMemo<MediaVisore[]>(() => {
        const elenco = items.map((item) => mediaDelVisore(lightbox && lightbox.id === item.id ? lightbox : item, t));
        if (lightbox && !items.some((item) => item.id === lightbox.id)) elenco.unshift(mediaDelVisore(lightbox, t));
        return elenco;
    }, [items, lightbox, t]);

    /** Le frecce ‹ › e i tasti ← →: il visore chiede un media, qui lo si apre. */
    const cambiaMedia = useCallback((id: string) => {
        const item = items.find((i) => i.id === id);
        if (!item) return;
        setLightbox(item);
        setEditMode(false);
        setTempTagged(item.tag_students ?? []);
    }, [items]);

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
            <div data-testid="griglia-media" data-kv-colonne={colonne} className={`grid ${CLASSI_COLONNE[colonne]} gap-3`}>
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

                        {/* Pulsanti Download e Condividi diretti sulla card (`PulsantiCardMedia`: lì
                            stanno lo stato «Preparo…» e il perché dei 36 px e del «sempre visibili»).
                            Senza indirizzo firmato non possono fare nulla: si tolgono,
                            invece di offrire un bottone che scarica un errore. */}
                        {conScarica && url && (
                            <PulsantiCardMedia
                                media={mediaAzionabile(item, url)}
                                azioni={azioni}
                                conCondividi={Boolean(showActions && azioni.puoCondividere)}
                            />
                        )}
                    </motion.div>
                    );
                })}
            </div>

            {/*
              IL VISORE È `VisoreMedia` (`../media/VisoreMedia`), lo stesso della chat: qui
              restano solo i suoi extra, passati come figli — didascalia, tag, Scarica /
              Condividi / Segnala, Elimina — e il dialogo di conferma, passato come
              `sovrapposti`. La struttura a tre nodi, il livello `z-[115]`, il portale su
              `body`, il fuoco, l'inerzia dello sfondo e le frecce sono spiegati lì.
            */}
            {lightbox && (
                <VisoreMedia
                    elementi={elementiVisore}
                    apertoId={lightbox.id}
                    onCambia={cambiaMedia}
                    /* La guardia sulla chiusura è QUESTA funzione, non il visore: ✕, tocco
                       fuori, `Escape` e il tasto Indietro di Android passano tutti da
                       `handleCloseLightbox`, che con l'eliminazione in volo non chiude. */
                    onChiudi={handleCloseLightbox}
                    /* Il nome del dialogo è quello del media aperto: la STESSA funzione
                       che nomina la card, così l'annuncio all'apertura combacia con
                       quello del comando che si è premuto. */
                    etichetta={(m) => (m.id === lightbox.id ? etichettaCard(lightbox, t) : m.alt)}
                    /* ⚠️ `daEliminare` NON È UNA RIFINITURA: col dialogo di conferma aperto le
                       frecce non devono cambiare il media dietro di lui. Il dialogo nomina e
                       cancella quello che ha catturato all'apertura. */
                    tastiBloccati={daEliminare !== null}
                    /*
                      LA CONFERMA È FIGLIA DEL VISORE E FRATELLA DEL SUO SCROLLER (per questo
                      passa da qui e non sta tra i figli): il perché — il clic fuori che
                      chiuderebbe anche lei, `inert` che la renderebbe irraggiungibile, il
                      `z-[120]` di `Modal` clampato dal contesto d'impilamento del visore —
                      sta scritto per esteso in `VisoreMedia`, sul punto in cui li rende.
                    */
                    sovrapposti={daEliminare && eliminaIlMedia ? (
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
                    ) : null}
                >
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

                    {/* Actions: la riga è `ComandiMedia`, la stessa della chat.
                        `flex-wrap` e gap più stretto (li porta lei): le tre etichette italiane
                        («Scarica» ~126 px, «Condividi» ~144, «Segnala foto/video» ~200)
                        più i gap fanno ~494 px in 358 disponibili sul telefono, e con
                        `justify-center` l'eccesso si divide fra i due lati — ~68 px
                        tagliati a sinistra e ~68 a destra, cioè metà della prima pillola
                        e metà dell'ultima. Andare a capo costa una riga in più; non
                        andarci costa due comandi.
                        Senza indirizzo firmato `ComandiMedia` non mostra né Scarica né
                        Condividi (e se non resta niente, nemmeno la riga: niente `mt-4` vuoto
                        in mezzo al visore); «Segnala» del genitore resta, come prima.
                        Gli STESSI due gesti della card, e dalla stessa guardia: la duplicazione
                        fra questi due punti è ciò che aveva lasciato la card senza nemmeno un log. */}
                    <ComandiMedia
                        media={mediaAzionabile(lightbox, urlVisore ?? '')}
                        azioni={azioni}
                        conScarica={conScarica}
                        conCondividi={Boolean(showActions)}
                        extra={showActions ? (
                            /* Segnalazione contenuto (C5 §2): sempre etichettata, SOLO lato
                               genitore — con `scaricabile` (staff) non compare. */
                            <SegnalaContenuto
                                tipoOggetto="media_galleria"
                                oggettoId={lightbox.id}
                                label={t('mediaSegnala')}
                                variant="pill"
                            />
                        ) : null}
                    />

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
                </VisoreMedia>
            )}
        </>
    );
}
