/**
 * T9 · T10 · T11 · T29 — quando due fatti diversi finiscono in UNA riga sola.
 *
 * ─── IL MECCANISMO, prima dei sintomi ────────────────────────────────────────
 *
 * `app_log` deduplica per `(fingerprint, giorno)` e l'`ON CONFLICT` somma le
 * occorrenze SENZA aggiornare il `contesto`: la riga superstite conserva quello
 * della PRIMA occorrenza. E l'impronta si compone dalle sole COLONNE della riga
 * (livello, evento, route, codice, stato_http, utente_id, messaggio, stack): il
 * `contesto` non c'è, ed è documentato — i campi portano contatori che cambiano
 * a ogni richiesta e ucciderebbero la deduplica.
 *
 * Conseguenza misurata dal collaudo:
 *  · T9  — venti tentativi su venti bambini altrui e venti sullo stesso
 *          producono la stessa identica riga, e `contesto.campi.alunno_id`
 *          dichiara UN bambino diverso da quello colpito;
 *  · T10 — due comunicazioni riuscite dello stesso genitore nello stesso giorno
 *          lasciano una riga con `alunno_id`, `presenza_id` e `n_docenti` della
 *          sola PRIMA: il secondo bambino non compare in nessuna riga;
 *  · T11 — tre rifiuti con tre codici diversi collassano in una riga che ne
 *          dichiara uno solo, e la colonna `codice` resta NULL perché il codice
 *          viaggiava solo dentro `campi.error_code`;
 *  · T29 — `riga_creata` non può mai valere `false` una volta che la prima del
 *          giorno è stata una creazione.
 *
 * ─── LA DECISIONE: COSA ENTRA NELL'IMPRONTA ──────────────────────────────────
 *
 * NON il contesto (per la ragione qui sopra: si perderebbe la deduplica, che
 * esiste per non farsi sommergere dalle tempeste del client). Entra un
 * BERSAGLIO dichiarato dal chiamante, campo per campo, con `distingui`: chi
 * scrive la riga sa se quella riga descrive un'ENTITÀ o un fatto aggregato.
 *
 * E il bersaglio passa dalla stessa forma che `redact` usa per lasciare un
 * valore in chiaro — uuid, numeri, booleani, date, enumerati. Un nome, una
 * email, un testo libero NON distinguono: due nomi diversi producono lo stesso
 * bersaglio. Non è una raccomandazione nel commento: è una proprietà del codice,
 * ed è quella che questo file misura.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { rigaEvento } from '@/lib/logging/logger'
import { impronta } from '@/lib/logging/app-log'

const ALUNNO_A = 'cf249c09-f56f-40a7-bcd8-1e1b1db916ab'
const ALUNNO_B = 'f4c61ece-b8fd-421d-ac11-72ee5f389bfb'

const base = {
  sorgente: 'server',
  livello: 'warn',
  evento: 'auth',
  route: '/api/parent/presenze/comunica-assenza',
  utenteId: '710717f0-d5ae-4f6f-889f-60d167b65a3b',
  messaggio: 'alunno-non-della-famiglia',
}

// ─────────────────────────────────────────────────────────────────────────────
describe('il bersaglio dichiarato entra nell’impronta', () => {
  it('due bambini diversi → due impronte diverse (T9)', () => {
    const a = impronta({ ...base, bersaglio: 'alunno_id=' + ALUNNO_A })
    const b = impronta({ ...base, bersaglio: 'alunno_id=' + ALUNNO_B })
    expect(a).not.toBe(b)
  })

  it('lo STESSO bambino → la stessa impronta: la deduplica non si perde', () => {
    const a = impronta({ ...base, bersaglio: 'alunno_id=' + ALUNNO_A })
    const b = impronta({ ...base, bersaglio: 'alunno_id=' + ALUNNO_A })
    expect(a).toBe(b)
  })

  it('senza bersaglio l’impronta è ESATTAMENTE quella di prima (nessuna migrazione di righe)', () => {
    // Se il campo nuovo entrasse comunque nella composizione — anche vuoto —
    // TUTTE le impronte già in tabella cambierebbero, e `group by fingerprint`,
    // che è la query con cui si legge la storia di trenta giorni, si
    // spezzerebbe in due il giorno del deploy.
    //
    // Il valore atteso si ricompone qui con la formula storica: nove parti unite
    // dal separatore NUL — che nel sorgente è invisibile, e per questo va
    // riscritto qui esplicitamente invece di essere copiato a occhio.
    const parti = [
      base.sorgente, base.livello, base.evento, base.route, '', '', base.utenteId, base.messaggio, '',
    ]
    const attesa = createHash('sha256').update(parti.join('\0')).digest('hex')
    expect(impronta({ ...base })).toBe(attesa)
  })

  it('e con il bersaglio l’impronta è quella storica PIÙ una parte, non un’altra formula', () => {
    const parti = [
      base.sorgente, base.livello, base.evento, base.route, '', '', base.utenteId, base.messaggio, '',
      `alunno_id=${ALUNNO_A}`,
    ]
    const attesa = createHash('sha256').update(parti.join('\0')).digest('hex')
    expect(impronta({ ...base, bersaglio: `alunno_id=${ALUNNO_A}` })).toBe(attesa)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('`distingui` — il chiamante dichiara cosa distingue la riga', () => {
  it('compone il bersaglio dai campi nominati, nell’ordine dichiarato', () => {
    const riga = rigaEvento('registro', 'info', {
      operazione: 'parent/presenze/comunica-assenza:POST',
      esito: 'assenza-comunicata',
      alunno_id: ALUNNO_A,
      presenza_id: '7cdcb1c5-d917-4acd-b446-88008e3a9297',
      n_docenti: 2,
    }, undefined, { distingui: ['alunno_id', 'presenza_id'] })
    expect(riga?.bersaglio).toBe(`alunno_id=${ALUNNO_A};presenza_id=7cdcb1c5-d917-4acd-b446-88008e3a9297`)
  })

  it('senza `distingui` non c’è bersaglio (il comportamento storico resta il default)', () => {
    const riga = rigaEvento('registro', 'info', { esito: 'assenza-comunicata', alunno_id: ALUNNO_A })
    expect(riga?.bersaglio).toBeUndefined()
  })

  it('un campo assente non inventa un bersaglio', () => {
    const riga = rigaEvento('auth', 'warn', { tipo: 'x' }, undefined, { distingui: ['alunno_id'] })
    expect(riga?.bersaglio).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('uuid sì, NOMI MAI — e non per raccomandazione', () => {
  it('un nome non distingue: due nomi diversi danno lo STESSO bersaglio', () => {
    const uno = rigaEvento('auth', 'warn', { nome: 'Maria Rossi' }, undefined, { distingui: ['nome'] })
    const due = rigaEvento('auth', 'warn', { nome: 'Luca Bianchi' }, undefined, { distingui: ['nome'] })
    expect(uno?.bersaglio).toBe(due?.bersaglio)
    expect(uno?.bersaglio).not.toContain('Maria')
    expect(uno?.bersaglio).not.toContain('Rossi')
  })

  it('un testo libero (il motivo dell’assenza) non entra mai nel bersaglio', () => {
    const riga = rigaEvento('registro', 'info', { motivo: 'ha la febbre da tre giorni' }, undefined, {
      distingui: ['motivo'],
    })
    expect(riga?.bersaglio ?? '').not.toContain('febbre')
  })

  it('numeri, booleani e enumerati passano (sono i metadati che il repo già logga in chiaro)', () => {
    const riga = rigaEvento('registro', 'warn', {
      error_code: 'ASSENZA_MOTIVO_TROPPO_LUNGO',
      n: 900,
      riga_creata: true,
    }, undefined, { distingui: ['error_code', 'n', 'riga_creata'] })
    expect(riga?.bersaglio).toBe('error_code=ASSENZA_MOTIVO_TROPPO_LUNGO;n=900;riga_creata=true')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T11 — il codice del rifiuto finisce in COLONNA, non solo nel jsonb', () => {
  it('`campi.error_code` popola `codice`, che è nell’impronta', () => {
    const riga = rigaEvento('registro', 'warn', {
      operazione: 'parent/presenze/comunica-assenza:POST',
      error_code: 'ASSENZA_DATA_PASSATA',
      stato: 400,
    })
    expect(
      riga?.codice,
      'senza la colonna, «quanti rifiuti per motivo troppo lungo?» non è interrogabile in SQL',
    ).toBe('ASSENZA_DATA_PASSATA')
  })

  it('tre codici diversi → tre impronte diverse', () => {
    const impronte = ['ASSENZA_DATA_PASSATA', 'ASSENZA_DATA_TROPPO_LONTANA', 'ASSENZA_MOTIVO_TROPPO_LUNGO'].map(
      (codice) => {
        const r = rigaEvento('registro', 'warn', { operazione: 'x:POST', error_code: codice, stato: 400 })!
        return impronta({
          sorgente: 'server',
          livello: r.livello,
          evento: r.evento,
          codice: r.codice,
          statoHttp: r.statoHttp,
          messaggio: r.messaggio,
          bersaglio: r.bersaglio,
        })
      },
    )
    expect(new Set(impronte).size).toBe(3)
  })

  it('l’errore vero VINCE sul campo: `descriviErrore` resta la fonte del codice', () => {
    const riga = rigaEvento('db', 'error', { error_code: 'INVENTATO' }, { code: '42501', message: 'permission denied' })
    expect(riga?.codice).toBe('42501')
  })

  it('`stato` numerico continua ad andare in colonna (nessuna regressione)', () => {
    const riga = rigaEvento('registro', 'warn', { operazione: 'x:POST', error_code: 'X', stato: 400 })
    expect(riga?.statoHttp).toBe(400)
  })
})
