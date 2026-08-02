'use client';

import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Upload, X, Image as ImageIcon, Images } from 'lucide-react';
import { useImagePicker } from '@/lib/native/use-image-picker';
import { fotocameraNativaDisponibile } from '@/lib/native/camera';
import { useClientValue } from '@/lib/hooks/use-client-value';

interface Props {
    onUpload: (files: { file: File; preview: string }[]) => void;
    uploading?: boolean;
}

export function MediaUploader({ onUpload, uploading }: Props) {
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
                    dragOver ? 'border-kidville-green bg-kidville-cream/50 scale-[1.01]' : 'border-gray-200 hover:border-kidville-green/50 hover:bg-kidville-cream/20'
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
                        <p className="font-maven text-xs text-gray-400 mt-1">{t('mediaOppureClicca')}</p>
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
                        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                            {previews.map((p, idx) => (
                                <motion.div key={idx} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                                    className="relative aspect-square rounded-xl overflow-hidden bg-gray-100 group">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={p.preview} alt="" className="w-full h-full object-cover" />
                                    <button onClick={(e) => { e.stopPropagation(); removeFile(idx); }} aria-label={t('galleryRimuoviFile')}
                                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                        <X size={10} strokeWidth={2} />
                                    </button>
                                </motion.div>
                            ))}
                        </div>

                        <button onClick={handleSubmit} disabled={uploading}
                            className="mt-4 w-full py-3 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-base uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20">
                            {uploading ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> {t('mediaCaricamentoInCorso')}</>
                                : <><Upload size={16} strokeWidth={1.5} /> {t('mediaCaricaVerbo')} {previews.length} {previews.length === 1 ? t('mediaFileSingolare') : t('mediaFilePlurale')}</>}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
