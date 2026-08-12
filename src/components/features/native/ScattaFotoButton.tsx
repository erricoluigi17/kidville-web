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
  /**
   * Il NOME ACCESSIBILE, quando «Scatta foto» non basta a distinguere due bottoni.
   *
   * ── PERCHÉ È UNA PROP A PARTE, E NON `label` ────────────────────────────────
   *
   * `label` è il testo che si VEDE; questo è il nome che si SENTE. Tenerli separati
   * serve dove il testo visibile deve restare corto e il nome no: un elenco di
   * bottoni pronunciati tutti «Scatta foto» è indistinguibile per chi naviga per
   * intestazioni o per comandi, e leggerne il testo non aiuta perché è lo stesso.
   *
   * ⚠️ CHI LO PASSA DEVE INCLUDERCI IL TESTO VISIBILE (WCAG 2.5.3, «Label in Name»):
   * chi comanda a voce pronuncia ciò che legge, e un nome accessibile che non
   * contiene le parole visibili rende il bottone inattivabile. La forma giusta è
   * «Scatta foto: <di che cosa>», non «<di che cosa>» da solo.
   *
   * ── IL DIFETTO CHE HA FATTO NASCERE QUESTA PROP (12/08/2026) ────────────────
   *
   * Il passo «Documento» di `/anagrafica-personale` chiede due scansioni — fronte e
   * retro — e ogni `FileField` che ammette immagini rende questo bottone. Nell'app
   * nativa quello è, per ammissione del commento accanto in `FieldRenderer`, «il modo
   * normale di consegnare la scansione del documento»: erano DUE bottoni con lo
   * stesso identico nome accessibile, uno sopra l'altro, e niente diceva quale fosse
   * quale. Nessun test ESISTENTE lo vedeva — su web questo componente non rende nulla,
   * quindi in jsdom di default non esiste — ed è la ragione per cui il rilievo è arrivato
   * da una lettura e non da un rosso.
   *
   * ⚠️ QUI C'ERA SCRITTO «nessun test POTEVA vederlo», e non era vero: basta mockare
   * `fotocameraNativaDisponibile` perché il bottone esista anche in jsdom. Lo fa
   * `__tests__/a11y/scatta-foto-due-facce.test.tsx`, che monta le due facce del template
   * e pretende due `aria-label` diversi. «Non c'era una prova» e «una prova non è
   * possibile» sono due frasi diverse, e la seconda scoraggia proprio chi passerebbe a
   * scriverla.
   */
  nomeAccessibile?: string;
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
  nomeAccessibile,
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
  // Il default NON cambia: chi non passa `nomeAccessibile` continua a chiamarsi
  // «Scatta foto» tradotto, che è ciò che gli otto host esistenti si aspettano.
  const nome = nomeAccessibile ?? t('scattaFoto');

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
      aria-label={nome}
      title={nome}
      disabled={disabled}
      onClick={() => { void scatta(); }}
      className={className}
    >
      <Camera size={iconSize} strokeWidth={2} aria-hidden="true" />
      {testo ? <span>{testo}</span> : null}
    </button>
  );
}
