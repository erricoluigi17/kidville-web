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
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useImagePicker } from '@/lib/native/use-image-picker';
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

export function NewsMediaUploader({
  userId,
  onUploaded,
  consensoFoto,
  onConsensoFoto,
  accept = 'image/jpeg,image/png,image/gif,image/webp',
  label,
  disabled = false,
}: Props) {
  const t = useTranslations('adminComunicazioni');
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
        else setErrore(t('uploaderUrlMancante'));
      } else if (res.status === 404) {
        setErrore(t('uploaderNonDisponibile'));
      } else {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrore(j?.error ?? t('uploaderImpossibileCaricare'));
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `news-media-upload-fallito: ${nomeErrore(err)}`, route: '/admin/news', stato: 0 });
      setErrore(t('erroreReteRiprova'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  // Gate del consenso foto: vale sia per il file scelto dall'input (web) sia per
  // la foto scattata/scelta con la fotocamera nativa. Punto d'ingresso unico.
  const processaFile = (file: File) => {
    const isImmagine = file.type.startsWith('image/');
    if (isImmagine && !consensoFoto) {
      setPending(file);
      setSpuntato(false);
      return;
    }
    void carica(file);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processaFile(file);
  };

  // Nativo: apre la fotocamera Capacitor; web: click sull'input nascosto.
  const { apri } = useImagePicker({
    inputRef,
    onFiles: (files) => { const f = files[0]; if (f) processaFile(f); },
    multiplo: false,
  });

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
        onClick={() => { void apri(); }}
        disabled={disabled || busy}
        className="inline-flex items-center gap-2 rounded-pill border-[1.5px] border-dashed border-kidville-line bg-kidville-white px-4 py-2.5 font-maven text-sm font-bold text-kidville-green transition-colors hover:border-kidville-green disabled:opacity-50"
      >
        <Upload size={15} strokeWidth={2} /> {busy ? t('caricamento') : (label ?? t('uploaderCaricaImmagine'))}
      </button>

      {errore && <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{errore}</p>}

      <Modal
        open={pending !== null}
        onClose={annullaConsenso}
        title={t('uploaderConsensoTitolo')}
        className={MODAL_CARD}
        style={{ boxShadow: MODAL_SHADOW }}
        returnFocusRef={triggerRef}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kidville-warn-soft text-kidville-warn-strong">
            <ShieldQuestion size={18} strokeWidth={2} />
          </span>
          <div>
            <h2 className="font-barlow text-base font-black uppercase tracking-wide text-kidville-green">{t('uploaderConsensoTitolo')}</h2>
            <p className="mt-1 font-maven text-sm text-kidville-sub">
              {t('uploaderConsensoTesto')}
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
            {t('uploaderConsensoCheckbox')}
          </span>
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={annullaConsenso} className={BTN_SECONDARY}>{t('annulla')}</button>
          <button type="button" onClick={confermaConsenso} disabled={!spuntato} className={BTN_PRIMARY_AA}>
            {t('uploaderConfermaCarica')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
