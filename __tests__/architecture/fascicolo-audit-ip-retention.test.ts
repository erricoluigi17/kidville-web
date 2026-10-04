import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · GLI IP DEL REGISTRO DEGLI ACCESSI SI CONSERVANO UN ANNO, E LA RIGA RESTA.
 *
 * ─── LA DECISIONE (titolare, 2026-10-04) ────────────────────────────────────
 *
 * `fascicolo_accessi_audit` registra chi apre i dati di un bambino: la scheda
 * anagrafica, i documenti del fascicolo, gli elenchi. Accanto a chi, cosa e quando
 * c'erano due colonne che nessun termine faceva scadere: `ip` (da dove) e
 * `user_agent` (con quale dispositivo). Domanda al titolare: «per quanto si tengono
 * gli IP?». Risposta: «un anno». Da qui `public.fascicolo_audit_ip_retention_tick()`,
 * ogni notte con `pg_cron`.
 *
 * ─── PERCHÉ OGNI PROVA DI QUESTO FILE ───────────────────────────────────────
 *
 *  · `v_mesi = 12` — il termine è UNA decisione, in UN posto. Cambiarlo è una nuova
 *    decisione del titolare, non un ritocco: per questo il numero è scritto qui.
 *  · SI AZZERANO ESATTAMENTE `ip` E `user_agent` — il dispositivo ha la stessa
 *    natura dell'indirizzo (identifica la persona che ha consultato), e coprirne uno
 *    solo lascerebbe il difetto a metà. Ma NIENT'ALTRO: `alunno_id`, `documento_id`,
 *    `utente_id`, `azione`, `finalita` e `creato_il` sono il registro che risponde
 *    alla domanda di una famiglia — «chi ha aperto la scheda di mio figlio?» — e
 *    quella risposta non scade.
 *  · NESSUNA `DELETE` — per la stessa ragione, detta dal lato opposto.
 *  · IL TERMINE SI LEGGE DA `v_mesi` — un `v_mesi` dichiarato e un `interval '6
 *    months'` scritto a mano nel `WHERE` farebbero passare la prova sul numero
 *    mentre il lavoro applica un altro termine: la costante sarebbe decorazione.
 *  · SCHEDULATO OGNI NOTTE — una funzione mai chiamata non conserva niente (è la
 *    forma di `obliaFotoNewsAlunno`, testata per mesi senza un chiamante); e
 *    giornaliero perché un lavoro mensile non è sorvegliabile da `/api/health`
 *    (`app_log` conserva 30 giorni: vedi `JOB_CRON_NON_SORVEGLIATI`).
 *  · IL BATTITO HA IL SUO NOME E NESSUN DATO PERSONALE — `cron:<job>` è l'impronta
 *    con cui `/api/health` lo riconosce come lavoro SQL; e un battito è un log, che
 *    porta conteggi e mai l'IP che il lavoro esiste per togliere.
 *
 * La FORMA del battito (`evento = 'cron'`, contesto annidato sotto `campi`,
 * `esito = 'ok'`, `operazione = <job>`) la sorveglia già
 * `informativa-conservazione-dichiarata.test.ts` (`BATTITI_DA_LEGGERE`), insieme al
 * fatto che il job sia in `JOB_CRON` o dichiarato fuori con la ragione: qui non si
 * ripete.
 *
 * ⚠️ IL SQL SI LEGGE SENZA COMMENTI. La testata della migrazione spiega, in prosa,
 * che si scrive `user_agent = NULL`: un lock che leggesse il file come testo
 * troverebbe la frase nel commento e resterebbe verde con il codice sbagliato —
 * un lock che si immunizza da solo.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

const FUNZIONE = 'fascicolo_audit_ip_retention_tick'
const JOB = 'fascicolo-audit-ip-retention'
const TABELLA = 'fascicolo_accessi_audit'

/** Decisione del titolare del 2026-10-04: «un anno». */
const MESI_DECISI = 12

/** Le sole colonne che scadono: l'indirizzo e il dispositivo di chi ha consultato. */
const COLONNE_CHE_SCADONO = ['ip', 'user_agent'] as const

/** Il SQL senza commenti `--` e `/* … *\/`. Vedi la testata: un lock non legge la prosa. */
function senzaCommenti(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

const SQL = readdirSync(MIGRAZIONI)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: senzaCommenti(readFileSync(join(MIGRAZIONI, file), 'utf8')) }))

const RE_DEFINIZIONE = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${FUNZIONE}\\s*\\(`, 'i')

/** L'ULTIMA migrazione che (ri)definisce la funzione: è quella che vale. */
const definizione = [...SQL].reverse().find(({ sql }) => RE_DEFINIZIONE.test(sql))

/** Il corpo della funzione: fra il primo `$$` dopo il `CREATE` e il successivo. */
function corpoDellaFunzione(sql: string): string {
  const inizio = sql.search(RE_DEFINIZIONE)
  const apertura = sql.indexOf('$$', inizio)
  const chiusura = sql.indexOf('$$', apertura + 2)
  return apertura === -1 || chiusura === -1 ? '' : sql.slice(apertura + 2, chiusura)
}

const corpo = definizione ? corpoDellaFunzione(definizione.sql) : ''

/** L'`UPDATE` sulla tabella del registro, fino al suo `;`. */
const update = corpo.match(new RegExp(`UPDATE\\s+public\\.${TABELLA}\\b[\\s\\S]*?;`, 'i'))?.[0] ?? ''

/** Le assegnazioni della clausola `SET`, come `[colonna, espressione]`. */
const assegnazioni: [string, string][] = (() => {
  const set = update.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)?.[1] ?? ''
  return set
    .split(',')
    .map((pezzo) => pezzo.trim())
    .filter(Boolean)
    .map((pezzo) => {
      const [colonna, ...resto] = pezzo.split('=')
      return [colonna.trim().toLowerCase(), resto.join('=').trim()] as [string, string]
    })
})()

/** Le migrazioni che installano il job con QUEL nome (`cron.schedule('<job>', …)`). */
const installazioni = SQL.filter(({ sql }) => new RegExp(`cron\\.schedule\\s*\\(\\s*'${JOB}'`, 'i').test(sql))

describe('lock · gli IP del registro degli accessi scadono a un anno, e la riga resta', () => {
  it('una migrazione definisce il lavoro di scadenza, e il suo UPDATE si legge (sanity)', () => {
    // Se questa cade, tutte le prove qui sotto girerebbero sul vuoto.
    expect(
      definizione,
      `Nessuna migrazione definisce \`public.${FUNZIONE}()\`. Il titolare ha deciso il 2026-10-04 ` +
        `che l'IP di chi consulta i dati dei bambini si conserva UN ANNO: senza questa funzione ` +
        `la decisione non è applicata da niente.`,
    ).toBeTruthy()
    expect(
      update,
      `\`${FUNZIONE}\` non contiene un \`UPDATE public.${TABELLA} … ;\`: il lavoro non tocca il ` +
        `registro degli accessi, o lo tocca in una forma che questo lock non sa leggere.`,
    ).not.toBe('')
    expect(assegnazioni.length, `l'UPDATE di \`${FUNZIONE}\` non ha una clausola SET … WHERE leggibile`).toBeGreaterThan(0)
  })

  it('il termine è UN numero, in un posto solo, ed è quello deciso dal titolare', () => {
    const m = corpo.match(/v_mesi\s+constant\s+int\s*:=\s*(\d+)/i)
    expect(
      m,
      `\`${FUNZIONE}\` non dichiara \`v_mesi constant int := N\`: il termine deve essere UN numero, ` +
        `in un punto solo, leggibile da qui.`,
    ).not.toBeNull()
    expect(
      Number(m![1]),
      `\`${FUNZIONE}\` conserva gli IP per ${m![1]} mesi; il titolare ha deciso ${MESI_DECISI} ` +
        `(«un anno», 2026-10-04). Un termine diverso è una NUOVA decisione del titolare: si chiede, ` +
        `poi si cambiano insieme la migrazione e questo numero.`,
    ).toBe(MESI_DECISI)
  })

  it('azzera l’indirizzo E il dispositivo', () => {
    for (const colonna of COLONNE_CHE_SCADONO) {
      const assegnazione = assegnazioni.find(([c]) => c === colonna)
      expect(
        assegnazione !== undefined && /^NULL$/i.test(assegnazione[1]),
        `L'UPDATE di \`${FUNZIONE}\` non scrive \`${colonna} = NULL\`. L'indirizzo (\`ip\`) e il ` +
          `dispositivo (\`user_agent\`) hanno la stessa natura — identificano chi ha consultato — e ` +
          `scadono insieme: coprirne uno solo lascia il difetto a metà.`,
      ).toBe(true)
    }
  })

  it('e NIENT’ALTRO: la riga resta, è il registro di chi ha aperto i dati del bambino', () => {
    const altre = assegnazioni.map(([c]) => c).filter((c) => !(COLONNE_CHE_SCADONO as readonly string[]).includes(c))
    expect(
      altre,
      `L'UPDATE di \`${FUNZIONE}\` tocca anche ${altre.map((c) => `\`${c}\``).join(', ')}. ` +
        `Scadono SOLO \`ip\` e \`user_agent\`: chi, quale bambino, quale documento, quale azione e ` +
        `quando sono la risposta a «chi ha aperto la scheda di mio figlio?», e quella non scade.`,
    ).toEqual([])
    const cancella = new RegExp(`(?:DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?(?:public\\.)?${TABELLA}\\b`, 'i')
    expect(
      cancella.test(definizione!.sql),
      `${definizione!.file} CANCELLA righe di \`${TABELLA}\`. La decisione del titolare fa scadere ` +
        `l'IP, non il registro: la riga resta.`,
    ).toBe(false)
  })

  it('il WHERE legge il termine da `v_mesi`, sulla data della riga', () => {
    const where = update.match(/\bWHERE\b([\s\S]*);/i)?.[1] ?? ''
    expect(
      /(?:\w+\.)?creato_il\s*<\s*now\(\)\s*-\s*make_interval\(\s*months\s*=>\s*v_mesi\s*\)/i.test(where),
      `Il WHERE di \`${FUNZIONE}\` non è \`creato_il < now() - make_interval(months => v_mesi)\`. ` +
        `Un termine riscritto a mano accanto a \`v_mesi\` fa passare la prova sul numero mentre il ` +
        `lavoro ne applica un altro: due copie dello stesso termine sono il modo in cui divergono.`,
    ).toBe(true)
  })

  it('il battito porta il nome del job, e nessun dato personale', () => {
    expect(
      corpo.includes(`'cron:${JOB}'`),
      `\`${FUNZIONE}\` non scrive il battito con l'impronta \`'cron:${JOB}'\`: è il segno con cui ` +
        `/api/health riconosce un lavoro di sola SQL (\`health.test.ts\`, «i job sorvegliati ` +
        `esistono davvero»), e senza quel nome il lavoro non si può sorvegliare.`,
    ).toBe(true)
    const insert = corpo.match(/INSERT\s+INTO\s+public\.app_log\b[\s\S]*?;/i)?.[0] ?? ''
    expect(insert, `\`${FUNZIONE}\` non scrive nessuna riga in \`app_log\`: un lavoro che cancella dati deve dire anche quando non cancella niente`).not.toBe('')
    // Si cercano i RIFERIMENTI alle colonne, quindi fuori dalle stringhe: il nome del job
    // (`'…-audit-ip-retention'`) contiene «ip», ed è un'etichetta, non un valore letto dalla riga.
    const fuoriDalleStringhe = insert.replace(/'(?:[^']|'')*'/g, "''")
    const personali = fuoriDalleStringhe.match(/\b(?:ip|user_agent|alunno_id|utente_id|documento_id|finalita)\b/gi) ?? []
    expect(
      personali,
      `Il battito di \`${FUNZIONE}\` nomina ${personali.join(', ')}: un battito è un log, porta ` +
        `conteggi e mesi. L'IP che il lavoro esiste per togliere non può finire in \`app_log\`.`,
    ).toEqual([])
  })

  it('è SCHEDULATO ogni notte, e chiama proprio questa funzione', () => {
    expect(
      installazioni.length,
      `Nessun \`cron.schedule('${JOB}', …)\` in supabase/migrations/. La funzione esisterebbe e non ` +
        `girerebbe mai: scritta, testata e senza chiamante.`,
    ).toBeGreaterThan(0)
    // L'ULTIMA che lo installa è quella che vale: `cron.schedule` con lo stesso nome rischedula.
    const ultima = installazioni[installazioni.length - 1]
    const chiamata = ultima.sql.match(
      new RegExp(`cron\\.schedule\\s*\\(\\s*'${JOB}'\\s*,\\s*'([^']+)'\\s*,\\s*\\$(\\w*)\\$([\\s\\S]*?)\\$\\2\\$`, 'i'),
    )
    expect(chiamata, `non si legge il \`cron.schedule('${JOB}', '<cadenza>', $…$ <comando> $…$)\` in ${ultima.file}`).not.toBeNull()
    const [, cadenza, , comando] = chiamata!
    expect(
      new RegExp(`public\\.${FUNZIONE}\\s*\\(\\s*\\)`, 'i').test(comando),
      `Il job \`${JOB}\` in ${ultima.file} non chiama \`public.${FUNZIONE}()\` ma «${comando.trim()}».`,
    ).toBe(true)
    const [, , giornoDelMese, mese, giornoDellaSettimana] = cadenza.trim().split(/\s+/)
    expect(
      [giornoDelMese, mese, giornoDellaSettimana],
      `La cadenza «${cadenza}» di \`${JOB}\` non è giornaliera. La sorveglianza di /api/health ` +
        `presuppone una finestra di 26 h, e un lavoro mensile non è sorvegliabile da lì: \`app_log\` ` +
        `conserva 30 giorni e il battito sparirebbe prima del successivo.`,
    ).toEqual(['*', '*', '*'])
  })
})
