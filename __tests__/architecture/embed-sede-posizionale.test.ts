import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { embedSedeDi } from '../helpers/embed-sede'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  L'ORDINE DEI DUE EMBED È UN CONTRATTO, E QUESTO LO SORVEGLIA            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── IL DIFETTO CHE CHIUDE ──────────────────────────────────────────────────
 * `.in('candidature_sedi.scuola_id', scuole)` si lega al PRIMO embed di quella
 * tabella nella stringa `select`, **per posizione** — non a quello che porta
 * `!inner`. La rotta del cockpit ne usa due: uno che RESTRINGE
 * (`candidature_sedi!inner(...)`) e uno che DESCRIVE (`sedi:candidature_sedi(...)`).
 *
 * Scambiare le due costanti sposta il filtro sull'embed descrittivo: l'`!inner`
 * finisce in seconda posizione, non restringe più niente, e l'elenco mostra
 * candidature di plessi che chi guarda non ha. Nessun errore, nessun avviso, e
 * il tipo del componente non cambia: solo dati di più.
 *
 * MISURATO sulla produzione il 2026-08-20 con una candidatura rivolta a due sedi
 * entrambe visibili: filtrando su Aversa l'array incorporato porta `[{Aversa}]`
 * e di Giugliano nessuna traccia. È la prova che il legame è posizionale.
 *
 * ─── PERCHÉ QUESTO LOCK OLTRE AL FINTO ──────────────────────────────────────
 * `__tests__/helpers/embed-sede.ts` insegna la stessa regola al finto dei test
 * API, e quello sorveglia il COMPORTAMENTO: cadrebbe anche per una forma che
 * oggi non immaginiamo. Questo sorveglia l'ORDINE nel punto in cui si sbaglia, e
 * dice in chiaro, nel messaggio d'errore, che l'ordine è un contratto. Un lock
 * strutturale da solo lo si aggira scrivendo la query altrove; un finto da solo
 * non spiega perché è caduto.
 *
 * ─── ROTTO APPOSTA, E VISTO CADERE ──────────────────────────────────────────
 * Non è una promessa: il `describe` finale contiene il CONTROLLO NEGATIVO
 * CODIFICATO — le stesse due costanti in ordine invertito, date all'analizzatore,
 * che deve segnalarle. Se un giorno l'analizzatore smettesse di riconoscere gli
 * embed (una regex che non regge una forma nuova), quel test diventa rosso
 * invece di lasciar passare tutto in silenzio.
 *
 * In più, il 2026-08-20 le due costanti sono state invertite DAVVERO nel
 * sorgente e questo file è diventato rosso con «l'embed che restringe non è il
 * primo»; rimesse a posto, verde.
 */

const ROTTA = 'src/app/api/admin/candidature-insegnanti/route.ts'

/**
 * Le costanti `const NOME = '…'` del file, per risolvere le interpolazioni.
 *
 * La `select` è un template literal che interpola `${EMBED_FILTRO}`, non la
 * stringa: senza risolvere, l'analizzatore non vedrebbe nessun embed e sarebbe
 * verde su qualunque cosa.
 */
function costantiStringa(src: string): Map<string, string> {
  const mappa = new Map<string, string>()
  for (const m of src.matchAll(/^const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/gm)) {
    mappa.set(m[1], m[2])
  }
  return mappa
}

/** Le catene `.select(`…`)` del file, ognuna col pezzo di sorgente che la segue. */
function catene(src: string): { proiezione: string; seguito: string; riga: number }[] {
  const fuori: { proiezione: string; seguito: string; riga: number }[] = []
  const re = /\.select\(\s*`([^`]+)`/g
  const inizi = [...src.matchAll(re)]
  inizi.forEach((m, i) => {
    const dopo = m.index! + m[0].length
    // Fino alla `select` successiva, o 1500 caratteri: abbastanza per arrivare
    // ai filtri della stessa catena senza sconfinare in quella dopo.
    const fine = i + 1 < inizi.length ? inizi[i + 1].index! : Math.min(src.length, dopo + 1500)
    fuori.push({
      proiezione: m[1],
      seguito: src.slice(dopo, fine),
      riga: src.slice(0, m.index!).split('\n').length,
    })
  })
  return fuori
}

/**
 * Risolve `${COSTANTE}` dentro la proiezione.
 *
 * ⚠️ Se una costante non si risolve, si LANCIA. Un rilevatore che tace su ciò
 * che non capisce non è un rilevatore: la prima volta che qualcuno scrive la
 * query con un'indirezione nuova, questo file smetterebbe di guardare senza
 * dirlo. Le interpolazioni note e innocue — `${colonne}`, che è l'array delle
 * colonne della madre — sono elencate qui, in chiaro.
 */
const INTERPOLAZIONI_SENZA_EMBED = new Set(['colonne'])

function risolvi(proiezione: string, costanti: Map<string, string>, riga: number): string {
  return proiezione.replace(/\$\{(\w+)\}/g, (_, nome: string) => {
    if (INTERPOLAZIONI_SENZA_EMBED.has(nome)) return ''
    const valore = costanti.get(nome)
    if (valore === undefined) {
      throw new Error(
        `${ROTTA}:${riga} — la \`select\` interpola \`${nome}\`, che questo lock non sa risolvere. ` +
          `Non è un falso allarme da mettere a tacere: finché resta così, l'ordine degli embed di ` +
          `quella query non è sorvegliato da nessuno. Aggiungere la costante come letterale, oppure ` +
          `— se davvero non porta embed — dichiararla in INTERPOLAZIONI_SENZA_EMBED con il perché.`,
      )
    }
    return valore
  })
}

/** Il verdetto su una proiezione già risolta. `null` quando va bene. */
export function guastoDellOrdine(proiezioneRisolta: string, conFiltro: boolean): string | null {
  const embed = embedSedeDi(proiezioneRisolta)
  if (embed.length === 0) return null
  if (!conFiltro) {
    return (
      'la query incorpora `candidature_sedi` ma non porta ' +
      "`.in('candidature_sedi.scuola_id', …)`: incorpora le sedi senza filtrarci sopra, " +
      'cioè arricchisce invece di isolare'
    )
  }
  if (!embed.some((e) => e.inner)) {
    return (
      'nessuno degli embed porta `!inner`: senza, un filtro sull’embed svuota l’array e ' +
      'LASCIA la riga madre in elenco — la candidatura di un altro plesso resta visibile'
    )
  }
  if (!embed[0].inner) {
    return (
      `l’embed che restringe non è il primo (il primo è \`${embed[0].alias}\`, senza \`!inner\`). ` +
      'PostgREST lega il filtro al PRIMO embed della stringa, per posizione: così il filtro ' +
      'finisce sull’embed descrittivo e l’isolamento di sede sparisce senza un errore'
    )
  }
  return null
}

describe('il filtro di sede si lega al PRIMO embed: l’ordine è sorvegliato', () => {
  const src = readFileSync(join(process.cwd(), ROTTA), 'utf8')
  const costanti = costantiStringa(src)
  const trovate = catene(src)

  it('le catene `.select()` della rotta si leggono tutte (se no, questo lock non guarda niente)', () => {
    expect(trovate.length, 'nessuna `.select()` trovata: la regex non regge più il file').toBeGreaterThan(0)
    const conEmbed = trovate.filter(
      (c) => embedSedeDi(risolvi(c.proiezione, costanti, c.riga)).length > 0,
    )
    expect(
      conEmbed.length,
      'nessuna query incorpora `candidature_sedi`: o il filtro di sede è sparito, o non lo si sta più leggendo',
    ).toBeGreaterThan(0)
  })

  for (const c of catene(readFileSync(join(process.cwd(), ROTTA), 'utf8'))) {
    it(`${ROTTA}:${c.riga} — gli embed sono nell’ordine giusto`, () => {
      const risolta = risolvi(c.proiezione, costanti, c.riga)
      const conFiltro = c.seguito.includes(".in('candidature_sedi.scuola_id'")
      expect(guastoDellOrdine(risolta, conFiltro)).toBeNull()
    })
  }
})

describe('CONTROLLO NEGATIVO — l’analizzatore riconosce davvero il difetto', () => {
  const FILTRO = 'candidature_sedi!inner(scuola_id, stato, motivo_rifiuto, evasa_il)'
  const TUTTE = 'sedi:candidature_sedi(scuola_id, stato, evasa_il)'

  it('l’ordine giusto passa', () => {
    expect(guastoDellOrdine(`id, nome, ${FILTRO}, ${TUTTE}`, true)).toBeNull()
  })

  it('🔴 l’ordine INVERTITO viene segnalato', () => {
    const guasto = guastoDellOrdine(`id, nome, ${TUTTE}, ${FILTRO}`, true)
    expect(guasto).toContain('non è il primo')
  })

  it('🔴 due embed SENZA `!inner` vengono segnalati', () => {
    expect(guastoDellOrdine(`id, ${TUTTE}, altre:candidature_sedi(scuola_id)`, true)).toContain('!inner')
  })

  it('🔴 un embed senza il filtro nella stessa catena viene segnalato', () => {
    expect(guastoDellOrdine(`id, ${FILTRO}`, false)).toContain('senza filtrarci sopra')
  })

  it('una query che non incorpora le sedi non riguarda questo lock', () => {
    expect(guastoDellOrdine('id, nome, cognome', false)).toBeNull()
  })
})
