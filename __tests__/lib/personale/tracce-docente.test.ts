import { describe, it, expect } from 'vitest'

// Le regole PURE della decisione «questo docente si cancella o si archivia?», più
// l'integrità del registro delle 56 chiavi esterne verso `utenti(id)`.
//
// ⚠️ PROVA PER ROTTURA — eseguita il 2026-09-20, una mutazione alla volta su un
// file ripristinato da copia pulita. I numeri sono misurati, non previsti: la
// prima stesura di questo commento diceva 2/1/3/1 e sbagliava tre valori su
// quattro, che è esattamente il motivo per cui le mutazioni si ESEGUONO.
//   • invertito l'ordine delle domande in `decisioneEliminazione` (ponte prima
//     delle tracce)                                        → 1 test rosso
//   • sostituito `v.ce === null` con `v.n === null`         → 1 test rosso
//   • tolta la voce `chat_messages` da TRACCE_DOCENTE       → 4 test rossi
//   • reso `pesa: true` su `pratiche_personale.utente_id`   → 3 test rossi
//
// La prima mutazione ne rende rosso UNO SOLO, ed è giusto così: con zero tracce
// i due ordini danno lo stesso esito, e solo il test dedicato — «una maestra con
// un figlio iscritto si ARCHIVIA» — li distingue. Se quel test sparisse, la
// regola tornerebbe indifesa senza che nient'altro se ne accorga.

import {
  TRACCE_DOCENTE,
  VOCI_CHE_PESANO,
  decisioneEliminazione,
} from '@/lib/personale/tracce-docente-voci'
import type { ConteggioVoce, EsitoTracce } from '@/lib/personale/tracce-docente-voci'

/** Una voce letta con esito noto. Il default è «letta, e non c'è niente». */
function voce(tabella: string, colonna: string, n: number | null = 0): ConteggioVoce {
  return { tabella, colonna, ce: n === null ? null : n > 0, n }
}

/** Tutte le voci che pesano, tutte a zero: il docente appena creato. */
function pulito(): ConteggioVoce[] {
  return VOCI_CHE_PESANO.map((v) => voce(v.tabella, v.colonna, 0))
}

function esito(voci: ConteggioVoce[], ponteGenitore: boolean | null): EsitoTracce {
  return { voci, ponteGenitore }
}

describe('decisioneEliminazione — i quattro esiti', () => {
  it('zero tracce e nessun ponte → cancella', () => {
    expect(decisioneEliminazione(esito(pulito(), false)).decisione).toBe('cancella')
  })

  it('UN SOLO messaggio di chat → archivia, e il motivo è quella voce', () => {
    // `chat_messages.sender_id` è `ON DELETE CASCADE`: la cancellazione
    // RIUSCIREBBE, portandosi via la conversazione con una famiglia. È la voce
    // per cui il registro distingue «cascade» da «non conta».
    const voci = pulito().map((v) =>
      v.tabella === 'chat_messages' ? voce('chat_messages', 'sender_id', 1) : v,
    )
    const verdetto = decisioneEliminazione(esito(voci, false))
    expect(verdetto.decisione).toBe('archivia')
    expect(verdetto.motivi).toHaveLength(1)
    expect(verdetto.motivi[0]).toMatchObject({ tabella: 'chat_messages', n: 1 })
  })

  it('ponte genitore e zero tracce → profilo-doppio, senza motivi', () => {
    const verdetto = decisioneEliminazione(esito(pulito(), true))
    expect(verdetto.decisione).toBe('profilo-doppio')
    expect(verdetto.motivi).toEqual([])
  })

  it('una sonda fallita → non-deciso, e dice QUALE', () => {
    const voci = pulito().map((v) =>
      v.tabella === 'eventi_diario' ? voce('eventi_diario', 'maestra_id', null) : v,
    )
    const verdetto = decisioneEliminazione(esito(voci, false))
    expect(verdetto.decisione).toBe('non-deciso')
    expect(verdetto.motivi).toHaveLength(1)
    expect(verdetto.motivi[0].tabella).toBe('eventi_diario')
  })

  it('ponte genitore non letto → non-deciso, anche con tutte le sonde a posto', () => {
    expect(decisioneEliminazione(esito(pulito(), null)).decisione).toBe('non-deciso')
  })
})

describe('decisioneEliminazione — le due regole che si sbagliano', () => {
  it('LE TRACCE VENGONO PRIMA DEL PONTE: una maestra con un figlio iscritto si ARCHIVIA', () => {
    // Il difetto misurato il 2026-09-20: mettendo il ponte per primo, tutti e 12
    // i docenti-genitori di produzione diventavano `profilo-doppio` — compresi i
    // nove che insegnano davvero, ai quali veniva negata anche l'archiviazione.
    // Archiviare è sicuro su di loro: revoca il profilo di `utenti.ruolo`, non
    // l'accesso della persona, e la mamma continua a vedere il diario del figlio.
    const voci = pulito().map((v) =>
      v.tabella === 'eventi_diario' ? voce('eventi_diario', 'maestra_id', 412) : v,
    )
    const verdetto = decisioneEliminazione(esito(voci, true))
    expect(verdetto.decisione).toBe('archivia')
    expect(verdetto.motivi[0].n).toBe(412)
  })

  it('traccia accertata ma conteggio mancato → archivia lo stesso, senza il numero', () => {
    // «So che c'è, non sono riuscito a contarla» non è «non so niente»: la
    // decisione c'è già, manca solo il numero da mostrare.
    const voci = pulito().map((v) =>
      v.tabella === 'presenze' && v.colonna === 'registrato_da'
        ? { tabella: 'presenze', colonna: 'registrato_da', ce: true, n: null }
        : v,
    )
    const verdetto = decisioneEliminazione(esito(voci, false))
    expect(verdetto.decisione).toBe('archivia')
    expect(verdetto.motivi[0].n).toBeNull()
  })
})

describe('TRACCE_DOCENTE — integrità del registro', () => {
  it('copre tutte e 56 le chiavi esterne verso utenti(id), senza doppioni', () => {
    // 56 misurate da `pg_constraint` il 2026-09-20. Il numero sta qui e non solo
    // nel commento perché una FK nuova deve rendere rosso qualcosa.
    expect(TRACCE_DOCENTE).toHaveLength(56)
    const chiavi = TRACCE_DOCENTE.map((v) => `${v.tabella}.${v.colonna}`)
    expect(new Set(chiavi).size).toBe(chiavi.length)
  })

  it('44 voci pesano, e ognuna porta la chiave con cui la si racconta', () => {
    expect(VOCI_CHE_PESANO).toHaveLength(44)
    for (const v of VOCI_CHE_PESANO) {
      expect(v.chiave, `${v.tabella}.${v.colonna} pesa ma non ha chiave`).toBeTruthy()
      expect(v.perche, `${v.tabella}.${v.colonna} pesa e non deve motivare`).toBeUndefined()
    }
  })

  it('ogni voce che NON pesa motiva perché, e non ha chiave', () => {
    // «Non conta» è un'affermazione, non un valore di default: va scritta.
    const leggere = TRACCE_DOCENTE.filter((v) => !v.pesa)
    expect(leggere).toHaveLength(12)
    for (const v of leggere) {
      expect(v.perche, `${v.tabella}.${v.colonna} non pesa senza dire perché`).toBeTruthy()
      expect(v.chiave).toBeUndefined()
    }
  })

  it("la pratica d'origine NON pesa: contarla renderebbe indelebili 67 docenti su 80", () => {
    const p = TRACCE_DOCENTE.find(
      (v) => v.tabella === 'pratiche_personale' && v.colonna === 'utente_id',
    )
    expect(p?.pesa).toBe(false)
    // Ma la pratica evasa PER QUALCUN ALTRO è lavoro fatto, e pesa.
    const evasa = TRACCE_DOCENTE.find(
      (v) => v.tabella === 'pratiche_personale' && v.colonna === 'evasa_da',
    )
    expect(evasa?.pesa).toBe(true)
  })

  it('le voci cascade che distruggono conversazioni e foto PESANO', () => {
    // La trappola: `cascade` non dà errore. La DELETE riesce e porta via.
    for (const [t, c] of [
      ['chat_messages', 'sender_id'],
      ['chat_threads', 'teacher_id'],
      ['avvisi', 'author_id'],
      ['galleria_media_v2', 'uploaded_by'],
    ] as const) {
      const v = TRACCE_DOCENTE.find((x) => x.tabella === t && x.colonna === c)
      expect(v?.azioneFk, `${t}.${c}`).toBe('cascade')
      expect(v?.pesa, `${t}.${c} è cascade e deve pesare`).toBe(true)
    }
  })

  it('nessuna chiave i18n duplicata fra le voci che pesano', () => {
    const chiavi = VOCI_CHE_PESANO.map((v) => v.chiave)
    expect(new Set(chiavi).size).toBe(chiavi.length)
  })
})
