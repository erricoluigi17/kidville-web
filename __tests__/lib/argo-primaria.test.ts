import { describe, it, expect } from 'vitest'
import * as argo from '../../scripts/lib/argo.mjs'

/**
 * Codici fiscali INVENTATI (`AAABBB…`, `CCCDDD…`): rispettano la forma dei 16
 * caratteri ma non appartengono a nessuno. Il repo è pubblico.
 */
const CF_PADRE = 'AAABBB80A01H501X'
const CF_MADRE = 'CCCDDD85M41H501Y'
const CF_TERZO = 'EEEFFF60E15F839Z'

/** Una riga dell'export, nei soli campi che contano per il test. */
function riga(over: Record<string, string> = {}) {
  return {
    COD_FISC: 'GGGHHH15A01H501Q', COGNOME: 'Bianchi', NOME: 'Test', DATAN: '01/01/2015',
    SESSO: 'M', COM_NASC: 'NAPOLI', PR_NA: 'NA', CODCOM_NASC: 'F839', CITTAD: 'ITALIANA',
    IND_RES: 'VIA DI PROVA 1', COM_RES: 'GIUGLIANO IN CAMPANIA', PR_RES: 'NA', CAP_RES: '80014',
    DATA_ISCR: '15/09/2025', CL: '3', SEZ: 'A',
    COGNOME_PA: 'Bianchi', NOME_PA: 'Padre', CF_PA: CF_PADRE, DATA_PA: '01/01/1980',
    EMAIL_PA: 'padre@esempio.invalid', CELL_PA: '3330000001', TELEFONO_PA: '',
    COMUNA_PA: 'NAPOLI', PRNA_PA: 'NA', INDRES_PA: 'VIA DI PROVA 1',
    COMURES_PA: 'GIUGLIANO IN CAMPANIA', PRRES_PA: 'NA', CAPRES_PA: '80014',
    COGNOME_MA: 'Verdi', NOME_MA: 'Madre', CF_MA: CF_MADRE, DATA_MA: '01/05/1985',
    EMAIL_MA: 'madre@esempio.invalid', CELL_MA: '3330000002', TELEFONO_MA: '',
    COMUNA_MA: 'NAPOLI', PRNA_MA: 'NA', INDRES_MA: 'VIA DI PROVA 1',
    COMURES_MA: 'GIUGLIANO IN CAMPANIA', PRRES_MA: 'NA', CAPRES_MA: '80014',
    COGNOME_GEN: '', NOME_GEN: '', CF_GEN: '', DATA_GEN: '', EMAIL_GEN: '',
    CELL_GEN: '', TELEFONO_GEN: '', COMUNA_GEN: '', PRNA_GEN: '', INDRES_GEN: '',
    COMURES_GEN: '', PRRES_GEN: '', CAPRES_GEN: '',
    ...over,
  }
}

describe('adultiDaRiga — il terzo posto di Argo non è un terzo adulto', () => {
  /**
   * ⚠️ QUESTO È IL TEST CHE VALE IL FILE. Sull'export reale del 2026-09-01 il
   * terzo posto era valorizzato 81 volte e in 81 casi su 81 ripeteva padre o
   * madre: zero persone nuove. Senza la deduplicazione sarebbero nati 81
   * genitori doppioni in produzione, ognuno collegato al proprio figlio.
   * Togliendo il controllo `visti.has(cf)` in `scripts/lib/argo.mjs`, questo
   * test e i due successivi diventano rossi.
   */
  it('scarta il terzo posto quando ripete il PADRE', () => {
    const a = argo.adultiDaRiga(riga({ CF_GEN: CF_PADRE, COGNOME_GEN: 'Bianchi', NOME_GEN: 'Padre' }))
    expect(a.map((x: { cf: string }) => x.cf)).toEqual([CF_PADRE, CF_MADRE])
    expect(a).toHaveLength(2)
  })

  it('scarta il terzo posto quando ripete la MADRE', () => {
    const a = argo.adultiDaRiga(riga({ CF_GEN: CF_MADRE, COGNOME_GEN: 'Verdi', NOME_GEN: 'Madre' }))
    expect(a).toHaveLength(2)
    expect(a.map((x: { ruolo: string }) => x.ruolo)).toEqual(['father', 'mother'])
  })

  it('lo tiene come «tutore» solo se è davvero una persona diversa', () => {
    const a = argo.adultiDaRiga(riga({ CF_GEN: CF_TERZO, COGNOME_GEN: 'Neri', NOME_GEN: 'Nonna' }))
    expect(a).toHaveLength(3)
    expect(a[2]).toMatchObject({ ruolo: 'tutore', cf: CF_TERZO })
  })

  it('non confonde due CF che differiscono per spazi o minuscole', () => {
    const a = argo.adultiDaRiga(riga({ CF_GEN: ' aaabbb80a01h501x ' }))
    expect(a).toHaveLength(2) // è il padre, scritto male
  })
})

describe('adultiDaRiga — senza chiave non si scrive', () => {
  it('esclude un adulto senza codice fiscale, anche se ha nome ed email', () => {
    const a = argo.adultiDaRiga(riga({ CF_PA: '', COGNOME_PA: 'Bianchi', EMAIL_PA: 'x@esempio.invalid' }))
    expect(a.map((x: { ruolo: string }) => x.ruolo)).toEqual(['mother'])
  })

  it('esclude un codice fiscale di forma sbagliata invece di usarlo', () => {
    expect(argo.adultiDaRiga(riga({ CF_PA: 'AAABBB80A01H501' }))).toHaveLength(1)   // 15 caratteri
    expect(argo.adultiDaRiga(riga({ CF_PA: '1234567890123456' }))).toHaveLength(1)  // tutte cifre
  })

  it('scarta un indirizzo email senza chiocciola invece di salvarlo', () => {
    const a = argo.adultiDaRiga(riga({ EMAIL_PA: 'nonUnIndirizzo' }))
    expect(a[0].email).toEqual([])
    expect(a[1].email).toEqual(['madre@esempio.invalid'])
  })

  it('mette cellulare e telefono insieme, saltando i vuoti', () => {
    const a = argo.adultiDaRiga(riga({ TELEFONO_PA: '0810000001' }))
    expect(a[0].telefoni).toEqual(['3330000001', '0810000001'])
    expect(a[1].telefoni).toEqual(['3330000002'])
  })
})

describe('dataIsoDaItaliana', () => {
  it('converte gg/mm/aaaa in aaaa-mm-gg', () => {
    expect(argo.dataIsoDaItaliana('07/03/2015')).toBe('2015-03-07')
  })

  it('torna null invece di indovinare, su qualunque altra forma', () => {
    for (const v of ['2015-03-07', '7/3/2015', '', '  ', 'ieri', '07-03-2015', null, undefined]) {
      expect(argo.dataIsoDaItaliana(v)).toBeNull()
    }
  })

  it('rifiuta un mese o un giorno impossibili', () => {
    expect(argo.dataIsoDaItaliana('01/13/2015')).toBeNull()
    expect(argo.dataIsoDaItaliana('32/01/2015')).toBeNull()
  })
})

describe('parentelaDaArgo — meglio NULL che inventata', () => {
  const adulti = argo.adultiDaRiga(riga({ CF_GEN: CF_TERZO }))

  it('riconosce padre e madre dal codice fiscale', () => {
    expect(argo.parentelaDaArgo(CF_PADRE, adulti)).toBe('father')
    expect(argo.parentelaDaArgo(' cccddd85m41h501y ', adulti)).toBe('mother')
  })

  it('non attribuisce una parentela al terzo posto', () => {
    expect(argo.parentelaDaArgo(CF_TERZO, adulti)).toBeNull()
  })

  it('torna null quando Argo non conosce quella persona', () => {
    expect(argo.parentelaDaArgo('ZZZWWW70A01H501K', adulti)).toBeNull()
  })
})

describe('legamiDaAggiungere', () => {
  const adulti = argo.adultiDaRiga(riga())

  it('salta chi è già collegato, anche se scritto con spazi o minuscole', () => {
    const r = argo.legamiDaAggiungere(adulti, new Set([' aaabbb80a01h501x ']))
    expect(r.map((x: { cf: string }) => x.cf)).toEqual([CF_MADRE])
  })

  it('non aggiunge niente se ci sono già tutti', () => {
    expect(argo.legamiDaAggiungere(adulti, new Set([CF_PADRE, CF_MADRE]))).toEqual([])
  })

  it('li aggiunge tutti quando il bambino non ha nessuno', () => {
    expect(argo.legamiDaAggiungere(adulti, new Set())).toHaveLength(2)
  })
})

describe('alunnoDaRiga', () => {
  it('legge i campi anagrafici e converte la data di nascita', () => {
    expect(argo.alunnoDaRiga(riga())).toMatchObject({
      cf: 'GGGHHH15A01H501Q', dataNascita: '2015-01-01', sesso: 'M',
      codiceBelfioreNascita: 'F839', cap: '80014', dataIscrizione: '2025-09-15',
    })
  })

  /**
   * La classe di Argo è dell'a.s. 2025/26 e il 2026/27 in Argo è VUOTO:
   * scriverla in Kidville retrocederebbe i bambini di un anno. Il nome del
   * campo lo dice — `classeArgo`, non `classe` — perché un domani nessuno la
   * scambi per la classe corrente.
   */
  it('espone la classe col nome che dichiara da dove viene', () => {
    const a = argo.alunnoDaRiga(riga())
    expect(a.classeArgo).toBe('3')
    expect(a.sezioneArgo).toBe('A')
    expect('classe' in a).toBe(false)
    expect('sezione' in a).toBe(false)
  })
})

describe('chiaveNome — serve a SEPARARE due problemi, non a scrivere', () => {
  it('ignora accenti, spazi e maiuscole', () => {
    expect(argo.chiaveNome(" D'Amico ", 'Marìa Pià')).toBe(argo.chiaveNome('damico', 'MARIAPIA'))
  })
})
