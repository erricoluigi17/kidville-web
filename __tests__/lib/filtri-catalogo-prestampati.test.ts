import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'
import {
  campiCatalogo,
  famigliaDi,
  type VoceCatalogo,
} from '@/components/features/prestampati/filtri-catalogo'
import { filtraRighe, valoriIniziali } from '@/lib/ui/filtri/motore'
import { ordinaPerRicerca } from '@/lib/ui/opzioni-filtro'
import type { CampoFiltro, ValoriFiltri } from '@/lib/ui/filtri/tipi'

/**
 * IL CATALOGO DEI DICIASSETTE — i filtri della griglia dei prestampati.
 *
 * ─── PERCHÉ SI PROVA QUI E NON SOLO MONTANDO IL PANNELLO ────────────────────────
 *
 * I descrittori sono una funzione pura di `t` e delle righe: si possono provare senza React,
 * senza fetch e senza jsdom, e questo è il posto in cui si misura la SEMANTICA — quale riga
 * passa e quale no. Il pannello, montato, misura un'altra cosa: che la barra si disegni e che
 * la griglia si accorci. Due domande diverse, due banchi diversi.
 *
 * ⚠️ I testi si prendono dai cataloghi VERI con il formattatore ICU vero, non si ricopiano a
 * mano: una prova che ripete la stringa attesa resta verde anche quando il catalogo cambia
 * sotto — ed è il difetto che `admin-modulistica-linguette` ha già pagato una volta.
 */

const RADICE = process.cwd()
const leggi = (ns: string) =>
  JSON.parse(readFileSync(join(RADICE, `messages/it/${ns}.json`), 'utf8')) as Record<string, string>

const CATALOGO_MODULISTICA = leggi('adminModulistica')
const CATALOGO_PRESTAMPATI = leggi('prestampatiSegreteria')

const traduttore = (ns: string, messaggi: Record<string, string>) =>
  createTranslator({
    locale: 'it',
    messages: { [ns]: messaggi } as never,
    namespace: ns as never,
    // Una chiave mancante deve far ROSSO qui, non degradare nel proprio nome a schermo.
    onError: (errore) => {
      throw errore
    },
  }) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

const t = traduttore('adminModulistica', CATALOGO_MODULISTICA)
const tPannello = traduttore('prestampatiSegreteria', CATALOGO_PRESTAMPATI)

/**
 * Sei voci d'elenco come le compone `voceElenco()`. Gli slug sono VERI — devono esserlo,
 * perché la famiglia si ricava dal registro e uno slug inventato non ne ha una.
 */
const RIGHE: VoceCatalogo[] = [
  { slug: 'scheda_sanitaria', soggetto: 'alunno', firma: 'otp_genitore', protocollo: 'nessuno', generabile: true },
  { slug: 'delega_ritiro', soggetto: 'alunno', firma: 'otp_due_genitori', protocollo: 'nessuno', generabile: true },
  { slug: 'certificato_iscrizione_frequenza', soggetto: 'alunno', firma: 'legale_rappresentante', protocollo: 'uscita', generabile: true },
  { slug: 'certificato_servizio', soggetto: 'dipendente', firma: 'legale_rappresentante', protocollo: 'uscita', generabile: false },
  { slug: 'stampe_sezione', soggetto: 'sezione', firma: 'nessuna', protocollo: 'nessuno', generabile: true },
  { slug: 'registro_presenze', soggetto: 'sezione', firma: 'nessuna', protocollo: 'nessuno', generabile: false },
]

const nomeModello = (v: VoceCatalogo) => `Modello ${v.slug}`

const campi = (righe: VoceCatalogo[] = RIGHE): CampoFiltro<VoceCatalogo>[] =>
  campiCatalogo(t, tPannello, righe, nomeModello)

/** Applica il motore con i valori di partenza più quelli indicati. */
function filtra(scelte: ValoriFiltri, righe: VoceCatalogo[] = RIGHE): string[] {
  const c = campi(righe)
  return filtraRighe(c, { ...valoriIniziali(c), ...scelte }, righe).map((v) => v.slug)
}

describe('catalogo prestampati — la famiglia si CHIEDE al registro, non si indovina', () => {
  it('ogni slug vero porta la famiglia che il registro gli dà', () => {
    expect(famigliaDi({ slug: 'scheda_sanitaria' })).toBe('genitore')
    expect(famigliaDi({ slug: 'certificato_iscrizione_frequenza' })).toBe('genitore')
    expect(famigliaDi({ slug: 'verbale_infortunio' })).toBe('segreteria')
    expect(famigliaDi({ slug: 'registro_presenze' })).toBe('segreteria')
  })

  it('uno slug che il registro non conosce non ha famiglia: `null`, non un ripiego', () => {
    // Un ripiego su «segreteria» metterebbe un modello sconosciuto dentro un filtro che
    // afferma qualcosa su di lui. `null` lo tiene fuori da entrambe le scelte, che è la sola
    // cosa vera che si può dire.
    expect(famigliaDi({ slug: 'modello_che_non_esiste' })).toBeNull()
    expect(famigliaDi({ slug: '' })).toBeNull()
  })
})

describe('catalogo prestampati — i campi', () => {
  it('sono tutti `client`: l’elenco arriva intero in una lettura sola', () => {
    for (const campo of campi()) expect(campo.dove, `${campo.chiave} non è client`).toBe('client')
  })

  it('ci sono le sei chiavi attese, e nessun’altra', () => {
    expect(campi().map((c) => c.chiave)).toEqual([
      'q',
      'soggetto',
      'famiglia',
      'protocollo',
      'firma',
      'generabili',
    ])
  })

  it('le voci del soggetto usano le PAROLE del pannello, non un secondo glossario', () => {
    // La griglia mostra già «Un bambino» nella pastiglia di ogni modello: due nomi per la
    // stessa cosa nella stessa schermata è il difetto che il lock del glossario sorveglia.
    const soggetto = campi().find((c) => c.chiave === 'soggetto')
    const etichette = soggetto && 'opzioni' in soggetto ? soggetto.opzioni.map((o) => o.etichetta) : []
    expect(etichette).toContain(CATALOGO_PRESTAMPATI.soggettoAlunno)
    expect(etichette).toContain(CATALOGO_PRESTAMPATI.soggettoSezione)
    expect(etichette).toContain(CATALOGO_PRESTAMPATI.soggettoDipendente)
  })

  it('le opzioni nascono dai DATI: un banco che vede solo fogli di sezione non ha il filtro soggetto', () => {
    const soloSezione = RIGHE.filter((r) => r.soggetto === 'sezione')
    const soggetto = campi(soloSezione).find((c) => c.chiave === 'soggetto')
    // Una scelta sola non restringe niente: il campo si azzera e `nascondiSeVuoto` lo toglie.
    expect(soggetto && 'opzioni' in soggetto ? soggetto.opzioni : []).toEqual([])
    expect(soggetto?.nascondiSeVuoto).toBe(true)
  })
})

describe('catalogo prestampati — che cosa passa', () => {
  it('il soggetto separa il bambino, la sezione e il dipendente', () => {
    expect(filtra({ soggetto: 'sezione' })).toEqual(['stampe_sezione', 'registro_presenze'])
    expect(filtra({ soggetto: 'dipendente' })).toEqual(['certificato_servizio'])
  })

  it('la famiglia separa i moduli di famiglia dai fogli dello sportello', () => {
    expect(filtra({ famiglia: 'genitore' })).toEqual([
      'scheda_sanitaria',
      'delega_ritiro',
      'certificato_iscrizione_frequenza',
    ])
    expect(filtra({ famiglia: 'segreteria' })).toEqual([
      'certificato_servizio',
      'stampe_sezione',
      'registro_presenze',
    ])
  })

  it('il protocollo isola i fogli che escono dalla scuola', () => {
    expect(filtra({ protocollo: 'uscita' })).toEqual([
      'certificato_iscrizione_frequenza',
      'certificato_servizio',
    ])
  })

  it('«una firma» e «due firme» restano due cose diverse', () => {
    // È l'unica informazione che il blocco disegnato perde, e per questo il filtro la tiene.
    expect(filtra({ firma: 'otp_genitore' })).toEqual(['scheda_sanitaria'])
    expect(filtra({ firma: 'otp_due_genitori' })).toEqual(['delega_ritiro'])
  })

  it('«solo quelli che posso generare» toglie gli spenti, e spento resta spento', () => {
    expect(filtra({ generabili: true })).toEqual([
      'scheda_sanitaria',
      'delega_ritiro',
      'certificato_iscrizione_frequenza',
      'stampe_sezione',
    ])
    // Interruttore a riposo: non filtra niente, e NON è il suo contrario.
    expect(filtra({ generabili: false })).toHaveLength(RIGHE.length)
  })

  it('i criteri si combinano in AND: ogni scelta in più toglie righe, non ne aggiunge', () => {
    const solo = filtra({ soggetto: 'alunno' })
    const combinato = filtra({ soggetto: 'alunno', protocollo: 'uscita' })
    expect(combinato.length).toBeLessThan(solo.length)
    expect(combinato).toEqual(['certificato_iscrizione_frequenza'])
  })

  it('la ricerca guarda l’etichetta TRADOTTA, non lo slug tecnico', () => {
    // Chi cerca scrive quello che legge. Se la ricerca guardasse lo slug, «Certificato di
    // servizio» non si troverebbe scrivendo «certificato di servizio» ma solo
    // «certificato_servizio», che nessuno digita.
    const nomeVero = (v: VoceCatalogo) =>
      v.slug === 'stampe_sezione' ? 'Stampe di sezione' : `Altro ${v.slug}`
    const c = campiCatalogo(t, tPannello, RIGHE, nomeVero)
    const passate = filtraRighe(c, { ...valoriIniziali(c), q: 'stampe di sezione' }, RIGHE)
    expect(passate.map((v) => v.slug)).toEqual(['stampe_sezione'])
  })
})

describe('catalogo prestampati — l’ordine segue la qualità della corrispondenza', () => {
  it('chi comincia con la parola cercata viene prima di chi la porta in mezzo', () => {
    // È la differenza fra un elenco di pratiche (dove l'ordine è quello della tabella) e un
    // CATALOGO di diciassette voci in griglia: qui l'ordine è la risposta.
    const nomi: Record<string, string> = {
      certificato_servizio: 'Certificato di servizio',
      scheda_sanitaria: 'Richiesta di un certificato sanitario',
      delega_ritiro: 'Delega al ritiro',
    }
    const righe = RIGHE.filter((r) => r.slug in nomi)
    const ordinate = ordinaPerRicerca(righe, 'certificato', (v) => nomi[v.slug])
    expect(ordinate.map((v) => v.slug)).toEqual([
      'certificato_servizio',
      'scheda_sanitaria',
      'delega_ritiro',
    ])
  })
})
