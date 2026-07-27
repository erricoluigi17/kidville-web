'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Flag } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';

// =============================================================================
// SegnalaContenuto (C5 §2) — trigger + dialog per segnalare un contenuto UGC.
// Condiviso tra galleria ("Segnala foto/video") e diario ("Segnala voce").
//
// La label del bottone la passa il chiamante, così il testo vive nel namespace
// i18n del contesto (shared per la galleria, diario per il diario); la chrome
// del dialog usa il proprio namespace `shared`.
//
// SICUREZZA/PRIVACY: il body manda solo tipo_oggetto + oggetto_id + categoria +
// motivo. Il `motivo` è testo libero: NON viene mai messo nei log (in caso di
// errore si logga un messaggio generico, senza contenuto).
// =============================================================================

const CATEGORIE = [
  'contenuto_inappropriato',
  'molestie_bullismo',
  'informazione_falsa',
  'spam',
  'altro',
] as const;

type Categoria = (typeof CATEGORIE)[number];

interface Props {
  tipoOggetto: 'media_galleria' | 'voce_diario';
  oggettoId: string;
  /** Testo visibile del bottone (sempre presente: mai solo icona). */
  label: string;
  /** Etichetta accessibile più esplicita, se la label visibile è breve. */
  ariaLabel?: string;
  /** Stile del trigger: pill colorata (galleria) o inline discreto (diario). */
  variant?: 'pill' | 'inline';
}

export function SegnalaContenuto({ tipoOggetto, oggettoId, label, ariaLabel, variant = 'inline' }: Props) {
  const t = useTranslations('shared');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [categoria, setCategoria] = useState<Categoria>('contenuto_inappropriato');
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errore, setErrore] = useState(false);
  const [inviata, setInviata] = useState(false);

  const chiudi = () => {
    setOpen(false);
    // Reset per una prossima apertura pulita (dopo l'animazione di chiusura).
    setSubmitting(false);
    setErrore(false);
    setInviata(false);
    setCategoria('contenuto_inappropriato');
    setMotivo('');
  };

  const invia = async () => {
    setSubmitting(true);
    setErrore(false);
    try {
      const res = await fetch('/api/segnalazioni', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo_oggetto: tipoOggetto,
          oggetto_id: oggettoId,
          categoria,
          // Solo se davvero valorizzato: chiave assente, non stringa vuota.
          ...(motivo.trim() ? { motivo: motivo.trim() } : {}),
        }),
      });
      if (!res.ok) {
        // Errore d'invio: si logga un messaggio GENERICO, mai il motivo (dati di minori).
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'segnalazione-invio-fallito', route: '/segnalazioni' });
        setErrore(true);
        return;
      }
      setInviata(true);
    } catch {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'segnalazione-invio-eccezione', route: '/segnalazioni' });
      setErrore(true);
    } finally {
      setSubmitting(false);
    }
  };

  const triggerClass =
    variant === 'pill'
      ? 'flex items-center gap-2 px-5 py-2.5 bg-kidville-neutral-soft hover:bg-kidville-cream-dark text-kidville-ink rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-colors cursor-pointer shadow-sm'
      : 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-maven text-xs font-semibold text-kidville-muted transition-colors hover:bg-kidville-neutral-soft hover:text-kidville-ink';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel ?? label}
        className={triggerClass}
      >
        <Flag size={variant === 'pill' ? 14 : 13} strokeWidth={2.5} />
        <span>{label}</span>
      </button>

      <Modal
        open={open}
        onClose={chiudi}
        title={t('segnalaTitolo')}
        returnFocusRef={triggerRef}
        className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
      >
        {inviata ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-kidville-success-soft text-2xl">
              ✅
            </div>
            <h2 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">
              {t('segnalaSuccessoTitolo')}
            </h2>
            <p className="mt-1 font-maven text-sm text-kidville-muted">{t('segnalaSuccessoCorpo')}</p>
            <button
              type="button"
              onClick={chiudi}
              className="mt-5 w-full rounded-full bg-kidville-green py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green/90"
            >
              {t('segnalaChiudi')}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-kidville-warn-soft text-kidville-warn">
                <Flag size={18} strokeWidth={2.5} />
              </span>
              <div>
                <h2 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">
                  {t('segnalaTitolo')}
                </h2>
                <p className="mt-0.5 font-maven text-xs text-kidville-muted">{t('segnalaSottotitolo')}</p>
              </div>
            </div>

            <fieldset className="mb-4">
              <legend className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-ink">
                {t('segnalaCategoriaLabel')}
              </legend>
              <div className="space-y-1.5">
                {CATEGORIE.map((c) => (
                  <label
                    key={c}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 font-maven text-sm transition-colors ${
                      categoria === c
                        ? 'border-kidville-green bg-kidville-green-soft text-kidville-green font-semibold'
                        : 'border-kidville-line text-kidville-ink hover:bg-kidville-neutral-soft'
                    }`}
                  >
                    <input
                      type="radio"
                      name="segnala-categoria"
                      value={c}
                      checked={categoria === c}
                      onChange={() => setCategoria(c)}
                      className="accent-kidville-green"
                    />
                    <span>{t(`segnalaCat_${c}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="mb-4 block">
              <span className="mb-1.5 block font-barlow text-xs font-bold uppercase tracking-wide text-kidville-ink">
                {t('segnalaNoteLabel')}
              </span>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder={t('segnalaNotePlaceholder')}
                className="w-full resize-none rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/20"
              />
            </label>

            {errore && (
              <p role="alert" className="mb-3 rounded-xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error">
                {t('segnalaErrore')}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={chiudi}
                disabled={submitting}
                className="rounded-full px-4 py-2 font-maven text-sm font-semibold text-kidville-muted transition-colors hover:bg-kidville-neutral-soft disabled:opacity-60"
              >
                {t('segnalaAnnulla')}
              </button>
              <button
                type="button"
                onClick={invia}
                disabled={submitting}
                className="flex items-center gap-2 rounded-full bg-kidville-green px-5 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green/90 disabled:opacity-60"
              >
                <Flag size={14} strokeWidth={2.5} />
                {submitting ? t('segnalaInvio') : t('segnalaInvia')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
