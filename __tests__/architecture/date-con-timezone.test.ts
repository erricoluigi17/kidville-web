import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'
import { APP_TIMEZONE, LOCALE_BCP47, bcp47, intlDateTime } from '@/i18n/config'
import { formatData, nomeMese, type FormatoData } from '@/lib/i18n/date'

/**
 * LOCK — il FUSO è dichiarato, la REGIONE è una sola.
 *
 * `Intl.DateTimeFormat(locale, opzioni)` senza `timeZone` usa il fuso
 * DELL'AMBIENTE. Su Vercel il processo gira in UTC, il browser di una famiglia
 * italiana in Europe/Rome: lo stesso identico istante rende due GIORNI diversi.
 * Misurato il 2026-07-31 su `2026-07-30T22:30:00Z`:
 *   TZ=UTC          → «giovedì 30 luglio»
 *   TZ=Europe/Rome  → «venerdì 31 luglio»
 *
 * Qui non è un dettaglio cosmetico: la data è la CHIAVE di presenze, registro e
 * diario, e il vincolo di unicità del registro è (sede, classe, data, ora). Un
 * giorno di scarto è una presenza segnata sul giorno sbagliato.
 *
 * Secondo difetto, stessa radice: `LOCALES = ['it','en']` espone un locale
 * SENZA regione, e `Intl` risolve `'en'` su en-US (mese/giorno/anno). Il
 * calendario Mensa aveva corretto a mano con `en-GB` (giorno/mese/anno): lo
 * stesso prodotto leggeva «8/10/2026» in due modi opposti.
 *
 * LE QUATTRO REGOLE:
 *  1. ogni voce di `OPZIONI` in `src/lib/i18n/date.ts` dichiara il suo `timeZone`;
 *  2. ogni `new Intl.DateTimeFormat(` in `src/` dichiara `timeZone` fra le opzioni
 *     (il modo normale è passare da `intlDateTime()`, che lo mette per costruzione);
 *  3. la regione della lingua si decide SOLO in `src/i18n/config.ts` — nessun
 *     `'en-GB'`/`'en-US'` cablato altrove;
 *  4. in un componente client, `.format(new Date())` nel corpo del render è un
 *     disallineamento di idratazione: va dietro `useClientValue`.
 *
 * Il test funzionale (il primo blocco) è scritto per dare lo STESSO risultato
 * sotto `TZ=UTC` e sotto `TZ=Europe/Rome`: se il fuso torna a dipendere
 * dall'ambiente, sotto UTC diventa rosso e NOMINA la voce che l'ha perso.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. COMPORTAMENTO — lo stesso istante rende lo stesso testo in ogni fuso
// ─────────────────────────────────────────────────────────────────────────────

/** 2026-07-30 22:30 UTC = 2026-07-31 00:30 a Roma. Mezzanotte e mezza: il caso
 *  in cui il giorno del server e il giorno del genitore NON coincidono. */
const ISTANTE = '2026-07-30T22:30:00Z'

/** Attesi calcolati per Europe/Rome: indipendenti dal `TZ` del processo. */
const ATTESI_IT: Record<FormatoData, string> = {
  lunga: '31 luglio 2026',
  breve: '31/07/2026',
  dataOra: '31/07/2026, 00:30',
  ora: '00:30',
  giornoMese: '31 luglio',
  meseAnno: 'luglio 2026',
}

const ATTESI_EN: Record<FormatoData, string> = {
  lunga: '31 July 2026',
  breve: '31/07/2026',
  dataOra: '31/07/2026, 00:30',
  ora: '00:30',
  giornoMese: '31 July',
  meseAnno: 'July 2026',
}

describe('formatData — il fuso non dipende dall\'ambiente', () => {
  for (const [voce, atteso] of Object.entries(ATTESI_IT) as [FormatoData, string][]) {
    it(`it · «${voce}» rende l'ora di Roma, non quella del processo`, () => {
      expect(formatData(ISTANTE, 'it', voce)).toBe(atteso)
    })
  }

  for (const [voce, atteso] of Object.entries(ATTESI_EN) as [FormatoData, string][]) {
    it(`en · «${voce}» rende l'ora di Roma nel formato britannico`, () => {
      expect(formatData(ISTANTE, 'en', voce)).toBe(atteso)
    })
  }

  it('en usa giorno/mese/anno (en-GB), non mese/giorno/anno (en-US)', () => {
    // Controllo positivo accanto all'asserzione negativa: l'11 non è ambiguo,
    // il 31 sì — con en-US «31/07» non esiste proprio come mese.
    expect(formatData('2026-08-11T10:00:00Z', 'en', 'breve')).toBe('11/08/2026')
    expect(formatData('2026-08-11T10:00:00Z', 'en', 'breve')).not.toBe('08/11/2026')
  })

  it('il locale già in forma BCP47 non viene ri-mappato (idempotenza)', () => {
    expect(formatData(ISTANTE, 'en-GB', 'breve')).toBe('31/07/2026')
    expect(formatData(ISTANTE, 'it-IT', 'lunga')).toBe('31 luglio 2026')
  })

  it('nomeMese resta ancorato a UTC e non slitta di un mese', () => {
    expect(nomeMese(1, 'it')).toBe('Gennaio')
    expect(nomeMese(12, 'en')).toBe('December')
  })

  it('bcp47 mappa le due lingue su una regione esplicita', () => {
    expect(LOCALE_BCP47).toEqual({ it: 'it-IT', en: 'en-GB' })
    expect(bcp47('it')).toBe('it-IT')
    expect(bcp47('en')).toBe('en-GB')
    expect(bcp47('en-GB')).toBe('en-GB')
    expect(bcp47(undefined)).toBe('it-IT')
    expect(bcp47('klingon')).toBe('it-IT')
  })

  it('intlDateTime mette il fuso di default e lascia sovrascriverlo', () => {
    expect(APP_TIMEZONE).toBe('Europe/Rome')
    expect(intlDateTime('it').resolvedOptions().timeZone).toBe('Europe/Rome')
    expect(intlDateTime('it', { timeZone: 'UTC' }).resolvedOptions().timeZone).toBe('UTC')
    // Il formatter è un vero Intl.DateTimeFormat: `.format` e `.formatToParts`.
    expect(
      intlDateTime('it', { hour: '2-digit', minute: '2-digit' }).format(new Date(ISTANTE)),
    ).toBe('00:30')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. La configurazione di richiesta di next-intl dichiara il fuso
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('next-intl/server', () => ({
  // `getRequestConfig` avvolge il callback: qui lo restituiamo nudo, così il
  // test può invocarlo come lo invocherebbe next-intl a ogni richiesta.
  getRequestConfig: (fn: unknown) => fn,
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

describe('getRequestConfig', () => {
  it('ritorna timeZone Europe/Rome insieme a locale e messaggi', async () => {
    const config = (await import('@/i18n/request')).default as unknown as (
      p: unknown,
    ) => Promise<{ locale: string; timeZone?: string; messages: Record<string, unknown> }>
    const out = await config({})
    expect(out.locale).toBe('it')
    expect(out.timeZone).toBe('Europe/Rome')
    // Controllo positivo: la config non è vuota, i cataloghi ci sono davvero.
    expect(Object.keys(out.messages).length).toBeGreaterThan(20)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. LOCK DI FORMA sul sorgente
// ─────────────────────────────────────────────────────────────────────────────

const SRC = path.join(process.cwd(), 'src')
const DATE_TS = path.join(SRC, 'lib', 'i18n', 'date.ts')
const CONFIG_TS = path.join(SRC, 'i18n', 'config.ts')

/** Indice DOPO la graffa che chiude quella aperta in `apertura`. */
function fineGraffa(strut: string, apertura: number): number {
  let livello = 0
  for (let k = apertura; k < strut.length; k++) {
    if (strut[k] === '{') livello++
    else if (strut[k] === '}') {
      livello--
      if (livello === 0) return k + 1
    }
  }
  return strut.length
}

describe('OPZIONI di date.ts — ogni voce dichiara il suo fuso', () => {
  const src = fs.readFileSync(DATE_TS, 'utf8')
  const { struttura, senzaCommenti } = mascheraSorgente(src)
  const inizio = struttura.indexOf('const OPZIONI')
  const apertura = struttura.indexOf('{', inizio)
  const fine = fineGraffa(struttura, apertura)

  it('il blocco OPZIONI è riconoscibile (se cambia forma, il lock va riscritto)', () => {
    expect(inizio).toBeGreaterThan(-1)
    expect(fine).toBeGreaterThan(apertura)
  })

  // Le voci del record: `nome: { … }` al primo livello di annidamento.
  const voci: { nome: string; corpo: string; riga: number }[] = []
  {
    let k = apertura + 1
    while (k < fine - 1) {
      const m = /^\s*([A-Za-z0-9_$]+)\s*:\s*\{/.exec(struttura.slice(k, fine - 1))
      if (!m) break
      const apreVoce = k + m[0].length - 1
      const chiudeVoce = fineGraffa(struttura, apreVoce)
      voci.push({
        nome: m[1],
        corpo: senzaCommenti.slice(apreVoce, chiudeVoce),
        riga: riga(src, apreVoce),
      })
      k = chiudeVoce
      while (k < fine && /[\s,]/.test(struttura[k])) k++
    }
  }

  it('le voci lette dal sorgente sono le stesse esposte dal tipo FormatoData', () => {
    expect(voci.map(v => v.nome).sort()).toEqual(Object.keys(ATTESI_IT).sort())
  })

  for (const voce of voci) {
    it(`«${voce.nome}» dichiara timeZone`, () => {
      expect(
        /\btimeZone\s*:/.test(voce.corpo),
        `src/lib/i18n/date.ts:${voce.riga} — la voce «${voce.nome}» di OPZIONI non dichiara ` +
          'timeZone: sotto un runtime UTC renderebbe il giorno sbagliato.',
      ).toBe(true)
    })
  }
})

describe('nessuna Intl.DateTimeFormat senza timeZone in src/', () => {
  it('ogni costruzione dichiara il fuso', () => {
    const colpevoli: string[] = []
    for (const file of fileSorgente(SRC)) {
      const src = fs.readFileSync(file, 'utf8')
      const { struttura, senzaCommenti } = mascheraSorgente(src)
      const re = /new\s+Intl\.DateTimeFormat\s*\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(struttura))) {
        const apertura = m.index + m[0].length - 1
        const fine = fineParentesi(struttura, apertura)
        const argomenti = senzaCommenti.slice(apertura, fine)
        if (!/\btimeZone\s*:/.test(argomenti)) {
          colpevoli.push(`${path.relative(process.cwd(), file)}:${riga(src, m.index)}`)
        }
      }
    }
    expect(
      colpevoli,
      'Queste costruzioni usano il fuso DELL\'AMBIENTE (UTC su Vercel, Europe/Rome nel ' +
        'browser): lo stesso istante rende giorni diversi. Usa intlDateTime() da ' +
        '@/i18n/config, oppure dichiara timeZone esplicitamente:\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })
})

describe('la regione della lingua si decide in un punto solo', () => {
  it('nessun en-GB / en-US cablato fuori da src/i18n/config.ts', () => {
    const colpevoli: string[] = []
    for (const file of fileSorgente(SRC)) {
      if (path.resolve(file) === path.resolve(CONFIG_TS)) continue
      const src = fs.readFileSync(file, 'utf8')
      const { senzaCommenti } = mascheraSorgente(src)
      const re = /['"`]en-(?:GB|US)['"`]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(senzaCommenti))) {
        colpevoli.push(`${path.relative(process.cwd(), file)}:${riga(src, m.index)}`)
      }
    }
    expect(
      colpevoli,
      'La regione della lingua inglese è una decisione di prodotto e vive in ' +
        'LOCALE_BCP47 (src/i18n/config.ts). Deciderla di nuovo qui è come è nato il ' +
        'difetto: en-US quasi ovunque, en-GB nel solo calendario Mensa.\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })
})

describe('la data di ADESSO non si formatta nel corpo del render', () => {
  it('in un componente client, .format(new Date()) sta dentro useClientValue', () => {
    const colpevoli: string[] = []
    for (const file of fileSorgente(SRC)) {
      const src = fs.readFileSync(file, 'utf8')
      if (!/^\s*['"]use client['"]/m.test(src)) continue
      const { struttura } = mascheraSorgente(src)

      // Range protetti: il corpo di ogni useClientValue(…).
      const protetti: [number, number][] = []
      const reHook = /\buseClientValue\s*\(/g
      let h: RegExpExecArray | null
      while ((h = reHook.exec(struttura))) {
        const apertura = h.index + h[0].length - 1
        protetti.push([apertura, fineParentesi(struttura, apertura)])
      }

      const re = /\.format\s*\(\s*new\s+Date\s*\(\s*\)\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(struttura))) {
        const dentro = protetti.some(([a, b]) => m!.index > a && m!.index < b)
        if (!dentro) colpevoli.push(`${path.relative(process.cwd(), file)}:${riga(src, m.index)}`)
      }
    }
    expect(
      colpevoli,
      'Il server rende l\'HTML con il SUO orologio, il browser con il proprio: fra le ' +
        '00:00 e le 02:00 italiane le due date non coincidono e React segnala il ' +
        'disallineamento. Il valore va dietro useClientValue (@/lib/hooks/use-client-value), ' +
        'come il saluto orario.\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })
})
