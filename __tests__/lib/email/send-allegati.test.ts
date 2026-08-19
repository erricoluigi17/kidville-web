import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * GLI ALLEGATI E IL «RISPONDI A» DELL'INVIO EMAIL.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ───────────────────────────────────────────────
 * Perché `sendEmailDetailed` è la porta da cui esce OGNI email dell'applicazione
 * — dodici generatori, credenziali comprese — e le due chiavi nuove sono le prime
 * che cambiano la forma del corpo mandato a Resend dal giorno in cui `html` è
 * stato aggiunto. Il rischio non è che gli allegati non funzionino: è che
 * funzionino e intanto aggiungano una chiave al corpo di tutte le ALTRE email,
 * dove nessuno la sta guardando. Il terzo test è lì per questo.
 *
 * ─── LA TRADUZIONE DEL VOCABOLARIO ──────────────────────────────────────────
 * Resend chiama `content_type` ciò che nel resto del progetto si chiama
 * `contentType`. La traduzione avviene dentro `send.ts` e non nei chiamanti,
 * perché il resto dell'applicazione non deve conoscere il vocabolario del
 * provider — il giorno in cui si cambia provider, cambia un file.
 */

const externalFetch = vi.fn()
vi.mock('@/lib/logging/external', () => ({
  externalFetch: (...a: unknown[]) => externalFetch(...a),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logOk: vi.fn(),
  logErrore: vi.fn(),
}))
vi.mock('@/lib/logging/redact', () => ({ hashCorrelabile: () => 'hash-finto' }))

import { sendEmailDetailed } from '@/lib/email/send'

/** Il corpo JSON che `sendEmailDetailed` ha passato a `externalFetch`. */
function corpoInviato(): Record<string, unknown> {
  const opzioni = externalFetch.mock.calls[0][2] as { body: string }
  return JSON.parse(opzioni.body) as Record<string, unknown>
}

describe('sendEmailDetailed · allegati e «rispondi a»', () => {
  beforeEach(() => {
    externalFetch.mockReset()
    externalFetch.mockResolvedValue({
      ok: true,
      stato: 200,
      corpo: '{"id":"msg_1"}',
      res: { json: async () => ({ id: 'msg_1' }) },
    })
    process.env.RESEND_API_KEY = 'chiave-di-prova'
  })
  afterEach(() => {
    delete process.env.RESEND_API_KEY
  })

  it('inoltra gli allegati nella forma che Resend si aspetta, con `content_type`', async () => {
    await sendEmailDetailed({
      to: 'giugliano@kidville.it',
      subject: 'oggetto',
      text: 'corpo',
      attachments: [
        { filename: 'curriculum-rossi-maria.pdf', content: 'JVBERi0=', contentType: 'application/pdf' },
      ],
    })
    expect(corpoInviato().attachments).toEqual([
      { filename: 'curriculum-rossi-maria.pdf', content: 'JVBERi0=', content_type: 'application/pdf' },
    ])
  })

  it('senza `contentType` non inventa un tipo: la chiave semplicemente non c’è', async () => {
    await sendEmailDetailed({
      to: 'a@b.it',
      subject: 'o',
      text: 't',
      attachments: [{ filename: 'cv.pdf', content: 'JVBERi0=' }],
    })
    expect(corpoInviato().attachments).toEqual([{ filename: 'cv.pdf', content: 'JVBERi0=' }])
  })

  it('inoltra `reply_to`, così la sede risponde a chi si è candidato', async () => {
    await sendEmailDetailed({ to: 'a@b.it', subject: 'o', text: 't', replyTo: 'maria.rossi@email.com' })
    expect(corpoInviato().reply_to).toBe('maria.rossi@email.com')
  })

  it('senza allegati e senza «rispondi a» il corpo è IDENTICO a prima: nessuna chiave in più', async () => {
    // È il test che protegge le altre undici email dell'applicazione. Le due
    // chiavi sono additive, e questo è l'unico modo di dimostrarlo invece di
    // dichiararlo.
    await sendEmailDetailed({ to: 'a@b.it', subject: 'o', text: 't' })
    expect(Object.keys(corpoInviato()).sort()).toEqual(['from', 'subject', 'text', 'to'])
  })

  it('un elenco di allegati VUOTO non aggiunge la chiave', async () => {
    // `[]` e «niente» si equivalgono per Resend oggi, ma il contratto di un
    // provider esterno non è una cosa su cui si scommette: si manda ciò che si
    // intende dire.
    await sendEmailDetailed({ to: 'a@b.it', subject: 'o', text: 't', attachments: [] })
    expect(corpoInviato()).not.toHaveProperty('attachments')
  })

  it('gli allegati convivono con l’HTML: la copia alla sede ha entrambi', async () => {
    await sendEmailDetailed({
      to: 'a@b.it',
      subject: 'o',
      text: 't',
      html: '<p>t</p>',
      attachments: [{ filename: 'cv.pdf', content: 'JVBERi0=' }],
      replyTo: 'chi@si.candida',
    })
    const corpo = corpoInviato()
    expect(corpo.html).toBe('<p>t</p>')
    expect(corpo.attachments).toHaveLength(1)
    expect(corpo.reply_to).toBe('chi@si.candida')
  })

  it('senza RESEND_API_KEY non parte niente, allegati o no: il ripiego resta parlante', async () => {
    delete process.env.RESEND_API_KEY
    const esito = await sendEmailDetailed({
      to: 'a@b.it',
      subject: 'o',
      text: 't',
      attachments: [{ filename: 'cv.pdf', content: 'JVBERi0=' }],
    })
    expect(esito.ok).toBe(false)
    expect(esito.error).toContain('RESEND_API_KEY')
    expect(externalFetch).not.toHaveBeenCalled()
  })
})
