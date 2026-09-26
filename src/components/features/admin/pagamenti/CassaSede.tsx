'use client';

// ─── Sede della scrittura in Cassa (P4b) ──────────────────────────────────────
// Decisione del titolare (26/09): la LETTURA della cassa unisce le sedi, ma ogni
// SCRITTURA (uscita/entrata manuale, svuota cassa, categorie, impostazioni) è di
// una sede sola, perché ogni sede è un cassetto a sé con il suo fondo e il suo
// saldo. Le route rispondono 400 se la sede è ambigua: qui la si fa scegliere
// PRIMA, dentro la finestra.
//
// Regola unica per le quattro finestre:
//  - una sola sede → è quella, e il selettore non compare;
//  - più sedi → selettore obbligatorio, e NESSUNA preselezione «a caso»: vale solo
//    `sedeIniziale`, e solo se è fra le sedi offerte (la sede già scelta dalla
//    pagina). Altrimenti la sede resta null finché l'utente non la sceglie;
//  - nessuna sede → null: la finestra non scrive.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SELECT } from './ui';

/** Una sede su cui l'utente può scrivere in cassa (le sedi EFFETTIVE del cockpit). */
export interface SedeCassa {
  id: string;
  nome: string;
}

/**
 * La sede su cui scrivere: l'unica, se è una; altrimenti quella scelta, purché sia
 * ancora fra le sedi offerte. Mai una sede indovinata.
 */
export function sedeDiLavoroCassa(sedi: readonly SedeCassa[], scelta: string | null): string | null {
  if (sedi.length === 1) return sedi[0].id;
  return scelta !== null && sedi.some((s) => s.id === scelta) ? scelta : null;
}

/** Stato della sede di una finestra: `scuolaId` è null finché non è determinata. */
export function useSedeCassa(sedi: readonly SedeCassa[], sedeIniziale: string | null) {
  const [scelta, setScelta] = useState<string | null>(sedeIniziale);
  return { scuolaId: sedeDiLavoroCassa(sedi, scelta), scegli: setScelta };
}

interface CampoProps {
  id: string;
  sedi: readonly SedeCassa[];
  valore: string | null;
  onCambia: (scuolaId: string) => void;
  disabled?: boolean;
  /** Id del messaggio d'errore quando la sede manca al salvataggio (WCAG 3.3.1). */
  erroreId?: string | null;
  className?: string;
}

/** Il selettore. Con una sede sola (o nessuna) non rende niente. */
export function CampoSedeCassa({ id, sedi, valore, onCambia, disabled, erroreId, className }: CampoProps) {
  const t = useTranslations('adminContabilita');
  if (sedi.length <= 1) return null;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaSedeLabel')}</label>
      <select
        id={id}
        value={valore ?? ''}
        disabled={disabled}
        onChange={(e) => { if (e.target.value) onCambia(e.target.value); }}
        className={SELECT}
        // Con più sedi la scelta è obbligatoria, e lo si dichiara PRIMA del salvataggio:
        // uno screen reader lo annuncia subito, non solo dopo l'errore (WCAG 3.3.2 / 4.1.2).
        // `aria-required` e non `required`: la validazione la fa la finestra, con il suo
        // messaggio tradotto, non il fumetto nativo del browser.
        aria-required="true"
        {...(erroreId ? { 'aria-invalid': true as const, 'aria-describedby': erroreId } : {})}
      >
        <option value="" disabled>{t('cassaSedeScegli')}</option>
        {sedi.map((s) => (
          <option key={s.id} value={s.id}>{s.nome.trim() || s.id}</option>
        ))}
      </select>
    </div>
  );
}
