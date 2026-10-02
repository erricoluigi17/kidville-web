'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { ArrowRight, Camera, X, Image as ImageIcon } from 'lucide-react';
import { useImagePicker } from '@/lib/native/use-image-picker';
import { fotocameraNativaDisponibile } from '@/lib/native/camera';
import type { CodiceFotocamera } from '@/lib/native/camera';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { classificaFileGalleria } from '@/lib/gallery/classifica-file';
import { MAX_ELEMENTI_PER_SCELTA, limitaElementi } from '@/lib/gallery/selettore-media';
import { logClient } from '@/lib/logging/client';
import { AnteprimaMedia } from './AnteprimaMedia';
import { useTracciaSelettore } from './use-traccia-selettore';

interface Props {
    onUpload: (files: { file: File; preview: string }[]) => void;
}

type Anteprima = { file: File; preview: string };

export function MediaUploader({ onUpload }: Props) {
    const t = useTranslations('shared');
    const [previews, setPreviews] = useState<Anteprima[]>([]);
    // La COPIA su cui si ragiona, aggiornata a ogni modifica insieme allo stato (`aggiornaPreviews`):
    // `addFiles` è asincrona, e il tetto dei 50 si decide su quanti file ci sono ORA, non su quanti ce
    // n'erano al render che l'ha creata. Lo stato resta ciò che si disegna; il ref ciò che si conta.
    const previewsRef = useRef<Anteprima[]>([]);
    const [dragOver, setDragOver] = useState(false);
    const [errore, setErrore] = useState<'permesso' | 'configurazione' | 'fotocamera' | 'file' | null>(null);
    // Una scelta ha superato il tetto di MAX_ELEMENTI_PER_SCELTA: l'avviso in linea (non è un errore).
    const [oltreIlMassimo, setOltreIlMassimo] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const montatoRef = useRef(true);
    // Le tre righe di log del selettore (aperto, file ricevuti, chiuso senza file): vedi
    // `@/lib/gallery/selettore-media`. Mai il nome del file: qui si passano i File, lì si contano.
    const traccia = useTracciaSelettore(inputRef);

    useEffect(() => {
        montatoRef.current = true;
        return () => { montatoRef.current = false; };
    }, []);

    const aggiornaPreviews = useCallback((modifica: (prev: Anteprima[]) => Anteprima[]) => {
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

    // La fotocamera nativa: dal 02/10/2026 NON è più il riquadro grande, ma «Scatta una foto»
    // (opzione secondaria, solo nell'app). Mostra solo foto, una alla volta, e `scegliFotoNativa` ha
    // già i suoi log. La foto scattata confluisce in `addFiles` come un file qualunque.
    const { apri: apriFotocamera } = useImagePicker({
        inputRef,
        onFiles: files => { traccia.fileRicevuti(files); void addFiles(files); },
        multiplo: true,
        onErrore: onErroreFotocamera,
        onAnnullato: () => traccia.annullatoFotocamera(),
    });

    // Nell'app il riquadro grande apre il SELETTORE con foto E video (l'<input> con
    // `accept="image/*,video/*"`), non la fotocamera: la fotocamera nativa mostra solo foto, una alla
    // volta, e i video stavano dietro un link piccolo (spec video PR 2 §11.1). ⚠️ Non è la correzione
    // del video da 73 MB che sull'iPhone non è mai arrivato alla pagina — il selettore è lo stesso
    // `<input>`, e la causa è ancora da distinguere: sono le tre righe di log di `useTracciaSelettore`
    // a doverlo dire. Sul web il riquadro apriva già l'input.
    // Web-safe/SSR-safe via useClientValue (nessun hydration mismatch: false finché non idrata il client).
    const nativo = useClientValue(() => fotocameraNativaDisponibile(), false);
    const ambiente = (): 'app' | 'web' => (fotocameraNativaDisponibile() ? 'app' : 'web');

    const apriSelettore = () => {
        setErrore(null);
        setOltreIlMassimo(false);
        traccia.apri('selettore-file', ambiente());
        inputRef.current?.click();
    };

    const scattaFoto = () => {
        setErrore(null);
        setOltreIlMassimo(false);
        traccia.apri('fotocamera-nativa', ambiente());
        void apriFotocamera();
    };

    const removeFile = (idx: number) => {
        const daTogliere = previewsRef.current[idx];
        if (!daTogliere) return;
        URL.revokeObjectURL(daTogliere.preview);
        aggiornaPreviews(prev => prev.filter((_, i) => i !== idx));
        // Un posto si è liberato: l'avviso del tetto non descrive più la situazione.
        setOltreIlMassimo(false);
    };

    const handleSubmit = () => {
        if (previews.length === 0) return;
        onUpload(previews);
    };

    return (
        <div className="space-y-4">
            {/* Il riquadro grande. Web: trascina o clicca per scegliere (come prima). App: tocca per
                aprire il selettore di FOTO E VIDEO; la fotocamera è il pulsante secondario qui sotto.
                In entrambi i casi il click apre l'`<input>`: cambia solo ciò che il riquadro dice. */}
            <div
                data-testid="gallery-selettore-riquadro"
                className={`relative border-2 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer ${
                    dragOver ? 'border-kidville-green bg-kidville-cream/50 scale-[1.01]' : 'border-kidville-line hover:border-kidville-green/50 hover:bg-kidville-cream/20'
                }`}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
                onClick={apriSelettore}
            >
                <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden"
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                        const scelti = e.target.files;
                        // I file sono ARRIVATI: la riga di log si scrive qui, sul gesto dell'input e non dentro
                        // `addFiles` (che serve anche al trascinamento, dove nessun selettore si è aperto).
                        if (scelti && scelti.length > 0) traccia.fileRicevuti(Array.from(scelti));
                        if (scelti) void addFiles(scelti);
                        e.target.value = '';
                    }} />
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

            {errore && (
                <p role="alert" className="rounded-xl border border-kidville-line p-3 font-maven text-sm text-kidville-ink">
                    {t(errore === 'permesso' ? 'mediaErrorePermesso' : errore === 'configurazione' ? 'mediaErroreConfigurazione' : errore === 'file' ? 'mediaErroreFormato' : 'mediaErroreFotocamera')}
                </p>
            )}

            {/* L'avviso del tetto dei 50. SEMPRE montato, e non è un vezzo: una regione viva che entra nel DOM
                già piena spesso non viene annunciata da VoiceOver (e le insegnanti sono su iOS) — è il difetto
                n. 36 della PR 1 (`VideoInLavorazione`). Vuota è `sr-only`: non occupa spazio e non si vede. */}
            <p
                role="status"
                className={oltreIlMassimo ? 'rounded-xl border border-kidville-line p-3 font-maven text-sm text-kidville-ink' : 'sr-only'}
            >
                {oltreIlMassimo ? t('mediaErroreTroppiElementi', { max: MAX_ELEMENTI_PER_SCELTA }) : ''}
            </p>

            {/* Nell'app: «Scatta una foto», l'opzione SECONDARIA (la fotocamera nativa). Il riquadro grande
                apre già il selettore di foto e video. Su web non compare. */}
            {nativo && (
                <button
                    type="button"
                    data-testid="gallery-selettore-scatta-foto"
                    onClick={scattaFoto}
                    className="mx-auto flex min-h-11 items-center gap-2 rounded-pill px-4 py-2 font-maven text-xs font-bold text-kidville-green underline underline-offset-2 transition-opacity hover:opacity-80"
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
                                    title={p.file.name}
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
                                        {p.file.name}
                                    </span>
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
