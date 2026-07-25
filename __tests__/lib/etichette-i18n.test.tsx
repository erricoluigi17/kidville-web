import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';

// Verifica il MECCANISMO DI SICUREZZA della i18n delle librerie di etichette
// condivise (namespace `etichette`): per ogni libreria la funzione pura resta
// retro-compatibile (IT), e accanto vive un hook locale-aware che risolve le
// chiavi `etichette.*`. Il mock globale di next-intl (test/setup.ts) risolve
// contro messages/it/etichette.json, quindi qui verifichiamo sia le traduzioni
// sia la tenuta della funzione pura come fallback.

import { labelRuolo, useLabelRuolo } from '@/lib/auth/ruoli';
import { allergeneLabel, useAllergeneLabel } from '@/lib/mensa/allergeni';
import { AGING_LABEL, useAgingLabel } from '@/lib/pagamenti/aging';
import { UMORE_CONFIG, useUmoreLabel } from '@/lib/diary/umore';
import { TIPI_NOTIFICA, useTipoNotifica } from '@/lib/notifiche/tipi';
import { getEventConfig, useEventLabel } from '@/components/features/teacher/diary/eventConfig';

describe('etichette i18n — ruoli', () => {
  it('la funzione pura resta in italiano (retro-compat)', () => {
    expect(labelRuolo('educator')).toBe('Docente');
    expect(labelRuolo('coordinator')).toBe('Direzione');
    // Codice ignoto → valore grezzo, mai la chiave.
    expect(labelRuolo('xyz')).toBe('xyz');
  });
  it('lo hook risolve la chiave etichette', () => {
    const { result } = renderHook(() => useLabelRuolo());
    expect(result.current('educator')).toBe('Docente');
    expect(result.current('genitore')).toBe('Genitore');
  });
});

describe('etichette i18n — allergeni', () => {
  it('la funzione pura resta in italiano', () => {
    expect(allergeneLabel('glutine')).toBe('Glutine');
    expect(allergeneLabel('latte')).toBe('Latte / lattosio');
  });
  it('lo hook risolve la chiave etichette', () => {
    const { result } = renderHook(() => useAllergeneLabel());
    expect(result.current('glutine')).toBe('Glutine');
    expect(result.current('molluschi')).toBe('Molluschi');
  });
});

describe('etichette i18n — aging pagamenti', () => {
  it('la mappa pura resta in italiano', () => {
    expect(AGING_LABEL.scaduti_oltre_30).toBe('Scaduti oltre 30gg');
  });
  it('lo hook risolve la chiave etichette', () => {
    const { result } = renderHook(() => useAgingLabel());
    expect(result.current('scaduti_oltre_30')).toBe('Scaduti oltre 30gg');
    expect(result.current('mese')).toBe('Prossimi 30gg');
  });
});

describe('etichette i18n — umore diario', () => {
  it('la config pura resta in italiano', () => {
    expect(UMORE_CONFIG.felice.label).toBe('Felice');
  });
  it('lo hook risolve la chiave etichette', () => {
    const { result } = renderHook(() => useUmoreLabel());
    expect(result.current('felice')).toBe('Felice');
    expect(result.current('cosi_cosi')).toBe('Così così');
  });
});

describe('etichette i18n — tipi notifica', () => {
  it('il catalogo puro resta in italiano', () => {
    expect(TIPI_NOTIFICA.avviso.label).toBe('Avvisi e circolari');
  });
  it('lo hook risolve label e descrizione', () => {
    const { result } = renderHook(() => useTipoNotifica());
    const avviso = result.current('avviso');
    expect(avviso.label).toBe('Avvisi e circolari');
    expect(avviso.descrizione).toBe('Quando la scuola pubblica un avviso destinato alla famiglia');
  });
});

describe('etichette i18n — eventi diario', () => {
  it('la config pura resta in italiano (incluso legacy)', () => {
    expect(getEventConfig('pranzo').label).toBe('Pranzo');
    expect(getEventConfig('entrata').label).toBe('Entrata');
  });
  it('lo hook risolve la chiave etichette', () => {
    const { result } = renderHook(() => useEventLabel());
    expect(result.current('pranzo')).toBe('Pranzo');
    expect(result.current('entrata')).toBe('Entrata');
  });
});
