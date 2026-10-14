// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getDocumentProxy } from 'unpdf'
import { elementiTesto } from '../fixtures/misure-pdf'

async function build(long = false) {
  const pending = import('@/lib/forms/authorization-summary-pdf')
  await expect(pending).resolves.toBeDefined()
  return (await pending).buildAuthorizationSummaryPdf({
    form: { title: long ? 'Titolo molto lungo '.repeat(30) : 'Uscita al museo', description: long ? Array.from({ length: 55 }, (_, n) => `Descrizione integrale ${n + 1}: uscita e attività con autorizzazione.`).join('\n') : 'Autorizzazione alla visita.', fields: [] },
    class_name: 'PRIMAVERA A', generated_at: '2026-10-14T08:30:00Z',
    results: Array.from({ length: long ? 86 : 2 }, (_, i) => ({
      student_id: `s-${i}`, nome_alunno: 'Bambino', cognome_alunno: i === 0 ? 'Zeta' : `Alfa ${String(i).padStart(3, '0')}`,
      autorizzato: i % 2 === 0, signed: i % 2 === 0, stato_autorizzazione: i % 2 === 0 ? 'autorizzato' as const : 'firma_mancante' as const,
      metodo: i % 2 === 0 ? 'OTP email' : null, signed_at: i % 2 === 0 ? '2026-08-05T09:00:00Z' : null,
      signature_log: { ip: '192.0.2.9', user_agent: 'segreto-agent', hash: 'hash-da-non-stampare' },
    })),
  })
}
describe('riepilogo autorizzazioni server A4', () => {
  it('alunni ordinati per cognome, conteggi, legenda, metodo e data italiana senza metadati tecnici', async () => {
    const pdf = await getDocumentProxy(await build())
    const items = await (await pdf.getPage(1)).getTextContent()
    const text = items.items.map((i) => 'str' in i ? i.str : '').join(' ')
    for (const s of ['Uscita al museo', 'Totale: 2', 'Autorizzati: 1', 'Legenda', 'Firma mancante', 'OTP email', '05/08/2026', '11:00']) expect(text).toContain(s)
    expect(text.indexOf('Alfa')).toBeLessThan(text.indexOf('Zeta'))
    for (const s of ['192.0.2.9', 'segreto-agent', 'hash-da-non-stampare']) expect(text).not.toContain(s)
  })
  it('testi lunghi e 86 alunni restano nei margini; intestazione tabella ripetuta e pagine numerate', async () => {
    const bytes = await build(true)
    const pdf = await getDocumentProxy(bytes.slice())
    expect(pdf.numPages).toBeGreaterThan(3)
    let all = ''
    for (let n = 1; n <= pdf.numPages; n++) {
      const items = await (await pdf.getPage(n)).getTextContent()
      const text = items.items.map((i) => 'str' in i ? i.str : '').join(' ')
      all += text
      expect(text).toContain(`Pagina ${n}/${pdf.numPages}`)
      if (text.includes('Bambino')) for (const header of ['Alunno', 'Esito', 'Metodo', 'Data firma']) expect(text).toContain(header)
    }
    expect(all).toContain('Descrizione integrale 55')
    expect(all).toContain('Alfa 085')
    const elements = await elementiTesto(bytes)
    expect(elements.every((e) => e.xMm >= 14.5 && e.xMm + e.larghezzaMm <= 195.5 && e.yMm >= 10 && e.yMm <= 288)).toBe(true)
  })
})
