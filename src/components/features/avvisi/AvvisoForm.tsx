import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, Upload, Link, AlertCircle } from 'lucide-react';
import { Avviso } from './AvvisoCard';

interface Props {
    open: boolean;
    onClose: () => void;
    onSubmit: (data: {
        titolo: string;
        contenuto: string;
        tipo: string;
        target_scope: string;
        target_classes: string[];
        scadenza: string | null;
        attachment_url: string | null;
    }) => void;
    availableClasses?: string[];
    initialAvviso?: Avviso | null;
}

export function AvvisoForm({ open, onClose, onSubmit, availableClasses = [], initialAvviso = null }: Props) {
    const [titolo, setTitolo] = useState('');
    const [contenuto, setContenuto] = useState('');
    const [tipo, setTipo] = useState<'presa_visione' | 'adesione'>('presa_visione');
    const [scope, setScope] = useState<'globale' | 'classe'>('globale');
    const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
    const [scadenza, setScadenza] = useState('');
    const [attachmentUrl, setAttachmentUrl] = useState(''); // File URL
    const [linkUrl, setLinkUrl] = useState(''); // External Link
    const [fileUploading, setFileUploading] = useState(false);
    const [fileName, setFileName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Gestione precompilazione in caso di modifica
    useEffect(() => {
        if (open) {
            if (initialAvviso) {
                setTitolo(initialAvviso.titolo);
                setContenuto(initialAvviso.contenuto);
                setTipo(initialAvviso.tipo as 'presa_visione' | 'adesione');
                setScope(initialAvviso.target_scope as 'globale' | 'classe');
                setSelectedClasses(initialAvviso.target_classes || []);
                setScadenza(initialAvviso.scadenza || '');
                
                // Decodifica allegato (JSON o link semplice)
                let fUrl = '';
                let lUrl = '';
                if (initialAvviso.attachment_url) {
                    if (initialAvviso.attachment_url.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(initialAvviso.attachment_url);
                            fUrl = parsed.file || '';
                            lUrl = parsed.link || '';
                        } catch {
                            fUrl = initialAvviso.attachment_url;
                        }
                    } else {
                        fUrl = initialAvviso.attachment_url;
                    }
                }
                setAttachmentUrl(fUrl);
                setLinkUrl(lUrl);
                setFileName(fUrl ? fUrl.split('/').pop() || 'File Allegato' : '');
            } else {
                // Reset in caso di creazione
                setTitolo('');
                setContenuto('');
                setTipo('presa_visione');
                setScope('globale');
                setSelectedClasses([]);
                setScadenza('');
                setAttachmentUrl('');
                setLinkUrl('');
                setFileName('');
            }
        }
    }, [open, initialAvviso]);

    const toggleClass = (c: string) => {
        setSelectedClasses(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setFileUploading(true);
        setFileName(file.name);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/avvisi/upload', {
                method: 'POST',
                body: formData,
            });

            if (res.ok) {
                const data = await res.json();
                setAttachmentUrl(data.fileUrl);
            } else {
                console.error("Errore caricamento file");
                alert("Impossibile caricare il file. Riprova.");
                setFileName('');
            }
        } catch (err) {
            console.error("Errore upload:", err);
            alert("Errore durante il caricamento del file.");
            setFileName('');
        } finally {
            setFileUploading(false);
        }
    };

    const removeFile = () => {
        setAttachmentUrl('');
        setFileName('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleSubmit = async () => {
        if (!titolo.trim() || !contenuto.trim()) return;
        setSubmitting(true);

        // Prepariamo l'attachment_url serializzato come JSON se c'è file o link
        let serializedAttachment = null;
        if (attachmentUrl.trim() || linkUrl.trim()) {
            serializedAttachment = JSON.stringify({
                file: attachmentUrl.trim() || null,
                link: linkUrl.trim() || null
            });
        }

        await onSubmit({
            titolo: titolo.trim(), contenuto: contenuto.trim(), tipo,
            target_scope: scope, target_classes: scope === 'classe' ? selectedClasses : [],
            scadenza: scadenza || null,
            attachment_url: serializedAttachment,
        });
        setSubmitting(false);
        setTitolo(''); setContenuto(''); setTipo('presa_visione');
        setScope('globale'); setSelectedClasses([]); setScadenza(''); setAttachmentUrl(''); setLinkUrl(''); setFileName('');
        onClose();
    };

    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50" onClick={onClose} />
                    <motion.div
                        initial={{ opacity: 0, y: 30, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.97 }} transition={{ duration: 0.25 }}
                        className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden"
                    >
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
                            <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">
                                {initialAvviso ? '✏️ Modifica Avviso' : '📢 Nuovo Avviso'}
                            </h2>
                            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors">
                                <X size={14} strokeWidth={1.5} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 bg-white">
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Titolo</label>
                                <input value={titolo} onChange={e => setTitolo(e.target.value)} placeholder="Es. Gita al parco"
                                    className="w-full border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                            </div>
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Contenuto</label>
                                <textarea value={contenuto} onChange={e => setContenuto(e.target.value)} placeholder="Scrivi il testo dell'avviso..." rows={4}
                                    className="w-full border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all resize-none" />
                            </div>
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Tipo</label>
                                <div className="flex gap-2">
                                    <button onClick={() => setTipo('presa_visione')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${tipo === 'presa_visione' ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/20' : 'bg-gray-50 text-gray-500 border border-gray-100 hover:bg-gray-100'}`}>📖 Presa visione</button>
                                    <button onClick={() => setTipo('adesione')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${tipo === 'adesione' ? 'bg-purple-500 text-white shadow-sm shadow-purple-500/20' : 'bg-gray-50 text-gray-500 border border-gray-100 hover:bg-gray-100'}`}>📋 Adesione</button>
                                </div>
                            </div>
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Destinatari</label>
                                <div className="flex gap-2">
                                    <button onClick={() => setScope('globale')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${scope === 'globale' ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-gray-50 text-gray-500 border border-gray-100 hover:bg-gray-100'}`}>🌐 Tutti</button>
                                    <button onClick={() => setScope('classe')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${scope === 'classe' ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-gray-50 text-gray-500 border border-gray-100 hover:bg-gray-100'}`}>🏫 Per classe</button>
                                </div>
                            </div>
                            {scope === 'classe' && (
                                <div className="flex flex-wrap gap-1.5 p-2 bg-gray-50 rounded-2xl border border-gray-100">
                                    {availableClasses.map(c => (
                                        <button key={c} onClick={() => toggleClass(c)} className={`px-3 py-1.5 rounded-xl font-maven text-xs font-semibold transition-all ${selectedClasses.includes(c) ? 'bg-kidville-green text-kidville-yellow shadow-sm' : 'bg-white text-gray-500 border border-gray-150 hover:bg-gray-100'}`}>{c}</button>
                                    ))}
                                </div>
                            )}
                            
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">
                                    Scadenza {tipo === 'presa_visione' ? 'avviso' : 'adesione'} (opzionale)
                                </label>
                                <input type="date" value={scadenza} onChange={e => setScadenza(e.target.value)}
                                    className="w-full border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                            </div>

                            {/* Upload File */}
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">File Allegato (opzionale)</label>
                                <div className="flex items-center gap-3">
                                    <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".pdf,image/*,.doc,.docx" />
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={fileUploading}
                                        className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-300 rounded-2xl font-maven text-xs font-semibold text-gray-600 hover:border-kidville-green hover:text-kidville-green transition-colors disabled:opacity-50"
                                    >
                                        <Upload size={14} /> {fileUploading ? 'Caricamento...' : 'Carica File (PDF, Immagini)'}
                                    </button>
                                    
                                    {fileName && (
                                        <div className="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-1.5 max-w-[200px] truncate text-xs font-maven text-gray-600">
                                            <span className="truncate flex-1">{fileName}</span>
                                            <button type="button" onClick={removeFile} className="text-gray-400 hover:text-red-500 flex-shrink-0">
                                                <X size={12} />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Link Esterno */}
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Link Esterno (opzionale)</label>
                                <div className="relative">
                                    <Link size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                                    <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://esempio.com/pagina-info"
                                        className="w-full border-2 border-gray-200/60 rounded-2xl pl-10 pr-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                                </div>
                            </div>
                        </div>
                        <div className="px-6 py-4 border-t border-gray-100 bg-white">
                            <button onClick={handleSubmit} disabled={submitting || fileUploading || !titolo.trim() || !contenuto.trim()}
                                className="w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20">
                                {submitting ? (
                                    <>
                                        <div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                                        {initialAvviso ? 'Salvataggio...' : 'Pubblicazione...'}
                                    </>
                                ) : (
                                    <>
                                        <Send size={16} strokeWidth={1.5} />
                                        {initialAvviso ? 'Salva Modifiche' : 'Pubblica Avviso'}
                                    </>
                                )}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
