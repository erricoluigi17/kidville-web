'use client';

import { useTranslations } from 'next-intl';
import { Camera } from 'lucide-react';
import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera';
import { useClientValue } from '@/lib/hooks/use-client-value';

interface Props {
  /** Chiamato per OGNI File scelto dalla fotocamera nativa (0..n). È lo STESSO
   *  handler che l'host usa per `e.target.files` dell'<input type=file>. */
  onFile: (file: File) => void;
  /** Classi del bottone: passale per allineare lo stile ai secondari dell'host. */
  className?: string;
  /** Testo visibile accanto all'icona. Omesso → `shared.scattaFoto` (tradotto).
   *  Passalo solo per dire qualcosa di DIVERSO da «Scatta foto». */
  label?: string;
  /** Bottone di sola icona (l'aria-label resta). Dove lo spazio è minimo. */
  soloIcona?: boolean;
  /** Dimensione icona lucide (px). Default 15. */
  iconSize?: number;
  disabled?: boolean;
  /** Coerenza con l'`multiple` dell'input dell'host (la fotocamera resta 1 scatto). */
  multiplo?: boolean;
  /** Problema vero (permesso negato o errore), NON l'annullamento dell'utente. */
  onErrore?: (codice: 'permesso_negato' | 'errore') => void;
}

/**
 * Bottone NATIVE-ONLY «Scatta foto». Additivo: si affianca a un `<input type=file>`
 * che accetta anche PDF/doc SENZA sostituirlo. Su web (e in SSR) non rende nulla —
 * l'input di sempre resta l'unico trigger e il supporto PDF è intatto. Su nativo
 * apre la fotocamera Capacitor (`scegliFotoNativa`) e consegna ogni File allo
 * STESSO handler dell'host, così il flusso di upload non cambia.
 *
 * Il testo visibile arriva dalla STESSA chiave i18n dell'`aria-label`
 * (`shared.scattaFoto`). Non è un dettaglio: cinque host passavano un
 * `label="Scatta foto"` cablato mentre l'aria-label era tradotto, ed è
 * esattamente così che le due etichette dello stesso bottone divergono. Chi
 * vuole un testo diverso passa `label`; chi vuole solo l'icona passa `soloIcona`.
 *
 * Il gate nativo passa da `useClientValue` (useSyncExternalStore): `false` in SSR
 * e al primo render client, valore reale dopo l'hydration → nessun mismatch di
 * hydration e nessun setState-in-effect (lock react-hooks/set-state-in-effect).
 *
 * L'annullamento da parte dell'utente è UX attesa: `scegliFotoNativa` ritorna `[]`
 * e l'handler non viene chiamato (nessun errore, nessun log — come `@/lib/native/*`).
 */
export function ScattaFotoButton({
  onFile,
  className,
  label,
  soloIcona = false,
  iconSize = 15,
  disabled = false,
  multiplo = false,
  onErrore,
}: Props) {
  const t = useTranslations('shared');
  const nativo = useClientValue(() => fotocameraNativaDisponibile(), false);
  if (!nativo) return null;

  const testo = soloIcona ? null : (label ?? t('scattaFoto'));

  const scatta = async () => {
    const files = await scegliFotoNativa({
      multiplo,
      onErrore,
      etichette: {
        intestazione: t('cameraTitolo'),
        scatta: t('cameraScatta'),
        libreria: t('cameraLibreria'),
        annulla: t('cameraAnnulla'),
      },
    });
    for (const f of files) onFile(f);
  };

  return (
    <button
      type="button"
      aria-label={t('scattaFoto')}
      title={t('scattaFoto')}
      disabled={disabled}
      onClick={() => { void scatta(); }}
      className={className}
    >
      <Camera size={iconSize} strokeWidth={2} aria-hidden="true" />
      {testo ? <span>{testo}</span> : null}
    </button>
  );
}
