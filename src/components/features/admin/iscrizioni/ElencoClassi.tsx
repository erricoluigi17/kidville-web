'use client'

/**
 * ELENCO CLASSI — la schermata da cui il giro di ogni mattina prende la classe.
 *
 * ─── COSA FA VEDERE, E IN QUALE ORDINE ──────────────────────────────────────
 *   1. lo stato: quale foglio è quello vivo, di quando, quante righe
 *   2. le difformità, SUBITO dopo il caricamento e non il giorno che bloccano
 *      un invio: rette vuote, rimandi ciechi, nomi ripetuti, cifre fuori scala
 *   3. il riscarico, che restituisce lo stesso foglio con dentro cosa è successo
 *
 * ─── LE DIFFORMITÀ NON SONO ERRORI ──────────────────────────────────────────
 * Su 338 righe vere, 46 rette risultano «fuori scala» e quasi tutte sono
 * legittime (part-time, sconti, un nido dentro una sezione d'infanzia). Vanno
 * FATTE VEDERE, non bloccate: per questo si dividono in due gruppi — quelle che
 * fermeranno un'iscrizione e quelle che sono solo da guardare — e il conteggio
 * dice quale è quale. Un elenco che grida su tutto è un elenco che non si legge.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Download, Eye, FileSpreadsheet, Loader2, Upload,
} from 'lucide-react'
import { StatCard } from '@/components/ui/cockpit'
import { useSediAttive } from '@/lib/context/sede-context'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'

interface Anomalia {
  genere: string
  classe: string
  rigaExcel: number
  nome: string
  dettaglio: string
}

interface ElencoSede {
  id: string
  scuolaId: string
  nomeFile: string
  righeTotali: number
  caricatoIl: string
  anomalie: Anomalia[]
  perClasse: { classe: string; alunni: number }[]
}

/**
 * I generi DA CORREGGERE, separati da quelli che sono solo da guardare. Non è
 * una sfumatura di colore: senza la distinzione la segreteria vedrebbe «46
 * anomalie» su un foglio in cui a bloccare sono 30 righe, e dedicherebbe lo
 * stesso tempo alle une e alle altre.
 *
 * ─── PERCHÉ UNA MAPPA E NON PIÙ UN INSIEME ──────────────────────────────────
 * Perché non tutti i difetti da correggere fanno la stessa cosa, e scrivere
 * «ferma l'iscrizione» su tutti sarebbe una bugia con una conseguenza pratica.
 *
 * `classe-senza-sezione` NON ferma niente: l'iscrizione va a buon fine, l'alunno
 * viene creato, e resta senza sezione — invisibile all'appello e a ogni
 * registro. È il difetto PIÙ pericoloso dei cinque proprio perché non si vede,
 * e una segreteria che leggesse «ferma l'iscrizione» aspetterebbe un blocco che
 * non arriva mai.
 *
 * `colonna-senza-classe` non ferma un'iscrizione: ne fa sparire un'intera
 * colonna dal conteggio, cioè dei bambini che non entrano proprio nell'elenco.
 */
const DA_CORREGGERE: Record<string, string> = {
  'nome-mancante': 'ferma l’iscrizione',
  'retta-mancante': 'ferma l’iscrizione',
  'retta-non-numerica': 'ferma l’iscrizione',
  'nome-ripetuto': 'ferma l’iscrizione',
  'classe-senza-sezione': 'il bambino resta senza sezione',
  'colonna-senza-classe': 'questi alunni non entrano nell’elenco',
}
const daCorreggere = (genere: string): boolean => genere in DA_CORREGGERE

export function ElencoClassi() {
  const { reFetchKey, sedi } = useSediAttive()
  const [elenchi, setElenchi] = useState<ElencoSede[]>([])
  const [caricando, setCaricando] = useState(true)
  const [inCorso, setInCorso] = useState<string | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const [esito, setEsito] = useState<string | null>(null)
  const [aperta, setAperta] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [sedeDelCaricamento, setSedeDelCaricamento] = useState<string | null>(null)

  // La lettura vive FUORI dal componente (`leggiElenchi`, in fondo al file) e non
  // lancia mai: qui restano solo `setState` DOPO un await, dentro un try/finally.
  // È la forma che `react-hooks/set-state-in-effect` accetta — nel gate è un
  // errore, non un avviso — e non è pignoleria: uno `setState` dentro un `catch`
  // sincrono all'effetto innesca render a cascata. Il log del guasto non si perde,
  // lo scrive `leggiElenchi`.
  const carica = useCallback(async (sediKey: string) => {
    const esito = await leggiElenchi(sediKey)
    try {
      if (esito.ok) {
        setElenchi(esito.elenchi)
        setErrore(null)
      } else {
        setErrore(esito.errore)
      }
    } finally {
      setCaricando(false)
    }
  }, [])

  useEffect(() => { void carica(reFetchKey) }, [carica, reFetchKey])

  function scegliFile(scuolaId: string) {
    setSedeDelCaricamento(scuolaId)
    setEsito(null)
    setErrore(null)
    inputRef.current?.click()
  }

  async function inviaFile(file: File) {
    const scuolaId = sedeDelCaricamento
    if (!scuolaId) return
    setInCorso(scuolaId)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(`/api/admin/iscrizioni/elenco?scuola_id=${encodeURIComponent(scuolaId)}`, {
        method: 'POST',
        body,
      })
      if (!res.ok) {
        setErrore((await erroreDaRisposta(res, 'Non è stato possibile caricare l’elenco')).testo)
        return
      }
      const json = await res.json()
      const bloccanti = (json?.anomalie as Anomalia[] | undefined)?.filter((a) => daCorreggere(a.genere)).length ?? 0
      setEsito(
        bloccanti > 0
          ? `Elenco caricato: ${json?.righeTotali ?? 0} alunni. ${bloccanti} righe da correggere prima del giro di domani.`
          : `Elenco caricato: ${json?.righeTotali ?? 0} alunni, nessuna riga bloccante.`,
      )
      setAperta(scuolaId)
      await carica(reFetchKey)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `elenco-classi-caricamento-invio-fallito: ${nomeErrore(e)}`,
        route: '/admin/modulistica',
      })
      setErrore('Non è stato possibile caricare l’elenco')
    } finally {
      setInCorso(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const perSede = new Map(elenchi.map((e) => [e.scuolaId, e]))
  const totaleRighe = elenchi.reduce((n, e) => n + e.righeTotali, 0)
  const totaleBloccanti = elenchi.reduce(
    (n, e) => n + e.anomalie.filter((a) => daCorreggere(a.genere)).length, 0,
  )
  const totaleDaGuardare = elenchi.reduce(
    (n, e) => n + e.anomalie.filter((a) => !daCorreggere(a.genere)).length, 0,
  )

  if (caricando) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[40vh] gap-3">
        <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
        <p className="font-maven text-kidville-sub">Caricamento…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        aria-label="Scegli il foglio delle classi"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void inviaFile(f)
        }}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={FileSpreadsheet} label="Elenchi attivi" value={elenchi.length} />
        <StatCard icon={CheckCircle2} label="Alunni in elenco" value={totaleRighe} />
        <StatCard icon={AlertTriangle} label="Righe da correggere" value={totaleBloccanti} />
        <StatCard icon={Eye} label="Righe da guardare" value={totaleDaGuardare} />
      </div>

      {errore && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-kidville-error-soft border border-kidville-error/30">
          <AlertTriangle className="w-4 h-4 text-kidville-error-strong flex-shrink-0 mt-0.5" />
          <p className="text-sm text-kidville-error-strong font-maven">{errore}</p>
        </div>
      )}
      {esito && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-kidville-success-soft border border-kidville-success/30">
          <CheckCircle2 className="w-4 h-4 text-kidville-success-strong flex-shrink-0 mt-0.5" />
          <p className="text-sm text-kidville-success-strong font-maven">{esito}</p>
        </div>
      )}

      {sedi.map((s) => {
        const e = perSede.get(s.id)
        const bloccanti = e?.anomalie.filter((a) => daCorreggere(a.genere)) ?? []
        const daGuardare = e?.anomalie.filter((a) => !daCorreggere(a.genere)) ?? []
        return (
          <div key={s.id} className="bg-white rounded-card border border-kidville-line p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-maven font-semibold text-kidville-ink">{s.nome}</h3>
                {e ? (
                  <p className="text-sm text-kidville-sub font-maven">
                    {e.righeTotali} alunni in {e.perClasse.length} classi · caricato il{' '}
                    {new Date(e.caricatoIl).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}
                  </p>
                ) : (
                  <p className="text-sm text-kidville-sub font-maven">
                    Nessun elenco caricato: per questa sede il giro automatico non assegna nessuna classe.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => scegliFile(s.id)}
                  disabled={inCorso !== null}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-kidville-green text-white text-sm font-medium hover:opacity-90 transition-all disabled:opacity-50"
                >
                  {inCorso === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {e ? 'Sostituisci elenco' : 'Carica elenco'}
                </button>
                {e && (
                  <a
                    href={`/api/admin/iscrizioni/elenco/export?scuola_id=${encodeURIComponent(s.id)}`}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-kidville-line text-kidville-ink text-sm font-medium hover:bg-kidville-cream transition-all"
                  >
                    <Download className="w-4 h-4" />
                    Scarica con gli esiti
                  </a>
                )}
              </div>
            </div>

            {e && (bloccanti.length > 0 || daGuardare.length > 0) && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setAperta(aperta === s.id ? null : s.id)}
                  className="flex items-center gap-2 text-sm font-maven text-kidville-ink hover:underline"
                >
                  <AlertTriangle className="w-4 h-4 text-kidville-warn-strong" />
                  {bloccanti.length} da correggere · {daGuardare.length} da guardare
                  <span className="text-kidville-sub">{aperta === s.id ? '(nascondi)' : '(mostra)'}</span>
                </button>

                {aperta === s.id && (
                  <div className="overflow-x-auto rounded-xl border border-kidville-line">
                    <table className="w-full text-sm font-maven">
                      <thead>
                        <tr className="bg-kidville-cream text-left">
                          <th className="px-3 py-2 font-medium text-kidville-sub">Classe</th>
                          <th className="px-3 py-2 font-medium text-kidville-sub">Riga</th>
                          <th className="px-3 py-2 font-medium text-kidville-sub">Cosa non torna</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...bloccanti, ...daGuardare].map((a) => (
                          <tr key={`${a.classe}-${a.rigaExcel}-${a.genere}`} className="border-t border-kidville-line">
                            <td className="px-3 py-2 whitespace-nowrap">{a.classe}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{a.rigaExcel}</td>
                            <td className="px-3 py-2">
                              {daCorreggere(a.genere) && (
                                <span className="inline-block mr-2 px-2 py-0.5 rounded-full text-xs bg-kidville-error-soft text-kidville-error-strong">
                                  {DA_CORREGGERE[a.genere]}
                                </span>
                              )}
                              {a.dettaglio}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <p className="text-xs text-kidville-sub font-maven leading-relaxed">
        Vanno bene due modi di preparare il foglio, e li riconosce da solo. <strong>Un foglio di lavoro per
        classe</strong>: il nome del foglio è la classe, la colonna A il nome dell’alunno e la colonna B la
        retta. Oppure <strong>le classi affiancate in un foglio solo</strong>: il nome della classe nella
        prima riga, sopra la colonna dei suoi alunni, e la retta nella colonna subito a fianco. In entrambi
        i casi la retta è una cifra oppure «vedi fratello». Formato .xlsx o .xls, fino a {LIMITE_UPLOAD_MB} MB.
        Caricando un nuovo elenco quello precedente viene sostituito.
      </p>
    </div>
  )
}

/**
 * La lettura degli elenchi. NON LANCIA MAI, e non tocca lo stato di React: è
 * questo che permette al componente di aggiornarsi solo dopo un await, dentro un
 * try/finally, come `react-hooks/set-state-in-effect` pretende.
 *
 * Il guasto si logga QUI: spostarlo fuori dal componente non deve significare
 * perderlo — «non ha caricato niente» e «non ci ha nemmeno provato» devono
 * restare due cose distinte anche fra sei mesi.
 */
async function leggiElenchi(
  sediKey: string,
): Promise<{ ok: true; elenchi: ElencoSede[] } | { ok: false; errore: string }> {
  try {
    const res = await fetch('/api/admin/iscrizioni/elenco', { headers: { 'x-sedi': sediKey } })
    if (!res.ok) {
      const e = await erroreDaRisposta(res, 'Non e stato possibile leggere gli elenchi')
      return { ok: false, errore: e.testo }
    }
    const json = await res.json()
    return { ok: true, elenchi: Array.isArray(json?.elenchi) ? (json.elenchi as ElencoSede[]) : [] }
  } catch (e) {
    logClient({
      livello: 'error',
      evento: 'react',
      messaggio: `elenco-classi-caricamento-fallito: ${nomeErrore(e)}`,
      route: '/admin/modulistica',
    })
    return { ok: false, errore: 'Non e stato possibile leggere gli elenchi' }
  }
}
