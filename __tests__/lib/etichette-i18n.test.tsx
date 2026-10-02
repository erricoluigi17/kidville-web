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
import etichetteIt from '../../messages/it/etichette.json';
import etichetteEn from '../../messages/en/etichette.json';
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

describe('etichette i18n — i tipi notifica dei video (PR 2, T7)', () => {
  // `etichette.json` VINCE sul catalogo (`useTipoNotifica` guarda prima la chiave i18n): se le due sorgenti dicono cose diverse il pannello
  // mostra quella del JSON e il catalogo resta una bugia. Qui si tengono uguali, per ciascuno dei tre tipi toccati dal 02/10.
  const TIPI = ['galleria', 'video_esito', 'video_liberatoria_revocata'] as const

  it('l’etichetta del tipo `galleria` dice «contenuti»: lo stesso tipo annuncia anche i video', () => {
    expect(TIPI_NOTIFICA.galleria.label).toBe('Nuovi contenuti in galleria');
    const { result } = renderHook(() => useTipoNotifica());
    expect(result.current('galleria').label).toBe('Nuovi contenuti in galleria');
    expect(result.current('galleria').descrizione).toBe('Quando vengono pubblicate foto o video della sezione del figlio');
  });

  it('i due tipi nuovi: l’esito è del docente, l’avviso di liberatoria è dello staff e di sicurezza', () => {
    expect(TIPI_NOTIFICA.video_esito).toMatchObject({ gruppo: 'docente' });
    expect(TIPI_NOTIFICA.video_liberatoria_revocata).toMatchObject({ gruppo: 'staff', sicurezza: true });
  });

  it.each(TIPI)('`%s`: la chiave i18n (it) è uguale al catalogo, e quella inglese esiste', (tipo) => {
    const it = etichetteIt as Record<string, string>;
    const en = etichetteEn as Record<string, string>;
    expect(it[`notifica_${tipo}_label`]).toBe(TIPI_NOTIFICA[tipo].label);
    expect(it[`notifica_${tipo}_desc`]).toBe(TIPI_NOTIFICA[tipo].descrizione);
    expect(en[`notifica_${tipo}_label`], 'manca l’etichetta inglese').toBeTruthy();
    expect(en[`notifica_${tipo}_desc`], 'manca la descrizione inglese').toBeTruthy();
    const { result } = renderHook(() => useTipoNotifica());
    expect(result.current(tipo)).toEqual({ label: TIPI_NOTIFICA[tipo].label, descrizione: TIPI_NOTIFICA[tipo].descrizione });
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
