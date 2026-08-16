import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · una chiave di traduzione che nessuna riga di codice nomina è una chiave MORTA.
 *
 * ─── IL DIFETTO, misurato il 2026-08-16 ─────────────────────────────────────────
 *
 * Il commit `7a438fde` aveva un mestiere solo — togliere un tab-mockup e i suoi residui — e
 * ha portato via il CONSUMATORE lasciando il CONSUMATO: cancellando il pannello «Sala
 * d'Attesa» di `admin/modulistica/page.tsx` sono rimaste indietro sei chiavi
 * (`modNessunaPreiscrizione`, `modFamiglia`, `modNuovo`, `modGenitoreRiga`,
 * `modFigliDaIscrivere`, `modGestisci`) in **entrambi** i cataloghi: dodici stringhe che
 * nessuno mostrerà mai più.
 *
 * ─── PERCHÉ NESSUNO STRUMENTO LE VEDEVA ─────────────────────────────────────────
 *
 * `messaggi-parita-cataloghi` verifica che `it` ed `en` si somiglino, e **due cataloghi
 * possono essere perfettamente simmetrici e perfettamente morti**. `messaggi-plurali-e-glossario`
 * guarda la FORMA delle stringhe, non se qualcuno le chiede. ESLint non può: una chiave è un
 * pezzo di JSON, non un identificatore. Il compilatore nemmeno. Restava l'occhio di chi
 * rilegge il diff — e il diff, quel giorno, era di 166 righe in meno.
 *
 * La regola qui è l'altra metà di quella che il repo applica già alle allowlist: un elenco
 * che non si abbassa quando una voce muore lascia un posto libero a chi verrà dopo. Vale
 * identica per un catalogo.
 *
 * ─── PERCHÉ IL PERIMETRO NON È (ANCORA) TUTTO IL REPO ───────────────────────────
 *
 * Misurato, non supposto: passando questa stessa scansione su tutti e 38 i cataloghi
 * italiani vengono fuori ~380 chiavi che nessun sorgente nomina — ma la grande maggioranza
 * NON è morta: è risolta a runtime, con la chiave costruita da un dato. Il caso limite è
 * `etichette`, dove 171 chiavi su 199 risultano «orfane» proprio perché il codice fa
 * `t(etichetta.chiave)`. Un lock acceso su tutto il repo oggi sarebbe un lock che tutti
 * imparano a spegnere, cioè peggio di nessun lock.
 *
 * Quindi il perimetro è DICHIARATO e si allarga a misura: si aggiunge un namespace a
 * `SOTTO_TUTELA` quando la scansione su quel namespace dà zero. Oggi sono a zero anche
 * `adminComunicazioni`, `adminMensa`, `adminNav`, `adminPrimaria`, `adminSettings`, `auth`,
 * `avvisi`, `mensa`, `nav`, `offline`, `pagamenti`, `parentAssenze`, `parentChat`,
 * `parentForms`, `parentNews`, `parentPrimaria`, `prestampatiSegreteria`, `profilo`,
 * `public`, `teacherPresenze`, `teacherServizi`, `teacherTasks`: entrano appena il ramo che
 * li sta riscrivendo è chiuso, per non far trovare un rosso a chi ci sta lavorando ora.
 */

const RADICE = process.cwd()
const CARTELLA_IT = join(RADICE, 'messages/it')

/**
 * I namespace sotto tutela: zero chiavi orfane, e il motivo per cui la misura è affidabile.
 * Per entrare serve una cosa sola — che la scansione dia zero — e una riga che dica perché.
 */
const SOTTO_TUTELA = new Map<string, string>([
  [
    'adminModulistica',
    'ogni chiave è nominata per esteso in page.tsx e nei componenti: nessuna costruita da un dato',
  ],
])

/** Tutti i sorgenti applicativi: è lì che una chiave viene chiesta. */
function sorgentiApplicative(): string[] {
  const trovati: string[] = []
  const cammina = (dir: string) => {
    for (const voce of readdirSync(dir)) {
      const percorso = join(dir, voce)
      if (statSync(percorso).isDirectory()) cammina(percorso)
      else if (/\.(ts|tsx)$/.test(voce)) trovati.push(percorso)
    }
  }
  cammina(join(RADICE, 'src'))
  return trovati
}

const TESTO_SORGENTI = sorgentiApplicative()
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

/** Le chiavi del namespace che nessuna riga di `src/` nomina. */
function chiaviOrfane(namespace: string, testo: string = TESTO_SORGENTI): string[] {
  const catalogo = JSON.parse(
    readFileSync(join(CARTELLA_IT, `${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>
  return Object.keys(catalogo).filter((chiave) => {
    // Il nome della chiave come PAROLA INTERA: `modNd` non deve farsi trovare dentro
    // `modNdQualcosa`, altrimenti il lock si autoassolve sulle chiavi con prefisso comune.
    const nome = new RegExp(`(?<![A-Za-z0-9_])${chiave}(?![A-Za-z0-9_])`)
    return !nome.test(testo)
  })
}

describe('lock architettura · nessuna chiave di traduzione morta nei namespace sotto tutela', () => {
  it('la scansione funziona davvero: una chiave inventata risulta orfana', () => {
    // Senza questo controllo positivo il divieto qui sotto sarebbe verde anche con una
    // scansione rotta — che è il modo in cui un lock smette di proteggere restando verde.
    const namespace = [...SOTTO_TUTELA.keys()][0]
    expect(chiaviOrfane(namespace, 'nessun sorgente qui dentro').length).toBeGreaterThan(50)
    expect(TESTO_SORGENTI.length).toBeGreaterThan(1_000_000)
  })

  for (const [namespace, motivo] of SOTTO_TUTELA) {
    it(`${namespace}: ogni chiave è chiesta da almeno una riga di codice`, () => {
      const orfane = chiaviOrfane(namespace)
      expect(
        orfane,
        `Queste chiavi di \`messages/{it,en}/${namespace}.json\` non sono nominate da nessuna ` +
          `riga di \`src/\`:\n  ${orfane.join('\n  ')}\n` +
          'Sono stringhe che nessun utente leggerà mai, e in due lingue. Quasi sempre ' +
          'significa che è stato tolto il codice che le mostrava e non le chiavi: ' +
          'toglile da ENTRAMBI i cataloghi. ' +
          `(Il namespace è sotto tutela perché ${motivo}.)`,
      ).toEqual([])
    })
  }

  it('le chiavi tolte da `it` spariscono anche da `en`', () => {
    // La parità dei cataloghi ha il suo lock; qui interessa la metà che quel lock non
    // vede — due file simmetrici e morti restano simmetrici, quindi verdi.
    for (const namespace of SOTTO_TUTELA.keys()) {
      const chiaviEn = Object.keys(
        JSON.parse(readFileSync(join(RADICE, 'messages/en', `${namespace}.json`), 'utf8')),
      )
      const orfane = chiaviOrfane(namespace)
      expect(chiaviEn.filter((c) => orfane.includes(c))).toEqual([])
    }
  })

  it('ogni namespace sotto tutela porta la ragione per cui ci sta', () => {
    for (const [namespace, motivo] of SOTTO_TUTELA) {
      expect(motivo.length, `${namespace} è sotto tutela senza motivo scritto`).toBeGreaterThan(20)
    }
  })
})
