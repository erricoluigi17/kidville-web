import { opzioniDerivate } from '@/lib/ui/filtri/motore'
import type { CampoFiltro, Traduttore } from '@/lib/ui/filtri/tipi'
import { PARAMETRO_RICERCA_ALUNNI } from '@/lib/anagrafiche/docente/ritorno-elenco'
import type { Grado, SezioneElenco, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'

/**
 * I FILTRI DELL'ANAGRAFICA DOCENTE — tutti `dove: 'client'`: l'elenco di una
 * insegnante sono poche decine di righe già in memoria, e anche quello della
 * segreteria resta sotto il migliaio.
 *
 * Le opzioni nascono dai DATI (`opzioniDerivate`), quindi chi monta questi campi lo
 * fa DOPO aver caricato l'elenco: `useFiltri` legge l'indirizzo una volta sola e
 * scarta un valore che non è fra le opzioni.
 *
 * La ricerca per nome è `maiNellUrl`: un nome di bambino non va nell'indirizzo.
 * Sezione e grado si offrono solo se c'è davvero una scelta (più di una voce).
 * Un consenso foto ASSENTE conta come «senza consenso»: per chi sta per pubblicare
 * una foto, è la direzione prudente.
 */

export interface ContestoFiltriAlunni {
  sezioni: readonly SezioneElenco[]
  alunni: readonly VoceElencoAlunno[]
  /** L'etichetta di un allergene nella lingua della pagina (`useAllergeneLabel`). */
  etichettaAllergene: (chiave: string) => string
}

export function campiAlunni(t: Traduttore, contesto: ContestoFiltriAlunni): CampoFiltro<VoceElencoAlunno>[] {
  const { alunni } = contesto
  const nomeSezione = new Map(contesto.sezioni.map((s) => [s.id, s.nome]))
  const ORDINE_GRADI: readonly Grado[] = ['nido', 'infanzia', 'primaria']
  const etichettaGrado: Record<Grado, string> = {
    nido: t('anagraficaGradoNido'),
    infanzia: t('anagraficaGradoInfanzia'),
    primaria: t('anagraficaGradoPrimaria'),
  }
  const etichettaSesso: Record<'M' | 'F', string> = { M: t('anagraficaSessoM'), F: t('anagraficaSessoF') }

  // Sezioni: solo quelle note (mai un uuid come etichetta), nell'ordine dei gruppi dell'elenco.
  const sezioniPerId = new Map(
    opzioniDerivate(alunni, (a) => a.sectionId, { etichettaDi: (id) => nomeSezione.get(id) ?? id }).map((o) => [o.valore, o]),
  )
  const sezioni = contesto.sezioni.flatMap((s) => sezioniPerId.get(s.id) ?? [])
  // Gradi: ordine fisso, non alfabetico (l'alfabeto cambia con la lingua).
  const gradiPerValore = new Map(
    opzioniDerivate(alunni, (a) => a.grado, { etichettaDi: (g) => etichettaGrado[g as Grado] ?? g }).map((o) => [o.valore, o]),
  )
  const gradi = ORDINE_GRADI.flatMap((g) => gradiPerValore.get(g) ?? [])
  const soloSeScelta = <T,>(opzioni: T[]): T[] => (opzioni.length > 1 ? opzioni : [])

  return [
    {
      tipo: 'ricerca',
      chiave: PARAMETRO_RICERCA_ALUNNI,
      etichetta: t('anagraficaFiltroCerca'),
      segnaposto: t('anagraficaFiltroCercaSegnaposto'),
      dove: 'client',
      primario: true,
      maiNellUrl: true,
      testiDi: (a) => [a.nome, a.cognome, `${a.nome} ${a.cognome}`, `${a.cognome} ${a.nome}`],
    },
    {
      tipo: 'multi',
      chiave: 'sezione',
      etichetta: t('anagraficaFiltroSezione'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: soloSeScelta(sezioni),
      valoriDi: (a) => [a.sectionId],
    },
    {
      tipo: 'multi',
      chiave: 'grado',
      etichetta: t('anagraficaFiltroGrado'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: soloSeScelta(gradi),
      valoriDi: (a) => [a.grado],
    },
    {
      tipo: 'interruttore',
      chiave: 'allergie',
      etichetta: t('anagraficaFiltroConAllergie'),
      dove: 'client',
      predicato: (a) => a.haAllergie,
    },
    {
      tipo: 'multi',
      chiave: 'allergene',
      etichetta: t('anagraficaFiltroAllergene'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: opzioniDerivate(alunni, (a) => a.allergeni, { etichettaDi: contesto.etichettaAllergene }),
      valoriDi: (a) => a.allergeni,
    },
    { tipo: 'interruttore', chiave: 'bes', etichetta: t('anagraficaFiltroBes'), dove: 'client', predicato: (a) => a.besDsa },
    {
      tipo: 'interruttore',
      chiave: 'pannolino',
      etichetta: t('anagraficaFiltroPannolino'),
      dove: 'client',
      predicato: (a) => a.usaPannolino,
    },
    {
      tipo: 'interruttore',
      chiave: 'senzaFotoSito',
      etichetta: t('anagraficaFiltroSenzaFotoSito'),
      dove: 'client',
      predicato: (a) => a.consensoFotoSito !== true,
    },
    {
      tipo: 'interruttore',
      chiave: 'senzaFotoSocial',
      etichetta: t('anagraficaFiltroSenzaFotoSocial'),
      dove: 'client',
      predicato: (a) => a.consensoFotoSocial !== true,
    },
    {
      tipo: 'multi',
      chiave: 'anno',
      etichetta: t('anagraficaFiltroAnno'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: opzioniDerivate(alunni, (a) => (a.annoNascita === null ? null : String(a.annoNascita))),
      valoriDi: (a) => (a.annoNascita === null ? [] : [String(a.annoNascita)]),
    },
    {
      tipo: 'multi',
      chiave: 'sesso',
      etichetta: t('anagraficaFiltroSesso'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: opzioniDerivate(alunni, (a) => a.sesso, { etichettaDi: (s) => etichettaSesso[s as 'M' | 'F'] ?? s }),
      valoriDi: (a) => [a.sesso],
    },
  ]
}
