import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import itPublic from '../../messages/it/public.json'
import enPublic from '../../messages/en/public.json'

const IT_S = itShared as Record<string, unknown>
const EN_S = enShared as Record<string, unknown>
const IT_P = itPublic as Record<string, unknown>
const EN_P = enPublic as Record<string, unknown>

// Contratto della migrazione degli ULTIMI residui i18n. Chiavi FLAT prefissate:
// `bio*`/`media*` nel namespace `shared`, `iscr*`/`wizard*`/`modulo*` in `public`.
// Se un componente usa t('x') senza la chiave, il mock next-intl (test/setup.ts)
// risolve a "shared.x"/"public.x" e i render-test qui sotto vanno rossi.
const SHARED_RICHIESTE = [
  'bioMotivo', 'bioBloccatoAria', 'bioBloccatoTitolo', 'bioBloccatoCorpo', 'bioSblocca', 'bioEsci',
  'mediaScarica', 'mediaCondividi', 'mediaPrecedente', 'mediaSuccessiva',
  'mediaLinkCopiato', 'mediaLinkCopiatoLungo',
]
const PUBLIC_RICHIESTE = [
  'iscrMetaTitolo', 'iscrMetaDescrizione',
  'wizardEyebrow', 'wizardPassoDi', 'wizardBambino', 'wizardBambinoSub',
  'wizardAdulto', 'wizardAdultoObbligatorioSuffix', 'wizardAdultoSub',
  'wizardRiepilogo', 'wizardRiepilogoSub', 'wizardInviata', 'wizardInviataCorpo',
  'wizardAdultoInfo', 'wizardAggiungiFiglio', 'wizardAggiungiAdulto', 'wizardRimuovi',
  'wizardRiepilogoConteggio', 'wizardRiepilogoNota', 'wizardIndietro', 'wizardAvanti',
  'wizardInviaRichiesta', 'wizardInvioInCorso', 'wizardErroreInvio',
  'moduloMetaTitolo', 'moduloAccessoRiservato', 'moduloAccessoCorpo', 'moduloAccedi',
]

describe('i18n residui — parità e copertura chiavi', () => {
  it('shared: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(IT_S).sort()).toEqual(Object.keys(EN_S).sort())
  })

  it('public: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(IT_P).sort()).toEqual(Object.keys(EN_P).sort())
  })

  it('shared espone tutte le chiavi bio*/media*', () => {
    for (const k of SHARED_RICHIESTE) {
      expect(IT_S, `it/shared.json manca "${k}"`).toHaveProperty(k)
      expect(EN_S, `en/shared.json manca "${k}"`).toHaveProperty(k)
    }
  })

  it('public espone tutte le chiavi iscr*/wizard*/modulo*', () => {
    for (const k of PUBLIC_RICHIESTE) {
      expect(IT_P, `it/public.json manca "${k}"`).toHaveProperty(k)
      expect(EN_P, `en/public.json manca "${k}"`).toHaveProperty(k)
    }
  })

  it('le chiavi shared preesistenti non sono state rimosse', () => {
    for (const k of ['account', 'chiudi', 'esci', 'notifiche', 'tutteLeSedi']) {
      expect(IT_S).toHaveProperty(k)
      expect(EN_S).toHaveProperty(k)
    }
  })

  it('le rese inglesi non sono un copia-incolla di quelle italiane', () => {
    for (const k of ['bioBloccatoTitolo', 'mediaScarica', 'mediaPrecedente']) {
      expect(EN_S[k]).not.toEqual(IT_S[k])
    }
    for (const k of ['wizardEyebrow', 'wizardInviaRichiesta', 'moduloAccessoRiservato']) {
      expect(EN_P[k]).not.toEqual(IT_P[k])
    }
  })
})

// --- Render-test: le stringhe arrivano dal namespace, non da letterali ---------
import { MediaGrid, type MediaItem } from '@/components/features/gallery/MediaGrid'

describe('MediaGrid — title dal namespace shared', () => {
  it('i pulsanti Scarica/Condividi sulla card usano le chiavi media*', () => {
    const item: MediaItem = {
      id: 'm1', file_url: 'https://example.test/a.jpg', file_type: 'image',
      caption: null, tag_students: [], is_broadcast: false,
      created_at: new Date().toISOString(), uploader_name: 'Staff',
    }
    render(<MediaGrid items={[item]} showActions />)
    // Il mock next-intl risolve `shared.mediaScarica` → "Scarica": se la chiave
    // manca o il componente non è cablato, il title sarebbe "shared.mediaScarica".
    expect(screen.getAllByTitle('Scarica').length).toBeGreaterThan(0)
    expect(screen.getAllByTitle('Condividi').length).toBeGreaterThan(0)
  })
})

// FieldRenderer trascina ScattaFotoButton (Capacitor): lo stubbiamo perché qui
// verifichiamo solo l'ossatura del wizard (eyebrow, heading, navigazione).
vi.mock('@/components/features/forms/FieldRenderer', () => ({
  FieldRenderer: () => null,
}))

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

describe('EnrollmentWizard — stringhe dal namespace public', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: async () => ({}) })))
  })

  it('eyebrow, heading e navigazione usano le chiavi wizard*', async () => {
    render(<EnrollmentWizard scuolaId={null} />)
    // Il wizard non dipinge nessun passo finché non sa se il passo sede esiste
    // (qui la fetch delle sedi degrada: nessuna sede → si parte dal bambino).
    // Senza questa attesa si guarderebbe il caricamento, non il modulo.
    await waitFor(() => expect(screen.getByText('Bambino 1')).toBeInTheDocument())
    // L'heading compone il numero in JS (mock-safe): "Bambino 1" esatto.
    expect(screen.getByText('Iscrizione Nuovo Alunno')).toBeInTheDocument()
    expect(screen.getByText('Bambino 1')).toBeInTheDocument()
    expect(screen.getByText('Avanti')).toBeInTheDocument()
    expect(screen.getByText('Indietro')).toBeInTheDocument()
  })
})
