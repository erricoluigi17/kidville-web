import { expect, it, vi } from 'vitest'

/**
 * Regressione del foglio aperto DOPO che lo scarico era già stato annullato.
 *
 * Il punto delicato non è `Share.share`, ma l'import dinamico che lo precede:
 * l'import non accetta un AbortSignal e può terminare quando il chiamante ha già
 * restituito «annullato». Questo test usa il modulo `share.ts` reale e tiene
 * sospeso soltanto `@capacitor/share`, cioè esattamente quella finestra.
 */
const h = vi.hoisted(() => {
  let risolviImport!: () => void
  const importShare = new Promise<void>((resolve) => {
    risolviImport = resolve
  })

  return {
    importShare,
    risolviImport,
    importIniziato: false,
    share: vi.fn(async () => ({})),
  }
})

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => true }))

vi.mock('@capacitor/share', async () => {
  h.importIniziato = true
  await h.importShare
  return { Share: { share: h.share } }
})

import { condividiFileLocale, condividiLink } from '@/lib/native/share'

it('un abort o timeout durante l’import non apre Share; senza signal resta compatibile', async () => {
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(10)

  const fileAnnullato = condividiFileLocale(
    'file:///cache/fattura-annullata.pdf',
    'Fattura',
    controller.signal,
  )
  const linkScaduto = condividiLink({ url: 'https://kidville.test/fattura' }, timeout)

  await vi.waitFor(() => expect(h.importIniziato).toBe(true))
  controller.abort()
  await vi.waitFor(() => expect(timeout.aborted).toBe(true))

  // Fino a qui il plugin non è caricato: nessun effetto può essere partito.
  expect(h.share).not.toHaveBeenCalled()
  h.risolviImport()

  await expect(fileAnnullato).resolves.toBe(false)
  await expect(linkScaduto).resolves.toBe('non-riuscita')
  expect(h.share).not.toHaveBeenCalled()

  const fileSenzaSignal = condividiFileLocale(
    'file:///cache/fattura-condivisa.pdf',
    'Fattura',
  )
  await expect(fileSenzaSignal).resolves.toBe(true)

  // Solo il chiamante storico, privo di signal, conserva il comportamento precedente.
  expect(h.share).toHaveBeenCalledTimes(1)
  expect(h.share).toHaveBeenCalledWith({
    files: ['file:///cache/fattura-condivisa.pdf'],
    title: 'Fattura',
  })
})
