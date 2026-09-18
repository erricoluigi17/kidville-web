import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BATTITI_TOLLERATI,
  PERIODO_BATTITO_MS,
  PERIODO_SONDA_MS,
  SECONDI_LEASE_BATTITO,
  SECONDI_LEASE_PRESA,
  TETTO_INVOCAZIONE_MS,
  TETTO_SANDBOX_MS,
  sorvegliaConversione,
} from '@/lib/media/video/runner/battito'
import type { ComandoInCorso, EsitoBattito, EsitoComando } from '@/lib/media/video/runner/porte'

/**
 * IL BATTITO — la parte del runner che decide per quanto tempo un job resta nostro.
 *
 * Qui i doppi ci sono (un comando finto, un orologio finto), e la domanda da farsi
 * per ognuno è quella che in questo repo ha già salvato un collaudo: *che cosa
 * direbbe questo test se la logica sotto fosse sbagliata?* Perciò le asserzioni non
 * guardano «il battito è stato chiamato»: guardano **quante volte**, contro un
 * numero che si ricava dall'orologio. Un runner che battesse a ogni sonda invece
 * che a ogni periodo passerebbe il primo controllo e fallirebbe questo.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * I doppi. Nessuna rete, nessun timer vero: l'orologio lo muove `pausa`.
 * ──────────────────────────────────────────────────────────────────────────── */

const FINITO_BENE: EsitoComando = { exitCode: 0, stdout: 'ok', stderr: '' }

/** Un orologio che avanza solo quando il codice sotto prova dichiara di aspettare. */
function orologioFinto() {
  let ora = 1_000_000
  return {
    adesso: () => ora,
    pausa: async (ms: number) => {
      ora += ms
    },
    avanza: (ms: number) => {
      ora += ms
    },
  }
}

/** Un comando che finisce dopo `duraMs` di orologio simulato. */
function comandoCheDura(orologio: { adesso: () => number }, duraMs: number) {
  const inizio = orologio.adesso()
  let terminato = 0
  const comando: ComandoInCorso = {
    esito: async () => (orologio.adesso() - inizio >= duraMs ? FINITO_BENE : null),
    termina: async () => {
      terminato += 1
    },
  }
  return { comando, terminazioni: () => terminato }
}

function contatoreBattiti(risposte: (n: number) => EsitoBattito | Error) {
  let chiamate = 0
  return {
    chiamate: () => chiamate,
    battito: async (): Promise<EsitoBattito> => {
      chiamate += 1
      const risposta = risposte(chiamate)
      if (risposta instanceof Error) throw risposta
      return risposta
    },
  }
}

const SEMPRE_OK: EsitoBattito = { ok: true }

/* ────────────────────────────────────────────────────────────────────────────
 * I numeri, e da dove vengono
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · il ritmo si ricava dal tetto della lease, non a occhio', () => {
  it('il tetto è quello che `video_job_heartbeat` concede DAVVERO, letto dalla migrazione', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260916190100_video_job_transitions.sql'),
      'utf8',
    )
    const inizio = sql.indexOf('FUNCTION public.video_job_heartbeat')
    expect(inizio).toBeGreaterThan(0)
    const corpo = sql.slice(inizio, sql.indexOf('$$;', inizio))
    // La RPC NON prende `p_lease_seconds`: rinnova a un valore fisso. È quel valore,
    // non l'1–1800 della firma di `video_job_claim`, il tetto vero del battito.
    expect(corpo).toContain("lease_expires_at = v_now + interval '5 minutes'")
    expect(SECONDI_LEASE_BATTITO).toBe(300)
  })

  it('la presa in carico non chiede una lease più corta di quella che un battito rinnova', () => {
    // Una lease iniziale più breve del rinnovo darebbe una finestra stretta solo al
    // primo giro, cioè proprio quando il Sandbox si sta ancora accendendo.
    expect(SECONDI_LEASE_PRESA).toBeGreaterThanOrEqual(SECONDI_LEASE_BATTITO)
    // …e resta dentro il campo che le RPC accettano (1–1800).
    expect(SECONDI_LEASE_PRESA).toBeGreaterThanOrEqual(1)
    expect(SECONDI_LEASE_PRESA).toBeLessThanOrEqual(1800)
  })

  it('dentro una lease ci stanno almeno quattro battiti, e tre possono andare persi', () => {
    const finestre = Math.floor((SECONDI_LEASE_BATTITO * 1000) / PERIODO_BATTITO_MS)
    expect(finestre).toBeGreaterThanOrEqual(4)
    // Le occasioni utili sono quelle STRETTAMENTE prima della scadenza: un battito
    // che cade esattamente sull'istante di scadenza arriva tardi.
    expect(BATTITI_TOLLERATI).toBe(finestre - 1)
    expect(BATTITI_TOLLERATI).toBeGreaterThanOrEqual(3)
  })

  it('si guarda se il comando è finito molto più spesso di quanto si batta', () => {
    // Se sonda e battito coincidessero, un genitore aspetterebbe fino a un periodo
    // di battito dopo che la conversione è già finita.
    expect(PERIODO_SONDA_MS).toBeLessThan(PERIODO_BATTITO_MS)
    expect(PERIODO_BATTITO_MS % PERIODO_SONDA_MS).toBe(0)
  })

  it('il tetto della MicroVM sta largo sulla misura peggiore, ma resta un tetto', () => {
    // Misura del piano (2026-09-17, rumore sintetico 2,13 GB a 2 thread): 709 s di
    // wall. Il tetto deve contenerla con margine, e restare comunque un tetto.
    expect(TETTO_SANDBOX_MS).toBeGreaterThan(709_000 * 2)
    expect(TETTO_SANDBOX_MS).toBeLessThanOrEqual(3_600_000)
  })

  it('il tetto di UNA invocazione sta sotto i 300 s della piattaforma, con margine', () => {
    // 300 s è il `maxDuration` massimo delle route di questo repo. Dentro il margine
    // ci stanno l'apertura del Sandbox, l'apparecchio e la scrittura dell'esito.
    expect(TETTO_INVOCAZIONE_MS).toBeLessThan(300_000)
    expect(300_000 - TETTO_INVOCAZIONE_MS).toBeGreaterThanOrEqual(30_000)
    // E deve comunque contenere qualche battito, altrimenti sorvegliare non serve.
    expect(TETTO_INVOCAZIONE_MS).toBeGreaterThan(PERIODO_BATTITO_MS * 2)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * La sorveglianza
 * ──────────────────────────────────────────────────────────────────────────── */

describe('runner video · la sorveglianza a battiti', () => {
  it('un comando che finisce subito non consuma nessun battito', async () => {
    const orologio = orologioFinto()
    const { comando, terminazioni } = comandoCheDura(orologio, 0)
    const spia = contatoreBattiti(() => SEMPRE_OK)

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    })

    expect(esito).toEqual({ esito: 'finito', comando: FINITO_BENE, battiti: 0 })
    expect(spia.chiamate()).toBe(0)
    expect(terminazioni()).toBe(0)
  })

  it('batte una volta per PERIODO, non una volta per sonda', async () => {
    const orologio = orologioFinto()
    const durata = PERIODO_BATTITO_MS * 3 + PERIODO_SONDA_MS
    const { comando } = comandoCheDura(orologio, durata)
    const spia = contatoreBattiti(() => SEMPRE_OK)

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    })

    expect(esito.esito).toBe('finito')
    // Tre periodi interi ⇒ tre battiti. Le sonde sono state molte di più:
    // `durata / PERIODO_SONDA_MS` = (3 × 60 s + 10 s) / 10 s = 19.
    expect(spia.chiamate()).toBe(3)
    expect(durata / PERIODO_SONDA_MS).toBeGreaterThan(10)
  })

  it('un battito RIFIUTATO dal database ferma tutto: il job non è più nostro', async () => {
    const orologio = orologioFinto()
    const { comando, terminazioni } = comandoCheDura(orologio, TETTO_INVOCAZIONE_MS * 100)
    const spia = contatoreBattiti(() => ({ ok: false, code: 'FENCE_MISMATCH' }))

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    })

    expect(esito).toEqual({ esito: 'lease-persa', codice: 'FENCE_MISMATCH', battiti: 0 })
    // Un solo tentativo: `FENCE_MISMATCH` è il database che ha già dato il job a un
    // altro worker. Insistere vorrebbe dire due `ffmpeg` sullo stesso file.
    expect(spia.chiamate()).toBe(1)
    // E il comando si spegne: una MicroVM che continua a macinare per un job che non
    // è più nostro è tempo di CPU pagato per un'uscita che nessuno scriverà.
    expect(terminazioni()).toBe(1)
  })

  it('un battito che NON ARRIVA si tollera: è un contrattempo di rete, non un verdetto', async () => {
    const orologio = orologioFinto()
    // Sei periodi: i battiti utili sono quelli ai periodi 1…5, perché al sesto il
    // comando è già finito e la sonda lo vede prima di battere.
    const { comando } = comandoCheDura(orologio, PERIODO_BATTITO_MS * 6)
    // I primi due battiti non partono, poi la rete torna.
    const spia = contatoreBattiti((n) => (n <= 2 ? new Error('rete giù') : SEMPRE_OK))

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      // Tetto largo di proposito: qui si prova il RITMO del battito, non il
      // budget dell'invocazione, che ha il suo caso a parte.
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS * 10,
    })

    expect(esito.esito).toBe('finito')
    expect(spia.chiamate()).toBe(5)
    if (esito.esito === 'finito') expect(esito.battiti).toBe(3)
  })

  it('…ma non all’infinito: oltre i battiti tollerati la lease è morta di sicuro', async () => {
    const orologio = orologioFinto()
    const { comando, terminazioni } = comandoCheDura(orologio, TETTO_INVOCAZIONE_MS * 100)
    const spia = contatoreBattiti(() => new Error('rete giù'))

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      // Tetto largo di proposito: qui si prova il RITMO del battito, non il
      // budget dell'invocazione, che ha il suo caso a parte.
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS * 10,
    })

    expect(esito).toEqual({ esito: 'lease-persa', codice: 'LEASE_EXPIRED', battiti: 0 })
    expect(spia.chiamate()).toBe(BATTITI_TOLLERATI)
    expect(terminazioni()).toBe(1)
  })

  it('un battito riuscito azzera il conto dei tentativi andati a vuoto', async () => {
    const orologio = orologioFinto()
    const { comando } = comandoCheDura(orologio, PERIODO_BATTITO_MS * (BATTITI_TOLLERATI * 2 + 1))
    // Un successo ogni due tentativi: senza l'azzeramento, i «persi» si
    // accumulerebbero e la sorveglianza morirebbe a metà strada.
    const spia = contatoreBattiti((n) => (n % 2 === 0 ? SEMPRE_OK : new Error('rete giù')))

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      // Tetto largo di proposito: qui si prova il RITMO del battito, non il
      // budget dell'invocazione, che ha il suo caso a parte.
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS * 10,
    })

    expect(esito.esito).toBe('finito')
  })

  it('finito il tetto dell’invocazione si va via SENZA spegnere niente', async () => {
    const orologio = orologioFinto()
    const { comando, terminazioni } = comandoCheDura(orologio, Number.MAX_SAFE_INTEGER)
    const spia = contatoreBattiti(() => SEMPRE_OK)

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    })

    expect(esito.esito).toBe('in-corso')
    // ⚠️ L'asserzione che conta: la conversione NON viene fermata. Spegnerla qui
    // butterebbe via ogni video che dura più di quattro minuti, cioè quasi tutti.
    expect(terminazioni()).toBe(0)
    // La sorveglianza non è durata un istante di più del tetto dichiarato.
    expect(orologio.adesso() - 1_000_000).toBeLessThanOrEqual(
      TETTO_INVOCAZIONE_MS + PERIODO_SONDA_MS,
    )
    // E l'ultimo battito è recente: la lease deve sopravvivere fino al tick dopo.
    if (esito.esito === 'in-corso') expect(esito.battiti).toBeGreaterThanOrEqual(3)
  })

  it('un comando che finisce MALE è comunque «finito»: l’esito lo giudica chi ha chiamato', async () => {
    const orologio = orologioFinto()
    const male: EsitoComando = { exitCode: 137, stdout: '', stderr: 'Killed' }
    const comando: ComandoInCorso = { esito: async () => male, termina: async () => {} }
    const spia = contatoreBattiti(() => SEMPRE_OK)

    const esito = await sorvegliaConversione({
      comando,
      battito: spia.battito,
      adesso: orologio.adesso,
      pausa: orologio.pausa,
      tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    })

    expect(esito).toEqual({ esito: 'finito', comando: male, battiti: 0 })
  })
})
