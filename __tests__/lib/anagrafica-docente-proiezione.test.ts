import { describe, it, expect } from 'vitest'
import {
  proiettaDelegati,
  proiettaGenitori,
  proiettaScheda,
  proiettaSezione,
  proiettaVoceElenco,
} from '@/lib/anagrafiche/docente/proiezione'

// La proiezione È la lista bianca. Il finto Supabase restituisce righe INTERE
// (non emula la proiezione di `select`), e anche il database vero lo farebbe se
// qualcuno scrivesse `select('*')`: qui si prova che, comunque arrivi la riga, i
// campi economici e i documenti non escono.

const SEZIONE_ID = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'

const RIGA_PIENA: Record<string, unknown> = {
  id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa',
  nome: '  Alfa ',
  cognome: 'Prova-E2E',
  gender: 'F',
  data_nascita: '2021-03-04',
  birth_city: 'Testville',
  birth_province: 'TV',
  birth_nation: 'Italia',
  citizenship: 'Italiana',
  codice_fiscale: 'tstprv21c44z999q',
  residence_address: 'Via Finta',
  residence_street_number: '1',
  zip_code: '00000',
  residence_city: 'Testville',
  residence_province: 'TV',
  section_id: SEZIONE_ID,
  data_iscrizione: '2025-09-01',
  allergies: 'latte, fragole',
  allergeni: ['latte'],
  note_mediche: 'Riga uno\nRiga due',
  is_bes_dsa: true,
  usa_pannolino: false,
  consenso_privacy: true,
  consenso_foto_sito: false,
  consenso_foto_social: null,
  scuola_id: 'e2e00000-0000-4000-8000-000000000001',
  stato: 'iscritto',
  // ── campi che NON devono uscire mai ──
  importo_retta_mensile: 987,
  retta_split_config: { quota: 'SPLIT-FINTO' },
  retta_a_carico_di: 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb',
  genitori_separati: true,
  intestatario_fatture: 'INTESTATARIO-FINTO',
  invoice_holder_name: 'TITOLARE-FATTURA-FINTO',
  fiscale_config: { regime: 'FISCALE-FINTO' },
  opposizione_ade: true,
  bollo_virtuale: true,
  giorno_scadenza_pagamenti: 10,
  sospeso: true,
  sospeso_motivo: 'MOROSITA-FINTA',
  documento_path: 'documenti/DOCUMENTO-FINTO.pdf',
  numero_domanda_sidi: 'SIDI-FINTO',
  archiviato_motivo: 'ARCHIVIO-FINTO',
}

const VIETATI = [
  'SPLIT-FINTO',
  'INTESTATARIO-FINTO',
  'TITOLARE-FATTURA-FINTO',
  'FISCALE-FINTO',
  'MOROSITA-FINTA',
  'DOCUMENTO-FINTO',
  'SIDI-FINTO',
  'ARCHIVIO-FINTO',
  '987',
  'b2b2b2b2',
]

describe('proiettaVoceElenco', () => {
  it('le chiavi in uscita sono ESATTAMENTE queste', () => {
    const voce = proiettaVoceElenco(RIGA_PIENA, 'infanzia')
    expect(Object.keys(voce).sort()).toEqual([
      'allergeni', 'annoNascita', 'besDsa', 'cognome', 'consensoFotoSito', 'consensoFotoSocial',
      'dataNascita', 'grado', 'haAllergie', 'id', 'nome', 'sectionId', 'sesso', 'usaPannolino',
    ])
  })

  it('niente economia, niente documenti, niente testo libero (allergie e note)', () => {
    const json = JSON.stringify(proiettaVoceElenco(RIGA_PIENA, 'infanzia'))
    for (const v of [...VIETATI, 'fragole', 'Riga uno', 'TSTPRV', 'Via Finta']) expect(json).not.toContain(v)
  })

  it('normalizza i valori', () => {
    const voce = proiettaVoceElenco(RIGA_PIENA, 'infanzia')
    expect(voce).toMatchObject({
      nome: 'Alfa',
      sectionId: SEZIONE_ID,
      grado: 'infanzia',
      dataNascita: '2021-03-04',
      annoNascita: 2021,
      sesso: 'F',
      allergeni: ['latte'],
      haAllergie: true,
      besDsa: true,
      usaPannolino: false,
      consensoFotoSito: false,
      consensoFotoSocial: null,
    })
  })

  it('allergeni dedotti dal testo quando l’archivio è vuoto; «fragole» resta un’allergia operativa', () => {
    expect(proiettaVoceElenco({ id: 'x', allergies: 'uova', allergeni: [] }, null).allergeni).toEqual(['uova'])
    const soloFragole = proiettaVoceElenco({ id: 'x', allergies: 'fragole', allergeni: [] }, null)
    expect(soloFragole.allergeni).toEqual([])
    expect(soloFragole.haAllergie).toBe(true)
    expect(proiettaVoceElenco({ id: 'x', allergies: 'Nessuna', allergeni: [] }, null).haAllergie).toBe(false)
  })

  it('valori assenti o storti diventano null, non stringhe vuote né eccezioni', () => {
    const voce = proiettaVoceElenco({ id: 'x', gender: 'X', data_nascita: 'ieri', section_id: '' }, null)
    expect(voce).toMatchObject({ nome: '', sesso: null, dataNascita: null, annoNascita: null, sectionId: null })
  })
})

describe('proiettaScheda', () => {
  const genitori = proiettaGenitori([])
  const scheda = () =>
    proiettaScheda(RIGA_PIENA, {
      sezione: proiettaSezione({ id: SEZIONE_ID, name: 'Girasoli', school_type: 'infanzia', scuola_id: 'x' }),
      genitori,
      delegati: [],
    })

  it('le chiavi in uscita sono ESATTAMENTE queste', () => {
    expect(Object.keys(scheda()).sort()).toEqual([
      'cittadinanza', 'codiceFiscale', 'cognome', 'consensi', 'dataIscrizione', 'dataNascita',
      'delegati', 'genitori', 'id', 'luogoNascita', 'nome', 'residenza', 'salute', 'sesso', 'sezione',
    ])
  })

  it('niente economia, niente documenti', () => {
    const json = JSON.stringify(scheda())
    for (const v of VIETATI) expect(json).not.toContain(v)
  })

  it('anagrafica, salute e consensi come li vede l’insegnante', () => {
    const s = scheda()
    expect(s.codiceFiscale).toBe('TSTPRV21C44Z999Q')
    expect(s.luogoNascita).toEqual({ comune: 'Testville', provincia: 'TV', nazione: 'Italia' })
    expect(s.residenza).toEqual({ indirizzo: 'Via Finta', civico: '1', cap: '00000', comune: 'Testville', provincia: 'TV' })
    expect(s.sezione).toEqual({ id: SEZIONE_ID, nome: 'Girasoli', grado: 'infanzia' })
    expect(s.salute).toEqual({
      allergeni: ['latte'],
      allergieAltro: 'fragole',
      haAllergie: true,
      noteMediche: 'Riga uno\nRiga due',
      besDsa: true,
      usaPannolino: false,
    })
    expect(s.consensi).toEqual({ privacy: true, fotoSito: false, fotoSocial: null })
  })
})

describe('proiettaGenitori / proiettaDelegati', () => {
  it('esclude i genitori anonimizzati, normalizza la parentela, mette prima il referente', () => {
    const genitori = proiettaGenitori([
      { relation_type: 'father', is_primary: false, parents: { first_name: 'Papà', last_name: 'Prova-E2E', phone_numbers: ['333 000 0001'], emails: [], fiscal_code: null } },
      { relation_type: 'mother', is_primary: true, parents: [{ first_name: 'Mamma', last_name: 'Prova-E2E', phone_numbers: ['333 000 0000', ' '], emails: ['mamma@example.test'], fiscal_code: 'tstmmm80a41z999q', document_number: 'DOC-FINTO', documento_path: 'doc/finto.pdf', residence_address: 'Via Genitore' }] },
      { relation_type: 'mother', is_primary: false, parents: { first_name: 'Ex', last_name: 'Anonima', anonimizzato_il: '2026-01-01T00:00:00Z' } },
      { relation_type: 'nonna', is_primary: false, parents: null },
    ])
    expect(genitori.map((g) => g.nome)).toEqual(['Mamma', 'Papà'])
    expect(genitori[0]).toEqual({
      nome: 'Mamma',
      cognome: 'Prova-E2E',
      parentela: 'madre',
      principale: true,
      telefoni: ['333 000 0000'],
      email: ['mamma@example.test'],
      codiceFiscale: 'TSTMMM80A41Z999Q',
    })
    const json = JSON.stringify(genitori)
    for (const v of ['DOC-FINTO', 'doc/finto.pdf', 'Via Genitore', 'Anonima']) expect(json).not.toContain(v)
  })

  it('una parentela sconosciuta è «altro», una assente è null', () => {
    const [a, b] = proiettaGenitori([
      { relation_type: 'delegate', parents: { first_name: 'Zia', last_name: 'X' } },
      { relation_type: null, parents: { first_name: 'Y', last_name: 'X' } },
    ])
    expect(a.parentela).toBe('altro')
    expect(b.parentela).toBeNull()
  })

  it('i delegati portano nome e parentela, mai il documento', () => {
    const delegati = proiettaDelegati([
      { first_name: 'Nonna', last_name: 'Prova-E2E', relation: 'Nonna', document_number: 'DOC-DELEGATO', document_url: 'u' },
    ])
    expect(delegati).toEqual([{ nome: 'Nonna', cognome: 'Prova-E2E', parentela: 'Nonna' }])
  })

  it('un grado sconosciuto della sezione è null', () => {
    expect(proiettaSezione({ id: 's', name: 'X', school_type: 'liceo' }).grado).toBeNull()
  })
})
