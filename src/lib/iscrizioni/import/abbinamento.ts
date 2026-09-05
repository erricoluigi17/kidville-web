/**
 * Trovare la classe di un bambino: la si CERCA nell'elenco, non la si deduce.
 *
 * ─── LA REGOLA, PRIMA DEL CODICE ────────────────────────────────────────────
 * La classe non si decide dalla data di nascita. Si cerca il bambino nell'elenco
 * che la segreteria ha preparato: il foglio in cui compare È la sua classe, e la
 * retta è quella scritta accanto al suo nome.
 *
 * Tre esiti, e nessun quarto:
 *   · UNICO    una sola riga corrisponde  → si procede
 *   · AMBIGUO  due o più                  → non si sceglie, si chiede
 *   · ASSENTE  nessuna                    → non si inventa, si chiede
 *
 * ─── PERCHÉ NON C'È UNA SOGLIA DI SOMIGLIANZA ───────────────────────────────
 * Sarebbe comodo dire «se somigliano al 90% è lui». Sul file vero di Giugliano
 * quella soglia avrebbe abbinato `SALICETTI EMNA` a `Salicetti Emma` (giusto) ma
 * anche `PIOVANELLI GRETA` a `Povanelli Greta` e `SHERMONI` a `Schermoni` — tutti refusi
 * che qualcuno deve correggere UNA VOLTA nel file, invece che vederli sopravvivere
 * per sempre dentro un algoritmo che li perdona in silenzio. E soprattutto: la
 * stessa soglia, su due fratelli con nomi simili, sbaglia bambino.
 *
 * Quindi si abbina solo per UGUAGLIANZA, provata in tre forme che sono la stessa
 * scrittura in tre modi (§`normalizza.ts`):
 *   1. il nome normalizzato                     `Corbezzi edoardo`    = `CORBEZZI EDOARDO`
 *   2. le stesse parole in ordine diverso       `Zafferani Leonardo`  = `LEONARDO ZAFFERANI`
 *   3. lo stesso nome con gli spazi altrove     `AnnaLucia`           = `ANNA LUCIA`
 *                                               `Del Prato Orzatelli` = `DELPRATO ORZATELLI`
 *
 * Tutto il resto va alla segreteria con i tre nomi più somiglianti allegati:
 * misurato, sono 6 domande su 221 al primo giro, e in cambio nessun bambino
 * finisce nella classe di un altro.
 *
 * (I nomi degli esempi sono INVENTATI: il repository è pubblico. Le forme —
 * refuso, inversione, saldatura — sono quelle misurate sul file vero.)
 */
import { normalizzaNome, senzaSpazi, similitudine, stessiToken, tokenNome } from './normalizza'

/** Una riga dell'elenco di classe, già riversata in tabella dal file Excel. */
export interface RigaElenco {
  id: string
  /** Il nome del foglio: È la classe. */
  classe: string
  /** Il nome come la segreteria l'ha scritto, senza ritocchi. */
  nome: string
  /** La riga del foglio, per far ritrovare il rigo a chi deve correggerlo. */
  riga: number
  /** La cifra, quando c'è. */
  retta: number | null
  /** Il testo, quando al posto della cifra c'è «vedi fratello» o «?». */
  rettaTesto: string | null
}

export type EsitoAbbinamento =
  | { tipo: 'unico'; riga: RigaElenco }
  | { tipo: 'ambiguo'; righe: RigaElenco[] }
  | { tipo: 'assente'; simili: RigaElenco[] }

/** Quanti «forse cercavi» si scrivono nella nota. Tre: una nota più lunga non si legge. */
const SIMILI_NELLA_NOTA = 3

/**
 * Cerca il bambino nell'elenco della sua sede.
 *
 * `nome` e `cognome` arrivano separati dal form; nell'elenco stanno in una
 * colonna sola e non è detto in quale ordine — per questo si prova anche
 * l'insieme delle parole.
 */
export function abbina(
  nome: string | null | undefined,
  cognome: string | null | undefined,
  elenco: readonly RigaElenco[],
): EsitoAbbinamento {
  const cercato = normalizzaNome(`${cognome ?? ''} ${nome ?? ''}`)
  if (!cercato || elenco.length === 0) {
    return { tipo: 'assente', simili: elenco.length === 0 ? [] : piuSimili(cercato, elenco) }
  }

  const perEsatto = elenco.filter((r) => normalizzaNome(r.nome) === cercato)
  if (perEsatto.length > 0) return esito(perEsatto)

  const token = tokenNome(cercato)
  const perToken = elenco.filter((r) => stessiToken(tokenNome(r.nome), token))
  if (perToken.length > 0) return esito(perToken)

  const saldato = senzaSpazi(cercato)
  const perSaldatura = elenco.filter((r) => senzaSpazi(r.nome) === saldato)
  if (perSaldatura.length > 0) return esito(perSaldatura)

  return { tipo: 'assente', simili: piuSimili(cercato, elenco) }
}

function esito(righe: RigaElenco[]): EsitoAbbinamento {
  return righe.length === 1 ? { tipo: 'unico', riga: righe[0] } : { tipo: 'ambiguo', righe }
}

/** I nomi più vicini, per la nota. Serve a far vedere il refuso, non a scegliere. */
function piuSimili(cercato: string, elenco: readonly RigaElenco[]): RigaElenco[] {
  return [...elenco]
    .map((r) => ({ r, s: similitudine(cercato, r.nome) }))
    .sort((a, b) => b.s - a.s || a.r.nome.localeCompare(b.r.nome))
    .slice(0, SIMILI_NELLA_NOTA)
    .map((x) => x.r)
}
