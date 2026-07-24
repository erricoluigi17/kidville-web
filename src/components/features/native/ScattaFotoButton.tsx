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
  /** Testo visibile accanto all'icona. Omesso → bottone solo-icona (icona +
   *  `aria-label`). */
  label?: string;
  /** Dimensione icona lucide (px). Default 15. */
  iconSize?: number;
  disabled?: boolean;
  /** Coerenza con l'`multiple` dell'input dell'host (la fotocamera resta 1 scatto). */
  multiplo?: boolean;
}

/**
 * Bottone NATIVE-ONLY «Scatta foto». Additivo: si affianca a un `<input type=file>`
 * che accetta anche PDF/doc SENZA sostituirlo. Su web (e in SSR) non rende nulla —
 * l'input di sempre resta l'unico trigger e il supporto PDF è intatto. Su nativo
 * apre la fotocamera Capacitor (`scegliFotoNativa`) e consegna ogni File allo
 * STESSO handler dell'host, così il flusso di upload non cambia.
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
  iconSize = 15,
  disabled = false,
  multiplo = false,
}: Props) {
  const t = useTranslations('shared');
  const nativo = useClientValue(() => fotocameraNativaDisponibile(), false);
  if (!nativo) return null;

  const scatta = async () => {
    const files = await scegliFotoNativa({ multiplo });
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
      {label ? <span>{label}</span> : null}
    </button>
  );
}
