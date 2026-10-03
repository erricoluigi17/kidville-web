// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'

import { VALIDITA_FIRMA_SECONDI, firmaPut } from '@/app/api/video-uploads/firme'
import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti'
import { schemaCoordinatePutVideo, schemaFileVideoDichiarato, schemaRinnovoVideo } from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES, validateVideoInputSize } from '@/lib/media/video/limiti'
import { generaTokenRinnovo, scadenzaTokenRinnovo } from '@/lib/media/video/token-rinnovo'
import {
  CODICI_NATIVI,
  CODICI_RIFIUTO_PONTE,
  EVENTI_LOG_NATIVI,
  EVENTI_PLUGIN_CARICAMENTI,
  HOST_DEBUG_CARICAMENTI,
  LATO_MASSIMO_FOTO,
  LATO_MINIATURA_VIDEO,
  MARGINE_RINNOVO_URL_SECONDI,
  METODI_PLUGIN_CARICAMENTI,
  MOTIVI_RIFIUTO,
  MOTORI_CARICAMENTI,
  MOTORI_PER_PIATTAFORMA,
  NOME_PLUGIN_CARICAMENTI,
  PIATTAFORME_CARICAMENTI,
  PROTOCOLLO_CARICAMENTI,
  QUALITA_FOTO,
  SCHEMI_METODI_CARICAMENTI,
  SORGENTI_SCELTA,
  STATI_NATIVI,
  STATI_TERMINALI_NATIVI,
  STATO_INIZIALE_NATIVO,
  TRANSIZIONI_STATO_NATIVO,
  VALIDITA_URL_PUT_SECONDI,
  eStatoTerminaleNativo,
  opzioniScegliMedia,
  schemaCaricamentoNativo,
  schemaElementoScelto,
  schemaEsitoAnnulla,
  schemaEsitoAnnullaScelta,
  schemaEsitoDimentica,
  schemaEsitoElenco,
  schemaEsitoScartaScelti,
  schemaEsitoScelta,
  schemaEventoPreparazione,
  schemaFotoLetta,
  schemaInfoCaricamenti,
  schemaOpzioniScegliMedia,
  schemaRichiestaAccodaVideo,
  schemaRichiestaAnnulla,
  schemaRichiestaDimentica,
  schemaRichiestaElenco,
  schemaRichiestaLeggiFoto,
  schemaRichiestaScartaScelti,
  transizioneNativaAmmessa,
  type CaricamentoNativo,
  type CodiceNativo,
  type ElementoScelto,
  type EsitoScelta,
  type InfoCaricamenti,
  type KidvilleCaricamentiPlugin,
  type MetodoPluginCaricamenti,
  type MotivoRifiuto,
  type RichiestaAccodaVideo,
  type StatoNativo,
} from '@/lib/native/caricamenti-nativi-tipi'

/**
 * IL CONTRATTO FRA IL JAVASCRIPT E IL PLUGIN `KidvilleCaricamenti` (spec PR 3, §4.1-§4.5, compito S1).
 *
 * Il modulo non fa niente: è un confine, e un confine si prova facendogli passare ciò che non deve passare. Per
 * questo il grosso del file sono rifiuti, uno per ogni difetto che la spec elenca (campo mancante, stato o codice
 * fuori elenco, `sha256` non esadecimale, URL non `https`) e per ogni limite che deve venire da `limiti.ts`. Ogni
 * caso parte da un oggetto VALIDO, già provato, e ne rompe UN campo: se il rifiuto nomina un altro campo il test
 * è verde per la ragione sbagliata, e per questo `rifiuta` controlla anche il percorso.
 *
 * Tre fonti che non si ricopiano, e come si prova che non lo sono:
 *  · i limiti di `limiti.ts`: il modulo viene rieseguito con altri valori e gli schemi li seguono;
 *  · `VALIDITA_FIRMA_SECONDI`: si confrontano i due numeri;
 *  · il contratto della PR 2 (`contratto.ts`, `firme.ts`, `token-rinnovo.ts`): le forme vere, prodotte dal codice vero,
 *    attraversano gli schemi nuovi, e un video «scelto» passa anche l'apertura dell'intento.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * ATTREZZI
 * ──────────────────────────────────────────────────────────────────────────── */

type Oggetto = Record<string, unknown>

/** Ciò che passa dal ponte è JSON: i valori di prova ci passano davvero, così un `undefined` non si nasconde. */
const viaPonte = <T>(valore: T): T => JSON.parse(JSON.stringify(valore)) as T

function modifica(origine: Oggetto, percorso: string, valore: unknown, elimina: boolean): Oggetto {
  const copia = structuredClone(origine)
  const pezzi = percorso.split('.')
  let cursore: Oggetto = copia
  for (const pezzo of pezzi.slice(0, -1)) cursore = cursore[pezzo] as Oggetto
  const ultimo = pezzi[pezzi.length - 1]
  if (elimina) delete cursore[ultimo]
  else cursore[ultimo] = valore
  return copia
}
const senza = (origine: Oggetto, percorso: string): Oggetto => modifica(origine, percorso, undefined, true)
const con = (origine: Oggetto, percorso: string, valore: unknown): Oggetto => modifica(origine, percorso, valore, false)

/** I percorsi di tutti i campi «foglia» di un oggetto, quelli annidati compresi (`caricamento.url`). */
function foglie(origine: Oggetto, prefisso = ''): string[] {
  return Object.entries(origine).flatMap(([chiave, valore]) =>
    valore !== null && typeof valore === 'object' && !Array.isArray(valore)
      ? foglie(valore as Oggetto, `${prefisso}${chiave}.`)
      : [`${prefisso}${chiave}`],
  )
}

function accetta(schema: z.ZodType, valore: unknown, etichetta: string) {
  const esito = schema.safeParse(valore)
  expect(esito.success, `${etichetta}: doveva passare — ${esito.success ? '' : JSON.stringify(esito.error.issues)}`).toBe(true)
  return esito.success ? esito.data : undefined
}

/** Il valore deve essere rifiutato, e il rifiuto deve nominare `percorso` (se dato): non basta che sia rosso. */
function rifiuta(schema: z.ZodType, valore: unknown, etichetta: string, percorso?: string) {
  const esito = schema.safeParse(valore)
  expect(esito.success, `${etichetta}: doveva essere rifiutato`).toBe(false)
  if (!esito.success && percorso !== undefined) {
    expect(
      esito.error.issues.map((problema) => problema.path.join('.')),
      `${etichetta}: il rifiuto deve nominare «${percorso}»`,
    ).toContain(percorso)
  }
}

/** Ogni campo, tolto da solo, fa rifiutare l'oggetto — e il rifiuto nomina proprio quel campo. */
function ognunoDeiCampiServe(schema: z.ZodType, valido: Oggetto) {
  accetta(schema, viaPonte(valido), 'l’oggetto di partenza')
  for (const percorso of foglie(valido)) rifiuta(schema, senza(valido, percorso), `senza ${percorso}`, percorso)
}

/* ────────────────────────────────────────────────────────────────────────────
 * I VALORI DI PARTENZA (tutti finti: nessun nome, nessun file, nessun segreto)
 * ──────────────────────────────────────────────────────────────────────────── */

const JOB = '11111111-1111-4111-8111-111111111111'
const INTENTO = '22222222-2222-4222-8222-222222222222'
const UTENTE = '33333333-3333-4333-8333-333333333333'
const SEDE = '44444444-4444-4444-8444-444444444444'
const ID_ELEMENTO = 'a1b2c3d4-e5f6-4789-8abc-def012345678'
/** Un uuid con lettere: il maiuscolo di uno fatto di sole cifre sarebbe identico, e non proverebbe niente. */
const UUID_MAIUSCOLO = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345'
const SHA256 = createHash('sha256').update('contenuto di prova').digest('hex')
const MINIATURA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='
const ISTANTE = '2026-10-03T12:00:00.000Z'
const TOKEN = `kvr_${'A'.repeat(43)}`
const URL_PUT = 'https://esempio.invalid/storage/v1/object/upload/sign/video_originals/prova.mov?token=gettone-di-prova'

const foto = (): Oggetto => ({
  id: ID_ELEMENTO,
  tipo: 'foto',
  nome: 'Foto di prova',
  larghezza: 1920,
  altezza: 1080,
  byte: 412_345,
})
const video = (): Oggetto => ({
  id: ID_ELEMENTO,
  tipo: 'video',
  nome: 'Video di prova.mov',
  byte: 52_428_800,
  mime: 'video/quicktime',
  durataSecondi: 12.5,
  miniatura: MINIATURA,
  sha256: SHA256,
})
const rifiutato = (): Oggetto => ({
  id: ID_ELEMENTO,
  tipo: 'rifiutato',
  nome: 'Video troppo lungo.mov',
  origine: 'video',
  motivo: 'troppo-lungo',
})
const caricamento = (): Oggetto => ({
  jobId: JOB,
  intentId: INTENTO,
  utenteId: UTENTE,
  scuolaId: SEDE,
  nome: 'Video di prova.mov',
  mime: 'video/quicktime',
  stato: 'in-invio',
  byteInviati: 1_048_576,
  byteTotali: 52_428_800,
  tentativi: 1,
  rinnovi: 0,
  codice: null,
  creatoIl: ISTANTE,
  aggiornatoIl: ISTANTE,
})
const richiestaAccoda = (): Oggetto => ({
  idElemento: ID_ELEMENTO,
  sha256: SHA256,
  byteAttesi: 52_428_800,
  jobId: JOB,
  intentId: INTENTO,
  utenteId: UTENTE,
  scuolaId: SEDE,
  caricamento: { url: URL_PUT, contentType: 'video/quicktime', scadeIl: ISTANTE },
  rinnovo: { url: 'https://app.esempio.invalid/api/video-uploads/rinnovo', token: TOKEN, scadeIl: ISTANTE },
  registro: { url: 'https://app.esempio.invalid/api/logs' },
  testi: {
    titolo: 'Kidville',
    invio: 'Invio dei video in corso',
    attesaRete: 'Il video è in attesa di rete: riprenderà da solo',
    pausa: 'Invio in pausa: tocca per riprendere',
  },
})
/** Byte che in base64 danno anche `+` e `/`: senza, la variante base64url non si distinguerebbe dall'originale. */
const contenutoFoto = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => [0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff][i % 6]))
/** Un base64 vero, di `n` byte, e quel che ne dice un nativo che lavora bene. */
const fotoLetta = (n = 100): Oggetto => ({
  base64: contenutoFoto(n).toString('base64'),
  mime: 'image/jpeg',
  byte: n,
  larghezza: 1600,
  altezza: 1200,
})

/* ────────────────────────────────────────────────────────────────────────────
 * 1 · COSTANTI E VOCABOLARI CHIUSI
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · costanti e vocabolari chiusi (§4.2)', () => {
  it('il nome del plugin e il protocollo sono quelli scritti nei tre linguaggi', () => {
    expect(NOME_PLUGIN_CARICAMENTI).toBe('KidvilleCaricamenti')
    expect(PROTOCOLLO_CARICAMENTI).toBe(1)
  })

  it('i metodi sono NOVE, nell’ordine della spec, senza doppioni e senza `creaElementoDiProva` né `addListener`', () => {
    expect([...METODI_PLUGIN_CARICAMENTI]).toEqual([
      'info',
      'scegliMedia',
      'annullaScelta',
      'leggiFoto',
      'scartaScelti',
      'accodaVideo',
      'elenco',
      'annulla',
      'dimentica',
    ])
    expect(new Set(METODI_PLUGIN_CARICAMENTI).size).toBe(METODI_PLUGIN_CARICAMENTI.length)
    // Solo Debug (`#if DEBUG`, `BuildConfig.DEBUG`): il lock confronta i sorgenti di Release.
    expect(METODI_PLUGIN_CARICAMENTI as readonly string[]).not.toContain('creaElementoDiProva')
    // Lo porta la classe base di Capacitor: non è un metodo nostro.
    expect(METODI_PLUGIN_CARICAMENTI as readonly string[]).not.toContain('addListener')
  })

  it('gli stati, i codici, i motivi di rifiuto e gli eventi sono gli elenchi chiusi della spec', () => {
    expect([...STATI_NATIVI]).toEqual(['in-coda', 'in-invio', 'in-attesa', 'in-pausa', 'inviato', 'fallito', 'annullato'])
    expect([...CODICI_NATIVI]).toEqual([
      'RETE',
      'SERVER',
      'FIRMA_RIFIUTATA',
      'TOKEN_NON_VALIDO',
      'TOKEN_SCADUTO',
      'RINNOVO_CICLICO',
      'TROPPO_GRANDE',
      'FILE_ASSENTE',
      'PESO_DIVERSO',
      'ANNULLATO_DAL_SERVER',
      'CHIUSURA_FORZATA',
      'FGS_NON_AVVIABILE',
      'UIDT_NON_PROGRAMMABILE',
      'INTERNO',
    ])
    expect([...MOTIVI_RIFIUTO]).toEqual([
      'troppo-grande',
      'troppo-lungo',
      'formato-non-supportato',
      'illeggibile',
      'spazio-insufficiente',
      'icloud-non-disponibile',
    ])
    expect([...EVENTI_PLUGIN_CARICAMENTI]).toEqual(['preparazione', 'caricamento'])
    expect([...PIATTAFORME_CARICAMENTI]).toEqual(['ios', 'android'])
    expect([...MOTORI_CARICAMENTI]).toEqual(['urlsession', 'uidt', 'workmanager'])
    expect([...SORGENTI_SCELTA]).toEqual(['galleria', 'file'])
    for (const elenco of [STATI_NATIVI, CODICI_NATIVI, MOTIVI_RIFIUTO, CODICI_RIFIUTO_PONTE, EVENTI_LOG_NATIVI]) {
      expect(new Set(elenco).size, `doppioni in ${elenco.join(', ')}`).toBe(elenco.length)
    }
  })

  it('i `code` con cui il ponte rifiuta sono quelli della colonna «Rifiuti» di §4.3', () => {
    expect([...CODICI_RIFIUTO_PONTE].sort()).toEqual(
      [
        'GIA_IN_CORSO',
        'SELETTORE_NON_DISPONIBILE',
        'PARAMETRI_NON_VALIDI',
        'INTERNO',
        'ELEMENTO_ASSENTE',
        'ELEMENTO_DIVERSO',
        'HOST_NON_AMMESSO',
      ].sort(),
    )
  })

  it('i messaggi di log nativi sono i QUATTORDICI di §8.2, in forma di slug, e nessuno è un evento del JS (§8.3)', () => {
    expect([...EVENTI_LOG_NATIVI]).toEqual([
      'video-nativo-accodato',
      'video-nativo-inviato',
      'video-nativo-ritento',
      'video-nativo-rinnovo',
      'video-nativo-attesa-rete',
      'video-nativo-pausa',
      'video-nativo-ripreso-dopo-chiusura',
      'video-nativo-annullato',
      'video-nativo-fallito',
      'media-nativo-preparazione-fallita',
      'caricamenti-nativi-motore',
      'coda-nativa-corrotta',
      'registro-nativo-scartati',
      'notifica-locale-non-autorizzata',
    ])
    for (const slug of EVENTI_LOG_NATIVI) expect(slug, slug).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    // Quelli del JS (§8.3) li scrive l'involucro, non il nativo: se entrassero qui il lock li lascerebbe passare dal Swift.
    for (const delJs of [
      'caricamenti-nativi-disponibili',
      'caricamenti-nativi-incompleti',
      'caricamenti-nativi-spenti',
      'selettore-nativo-errore',
      'selettore-nativo-rifiutati',
      'foto-nativa-non-letta',
      'video-nativo-accodamento-fallito',
      'video-nativo-elenco-non-letto',
    ]) {
      expect(EVENTI_LOG_NATIVI as readonly string[], delJs).not.toContain(delJs)
    }
  })

  it('i numeri di §4.2 e gli host della forma Debug (§9)', () => {
    expect(MARGINE_RINNOVO_URL_SECONDI).toBe(900)
    expect(LATO_MASSIMO_FOTO).toBe(1920)
    expect(QUALITA_FOTO).toBe(0.85)
    expect(LATO_MINIATURA_VIDEO).toBe(320)
    expect([...HOST_DEBUG_CARICAMENTI]).toEqual(['localhost', '127.0.0.1', '10.0.2.2'])
  })

  it('la validità dell’URL di PUT è quella che il server dichiara per le sue firme: due ore', () => {
    expect(VALIDITA_URL_PUT_SECONDI).toBe(VALIDITA_FIRMA_SECONDI)
    expect(VALIDITA_URL_PUT_SECONDI).toBe(2 * 60 * 60)
  })

  it('ogni motore sta su una piattaforma sola, e ogni piattaforma ne ha almeno uno', () => {
    for (const motore of MOTORI_CARICAMENTI) {
      const piattaforme = PIATTAFORME_CARICAMENTI.filter((p) => (MOTORI_PER_PIATTAFORMA[p] as readonly string[]).includes(motore))
      expect(piattaforme, motore).toHaveLength(1)
    }
    for (const piattaforma of PIATTAFORME_CARICAMENTI) expect(MOTORI_PER_PIATTAFORMA[piattaforma].length).toBeGreaterThan(0)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2 · STATI E TRANSIZIONI (§4.4)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · stati e transizioni (§4.4)', () => {
  /** Una riga per freccia della tabella di §4.4, scritta qui per esteso e non ricavata dal modulo. */
  const PASSI: ReadonlyArray<readonly [StatoNativo, StatoNativo]> = [
    ['in-coda', 'in-invio'], // trasferimento avviato
    ['in-invio', 'in-attesa'], // rete assente, task in attesa, backoff
    ['in-invio', 'in-pausa'], // FGS non avviabile (Android 12-13), UIDT non programmabile (Android ≥ 14)
    ['in-attesa', 'in-invio'], // rete tornata
    ['in-pausa', 'in-invio'], // app riaperta
    ['in-invio', 'inviato'], // PUT 2xx, o rinnovo `arrivato`
    ['in-coda', 'annullato'], // qualunque non terminale → annullato
    ['in-invio', 'annullato'],
    ['in-attesa', 'annullato'],
    ['in-pausa', 'annullato'],
    ['in-coda', 'fallito'], // qualunque non terminale → fallito
    ['in-invio', 'fallito'],
    ['in-attesa', 'fallito'],
    ['in-pausa', 'fallito'],
  ]

  it('di 49 coppie ammette ESATTAMENTE le 14 frecce della tabella: nessuna in più, nessuna in meno', () => {
    for (const da of STATI_NATIVI) {
      for (const a of STATI_NATIVI) {
        const attesa = PASSI.some(([d, x]) => d === da && x === a)
        expect(transizioneNativaAmmessa(da, a), `${da} → ${a}`).toBe(attesa)
      }
    }
    expect(Object.keys(TRANSIZIONI_STATO_NATIVO).sort()).toEqual([...STATI_NATIVI].sort())
    expect(Object.values(TRANSIZIONI_STATO_NATIVO).flat()).toHaveLength(PASSI.length)
  })

  it('i terminali sono tre, non hanno uscite, e da ogni altro stato si può annullare o fallire', () => {
    expect([...STATI_TERMINALI_NATIVI].sort()).toEqual(['annullato', 'fallito', 'inviato'])
    for (const stato of STATI_NATIVI) {
      const terminale = (STATI_TERMINALI_NATIVI as readonly string[]).includes(stato)
      expect(eStatoTerminaleNativo(stato), stato).toBe(terminale)
      if (terminale) {
        expect(TRANSIZIONI_STATO_NATIVO[stato], `da ${stato} non si esce`).toEqual([])
      } else {
        expect(transizioneNativaAmmessa(stato, 'annullato'), `${stato} → annullato`).toBe(true)
        expect(transizioneNativaAmmessa(stato, 'fallito'), `${stato} → fallito`).toBe(true)
      }
    }
  })

  it('una voce nasce `in-coda` e a `in-coda` non si torna; l’invio riuscito nasce solo da `in-invio`', () => {
    expect(STATO_INIZIALE_NATIVO).toBe('in-coda')
    for (const da of STATI_NATIVI) expect(transizioneNativaAmmessa(da, 'in-coda'), `${da} → in-coda`).toBe(false)
    const versoInviato = STATI_NATIVI.filter((da) => transizioneNativaAmmessa(da, 'inviato'))
    expect(versoInviato).toEqual(['in-invio'])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 3 · LE RISPOSTE DEL PONTE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · info()', () => {
  const valida = (): Oggetto => ({ protocollo: 1, piattaforma: 'ios', motore: 'urlsession' })

  it('passano le tre coppie che esistono; ogni campo serve', () => {
    for (const coppia of [
      { piattaforma: 'ios', motore: 'urlsession' },
      { piattaforma: 'android', motore: 'uidt' },
      { piattaforma: 'android', motore: 'workmanager' },
    ]) {
      accetta(schemaInfoCaricamenti, viaPonte({ protocollo: 1, ...coppia }), JSON.stringify(coppia))
    }
    ognunoDeiCampiServe(schemaInfoCaricamenti, valida())
  })

  it('rifiuta una piattaforma o un motore fuori elenco, e una coppia che non esiste', () => {
    rifiuta(schemaInfoCaricamenti, { ...valida(), piattaforma: 'web' }, 'piattaforma web', 'piattaforma')
    rifiuta(schemaInfoCaricamenti, { ...valida(), motore: 'jobscheduler' }, 'motore sconosciuto', 'motore')
    rifiuta(schemaInfoCaricamenti, { ...valida(), piattaforma: 'ios', motore: 'uidt' }, 'iOS con UIDT', 'motore')
    rifiuta(schemaInfoCaricamenti, { ...valida(), piattaforma: 'ios', motore: 'workmanager' }, 'iOS con WorkManager', 'motore')
    rifiuta(schemaInfoCaricamenti, { ...valida(), piattaforma: 'android', motore: 'urlsession' }, 'Android con URLSession', 'motore')
  })

  it('il protocollo è un intero positivo qualunque: dire se è QUELLO tocca all’involucro', () => {
    accetta(schemaInfoCaricamenti, { ...valida(), protocollo: 2 }, 'protocollo 2 (letto, non accettato dall’involucro)')
    for (const sbagliato of [0, -1, 1.5, '1', null]) {
      rifiuta(schemaInfoCaricamenti, { ...valida(), protocollo: sbagliato }, `protocollo ${JSON.stringify(sbagliato)}`, 'protocollo')
    }
  })
})

describe('caricamenti nativi · gli elementi scelti', () => {
  it('foto, video e rifiutato: ognuno, tolto un campo alla volta, viene rifiutato', () => {
    ognunoDeiCampiServe(schemaElementoScelto, foto())
    ognunoDeiCampiServe(schemaElementoScelto, video())
    ognunoDeiCampiServe(schemaElementoScelto, rifiutato())
  })

  it('`durataSecondi` e `miniatura` possono essere `null` ma non mancare', () => {
    accetta(schemaElementoScelto, { ...video(), durataSecondi: null, miniatura: null }, 'durata e miniatura nulle')
    rifiuta(schemaElementoScelto, senza({ ...video(), durataSecondi: null }, 'durataSecondi'), 'durata assente', 'durataSecondi')
    rifiuta(schemaElementoScelto, senza({ ...video(), miniatura: null }, 'miniatura'), 'miniatura assente', 'miniatura')
  })

  it('il discriminante è obbligatorio e chiuso', () => {
    rifiuta(schemaElementoScelto, senza(video(), 'tipo'), 'senza tipo', 'tipo')
    rifiuta(schemaElementoScelto, { ...video(), tipo: 'audio' }, 'tipo audio', 'tipo')
    rifiuta(schemaElementoScelto, { ...video(), tipo: 'Video' }, 'tipo con la maiuscola', 'tipo')
  })

  it('i campi in più non attraversano il ponte: un percorso scritto per sbaglio dal nativo viene scartato', () => {
    const letto = accetta(schemaElementoScelto, { ...video(), percorso: '/privato/scelti/x.mov', url: 'file:///x' }, 'video con campi in più') as Oggetto
    expect(Object.keys(letto).sort()).toEqual(Object.keys(video()).sort())
  })

  it('un rifiutato porta uno dei sei motivi e una delle tre origini: ogni altro valore è fuori elenco', () => {
    for (const motivo of MOTIVI_RIFIUTO) accetta(schemaElementoScelto, { ...rifiutato(), motivo }, `motivo ${motivo}`)
    for (const origine of ['foto', 'video', 'altro']) accetta(schemaElementoScelto, { ...rifiutato(), origine }, `origine ${origine}`)
    for (const motivo of ['troppo-pesante', 'TROPPO_GRANDE', '', null]) {
      rifiuta(schemaElementoScelto, { ...rifiutato(), motivo }, `motivo ${JSON.stringify(motivo)}`, 'motivo')
    }
    for (const origine of ['audio', 'Video', '', null]) {
      rifiuta(schemaElementoScelto, { ...rifiutato(), origine }, `origine ${JSON.stringify(origine)}`, 'origine')
    }
  })

  describe('sha256', () => {
    it('è esadecimale MINUSCOLO di 64 caratteri, e nient’altro', () => {
      // L'impronta di prova ha delle lettere: il suo maiuscolo è davvero un'altra stringa.
      expect(SHA256).not.toBe(SHA256.toUpperCase())
      accetta(schemaElementoScelto, { ...video(), sha256: '0'.repeat(64) }, 'sessantaquattro zeri')
      accetta(schemaElementoScelto, { ...video(), sha256: 'abcdef0123456789'.repeat(4) }, 'tutte le cifre esadecimali')
      for (const [etichetta, sbagliato] of [
        ['63 caratteri', SHA256.slice(1)],
        ['65 caratteri', `${SHA256}0`],
        ['una cifra che non è esadecimale', `g${SHA256.slice(1)}`],
        ['maiuscolo (il nativo scrive minuscolo: la spec lo dice, e il confronto con l’elemento è fra stringhe)', SHA256.toUpperCase()],
        ['con il prefisso 0x', `0x${SHA256.slice(2)}`],
        ['con un a capo in coda', `${SHA256}\n`],
        ['con uno spazio in testa', ` ${SHA256.slice(1)}`],
        ['base64 al posto dell’esadecimale', Buffer.from(SHA256, 'hex').toString('base64')],
        ['vuoto', ''],
        ['un numero', 12345],
        ['nullo', null],
      ] as const) {
        rifiuta(schemaElementoScelto, { ...video(), sha256: sbagliato }, etichetta, 'sha256')
      }
    })

    it('un’impronta vera, calcolata da node, passa: la forma è quella di `hex` di CryptoKit e di `MessageDigest`', () => {
      for (const contenuto of ['', 'a', 'un video qualunque', 'x'.repeat(10_000)]) {
        const impronta = createHash('sha256').update(contenuto).digest('hex')
        accetta(schemaElementoScelto, { ...video(), sha256: impronta }, `sha256 di «${contenuto.slice(0, 12)}»`)
      }
    })
  })

  describe('i limiti del video', () => {
    it('il peso va da 1 byte al tetto di `limiti.ts`, intero', () => {
      accetta(schemaElementoScelto, { ...video(), byte: 1 }, 'un byte')
      accetta(schemaElementoScelto, { ...video(), byte: MAX_VIDEO_INPUT_BYTES }, 'il tetto')
      for (const sbagliato of [0, -1, 1.5, MAX_VIDEO_INPUT_BYTES + 1, '100', null]) {
        rifiuta(schemaElementoScelto, { ...video(), byte: sbagliato }, `byte ${JSON.stringify(sbagliato)}`, 'byte')
      }
    })

    it('la regola è quella di `validateVideoInputSize`, la stessa del server e del web', () => {
      for (const peso of [-1, 0, 1, 1.5, 1_000, MAX_VIDEO_INPUT_BYTES - 1, MAX_VIDEO_INPUT_BYTES, MAX_VIDEO_INPUT_BYTES + 1, Number.MAX_SAFE_INTEGER + 2]) {
        const server = validateVideoInputSize(peso).ok
        const ponte = schemaElementoScelto.safeParse({ ...video(), byte: peso }).success
        expect(ponte, `peso ${peso}`).toBe(server)
      }
    })

    it('la durata è positiva e arriva al tetto di `limiti.ts`', () => {
      accetta(schemaElementoScelto, { ...video(), durataSecondi: 0.1 }, 'un decimo di secondo')
      accetta(schemaElementoScelto, { ...video(), durataSecondi: MAX_VIDEO_DURATION_SECONDS }, 'il tetto')
      for (const sbagliato of [0, -3, MAX_VIDEO_DURATION_SECONDS + 0.01, MAX_VIDEO_DURATION_SECONDS + 1, '12', undefined]) {
        rifiuta(schemaElementoScelto, { ...video(), durataSecondi: sbagliato }, `durata ${String(sbagliato)}`, 'durataSecondi')
      }
    })

    it('il MIME ha la forma permissiva del server, anche col suffisso dei codec; non un testo qualunque', () => {
      for (const mime of ['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2']) {
        accetta(schemaElementoScelto, { ...video(), mime }, mime)
      }
      for (const sbagliato of ['', 'video', 'video/', '/mp4', 'video mp4', 'video/mp4\n', 5]) {
        rifiuta(schemaElementoScelto, { ...video(), mime: sbagliato }, `MIME ${JSON.stringify(sbagliato)}`, 'mime')
      }
    })
  })

  describe('miniatura, nome e identificativo', () => {
    it('la miniatura è un data URL JPEG in base64', () => {
      for (const sbagliata of [
        'data:image/png;base64,AAAA',
        'data:image/jpeg;base64,',
        'data:image/jpeg;base64,@@@@',
        'data:image/jpeg,AAAA',
        'https://esempio.invalid/miniatura.jpg',
        'AAAA',
        '',
      ]) {
        rifiuta(schemaElementoScelto, { ...video(), miniatura: sbagliata }, `miniatura «${sbagliata}»`, 'miniatura')
      }
    })

    it('il nome ha da 1 a 255 caratteri (come `nome` del file dichiarato al server)', () => {
      accetta(schemaElementoScelto, { ...video(), nome: 'x' }, 'un carattere')
      accetta(schemaElementoScelto, { ...video(), nome: 'x'.repeat(255) }, '255 caratteri')
      rifiuta(schemaElementoScelto, { ...video(), nome: '' }, 'nome vuoto', 'nome')
      rifiuta(schemaElementoScelto, { ...video(), nome: 'x'.repeat(256) }, '256 caratteri', 'nome')
      rifiuta(schemaElementoScelto, { ...foto(), nome: '' }, 'nome vuoto di una foto', 'nome')
      rifiuta(schemaElementoScelto, { ...rifiutato(), nome: '' }, 'nome vuoto di un rifiutato', 'nome')
    })

    it('l’identificativo dà il nome a un file: niente separatori, niente `..`, niente spazi, al più 64 caratteri', () => {
      for (const id of [ID_ELEMENTO, 'elemento_1-A', 'x', 'A'.repeat(64)]) accetta(schemaElementoScelto, { ...video(), id }, id)
      for (const sbagliato of ['', '../segreto', 'a/b', 'a\\b', 'a b', 'a.mov', '.nascosto', '-inizio', 'A'.repeat(65), 'è', 7, null]) {
        rifiuta(schemaElementoScelto, { ...video(), id: sbagliato }, `id ${JSON.stringify(sbagliato)}`, 'id')
      }
    })
  })

  describe('le foto', () => {
    it('hanno i lati fra 1 e `LATO_MASSIMO_FOTO` (sono già ridotte) e un peso nel tetto della porta delle foto', () => {
      accetta(schemaElementoScelto, { ...foto(), larghezza: LATO_MASSIMO_FOTO, altezza: LATO_MASSIMO_FOTO }, 'lati al massimo')
      accetta(schemaElementoScelto, { ...foto(), larghezza: 1, altezza: 1 }, 'un pixel')
      for (const campo of ['larghezza', 'altezza']) {
        for (const sbagliato of [0, -5, LATO_MASSIMO_FOTO + 1, 1.5, '1000', null]) {
          rifiuta(schemaElementoScelto, { ...foto(), [campo]: sbagliato }, `${campo} ${JSON.stringify(sbagliato)}`, campo)
        }
      }
      accetta(schemaElementoScelto, { ...foto(), byte: TETTO_GALLERIA_BYTE }, 'peso al tetto')
      for (const sbagliato of [0, -1, 1.5, TETTO_GALLERIA_BYTE + 1]) {
        rifiuta(schemaElementoScelto, { ...foto(), byte: sbagliato }, `peso ${sbagliato}`, 'byte')
      }
    })
  })
})

describe('caricamenti nativi · scegliMedia(), annullaScelta(), scartaScelti()', () => {
  const esito = (): Oggetto => ({ annullato: false, elementi: [foto(), video(), rifiutato()] })

  it('una scelta porta gli elementi (di qualunque tipo, in qualunque numero) o viene annullata, e ogni campo serve', () => {
    ognunoDeiCampiServe(schemaEsitoScelta, { annullato: false, elementi: [] })
    accetta(schemaEsitoScelta, viaPonte(esito()), 'tre elementi')
    accetta(schemaEsitoScelta, { annullato: false, elementi: [] }, 'chiusa senza scegliere')
    accetta(schemaEsitoScelta, { annullato: true, elementi: [] }, 'annullata')
    rifiuta(schemaEsitoScelta, { elementi: [] }, 'senza annullato', 'annullato')
    rifiuta(schemaEsitoScelta, { annullato: false }, 'senza elementi', 'elementi')
    rifiuta(schemaEsitoScelta, { annullato: 'no', elementi: [] }, 'annullato testuale', 'annullato')
    rifiuta(schemaEsitoScelta, { annullato: false, elementi: 'nessuno' }, 'elementi non è un elenco', 'elementi')
  })

  it('una scelta ANNULLATA non porta elementi: una copia consegnata insieme a `annullato` non la scarterebbe nessuno', () => {
    rifiuta(schemaEsitoScelta, { annullato: true, elementi: [video()] }, 'annullata con un video', 'elementi')
    rifiuta(schemaEsitoScelta, { annullato: true, elementi: [rifiutato()] }, 'annullata con un rifiutato', 'elementi')
  })

  it('basta UN elemento fuori forma perché la risposta intera sia rifiutata, e il rifiuto dice quale', () => {
    rifiuta(
      schemaEsitoScelta,
      { annullato: false, elementi: [foto(), { ...video(), sha256: 'non-un-hash' }] },
      'secondo elemento con l’hash sbagliato',
      'elementi.1.sha256',
    )
  })

  it('`annullaScelta` e `scartaScelti` rispondono con un booleano e con un contatore', () => {
    ognunoDeiCampiServe(schemaEsitoAnnullaScelta, { annullata: true })
    ognunoDeiCampiServe(schemaEsitoScartaScelti, { eliminati: 3 })
    accetta(schemaEsitoScartaScelti, { eliminati: 0 }, 'nessuno eliminato')
    rifiuta(schemaEsitoAnnullaScelta, { annullata: 'si' }, 'annullata testuale', 'annullata')
    rifiuta(schemaEsitoAnnullaScelta, { annullato: true }, 'il nome di un altro metodo', 'annullata')
    for (const sbagliato of [-1, 1.5, '3', null]) {
      rifiuta(schemaEsitoScartaScelti, { eliminati: sbagliato }, `eliminati ${JSON.stringify(sbagliato)}`, 'eliminati')
    }
  })
})

describe('caricamenti nativi · leggiFoto()', () => {
  it('ogni campo serve, e una foto vera passa', () => {
    ognunoDeiCampiServe(schemaFotoLetta, fotoLetta())
    for (const n of [1, 2, 3, 4, 99, 100, 101, 102, 4096]) accetta(schemaFotoLetta, fotoLetta(n), `${n} byte`)
  })

  it('il JPEG è l’unico tipo; i lati restano entro `LATO_MASSIMO_FOTO`; il peso entro il tetto delle foto', () => {
    rifiuta(schemaFotoLetta, { ...fotoLetta(), mime: 'image/png' }, 'PNG', 'mime')
    rifiuta(schemaFotoLetta, { ...fotoLetta(), mime: 'image/heic' }, 'HEIC', 'mime')
    rifiuta(schemaFotoLetta, { ...fotoLetta(), larghezza: LATO_MASSIMO_FOTO + 1 }, 'non ridotta', 'larghezza')
    rifiuta(schemaFotoLetta, { ...fotoLetta(), altezza: 0 }, 'altezza zero', 'altezza')
    rifiuta(schemaFotoLetta, { ...fotoLetta(), byte: TETTO_GALLERIA_BYTE + 1 }, 'oltre il tetto', 'byte')
  })

  it('i byte dichiarati sono ESATTAMENTE quelli del base64: una stringa troncata o un peso sbagliato sono una foto corrotta', () => {
    const base64 = String(fotoLetta().base64)
    rifiuta(schemaFotoLetta, { ...fotoLetta(), base64: base64.slice(0, -4) }, 'base64 troncato di un gruppo', 'byte')
    // Troncato nel mezzo di un gruppo: la lunghezza non è un multiplo di quattro e non rappresenta nessun peso intero.
    for (const tolti of [1, 2, 3]) {
      rifiuta(schemaFotoLetta, { ...fotoLetta(), base64: base64.slice(0, -tolti) }, `base64 troncato di ${tolti} caratteri`)
      rifiuta(schemaFotoLetta, { ...fotoLetta(99), base64: String(fotoLetta(99).base64).slice(0, -tolti) }, `base64 senza padding, troncato di ${tolti}`)
    }
    rifiuta(schemaFotoLetta, { ...fotoLetta(), byte: 99 }, 'peso di uno in meno', 'byte')
    rifiuta(schemaFotoLetta, { ...fotoLetta(), byte: 101 }, 'peso di uno in più', 'byte')
    rifiuta(schemaFotoLetta, { ...fotoLetta(), byte: 1_000 }, 'peso di dieci volte', 'byte')
    // Il padding conta: 100 byte sono 136 caratteri con `=`, e 102 sono 136 senza padding. Non si confondono.
    expect(String(fotoLetta(102).base64).endsWith('=')).toBe(false)
    rifiuta(schemaFotoLetta, { ...fotoLetta(102), byte: 100 }, '102 byte dichiarati 100', 'byte')
  })

  it('il base64 è quello standard senza spazi né a capo (Android: NO_WRAP), non una variante', () => {
    const base64 = String(fotoLetta(300).base64)
    for (const [etichetta, sbagliato] of [
      ['con un a capo (Base64.DEFAULT di Android)', `${base64.slice(0, 76)}\n${base64.slice(76)}`],
      ['con uno spazio', `${base64.slice(0, 40)} ${base64.slice(40)}`],
      ['base64url', base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')],
      ['con un carattere che non è base64', `${base64.slice(0, -2)}!!`],
      ['vuoto', ''],
      ['un data URL', `data:image/jpeg;base64,${base64}`],
    ] as const) {
      rifiuta(schemaFotoLetta, { ...fotoLetta(300), base64: sbagliato }, etichetta, 'base64')
    }
  })
})

describe('caricamenti nativi · una voce della coda (CaricamentoNativo)', () => {
  it('ogni campo serve', () => {
    ognunoDeiCampiServe(schemaCaricamentoNativo, caricamento())
  })

  it('i sette stati passano, ogni altro valore è fuori elenco', () => {
    for (const stato of STATI_NATIVI) accetta(schemaCaricamentoNativo, { ...caricamento(), stato }, stato)
    for (const sbagliato of ['pausa', 'IN-INVIO', 'in_invio', 'completato', '', null, 4]) {
      rifiuta(schemaCaricamentoNativo, { ...caricamento(), stato: sbagliato }, `stato ${JSON.stringify(sbagliato)}`, 'stato')
    }
  })

  it('i quattordici codici passano, anche `null`; ogni altro valore è fuori elenco', () => {
    accetta(schemaCaricamentoNativo, { ...caricamento(), codice: null }, 'nessun codice')
    for (const codice of CODICI_NATIVI) accetta(schemaCaricamentoNativo, { ...caricamento(), codice }, codice)
    for (const sbagliato of ['rete', 'ERRORE', 'GIA_IN_CORSO', 'HOST_NON_AMMESSO', '', 0]) {
      rifiuta(schemaCaricamentoNativo, { ...caricamento(), codice: sbagliato }, `codice ${JSON.stringify(sbagliato)}`, 'codice')
    }
    // `codice` può essere nullo ma non mancare: un nativo che lo dimentica non si distingue da uno che non ha niente da dire.
    rifiuta(schemaCaricamentoNativo, senza(caricamento(), 'codice'), 'codice assente', 'codice')
  })

  it('gli identificativi sono uuid in minuscolo: un’altra forma è una voce che non si ritrova', () => {
    for (const campo of ['jobId', 'intentId', 'utenteId', 'scuolaId']) {
      accetta(schemaCaricamentoNativo, { ...caricamento(), [campo]: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, `${campo}: id di sviluppo, senza versione`)
      for (const sbagliato of [UUID_MAIUSCOLO, JOB.slice(1), `${JOB}0`, 'non-un-uuid', '', null, 7]) {
        rifiuta(schemaCaricamentoNativo, { ...caricamento(), [campo]: sbagliato }, `${campo} ${JSON.stringify(sbagliato)}`, campo)
      }
    }
  })

  it('i contatori sono interi non negativi, e i byte non superano il tetto di `limiti.ts`', () => {
    for (const campo of ['byteInviati', 'tentativi', 'rinnovi']) {
      accetta(schemaCaricamentoNativo, { ...caricamento(), [campo]: 0 }, `${campo} a zero`)
      for (const sbagliato of [-1, 1.5, '1', null]) {
        rifiuta(schemaCaricamentoNativo, { ...caricamento(), [campo]: sbagliato }, `${campo} ${JSON.stringify(sbagliato)}`, campo)
      }
    }
    accetta(schemaCaricamentoNativo, { ...caricamento(), byteInviati: MAX_VIDEO_INPUT_BYTES }, 'inviati al tetto')
    rifiuta(schemaCaricamentoNativo, { ...caricamento(), byteInviati: MAX_VIDEO_INPUT_BYTES + 1 }, 'inviati oltre il tetto', 'byteInviati')
    for (const sbagliato of [0, -1, MAX_VIDEO_INPUT_BYTES + 1, 1.5]) {
      rifiuta(schemaCaricamentoNativo, { ...caricamento(), byteTotali: sbagliato }, `totali ${sbagliato}`, 'byteTotali')
    }
  })

  it('le date sono ISO 8601 (con `Z` o con l’offset), non testo', () => {
    for (const campo of ['creatoIl', 'aggiornatoIl']) {
      for (const valida of [ISTANTE, '2026-10-03T12:00:00Z', '2026-10-03T14:00:00.123+02:00']) {
        accetta(schemaCaricamentoNativo, { ...caricamento(), [campo]: valida }, `${campo} ${valida}`)
      }
      for (const sbagliata of ['ieri', '2026-10-03', '2026-10-03 12:00:00', '03/10/2026', '', null, 1_790_000_000]) {
        rifiuta(schemaCaricamentoNativo, { ...caricamento(), [campo]: sbagliata }, `${campo} ${JSON.stringify(sbagliata)}`, campo)
      }
    }
  })

  it('il nome e il MIME hanno la forma che il server pretende dal file dichiarato', () => {
    rifiuta(schemaCaricamentoNativo, { ...caricamento(), nome: '' }, 'nome vuoto', 'nome')
    rifiuta(schemaCaricamentoNativo, { ...caricamento(), mime: 'video' }, 'MIME senza sottotipo', 'mime')
    accetta(schemaCaricamentoNativo, { ...caricamento(), mime: 'video/mp4;codecs=avc1.42E01E' }, 'MIME col suffisso dei codec')
  })

  it('l’elenco è un elenco di voci; una voce fuori forma fa rifiutare l’elenco e il rifiuto la nomina', () => {
    ognunoDeiCampiServe(schemaEsitoElenco, { caricamenti: [] })
    accetta(schemaEsitoElenco, viaPonte({ caricamenti: [caricamento(), { ...caricamento(), jobId: INTENTO, stato: 'inviato' }] }), 'due voci')
    rifiuta(schemaEsitoElenco, { caricamenti: caricamento() }, 'una voce sola al posto di un elenco', 'caricamenti')
    rifiuta(schemaEsitoElenco, { caricamenti: [caricamento(), { ...caricamento(), stato: 'sconosciuto' }] }, 'seconda voce con lo stato sbagliato', 'caricamenti.1.stato')
  })
})

describe('caricamenti nativi · le risposte brevi e l’evento di preparazione', () => {
  it('annulla e dimentica rispondono con un booleano e con un contatore', () => {
    ognunoDeiCampiServe(schemaEsitoAnnulla, { annullato: true })
    ognunoDeiCampiServe(schemaEsitoDimentica, { dimenticati: 2 })
    rifiuta(schemaEsitoAnnulla, { annullato: 1 }, 'annullato numerico', 'annullato')
    rifiuta(schemaEsitoAnnulla, { annullata: true }, 'il nome di un altro metodo', 'annullato')
    for (const sbagliato of [-1, 0.5, '2', null]) {
      rifiuta(schemaEsitoDimentica, { dimenticati: sbagliato }, `dimenticati ${JSON.stringify(sbagliato)}`, 'dimenticati')
    }
  })

  it('l’evento `preparazione` ha i quattro campi, e il totale dei byte può essere `null`', () => {
    ognunoDeiCampiServe(schemaEventoPreparazione, { fatti: 1, totali: 3, byteCopiati: 1_000, byteTotali: 3_000 })
    accetta(schemaEventoPreparazione, { fatti: 0, totali: 3, byteCopiati: 0, byteTotali: null }, 'totale dei byte ignoto')
    rifiuta(schemaEventoPreparazione, { fatti: 0, totali: 3, byteCopiati: 0 }, 'totale dei byte assente', 'byteTotali')
    for (const campo of ['fatti', 'totali', 'byteCopiati']) {
      for (const sbagliato of [-1, 1.5, '1', null]) {
        rifiuta(schemaEventoPreparazione, { fatti: 1, totali: 3, byteCopiati: 10, byteTotali: 30, [campo]: sbagliato }, `${campo} ${JSON.stringify(sbagliato)}`, campo)
      }
    }
  })
})

describe('caricamenti nativi · ciò che il nativo scrive in più non attraversa il ponte', () => {
  it('ogni risposta scarta i campi che la forma non dichiara — un percorso, un indirizzo, un hash — anche dentro gli elenchi', () => {
    const intruso = { percorso: '/privato/scelti/x.mov', url: 'file:///x', sha256Completo: SHA256 }
    const casi: ReadonlyArray<readonly [string, z.ZodType, Oggetto]> = [
      ['info', schemaInfoCaricamenti, { protocollo: 1, piattaforma: 'ios', motore: 'urlsession' }],
      ['foto letta', schemaFotoLetta, fotoLetta()],
      ['voce di coda', schemaCaricamentoNativo, caricamento()],
      ['evento di preparazione', schemaEventoPreparazione, { fatti: 1, totali: 2, byteCopiati: 3, byteTotali: null }],
      ['annullaScelta', schemaEsitoAnnullaScelta, { annullata: true }],
      ['scartaScelti', schemaEsitoScartaScelti, { eliminati: 1 }],
      ['annulla', schemaEsitoAnnulla, { annullato: true }],
      ['dimentica', schemaEsitoDimentica, { dimenticati: 1 }],
    ]
    for (const [nome, schema, valido] of casi) {
      const letto = accetta(schema, { ...valido, ...intruso }, nome) as Oggetto
      expect(Object.keys(letto).sort(), nome).toEqual(Object.keys(valido).sort())
    }
    const scelta = accetta(schemaEsitoScelta, { annullato: false, elementi: [{ ...foto(), ...intruso }, { ...rifiutato(), ...intruso }], ...intruso }, 'scelta') as EsitoScelta
    expect(Object.keys(scelta).sort()).toEqual(['annullato', 'elementi'])
    scelta.elementi.forEach((elemento, indice) => {
      expect(Object.keys(elemento).sort(), `elemento ${indice}`).toEqual(Object.keys(indice === 0 ? foto() : rifiutato()).sort())
    })
    const elenco = accetta(schemaEsitoElenco, { caricamenti: [{ ...caricamento(), ...intruso }], ...intruso }, 'elenco') as { caricamenti: Oggetto[] }
    expect(Object.keys(elenco)).toEqual(['caricamenti'])
    expect(Object.keys(elenco.caricamenti[0]).sort()).toEqual(Object.keys(caricamento()).sort())
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 4 · LE RICHIESTE VERSO IL PONTE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · accodaVideo(): ogni pezzo e ogni indirizzo', () => {
  it('una richiesta completa passa, e ogni campo — anche quelli annidati — serve', () => {
    ognunoDeiCampiServe(schemaRichiestaAccodaVideo, richiestaAccoda())
  })

  it('un blocco intero (`caricamento`, `rinnovo`, `registro`, `testi`) non può mancare né essere nullo o un testo', () => {
    for (const blocco of ['caricamento', 'rinnovo', 'registro', 'testi']) {
      rifiuta(schemaRichiestaAccodaVideo, senza(richiestaAccoda(), blocco), `senza ${blocco}`, blocco)
      for (const sbagliato of [null, 'x', [], 7]) {
        rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), blocco, sbagliato), `${blocco} = ${JSON.stringify(sbagliato)}`, blocco)
      }
    }
  })

  it('un campo nullo ma richiesto (`caricamento.scadeIl`) va scritto `null`: `undefined` si perde nel ponte e vale «manca»', () => {
    accetta(schemaRichiestaAccodaVideo, viaPonte(con(richiestaAccoda(), 'caricamento.scadeIl', null)), 'null scritto')
    rifiuta(schemaRichiestaAccodaVideo, viaPonte(con(richiestaAccoda(), 'caricamento.scadeIl', undefined)), 'undefined (sparisce nel JSON)', 'caricamento.scadeIl')
  })

  describe('sha256 e peso', () => {
    it('lo sha256 è esadecimale minuscolo di 64 caratteri, come nell’elemento che il nativo ha già misurato', () => {
      for (const sbagliato of [SHA256.slice(1), `${SHA256}0`, `z${SHA256.slice(1)}`, SHA256.toUpperCase(), '', null, 0]) {
        rifiuta(schemaRichiestaAccodaVideo, { ...richiestaAccoda(), sha256: sbagliato }, `sha256 ${JSON.stringify(sbagliato)}`, 'sha256')
      }
    })

    it('`byteAttesi` va da 1 byte al tetto di `limiti.ts`', () => {
      accetta(schemaRichiestaAccodaVideo, { ...richiestaAccoda(), byteAttesi: MAX_VIDEO_INPUT_BYTES }, 'il tetto')
      for (const sbagliato of [0, -1, 1.5, MAX_VIDEO_INPUT_BYTES + 1, '100', null]) {
        rifiuta(schemaRichiestaAccodaVideo, { ...richiestaAccoda(), byteAttesi: sbagliato }, `byteAttesi ${JSON.stringify(sbagliato)}`, 'byteAttesi')
      }
    })

    it('l’elemento e gli identificativi hanno la forma che il nativo usa per ritrovarli', () => {
      for (const sbagliato of ['', '../x', 'a/b', 'a b', 'A'.repeat(65)]) {
        rifiuta(schemaRichiestaAccodaVideo, { ...richiestaAccoda(), idElemento: sbagliato }, `idElemento ${JSON.stringify(sbagliato)}`, 'idElemento')
      }
      for (const campo of ['jobId', 'intentId', 'utenteId', 'scuolaId']) {
        for (const sbagliato of [UUID_MAIUSCOLO, 'non-un-uuid', '', null]) {
          rifiuta(schemaRichiestaAccodaVideo, { ...richiestaAccoda(), [campo]: sbagliato }, `${campo} ${JSON.stringify(sbagliato)}`, campo)
        }
      }
    })
  })

  describe('l’URL della PUT: solo https, mai la forma Debug', () => {
    const rifiutati = (url: unknown) => rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.url', url), `PUT su ${JSON.stringify(url)}`, 'caricamento.url')

    it('https passa, con o senza porta, con la query del token', () => {
      for (const url of [URL_PUT, 'https://esempio.invalid/x', 'https://esempio.invalid:8443/x?a=b&token=c']) {
        accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.url', url), url)
      }
    })

    it('http è rifiutato — anche verso localhost —, e con lui ogni altro schema e ogni forma che non sia un indirizzo assoluto', () => {
      for (const sbagliato of [
        'http://esempio.invalid/x',
        'http://localhost:54321/storage/v1/object/upload/sign/video_originals/x',
        'http://10.0.2.2:3101/x',
        'ftp://esempio.invalid/x',
        'file:///privato/x.mov',
        'javascript:alert(1)',
        'data:text/plain,ciao',
        '//esempio.invalid/x',
        '/storage/v1/x',
        'esempio.invalid/x',
        'HTTPS://esempio.invalid/x',
        'https://',
        '',
        null,
        42,
      ]) {
        rifiutati(sbagliato)
      }
    })

    it('spazi e a capo, credenziali incorporate e lunghezza fuori misura sono rifiutati', () => {
      for (const sbagliato of [
        'https://esempio.invalid/con spazio',
        'https://esempio.invalid/x\n',
        ' https://esempio.invalid/x',
        'https://utente:segreto@esempio.invalid/x',
        'https://utente@esempio.invalid/x',
        'https://@esempio.invalid/x',
        `https://esempio.invalid/${'x'.repeat(2048)}`,
      ]) {
        rifiutati(sbagliato)
      }
    })

    it('il `content-type` ha la forma delle intestazioni del server, anche col suffisso dei codec', () => {
      accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.contentType', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'), 'MIME con i codec')
      for (const sbagliato of ['', 'video', 'ab', 'video/mp4\n', null, 5]) {
        rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.contentType', sbagliato), `content-type ${JSON.stringify(sbagliato)}`, 'caricamento.contentType')
      }
    })

    it('la scadenza dell’URL è un istante o `null`, non testo', () => {
      accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.scadeIl', null), 'scadenza ignota')
      for (const sbagliata of ['domani', '2026-10-03', '', 1_790_000_000]) {
        rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.scadeIl', sbagliata), `scadenza ${JSON.stringify(sbagliata)}`, 'caricamento.scadeIl')
      }
    })
  })

  describe('gli indirizzi di rinnovo e di registro: https, e la forma Debug dichiarata', () => {
    const CAMPI = ['rinnovo.url', 'registro.url'] as const

    it('https passa, e passa il loopback in chiaro che il collaudo dell’app vera usa: localhost, 127.0.0.1, 10.0.2.2, con qualunque porta', () => {
      for (const campo of CAMPI) {
        for (const url of [
          'https://app.esempio.invalid/api/video-uploads/rinnovo',
          'https://app.esempio.invalid',
          'https://localhost:3100/api/logs',
          'http://localhost:3101/api/logs',
          'http://localhost/api/logs',
          'http://127.0.0.1:3000/api/video-uploads/rinnovo',
          'http://10.0.2.2:3101/api/logs',
          'http://10.0.2.2:80',
        ]) {
          accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), campo, url), `${campo}: ${url}`)
        }
      }
    })

    it('qualunque altro `http` è rifiutato: un host che CONTIENE o COMINCIA con un host di Debug non è quell’host', () => {
      for (const campo of CAMPI) {
        for (const sbagliato of [
          'http://app.esempio.invalid/api/logs',
          'http://localhost.esempio.invalid/api/logs',
          'http://esempio.invalid.localhost/api/logs',
          'http://localhost@esempio.invalid/api/logs',
          'http://127.0.0.1.esempio.invalid/api/logs',
          'http://10.0.2.3:3101/api/logs',
          'http://10.0.2.20:3101/api/logs',
          'http://127.0.0.2/api/logs',
          'http://0.0.0.0:3101/api/logs',
          'http://[::1]:3101/api/logs',
          'http://localhost:abc/api/logs',
          'http://localhost:3101:99/api/logs',
          'http://localhost:/api/logs',
          'http://LOCALHOST:3101/api/logs',
          'http://utente:segreto@localhost:3101/api/logs',
          'http:///api/logs',
        ]) {
          rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), campo, sbagliato), `${campo}: ${sbagliato}`, campo)
        }
      }
    })

    it('né https né http è rifiutato; e anche spazi, credenziali, relativi, vuoti', () => {
      for (const campo of CAMPI) {
        for (const sbagliato of [
          'ftp://localhost/api/logs',
          'ws://localhost:3101/api/logs',
          'wss://app.esempio.invalid/api/logs',
          'file:///x',
          'javascript:alert(1)',
          '//localhost/api/logs',
          '/api/logs',
          'api/logs',
          'https://',
          'https:///api/logs',
          'https://app.esempio.invalid/con spazio',
          'https://app.esempio.invalid/api/logs\n',
          'https://utente:segreto@app.esempio.invalid/api/logs',
          'https://@app.esempio.invalid/api/logs',
          `https://app.esempio.invalid/${'x'.repeat(2048)}`,
          '',
          null,
          1,
        ]) {
          rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), campo, sbagliato), `${campo}: ${JSON.stringify(sbagliato)}`, campo)
        }
      }
    })

    it('la forma Debug è dichiarata: i tre host sono quelli dell’elenco, né di più né di meno', () => {
      for (const host of HOST_DEBUG_CARICAMENTI) {
        accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'registro.url', `http://${host}:3101/api/logs`), host)
      }
      expect(HOST_DEBUG_CARICAMENTI).toHaveLength(3)
    })
  })

  describe('il token di rinnovo e la sua scadenza', () => {
    it('il token è `kvr_` e 43 caratteri base64url: un’altra forma è un token che nessuno ha coniato', () => {
      for (const sbagliato of [`kvx_${'A'.repeat(43)}`, `kvr_${'A'.repeat(42)}`, `kvr_${'A'.repeat(44)}`, `kvr_${'A'.repeat(42)}=`, `kvr_${'A'.repeat(42)}+`, `kvr_${'A'.repeat(42)} `, 'A'.repeat(47), '', null]) {
        rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'rinnovo.token', sbagliato), `token ${JSON.stringify(sbagliato)}`, 'rinnovo.token')
      }
    })

    it('la scadenza del token è obbligatoria e dev’essere un istante', () => {
      for (const sbagliata of ['', 'tra due giorni', '2026-10-05', null]) {
        rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'rinnovo.scadeIl', sbagliata), `scadenza ${JSON.stringify(sbagliata)}`, 'rinnovo.scadeIl')
      }
    })
  })

  describe('i testi delle notifiche', () => {
    it('sono quattro, non vuoti e non lunghi quanto una pagina', () => {
      for (const campo of ['titolo', 'invio', 'attesaRete', 'pausa']) {
        for (const sbagliato of ['', '   ', 'x'.repeat(201), null, 3]) {
          rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), `testi.${campo}`, sbagliato), `testi.${campo} ${JSON.stringify(sbagliato).slice(0, 20)}`, `testi.${campo}`)
        }
        accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), `testi.${campo}`, 'x'.repeat(200)), `testi.${campo} da 200 caratteri`)
      }
    })
  })
})

describe('caricamenti nativi · le altre richieste e le opzioni di scelta', () => {
  it('leggiFoto, scartaScelti, elenco, annulla e dimentica nominano ciò che cercano con la forma che il nativo usa', () => {
    ognunoDeiCampiServe(schemaRichiestaLeggiFoto, { id: ID_ELEMENTO })
    ognunoDeiCampiServe(schemaRichiestaScartaScelti, { ids: [ID_ELEMENTO, 'altro_elemento'] })
    ognunoDeiCampiServe(schemaRichiestaElenco, { utenteId: UTENTE })
    ognunoDeiCampiServe(schemaRichiestaAnnulla, { jobId: JOB })
    ognunoDeiCampiServe(schemaRichiestaDimentica, { jobIds: [JOB, INTENTO] })
    accetta(schemaRichiestaScartaScelti, { ids: [] }, 'nessun elemento da scartare')
    accetta(schemaRichiestaDimentica, { jobIds: [] }, 'nessuna voce da dimenticare')

    rifiuta(schemaRichiestaLeggiFoto, { id: '../x' }, 'id con la risalita', 'id')
    rifiuta(schemaRichiestaScartaScelti, { ids: [ID_ELEMENTO, 'a/b'] }, 'un id con il separatore', 'ids.1')
    rifiuta(schemaRichiestaScartaScelti, { ids: ID_ELEMENTO }, 'un id al posto di un elenco', 'ids')
    rifiuta(schemaRichiestaElenco, { utenteId: UUID_MAIUSCOLO }, 'utente in maiuscolo', 'utenteId')
    rifiuta(schemaRichiestaAnnulla, { jobId: 'non-un-uuid' }, 'job che non è un uuid', 'jobId')
    rifiuta(schemaRichiestaDimentica, { jobIds: [JOB, 'x'] }, 'un job che non è un uuid', 'jobIds.1')
    rifiuta(schemaRichiestaDimentica, { jobIds: JOB }, 'un job al posto di un elenco', 'jobIds')
  })

  it('le opzioni di scelta costruite dal modulo passano, e portano i limiti dalle loro fonti', () => {
    for (const sorgente of SORGENTI_SCELTA) {
      const opzioni = opzioniScegliMedia(sorgente, 50)
      accetta(schemaOpzioniScegliMedia, viaPonte(opzioni), `sorgente ${sorgente}`)
      expect(opzioni).toEqual({
        sorgente,
        massimoElementi: 50,
        latoMassimoFoto: LATO_MASSIMO_FOTO,
        qualitaFoto: QUALITA_FOTO,
        byteMassimiVideo: MAX_VIDEO_INPUT_BYTES,
        durataMassimaVideoSecondi: MAX_VIDEO_DURATION_SECONDS,
      })
    }
  })

  it('ogni limite sta fra 1 e il suo tetto: un numero sbagliato non allarga la scelta, e `0` non la spalanca', () => {
    const valide = (): Oggetto => ({ ...opzioniScegliMedia('galleria', 50) })
    ognunoDeiCampiServe(schemaOpzioniScegliMedia, valide())
    rifiuta(schemaOpzioniScegliMedia, { ...valide(), sorgente: 'fotocamera' }, 'sorgente fuori elenco', 'sorgente')
    for (const sbagliato of [0, -1, 1.5, '5', null]) {
      // PHPicker legge `selectionLimit = 0` come «senza limite»: un posto zero non deve mai arrivare al selettore.
      rifiuta(schemaOpzioniScegliMedia, { ...valide(), massimoElementi: sbagliato }, `massimoElementi ${JSON.stringify(sbagliato)}`, 'massimoElementi')
    }
    for (const sbagliato of [0, LATO_MASSIMO_FOTO + 1, 1.5]) {
      rifiuta(schemaOpzioniScegliMedia, { ...valide(), latoMassimoFoto: sbagliato }, `latoMassimoFoto ${sbagliato}`, 'latoMassimoFoto')
    }
    for (const sbagliata of [0, -0.1, 1.01, '0.85']) {
      rifiuta(schemaOpzioniScegliMedia, { ...valide(), qualitaFoto: sbagliata }, `qualitaFoto ${JSON.stringify(sbagliata)}`, 'qualitaFoto')
    }
    for (const sbagliato of [0, MAX_VIDEO_INPUT_BYTES + 1]) {
      rifiuta(schemaOpzioniScegliMedia, { ...valide(), byteMassimiVideo: sbagliato }, `byteMassimiVideo ${sbagliato}`, 'byteMassimiVideo')
    }
    for (const sbagliata of [0, MAX_VIDEO_DURATION_SECONDS + 1]) {
      rifiuta(schemaOpzioniScegliMedia, { ...valide(), durataMassimaVideoSecondi: sbagliata }, `durataMassimaVideoSecondi ${sbagliata}`, 'durataMassimaVideoSecondi')
    }
    // Più stretti sì (un collaudo può provare un tetto basso), più larghi no.
    accetta(schemaOpzioniScegliMedia, { ...valide(), byteMassimiVideo: 1_000, durataMassimaVideoSecondi: 5 }, 'limiti più stretti')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 5 · IL CONTRATTO VERO DELLA PR 2 (vince sulla spec)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · il contratto vero della PR 2 attraversa gli schemi nuovi', () => {
  it('le coordinate di PUT coniate da `firmaPut` e il token coniato dal server entrano in `accodaVideo` com’è scritto nella spec', async () => {
    const supabaseFinto = {
      storage: {
        from: () => ({
          createSignedUploadUrl: async () => ({ data: { signedUrl: URL_PUT, token: 'gettone-di-prova', path: 'prova.mov' }, error: null }),
        }),
      },
    } as unknown as SupabaseClient
    const firma = await firmaPut(supabaseFinto, 'prova.mov', 'video/quicktime')
    expect(firma.ok).toBe(true)
    if (!firma.ok) return
    const scadenzaToken = scadenzaTokenRinnovo().toISOString()
    // Ciò che il server dice, riletto con i SUOI schemi: se qui non passa, il difetto è del fixture e non del ponte.
    accetta(schemaRinnovoVideo, { token: generaTokenRinnovo(), scadeIl: scadenzaToken }, 'rinnovo del server')

    const richiesta: RichiestaAccodaVideo = {
      ...(richiestaAccoda() as unknown as RichiestaAccodaVideo),
      // Il passaggio di §7.4 punto 6: `CoordinatePutVideo` + `job.expires_at`.
      caricamento: {
        url: firma.caricamento.url,
        contentType: firma.caricamento.intestazioni['content-type'],
        scadeIl: firma.scadeIl,
      },
      rinnovo: { url: 'https://app.esempio.invalid/api/video-uploads/rinnovo', token: generaTokenRinnovo(), scadeIl: scadenzaToken },
    }
    accetta(schemaRichiestaAccodaVideo, viaPonte(richiesta), 'richiesta composta con i pezzi del server')
  })

  it('un token coniato dal generatore del server passa sempre (venti prove: la forma è `kvr_` + 43)', () => {
    for (let prova = 0; prova < 20; prova++) {
      accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'rinnovo.token', generaTokenRinnovo()), `prova ${prova}`)
    }
  })

  it('un video scelto passa anche l’apertura dell’intento: ciò che il ponte lascia entrare il server non lo rifiuta per forma', () => {
    const elemento = accetta(schemaElementoScelto, video(), 'video scelto') as Extract<ElementoScelto, { tipo: 'video' }>
    for (const durataSecondi of [elemento.durataSecondi, null, MAX_VIDEO_DURATION_SECONDS]) {
      const dichiarato = {
        chiaveIdempotenza: 'gn1-chiave-di-prova',
        nome: elemento.nome,
        byte: elemento.byte,
        mime: elemento.mime,
        durataSecondi,
        sha256: elemento.sha256,
      }
      accetta(schemaFileVideoDichiarato, dichiarato, `apertura con durata ${String(durataSecondi)}`)
    }
  })

  it('lo sha256 maiuscolo il server lo accetta e lo riporta in minuscolo, il ponte NO: è una scelta, e sta scritta qui', () => {
    const maiuscolo = SHA256.toUpperCase()
    const lettoDalServer = schemaFileVideoDichiarato.safeParse({
      chiaveIdempotenza: 'gn1-chiave-di-prova',
      nome: 'x.mov',
      byte: 10,
      mime: 'video/mp4',
      durataSecondi: null,
      sha256: maiuscolo,
    })
    expect(lettoDalServer.success).toBe(true)
    expect(lettoDalServer.success && lettoDalServer.data.sha256).toBe(SHA256)
    rifiuta(schemaElementoScelto, { ...video(), sha256: maiuscolo }, 'il nativo scrive minuscolo', 'sha256')
  })

  it('riusare gli schemi del server non li altera: l’URL con credenziali, che qui si rifiuta, per il server resta quello di sempre', () => {
    const put = { protocollo: 'put', url: 'https://utente@esempio.invalid/x', metodo: 'PUT', intestazioni: { 'content-type': 'video/mp4' } }
    // Il server non ha mai vietato le credenziali incorporate: se questo diventasse falso, il divieto sarebbe finito nel SUO schema.
    expect(schemaCoordinatePutVideo.safeParse(put).success, 'schema del server').toBe(true)
    rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.url', put.url), 'stesso URL nel ponte', 'caricamento.url')
    expect(schemaCoordinatePutVideo.safeParse(put).success, 'schema del server, dopo').toBe(true)
  })

  it('la forma Debug NON si estende alla PUT: il server la vuole https, e il collaudo la riceve https dallo Storage', () => {
    rifiuta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'caricamento.url', 'http://localhost:3101/x'), 'PUT in chiaro', 'caricamento.url')
    accetta(schemaRichiestaAccodaVideo, con(richiestaAccoda(), 'registro.url', 'http://localhost:3101/api/logs'), 'registro in chiaro, di Debug')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 6 · I LIMITI NON SONO RISCRITTI: arrivano da `limiti.ts`
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · i limiti arrivano da `limiti.ts`', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/media/video/limiti')
    vi.doUnmock('@/lib/gallery/limiti')
    vi.resetModules()
  })

  it('rieseguito con altri valori di `limiti.ts` e del bucket, il modulo li segue: nessun numero è stato copiato', async () => {
    vi.resetModules()
    vi.doMock('@/lib/media/video/limiti', async (importaOriginale) => ({
      ...(await importaOriginale<typeof import('@/lib/media/video/limiti')>()),
      MAX_VIDEO_INPUT_BYTES: 1_000,
      MAX_VIDEO_DURATION_SECONDS: 10,
    }))
    vi.doMock('@/lib/gallery/limiti', async (importaOriginale) => ({
      ...(await importaOriginale<typeof import('@/lib/gallery/limiti')>()),
      TETTO_GALLERIA_BYTE: 5_000,
    }))
    const altri = await import('@/lib/native/caricamenti-nativi-tipi')

    // Ogni caso cambia UN campo di un oggetto già valido sotto i nuovi limiti (durata di 5 s, niente byte inviati).
    const videoPiccolo = (): Oggetto => ({ ...video(), byte: 1_000, durataSecondi: 5 })
    const voceVuota = (): Oggetto => ({ ...caricamento(), byteTotali: 1_000, byteInviati: 0 })

    // Peso del video: negli elementi, nella voce di coda, nella richiesta di accodamento, nelle opzioni.
    accetta(altri.schemaElementoScelto, videoPiccolo(), 'video al nuovo tetto')
    rifiuta(altri.schemaElementoScelto, { ...videoPiccolo(), byte: 1_001 }, 'video oltre il nuovo tetto', 'byte')
    accetta(altri.schemaCaricamentoNativo, { ...voceVuota(), byteInviati: 1_000 }, 'voce al nuovo tetto')
    rifiuta(altri.schemaCaricamentoNativo, { ...voceVuota(), byteTotali: 1_001 }, 'voce oltre il nuovo tetto', 'byteTotali')
    rifiuta(altri.schemaCaricamentoNativo, { ...voceVuota(), byteInviati: 1_001 }, 'inviati oltre il nuovo tetto', 'byteInviati')
    accetta(altri.schemaRichiestaAccodaVideo, { ...richiestaAccoda(), byteAttesi: 1_000 }, 'accodamento al nuovo tetto')
    rifiuta(altri.schemaRichiestaAccodaVideo, { ...richiestaAccoda(), byteAttesi: 1_001 }, 'accodamento oltre il nuovo tetto', 'byteAttesi')
    rifiuta(altri.schemaOpzioniScegliMedia, { ...altri.opzioniScegliMedia('file', 5), byteMassimiVideo: 1_001 }, 'opzioni oltre il nuovo tetto', 'byteMassimiVideo')

    // Durata.
    accetta(altri.schemaElementoScelto, { ...videoPiccolo(), durataSecondi: 10 }, 'durata al nuovo tetto')
    rifiuta(altri.schemaElementoScelto, { ...videoPiccolo(), durataSecondi: 10.01 }, 'durata oltre il nuovo tetto', 'durataSecondi')
    rifiuta(altri.schemaOpzioniScegliMedia, { ...altri.opzioniScegliMedia('file', 5), durataMassimaVideoSecondi: 11 }, 'opzioni oltre la nuova durata', 'durataMassimaVideoSecondi')

    // Il costruttore delle opzioni passa i valori che ha trovato.
    expect(altri.opzioniScegliMedia('galleria', 7)).toMatchObject({ byteMassimiVideo: 1_000, durataMassimaVideoSecondi: 10, massimoElementi: 7 })

    // Il tetto delle foto è quello del bucket.
    accetta(altri.schemaElementoScelto, { ...foto(), byte: 5_000 }, 'foto al nuovo tetto')
    rifiuta(altri.schemaElementoScelto, { ...foto(), byte: 5_001 }, 'foto oltre il nuovo tetto', 'byte')
  })

  it('con i valori veri il modulo rieseguito torna a quelli veri (il test non lascia niente in giro)', async () => {
    vi.resetModules()
    const veri = await import('@/lib/native/caricamenti-nativi-tipi')
    accetta(veri.schemaElementoScelto, { ...video(), byte: MAX_VIDEO_INPUT_BYTES }, 'tetto vero')
    rifiuta(veri.schemaElementoScelto, { ...video(), byte: MAX_VIDEO_INPUT_BYTES + 1 }, 'oltre il tetto vero', 'byte')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 7 · LA TABELLA DEI METODI E L'INTERFACCIA
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · la tabella dei metodi e l’interfaccia del plugin', () => {
  it('ha una riga per OGNI metodo dell’elenco, e nessuna di più; ogni riga ha lo schema degli argomenti e quello della risposta', () => {
    expect(Object.keys(SCHEMI_METODI_CARICAMENTI).sort()).toEqual([...METODI_PLUGIN_CARICAMENTI].sort())
    for (const metodo of METODI_PLUGIN_CARICAMENTI) {
      const riga = SCHEMI_METODI_CARICAMENTI[metodo]
      expect(riga.richiesta, `${metodo}: richiesta`).toBeInstanceOf(z.ZodType)
      expect(riga.risposta, `${metodo}: risposta`).toBeInstanceOf(z.ZodType)
    }
  })

  it('`info` e `annullaScelta` non hanno argomenti; gli altri sette li hanno e li verificano', () => {
    for (const metodo of ['info', 'annullaScelta'] as const) {
      accetta(SCHEMI_METODI_CARICAMENTI[metodo].richiesta, undefined, `${metodo} senza argomenti`)
      rifiuta(SCHEMI_METODI_CARICAMENTI[metodo].richiesta, { x: 1 }, `${metodo} con un argomento`)
    }
    for (const metodo of METODI_PLUGIN_CARICAMENTI.filter((m) => m !== 'info' && m !== 'annullaScelta')) {
      rifiuta(SCHEMI_METODI_CARICAMENTI[metodo].richiesta, undefined, `${metodo} senza argomenti`)
      rifiuta(SCHEMI_METODI_CARICAMENTI[metodo].richiesta, {}, `${metodo} con un oggetto vuoto`)
    }
  })

  it('le risposte rilette dalla tabella sono quelle degli schemi: un valore valido per metodo passa, uno fuori forma no', () => {
    const buone: Record<MetodoPluginCaricamenti, unknown> = {
      info: { protocollo: 1, piattaforma: 'android', motore: 'uidt' },
      scegliMedia: { annullato: false, elementi: [video()] },
      annullaScelta: { annullata: false },
      leggiFoto: fotoLetta(),
      scartaScelti: { eliminati: 1 },
      accodaVideo: caricamento(),
      elenco: { caricamenti: [caricamento()] },
      annulla: { annullato: true },
      dimentica: { dimenticati: 1 },
    }
    for (const metodo of METODI_PLUGIN_CARICAMENTI) {
      accetta(SCHEMI_METODI_CARICAMENTI[metodo].risposta, viaPonte(buone[metodo]), `${metodo}: risposta`)
      rifiuta(SCHEMI_METODI_CARICAMENTI[metodo].risposta, {}, `${metodo}: risposta vuota`)
      rifiuta(SCHEMI_METODI_CARICAMENTI[metodo].risposta, null, `${metodo}: risposta nulla`)
    }
  })

  it('i tipi esportati sono quelli scritti nella spec (§4.2): un test di COMPILAZIONE, che tsc fa girare', () => {
    type Piatto<T> = { [K in keyof T]: T[K] }
    type ElementoSceltoDaSpec =
      | { id: string; tipo: 'foto'; nome: string; larghezza: number; altezza: number; byte: number }
      | { id: string; tipo: 'video'; nome: string; byte: number; mime: string; durataSecondi: number | null; miniatura: string | null; sha256: string }
      | { id: string; tipo: 'rifiutato'; nome: string; origine: 'foto' | 'video' | 'altro'; motivo: MotivoRifiuto }
    interface CaricamentoNativoDaSpec {
      jobId: string
      intentId: string
      utenteId: string
      scuolaId: string
      nome: string
      mime: string
      stato: StatoNativo
      byteInviati: number
      byteTotali: number
      tentativi: number
      rinnovi: number
      codice: CodiceNativo | null
      creatoIl: string
      aggiornatoIl: string
    }
    interface RichiestaAccodaVideoDaSpec {
      idElemento: string
      sha256: string
      byteAttesi: number
      jobId: string
      intentId: string
      utenteId: string
      scuolaId: string
      caricamento: { url: string; contentType: string; scadeIl: string | null }
      rinnovo: { url: string; token: string; scadeIl: string }
      registro: { url: string }
      testi: { titolo: string; invio: string; attesaRete: string; pausa: string }
    }
    interface InfoCaricamentiDaSpec {
      protocollo: number
      piattaforma: 'ios' | 'android'
      motore: 'urlsession' | 'uidt' | 'workmanager'
    }
    interface PluginDaSpec {
      info(): Promise<InfoCaricamentiDaSpec>
      scegliMedia(o: {
        sorgente: 'galleria' | 'file'
        massimoElementi: number
        latoMassimoFoto: number
        qualitaFoto: number
        byteMassimiVideo: number
        durataMassimaVideoSecondi: number
      }): Promise<{ annullato: boolean; elementi: ElementoSceltoDaSpec[] }>
      annullaScelta(): Promise<{ annullata: boolean }>
      leggiFoto(o: { id: string }): Promise<{ base64: string; mime: 'image/jpeg'; byte: number; larghezza: number; altezza: number }>
      scartaScelti(o: { ids: string[] }): Promise<{ eliminati: number }>
      accodaVideo(o: RichiestaAccodaVideoDaSpec): Promise<CaricamentoNativoDaSpec>
      elenco(o: { utenteId: string }): Promise<{ caricamenti: CaricamentoNativoDaSpec[] }>
      annulla(o: { jobId: string }): Promise<{ annullato: boolean }>
      dimentica(o: { jobIds: string[] }): Promise<{ dimenticati: number }>
    }
    expectTypeOf<ElementoScelto>().toEqualTypeOf<ElementoSceltoDaSpec>()
    expectTypeOf<CaricamentoNativo>().toEqualTypeOf<CaricamentoNativoDaSpec>()
    expectTypeOf<RichiestaAccodaVideo>().toEqualTypeOf<RichiestaAccodaVideoDaSpec>()
    expectTypeOf<InfoCaricamenti>().toEqualTypeOf<InfoCaricamentiDaSpec>()
    expectTypeOf<EsitoScelta>().toEqualTypeOf<{ annullato: boolean; elementi: ElementoSceltoDaSpec[] }>()
    // L'interfaccia, tolto `addListener`, è quella della spec; e le sue chiavi sono l'elenco dei metodi.
    expectTypeOf<Piatto<Omit<KidvilleCaricamentiPlugin, 'addListener'>>>().toEqualTypeOf<Piatto<PluginDaSpec>>()
    expectTypeOf<keyof Omit<KidvilleCaricamentiPlugin, 'addListener'>>().toEqualTypeOf<MetodoPluginCaricamenti>()
    // Gli schemi di risposta producono ciò che l'interfaccia promette.
    expectTypeOf<z.output<(typeof SCHEMI_METODI_CARICAMENTI)['accodaVideo']['risposta']>>().toEqualTypeOf<CaricamentoNativo>()
    expectTypeOf<z.output<(typeof SCHEMI_METODI_CARICAMENTI)['scegliMedia']['risposta']>>().toEqualTypeOf<EsitoScelta>()
    expectTypeOf<z.output<(typeof SCHEMI_METODI_CARICAMENTI)['info']['risposta']>>().toEqualTypeOf<InfoCaricamenti>()
    expect(true).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 8 · IL MODULO RESTA CLIENT E SENZA EFFETTI
 * ──────────────────────────────────────────────────────────────────────────── */

describe('caricamenti nativi · il modulo è solo client e non si porta dietro niente', () => {
  const sorgente = readFileSync(join(process.cwd(), 'src/lib/native/caricamenti-nativi-tipi.ts'), 'utf8')

  it('importa soltanto zod, il contratto e i limiti dei video, il tetto delle foto e UN TIPO di Capacitor', () => {
    // Le righe `import` cominciano a inizio riga: i commenti di testata (` * …`) non possono ingannare il lock.
    const importati = [...sorgente.matchAll(/^import\s[\s\S]*?\sfrom\s+'([^']+)'/gm)].map((trovato) => trovato[1]).sort()
    expect(importati).toEqual(
      ['@/lib/gallery/limiti', '@/lib/media/video/contratto', '@/lib/media/video/limiti', '@capacitor/core', 'zod'].sort(),
    )
    // Il plugin vero non entra nel bundle da qui: `import type` si cancella in compilazione.
    expect(sorgente).toMatch(/^import type \{ PluginListenerHandle \} from '@capacitor\/core'$/m)
  })

  it('non usa il logger, `console`, `process`, `window` né l’orologio: è un confine, non un comportamento', () => {
    const codice = sorgente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const vietato of [/\bconsole\./, /\bprocess\./, /\bwindow\./, /\bdocument\./, /\bDate\.now\b/, /\bfetch\(/, /logging\/logger/, /\blogClient\b/]) {
      expect(codice, String(vietato)).not.toMatch(vietato)
    }
  })
})
