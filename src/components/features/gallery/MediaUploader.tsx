'use client';

import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { ArrowRight, X, Image as ImageIcon, Images } from 'lucide-react';
import { useImagePicker } from '@/lib/native/use-image-picker';
import { fotocameraNativaDisponibile } from '@/lib/native/camera';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { AnteprimaMedia } from './AnteprimaMedia';

interface Props {
    onUpload: (files: { file: File; preview: string }[]) => void;
}

export function MediaUploader({ onUpload }: Props) {
    const t = useTranslations('shared');
    const [previews, setPreviews] = useState<{ file: File; preview: string }[]>([]);
    const [dragOver, setDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const addFiles = useCallback((fileList: FileList | File[]) => {
        const newFiles = Array.from(fileList)
            .filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'))
            .map(file => ({ file, preview: URL.createObjectURL(file) }));
        setPreviews(prev => [...prev, ...newFiles]);
    }, []);

    // Nativo: la foto arriva dalla fotocamera Capacitor; web: click sull'input.
    // In entrambi i casi i file confluiscono in addFiles → flusso identico.
    const { apri } = useImagePicker({ inputRef, onFiles: addFiles, multiplo: true });

    // Su nativo il drop-zone apre la fotocamera (solo scatto foto). Per caricare un
    // VIDEO (o scegliere dalla libreria) serve l'<input> — che accetta già
    // image+video e, nella WebView, offre la galleria coi video. Affordance
    // secondaria native-only che clicca direttamente l'input. Web-safe/SSR-safe via
    // useClientValue (nessun hydration mismatch: false finché non idrata il client).
    const nativo = useClientValue(() => fotocameraNativaDisponibile(), false);

    const removeFile = (idx: number) => {
        setPreviews(prev => {
            URL.revokeObjectURL(prev[idx].preview);
            return prev.filter((_, i) => i !== idx);
        });
    };

    const handleSubmit = () => {
        if (previews.length === 0) return;
        onUpload(previews);
    };

    return (
        <div className="space-y-4">
            {/* Drop zone */}
            <div
                className={`relative border-2 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer ${
                    dragOver ? 'border-kidville-green bg-kidville-cream/50 scale-[1.01]' : 'border-kidville-line hover:border-kidville-green/50 hover:bg-kidville-cream/20'
                }`}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
                onClick={() => { void apri(); }}
            >
                <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden"
                    onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
                <div className="flex flex-col items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl bg-kidville-cream flex items-center justify-center">
                        <ImageIcon size={24} className="text-kidville-green" strokeWidth={1.5} />
                    </div>
                    <div>
                        <p className="font-barlow font-bold text-sm text-kidville-green uppercase">
                            {dragOver ? t('mediaRilasciaQui') : t('mediaTrascinaFotoVideo')}
                        </p>
                        <p className="font-maven text-xs text-kidville-sub mt-1">{t('mediaOppureClicca')}</p>
                    </div>
                </div>
            </div>

            {/* Nativo: link secondario per aprire la galleria (foto E video). Su web
                non compare — il drop-zone apre già l'input. */}
            {nativo && (
                <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="mx-auto flex items-center gap-2 rounded-pill px-4 py-2 font-maven text-xs font-bold text-kidville-green underline underline-offset-2 transition-opacity hover:opacity-80"
                >
                    <Images size={15} strokeWidth={1.75} aria-hidden="true" />
                    {t('mediaCaricaDaGalleria')}
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
