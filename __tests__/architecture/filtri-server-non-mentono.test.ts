import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * ─── LOCK — UN FILTRO `dove: 'server'` DEVE ESISTERE ANCHE NEL SERVER ────────
 *
 * ── IL DIFETTO CHE QUESTO LOCK IMPEDISCE ────────────────────────────────────
 *
 * Una barra filtri manda i campi `dove: 'server'` nella query dell'API
 * (`queryServer`, `motore.ts`). Se la rotta quel parametro non lo conosce, non
 * succede niente di rumoroso: `parseQuery` lo IGNORA — uno schema `zod` senza
 * `.strict()` scarta le chiavi che non ha — e la risposta torna **200 con
 * l'elenco INTERO**. A schermo si vede un filtro attivo, il suo chip removibile,
 * il conteggio della pastiglia «Filtri», e sotto tutte le righe che c'erano
 * prima. Nessun 400, nessun log, nessun test rosso: solo una schermata che dice
 * di aver filtrato e non l'ha fatto.
 *
 * È lo stesso difetto — misurato, non ipotizzato — che `admin/forms:GET` aveva
 * su `scuola_id`: lo schema lo dichiarava con accanto il commento «ignorato», e
 * la lista tornava quella di tutte le sedi attive.
 *
 * ── COSA PRETENDE, ESATTAMENTE ──────────────────────────────────────────────
 *
 * Per ogni descrittore `src/components/features/**\/filtri-*.ts` e per ogni
 * campo con `dove: 'server'`, la `chiave` di quel campo deve comparire fra le
 * chiavi del `getQuerySchema` della rotta che quella linguetta interroga. Per un
 * campo `tipo: 'periodo'` le chiavi sono DUE (`<chiave>Da` e `<chiave>A`), come
 * le scrive il motore nell'indirizzo e come le costruisce `zPeriodo`.
 *
 * ── E COSA NON PRETENDE ─────────────────────────────────────────────────────
 *
 * Il contrario NON è un errore: una rotta può accettare un parametro che nessuna
 * barra offre (`?citta=`, `?provincia=`) — è una capacità dell'API, non un
 * filtro che mente. La bugia è solo nel verso barra → server.
 */

const RADICE = process.cwd()
const DESCRITTORI = path.join(RADICE, 'src/components/features')

/**
 * ⚠️ LA MAPPA È ESPLICITA, e non dedotta dal nome del file.
 *
 * Dedurla («filtri-candidature» → `api/admin/candidature…`) sembra più comodo e
 * sarebbe un rilevatore che si aggira rinominando un file: il giorno in cui la
 * deduzione fallisce, il lock non trova la rotta e — se fosse indulgente — non
 * verificherebbe niente restando verde. Qui una voce mancante è un ERRORE
 * (vedi il primo test), quindi aggiungere un descrittore con campi server senza
 * dichiarare la sua rotta rende rosso questo file.
 */
/**
 * ⚠️ IL VALORE È UN ELENCO, e non per generosità: un descrittore può servire più
 * di un pannello. `teacher/filtri-modulistica.ts` ne serve due — il semaforo
 * delle autorizzazioni e i certificati medici — che interrogano due rotte
 * diverse. Una chiave server è in regola se la conosce ALMENO UNA delle rotte
 * dichiarate: pretenderla in tutte renderebbe rosso un descrittore corretto.
 */
const ROTTA_DI: Record<string, string[]> = {
  'admin/iscrizioni/filtri-candidature.ts': ['src/app/api/admin/candidature-insegnanti/route.ts'],
  'admin/iscrizioni/filtri-ricevuti.ts': ['src/app/api/admin/iscrizioni/route.ts'],
  'admin/personale/filtri-pratiche.ts': ['src/app/api/admin/pratiche-personale/route.ts'],
  'teacher/filtri-modulistica.ts': [
    'src/app/api/teacher/modulistica/route.ts',
    'src/app/api/teacher/medical-certificates/route.ts',
  ],
}

/** Tutti i descrittori di filtri sotto `src/components/features`. */
function descrittori(dir: string): string[] {
  const fuori: string[] = []
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, voce.name)
    if (voce.isDirectory()) fuori.push(...descrittori(completo))
    else if (/^filtri-.*\.ts$/.test(voce.name)) fuori.push(completo)
  }
  return fuori
}

interface CampoDichiarato {
  chiave: string
  dove: string
  tipo: string
}

/**
 * I campi dichiarati in un descrittore.
 *
 * Il riconoscimento è testuale e volutamente ingenuo: si spezza il file sui
 * `chiave:` e si guarda il pezzo che segue, dove `dove:` e `tipo:` vivono per
 * forza (sono proprietà dello stesso oggetto letterale). Un campo che non
 * dichiara `dove` NON viene saltato: viene segnalato — un riconoscitore che
 * smette di riconoscere lascerebbe questo lock verde per sempre, ed è il modo
 * in cui un guardiano muore senza che nessuno se ne accorga.
 */
function campiDi(sorgente: string): { campi: CampoDichiarato[]; senzaDove: string[] } {
  const campi: CampoDichiarato[] = []
  const senzaDove: string[] = []
  const chiavi = [...sorgente.matchAll(/\bchiave:\s*'([^']+)'/g)]
  for (let i = 0; i < chiavi.length; i++) {
    const inizio = chiavi[i].index ?? 0
    const fine = i + 1 < chiavi.length ? (chiavi[i + 1].index ?? sorgente.length) : sorgente.length
    const pezzo = sorgente.slice(inizio, fine)
    const dove = /\bdove:\s*'([^']+)'/.exec(pezzo)?.[1]
    // `tipo` PRECEDE `chiave` nello stesso oggetto letterale: si prende
    // l'ULTIMA occorrenza prima di qui, non la prima di una finestra — con una
    // finestra a lunghezza fissa si pesca il `tipo` del campo PRECEDENTE, e un
    // `periodo` scambiato per una `scelta` fa cercare la chiave sbagliata (cioè
    // fa fallire il lock su uno schema che è a posto: un falso positivo che
    // insegna a non fidarsi del lock).
    const primaDiQui = [...sorgente.slice(0, inizio).matchAll(/\btipo:\s*'([^']+)'/g)]
    const tipo = primaDiQui.length > 0 ? primaDiQui[primaDiQui.length - 1][1] : undefined
    if (!dove) {
      senzaDove.push(chiavi[i][1])
      continue
    }
    campi.push({ chiave: chiavi[i][1], dove, tipo: tipo ?? 'ignoto' })
  }
  return { campi, senzaDove }
}

/**
 * Le chiavi che il `getQuerySchema` di una rotta accetta.
 *
 * `...zPeriodo('creata').shape` si espande in `creataDa`/`creataA`: sono i nomi
 * che `zPeriodo` costruisce e che il motore scrive nell'indirizzo, quindi
 * cercare la stringa `creataDa` alla lettera direbbe «non c'è» su uno schema che
 * ce l'ha eccome.
 */
function chiaviSchema(sorgente: string): string[] {
  const inizio = sorgente.indexOf('const getQuerySchema = z.object({')
  if (inizio === -1) return []
  // Fino alla chiusura dell'oggetto: la prima riga che comincia con `})`.
  const resto = sorgente.slice(inizio)
  const fine = resto.search(/\n\}\)/)
  const corpo = fine === -1 ? resto : resto.slice(0, fine)
  const chiavi = [...corpo.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
  for (const m of corpo.matchAll(/\.\.\.zPeriodo\('([^']+)'\)\.shape/g)) {
    chiavi.push(`${m[1]}Da`, `${m[1]}A`)
  }
  return chiavi
}

const FILE = descrittori(DESCRITTORI)

describe('LOCK — i filtri `dove: server` esistono anche nello schema della rotta', () => {
  it('ci sono descrittori da controllare (un lock che non guarda niente è verde per sbaglio)', () => {
    expect(FILE.length).toBeGreaterThan(0)
    // E almeno uno deve avere campi server, altrimenti questo lock non sta
    // verificando la regola che dice di verificare.
    const conServer = FILE.filter((f) => campiDi(fs.readFileSync(f, 'utf8')).campi.some((c) => c.dove === 'server'))
    expect(conServer.length).toBeGreaterThan(0)
  })

  it('ogni campo dichiara `dove`: un campo senza non è filtrato da nessuno', () => {
    const guasti: string[] = []
    for (const f of FILE) {
      const { senzaDove } = campiDi(fs.readFileSync(f, 'utf8'))
      for (const k of senzaDove) guasti.push(`${path.relative(RADICE, f)} → '${k}'`)
    }
    expect(guasti, `campi senza \`dove\`:\n${guasti.join('\n')}`).toEqual([])
  })

  it('ogni descrittore CON campi server dichiara la propria rotta in `ROTTA_DI`', () => {
    const orfani: string[] = []
    for (const f of FILE) {
      const { campi } = campiDi(fs.readFileSync(f, 'utf8'))
      if (!campi.some((c) => c.dove === 'server')) continue
      const relativo = path.relative(DESCRITTORI, f)
      if (!ROTTA_DI[relativo]) orfani.push(relativo)
    }
    expect(
      orfani,
      `descrittori con filtri server e senza rotta dichiarata:\n${orfani.join('\n')}`,
    ).toEqual([])
  })

  it('🔴 ogni `chiave` server compare nel `getQuerySchema` della sua rotta', () => {
    const mancanti: string[] = []
    for (const [relativo, rotte] of Object.entries(ROTTA_DI)) {
      const percorsoDescrittore = path.join(DESCRITTORI, relativo)
      expect(fs.existsSync(percorsoDescrittore), `descrittore assente: ${relativo}`).toBe(true)

      const accettate = new Set<string>()
      for (const rotta of rotte) {
        const percorsoRotta = path.join(RADICE, rotta)
        expect(fs.existsSync(percorsoRotta), `rotta assente: ${rotta}`).toBe(true)
        const chiavi = chiaviSchema(fs.readFileSync(percorsoRotta, 'utf8'))
        // Uno schema che non si è saputo leggere non deve produrre un lock
        // verde: zero chiavi è un guasto del riconoscitore, non una rotta senza
        // filtri.
        expect(chiavi.length, `nessuna chiave letta da ${rotta}: il riconoscitore non ha funzionato`)
          .toBeGreaterThan(0)
        for (const k of chiavi) accettate.add(k)
      }

      const { campi } = campiDi(fs.readFileSync(percorsoDescrittore, 'utf8'))
      for (const campo of campi) {
        if (campo.dove !== 'server') continue
        const attese = campo.tipo === 'periodo' ? [`${campo.chiave}Da`, `${campo.chiave}A`] : [campo.chiave]
        for (const attesa of attese) {
          if (!accettate.has(attesa)) {
            mancanti.push(`${relativo} → '${attesa}' non è in ${rotte.join(' né in ')}`)
          }
        }
      }
    }
    expect(
      mancanti,
      `filtri che partono verso il server e che il server non conosce ` +
        `(la rotta li IGNORA e risponde 200 con l'elenco intero):\n${mancanti.join('\n')}`,
    ).toEqual([])
  })
})
