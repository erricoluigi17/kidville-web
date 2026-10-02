import { describe, it, expect, vi } from 'vitest'

import { dipendenzeCaricamentoNews, type FirmaDelJob } from '@/components/features/admin/news/video/firma'
import type { ArchivioCaricamentiVideo } from '@/lib/media/video/upload'

/**
 * LA FIRMA TUS DI UN JOB DI NEWS, RINNOVABILE.
 *
 * Due punti del componente — il giro di un video nuovo e la ripresa al rientro — avevano due copie
 * dello stesso codice di rinnovo. Qui sta una copia sola, e si misura come la usa la libreria:
 * `intestazioni()` a ogni richiesta, `rinnovaFirma(jobId)` quando lo Storage rifiuta la firma.
 * Nessuna rete: il rinnovo è una funzione iniettata, e di ciò che fa si guardano i conteggi.
 */

const JOB = '22222222-2222-4222-8222-222222222222'
const ARCHIVIO = {} as ArchivioCaricamentiVideo

/** Una scadenza fra `ms` millisecondi: relativa a ora, perché la firma lo è. */
const fra = (ms: number): string => new Date(Date.now() + ms).toISOString()
const DUE_ORE = 2 * 60 * 60 * 1000

function banco(over: Partial<{ iniziale: FirmaDelJob; ancora: () => boolean; rinnova: () => Promise<FirmaDelJob | null> }> = {}) {
  const rinnova = vi.fn(over.rinnova ?? (async () => ({ firma: 'firma-nuova', scadeIl: fra(DUE_ORE) })))
  const dip = dipendenzeCaricamentoNews({
    archivio: ARCHIVIO,
    jobId: JOB,
    iniziale: over.iniziale ?? { firma: 'firma-iniziale', scadeIl: fra(DUE_ORE) },
    ancora: over.ancora ?? (() => true),
    rinnova,
  })
  return { dip, rinnova }
}

describe('le intestazioni di un job di News', () => {
  it('finché la firma vale rispondono con quella dell’apertura, senza chiedere niente a nessuno', async () => {
    const { dip, rinnova } = banco()

    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-iniziale' })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-iniziale' })

    // Il caso che costava 190 aperture per 44 job: una richiesta di rinnovo a ogni blocco spedito.
    expect(rinnova).not.toHaveBeenCalled()
    expect(dip.archivio).toBe(ARCHIVIO)
  })

  it('quando manca meno del margine alla scadenza la rinnovano da sole, e poi tengono la nuova', async () => {
    const { dip, rinnova } = banco({ iniziale: { firma: 'firma-vecchia', scadeIl: fra(5_000) } })

    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-nuova' })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-nuova' })

    expect(rinnova).toHaveBeenCalledTimes(1)
  })

  it('una firma senza scadenza leggibile si rinnova: nel dubbio non si spedisce con una che può essere scaduta', async () => {
    const { dip, rinnova } = banco({ iniziale: { firma: 'firma-vecchia', scadeIl: null } })

    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-nuova' })
    expect(rinnova).toHaveBeenCalledTimes(1)
  })

  it('fuori dal contesto non danno nessuna firma: la persona ha cambiato sede o lasciato la pagina', async () => {
    let ancora = true
    const { dip, rinnova } = banco({ ancora: () => ancora })
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-iniziale' })

    ancora = false

    await expect(dip.intestazioni()).rejects.toThrow('ContestoCambiato')
    expect(rinnova).not.toHaveBeenCalled()
  })
})

describe('il rinnovo chiesto dalla libreria quando lo Storage rifiuta la firma', () => {
  it('risponde con le intestazioni nuove, e da quel momento sono quelle di `intestazioni()`', async () => {
    const { dip, rinnova } = banco()

    expect(await dip.rinnovaFirma!(JOB)).toEqual({ 'x-signature': 'firma-nuova' })

    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-nuova' })
    // Una chiamata sola: `intestazioni()` ha trovato la firma nuova già buona.
    expect(rinnova).toHaveBeenCalledTimes(1)
  })

  it('due rinnovi insieme — quello proattivo e quello della libreria — sono UNA sola riapertura', async () => {
    let finisci: (f: FirmaDelJob) => void = () => {}
    const { dip, rinnova } = banco({
      iniziale: { firma: 'firma-vecchia', scadeIl: fra(1_000) },
      rinnova: () => new Promise<FirmaDelJob>((risolvi) => { finisci = risolvi }),
    })

    const insieme = Promise.all([dip.intestazioni(), dip.rinnovaFirma!(JOB), dip.intestazioni()])
    finisci({ firma: 'firma-nuova', scadeIl: fra(DUE_ORE) })

    expect(await insieme).toEqual([
      { 'x-signature': 'firma-nuova' },
      { 'x-signature': 'firma-nuova' },
      { 'x-signature': 'firma-nuova' },
    ])
    // Due aperture dell'intento per la stessa firma sarebbero due richieste sprecate, e due firme diverse in volo.
    expect(rinnova).toHaveBeenCalledTimes(1)
  })

  it('un rinnovo finito si può chiedere di nuovo: non resta incastrato sul risultato di prima', async () => {
    const firme = ['firma-uno', 'firma-due']
    const { dip, rinnova } = banco({
      rinnova: async () => ({ firma: firme.shift()!, scadeIl: fra(DUE_ORE) }),
    })

    expect(await dip.rinnovaFirma!(JOB)).toEqual({ 'x-signature': 'firma-uno' })
    expect(await dip.rinnovaFirma!(JOB)).toEqual({ 'x-signature': 'firma-due' })
    expect(rinnova).toHaveBeenCalledTimes(2)
  })

  it('se non c’è più niente da firmare rifiuta, e un rifiuto non blocca i rinnovi dopo', async () => {
    const risposte: Array<FirmaDelJob | null> = [null, { firma: 'firma-nuova', scadeIl: fra(DUE_ORE) }]
    const { dip } = banco({ rinnova: async () => risposte.shift() ?? null })

    await expect(dip.rinnovaFirma!(JOB)).rejects.toThrow('FirmaNonDisponibile')
    expect(await dip.rinnovaFirma!(JOB)).toEqual({ 'x-signature': 'firma-nuova' })
  })

  it('se il contesto è cambiato mentre aspettava la rete non consegna la firma', async () => {
    let ancora = true
    const { dip } = banco({
      ancora: () => ancora,
      rinnova: async () => {
        ancora = false
        return { firma: 'firma-nuova', scadeIl: fra(DUE_ORE) }
      },
    })

    await expect(dip.rinnovaFirma!(JOB)).rejects.toThrow('FirmaNonDisponibile')
  })

  it('un rinnovo chiesto per un altro job non si consegna a questo', async () => {
    const { dip, rinnova } = banco()

    await expect(dip.rinnovaFirma!('99999999-9999-4999-8999-999999999999')).rejects.toThrow('JobDiverso')
    expect(rinnova).not.toHaveBeenCalled()
  })
})
