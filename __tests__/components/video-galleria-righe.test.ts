import { describe, it, expect } from 'vitest'

import { FASI_UI_ATTIVE, fondiRighe, type IngressoFusione, type StatoLocale } from '@/components/features/gallery/video-galleria-righe'
import { FASI_ATTIVE } from '@/app/api/video-uploads/elenco'
import { FASI_VOCE_VIDEO, type VoceVideo } from '@/lib/media/video/contratto'

/**
 * COME SI FONDONO LE RIGHE DI QUESTO DISPOSITIVO CON L'ELENCO DEL SERVER.
 *
 * La funzione è pura, quindi si prova su una tabella: ogni riga è una domanda che una persona si
 * fa guardando lo schermo — «dov'è il mio video?» — e la risposta che deve leggere. Le regole stanno
 * in testa a `video-galleria-righe.ts`; qui si tengono ferme quelle che, sbagliate, mentono:
 * un video «da un altro dispositivo» che è appena partito da QUESTO, una scheda che ricompare dopo
 * «Togli», una barra che sparisce a metà trasferimento.
 */

const INTENTO = '11111111-0000-4000-8000-000000000011'
const JOB = '22222222-0000-4000-8000-000000000022'
const INTENTO_B = '11111111-0000-4000-8000-0000000000bb'
const JOB_B = '22222222-0000-4000-8000-0000000000bb'

const frase = (codice: string | null) => `[${codice ?? 'ripiego'}]`
const NOTA = 'NOTA-TUS'

function locale(extra: Partial<StatoLocale> = {}): StatoLocale {
  return {
    jobId: JOB,
    intentId: INTENTO,
    nome: 'recita.mp4',
    creatoIl: '2026-10-02T10:00:00.000Z',
    trasferimento: 'in-corso',
    percentuale: 42,
    codice: null,
    ...extra,
  }
}

function voce(fase: VoceVideo['fase'], extra: Partial<VoceVideo> = {}): VoceVideo {
  const conErrore = fase === 'fallito' || fase === 'non-pubblicato'
  return {
    intentId: INTENTO,
    jobId: JOB,
    fase,
    codice: conErrore ? (fase === 'fallito' ? 'VIDEO_TROPPO_LUNGO' : 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA') : null,
    creatoIl: '2026-10-02T10:00:05.000Z',
    aggiornatoIl: '2026-10-02T10:00:09.000Z',
    trasporto: 'tus',
    byte: 1234,
    durataS: null,
    nBambini: 2,
    broadcast: false,
    mediaId: null,
    pubblicazioneAutomatica: fase !== 'da-ricaricare',
    riprovaPossibile: false,
    ...extra,
  }
}

function fondi(parziale: Partial<IngressoFusione>) {
  return fondiRighe({
    locali: {},
    voci: [],
    nascosti: new Set(),
    messaggiAzione: {},
    frase,
    notaCaricamento: NOTA,
    offline: false,
    ...parziale,
  })
}

const unica = (parziale: Partial<IngressoFusione>) => {
  const righe = fondi(parziale)
  expect(righe).toHaveLength(1)
  return righe[0]
}

describe('finché i byte non sono sullo Storage la parola è del telefono', () => {
  it('in corso: «caricamento», con la barra vera e la nota onesta del TUS', () => {
    const r = unica({ locali: { [JOB]: locale() }, voci: [voce('da-caricare')] })
    expect(r.fase).toBe('caricamento')
    expect(r.percentuale).toBe(42)
    expect(r.messaggio).toBe(NOTA)
    expect(r.nome).toBe('recita.mp4')
  })

  it('accodato: «in fila», senza barra — non è partito niente', () => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'in-fila', percentuale: null }) }, voci: [voce('da-caricare')] })
    expect(r.fase).toBe('in-fila')
    expect(r.percentuale).toBeNull()
  })

  it('fermo: «interrotto», senza barra, e di norma senza messaggio', () => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'interrotto' }) }, voci: [voce('da-caricare')] })
    expect(r.fase).toBe('interrotto')
    expect(r.percentuale).toBeNull()
    expect(r.messaggio).toBeNull()
  })

  it('un «non autorizzato» si legge solo se il browser crede di avere la rete', () => {
    const fermo = locale({ trasferimento: 'interrotto', codice: 'VIDEO_NON_AUTORIZZATO' })
    expect(unica({ locali: { [JOB]: fermo }, offline: false }).messaggio).toBe('[VIDEO_NON_AUTORIZZATO]')
    // Offline è soltanto la firma che non si è potuta chiedere: dirlo come un rifiuto sarebbe una bugia.
    expect(unica({ locali: { [JOB]: fermo }, offline: true }).messaggio).toBeNull()
    // Qualunque altro codice si legge comunque.
    expect(
      unica({ locali: { [JOB]: locale({ trasferimento: 'interrotto', codice: 'VIDEO_TROPPO_GRANDE' }) }, offline: true }).messaggio,
    ).toBe('[VIDEO_TROPPO_GRANDE]')
  })

  it('il trasferimento in corso NON sparisce se il server «sorpassa» di un istante la riga', () => {
    // La voce dice già `in-coda` (un tentativo precedente aveva portato i byte), ma questo
    // trasferimento sta ancora girando: la barra resta finché non si chiude da sé.
    const r = unica({ locali: { [JOB]: locale() }, voci: [voce('in-coda')] })
    expect(r.fase).toBe('caricamento')
  })
})

describe('quando i byte sono arrivati la parola passa al server', () => {
  it.each([
    ['in-coda', 'in-coda'],
    ['in-conversione', 'conversione'],
    ['in-riprova', 'in-riprova'],
    ['pronto', 'pronto'],
  ] as const)('trasferimento concluso + voce %s ⇒ fase %s', (faseVoce, atteso) => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'concluso', percentuale: null }) }, voci: [voce(faseVoce)] })
    expect(r.fase).toBe(atteso)
    expect(r.percentuale).toBeNull()
    // Il nome resta quello del file: l'elenco del server non ne ha.
    expect(r.nome).toBe('recita.mp4')
  })

  it('appena finito di caricare, prima che l’elenco lo sappia: «in coda», NON «da un altro dispositivo»', () => {
    const concluso = locale({ trasferimento: 'concluso', percentuale: null })
    expect(unica({ locali: { [JOB]: concluso }, voci: [] }).fase).toBe('in-coda')
    expect(unica({ locali: { [JOB]: concluso }, voci: null }).fase).toBe('in-coda')
    // Il server dice ancora «da caricare» (non ha ancora registrato l'arrivo): per chi l'ha appena
    // mandato da qui, è la bugia peggiore — non è di un altro dispositivo.
    expect(unica({ locali: { [JOB]: concluso }, voci: [voce('da-caricare')] }).fase).toBe('in-coda')
  })

  it('un trasferimento fermo il cui job ha GIÀ i byte sul server segue il server (non si rispedisce)', () => {
    expect(unica({ locali: { [JOB]: locale({ trasferimento: 'interrotto' }) }, voci: [voce('in-conversione')] }).fase).toBe('conversione')
    expect(unica({ locali: { [JOB]: locale({ trasferimento: 'in-fila' }) }, voci: [voce('pronto')] }).fase).toBe('pronto')
  })

  it('non pubblicato: il motivo è la frase del codice, e «Riprova» solo se il server dice di sì', () => {
    const nonPubblicato = voce('non-pubblicato', { riprovaPossibile: true })
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'concluso', percentuale: null }) }, voci: [nonPubblicato] })
    expect(r.fase).toBe('non-pubblicato')
    expect(r.messaggio).toBe('[VIDEO_PUBBLICAZIONE_NON_RIUSCITA]')
    expect(r.riprovaPossibile).toBe(true)
    expect(unica({ voci: [voce('non-pubblicato')] }).riprovaPossibile).toBe(false)
  })

  it('fallito: il motivo è il codice mostrabile della voce', () => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'concluso' }) }, voci: [voce('fallito')] })
    expect(r.fase).toBe('fallito')
    expect(r.messaggio).toBe('[VIDEO_TROPPO_LUNGO]')
  })

  it('«da ricaricare» (flusso vecchio) resta tale, con o senza riga locale', () => {
    expect(unica({ voci: [voce('da-ricaricare')] }).fase).toBe('da-ricaricare')
    expect(
      unica({ locali: { [JOB]: locale({ trasferimento: 'concluso' }) }, voci: [voce('da-ricaricare')] }).fase,
    ).toBe('da-ricaricare')
  })

  it('un video pubblicato non è più «in lavorazione», con o senza riga locale', () => {
    expect(fondi({ voci: [voce('pubblicato')] })).toEqual([])
    expect(fondi({ locali: { [JOB]: locale({ trasferimento: 'concluso' }) }, voci: [voce('pubblicato')] })).toEqual([])
  })
})

describe('un video che questo dispositivo non conosce', () => {
  it('in attesa dei suoi byte: «da un altro dispositivo», senza nome e con la data', () => {
    const r = unica({ voci: [voce('da-caricare')] })
    expect(r.fase).toBe('altro-dispositivo')
    expect(r.nome).toBeNull()
    expect(r.creatoIl).toBe('2026-10-02T10:00:05.000Z')
  })

  it.each([
    ['in-coda', 'in-coda'],
    ['in-conversione', 'conversione'],
    ['in-riprova', 'in-riprova'],
    ['pronto', 'pronto'],
  ] as const)('voce %s ⇒ fase %s', (faseVoce, atteso) => {
    expect(unica({ voci: [voce(faseVoce)] }).fase).toBe(atteso)
  })

  it('un annullato senza riga locale non si mostra: l’ha chiesto qualcuno, e non c’è niente da riconoscere', () => {
    expect(fondi({ voci: [voce('annullato')] })).toEqual([])
    // Con la riga locale sì: la persona vede che l'invio è stato ritirato (da un altro dispositivo).
    expect(unica({ locali: { [JOB]: locale({ trasferimento: 'concluso' }) }, voci: [voce('annullato')] }).fase).toBe('annullato')
  })
})

describe('i fallimenti del trasferimento locale', () => {
  it('i byte non ci sono più (`VIDEO_RIPROVA`): è un invio da rifare, non un errore da leggere', () => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'fallito', codice: 'VIDEO_RIPROVA' }) } })
    expect(r.fase).toBe('da-ricaricare')
    expect(r.messaggio).toBeNull()
  })

  it('ogni altro fallimento dice il suo codice', () => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'fallito', codice: 'VIDEO_TROPPO_GRANDE' }) } })
    expect(r.fase).toBe('fallito')
    expect(r.messaggio).toBe('[VIDEO_TROPPO_GRANDE]')
  })

  it('un fallimento senza codice non lascia una scheda muta: il ripiego lo decide `frase`', () => {
    const r = unica({ locali: { [JOB]: locale({ trasferimento: 'fallito', codice: null }) } })
    expect(r.fase).toBe('fallito')
    expect(r.messaggio).toBe('[ripiego]')
  })

  it('un trasferimento annullato è «annullato»', () => {
    expect(unica({ locali: { [JOB]: locale({ trasferimento: 'annullato' }) } }).fase).toBe('annullato')
  })
})

describe('«Togli» non torna, e gli altri casi di casa', () => {
  it('un intento tolto non compare, anche se il server lo riporta ancora (e «da ricaricare» ci resta per sette giorni)', () => {
    expect(unica({ voci: [voce('da-ricaricare')], nascosti: new Set() }).fase).toBe('da-ricaricare')
    expect(fondi({ voci: [voce('da-ricaricare')], nascosti: new Set([INTENTO]) })).toEqual([])
    // Vale anche per una riga locale.
    expect(fondi({ locali: { [JOB]: locale() }, nascosti: new Set([INTENTO]) })).toEqual([])
  })

  it('il messaggio di un’azione appena fallita («Riprova» negato) vince sul motivo della scheda', () => {
    const r = unica({
      voci: [voce('non-pubblicato', { riprovaPossibile: true })],
      messaggiAzione: { [JOB]: 'Non è più possibile riprovare' },
    })
    expect(r.messaggio).toBe('Non è più possibile riprovare')
  })

  it('le schede vanno dalla più vecchia alla più recente, qualunque sia l’ordine in cui arrivano', () => {
    const righe = fondi({
      voci: [
        voce('in-coda', { jobId: JOB_B, intentId: INTENTO_B, creatoIl: '2026-10-02T11:00:00.000Z' }),
        voce('in-coda', { creatoIl: '2026-10-02T09:00:00.000Z' }),
      ],
    })
    expect(righe.map((r) => r.jobId)).toEqual([JOB, JOB_B])
  })

  it('una riga locale e una voce dello stesso job sono UNA scheda sola', () => {
    expect(fondi({ locali: { [JOB]: locale({ trasferimento: 'concluso' }) }, voci: [voce('in-coda')] })).toHaveLength(1)
  })

  it('ogni riga dice se esiste su QUESTO dispositivo (serve a chi decide che cosa annullare)', () => {
    const righe = fondi({
      locali: { [JOB]: locale({ trasferimento: 'concluso' }) },
      voci: [voce('in-coda'), voce('in-coda', { jobId: JOB_B, intentId: INTENTO_B })],
    })
    expect(righe.find((r) => r.jobId === JOB)?.localeDiQuestoDispositivo).toBe(true)
    expect(righe.find((r) => r.jobId === JOB_B)?.localeDiQuestoDispositivo).toBe(false)
  })
})

describe('le fasi attive tengono viva la lettura dell’elenco', () => {
  it('sono quelle in cui un video non è ancora arrivato a una fine, e solo quelle', () => {
    expect([...FASI_UI_ATTIVE].sort()).toEqual(
      ['altro-dispositivo', 'caricamento', 'conversione', 'in-coda', 'in-fila', 'in-riprova', 'interrotto', 'pronto'].sort(),
    )
  })

  it('il polling segue il server: una voce «attiva» per il server è una scheda attiva, e il contrario', () => {
    // `FASI_ATTIVE` è la nozione del SERVER di «non ancora arrivato a una fine» (la usa l'elenco): se lo
    // schermo ne avesse una diversa, il polling si fermerebbe con un video ancora in lavorazione — o
    // non si fermerebbe mai. Qui le due nozioni si confrontano su ogni fase del contratto.
    for (const fase of FASI_VOCE_VIDEO) {
      const righe = fondi({ voci: [voce(fase)] })
      const attivaPerIlServer = FASI_ATTIVE.includes(fase)
      if (righe.length === 0) {
        expect(attivaPerIlServer, `la fase ${fase} è attiva per il server ma non produce nessuna scheda`).toBe(false)
        continue
      }
      expect(FASI_UI_ATTIVE.has(righe[0].fase), `la fase ${fase} → scheda ${righe[0].fase}`).toBe(attivaPerIlServer)
    }
  })

  it('ogni fase che il server può mandare produce una fase della scheda o nessuna (mai un’eccezione)', () => {
    for (const fase of FASI_VOCE_VIDEO) {
      const v = voce(fase)
      expect(() => fondi({ voci: [v] })).not.toThrow()
    }
  })
})
