import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { parseSidiZip } from '@/lib/sidi/zip-parser'

async function makeZip(filename: string, content: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(filename, content)
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

describe('parseSidiZip — manifest CSV', () => {
  const csv = [
    'NUMERO_DOMANDA,ALUNNO_CF,ALUNNO_NOME,ALUNNO_COGNOME,GENITORE1_CF,GENITORE1_NOME,GENITORE1_EMAIL',
    '123,RSSMRC15C01H501Z,Marco,Rossi,VRDLGU80A01H501X,Luigi,luigi@example.it',
    '124,BNCANN16D41H501Y,Anna,Bianchi,,,',
  ].join('\n')

  it('estrae i record indicizzati per numero domanda', async () => {
    const res = await parseSidiZip(await makeZip('domande.csv', csv))
    expect(res.records).toHaveLength(2)
    const r = res.byNumeroDomanda.get('123')
    expect(r?.alunno.nome).toBe('Marco')
    expect(r?.alunno.codice_fiscale).toBe('RSSMRC15C01H501Z')
    expect(r?.genitori).toHaveLength(1)
    expect(r?.genitori[0].codice_fiscale).toBe('VRDLGU80A01H501X')
  })

  it('una domanda senza genitori non produce slot genitore vuoti', async () => {
    const res = await parseSidiZip(await makeZip('domande.csv', csv))
    expect(res.byNumeroDomanda.get('124')?.genitori).toHaveLength(0)
  })

  it('riga senza numero domanda → warning, non lancia', async () => {
    const bad = ['NUMERO_DOMANDA,ALUNNO_NOME', ',Senzanumero', '999,Valida'].join('\n')
    const res = await parseSidiZip(await makeZip('domande.csv', bad))
    expect(res.records).toHaveLength(1)
    expect(res.warnings.length).toBeGreaterThan(0)
  })
})

describe('parseSidiZip — manifest JSON', () => {
  it('accetta domande.json come array di record', async () => {
    const json = JSON.stringify([{ NUMERO_DOMANDA: '200', ALUNNO_NOME: 'Sara', ALUNNO_COGNOME: 'Verdi' }])
    const res = await parseSidiZip(await makeZip('domande.json', json))
    expect(res.records).toHaveLength(1)
    expect(res.byNumeroDomanda.get('200')?.alunno.nome).toBe('Sara')
  })

  it('zip senza manifest riconoscibile → warning, 0 record', async () => {
    const res = await parseSidiZip(await makeZip('altro.txt', 'x'))
    expect(res.records).toHaveLength(0)
    expect(res.warnings.length).toBeGreaterThan(0)
  })
})
