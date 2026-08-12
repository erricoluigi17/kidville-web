// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import itPublic from '../../messages/it/public.json'
import { isPublicPath } from '@/lib/auth/middleware-rules'

/**
 * `/anagrafica-personale` — LA PAGINA, E LE TRE COSE CHE DEVE FARE.
 *
 * ─── 1. IL LANDMARK ─────────────────────────────────────────────────────────
 *
 * Un `<main>`. È ciò che permette a uno screen reader di saltare al contenuto
 * invece di riscorrere la riga di testa a ogni passo, e su `/lavora-con-noi` non
 * c'era: misurato l'11/08/2026 sulla pagina viva, su tutti e cinque i passi,
 * `document.querySelector('main')` rispondeva `null`. Non era un fallimento
 * WCAG A/AA — la struttura per intestazioni c'era ed era corretta — ma era
 * l'unica superficie pubblica con un modulo dentro a non averlo.
 * Sta nella PAGINA e non nel wizard: il wizard è un componente client ridisegnato
 * dai passi, il landmark è una proprietà del documento.
 *
 * ─── 2. NESSUN `?sede=`, MAI ────────────────────────────────────────────────
 *
 * Il modulo delle candidature accetta un link «targato» per plesso; qui il link è
 * UNO SOLO per tutte e tre le sedi (decisione del titolare dell'11/08/2026) e la
 * sede la sceglie chi compila, al primo passo, che c'è sempre.
 *
 * ⚠️ E questo collaudo non verifica soltanto che il parametro non sia letto:
 * verifica che il wizard non riceva NIENTE che possa valere come una sede. È la
 * differenza che conta, perché il difetto non nascerebbe scrivendo `?sede=` —
 * nascerebbe copiando `lavora-con-noi/page.tsx`, che quella riga ce l'ha, e
 * lasciandola dentro. Da lì un uuid inoltrato su WhatsApp da una collega
 * all'altra archivierebbe l'anagrafica nel plesso sbagliato in silenzio: la
 * segreteria che l'aspetta crederebbe che non sia mai arrivata.
 *
 * ─── 3. IL PREFISSO PUBBLICO ────────────────────────────────────────────────
 *
 * Senza `/anagrafica-personale` in `PUBLIC_PREFIXES` la pagina finirebbe dietro
 * il login. È un difetto che da server non si vede — lo si scopre solo aprendo la
 * pagina da disconnessi — e a scoprirlo sarebbe una maestra a cui è stato appena
 * mandato il link.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (chiave: string) =>
    (itPublic as Record<string, string>)[chiave] ?? `${ns}.${chiave}`,
}))

// I due componenti sono finti — la pagina si collauda per la FORMA dell'albero
// che restituisce, non per ciò che quei due disegnano (che ha i suoi collaudi).
// Le fabbriche non chiudono su nessuna variabile del modulo: `vi.mock` è issata
// in cima al file, e una costante dichiarata sopra non esisterebbe ancora.
vi.mock('@/components/ui/PublicPageHeader', () => ({ PublicPageHeader: () => null }))
vi.mock('@/components/features/public/AnagraficaPersonaleWizard', () => ({
  AnagraficaPersonaleWizard: () => null,
}))

import AnagraficaPersonalePage, { generateMetadata } from '@/app/anagrafica-personale/page'
import { PublicPageHeader } from '@/components/ui/PublicPageHeader'
import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

type ParametriUrl = Record<string, string | undefined>

async function rendiPagina(sp: ParametriUrl = {}): Promise<ReactElement> {
  return (await AnagraficaPersonalePage({
    searchParams: Promise.resolve(sp as { da?: string }),
  })) as ReactElement
}

/** L'elemento del wizard dentro il `<main>`. */
function wizardDi(pagina: ReactElement): ReactElement<Record<string, unknown>> {
  return (pagina.props as { children: ReactElement<Record<string, unknown>> }).children
}

describe('/anagrafica-personale — la pagina', () => {
  it('il contenuto sta dentro un `<main>`, e il wizard è quello giusto', async () => {
    const pagina = await rendiPagina()
    expect(pagina.type).toBe('main')
    expect(wizardDi(pagina).type).toBe(AnagraficaPersonaleWizard)
  })

  it('la riga di testa pubblica è montata come slot, col ritorno di `?da=`', async () => {
    const pagina = await rendiPagina({ da: '/parent/profilo' })
    const intestazione = wizardDi(pagina).props.intestazione as ReactElement<{ ritorno?: string }>
    expect(intestazione.type).toBe(PublicPageHeader)
    // Il filtro dei percorsi interni vive dentro `PublicPageHeader`
    // (`ritornoInterno`), non qui: una seconda copia sarebbe la seconda regola da
    // tenere allineata su sei pagine.
    expect(intestazione.props.ritorno).toBe('/parent/profilo')
  })

  it('senza `?da=` il ritorno resta indefinito (e la riga di testa ripiega da sé)', async () => {
    const pagina = await rendiPagina()
    const intestazione = wizardDi(pagina).props.intestazione as ReactElement<{ ritorno?: string }>
    expect(intestazione.props.ritorno).toBeUndefined()
  })

  it('funziona anche SENZA `searchParams` (la pagina si apre da un link nudo)', async () => {
    const pagina = (await AnagraficaPersonalePage({})) as ReactElement
    expect(pagina.type).toBe('main')
    expect(wizardDi(pagina).type).toBe(AnagraficaPersonaleWizard)
  })

  it('⚠️ nessuna SEDE arriva dall’URL: il wizard riceve solo l’intestazione', async () => {
    // Anche se qualcuno costruisse a mano un link con `?sede=`, `?scuola=` o
    // `?plesso=`, la pagina non lo guarda: le uniche proprietà passate al wizard
    // sono quelle dichiarate qui.
    const pagina = await rendiPagina({
      sede: 'aaaaaaaa-0000-4000-8000-00000000000a',
      scuola: 'bbbbbbbb-0000-4000-8000-00000000000b',
      plesso: 'Kidville Cesa',
    })
    const props = wizardDi(pagina).props
    expect(Object.keys(props)).toEqual(['intestazione'])
    expect(JSON.stringify(Object.keys(props))).not.toContain('sede')
  })

  it('e nemmeno il SORGENTE della pagina legge un parametro di sede', async () => {
    // La prova che regge anche se domani qualcuno aggiungesse una proprietà: il
    // difetto nascerebbe copiando `lavora-con-noi/page.tsx`, che quella riga ce
    // l'ha, e la copia si vede nel testo prima che nei props.
    const sorgente = fs.readFileSync(
      path.join(process.cwd(), 'src/app/anagrafica-personale/page.tsx'),
      'utf8',
    )
    // Le occorrenze nei commenti sono la SPIEGAZIONE della scelta e devono
    // restare: si guarda il codice, cioè le righe che non cominciano per `*`,
    // `//` o `{/*`.
    const codice = sorgente
      .split('\n')
      .filter((r) => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(r))
      .join('\n')
    expect(codice).not.toMatch(/\bsp\.(sede|scuola|plesso)\b/)
    expect(codice).not.toMatch(/\bsedeId\s*=/)
  })
})

describe('/anagrafica-personale — i metadati e il prefisso pubblico', () => {
  it('titolo e descrizione vengono dal catalogo, non da una stringa cablata', async () => {
    const meta = await generateMetadata()
    expect(meta.title).toBe(itPublic.persMetaTitolo)
    expect(meta.description).toBe(itPublic.persMetaDescrizione)
    // …e non sono il nome della chiave, che è ciò che si vedrebbe se il namespace
    // fosse sbagliato.
    expect(String(meta.title)).not.toContain('public.')
  })

  it('la pagina è raggiungibile SENZA sessione, e la sua rotta di invio pure', () => {
    expect(isPublicPath('/anagrafica-personale')).toBe(true)
    expect(isPublicPath('/api/iscrizione/personale')).toBe(true)
    expect(isPublicPath('/api/iscrizione/personale/upload')).toBe(true)
    // Il controllo negativo: senza di esso questa asserzione sarebbe verde anche
    // su un `isPublicPath` che risponde `true` a tutto.
    expect(isPublicPath('/admin/personale')).toBe(false)
  })

  it('il prefisso pubblico protegge una pagina che ESISTE davvero', () => {
    // È la stessa domanda del lock `prefissi-pubblici`, fatta per nome su questa
    // rotta: una voce in `PUBLIC_PREFIXES` può sopravvivere alla cosa che
    // giustificava, ed è già successo due volte in questo repo.
    expect(fs.existsSync(path.join(process.cwd(), 'src/app/anagrafica-personale/page.tsx'))).toBe(true)
  })
})
