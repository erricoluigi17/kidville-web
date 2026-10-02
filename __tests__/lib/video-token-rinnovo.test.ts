import { describe, it, expect } from 'vitest'

import {
  BYTE_CASUALI_TOKEN_RINNOVO,
  INTESTAZIONE_TOKEN_RINNOVO,
  PREFISSO_TOKEN_RINNOVO,
  schemaTokenRinnovoVideo,
} from '@/lib/media/video/contratto'
import {
  FINESTRA_TETTO_RINNOVO_MS,
  ORE_VALIDITA_TOKEN_RINNOVO,
  TETTO_RINNOVO_PER_IP,
  TETTO_RINNOVO_PER_TOKEN,
  generaTokenRinnovo,
  hashTokenRinnovo,
  hashTokenRinnovoEsadecimale,
  hashTokenRinnovoPerPostgres,
  scadenzaTokenRinnovo,
  tokenCorrispondeAlHash,
  tokenRinnovoDaRichiesta,
} from '@/lib/media/video/token-rinnovo'

/**
 * IL TOKEN DI RINNOVO — la forma, l'hash che si conserva, e l'intestazione da cui si legge.
 *
 * Il token è l'unica cosa che l'app 1.2 tiene per chiedere un nuovo URL di caricamento senza una
 * sessione. Qui si prova ciò che lo rende un segreto vero e non un identificativo: 256 bit casuali
 * (non due token uguali, non una forma prevedibile), un hash che è davvero lo SHA-256 (un vettore
 * noto, non la stessa funzione riletta), un confronto che non lancia sulla lunghezza sbagliata, e
 * una lettura che non restituisce mai il valore quando non passa la forma.
 */

describe('generaTokenRinnovo — la forma del contratto', () => {
  it('rispetta lo schema del contratto: `kvr_` e 43 caratteri base64url, senza padding', () => {
    for (let i = 0; i < 50; i++) {
      const token = generaTokenRinnovo()
      expect(schemaTokenRinnovoVideo.safeParse(token).success, token).toBe(true)
      expect(token.startsWith(PREFISSO_TOKEN_RINNOVO)).toBe(true)
      expect(token).toHaveLength(PREFISSO_TOKEN_RINNOVO.length + 43)
      expect(token).not.toMatch(/[+/=]/)
    }
  })

  it('porta DAVVERO 32 byte: decodificato, il corpo del token ne vale 256 bit', () => {
    const corpo = generaTokenRinnovo().slice(PREFISSO_TOKEN_RINNOVO.length)
    expect(Buffer.from(corpo, 'base64url')).toHaveLength(BYTE_CASUALI_TOKEN_RINNOVO)
    expect(BYTE_CASUALI_TOKEN_RINNOVO).toBe(32)
  })

  it('non si ripete, e non ha una parte fissa oltre al prefisso', () => {
    const insieme = new Set<string>()
    for (let i = 0; i < 2000; i++) insieme.add(generaTokenRinnovo())
    expect(insieme.size).toBe(2000)
    // Il primo carattere del corpo non può essere sempre lo stesso: segnerebbe un valore costante.
    const iniziali = new Set([...insieme].map((t) => t[PREFISSO_TOKEN_RINNOVO.length]))
    expect(iniziali.size).toBeGreaterThan(10)
  })
})

describe('hash del token — ciò che il database conserva', () => {
  it('è lo SHA-256 vero: un vettore noto, non la funzione riletta con sé stessa', () => {
    // SHA-256("abc"), dal documento FIPS 180-4. La funzione non valida la forma del token, quindi
    // un valore qualunque basta a provare l'algoritmo.
    expect(hashTokenRinnovoEsadecimale('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(hashTokenRinnovo('abc').toString('hex')).toBe(hashTokenRinnovoEsadecimale('abc'))
    expect(hashTokenRinnovo('abc')).toHaveLength(32)
  })

  it('per PostgREST è `\\x` più 64 cifre esadecimali minuscole: la forma di un `bytea`', () => {
    const forma = hashTokenRinnovoPerPostgres(generaTokenRinnovo())
    expect(forma).toMatch(/^\\x[0-9a-f]{64}$/)
    expect(hashTokenRinnovoPerPostgres('abc')).toBe(
      '\\xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('l’hash non contiene il token, nemmeno in pezzi riconoscibili', () => {
    const token = generaTokenRinnovo()
    const hash = hashTokenRinnovoPerPostgres(token)
    expect(hash).not.toContain(token)
    expect(hash).not.toContain(token.slice(PREFISSO_TOKEN_RINNOVO.length, PREFISSO_TOKEN_RINNOVO.length + 8))
  })

  it('due token diversi hanno due hash diversi, lo stesso token lo stesso hash', () => {
    const a = generaTokenRinnovo()
    const b = generaTokenRinnovo()
    expect(hashTokenRinnovoEsadecimale(a)).not.toBe(hashTokenRinnovoEsadecimale(b))
    expect(hashTokenRinnovoEsadecimale(a)).toBe(hashTokenRinnovoEsadecimale(a))
  })
})

describe('tokenCorrispondeAlHash — il confronto', () => {
  it('vero con l’hash del token, falso con quello di un altro', () => {
    const token = generaTokenRinnovo()
    const altro = generaTokenRinnovo()
    expect(tokenCorrispondeAlHash(token, hashTokenRinnovo(token))).toBe(true)
    expect(tokenCorrispondeAlHash(token, hashTokenRinnovo(altro))).toBe(false)
  })

  it('un hash di lunghezza sbagliata è falso, e non lancia (`timingSafeEqual` lancerebbe)', () => {
    const token = generaTokenRinnovo()
    expect(() => tokenCorrispondeAlHash(token, new Uint8Array(31))).not.toThrow()
    expect(tokenCorrispondeAlHash(token, new Uint8Array(31))).toBe(false)
    expect(tokenCorrispondeAlHash(token, new Uint8Array(33))).toBe(false)
    expect(tokenCorrispondeAlHash(token, new Uint8Array(0))).toBe(false)
  })

  it('un solo byte diverso nell’hash basta a negarlo', () => {
    const token = generaTokenRinnovo()
    const hash = Uint8Array.from(hashTokenRinnovo(token))
    hash[31] ^= 0x01
    expect(tokenCorrispondeAlHash(token, hash)).toBe(false)
  })
})

describe('scadenza e tetti', () => {
  it('il token vale 48 ore dall’istante dato, esatte', () => {
    expect(ORE_VALIDITA_TOKEN_RINNOVO).toBe(48)
    const adesso = Date.UTC(2026, 9, 2, 12, 0, 0)
    expect(scadenzaTokenRinnovo(adesso).toISOString()).toBe('2026-10-04T12:00:00.000Z')
  })

  it('senza argomento parte da adesso (e non dal passato)', () => {
    const prima = Date.now()
    const scadenza = scadenzaTokenRinnovo().getTime()
    const dopo = Date.now()
    expect(scadenza).toBeGreaterThanOrEqual(prima + 48 * 3_600_000)
    expect(scadenza).toBeLessThanOrEqual(dopo + 48 * 3_600_000)
  })

  it('i tetti di frequenza sono quelli della spec: 30 per IP e 20 per token, ogni 10 minuti', () => {
    expect(TETTO_RINNOVO_PER_IP).toBe(30)
    expect(TETTO_RINNOVO_PER_TOKEN).toBe(20)
    expect(FINESTRA_TETTO_RINNOVO_MS).toBe(600_000)
    // Il tetto per token è il più stretto: chi martella UN token si ferma prima di chi sonda.
    expect(TETTO_RINNOVO_PER_TOKEN).toBeLessThan(TETTO_RINNOVO_PER_IP)
  })
})

describe('tokenRinnovoDaRichiesta — l’intestazione, e solo quella', () => {
  const richiesta = (intestazioni: Record<string, string> = {}, url = 'http://localhost/api/video-uploads/rinnovo') =>
    new Request(url, { method: 'POST', headers: intestazioni })

  it('un token ben formato nell’intestazione si legge', () => {
    const token = generaTokenRinnovo()
    expect(tokenRinnovoDaRichiesta(richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: token }))).toEqual({ esito: 'ok', token })
  })

  it('senza intestazione, o con l’intestazione vuota, è «assente»', () => {
    expect(tokenRinnovoDaRichiesta(richiesta())).toEqual({ esito: 'assente' })
    expect(tokenRinnovoDaRichiesta(richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: '' }))).toEqual({ esito: 'assente' })
  })

  it('un valore fuori forma è «malformato», e il valore NON esce dal risultato', () => {
    const sbagliati = [
      'qualcosa',
      generaTokenRinnovo().slice(1), // senza la k del prefisso
      generaTokenRinnovo().slice(0, -1), // un carattere in meno
      `${generaTokenRinnovo()}x`, // un carattere in più
      `KVR_${generaTokenRinnovo().slice(PREFISSO_TOKEN_RINNOVO.length)}`, // prefisso in maiuscolo
      `${PREFISSO_TOKEN_RINNOVO}${'+'.repeat(43)}`, // alfabeto base64 e non base64url
    ]
    for (const valore of sbagliati) {
      const risposta = tokenRinnovoDaRichiesta(richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: valore }))
      expect(risposta, valore).toEqual({ esito: 'malformato' })
      // Il valore sbagliato non torna indietro in nessuna forma: non c'è modo di rimetterlo in un log per distrazione.
      expect(JSON.stringify(risposta)).not.toContain(valore)
    }
  })

  it('il token nell’URL (query o percorso) NON conta: si legge solo dall’intestazione', () => {
    const token = generaTokenRinnovo()
    expect(tokenRinnovoDaRichiesta(richiesta({}, `http://localhost/api/video-uploads/rinnovo?token=${token}`))).toEqual({
      esito: 'assente',
    })
    expect(tokenRinnovoDaRichiesta(richiesta({}, `http://localhost/api/video-uploads/rinnovo/${token}`))).toEqual({
      esito: 'assente',
    })
  })

  it('l’intestazione è quella del contratto, in minuscolo', () => {
    expect(INTESTAZIONE_TOKEN_RINNOVO).toBe('x-kidville-rinnovo')
    // Le intestazioni HTTP non distinguono le maiuscole: `X-Kidville-Rinnovo` è la stessa.
    const token = generaTokenRinnovo()
    expect(tokenRinnovoDaRichiesta(richiesta({ 'X-Kidville-Rinnovo': token }))).toEqual({ esito: 'ok', token })
  })
})
