import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '@/lib/logging/redact'

/**
 * LOCK — L'INFORMATIVA NON PROMETTE UN OSCURAMENTO CHE IL CODICE NON FA.
 *
 * ─── IL FATTO (rilievo Q2, quarto collaudo) ─────────────────────────────────
 *
 * La sezione «Misure di sicurezza» prometteva, in forma ASSOLUTA, che i registri tecnici
 * «non contengono nomi, recapiti, contenuti dei messaggi né informazioni sulla salute».
 * Misurato in `app_log` — 30 giorni, interrogabile in SQL, leggibile dalla console di
 * Direzione — con la sola sessione di un genitore TEST:
 *
 *   {"tipo":"AAABBB99C99D999E","esito":"diagnosi-inventata-per-collaudo",
 *    "stato":"XXXXXX00X00X000X-SINTETICO"}   → tutti e tre IN CHIARO
 *
 * più una riga preesistente, non del collaudo: `"sezione": "RSSMRA80A01H501U"`, un codice
 * fiscale in chiaro dentro `campi` e dentro `payload.query`.
 *
 * ─── PERCHÉ IL DIFETTO NON ERA (SOLO) IL CODICE ─────────────────────────────
 *
 * Perché la redazione è, e resta, un meccanismo BEST-EFFORT a lista bianca: il modulo lo
 * dichiara nella sua stessa testata («un token senza spazi e più corto di 64 caratteri passa
 * ancora»). Una promessa categorica su un meccanismo best-effort non è un'imprecisione
 * tecnica: è una dichiarazione dell'art. 13 GDPR che nessuno può mantenere, scritta a 60 righe
 * di distanza dalla voce sui dodici mesi che lo stesso ciclo aveva appena aggiunto.
 *
 * ─── COSA SORVEGLIA QUESTO FILE ─────────────────────────────────────────────
 *
 * Due cose, e nessuna delle due è la tipografia della frase:
 *  1. che l'informativa DESCRIVA il meccanismo invece di garantire un risultato assoluto;
 *  2. che ogni categoria che dichiara oscurata sia oscurata DAVVERO — provandolo su
 *     `redact()`, non leggendo il sorgente. Se domani qualcuno togliesse `RADICI_TESTO_LIBERO`
 *     o `DA_HASHARE`, la frase resterebbe scritta e questo lock diventerebbe rosso.
 */

const RADICE = process.cwd()
const informativa = readFileSync(join(RADICE, 'src/app/privacy/page.tsx'), 'utf8')

/** La sezione «Misure di sicurezza», dal titolo al suo `</section>`. */
const SEZIONE = (() => {
  const dal = informativa.indexOf('Misure di sicurezza')
  const al = informativa.indexOf('</section>', dal)
  return informativa.slice(dal, al === -1 ? undefined : al).replace(/\s+/g, ' ')
})()

/**
 * Le formule con cui si promette un ASSOLUTO su una categoria di dati: «non contengono …
 * salute», «mai … dati sanitari», «nessun … nome». Non si sorveglia la parola «salute» (che
 * l'informativa DEVE poter nominare): si sorveglia la promessa categorica attorno a essa.
 */
const PROMESSA_ASSOLUTA =
  /(?:non\s+conten\w+|non\s+registr\w+|mai|nessun\w*)[^.;]{0,160}(?:salute|sanitari\w*|diagnos\w*)/i

describe('lock · l’informativa descrive l’oscuramento dei registri tecnici, non lo garantisce', () => {
  it('la sezione «Misure di sicurezza» si legge (sanity)', () => {
    // Senza questa, tutte le prove qui sotto girerebbero sul vuoto e direbbero «verde».
    expect(
      SEZIONE.length,
      'la sezione «Misure di sicurezza» non si trova più in src/app/privacy/page.tsx: questo ' +
        'lock non sta più leggendo l’informativa.',
    ).toBeGreaterThan(200)
    expect(/registri tecnici/i.test(SEZIONE)).toBe(true)
  })

  it('non promette in forma ASSOLUTA che i log non contengano dati sanitari', () => {
    expect(
      PROMESSA_ASSOLUTA.test(SEZIONE),
      'La sezione «Misure di sicurezza» promette in forma categorica che i registri tecnici non ' +
        'contengono informazioni sulla salute. La redazione di `src/lib/logging/redact.ts` è un ' +
        'meccanismo a lista bianca e best-effort — il modulo dichiara esso stesso il residuo — ' +
        'quindi quella frase è una dichiarazione GDPR (art. 13) che il codice non è in grado di ' +
        'mantenere. Va scritta al DESCRITTIVO: cosa il meccanismo fa, non cosa garantisce.\n' +
        `Testo attuale: «${SEZIONE.slice(0, 400)}…»`,
    ).toBe(false)
  })

  it('e ciò che dichiara di oscurare, lo oscura davvero (provato su redact)', () => {
    // Il salt è fail-closed: senza, `hashCorrelabile` redige e basta. Qui va impostato,
    // altrimenti la prova sull'hash sarebbe verde per la ragione sbagliata.
    const prima = process.env.LOG_HASH_SALT
    process.env.LOG_HASH_SALT = 'salt-di-prova'
    try {
      const out = redact({
        nome: 'NomeDiProva',
        email: 'indirizzo@example.test',
        codice_fiscale: 'AAABBB99C99D999E',
        motivo: 'sintomo scritto dalla famiglia',
        note_appello: 'nota scritta dalla maestra',
        corpo: 'testo di una notifica',
      }) as Record<string, unknown>

      // Identità: sostituita da un codice non reversibile — non cancellata (serve a correlare).
      for (const chiave of ['nome', 'email', 'codice_fiscale']) {
        expect(
          String(out[chiave]).startsWith('#'),
          `L'informativa dichiara che i dati identificativi sono sostituiti da un codice non ` +
            `reversibile, e "${chiave}" non lo è più: controlla \`DA_HASHARE\` in redact.ts.`,
        ).toBe(true)
      }

      // Testo libero: rimosso, di qualunque forma sia (è la regola di Q19).
      const json = JSON.stringify(out)
      for (const parola of ['sintomo', 'maestra', 'notifica']) {
        expect(
          json.includes(parola),
          `L'informativa dichiara che i testi liberi sono rimossi prima della scrittura, e "` +
            `${parola}" è arrivato in chiaro: controlla \`RADICI_TESTO_LIBERO\` in redact.ts.`,
        ).toBe(false)
      }
    } finally {
      if (prima === undefined) delete process.env.LOG_HASH_SALT
      else process.env.LOG_HASH_SALT = prima
    }
  })

  it('e ciò che dichiara di lasciare in chiaro resta in chiaro (il log deve restare un log)', () => {
    // La frase promette anche il contrario — «passano in chiaro identificativi tecnici, date e
    // conteggi» — ed è la metà che rende `app_log` interrogabile. Una difesa che spegne il log
    // non è una difesa: è un log in meno e un incidente in più che nessuno vedrà.
    const out = redact({
      alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      creato_il: '2026-08-08T04:59:00.000Z',
      n_righe: 42,
      stato: 403,
    }) as Record<string, unknown>
    expect(out).toMatchObject({
      alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      creato_il: '2026-08-08T04:59:00.000Z',
      n_righe: 42,
      stato: 403,
    })
  })
})
