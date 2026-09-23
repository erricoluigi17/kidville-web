import { describe, it, expect } from 'vitest'
import {
  vincoloDelRifiuto,
  INDICE_NUMERO_SERIE,
  INDICE_PAGAMENTO_QUOTA,
  VINCOLO_NUMERO_PER_SEDE,
} from '@/lib/fatturazione/vincolo-registro'
import { SEDE_A } from '../../fixtures/sedi'

/** Un errore di PostgREST così come arriva da `await supabase.from(…).insert(…)`. */
function erroreDaMessaggio(nomeVincolo: string) {
  return {
    code: '23505',
    message: `duplicate key value violates unique constraint "${nomeVincolo}"`,
    details: null,
  }
}

describe('vincoloDelRifiuto', () => {
  it('legge i 4 vincoli dal message', () => {
    expect(vincoloDelRifiuto(erroreDaMessaggio(INDICE_PAGAMENTO_QUOTA)))
      .toEqual({ vincolo: 'pagamento-quota', nome: INDICE_PAGAMENTO_QUOTA })
    expect(vincoloDelRifiuto(erroreDaMessaggio(INDICE_NUMERO_SERIE)))
      .toEqual({ vincolo: 'numero-serie', nome: INDICE_NUMERO_SERIE })
    expect(vincoloDelRifiuto(erroreDaMessaggio(VINCOLO_NUMERO_PER_SEDE)))
      .toEqual({ vincolo: 'numero-per-sede', nome: VINCOLO_NUMERO_PER_SEDE })
    expect(vincoloDelRifiuto(erroreDaMessaggio('un_vincolo_mai_visto_prima')))
      .toEqual({ vincolo: 'ignoto', nome: 'un_vincolo_mai_visto_prima' })
  })

  it('legge i 4 vincoli dai details, quando il message non porta il nome', () => {
    expect(vincoloDelRifiuto({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: "Key (pagamento_id, coalesce)=(11111111-1111-1111-1111-111111111111, 00000000-0000-0000-0000-000000000000) already exists.",
    })).toEqual({ vincolo: 'pagamento-quota', nome: null })

    expect(vincoloDelRifiuto({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (sezionale, anno, numero)=(FPR, 2026, 2542) already exists.',
    })).toEqual({ vincolo: 'numero-serie', nome: null })

    expect(vincoloDelRifiuto({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: `Key (scuola_id, anno, numero)=(${SEDE_A}, 2026, 2542) already exists.`,
    })).toEqual({ vincolo: 'numero-per-sede', nome: null })

    expect(vincoloDelRifiuto({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (colonna_mai_vista)=(qualcosa) already exists.',
    })).toEqual({ vincolo: 'ignoto', nome: null })
  })

  it('un codice diverso da 23505 → null', () => {
    expect(vincoloDelRifiuto({
      ...erroreDaMessaggio(VINCOLO_NUMERO_PER_SEDE),
      code: '23503',
    })).toBeNull()
    expect(vincoloDelRifiuto(null)).toBeNull()
    expect(vincoloDelRifiuto(undefined)).toBeNull()
    expect(vincoloDelRifiuto('errore qualsiasi')).toBeNull()
    expect(vincoloDelRifiuto({ code: undefined, message: 'niente codice' })).toBeNull()
  })

  it('legge dai details anche quando il message non porta il nome', () => {
    // Un errore con un `message` che NON contiene la forma `constraint "…"` (qui il
    // DB non l'ha scritta, solo `details`) deve comunque essere riconosciuto tramite
    // `details`.
    const senzaNomeNelMessaggio = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: `Key (sezionale, anno, numero)=(Asilo, 2026, 10) already exists.`,
    }
    const esito = vincoloDelRifiuto(senzaNomeNelMessaggio)
    expect(esito).not.toBeNull()
    expect(esito?.vincolo).toBe('numero-serie')
    expect(esito?.vincolo).not.toBe('ignoto')
  })

  it('CONTROLLO NEGATIVO: una funzione che leggesse SOLO il message perderebbe questo vincolo', () => {
    // Prova che il test sopra misura davvero qualcosa: una variante rotta che, a
    // differenza della funzione vera, ignora `details` e si ferma alla regex sul
    // `message` non riconosce affatto il vincolo — lo classifica `ignoto` invece di
    // `numero-serie`. Se questo test diventasse verde, vorrebbe dire che il lato
    // `details` di `vincoloDelRifiuto` non è più necessario per superare la suite.
    function vincoloDelRifiutoRottoSoloMessage(err: unknown) {
      if (
        typeof err !== 'object' ||
        err === null ||
        !('code' in err) ||
        (err as { code?: unknown }).code !== '23505'
      ) {
        return null
      }
      const message = (err as { message?: unknown }).message
      const match = typeof message === 'string' ? /constraint "([a-z0-9_]+)"/.exec(message) : null
      if (!match) return { vincolo: 'ignoto' as const, nome: null }
      const nome = match[1]
      const vincolo =
        nome === INDICE_PAGAMENTO_QUOTA
          ? ('pagamento-quota' as const)
          : nome === INDICE_NUMERO_SERIE
            ? ('numero-serie' as const)
            : nome === VINCOLO_NUMERO_PER_SEDE
              ? ('numero-per-sede' as const)
              : ('ignoto' as const)
      return { vincolo, nome }
    }

    const senzaNomeNelMessaggio = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: `Key (sezionale, anno, numero)=(Asilo, 2026, 10) already exists.`,
    }

    expect(vincoloDelRifiutoRottoSoloMessage(senzaNomeNelMessaggio)?.vincolo).toBe('ignoto')
    expect(vincoloDelRifiuto(senzaNomeNelMessaggio)?.vincolo).toBe('numero-serie')
  })
})
