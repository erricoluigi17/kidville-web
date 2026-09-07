'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Send, Paperclip, X } from 'lucide-react';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';

interface Props {
    /**
     * ⚠️ RESTITUISCE L'ESITO, e non è un dettaglio di tipo.
     *
     * Prima era `=> void`, e questo componente svuotava il campo SUBITO, prima di
     * sapere com'era andata. Se la POST veniva rifiutata — genitore moroso
     * (403 `account_sospeso`), allegato fuori bucket (400), 500 — il testo spariva
     * e a schermo non compariva niente: il messaggio era perso, e chi l'aveva
     * scritto credeva di averlo mandato. Con `false` il campo NON si svuota, e il
     * testo resta dov'era.
     */
    onSend: (content: string, attachmentUrl?: string, attachmentType?: string) => void | boolean | Promise<void | boolean>;
    disabled?: boolean;
    placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: Props) {
    const t = useTranslations('teacherComunicazioni');
    const [text, setText] = useState('');
    // `riferimento` è ciò che si manda al server: dal 2026-08-01 (S32) è il
    // PERCORSO nel bucket privato, non più un link firmato a 365 giorni.
    // L'anteprima qui sotto mostra solo il nome del file, quindi un indirizzo
    // apribile non serve a nessuno prima dell'invio.
    const [attachment, setAttachment] = useState<{ name: string; riferimento: string; type: string } | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const [inviando, setInviando] = useState(false);

    const handleSend = useCallback(async () => {
        // Niente invio con upload in corso: il messaggio partirebbe senza
        // allegato e il file, a upload finito, resterebbe agganciato al composer.
        if (uploading || inviando) return;
        const trimmed = text.trim();
        if (!trimmed && !attachment) return;

        // Ciò che si sta MANDANDO, catturato adesso: è l'unica cosa che si avrà il
        // diritto di cancellare quando la risposta arriverà.
        const testoInviato = trimmed;
        const allegatoInviato = attachment;

        setInviando(true);
        try {
            const esito = await onSend(
                trimmed || (attachment ? '📎 Allegato' : ''),
                attachment?.riferimento,
                attachment?.type,
            );
            // ⚠️ Si svuota SOLO se l'invio è andato. `undefined` vale «andata»:
            // i chiamanti che non dichiarano l'esito si comportano come prima.
            if (esito === false) {
                inputRef.current?.focus();
                return;
            }

            /**
             * ⚠️ SI CANCELLA CIÒ CHE SI È MANDATO, NON CIÒ CHE C'È ADESSO.
             *
             * Attendere `onSend` è ciò che impedisce di perdere un messaggio
             * rifiutato — ma sposta lo svuotamento a DOPO, e nel frattempo lo stato
             * può essere cambiato. Con un `setAttachment(null)` secco si buttava via
             * un allegato caricato MENTRE l'invio era in volo.
             *
             * Non è teoria: è la sequenza che ha fatto rossa `e2e/chat.spec.ts`,
             * letta dal trace di rete della CI. `POST /api/chat/messages` parte a
             * +8,3 s e ci mette **2.658 ms**; `POST /api/chat/upload` parte a +8,4 s
             * e finisce prima. Alla risoluzione della prima, l'allegato era già
             * agganciato — e spariva. Poi «Invia» risultava disabilitato
             * (`!text.trim() && !attachment`) e il secondo invio non partiva mai:
             * nel trace c'è UNA sola POST per due messaggi mandati.
             *
             * Vale per una persona quanto per il test: chi manda un messaggio e nel
             * frattempo allega un file si vedeva sparire l'allegato, in silenzio.
             * Il confronto per identità dice esattamente la cosa giusta — «questo è
             * ancora quello che ho spedito?» — e in caso contrario non tocca niente.
             */
            setText((attuale) => (attuale.trim() === testoInviato ? '' : attuale));
            setAttachment((attuale) => (attuale === allegatoInviato ? null : attuale));
            inputRef.current?.focus();
        } finally {
            setInviando(false);
        }
    }, [text, attachment, onSend, uploading, inviando]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Upload reale su Supabase Storage via POST /api/chat/upload (M5.5):
    // bucket privato chat-allegati, max 10MB, PDF o immagini; la route
    // risponde col PERCORSO nel bucket + tipo ('image' | 'document').
    const handleAttachClick = () => {
        if (uploading) return;
        fileRef.current?.click();
    };

    // Punto d'ingresso unico dell'upload: lo usano sia l'<input> (che accetta anche
    // PDF) sia il bottone «Scatta foto» nativo → stesso flusso, supporto PDF intatto.
    const processaFile = useCallback(async (file: File) => {
        setUploading(true);
        setUploadError('');
        try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch('/api/chat/upload', { method: 'POST', body: fd }).catch(() => null);
            const data = res ? await res.json().catch(() => null) : null;
            // `data.url` è il ripiego per un server non ancora aggiornato: il
            // server nuovo lo riporta comunque a percorso prima di scrivere.
            const riferimento = data?.path ?? data?.url;
            if (res?.ok && riferimento) {
                setAttachment({ name: data.name ?? file.name, riferimento, type: data.attachment_type ?? 'document' });
            } else {
                setUploadError(data?.error ?? t('chatInputUploadErrore'));
            }
        } finally {
            setUploading(false);
        }
    }, [t]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // permette di riselezionare lo stesso file
        if (!file) return;
        void processaFile(file);
    };

    return (
        <div className="border-t border-kidville-line bg-white/95 backdrop-blur-xl">
            {/* Attachment preview */}
            {attachment && (
                <div className="px-4 pt-3 flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 bg-kidville-cream rounded-xl px-3 py-2">
                        <span className="text-sm">📎</span>
                        <span className="font-maven text-xs text-kidville-green truncate">{attachment.name}</span>
                    </div>
                    <button
                        onClick={() => setAttachment(null)}
                        aria-label={t('chatRimuoviAllegato')}
                        className="w-7 h-7 rounded-full bg-kidville-cream-dark flex items-center justify-center text-kidville-sub transition-colors hover:text-kidville-green"
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
                {/* Design Composer: allega = cerchio green-soft */}
                <button
                    onClick={handleAttachClick}
                    disabled={disabled || uploading}
                    className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-kidville-green-soft text-kidville-green transition-transform active:scale-95 disabled:opacity-50"
                    // Il NOME del comando resta fisso; lo STATO lo dice `aria-busy`.
                    // Prima l'`aria-label` alternava «Allega»/«Caricamento»: un
                    // controllo che cambia nome mentre lavora è un controllo diverso
                    // per chi lo comanda a voce («clicca Allega» smette di trovarlo)
                    // e per chi ne ha memorizzato la posizione nell'elenco dei
                    // comandi. È lo stesso pattern già scelto bene per il toggle
                    // della password sulla login: nome fisso + attributo di stato.
                    aria-label={t('chatInputAriaAllega')}
                    aria-busy={uploading}
                >
                    {uploading
                        ? <span className="w-4 h-4 border-2 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                        : <Paperclip size={18} strokeWidth={1.5} />}
                </button>

                {/* Nativo: scatta una foto da inviare in chat. Su web non compare. */}
                <ScattaFotoButton
                    onFile={processaFile}
                    // Nella barra della chat c'è spazio solo per l'icona:
                    // `soloIcona` lo dichiara invece di dedurlo dall'assenza di
                    // `label`, che ora vale «usa il testo tradotto».
                    soloIcona
                    iconSize={18}
                    disabled={disabled || uploading}
                    className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-kidville-green-soft text-kidville-green transition-transform active:scale-95 disabled:opacity-50"
                />

                {/* Text input */}
                <div className="flex-1 relative">
                    <textarea
                        ref={inputRef}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={disabled}
                        rows={1}
                        placeholder={placeholder ?? t('chatInputPlaceholder')}
                        className="w-full resize-none rounded-[22px] border border-kidville-line bg-white px-4 py-2.5 font-maven text-[13.5px] text-kidville-ink placeholder:text-kidville-hint focus:border-kidville-green focus:outline-none focus:ring-[3px] focus:ring-kidville-green/12 transition-all disabled:opacity-50 max-h-32 overflow-y-auto"
                        style={{ minHeight: '44px' }}
                    />
                </div>

                {/* Send button */}
                {/* Design Composer: invio = cerchio 44 verde/giallo con glow */}
                <button
                    onClick={handleSend}
                    disabled={disabled || uploading || (!text.trim() && !attachment)}
                    className="w-11 h-11 rounded-full flex-shrink-0 flex items-center justify-center bg-kidville-green text-kidville-yellow hover:bg-kidville-green-dark active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ boxShadow: '0 8px 18px -10px rgba(0,84,75,.8)' }}
                    aria-label={t('chatInputAriaInvia')}
                >
                    <Send size={19} strokeWidth={2} />
                </button>
            </div>
        </div>
    );
}
