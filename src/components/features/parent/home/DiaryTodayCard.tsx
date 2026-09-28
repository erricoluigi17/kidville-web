'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { BookOpen, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { useDateFormat } from '@/lib/i18n/date'
import { voceDaMostrare } from '@/lib/diary/registrazione'
import { useEventLabel } from '@/components/features/teacher/diary/eventConfig'
import { eRoutinePersonalizzata, oraRoutine } from '@/lib/diary/routine'
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile'
import { segnalaDiarioNonLetto } from '@/lib/diary/lettura-genitore'

interface Entry {
  id: string
  tipo_evento: string
  timestamp_evento: string
  note?: string | null
  // La nota del SINGOLO bambino (E1): tiene in piedi la voce come quella di sezione. Prima la card
  // la ignorava, e una routine tenuta in piedi solo da lei compariva nella pagina del diario ma
  // non qui («nessun aggiornamento») — 2026-09-28.
  notaBambino?: string | null
  // Serve a `voceDaMostrare`: senza, «Bagno» ricomparirebbe in home anche dopo la
  // correzione, perché qui si stampa il `tipo_evento` grezzo senza guardare cosa
  // c'è dentro. La GET del genitore lo restituisce già.
  dettagli?: Record<string, unknown> | null
}

interface Props {
  studentId: string
  href: string
}

/**
 * "Oggi a scuola" del design (DR DiaryToday). Mostra gli ultimi aggiornamenti del
 * diario di oggi. Dato esistente: GET /api/diary/entries?alunno_id=&from=&to=
 * (sola lettura). Si nasconde se non ci sono eventi oggi.
 */
/**
 * Dopo un ritorno nell'app andato a vuoto si riprova una volta dopo questo tempo. Misurato il
 * 2026-09-28: in 14 giorni la lettura del diario è fallita a stato 0 967 volte, per ~220 utenti.
 */
const RITENTA_DOPO_MS = 4_000

/** Ciò che la card mostra, e di quale figlio e di quale giorno è. `entries: null` = non letto. */
interface Mostrato {
  studente: string
  entries: Entry[] | null
}

export function DiaryTodayCard({ studentId, href }: Props) {
  const t = useTranslations('home')
  // L'etichetta di ogni voce è quella della pagina del diario (2026-09-28). Qui si maiuscolava il
  // codice del tipo (`titleCase`): «Nanna inizio», «Attivita» senza accento, e per le routine
  // della scuola sarebbe uscito «Routine:a1b2c3d4». Le routine della scuola si chiamano col nome
  // salvato nella voce.
  const eventLabel = useEventLabel()
  const { ora: fmtTime } = useDateFormat()
  const [mostrato, setMostrato] = useState<Mostrato | null>(null)
  // Dal 2026-09-28 la card si rilegge anche al ritorno nell'app. Tre regole la tengono vera,
  // le stesse della pagina del diario:
  //  · scrive solo l'ultima lettura partita (`ultimaLettura`): una lettura lenta del figlio di
  //    prima non scrive sopra quello di adesso;
  //  · un ritorno mentre la stessa lettura è in volo la aspetta (`inVolo`), invece di
  //    scavalcarla e — se falliva — buttare via la risposta buona che stava arrivando;
  //  · al ritorno una lettura fallita lascia la card com'è, ma solo se a schermo c'è proprio
  //    QUEL figlio e QUEL giorno (`aSchermo`): cambiato figlio, o passata la mezzanotte, le
  //    voci a schermo non sono più «di oggi» di nessuno.
  const ultimaLettura = useRef(0)
  const aSchermo = useRef<string | null>(null)
  const inVolo = useRef<{ chiave: string; numero: number; esito: Promise<boolean> } | null>(null)

  /** `true` se le voci sono arrivate; `false` se no — il ritorno nell'app allora riprova. */
  const carica = useCallback(({ ricarica = false }: { ricarica?: boolean } = {}): Promise<boolean> => {
    if (!studentId) return Promise.resolve(true)
    const today = new Date().toISOString().split('T')[0]
    const chiave = `${studentId}:${today}`
    if (ricarica && inVolo.current?.chiave === chiave) return inVolo.current.esito
    const numero = ++ultimaLettura.current

    const esito = (async (): Promise<boolean> => {
      let voci: Entry[] | null = null
      try {
        const r = await fetch(`/api/diary/entries?alunno_id=${studentId}&from=${today}&to=${today}`)
        const d: unknown = r.ok ? await r.json() : null
        // Si filtra UNA volta sola, appena arrivano: da `entries` dipendono tre
        // cose che altrimenti mentirebbero in tre modi diversi — lo stato vuoto,
        // l'ora di «aggiornato alle» (che poteva essere quella di una riga vuota)
        // e l'elenco, che stampa il `tipo_evento` grezzo.
        if (Array.isArray(d)) {
          voci = (d as Entry[]).filter(e => voceDaMostrare(e.tipo_evento, e.dettagli, { conNota: Boolean(e.note || e.notaBambino) }))
        }
      } catch {
        // Rete giù o corpo illeggibile: `voci` resta null, e qui sotto diventa l'avviso
        // d'errore (o la card tenuta com'è) più la riga di `segnalaDiarioNonLetto`. Il guasto
        // di rete in sé lo registra già la fetch strumentata.
      }
      if (inVolo.current?.numero === numero) inVolo.current = null
      if (numero !== ultimaLettura.current) return true
      if (voci === null) {
        segnalaDiarioNonLetto('card', ricarica ? 'ricarica' : 'apertura')
        if (ricarica && aSchermo.current === chiave) return false
      }
      aSchermo.current = chiave
      setMostrato({ studente: studentId, entries: voci })
      return voci !== null
    })()
    inVolo.current = { chiave, numero, esito }
    return esito
  }, [studentId])

  useEffect(() => {
    void carica()
    const letture = ultimaLettura
    // Allo smontaggio (o al cambio di figlio) nessuna lettura in volo scrive più.
    return () => { letture.current++ }
  }, [carica])

  // Al ritorno nell'app si rilegge (2026-09-28): aperta al mattino, la card diceva «Ancora
  // nessun aggiornamento del diario per oggi» per tutto il giorno, con le voci già scritte.
  // `null` = nessun orologio, solo la riapertura; se non arriva niente si riprova una volta.
  usePollingVisibile(() => carica({ ricarica: true }), null, { ritentaDopoMs: RITENTA_DOPO_MS })

  // Finché non è arrivata la prima lettura di QUESTO figlio la card non c'è, come prima: mai
  // le voci del figlio di prima sotto il nome di quello nuovo.
  if (!mostrato || mostrato.studente !== studentId) return null

  // Il diario non si è letto: lo si dice. Fino al 2026-09-28 qui finiva «Ancora nessun
  // aggiornamento del diario per oggi», la frase che accusava la maestra.
  if (mostrato.entries === null) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] bg-kidville-green-soft text-kidville-green">
          <BookOpen size={20} strokeWidth={1.8} />
        </span>
        <p className="min-w-0 flex-1 font-maven text-[13px] text-kidville-sub">{t('diaryNonLetto')}</p>
        <button
          type="button"
          onClick={() => { void carica({ ricarica: true }) }}
          className="flex-shrink-0 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green"
        >
          {t('diaryRiprova')}
        </button>
      </Card>
    )
  }

  const entries = mostrato.entries

  if (entries.length === 0) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] bg-kidville-green-soft text-kidville-green">
          <BookOpen size={20} strokeWidth={1.8} />
        </span>
        <p className="font-maven text-[13px] text-kidville-muted">{t('diaryVuoto')}</p>
      </Card>
    )
  }

  const items = entries.slice(0, 3)
  const updated = fmtTime(entries[0].timestamp_evento)

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-kidville-line px-4 py-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] bg-kidville-green text-kidville-yellow">
          <BookOpen size={21} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-barlow text-[17px] font-black uppercase leading-none text-kidville-green">
            {t('titoloOggiAScuola')}
          </p>
          {updated && <p className="mt-0.5 font-maven text-[11.5px] text-kidville-muted">{t('diaryAggiornato', { ora: updated })}</p>}
        </div>
      </div>

      <div className="px-4 py-2">
        {items.map((ev, i) => (
          <div key={ev.id} className="flex gap-3 py-2">
            <div className="flex flex-col items-center">
              <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green">
                <BookOpen size={16} strokeWidth={1.8} />
              </div>
              {i < items.length - 1 && <div className="mt-1 w-0.5 flex-1 bg-kidville-line" />}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 break-words font-barlow text-[13.5px] font-extrabold uppercase tracking-wide text-kidville-green">
                  {ev.tipo_evento ? eventLabel(ev.tipo_evento, ev.dettagli) : t('diaryAggiornamentoDefault')}
                </span>
                {/* Una routine della scuola a orario: l'ora SEGNATA, non quella del salvataggio. */}
                <span className="font-maven text-[11px] text-kidville-muted">
                  {(eRoutinePersonalizzata(ev.tipo_evento) ? oraRoutine(ev.dettagli) : null) ?? fmtTime(ev.timestamp_evento)}
                </span>
              </div>
              {/* `text-kidville-sub` e non l'hex letterale `#55615c`: stesso colore, ma
                  l'hex scritto a mano resta fuori dall'inventario dei token e dalle
                  rimappature per-superficie dell'Alto Contrasto, che agiscono sul nome
                  della classe. */}
              {ev.note && (
                <p className="mt-0.5 break-words font-maven text-[12.8px] leading-snug text-kidville-sub">{ev.note}</p>
              )}
              {ev.notaBambino && (
                <p className="mt-0.5 break-words font-maven text-[12.8px] leading-snug text-kidville-sub">{ev.notaBambino}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <Link
        href={href}
        className="flex items-center justify-center gap-1.5 border-t border-kidville-line py-3 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green"
      >
        {t('diaryApriCompleto')}
        <ChevronRight size={16} strokeWidth={2.2} />
      </Link>
    </Card>
  )
}
