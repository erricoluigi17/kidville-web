import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * ─── LOCK — ETICHETTARE UN CURRICULUM NON PUÒ MANDARE UNA EMAIL ──────────────
 *
 * ── IL DIFETTO CHE QUESTO LOCK IMPEDISCE ────────────────────────────────────
 *
 * L'etichetta di selezione (`gia_chiamata`, `non_idonea`, `da_richiamare`,
 * `in_valutazione`, `assunta`) è una nota INTERNA: serve a chi seleziona, e non
 * deve mai raggiungere la persona che si è candidata. «Non idonea» segnato per la
 * Direzione e «non idonea» recapitato via posta sono due fatti diversi, e il
 * secondo non si annulla.
 *
 * Il flusso candidature ha TRE punti d'invio, tutti a poche righe da qui:
 *   1. `src/app/api/iscrizione/insegnanti/route.ts`  — conferma alla candidata,
 *      alla RICEZIONE del modulo pubblico;
 *   2. `src/lib/candidature/copia-alla-sede.ts`      — copia con CV alla casella
 *      del plesso (automatica alla ricezione, o manuale da `inoltro-arretrato`);
 *   3. `src/app/api/admin/candidature-insegnanti/route.ts` — esito, e SOLO con
 *      `action: 'rifiuta'` **e** `inviaEmailEsito === true` (spento di default).
 *
 * La strada più corta per aggiungere l'etichetta sarebbe stata farla passare da
 * uno di quei tre — un `action: 'etichetta'` nella PATCH grossa, per dire. Ed è
 * esattamente la strada che non si può prendere: in quel modulo vivono
 * `sendEmailDetailed` e il costruttore del messaggio d'esito, e nessun lock
 * potrebbe più distinguere «non manda email» da «non manda email oggi».
 *
 * ── PERCHÉ SUL GRAFO DEGLI IMPORT E NON SU UNA `grep` ───────────────────────
 *
 * Una `grep` di `sendEmail` in un file si aggira in un pomeriggio, e non per
 * malizia: basta un aiutante intermedio — `notifica(candidatura)` in un
 * `lib/` — perché la parola sparisca dalla rotta e l'invio resti. Qui si
 * ricostruisce il grafo degli import a partire dalla rotta e si guarda TUTTO ciò
 * che è raggiungibile, a qualunque profondità: un mittente dietro tre livelli di
 * indirezione è raggiungibile quanto uno importato in cima al file.
 *
 * ── E PERCHÉ L'ELENCO DEI MITTENTI SI DERIVA, NON SI SCRIVE ─────────────────
 *
 * `MITTENTI` non è una lista a mano: è l'insieme dei file di `src/` che
 * CONTENGONO una chiamata d'invio (`sendEmail…(`, `emails.send(`,
 * `inviaCopiaAllaSede(`), calcolato a ogni esecuzione. Un mittente nuovo entra da
 * solo nel perimetro il giorno in cui viene scritto. Una lista scritta a mano,
 * invece, sarebbe ferma al 2026-09-05 e questo lock sarebbe verde su un percorso
 * d'invio che ancora non esisteva.
 *
 * ── LA PROVA CHE IL RILEVATORE MORDE ────────────────────────────────────────
 *
 * Il controllo positivo NON è un campione inventato: è la rotta grossa delle
 * candidature, quella che le email le manda davvero. Se il grafo, partendo di lì,
 * non trovasse nessun mittente, vorrebbe dire che il camminatore non cammina — e
 * il verde di tutto il resto del file non varrebbe niente. È l'unica forma di
 * controllo positivo che non può marcire: usa il repo, non una finzione.
 */

const RADICE = process.cwd()

/** La rotta che scrive l'etichetta: da qui non si deve poter arrivare alla posta. */
const ROTTA_ETICHETTA = 'src/app/api/admin/candidature-insegnanti/etichetta/route.ts'

/** Il controllo positivo: la rotta che le email le manda per davvero. */
const ROTTA_CON_INVII = 'src/app/api/admin/candidature-insegnanti/route.ts'

/**
 * Le CHIAMATE che spediscono. Il `(` non è un dettaglio: `sendEmailDetailed`
 * nominato in un commento o in un tipo non spedisce niente, e un rilevatore che
 * accusa i commenti insegna a spegnere il lock.
 */
const CHIAMATA_DI_INVIO = /\b(?:sendEmailDetailed|sendEmail|inviaCopiaAllaSede)\s*\(|\bemails\s*\.\s*send\s*\(/

/**
 * I moduli della POSTA per costruzione: tutto `src/lib/email/**`.
 *
 * Ci sta dentro anche `messaggi/**`, che «solo» costruisce il testo. È voluto:
 * un modulo che sa comporre l'email d'esito di una candidatura è già a un `await`
 * di distanza dal mandarla, e una rotta che etichetta non ha nessuna ragione di
 * conoscerlo.
 */
const PERCORSI_POSTA = /^src\/lib\/email\//

// ─── il camminatore ──────────────────────────────────────────────────────────

/** Via i commenti: `//…` e `/*…*\/`, e le stringhe restano intatte quanto basta. */
function senzaCommenti(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Gli specificatori importati da un file: `import … from 'X'`, `export … from 'X'`, `import('X')`. */
function specificatoriDi(testo: string): string[] {
  const puliti = senzaCommenti(testo)
  const fuori: string[] = []
  for (const m of puliti.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) fuori.push(m[1])
  for (const m of puliti.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) fuori.push(m[1])
  for (const m of puliti.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) fuori.push(m[1])
  return fuori
}

const ESTENSIONI = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']

/** Un percorso senza estensione → il file vero, relativo alla radice del repo. */
function primoEsistente(base: string): string | null {
  for (const est of ['', ...ESTENSIONI]) {
    const tentativo = base + est
    if (fs.existsSync(path.join(RADICE, tentativo)) && fs.statSync(path.join(RADICE, tentativo)).isFile()) {
      return tentativo
    }
  }
  for (const est of ESTENSIONI) {
    const tentativo = path.join(base, `index${est}`)
    if (fs.existsSync(path.join(RADICE, tentativo))) return tentativo
  }
  return null
}

/**
 * Lo specificatore → il file del repo, oppure `null` se è un pacchetto.
 *
 * ⚠️ `@/` NON è uno scope npm: è l'alias di `src/` di questo repo
 * (`tsconfig.json`). Confonderlo con `@supabase/…` farebbe saltare metà del grafo
 * — cioè renderebbe questo lock verde per cecità.
 */
function risolvi(spec: string, daFile: string): string | null {
  if (spec.startsWith('@/')) return primoEsistente(path.join('src', spec.slice(2)))
  if (spec.startsWith('.')) {
    const base = path.normalize(path.join(path.dirname(daFile), spec))
    return primoEsistente(base)
  }
  return null // pacchetto esterno: fuori dal grafo del repo
}

/** Tutto ciò che, partendo da `ingresso`, si raggiunge seguendo gli import. */
function raggiungibili(ingresso: string): Set<string> {
  const visti = new Set<string>()
  const coda = [ingresso]
  while (coda.length > 0) {
    const corrente = coda.pop() as string
    if (visti.has(corrente)) continue
    visti.add(corrente)
    const assoluto = path.join(RADICE, corrente)
    if (!fs.existsSync(assoluto)) continue
    for (const spec of specificatoriDi(fs.readFileSync(assoluto, 'utf8'))) {
      const risolto = risolvi(spec, corrente)
      if (risolto && !visti.has(risolto)) coda.push(risolto)
    }
  }
  visti.delete(ingresso)
  return visti
}

/** Tutti i sorgenti sotto `src/`. */
function sorgenti(dir: string, acc: string[] = []): string[] {
  for (const voce of fs.readdirSync(path.join(RADICE, dir), { withFileTypes: true })) {
    const rel = path.join(dir, voce.name)
    if (voce.isDirectory()) {
      if (voce.name === 'node_modules' || voce.name.startsWith('.')) continue
      sorgenti(rel, acc)
    } else if (/\.(?:ts|tsx)$/.test(voce.name)) {
      acc.push(rel)
    }
  }
  return acc
}

/** I file che CONTENGONO una chiamata d'invio. Derivato dal repo, non scritto a mano. */
const MITTENTI = new Set(
  sorgenti('src').filter((f) => CHIAMATA_DI_INVIO.test(senzaCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8')))),
)

const DA_ETICHETTA = raggiungibili(ROTTA_ETICHETTA)

const COME_SI_CORREGGE =
  "L'etichetta è una nota interna e non deve poter raggiungere la posta. " +
  'Se serve avvisare qualcuno, si fa da una rotta sua, con il suo consenso e la sua casella — ' +
  'non appendendo un invio al gesto di marcare un curriculum.'

describe('LOCK — la rotta che etichetta un curriculum non può mandare email', () => {
  it('il camminatore cammina davvero (se cade, tutto il resto è verde per cecità)', () => {
    expect(fs.existsSync(path.join(RADICE, ROTTA_ETICHETTA)), `rotta assente: ${ROTTA_ETICHETTA}`).toBe(true)
    expect(fs.existsSync(path.join(RADICE, ROTTA_CON_INVII)), `rotta assente: ${ROTTA_CON_INVII}`).toBe(true)
    // Una rotta importa il client Supabase, il gate, il logger, zod…: un grafo di
    // due moduli vorrebbe dire che `risolvi` non risolve più niente.
    expect(
      DA_ETICHETTA.size,
      `dalla rotta dell'etichetta si raggiungono ${DA_ETICHETTA.size} moduli: il grafo non si sta costruendo`,
    ).toBeGreaterThan(5)
    expect(MITTENTI.size, 'nessun mittente trovato in src/: il rilevatore delle chiamate non funziona').toBeGreaterThan(3)
  })

  it('CONTROLLO POSITIVO — dalla rotta grossa (che le email le manda) il rilevatore li TROVA', () => {
    const daGrossa = raggiungibili(ROTTA_CON_INVII)
    const trovati = [...daGrossa].filter((f) => MITTENTI.has(f)).sort()
    expect(
      trovati.length,
      `Dalla rotta che manda l'esito della candidatura non si raggiunge NESSUN mittente: ` +
        `il grafo o il rilevatore sono rotti, e il verde degli altri test qui non vale niente.`,
    ).toBeGreaterThan(0)
    // E anche i moduli della posta: le due reti devono mordere tutte e due.
    expect(
      [...daGrossa].filter((f) => PERCORSI_POSTA.test(f)).length,
      'la rotta grossa non raggiunge `src/lib/email/**`: la seconda rete non è tesa',
    ).toBeGreaterThan(0)
  })

  it('🔴 dalla rotta dell’etichetta non si raggiunge NESSUN mittente di email', () => {
    const colpevoli = [...DA_ETICHETTA].filter((f) => MITTENTI.has(f)).sort()
    expect(
      colpevoli,
      `Da ${ROTTA_ETICHETTA} si arriva a un percorso che SPEDISCE:\n  ${colpevoli.join('\n  ')}\n${COME_SI_CORREGGE}`,
    ).toEqual([])
  })

  it('🔴 e non si raggiunge nemmeno `src/lib/email/**` (comporre è già troppo vicino)', () => {
    const colpevoli = [...DA_ETICHETTA].filter((f) => PERCORSI_POSTA.test(f)).sort()
    expect(
      colpevoli,
      `Da ${ROTTA_ETICHETTA} si arriva ai moduli della posta:\n  ${colpevoli.join('\n  ')}\n${COME_SI_CORREGGE}`,
    ).toEqual([])
  })

  it('🔴 e non si raggiunge la rotta grossa, che quei tre percorsi li contiene tutti', () => {
    expect(
      DA_ETICHETTA.has(ROTTA_CON_INVII),
      `${ROTTA_ETICHETTA} importa ${ROTTA_CON_INVII}: da lì si arriva all'invio dell'esito, ` +
        `alla conferma alla candidata e alla copia con CV al plesso. ${COME_SI_CORREGGE}`,
    ).toBe(false)
    expect(
      DA_ETICHETTA.has('src/lib/candidature/copia-alla-sede.ts'),
      `${ROTTA_ETICHETTA} raggiunge la copia con CV al plesso. ${COME_SI_CORREGGE}`,
    ).toBe(false)
  })
})
