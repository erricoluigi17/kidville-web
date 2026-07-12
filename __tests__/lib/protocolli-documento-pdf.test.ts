// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildDocumentoRichiestaPdf } from '@/lib/protocolli/documento-pdf'
import { estraiTesto } from '@/lib/protocolli/estrai'

describe('buildDocumentoRichiestaPdf (carta intestata, decisione #22)', () => {
  it('produce un PDF con intestazione, titolo, corpo e luogo/data', async () => {
    const pdf = buildDocumentoRichiestaPdf({
      intestazione: ['Kidville Giugliano', 'Via Roma 1 — 80014 Giugliano (NA)'],
      titolo: 'NULLA OSTA AL TRASFERIMENTO',
      corpo:
        "Vista la richiesta presentata dalla famiglia, si concede il nulla osta al trasferimento dell'alunno/a Rossi Mario.",
      luogoData: 'Giugliano, lì 12/07/2026',
    })

    expect(new TextDecoder('latin1').decode(pdf.slice(0, 5))).toBe('%PDF-')

    const testo = await estraiTesto(pdf)
    expect(testo).toContain('Kidville Giugliano')
    expect(testo).toContain('NULLA OSTA AL TRASFERIMENTO')
    expect(testo).toContain('Rossi Mario')
    expect(testo).toContain('Giugliano, lì 12/07/2026')
    expect(testo).toContain('La Direzione')
  })

  it('degrada senza intestazione (righe assenti, mai inventate)', async () => {
    const pdf = buildDocumentoRichiestaPdf({
      intestazione: [],
      titolo: 'CERTIFICATO DI FREQUENZA',
      corpo: 'Testo del certificato.',
      luogoData: 'Lì 12/07/2026',
    })
    const testo = await estraiTesto(pdf)
    expect(testo).toContain('CERTIFICATO DI FREQUENZA')
    expect(testo).toContain('Lì 12/07/2026')
  })
})
