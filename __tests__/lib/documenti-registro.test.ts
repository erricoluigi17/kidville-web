import { describe, it, expect } from 'vitest'
import {
  categoriaDocumento,
  daCertificatoMedico,
  daFascicolo,
  daModuloFirmato,
  etichettaTipo,
  filtraPerVisibilita,
  istanteFirma,
  ordinaDocumenti,
  riepilogo,
  TIPI_SANITARI,
  type DocumentoAlunno,
} from '@/lib/documenti/registro'

const ALUNNO = '11111111-1111-4111-8111-111111111111'
const ALTRO_ALUNNO = '22222222-2222-4222-8222-222222222222'

function doc(over: Partial<DocumentoAlunno> = {}): DocumentoAlunno {
  return {
    id: 'modulo_firmato:x',
    fonte: 'modulo_firmato',
    rifId: 'x',
    alunnoId: ALUNNO,
    titolo: 'Modulo',
    tipo: null,
    categoria: 'amministrativo',
    firmato: true,
    firmatoIl: '2026-08-10T10:00:00.000Z',
    creatoIl: '2026-08-10T09:00:00.000Z',
    scadeIl: null,
    nota: null,
    ...over,
  }
}

describe('categoriaDocumento', () => {
  it('il fascicolo è sanitario qualunque tipo porti, anche uno sconosciuto', () => {
    expect(categoriaDocumento('fascicolo', 'pei')).toBe('sanitario')
    expect(categoriaDocumento('fascicolo', 'tipo-mai-visto')).toBe('sanitario')
    expect(categoriaDocumento('fascicolo', null)).toBe('sanitario')
  })

  it('il certificato medico è sanitario per natura', () => {
    expect(categoriaDocumento('certificato_medico', null)).toBe('sanitario')
  })

  it('un modulo firmato è amministrativo, salvo che il tipo sia in lista', () => {
    expect(categoriaDocumento('modulo_firmato', 'autorizzazione_uscita')).toBe('amministrativo')
    expect(categoriaDocumento('modulo_firmato', null)).toBe('amministrativo')
    expect(categoriaDocumento('modulo_firmato', 'scheda_sanitaria')).toBe('sanitario')
    expect(categoriaDocumento('modulo_firmato', 'autorizzazione_farmaci')).toBe('sanitario')
  })

  it('riconosce il tipo a prescindere da maiuscole e spazi', () => {
    expect(categoriaDocumento('modulo_firmato', '  Dieta_Speciale ')).toBe('sanitario')
  })

  it('i quattro prestampati sanitari futuri sono già in lista', () => {
    for (const slug of ['scheda_sanitaria', 'autorizzazione_farmaci', 'dieta_speciale', 'verbale_infortunio']) {
      expect(TIPI_SANITARI).toContain(slug)
    }
  })
})

describe('istanteFirma', () => {
  it('legge la forma canonica signed_at', () => {
    expect(istanteFirma({ signed_at: '2026-08-10T10:00:00.000Z' })).toBe('2026-08-10T10:00:00.000Z')
  })

  it('accetta anche timestamp, la forma dei flussi pagella e giustifica', () => {
    expect(istanteFirma({ timestamp: '2026-08-11T08:30:00.000Z' })).toBe('2026-08-11T08:30:00.000Z')
  })

  it('non inventa una data quando il log è assente o malformato', () => {
    expect(istanteFirma(null)).toBeNull()
    expect(istanteFirma('non-un-oggetto')).toBeNull()
    expect(istanteFirma({})).toBeNull()
    expect(istanteFirma({ signed_at: '   ' })).toBeNull()
    expect(istanteFirma({ signed_at: 42 })).toBeNull()
  })
})

describe('daModuloFirmato', () => {
  it('scarta la submission senza alunno (onboarding)', () => {
    const r = daModuloFirmato(
      { id: 'a', student_id: null, form_id: 'f', is_signed: true, signature_log: null, created_at: '2026-08-01' },
      'Autorizzazione gita',
    )
    expect(r).toBeNull()
  })

  it('porta titolo del modello, stato di firma e istante', () => {
    const r = daModuloFirmato(
      {
        id: 'a1',
        student_id: ALUNNO,
        form_id: 'f1',
        is_signed: true,
        signature_log: { signed_at: '2026-08-10T10:00:00.000Z' },
        created_at: '2026-08-09T10:00:00.000Z',
        origine: 'parent',
      },
      'Autorizzazione gita al museo',
    )
    expect(r).not.toBeNull()
    expect(r!.id).toBe('modulo_firmato:a1')
    expect(r!.titolo).toBe('Autorizzazione gita al museo')
    expect(r!.firmato).toBe(true)
    expect(r!.firmatoIl).toBe('2026-08-10T10:00:00.000Z')
    expect(r!.categoria).toBe('amministrativo')
  })

  it('un modulo non firmato non porta un istante di firma, anche se il log esiste', () => {
    const r = daModuloFirmato(
      {
        id: 'a2',
        student_id: ALUNNO,
        form_id: 'f1',
        is_signed: false,
        signature_log: { signed_at: '2026-08-10T10:00:00.000Z' },
        created_at: '2026-08-09T10:00:00.000Z',
      },
      'Sondaggio',
    )
    expect(r!.firmato).toBe(false)
    expect(r!.firmatoIl).toBeNull()
  })

  it('degrada su un titolo esplicito invece di lasciare la riga senza nome', () => {
    const r = daModuloFirmato(
      { id: 'a3', student_id: ALUNNO, form_id: null, is_signed: true, signature_log: null, created_at: null },
      null,
    )
    expect(r!.titolo).toBe('Modulo senza titolo')
  })
})

describe('daFascicolo', () => {
  it('è sempre sanitario e mai firmato', () => {
    const r = daFascicolo({
      id: 'd1',
      student_id: ALUNNO,
      document_type: 'pei',
      descrizione: 'anno in corso',
      file_name: 'pei.pdf',
      expiry_date: '2027-06-30',
      created_at: '2026-09-01T08:00:00.000Z',
    })
    expect(r.categoria).toBe('sanitario')
    expect(r.firmato).toBe(false)
    expect(r.titolo).toBe('PEI — Piano Educativo Individualizzato')
    expect(r.scadeIl).toBe('2027-06-30')
  })

  it('senza tipo ripiega sul nome del file, non su una stringa vuota', () => {
    const r = daFascicolo({
      id: 'd2',
      student_id: ALUNNO,
      document_type: null,
      descrizione: null,
      file_name: 'verbale.pdf',
      expiry_date: null,
      created_at: null,
    })
    expect(r.titolo).toBe('verbale.pdf')
  })
})

describe('daCertificatoMedico', () => {
  it('usa la data di fine come scadenza', () => {
    const r = daCertificatoMedico({
      id: 'c1',
      alunno_id: ALUNNO,
      data_inizio: '2026-08-01',
      data_fine: '2026-08-10',
      stato: 'validato',
      creato_il: '2026-08-01T07:00:00.000Z',
    })
    expect(r.categoria).toBe('sanitario')
    expect(r.scadeIl).toBe('2026-08-10')
    expect(r.nota).toBe('validato')
  })
})

describe('ordinaDocumenti', () => {
  it('mette per prima la firma più recente', () => {
    const out = ordinaDocumenti([
      doc({ id: 'vecchio', firmatoIl: '2026-08-01T10:00:00.000Z' }),
      doc({ id: 'nuovo', firmatoIl: '2026-08-12T10:00:00.000Z' }),
      doc({ id: 'medio', firmatoIl: '2026-08-05T10:00:00.000Z' }),
    ])
    expect(out.map((d) => d.id)).toEqual(['nuovo', 'medio', 'vecchio'])
  })

  it('per i documenti non firmati usa la data di creazione', () => {
    const out = ordinaDocumenti([
      doc({ id: 'caricato-oggi', firmato: false, firmatoIl: null, creatoIl: '2026-08-13T10:00:00.000Z' }),
      doc({ id: 'firmato-ieri', firmatoIl: '2026-08-12T10:00:00.000Z' }),
    ])
    expect(out[0].id).toBe('caricato-oggi')
  })

  it('le righe senza data finiscono in fondo, non in cima', () => {
    const out = ordinaDocumenti([
      doc({ id: 'senza-data', firmatoIl: null, creatoIl: '' }),
      doc({ id: 'con-data', firmatoIl: '2026-08-01T10:00:00.000Z' }),
    ])
    expect(out.map((d) => d.id)).toEqual(['con-data', 'senza-data'])
  })

  it('non muta la lista ricevuta', () => {
    const originale = [doc({ id: 'a', firmatoIl: '2026-08-01T10:00:00.000Z' }), doc({ id: 'b', firmatoIl: '2026-08-09T10:00:00.000Z' })]
    ordinaDocumenti(originale)
    expect(originale.map((d) => d.id)).toEqual(['a', 'b'])
  })
})

describe('filtraPerVisibilita', () => {
  const documenti = [
    doc({ id: 'amm-mio', categoria: 'amministrativo', alunnoId: ALUNNO }),
    doc({ id: 'san-mio', categoria: 'sanitario', alunnoId: ALUNNO }),
    doc({ id: 'amm-altro', categoria: 'amministrativo', alunnoId: ALTRO_ALUNNO }),
    doc({ id: 'san-altro', categoria: 'sanitario', alunnoId: ALTRO_ALUNNO }),
  ]

  it('mostra i sanitari solo degli alunni per cui l\'accesso è stato concesso', () => {
    const out = filtraPerVisibilita(documenti, new Set([ALUNNO]))
    expect(out.map((d) => d.id)).toEqual(['amm-mio', 'san-mio', 'amm-altro'])
  })

  it('senza alcun accesso restano solo gli amministrativi', () => {
    const out = filtraPerVisibilita(documenti, new Set())
    expect(out.map((d) => d.id)).toEqual(['amm-mio', 'amm-altro'])
  })

  it('con accesso a tutti non toglie niente', () => {
    const out = filtraPerVisibilita(documenti, new Set([ALUNNO, ALTRO_ALUNNO]))
    expect(out).toHaveLength(4)
  })
})

describe('etichettaTipo', () => {
  it('traduce le sigle del fascicolo', () => {
    expect(etichettaTipo('104')).toBe('Verbale L. 104')
    expect(etichettaTipo('pdp')).toBe('PDP — Piano Didattico Personalizzato')
  })

  it('restituisce il tipo grezzo quando non è in tabella, invece di perderlo', () => {
    expect(etichettaTipo('tipo_nuovo')).toBe('tipo_nuovo')
  })

  it('su tipo assente non inventa una etichetta', () => {
    expect(etichettaTipo(null)).toBeNull()
    expect(etichettaTipo('   ')).toBeNull()
  })
})

describe('riepilogo', () => {
  it('conta totale, firmati, sanitari e quelli con scadenza', () => {
    const r = riepilogo([
      doc({ firmato: true, categoria: 'amministrativo' }),
      doc({ firmato: false, categoria: 'sanitario', scadeIl: '2026-09-01' }),
      doc({ firmato: true, categoria: 'sanitario' }),
    ])
    expect(r).toEqual({ totale: 3, firmati: 2, sanitari: 2, inScadenza: 1 })
  })
})
