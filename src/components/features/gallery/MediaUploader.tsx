'use client';

import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Camera, FolderOpen, X, Image as ImageIcon, Images } from 'lucide-react';
import { useImagePicker } from '@/lib/native/use-image-picker';
import { fotocameraNativaDisponibile } from '@/lib/native/camera';
import type { CodiceFotocamera } from '@/lib/native/camera';
import {
    annullaScelta,
    ascoltaPreparazione,
    caricamentiNativiDisponibili,
    codiceDelPonte,
    scegliMedia,
} from '@/lib/native/caricamenti-nativi';
import {
    LATO_MASSIMO_FOTO,
    opzioniScegliMedia,
    type ElementoFotoScelta,
    type ElementoRifiutato,
    type ElementoScelto,
    type ElementoVideoScelto,
    type EsitoScelta,
    type InfoCaricamenti,
    type MotivoRifiuto,
    type SorgenteScelta,
} from '@/lib/native/caricamenti-nativi-tipi';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { classificaFileGalleria } from '@/lib/gallery/classifica-file';
import {
    CHIAVE_RIFIUTO,
    MAX_ELEMENTI_PER_SCELTA,
    contaRifiutiPerMotivo,
    formattaDurata,
    idNativi,
    limitaElementi,
    nomeElemento,
    postiRimasti,
    riepilogaElementiNativi,
    type ElementoCaricabile,
} from '@/lib/gallery/selettore-media';
import { elementoCaricabileDaVideo, leggiFotoComeFile, scartaPreparatiNativi } from '@/lib/gallery/selettore-nativo';
import { formattaMegabyte } from '@/lib/i18n/numero';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { AnteprimaMedia } from './AnteprimaMedia';
import { useTracciaSelettore } from './use-traccia-selettore';

interface Props {
    /**
     * Porta le scelte al passo dei bambini. Da qui in poi gli elementi NATIVI (video preparati sul
     * telefono, senza `File`) sono di chi li riceve: sta a lui scartarli se non partono (spec §7.3).
     */
    onUpload: (files: ElementoCaricabile[]) => void;
}

type ElementoAccettato = ElementoFotoScelta | ElementoVideoScelto;
const eAccettato = (e: ElementoScelto): e is ElementoAccettato => e.tipo !== 'rifiutato';
const eRifiutato = (e: ElementoScelto): e is ElementoRifiutato => e.tipo === 'rifiutato';
const eVideo = (e: ElementoAccettato): e is ElementoVideoScelto => e.tipo === 'video';
const eFoto = (e: ElementoAccettato): e is ElementoFotoScelta => e.tipo === 'foto';

type ErroreUploader = 'permesso' | 'configurazione' | 'fotocamera' | 'file' | 'selettore';

/** Un elemento che il plugin non ha accettato: il NOME si mostra a schermo (e basta), il motivo si traduce. */
interface RifiutoMostrato {
    nome: string;
    motivo: MotivoRifiuto;
}

/**
 * I due pulsanti PRINCIPALI dell'app 1.2 (decisione del titolare, spec §2.1): stessa mano del riquadro
 * che sostituiscono — bordo, angoli, icona su fondo crema — ma sono comandi veri, uno per gesto. Lo stato
 * spento si DIPINGE (le stesse tre classi di `Btn`) e non si sbiadisce con un'alfa: vedi il lock
 * `btn-disabilitato-leggibile`. Il colore sta sul pulsante e i figli lo ereditano, così il grigio dello
 * stato spento arriva anche all'icona e alla scritta.
 */
const CLASSE_PULSANTE_PRINCIPALE =
    'flex w-full items-center gap-4 rounded-3xl border-2 border-kidville-line p-5 text-left text-kidville-green transition-all hover:border-kidville-green/50 hover:bg-kidville-cream/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kidville-green active:scale-[0.99] disabled:pointer-events-none disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub';

/** I comandi SECONDARI (link sottolineato): «Scatta una foto» nell'impaginato della PR 2, «Scegli da File», «Usa il selettore del browser». */
const CLASSE_PULSANTE_SECONDARIO =
    'mx-auto flex min-h-11 items-center gap-2 rounded-pill px-4 py-2 font-maven text-xs font-bold text-kidville-green underline underline-offset-2 transition-opacity hover:opacity-80 disabled:pointer-events-none disabled:text-kidville-sub';

export function MediaUploader({ onUpload }: Props) {
    const t = useTranslations('shared');
    const locale = useLocale();
    const [previews, setPreviews] = useState<ElementoCaricabile[]>([]);
    // La COPIA su cui si ragiona, aggiornata a ogni modifica insieme allo stato (`aggiornaPreviews`):
    // `addFiles` è asincrona, e il tetto dei 50 si decide su quanti file ci sono ORA, non su quanti ce
    // n'erano al render che l'ha creata. Lo stato resta ciò che si disegna; il ref ciò che si conta.
    const previewsRef = useRef<ElementoCaricabile[]>([]);
    const [dragOver, setDragOver] = useState(false);
    const [errore, setErrore] = useState<ErroreUploader | null>(null);
    // Una scelta ha superato il tetto di MAX_ELEMENTI_PER_SCELTA: l'avviso in linea (non è un errore).
    const [oltreIlMassimo, setOltreIlMassimo] = useState(false);
    // ── L'APP 1.2 (spec «caricamenti nativi» §7.2) ────────────────────────────────────────────────
    // Che cosa risponde la rilevazione del plugin: `undefined` = non ha ancora risposto (tetto 3 s: la
    // scelta non si disegna, niente sfarfallio fra i due impaginati), `null` = il plugin non c'è (app
    // 1.0/1.1, o interruttore spento: impaginato della PR 2), un oggetto = l'app 1.2 col plugin.
    const [rilevazione, setRilevazione] = useState<InfoCaricamenti | null | undefined>(undefined);
    // Una scelta nativa è in corso (selettore di sistema aperto, o preparazione dei file): i comandi si spengono.
    const [scegliendo, setScegliendo] = useState(false);
    // «Preparo i file: N di M» — `null` finché il plugin non ha mandato il primo avanzamento.
    const [preparazione, setPreparazione] = useState<{ fatti: number; totali: number } | null>(null);
    // «Annulla» è stato premuto e il plugin non ha ancora risposto: il pulsante non si preme due volte.
    const [annullando, setAnnullando] = useState(false);
    // Gli elementi che il plugin ha rifiutato nell'ultima scelta (nome e motivo, solo per lo schermo).
    const [rifiutati, setRifiutati] = useState<RifiutoMostrato[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const montatoRef = useRef(true);
    // Guardia contro il doppio tocco: lo stato si aggiorna dopo, il ref subito.
    const sceltaInCorsoRef = useRef(false);
    // Gli elementi sono passati al passo dei bambini (`handleSubmit`): da lì sono della pagina.
    const consegnatoRef = useRef(false);
    const idTetto = useId();
    // Le tre righe di log del selettore (aperto, file ricevuti, chiuso senza file): vedi
    // `@/lib/gallery/selettore-media`. Mai il nome del file: qui si passano i File, lì si contano.
    const traccia = useTracciaSelettore(inputRef);

    useEffect(() => {
        montatoRef.current = true;
        return () => {
            montatoRef.current = false;
            // Una scelta nativa ancora in corso si ferma: ciò che sta preparando non lo vedrà nessuno, e
            // sono copie sul telefono (`accogliScelta` scarta quel che arriva comunque a componente morto).
            if (sceltaInCorsoRef.current) {
                annullaScelta().catch((e: unknown) => scriviErroreNativo('selettore-nativo-annulla-fallito', e));
            }
            // I video già scelti che la pagina non ha ricevuto (si esce dal passo prima di «continua»)
            // sono copie da fino a 2 GB che nessuno porterà più avanti: si cancellano ora.
            if (!consegnatoRef.current) void scartaPreparatiNativi(idNativi(previewsRef.current));
        };
    }, []);

    // La rilevazione parte solo dove ha senso: nell'app. Sul web non c'è niente da aspettare e l'area si
    // disegna subito, come prima. `caricamentiNativiDisponibili` non lancia e non aspetta più di 3 s.
    // Web-safe/SSR-safe via useClientValue (nessun hydration mismatch: false finché non idrata il client).
    const nativo = useClientValue(() => fotocameraNativaDisponibile(), false);
    useEffect(() => {
        if (!nativo) return;
        let vivo = true;
        caricamentiNativiDisponibili().then(
            info => { if (vivo) setRilevazione(info); },
            (e: unknown) => {
                // Per contratto non rifiuta mai: se succede è un difetto nostro, e si ripiega sul percorso
                // della PR 2 (che funziona senza il plugin) invece di lasciare la schermata vuota.
                logClient({
                    livello: 'error', evento: 'caricamento-nativo',
                    messaggio: 'caricamenti-nativi-incompleti: errore-imprevisto',
                    campi: { error_code: nomeErrore(e) },
                });
                if (vivo) setRilevazione(null);
            },
        );
        return () => { vivo = false; };
    }, [nativo]);

    const rilevato = !nativo || rilevazione !== undefined;
    const conPlugin = nativo && rilevazione !== undefined && rilevazione !== null;
    const posti = postiRimasti(previews.length);

    const aggiornaPreviews = useCallback((modifica: (prev: ElementoCaricabile[]) => ElementoCaricabile[]) => {
        const prossime = modifica(previewsRef.current);
        previewsRef.current = prossime;
        setPreviews(prossime);
    }, []);

    const addFiles = useCallback(async (fileList: FileList | File[]) => {
        const files = Array.from(fileList);
        if (files.length === 0) return;
        const esiti = await Promise.allSettled(files.map(classificaFileGalleria));
        if (!montatoRef.current) return;
        const validi = esiti.flatMap(esito => esito.status === 'fulfilled' && esito.value ? [esito.value] : []);
        const rifiutati = esiti.length - validi.length;
        if (rifiutati > 0) {
            setErrore('file');
            logClient({
                livello: 'warn', evento: 'js', messaggio: 'gallery-file-selezione-rifiutata',
                campi: { rifiutati, accettati: validi.length, lettura_fallita: esiti.some(esito => esito.status === 'rejected') },
            });
        } else {
            setErrore(null);
        }
        // IL TETTO: al massimo MAX_ELEMENTI_PER_SCELTA (50) foto e video fra quelli già scelti e quelli
        // nuovi. Si tengono i primi nell'ordine in cui il selettore li ha consegnati, gli altri non
        // entrano e l'insegnante lo vede in linea. Nel log solo il CONTEGGIO: mai un nome di file.
        // (`previewsRef` conta anche i video NATIVI: il tetto è sul totale, comunque siano arrivati.)
        const { tenuti, scartati } = limitaElementi(validi, previewsRef.current.length);
        setOltreIlMassimo(scartati > 0);
        if (scartati > 0) {
            logClient({
                livello: 'warn', evento: 'js', messaggio: 'gallery-selezione-oltre-il-massimo',
                campi: { scelti: files.length, aggiunti: tenuti.length, massimo: MAX_ELEMENTI_PER_SCELTA },
            });
        }
        if (tenuti.length > 0) {
            const nuovi = tenuti.map(file => ({ file, preview: URL.createObjectURL(file) }));
            aggiornaPreviews(prev => [...prev, ...nuovi]);
        }
    }, [aggiornaPreviews]);

    const onErroreFotocamera = useCallback((codice: 'permesso_negato' | 'errore', dettaglio?: CodiceFotocamera) => {
        setErrore(codice === 'permesso_negato' ? 'permesso' : dettaglio?.startsWith('plist_') ? 'configurazione' : 'fotocamera');
    }, []);

    // «Scatta una foto»: la fotocamera DIRETTA, su OGNI binario nativo (1.0, 1.1 e 1.2). Prima apriva il
    // foglio «scatta o scegli» del plugin (`CameraSource.Prompt`) — con un'etichetta che promette la
    // fotocamera e un foglio che ne offre due cose (secondario #194 della PR 2). Lato 1920, come le foto
    // che il selettore nativo riduce da sé. Mostra solo foto, una alla volta, e `scegliFotoNativa` ha già
    // i suoi log. La foto scattata confluisce in `addFiles` come un file qualunque.
    const { apri: apriFotocamera } = useImagePicker({
        inputRef,
        onFiles: files => { traccia.fileRicevuti(files); void addFiles(files); },
        multiplo: true,
        onErrore: onErroreFotocamera,
        onAnnullato: () => traccia.annullatoFotocamera(),
        sorgente: 'fotocamera',
        latoMassimo: LATO_MASSIMO_FOTO,
    });

    const ambiente = (): 'app' | 'web' => (fotocameraNativaDisponibile() ? 'app' : 'web');

    // Il selettore del BROWSER (l'`<input>`): sul web è la scelta, nell'app 1.0/1.1 è il riquadro grande, e
    // nell'app 1.2 è il ripiego dopo un errore del selettore nativo («Usa il selettore del browser»).
    // Quei file sono `File` e vanno in TUS dalla pagina, come sul web.
    const apriSelettore = () => {
        setErrore(null);
        setOltreIlMassimo(false);
        setRifiutati([]);
        traccia.apri('selettore-file', ambiente());
        inputRef.current?.click();
    };

    const scattaFoto = () => {
        setErrore(null);
        setOltreIlMassimo(false);
        setRifiutati([]);
        traccia.apri('fotocamera-nativa', ambiente());
        void apriFotocamera();
    };

    // ── LA SCELTA NATIVA (app 1.2): «Scegli foto e video dalla galleria» e «Scegli da File» ──────────

    /** Mette in ascolto l'avanzamento della preparazione. Se non si riesce la scelta va avanti senza barra. */
    const agganciaPreparazione = async (): Promise<(() => Promise<void>) | null> => {
        try {
            return await ascoltaPreparazione(evento => {
                // Un avanzamento in ritardo, a scelta già finita, non deve far ricomparire «Preparo i file».
                if (!montatoRef.current || !sceltaInCorsoRef.current || evento.totali === 0) return;
                setPreparazione(prec => (
                    prec !== null && prec.fatti === evento.fatti && prec.totali === evento.totali
                        ? prec
                        : { fatti: evento.fatti, totali: evento.totali }
                ));
            });
        } catch (e) {
            scriviErroreNativo('selettore-nativo-ascolto-fallito', e);
            return null;
        }
    };

    /**
     * Che cosa se ne fa di ciò che il plugin ha consegnato, nell'ordine:
     *  1. a componente smontato niente di ciò che arriva è visibile a qualcuno: si scarta;
     *  2. `annullato` (selettore chiuso senza scelta, o «Annulla» durante la preparazione) è «chiuso senza file»;
     *  3. le tre righe del selettore (file ricevuti) e l'avviso dei rifiutati, con i NOMI a schermo e mai nei log;
     *  4. il tetto sul TOTALE: gli elementi oltre il tetto non entrano e si scartano dal telefono;
     *  5. i video diventano anteprime native; le foto si leggono una alla volta e seguono `addFiles`.
     */
    const accogliScelta = async (esito: EsitoScelta) => {
        const accettati = esito.elementi.filter(eAccettato);
        if (!montatoRef.current) {
            void scartaPreparatiNativi(accettati.map(e => e.id));
            return;
        }
        if (esito.annullato || esito.elementi.length === 0) {
            traccia.annullatoNativo();
            return;
        }
        traccia.elementiRicevuti(riepilogaElementiNativi(esito.elementi));

        const rifiutatiOra = esito.elementi.filter(eRifiutato);
        if (rifiutatiOra.length > 0) {
            setRifiutati(rifiutatiOra.map(({ nome, motivo }) => ({ nome, motivo })));
            logClient({
                livello: 'warn', evento: 'caricamento-nativo', messaggio: 'selettore-nativo-rifiutati',
                campi: contaRifiutiPerMotivo(esito.elementi),
            });
        }

        // Il plugin riceve «quanti posti restano» come massimo, ma non sempre lo rispetta (il selettore
        // di file di sistema non ha un tetto): il tetto vero lo applica il JS, sul totale.
        const { tenuti, scartati } = limitaElementi(accettati, previewsRef.current.length);
        if (scartati > 0) {
            logClient({
                livello: 'warn', evento: 'js', messaggio: 'gallery-selezione-oltre-il-massimo',
                campi: { scelti: accettati.length, aggiunti: tenuti.length, massimo: MAX_ELEMENTI_PER_SCELTA },
            });
            void scartaPreparatiNativi(accettati.slice(tenuti.length).map(e => e.id));
        }

        const video = tenuti.filter(eVideo);
        if (video.length > 0) aggiornaPreviews(prev => [...prev, ...video.map(elementoCaricabileDaVideo)]);

        // Le foto UNA ALLA VOLTA: `leggiFoto` consegna la foto e la cancella, e 50 foto in base64 insieme
        // sono una pagina intera di memoria. Un componente che si smonta a metà lascia indietro le foto
        // non ancora lette, che si cancellano dal telefono.
        const foto = tenuti.filter(eFoto);
        const lette: File[] = [];
        let nonLette = 0;
        for (let i = 0; i < foto.length; i++) {
            if (!montatoRef.current) {
                void scartaPreparatiNativi(foto.slice(i).map(f => f.id));
                return;
            }
            const letta = await leggiFotoComeFile(foto[i]);
            if (letta) lette.push(letta);
            else nonLette++;
        }
        if (!montatoRef.current) return;
        // Le foto entrano dalla porta di sempre (classificazione, tetto, anteprima): è lei a decidere
        // `errore` e `oltreIlMassimo`, quindi i due avvisi di questa scelta si scrivono DOPO di lei.
        if (lette.length > 0) await addFiles(lette);
        if (!montatoRef.current) return;
        if (nonLette > 0) setErrore('file');
        if (scartati > 0) setOltreIlMassimo(true);
    };

    const scegliDalTelefono = async (sorgente: SorgenteScelta) => {
        if (sceltaInCorsoRef.current) return;
        const postiOra = postiRimasti(previewsRef.current.length);
        // Il pulsante è spento a zero posti, e il ponte rifiuta un massimo sotto 1: nessuna chiamata a vuoto.
        if (postiOra === 0) return;
        sceltaInCorsoRef.current = true;
        setScegliendo(true);
        setErrore(null);
        setOltreIlMassimo(false);
        setRifiutati([]);
        setPreparazione(null);
        setAnnullando(false);
        traccia.apri(sorgente === 'galleria' ? 'selettore-nativo' : 'file-nativo', ambiente());
        const avvio = Date.now();
        let togliAscolto: (() => Promise<void>) | null = null;
        try {
            togliAscolto = await agganciaPreparazione();
            let esito: EsitoScelta;
            try {
                esito = await scegliMedia(opzioniScegliMedia(sorgente, postiOra));
            } catch (e) {
                // Il rifiuto del ponte, ridotto a un CODICE dell'elenco chiuso: mai il suo messaggio. Non è
                // «chiuso senza file»: ha il suo log d'errore, e dichiararlo annullato falserebbe il conteggio.
                logClient({
                    livello: 'error', evento: 'caricamento-nativo',
                    messaggio: `selettore-nativo-errore: ${codiceDelPonte(e)}`,
                    campi: { ms: Date.now() - avvio },
                });
                if (montatoRef.current) setErrore('selettore');
                return;
            }
            await accogliScelta(esito);
        } finally {
            sceltaInCorsoRef.current = false;
            if (togliAscolto) {
                togliAscolto().catch((e: unknown) => scriviErroreNativo('selettore-nativo-ascolto-fallito', e));
            }
            if (montatoRef.current) {
                setScegliendo(false);
                setPreparazione(null);
                setAnnullando(false);
            }
        }
    };

    const annullaPreparazione = () => {
        if (annullando) return;
        setAnnullando(true);
        // `scegliMedia` risolve con `annullato: true` e la preparazione sparisce da sola; se il plugin
        // rifiuta l'annullamento il pulsante torna premibile.
        annullaScelta().catch((e: unknown) => {
            scriviErroreNativo('selettore-nativo-annulla-fallito', e);
            if (montatoRef.current) setAnnullando(false);
        });
    };

    const removeFile = (idx: number) => {
        const daTogliere = previewsRef.current[idx];
        if (!daTogliere) return;
        // Un video nativo è una COPIA sul telefono (nessun objectURL): si cancella. Una foto o un file del
        // browser ha un objectURL, e il blob resterebbe in memoria fino al ricaricamento della pagina.
        if (daTogliere.nativo) void scartaPreparatiNativi([daTogliere.nativo.id]);
        else URL.revokeObjectURL(daTogliere.preview);
        aggiornaPreviews(prev => prev.filter((_, i) => i !== idx));
        // Un posto si è liberato: l'avviso del tetto non descrive più la situazione.
        setOltreIlMassimo(false);
    };

    const handleSubmit = () => {
        if (previews.length === 0) return;
        // Da qui i video nativi sono della pagina: lo smontaggio di questo componente non li scarta.
        consegnatoRef.current = true;
        onUpload(previews);
    };

    // L'avviso del tetto compare anche a zero posti nell'impaginato 1.2: i pulsanti sono spenti, e la frase
    // dice perché (e `aria-describedby` la lega ai pulsanti).
    const mostraTetto = oltreIlMassimo || (conPlugin && posti === 0);
    const comandiSpenti = scegliendo || posti === 0;

    return (
        <div className="space-y-4">
            {/* L'<input> del BROWSER: uno solo, SEMPRE montato e fuori da ogni pulsante. Sta qui e non dentro il
                riquadro perché l'ascoltatore di `cancel` (`useTracciaSelettore`) si aggancia una volta sola, al
                montaggio: con l'area di scelta che si disegna dopo la rilevazione dell'app 1.2, un input dentro
                di lei non sarebbe ancora nel documento. Serve a tre cose: il riquadro (web e app 1.0/1.1), il
                trascinamento, e il ripiego «Usa il selettore del browser» dell'app 1.2.
                `hidden` (l'attributo, oltre alla classe): senza CSS — in un collaudo, in un lettore — l'input
                resterebbe un controllo senza etichetta (`nested-interactive` quando stava dentro il riquadro). */}
            <input ref={inputRef} type="file" accept="image/*,video/*" multiple hidden className="hidden"
                onChange={e => {
                    const scelti = e.target.files;
                    // I file sono ARRIVATI: la riga di log si scrive qui, sul gesto dell'input e non dentro
                    // `addFiles` (che serve anche al trascinamento, dove nessun selettore si è aperto).
                    if (scelti && scelti.length > 0) traccia.fileRicevuti(Array.from(scelti));
                    if (scelti) void addFiles(scelti);
                    e.target.value = '';
                }} />

            {/* ── Web e app 1.0/1.1 (o 1.2 a interruttore spento): il riquadro grande. ──────────────────────
                Web: trascina o clicca per scegliere (come prima). App: tocca per aprire il selettore di FOTO
                E VIDEO; la fotocamera è il pulsante secondario qui sotto. In entrambi i casi il click apre
                l'`<input>`: cambia solo ciò che il riquadro dice.

                ⚠️ È UN VERO COMANDO (secondario #150). Nell'app questo riquadro è la scelta PRINCIPALE, e
                era un `<div onClick>` nudo: nessun ruolo, nessun `tabIndex`, nessuna tastiera. Da tastiera
                non si apriva in nessun modo (WCAG 2.1.1, livello A), e VoiceOver o TalkBack non lo
                annunciavano come azionabile. Adesso ha `role="button"`, entra nell'ordine del Tab, e Invio o
                Spazio fanno ciò che fa il click. Il NOME accessibile è il suo testo visibile (WCAG 2.5.3,
                «Label in Name»): «Scegli foto e video…» nell'app, «Trascina foto o video…» sul web. Il
                comportamento non cambia: apre lo stesso `<input>`, con la stessa riga di log.
                Lo Spazio su un elemento non nativo farebbe scorrere la pagina: qui la pressione è il gesto.
                L'anello di fuoco è FUORI, come negli altri comandi della galleria. */}
            {rilevato && !conPlugin && (
                <div
                    data-testid="gallery-selettore-riquadro"
                    role="button"
                    tabIndex={0}
                    className={`relative border-2 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kidville-green ${
                        dragOver ? 'border-kidville-green bg-kidville-cream/50 scale-[1.01]' : 'border-kidville-line hover:border-kidville-green/50 hover:bg-kidville-cream/20'
                    }`}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
                    onClick={apriSelettore}
                    onKeyDown={e => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            apriSelettore();
                        }
                    }}
                >
                    <div className="flex flex-col items-center gap-3">
                        <div className="w-14 h-14 rounded-2xl bg-kidville-cream flex items-center justify-center">
                            <ImageIcon size={24} className="text-kidville-green" strokeWidth={1.5} />
                        </div>
                        <div>
                            <p className="font-barlow font-bold text-sm text-kidville-green uppercase">
                                {dragOver ? t('mediaRilasciaQui') : nativo ? t('mediaScegliFotoVideo') : t('mediaTrascinaFotoVideo')}
                            </p>
                            <p className="font-maven text-xs text-kidville-sub mt-1">
                                {nativo ? t('mediaScegliFotoVideoDettaglio', { max: MAX_ELEMENTI_PER_SCELTA }) : t('mediaOppureClicca')}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ── App 1.2 col plugin: due pulsanti PRINCIPALI («Scatta una foto» e «Scegli foto e video dalla
                galleria») e, sotto, il link «Scegli da File». Nessun riquadro di trascinamento (decisione del
                titolare, spec §2.1). A zero posti si spengono tutti e la frase del tetto dice perché. ─────── */}
            {conPlugin && (
                <div className="space-y-3" data-testid="gallery-selettore-nativo">
                    <button
                        type="button"
                        data-testid="gallery-selettore-scatta-foto"
                        onClick={scattaFoto}
                        disabled={comandiSpenti}
                        aria-describedby={posti === 0 ? idTetto : undefined}
                        className={CLASSE_PULSANTE_PRINCIPALE}
                    >
                        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-kidville-cream">
                            <Camera size={24} strokeWidth={1.5} aria-hidden="true" />
                        </span>
                        <span className="font-barlow text-sm font-bold uppercase">{t('mediaScattaUnaFoto')}</span>
                    </button>
                    <button
                        type="button"
                        data-testid="gallery-selettore-galleria"
                        onClick={() => { void scegliDalTelefono('galleria'); }}
                        disabled={comandiSpenti}
                        aria-describedby={posti === 0 ? idTetto : undefined}
                        className={CLASSE_PULSANTE_PRINCIPALE}
                    >
                        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-kidville-cream">
                            <Images size={24} strokeWidth={1.5} aria-hidden="true" />
                        </span>
                        <span className="font-barlow text-sm font-bold uppercase">{t('mediaScegliDallaGalleria')}</span>
                    </button>
                    <button
                        type="button"
                        data-testid="gallery-selettore-file"
                        onClick={() => { void scegliDalTelefono('file'); }}
                        disabled={comandiSpenti}
                        aria-describedby={posti === 0 ? idTetto : undefined}
                        className={CLASSE_PULSANTE_SECONDARIO}
                    >
                        <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
                        {t('mediaScegliDaFile')}
                    </button>
                </div>
            )}

            {errore && (
                <p role="alert" className="rounded-xl border border-kidville-line p-3 font-maven text-sm text-kidville-ink">
                    {t(errore === 'permesso' ? 'mediaErrorePermesso' : errore === 'configurazione' ? 'mediaErroreConfigurazione' : errore === 'file' ? 'mediaErroreFormato' : errore === 'selettore' ? 'mediaErroreSelettoreNativo' : 'mediaErroreFotocamera')}
                </p>
            )}

            {/* «Usa il selettore del browser»: il ripiego, SOLO dopo un errore del selettore nativo (spec §2.2).
                Non cambia l'impaginato deciso dal titolare, e evita la schermata morta se il plugin fallisce.
                Apre l'`<input>`: quei file sono `File` e vanno in TUS dalla pagina. */}
            {conPlugin && errore === 'selettore' && (
                <button
                    type="button"
                    data-testid="gallery-selettore-browser"
                    onClick={apriSelettore}
                    className={CLASSE_PULSANTE_SECONDARIO}
                >
                    {t('mediaSelettoreBrowser')}
                </button>
            )}

            {/* L'avviso del tetto dei 50. SEMPRE montato, e non è un vezzo: una regione viva che entra nel DOM
                già piena spesso non viene annunciata da VoiceOver (e le insegnanti sono su iOS) — è il difetto
                n. 36 della PR 1 (`VideoInLavorazione`). Vuota è `sr-only`: non occupa spazio e non si vede. */}
            <p
                id={idTetto}
                role="status"
                data-testid="gallery-selettore-tetto"
                className={mostraTetto ? 'rounded-xl border border-kidville-line p-3 font-maven text-sm text-kidville-ink' : 'sr-only'}
            >
                {mostraTetto ? t('mediaErroreTroppiElementi', { max: MAX_ELEMENTI_PER_SCELTA }) : ''}
            </p>

            {/* ── Solo nell'app 1.2: la PREPARAZIONE e i RIFIUTATI. Entrambe le regioni sono SEMPRE montate (stessa
                ragione del tetto, #36): cambia ciò che contengono, non il montaggio. «Annulla» sta FUORI dalla
                regione viva: un comando dentro un annuncio verrebbe riletto a ogni avanzamento. ─────────────── */}
            {conPlugin && (
                <>
                    <div className={preparazione !== null ? 'flex items-center justify-between gap-3 rounded-xl border border-kidville-line p-3' : 'sr-only'}>
                        <p role="status" data-testid="gallery-selettore-preparazione" className="font-maven text-sm text-kidville-ink">
                            {preparazione !== null ? t('mediaPreparazione', { fatti: preparazione.fatti, totali: preparazione.totali }) : ''}
                        </p>
                        {preparazione !== null && (
                            <button
                                type="button"
                                data-testid="gallery-selettore-annulla-preparazione"
                                onClick={annullaPreparazione}
                                disabled={annullando}
                                className="min-h-11 shrink-0 rounded-pill px-3 font-maven text-xs font-bold text-kidville-green underline underline-offset-2 transition-opacity hover:opacity-80 disabled:pointer-events-none disabled:text-kidville-sub"
                            >
                                {t('galleryAnnulla')}
                            </button>
                        )}
                    </div>
                    {/* I NOMI dei rifiutati stanno a schermo e basta: nei log passano solo i conteggi per motivo. */}
                    <div
                        role="status"
                        data-testid="gallery-selettore-rifiutati"
                        className={rifiutati.length > 0 ? 'rounded-xl border border-kidville-line p-3 font-maven text-sm text-kidville-ink' : 'sr-only'}
                    >
                        {rifiutati.length > 0 && (
                            <>
                                <p className="font-bold">{t('mediaRifiutati', { n: rifiutati.length })}</p>
                                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                                    {rifiutati.map((r, i) => (
                                        <li key={i} className="break-words">
                                            {r.nome}: {t(CHIAVE_RIFIUTO[r.motivo])}
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                </>
            )}

            {/* Nell'app 1.0/1.1: «Scatta una foto», l'opzione SECONDARIA (la fotocamera nativa). Il riquadro grande
                apre già il selettore di foto e video. Su web non compare; nell'app 1.2 è uno dei due pulsanti
                principali, qui sopra. */}
            {rilevato && nativo && !conPlugin && (
                <button
                    type="button"
                    data-testid="gallery-selettore-scatta-foto"
                    onClick={scattaFoto}
                    className={CLASSE_PULSANTE_SECONDARIO}
                >
                    <Camera size={15} strokeWidth={1.75} aria-hidden="true" />
                    {t('mediaScattaUnaFoto')}
                </button>
            )}

            {/* Preview grid */}
            <AnimatePresence>
                {previews.length > 0 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                        {/* TRE colonne, e fisse. Con `sm:grid-cols-6` questa griglia
                            viveva in una colonna da 460 px: sei tessere da 66 px, dentro
                            cui non si riconosce un bambino e su cui non si centra una X. */}
                        <div className="grid grid-cols-3 gap-2">
                            {previews.map((p, idx) => (
                                <motion.div key={idx} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                                    title={nomeElemento(p)}
                                    className="relative aspect-square rounded-xl overflow-hidden bg-kidville-neutral-soft">
                                    <AnteprimaMedia file={p.file} src={p.preview} />
                                    {/*
                                      IL NOME DEL FILE, e non è decorazione. La domanda del
                                      titolare era «non so QUALE video ho scelto»: il primo
                                      frame la chiude solo SE il browser lo dipinge, e su
                                      Safari/iOS `preload="metadata"` è un suggerimento che
                                      può ignorare (Risparmio Energetico, rete cellulare) —
                                      in jsdom non dipinge mai niente, quindi nessun test di
                                      questo lavoro può dimostrare il contrario. Il nome si
                                      vede sempre, costa una riga e si collauda.
                                      Sta in ALTO e finisce a `right-10`: la X occupa 32 px
                                      da `right-1`, cioè arriva a 36 — restano 4 px di aria.
                                      In basso non può stare: là c'è la pastiglia del video.
                                      `title` per il nome intero quando c'è un puntatore.
                                      ⚠️ Un nome di file è un dato personale (spesso contiene
                                      il nome del bambino): si mostra a chi ha scelto il file,
                                      e non finisce in nessun log.
                                    */}
                                    <span className="pointer-events-none absolute top-1 left-1 right-10 truncate rounded-pill bg-kidville-ink/90 px-1.5 py-0.5 font-barlow text-[9px] font-semibold text-kidville-white">
                                        {nomeElemento(p)}
                                    </span>
                                    {/*
                                      DURATA E PESO di un video NATIVO (spec §7.2: «miniatura, nome, durata,
                                      peso»): il nome non basta a riconoscere un filmato, e un `File` il suo
                                      peso lo porta nel nome del browser, un video nativo no. Sta SOPRA la
                                      pastiglia «Video» (in basso a sinistra, ~20 px d'altezza) e non accanto:
                                      la tessella è di ~98 px, e le due pastiglie affiancate non ci stanno.
                                      Un valore che non si conosce (la durata `null`) si omette.
                                    */}
                                    {p.nativo && (
                                        <span
                                            data-testid="gallery-anteprima-dati"
                                            className="pointer-events-none absolute bottom-6 left-1 rounded-pill bg-kidville-ink/90 px-1.5 py-0.5 font-barlow text-[9px] font-semibold text-kidville-white"
                                        >
                                            {[formattaDurata(p.nativo.durataSecondi), formattaMegabyte(p.nativo.byte, locale, { cifreMax: 0 })]
                                                .filter(parte => parte !== null && parte !== '')
                                                .join(' · ')}
                                        </span>
                                    )}
                                    {/*
                                      LA X SI VEDE SEMPRE. Era `w-5 h-5 opacity-0
                                      group-hover:opacity-100`: su iPhone e su tablet l'hover
                                      NON ESISTE, quindi il bottone era invisibile — ed è
                                      l'unico modo di togliere un file scelto per sbaglio.
                                      20 px erano anche sotto il minimo di 24×24 di WCAG 2.5.8
                                      (Target Size, AA); 32 px stanno comodi in una tessella da
                                      ~98 px. Il fondo `kidville-ink/90` la stacca da una foto
                                      chiara: senza, la X bianca sparisce su una parete bianca.
                                      ⚠️ `/90` e non `/70`: le velature scure adoperate in `src/`
                                      sono CENSITE dal lock `__tests__/a11y/` §5.3 col loro
                                      rapporto di contrasto misurato, e `/70` era una variante
                                      nuova — il lock diventava rosso e chiedeva una revisione
                                      umana sul contrasto. `/90` è già in tabella, e come
                                      effetto collaterale la X si vede MEGLIO: è la direzione
                                      giusta per un difetto nato da «non si vede».
                                    */}
                                    <button type="button" onClick={(e) => { e.stopPropagation(); removeFile(idx); }}
                                        aria-label={t('galleryRimuoviFile')}
                                        className="absolute top-1 right-1 h-8 w-8 rounded-full bg-kidville-ink/90 text-kidville-white flex items-center justify-center touch-manipulation active:scale-95 transition-transform">
                                        <X size={16} strokeWidth={2.25} />
                                    </button>
                                </motion.div>
                            ))}
                        </div>

                        {/*
                          QUESTO BOTTONE NON CARICA NIENTE: passa allo step 2 (tag e
                          privacy), e il caricamento vero parte solo da lì. Diceva
                          «Carica 3 file» — cioè annunciava un'azione irreversibile sulle
                          foto di bambini mentre ne faceva una reversibile.

                          ⚠️ E NON PUÒ DIVENTARE IL SOLO CONTEGGIO. Al primo giro
                          l'etichetta era «3 file»: non mente più, ma un nome accessibile
                          senza verbo non dice a che serve il bottone (WCAG 2.4.6) — si
                          sarebbe scambiato un difetto con un altro. Quindi si nomina la
                          DESTINAZIONE, che è la sola cosa vera: premendo si va a
                          configurare i tag.
                          `galleryModificaTag` è una chiave che esiste già, nello stesso
                          namespace `shared` che questo componente carica, e i due bottoni
                          che la portano non convivono mai (l'altro sta nel visore della
                          galleria, step `gallery`; questo nello step `upload`).
                          Resta un INTERIM dichiarato: la chiave giusta («Continua» /
                          «Continue») va aggiunta a `shared`, e i cataloghi `messages/`
                          appartengono a un altro agente in questo ciclo. Il nome proposto
                          sta nella consegna e nel PRD; quando esisterà, qui cambia una
                          parola e nient'altro.

                          Lo spinner di prima era legato a una prop `uploading` che NESSUN
                          chiamante passava: codice morto, tolto con la prop. Con lui
                          muoiono DUE chiavi di `shared` — quella del verbo «Carica» e
                          quella del «Caricamento…» dello spinner: vanno cancellate da chi
                          possiede i cataloghi, e i loro nomi esatti stanno nella consegna.
                          ⚠️ NON si scrivono qui, e non è pigrizia: il lock
                          `messaggi-chiavi-orfane` cerca il nome della chiave nel SORGENTE
                          GREZZO, commenti compresi. Nominarle le farebbe risultare vive —
                          ed è esattamente così che in questo repo un lock si è già
                          immunizzato col proprio commento.
                        */}
                        <button type="button" onClick={handleSubmit}
                            className="mt-4 w-full py-3 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-base uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20">
                            {t('galleryModificaTag')} · {previews.length} {previews.length === 1 ? t('mediaFileSingolare') : t('mediaFilePlurale')}
                            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/**
 * Un'operazione di contorno del selettore nativo che non è riuscita e che non ferma niente (l'ascolto
 * dell'avanzamento, l'annullamento, lo scarto): `warn` con lo slug e il CODICE dell'elenco chiuso. Mai il
 * messaggio del ponte — può contenere il nome di un file —, mai un identificativo di elemento.
 */
function scriviErroreNativo(slug: 'selettore-nativo-ascolto-fallito' | 'selettore-nativo-annulla-fallito', e: unknown): void {
    logClient({
        livello: 'warn',
        evento: 'caricamento-nativo',
        messaggio: `${slug}: ${codiceDelPonte(e)}`,
    });
}
