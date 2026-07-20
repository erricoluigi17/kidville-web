'use client';

// ─── Upload di un media verso /api/news/upload (bucket `news`) ────────────────
// Pattern del caricamento avvisi/gallery, con UNA regola in più: al PRIMO
// caricamento di una FOTO in un post compare un dialog BLOCCANTE con checkbox di
// conferma del consenso foto per i bambini riconoscibili. Il consenso è condiviso
// a livello di post (lo possiede il pannello editor e lo passa a tutti gli
// uploader), così lo si chiede una volta sola. Video (YouTube/Vimeo/upload) non
// passano dal gate del consenso foto. Degrada con un messaggio sugli errori (415).

import { useRef, useState } from 'react';
import { Upload, ShieldQuestion } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';
import { MODAL_CARD, MODAL_SHADOW, BTN_PRIMARY_AA, BTN_SECONDARY } from '@/components/features/admin/pagamenti/ui';

interface Props {
  userId: string;
  onUploaded: (url: string) => void;
  /** Consenso foto già acquisito per QUESTO post (posseduto dal pannello editor). */
  consensoFoto: boolean;
  /** Chiamato quando l'operatore conferma il consenso foto la prima volta. */
  onConsensoFoto: () => void;
  accept?: string;
  label?: string;
  disabled?: boolean;
}

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NewsMediaUploader({
  userId,
  onUploaded,
  consensoFoto,
  onConsensoFoto,
  accept = 'image/jpeg,image/png,image/gif,image/webp',
  label = 'Carica immagine',
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  // File in attesa che l'operatore confermi il consenso foto, e stato della spunta.
  const [pending, setPending] = useState<File | null>(null);
  const [spuntato, setSpuntato] = useState(false);

  const carica = async (file: File) => {
    setErrore(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/news/upload?userId=${userId}`, {
        method: 'POST',
        headers: { 'x-user-id': userId },
        body: fd,
      });
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as { fileUrl?: string; url?: string } | null;
        const url = j?.fileUrl ?? j?.url ?? null;
        if (url) onUploaded(url);
        else setErrore('Caricamento riuscito ma URL mancante nella risposta.');
      } else if (res.status === 404) {
        setErrore('Caricamento non ancora disponibile su questo ambiente.');
      } else {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrore(j?.error ?? 'Impossibile caricare il file. Riprova.');
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST news/upload — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
      setErrore('Errore di rete: riprova.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImmagine = file.type.startsWith('image/');
    // Gate del consenso foto: solo per le immagini, solo se non ancora dato.
    if (isImmagine && !consensoFoto) {
      setPending(file);
      setSpuntato(false);
      return;
    }
    void carica(file);
  };

  const confermaConsenso = () => {
    if (!spuntato) return;
    onConsensoFoto();
    const f = pending;
    setPending(null);
    if (f) void carica(f);
  };

  const annullaConsenso = () => {
    setPending(null);
    setSpuntato(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div>
      <input ref={inputRef} type="file" accept={accept} onChange={onFile} className="hidden" aria-hidden="true" tabIndex={-1} />
      <button
        ref={triggerRef}
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        className="inline-flex items-center gap-2 rounded-pill border-[1.5px] border-dashed border-kidville-line bg-kidville-white px-4 py-2.5 font-maven text-sm font-bold text-kidville-green transition-colors hover:border-kidville-green disabled:opacity-50"
      >
        <Upload size={15} strokeWidth={2} /> {busy ? 'Caricamento…' : label}
      </button>

      {errore && <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{errore}</p>}

      <Modal
        open={pending !== null}
        onClose={annullaConsenso}
        title="Consenso foto"
        className={MODAL_CARD}
        style={{ boxShadow: MODAL_SHADOW }}
        returnFocusRef={triggerRef}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kidville-warn-soft text-kidville-warn-strong">
            <ShieldQuestion size={18} strokeWidth={2} />
          </span>
          <div>
            <h2 className="font-barlow text-base font-black uppercase tracking-wide text-kidville-green">Consenso foto</h2>
            <p className="mt-1 font-maven text-sm text-kidville-sub">
              Stai pubblicando una foto in cui potrebbero comparire bambini riconoscibili. La responsabilità
              di avere il consenso è dell&apos;operatore che pubblica.
            </p>
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={spuntato}
            onChange={(e) => setSpuntato(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded accent-kidville-green"
          />
          <span className="font-maven text-sm text-kidville-ink">
            Confermo di avere il consenso foto per i bambini riconoscibili in questa immagine.
          </span>
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={annullaConsenso} className={BTN_SECONDARY}>Annulla</button>
          <button type="button" onClick={confermaConsenso} disabled={!spuntato} className={BTN_PRIMARY_AA}>
            Conferma e carica
          </button>
        </div>
      </Modal>
    </div>
  );
}
