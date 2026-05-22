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
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const handleSend = useCallback(() => {
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
    }, [text, attachment, onSend]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Placeholder file pick — In produzione userà Supabase Storage
    const handleAttachClick = () => {
        // TODO: Implementare upload su Supabase Storage
        // Per ora, simula un allegato
        alert('Upload file: verrà implementato con Supabase Storage.');
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

            {/* Input area */}
            <div className="flex items-end gap-2 px-4 py-3">
                {/* Attachment button */}
                <button
                    onClick={handleAttachClick}
                    className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-gray-50 hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Allega file"
                >
                    <Paperclip size={18} strokeWidth={1.5} />
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
                    disabled={disabled || (!text.trim() && !attachment)}
                    className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-kidville-green text-kidville-yellow hover:opacity-90 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-kidville-green/20"
                    aria-label="Invia messaggio"
                >
                    <Send size={18} strokeWidth={1.5} />
                </button>
            </div>
        </div>
    );
}
