'use client';

import { useState, useRef, useCallback } from 'react';
import { Send, Paperclip, X } from 'lucide-react';

interface Props {
    onSend: (content: string, attachmentUrl?: string, attachmentType?: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: Props) {
    const [text, setText] = useState('');
    const [attachment, setAttachment] = useState<{ name: string; url: string; type: string } | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const handleSend = useCallback(() => {
        // Niente invio con upload in corso: il messaggio partirebbe senza
        // allegato e il file, a upload finito, resterebbe agganciato al composer.
        if (uploading) return;
        const trimmed = text.trim();
        if (!trimmed && !attachment) return;

        onSend(
            trimmed || (attachment ? '📎 Allegato' : ''),
            attachment?.url,
            attachment?.type,
        );
        setText('');
        setAttachment(null);
        inputRef.current?.focus();
    }, [text, attachment, onSend, uploading]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Upload reale su Supabase Storage via POST /api/chat/upload (M5.5):
    // bucket privato chat-allegati, max 10MB, PDF o immagini; la route
    // risponde con URL firmato + tipo ('image' | 'document').
    const handleAttachClick = () => {
        if (uploading) return;
        fileRef.current?.click();
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // permette di riselezionare lo stesso file
        if (!file) return;
        setUploading(true);
        setUploadError('');
        try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch('/api/chat/upload', { method: 'POST', body: fd }).catch(() => null);
            const data = res ? await res.json().catch(() => null) : null;
            if (res?.ok && data?.url) {
                setAttachment({ name: data.name ?? file.name, url: data.url, type: data.attachment_type ?? 'document' });
            } else {
                setUploadError(data?.error ?? 'Caricamento non riuscito. Riprova.');
            }
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="border-t border-gray-100/60 bg-white/80 backdrop-blur-xl">
            {/* Attachment preview */}
            {attachment && (
                <div className="px-4 pt-3 flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 bg-kidville-cream rounded-xl px-3 py-2">
                        <span className="text-sm">📎</span>
                        <span className="font-maven text-xs text-kidville-green truncate">{attachment.name}</span>
                    </div>
                    <button
                        onClick={() => setAttachment(null)}
                        className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                    >
                        <X size={12} strokeWidth={1.5} />
                    </button>
                </div>
            )}

            {/* Errore upload */}
            {uploadError && (
                <div className="px-4 pt-2">
                    <p className="font-maven text-xs text-kidville-error">{uploadError}</p>
                </div>
            )}

            {/* Input area */}
            <div className="flex items-end gap-2 px-4 py-3">
                {/* Attachment button (file input nascosto, upload M5.5) */}
                <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/gif"
                    onChange={handleFileChange}
                    className="hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                />
                <button
                    onClick={handleAttachClick}
                    disabled={disabled || uploading}
                    className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-gray-50 hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
                    aria-label={uploading ? 'Caricamento in corso' : 'Allega file'}
                >
                    {uploading
                        ? <span className="w-4 h-4 border-2 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                        : <Paperclip size={18} strokeWidth={1.5} />}
                </button>

                {/* Text input */}
                <div className="flex-1 relative">
                    <textarea
                        ref={inputRef}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={disabled}
                        rows={1}
                        placeholder={placeholder ?? 'Scrivi un messaggio...'}
                        className="w-full resize-none border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all disabled:opacity-50 max-h-32 overflow-y-auto"
                        style={{ minHeight: '44px' }}
                    />
                </div>

                {/* Send button */}
                <button
                    onClick={handleSend}
                    disabled={disabled || uploading || (!text.trim() && !attachment)}
                    className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-kidville-green text-kidville-yellow hover:opacity-90 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-kidville-green/20"
                    aria-label="Invia messaggio"
                >
                    <Send size={18} strokeWidth={1.5} />
                </button>
            </div>
        </div>
    );
}
