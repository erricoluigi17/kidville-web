// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'

import {
  campiCertificatiMedici,
  campiSemaforo,
  type RigaCertificatoDocente,
  type RigaSemaforo,
} from '@/components/features/teacher/filtri-modulistica'
import { contaAttivi, filtraRighe, pulisciFiltri, queryServer, valoriIniziali } from '@/lib/ui/filtri/motore'
import type { CampoFiltro, ValoriFiltri } from '@/lib/ui/filtri/tipi'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * I FILTRI DELLA «MODULISTICA» DEL DOCENTE — dove i filtri vanno SUL SERVER.
 *
 * È il rovescio della scheda del genitore: qui l'elenco è di una sezione intera e
 * la rotta i filtri li accetta già. Due cose sole possono andare storte, e sono
 * quelle che questo file misura:
 *
 *  1. **il nome del parametro.** `GET /api/teacher/medical-certificates` dichiara
 *     `stato` nel proprio schema `zod` da sempre — e l'interfaccia non gliel'ha
 *     MAI mandato. Un filtro che parte col nome sbagliato non dà nessun errore:
 *     `parseQuery` scarta ciò che non conosce, la rotta risponde con tutto, e la
 *     schermata dice di aver filtrato. Perciò il test non ripete i nomi a memoria:
 *     li LEGGE dallo schema della rotta, e pretende che coincidano.
 *
 *  2. **la cornice che si svuota.** Sezione e modulo non sono filtri: sono la
 *     domanda. Se «Pulisci filtri» li azzerasse, o se contassero nella pastiglia
 *     «Filtri ③», il docente si troverebbe una schermata vuota dopo un gesto che
 *     prometteva di rimettere ordine — e nessun messaggio saprebbe spiegargli
 *     perché. Per questo sono `obbligatorio: true`, e per questo lo si prova.
 *
 * ⚠️ Nessun dato personale nei dati di prova: il repository è PUBBLICO.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const RADICE = process.cwd()
const CATALOGO = JSON.parse(
  readFileSync(join(RADICE, 'messages/it/teacherServizi.json'), 'utf8'),
) as Record<string, string>

const t = createTranslator({
  locale: 'it',
  messages: { teacherServizi: CATALOGO } as never,
  namespace: 'teacherServizi' as never,
  onError: (errore) => {
    throw errore
  },
}) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

const riposo = <R,>(campi: readonly CampoFiltro<R>[]): ValoriFiltri => valoriIniziali(campi, null)

/** I nomi che uno schema `zod` di rotta dichiara: `const <nome> = z.object({ … })`. */
function chiaviDelloSchema(percorsoRotta: string, nomeSchema: string): string[] {
  const sorgente = readFileSync(join(RADICE, percorsoRotta), 'utf8')
  const blocco = new RegExp(`const ${nomeSchema} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\)`).exec(sorgente)?.[1]
  if (!blocco) throw new Error(`schema «${nomeSchema}» non trovato in ${percorsoRotta}`)
  return [...blocco.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1])
}

const SEZIONI = ['Girasoli', 'Margherite']

const MODULI = [
  { id: 'm1', title: 'Autorizzazione gita al museo' },
  { id: 'm2', title: 'Consenso fotografie' },
]

const ALUNNI: RigaSemaforo[] = [
  { student_id: 'a1', nome: 'Primo', cognome: 'Diprova', status: 'green' },
  { student_id: 'a2', nome: 'Seconda', cognome: 'Esempio', status: 'red' },
  { student_id: 'a3', nome: 'Terzo', cognome: 'Diprova', status: 'red' },
]

const CERTIFICATI: RigaCertificatoDocente[] = [
  { id: 'c1', nome_alunno: 'Primo', cognome_alunno: 'Diprova', stato: 'in_validazione' },
  { id: 'c2', nome_alunno: 'Seconda', cognome_alunno: 'Esempio', stato: 'validato' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 1 · «Semaforo consensi»
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica docente · semaforo', () => {
  const campi = () => campiSemaforo(t, { sezioni: SEZIONI, moduli: MODULI, sezionePredefinita: 'Girasoli' })

  /**
   * ⚠️ QUESTA PROVA PRIMA INIETTAVA `form_id` A MANO (`{ ...riposo(c), form_id: 'm1' }`),
   * ed è il motivo per cui non ha visto il difetto: montata, la pagina non aveva
   * nessun modo di mettercelo. `form_id` non aveva un `predefinito`, quindi il suo
   * riposo era la stringa vuota, `queryServer` non lo scriveva e il semaforo non
   * chiedeva NIENTE — elenco perennemente vuoto, senza errori e senza log. Un test
   * che prepara lo stato che il prodotto non sa raggiungere misura sé stesso.
   *
   * Ora si parte dal RIPOSO e basta: è lo stato in cui la schermata nasce davvero.
   */
  it('sezione e modulo sono la CORNICE: al RIPOSO sono già nella query, senza che nessuno li scelga', () => {
    const c = campi()
    const query = queryServer(c, riposo(c))
    expect(query.get('class_name')).toBe('Girasoli')
    expect(query.get('form_id')).toBe('m1')
  })

  it('il modulo di riposo è il PRIMO dell’elenco della sezione, non una stringa vuota', () => {
    const c = campiSemaforo(t, { sezioni: SEZIONI, moduli: [MODULI[1], MODULI[0]], sezionePredefinita: 'Girasoli' })
    expect(queryServer(c, riposo(c)).get('form_id')).toBe('m2')
  })

  it('la cornice non si conta fra i filtri attivi e «Pulisci» non la tocca', () => {
    const c = campi()
    const scelto: ValoriFiltri = { ...riposo(c), class_name: 'Margherite', form_id: 'm2', q: 'diprova' }
    // Tre valori diversi dal riposo, ma uno solo è un «filtro»: la ricerca.
    expect(contaAttivi(c, scelto)).toBe(1)
    const puliti = pulisciFiltri(c, scelto)
    expect(puliti.class_name).toBe('Margherite')
    expect(puliti.form_id).toBe('m2')
    expect(puliti.q).toBe('')
  })

  it('firmati/mancanti restano a schermo: la rotta non li conosce e non deve riceverli', () => {
    const c = campi()
    const mancanti: ValoriFiltri = { ...riposo(c), stato: 'red' }
    expect(filtraRighe(c, mancanti, ALUNNI).map((a) => a.student_id)).toEqual(['a2', 'a3'])
    expect(queryServer(c, mancanti).has('stato')).toBe(false)
  })

  it('la ricerca dell’alunno guarda cognome e nome, e non parte verso l’API', () => {
    const c = campi()
    const cercato: ValoriFiltri = { ...riposo(c), q: 'seconda' }
    expect(filtraRighe(c, cercato, ALUNNI).map((a) => a.student_id)).toEqual(['a2'])
    expect(queryServer(c, cercato).has('q')).toBe(false)
  })

  it('senza moduli il selettore non si disegna invece di offrire una tendina vuota', () => {
    const senza = campiSemaforo(t, { sezioni: SEZIONI, moduli: [], sezionePredefinita: 'Girasoli' })
    const modulo = senza.find((c) => c.chiave === 'form_id')
    expect(modulo?.nascondiSeVuoto).toBe(true)
    expect(modulo && 'opzioni' in modulo ? modulo.opzioni : null).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 · «Certificati medici» — il guadagno più a buon mercato
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica docente · certificati medici', () => {
  const campi = () => campiCertificatiMedici(t, { sezioni: SEZIONI, sezionePredefinita: 'Girasoli' })

  it('lo stato parte verso la rotta col nome che la rotta dichiara', () => {
    const c = campi()
    const stato = c.find((x) => x.chiave === 'stato')
    expect(stato?.dove).toBe('server')
    const query = queryServer(c, { ...riposo(c), stato: 'in_validazione' })
    expect(query.get('stato')).toBe('in_validazione')
    expect(query.get('class_name')).toBe('Girasoli')
  })

  it('i tre stati sono ESATTAMENTE quelli che il vincolo del database ammette', () => {
    const stato = campi().find((x) => x.chiave === 'stato')
    if (!stato || (stato.tipo !== 'scelta' && stato.tipo !== 'chip')) throw new Error('stato non è una scelta')
    expect(stato.opzioni.map((o) => o.valore)).toEqual(['in_validazione', 'validato', 'rifiutato'])
    // Gli stessi toni dei badge dell'elenco, o la stessa parola avrebbe due colori.
    expect(stato.opzioni.map((o) => o.tono)).toEqual(['warn', 'success', 'error'])
  })

  it('la ricerca dell’alunno resta a schermo (la rotta non la accetta)', () => {
    const c = campi()
    const cercato: ValoriFiltri = { ...riposo(c), q: 'esempio' }
    expect(filtraRighe(c, cercato, CERTIFICATI).map((r) => r.id)).toEqual(['c2'])
    expect(queryServer(c, cercato).toString()).toBe('class_name=Girasoli')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 · Il legame con le rotte: i nomi non si ricopiano, si LEGGONO
// ═════════════════════════════════════════════════════════════════════════════

describe('modulistica docente · ogni parametro che parte è dichiarato dalla rotta', () => {
  it('certificati medici: `stato` e `class_name` sono nello schema `zod` della rotta', () => {
    const dichiarati = chiaviDelloSchema('src/app/api/teacher/medical-certificates/route.ts', 'getQuerySchema')
    expect(dichiarati).toContain('stato')
    expect(dichiarati).toContain('class_name')

    const c = campiCertificatiMedici(t, { sezioni: SEZIONI, sezionePredefinita: 'Girasoli' })
    for (const campo of c) {
      if (campo.dove !== 'server') continue
      expect(dichiarati, `la barra manda «${campo.chiave}», che la rotta non dichiara`).toContain(campo.chiave)
    }
  })

  it('semaforo: `form_id` e `class_name` sono i due parametri che la rotta legge', () => {
    const sorgente = readFileSync(join(RADICE, 'src/app/api/teacher/modulistica/route.ts'), 'utf8')
    const c = campiSemaforo(t, { sezioni: SEZIONI, moduli: MODULI, sezionePredefinita: 'Girasoli' })
    for (const campo of c) {
      if (campo.dove !== 'server') continue
      expect(sorgente, `la barra manda «${campo.chiave}», che la rotta non nomina`).toContain(campo.chiave)
    }
  })

  it('ogni etichetta è un TESTO risolto, mai il nome di una chiave', () => {
    const tutte = [
      ...campiSemaforo(t, { sezioni: SEZIONI, moduli: MODULI, sezionePredefinita: 'Girasoli' }),
      ...campiCertificatiMedici(t, { sezioni: SEZIONI, sezionePredefinita: 'Girasoli' }),
    ]
    for (const campo of tutte) {
      expect(campo.etichetta.length).toBeGreaterThan(1)
      expect(campo.etichetta).not.toContain('teacherServizi.')
    }
  })
})
