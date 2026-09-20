// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  ALFABETO_CODICE_VOCE,
  LUNGHEZZA_CODICE_VOCE,
  SIGILLO_CODICE_VOCE,
  codiceVoce,
  estraiCodiciVoce,
} from '@/lib/pagamenti/codice-voce'
import { estraiCodiciFiscali } from '@/lib/pagamenti/riconciliazione'

// ─────────────────────────────────────────────────────────────────────────────
// IL CODICE DELLA VOCE — il collaudo del motore.
//
// Il modulo esiste perché la causale del bonifico dice di CHI è il pagamento (il
// codice fiscale del minore) e non DI CHE COSA: su 50 movimenti rossi misurati in
// produzione, 37 hanno più voci aperte con lo stesso identico residuo, perché le
// rette sono tutte uguali. L'importo non discrimina mai; il codice sì.
//
// Qui si collauda il comportamento. Il CONGELAMENTO (vettori d'oro, alfabeto,
// seme, zero import) è ripetuto apposta in
// `__tests__/architecture/codice-voce-congelato.test.ts`: questo file è un file
// di test come gli altri e può essere riscritto da chi cambia il modulo, un lock
// no.
//
// ⚠️ Tutti gli uuid qui dentro sono SINTETICI, scritti a mano o generati da un
// PRNG seminato. Il repository è pubblico e in produzione ci sono dati di minori:
// nessun id di produzione entra in un test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I VETTORI D'ORO: dieci uuid sintetici e i dieci codici che il motore produce
 * OGGI, cablati alla lettera. Non verificano che il codice sia "giusto" — non
 * esiste un giusto per una mescola — ma che sia lo STESSO di ieri: diventano
 * rossi se cambia l'alfabeto, la lunghezza, il seme o la mescola, cioè
 * esattamente nei casi in cui ogni codice già stampato in una causale, in un
 * sollecito spedito o in un bonifico già partito smetterebbe di valere.
 *
 * Se questo test diventa rosso, la domanda NON è «come aggiorno i vettori»: è
 * «sto davvero invalidando tutti i codici in circolazione?». Se la risposta è sì
 * e deliberata, la strada è un `SEME_CODICE_VOCE` a `:v2` che tiene vivo il
 * riconoscimento del `:v1`, non un find&replace qui.
 */
const VETTORI_ORO: Record<string, string> = {
  '00000000-0000-4000-8000-000000000000': '#77XKN2T',
  '00000000-0000-4000-8000-000000000001': '#FT7FC33',
  'ffffffff-ffff-4fff-bfff-ffffffffffff': '#YNMC3VF',
  '11111111-2222-4333-8444-555555555555': '#TK2X43V',
  'deadbeef-dead-4eef-bead-deadbeefdead': '#CT2R6HM',
  'abcdef01-2345-4678-9abc-def012345678': '#3R84FP6',
  'c0ffee00-0000-4000-8000-000000000c0f': '#2924KK7',
  '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d': '#V8N3M9N',
  'feedface-cafe-4bad-9dad-facefeedcafe': '#XH28P22',
  '12345678-1234-4123-8123-123456789abc': '#59TC7MK',
}

/**
 * PRNG SEMINATO (mulberry32). `Math.random()` renderebbe i due test di volume
 * diversi a ogni esecuzione: il primo che fallisse sarebbe irriproducibile, e un
 * test irriproducibile si disattiva invece di correggerlo.
 */
function prng(seme: number): () => number {
  let a = seme >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HEX = '0123456789abcdef'

/** Un uuid v4 di forma corretta da un PRNG seminato: sintetico e riproducibile. */
function uuidFinto(rnd: () => number): string {
  let s = ''
  for (let i = 0; i < 32; i++) {
    if (i === 12) s += '4'
    else if (i === 16) s += HEX[8 + Math.floor(rnd() * 4)]
    else s += HEX[Math.floor(rnd() * 16)]
    if (i === 7 || i === 11 || i === 15 || i === 19) s += '-'
  }
  return s
}

const soloCifre = (c: string) => /^[0-9]+$/.test(c)
const soloLettere = (c: string) => /^[A-Z]+$/.test(c)

describe('codiceVoce — la forma', () => {
  it('è sempre il sigillo più sette simboli dell’alfabeto', () => {
    const forma = new RegExp(`^\\${SIGILLO_CODICE_VOCE}[${ALFABETO_CODICE_VOCE}]{${LUNGHEZZA_CODICE_VOCE}}$`)
    const rnd = prng(424242)
    for (let i = 0; i < 500; i++) {
      const codice = codiceVoce(uuidFinto(rnd))
      expect(codice, `forma inattesa: ${codice}`).toMatch(forma)
      expect(codice.length).toBe(LUNGHEZZA_CODICE_VOCE + SIGILLO_CODICE_VOCE.length)
    }
  })

  it('i dieci VETTORI D’ORO non si muovono', () => {
    for (const [uuid, atteso] of Object.entries(VETTORI_ORO)) {
      expect(
        codiceVoce(uuid),
        `${uuid} cambierebbe codice: ogni codice già in circolazione diventerebbe muto.`,
      ).toBe(atteso)
    }
  })

  it('l’alfabeto non contiene nessuno dei simboli esclusi, e sono venti', () => {
    // Vocali (niente parole italiane, niente parolacce), 0/1 e i loro sosia,
    // i sosia di 8/5/2/6, e la W che si legge VV.
    for (const escluso of ['A', 'E', 'I', 'O', 'U', '0', '1', 'L', 'J', 'Q', 'D', 'B', 'S', 'Z', 'G', 'W']) {
      expect(ALFABETO_CODICE_VOCE.includes(escluso), `l'alfabeto contiene ${escluso}`).toBe(false)
    }
    expect(ALFABETO_CODICE_VOCE.length).toBe(20)
    // Nessun simbolo ripetuto: un duplicato renderebbe due indici lo stesso carattere.
    expect(new Set(ALFABETO_CODICE_VOCE).size).toBe(20)
    expect(ALFABETO_CODICE_VOCE.replace(/[0-9]/g, '').length).toBe(12)
  })

  it('su 10 000 id nessun codice è tutto-lettere né tutto-cifre', () => {
    // È il vincolo che rende sicura l'estrazione della forma NUDA. Se il ciclo dei
    // giri si rompesse, qui si vedrebbe subito — e senza questo controllo si
    // vedrebbe invece un giorno, su un movimento vero, come un falso aggancio.
    const rnd = prng(20260920)
    let vuoti = 0
    for (let i = 0; i < 10_000; i++) {
      const codice = codiceVoce(uuidFinto(rnd)).slice(SIGILLO_CODICE_VOCE.length)
      if (!codice) vuoti++
      expect(soloCifre(codice), `tutto-cifre: ${codice}`).toBe(false)
      expect(soloLettere(codice), `tutto-lettere: ${codice}`).toBe(false)
    }
    expect(vuoti, 'nessun id valido deve restare senza codice').toBe(0)
  })

  it('id vuoto, di soli spazi o non-stringa → stringa vuota, mai un codice malformato', () => {
    expect(codiceVoce('')).toBe('')
    expect(codiceVoce('   ')).toBe('')
    expect(codiceVoce('\t\n ')).toBe('')
    // La firma dice `string`, ma il valore arriva da una riga di database che
    // passa per una rotta: è la difesa gemella di quella su `template` in
    // `renderCausale`. Un `.trim()` su `null` sarebbe un 500 sulla lista
    // pagamenti del genitore.
    expect(codiceVoce(null as unknown as string)).toBe('')
    expect(codiceVoce(undefined as unknown as string)).toBe('')
    expect(codiceVoce(42 as unknown as string)).toBe('')
    expect(codiceVoce({} as unknown as string)).toBe('')
  })

  it('è indifferente a maiuscole e spazi ai bordi', () => {
    for (const uuid of Object.keys(VETTORI_ORO)) {
      expect(codiceVoce(uuid.toUpperCase())).toBe(codiceVoce(uuid))
      expect(codiceVoce(`  ${uuid}  `)).toBe(codiceVoce(uuid))
    }
  })

  it(
    'su 100 000 uuid le collisioni restano quelle che la matematica prevede',
    () => {
      // ─── PERCHÉ NON «ZERO COLLISIONI» ───────────────────────────────────────
      // Lo spazio ammesso è 20^7 meno i tutto-lettere (12^7) e i tutto-cifre
      // (8^7): 1 280 000 000 − 35 831 808 − 2 097 152 = 1 242 071 040.
      // Il paradosso del compleanno su 100 000 estrazioni prevede
      // n·(n−1)/2 / N ≈ 4,03 collisioni ATTESE. Pretendere zero non sarebbe
      // severità: sarebbe un test che pretende un evento da ~1,8% di probabilità,
      // cioè un rosso a caso che il primo cambio di seme farebbe scattare.
      //
      // Qui si congela il numero MISURATO (deterministico: PRNG seminato +
      // funzione pura) e, accanto, si tiene un TETTO derivato dalla stessa
      // formula. Il numero esatto rende rosso qualunque ritocco alla mescola; il
      // tetto sopravvive alla rigenerazione di quel numero e sarebbe l'unica cosa
      // ancora in piedi se un giorno la mescola collassasse lo spazio (una
      // mescola rotta non fa 3 collisioni: ne fa migliaia).
      //
      // Il tetto è 15. «Superarlo» vuol dire 16 collisioni o più, quindi la
      // probabilità è la coda P(X ≥ 16) di una Poisson di media
      // λ = 4 999 950 000 / 1 242 071 040 = 4,0255: vale ~5,3e-6 (~5,4e-6 se si
      // arrotonda λ a 4,03). Per confronto, P(X ≥ 15) — raggiungere il tetto —
      // è ~2,1e-5: l'evento va detto, altrimenti il numero non si ricalcola.
      //
      // Misurato, per non lasciarlo alla teoria: due semi diversi dello stesso
      // PRNG danno 2 e 8 collisioni. Non è un difetto della mescola, è il
      // compleanno — e un test che avesse chiesto «zero» sarebbe stato rosso
      // metà delle volte, cioè disattivato entro la settimana.
      const SPAZIO_AMMESSO = 20 ** 7 - 12 ** 7 - 8 ** 7
      // ⚠️ PROMEMORIA ARITMETICO, NON UNA MISURA DEL MODULO: questa riga verifica
      // l'aritmetica di JavaScript e resta verde qualunque cosa faccia
      // `codice-voce.ts`. Sta qui per un solo motivo: inchiodare il numero citato
      // nel commento qui sopra, perché non lo si possa correggere in un posto solo.
      expect(SPAZIO_AMMESSO).toBe(1_242_071_040)
      const TETTO_COLLISIONI = 15
      const COLLISIONI_MISURATE = 8

      const rnd = prng(773311)
      const visti = new Set<string>()
      let collisioni = 0
      let vuoti = 0
      for (let i = 0; i < 100_000; i++) {
        const codice = codiceVoce(uuidFinto(rnd))
        if (!codice) vuoti++
        if (visti.has(codice)) collisioni++
        visti.add(codice)
      }

      // NB: non si asserisce `visti.size === 100 000 − collisioni`. Sarebbe vero
      // per costruzione — `collisioni` è contato proprio come «quante volte
      // `visti.has(codice)` era già vero» — e un'asserzione che non può fallire
      // gonfia il conteggio delle prove senza aggiungerne una.
      expect(vuoti).toBe(0)
      expect(
        collisioni,
        `collisioni oltre il tetto ${TETTO_COLLISIONI} (attese ~4,03 su ${SPAZIO_AMMESSO} codici): ` +
          'la mescola sta comprimendo lo spazio.',
      ).toBeLessThanOrEqual(TETTO_COLLISIONI)
      expect(
        collisioni,
        'numero congelato: se cambia, è cambiata la mescola — e con lei tutti i codici in circolazione.',
      ).toBe(COLLISIONI_MISURATE)
    },
    20_000,
  )
})

describe('estraiCodiciVoce — cosa si riconosce', () => {
  it('col sigillo, anche in minuscolo', () => {
    expect(estraiCodiciVoce('RETTA SETTEMBRE #K7MXN3P')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('retta settembre #k7mxn3p')).toEqual(['#K7MXN3P'])
  })

  it('le forme che gli export bancari producono spezzando i token', () => {
    expect(estraiCodiciVoce('#K7M XN3P')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('# K7MXN3P')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('##K7MXN3P')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('RETTA # K7MXN3P GRAZIE')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('CAUSALE: #K7M XN3P.')).toEqual(['#K7MXN3P'])
  })

  it('LIMITE DICHIARATO: un codice spezzato e seguito da una parola non si recupera', () => {
    // La variante senza spazi incolla tutto: in «#K7M XN3P GRAZIE» il codice si
    // salda a GRAZIE e il delimitatore finale sparisce. È lo stesso limite della
    // gemella `estraiCodiciFiscali` (dove «RSSMRA 15T10A562S RETTA» non si
    // ricompone), ed è scritto qui perché resti una scelta e non una sorpresa:
    // il canale primario è il copia-incolla, che non produce questo caso.
    expect(estraiCodiciVoce('RETTA #K7M XN3P GRAZIE')).toEqual([])
  })

  it('la forma NUDA, senza sigillo', () => {
    expect(estraiCodiciVoce('RETTA K7MXN3P GRAZIE')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('K7MXN3P')).toEqual(['#K7MXN3P'])
  })

  it('restituisce la forma canonica, distinta, nell’ordine di prima apparizione', () => {
    expect(estraiCodiciVoce('#K7MXN3P e ancora K7MXN3P e #K7MXN3P')).toEqual(['#K7MXN3P'])
    expect(estraiCodiciVoce('PRIMA #V8N3M9N POI #K7MXN3P')).toEqual(['#V8N3M9N', '#K7MXN3P'])
    // L'ordine è quello del TESTO, non quello delle due PASSATE: qui il primo
    // codice è nudo e il secondo ha il sigillo.
    // ⚠️ Attenzione a cosa questo `it` NON prova: tutti i suoi codici si trovano
    // già nella PRIMA variante, quindi l'ordine fra le due VARIANTI qui non viene
    // mai messo alla prova — lo provano i due `it` subito sotto, e servono
    // entrambi.
    expect(estraiCodiciVoce('PRIMA K7MXN3P POI #V8N3M9N')).toEqual(['#K7MXN3P', '#V8N3M9N'])
    expect(estraiCodiciVoce('BONIFICO #K7MXN3P/#V8N3M9N')).toEqual(['#K7MXN3P', '#V8N3M9N'])
  })

  it('l’ordine regge anche quando un codice si recupera SOLO dalla variante senza spazi', () => {
    // ⚠️ È il caso che l'`it` qui sopra NON può vedere, e per cui era verde con e
    // senza la proprietà: tutti i suoi codici si risolvono nella PRIMA variante,
    // quindi l'ordine fra le due varianti non viene mai messo alla prova.
    //
    // Qui il primo codice del testo (`#K7M XN3P`, spezzato dall'export bancario)
    // esiste SOLO nella variante senza spazi, e il secondo (`#V8N3M9N`) esiste già
    // nella prima. Se le due varianti si accodassero invece di fondersi su un solo
    // asse, il codice che nel testo viene PRIMA uscirebbe SECONDO.
    //
    // Non è un caso di laboratorio: è il bonifico composito — che questo repo
    // supporta apposta — letto da un export bancario che spezza i token, cioè
    // esattamente l'incrocio per cui la variante senza spazi esiste.
    expect(estraiCodiciVoce('CAUSALE: #K7M XN3P. POI #V8N3M9N')).toEqual(['#K7MXN3P', '#V8N3M9N'])
    expect(estraiCodiciVoce('#K7M XN3P, E ANCHE #V8N3M9N')).toEqual(['#K7MXN3P', '#V8N3M9N'])
    expect(estraiCodiciVoce('RIF #K7M XN3P / #V8N3M9N')).toEqual(['#K7MXN3P', '#V8N3M9N'])
    // E nell'ordine opposto, perché «primo nel testo» non sia un sinonimo di
    // «trovato nella seconda variante»: qui è il secondo a essere spezzato.
    expect(estraiCodiciVoce('PRIMA #V8N3M9N POI #K7M XN3P.')).toEqual(['#V8N3M9N', '#K7MXN3P'])
  })

  it('l’ordine regge anche quando il riempimento fa divergere i due assi', () => {
    // ⚠️ Questo caso sorveglia una cosa sola, e nessun altro `it` la tocca: la
    // MAPPA delle posizioni che la variante senza spazi si porta dietro.
    //
    // Fondere i candidati delle due varianti non basta, perché i due indici NON
    // sono sullo stesso asse: nella variante compressa ogni carattere è arretrato
    // di quanti spazi lo precedono. Se si ordinasse sugli indici così come sono,
    // i codici trovati nella variante compressa risulterebbero sistematicamente
    // più a sinistra di quanto siano davvero — e scavalcherebbero.
    //
    // Serve del riempimento perché lo scarto superi la distanza fra i due codici:
    // è la forma di un estratto a larghezza fissa, che è poi la stessa sorgente
    // che spezza i token e per cui la variante senza spazi esiste.
    //
    // Qui il primo codice esiste SOLO nella variante piana (nella compressa si
    // salda a «RETTA») e il secondo SOLO nella compressa (nella piana è spezzato).
    // Misurato: `K7MXN3P` sta a 47, il `#` sta a 78 nel testo ma a 34 nella
    // variante compressa — 34 < 47, cioè l'inversione, se la mappa non c'è.
    const ESTRATTO =
      'BONIFICO SEPA' + ' '.repeat(20) + 'CAUSALE RETTA K7MXN3P' + ' '.repeat(20) + 'RIF #V8N 3M9N.'
    expect(ESTRATTO.indexOf('K7MXN3P'), 'il caso ha senso solo se il primo codice viene prima').toBeLessThan(
      ESTRATTO.indexOf('#'),
    )
    expect(estraiCodiciVoce(ESTRATTO)).toEqual(['#K7MXN3P', '#V8N3M9N'])
  })

  it('testo assente, vuoto o non-stringa → nessun codice', () => {
    expect(estraiCodiciVoce('')).toEqual([])
    expect(estraiCodiciVoce('    ')).toEqual([])
    expect(estraiCodiciVoce(null as unknown as string)).toEqual([])
    expect(estraiCodiciVoce(undefined as unknown as string)).toEqual([])
  })
})

describe('estraiCodiciVoce — cosa NON si riconosce', () => {
  it('una finestra da 7 ritagliata dentro un run più lungo', () => {
    // «CK7MXN3P» è tutto alfabeto, ma è incastonato fra lettere: un codice è un
    // token intero, o non è.
    expect(estraiCodiciVoce('ABCK7MXN3PDEF')).toEqual([])
  })

  it('un riferimento di sole cifre — il caso che il vincolo lettera+cifra esiste per respingere', () => {
    // `2345678` è composto per intero di simboli dell'alfabeto: senza quel
    // vincolo sarebbe un codice valido, e ogni numero di disposizione a 7 cifre
    // aggancerebbe una voce a caso.
    expect(estraiCodiciVoce('2345678')).toEqual([])
    expect(estraiCodiciVoce('BONIFICO NR 2345678 DEL 12/09')).toEqual([])
  })

  it('un TRN bancario da 16 caratteri, anche se fatto di soli simboli dell’alfabeto', () => {
    expect(estraiCodiciVoce('TRN CK7MXN3PK7MXN3PC OK')).toEqual([])
    expect(estraiCodiciVoce('RIF 1234567890123456')).toEqual([])
  })

  it('un codice di sole lettere — che è perché l’esempio a schermo può esserlo', () => {
    expect(estraiCodiciVoce('#MNKPRTF')).toEqual([])
    expect(estraiCodiciVoce('MNKPRTF')).toEqual([])
  })

  it('niente correzione degli errori di battitura: un carattere sbagliato non aggancia niente', () => {
    // `A` non è nell'alfabeto. Indovinare che l'utente intendesse `#K7MXN3P`
    // vorrebbe dire incassare su una voce scelta da noi al posto suo.
    expect(estraiCodiciVoce('#K7MXA3P')).toEqual([])
    // Sei caratteri: nemmeno "quasi" esiste.
    expect(estraiCodiciVoce('#K7MXN3')).toEqual([])
  })
})

describe('ANTI-REGRESSIONE: il codice voce non disturba il codice fiscale', () => {
  // Il codice finisce nella STESSA causale che la riconciliazione già legge per
  // agganciare il CF del minore. Se le regex del codice voce e quelle del CF si
  // pestassero i piedi — o se aggiungere il codice cambiasse i delimitatori
  // attorno al CF — si romperebbe l'aggancio più forte che il sistema ha, e si
  // romperebbe in silenzio: un movimento in meno agganciato non è un errore,
  // è solo un rosso in più da smistare a mano.
  const CAUSALI = [
    'RETTA SETTEMBRE - per il minore MARIO ROSSI - RSSMRA15T10A562S - Kidville Giugliano',
    'BONIFICO A FAVORE DI RSSMRA15T10A562S RETTA OTTOBRE',
    // Spezzato dall'export bancario, ma delimitato da punteggiatura: è il caso
    // che la variante senza spazi di `estraiCodiciFiscali` esiste per recuperare.
    'RETTA NOVEMBRE - RSSMRA 15T10A562S.',
    'PAGAMENTO MENSA BNCLCU16M01F839X GRAZIE',
    'RETTA - VRDGPP17A41L219K - Kidville Cesa',
    'SALDO NDRLSS18E05I234M E POMERIDIANO',
  ]

  it('gli stessi CF si estraggono con e senza il codice in coda', () => {
    for (const causale of CAUSALI) {
      const conCodice = `${causale} #K7MXN3P`
      expect(estraiCodiciFiscali(conCodice), causale).toEqual(estraiCodiciFiscali(causale))
      // E il codice si legge lo stesso, senza rubare caratteri al CF.
      expect(estraiCodiciVoce(conCodice), causale).toEqual(['#K7MXN3P'])
    }
  })

  it('vale anche sulla variante senza spazi, che è quella che incolla i token', () => {
    for (const causale of CAUSALI) {
      const conCodice = `${causale} #K7MXN3P`.replace(/\s+/g, '')
      const senza = causale.replace(/\s+/g, '')
      expect(estraiCodiciFiscali(conCodice), causale).toEqual(estraiCodiciFiscali(senza))
    }
  })

  it('la misura vede davvero dei CF (controllo positivo)', () => {
    // Senza questo, un cambio di forma che facesse restituire SEMPRE `[]` a
    // `estraiCodiciFiscali` renderebbe verdi i due test qui sopra: «zero CF» e
    // «gli stessi CF» hanno lo stesso colore.
    for (const causale of CAUSALI) {
      expect(estraiCodiciFiscali(causale).length, causale).toBeGreaterThan(0)
    }
  })
})
