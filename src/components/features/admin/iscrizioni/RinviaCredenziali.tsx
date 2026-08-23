'use client'

/**
 * RIMANDARE LE CREDENZIALI A CHI NON È MAI ENTRATO.
 *
 * ─── PERCHÉ QUESTA SCHERMATA ESISTE ─────────────────────────────────────────
 * Il 22/08 il giro automatico ha creato 67 accessi e spedito 67 email. 37
 * famiglie sono entrate, 30 no, e alcune hanno telefonato. Le password erano
 * valide — quelle che le 30 famiglie hanno in mano sono ancora oggi quelle
 * giuste — ma erano 28 caratteri con `l`, `I` e `1` indistinguibili, da
 * ricopiare a mano da un telefono. Il formato nuovo si detta al telefono; questo
 * pannello lo rimanda a chi era rimasto fuori.
 *
 * ─── PERCHÉ IL CONTEGGIO VIENE PRIMA, E NON SI PUÒ SALTARE ──────────────────
 * Rimandare una password INVALIDA quella precedente: è un gesto che non si
 * disfa. Il pulsante che spedisce compare solo dopo aver visto quante persone
 * riceverebbero — non è una conferma di cortesia, è l'unico momento in cui si
 * può accorgersi che il numero è diverso da quello che ci si aspettava.
 *
 * Chi è già entrato non compare in quel numero e non viene toccato, nemmeno se
 * entra nei minuti fra il conteggio e l'invio: il controllo si rifà per ogni
 * persona un istante prima di toccarle la password.
 */

import { useState } from 'react'
import { KeyRound, Loader2, Send, Users } from 'lucide-react'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'

interface Esito {
    candidati: number
    rimandate: number
    entratiNelFrattempo: number
    saltatiNonGenitore: number
    giaInCorso: number
    falliti: number
    daConsegnareAMano: Array<{ email: string; password: string }>
}

export function RinviaCredenziali() {
    const [contando, setContando] = useState(false)
    const [inviando, setInviando] = useState(false)
    const [quanti, setQuanti] = useState<number | null>(null)
    const [esito, setEsito] = useState<Esito | null>(null)
    const [errore, setErrore] = useState<string | null>(null)

    async function chiama(dryRun: boolean): Promise<Esito | null> {
        setErrore(null)
        try {
            const res = await fetch('/api/admin/iscrizioni/rinvia-credenziali', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ dry_run: dryRun }),
            })
            if (!res.ok) {
                const e = await erroreDaRisposta(res, 'Non è stato possibile rimandare le credenziali')
                setErrore(e.testo)
                return null
            }
            return (await res.json()) as Esito
        } catch (e) {
            // Un `catch` che non logga è un bug (regola 6 di AGENTS.md): qui la
            // richiesta non è mai partita, e il server per definizione non lo vede.
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `rinvio credenziali non partito — errore=${nomeErrore(e)}`,
                route: '/admin/modulistica',
            })
            setErrore('La richiesta non è partita. Controlla la connessione e riprova.')
            return null
        }
    }

    async function conta() {
        setContando(true)
        setEsito(null)
        try {
            const r = await chiama(true)
            if (r) setQuanti(r.candidati)
        } finally {
            setContando(false)
        }
    }

    async function rimanda() {
        setInviando(true)
        try {
            const r = await chiama(false)
            if (r) {
                setEsito(r)
                setQuanti(null)
            }
        } finally {
            setInviando(false)
        }
    }

    return (
        <div className="rounded-2xl border border-kidville-line bg-white p-5 space-y-4">
            <div className="flex items-start gap-3">
                <KeyRound className="h-5 w-5 text-kidville-green shrink-0 mt-0.5" aria-hidden />
                <div>
                    <h3 className="font-maven font-bold text-kidville-ink">Rimanda le credenziali</h3>
                    <p className="text-sm text-kidville-sub font-maven leading-relaxed mt-1">
                        Le rimanda <strong>solo a chi non è mai entrato</strong>, con il formato nuovo, più
                        semplice da ricopiare da un telefono. Chi è già entrato non viene toccato: la sua
                        password continua a funzionare.
                    </p>
                </div>
            </div>

            {errore && (
                <p role="alert" className="text-sm font-maven text-red-700 bg-red-50 rounded-xl px-3 py-2">
                    {errore}
                </p>
            )}

            {quanti !== null && !esito && (
                <div className="rounded-xl bg-kidville-cream px-4 py-3 space-y-3">
                    <p className="text-sm font-maven text-kidville-ink">
                        {quanti === 0 ? (
                            <>Non c’è nessuno a cui rimandarle: sono entrati tutti.</>
                        ) : (
                            <>
                                Riceverebbero una password nuova <strong>{quanti}</strong>{' '}
                                {quanti === 1 ? 'persona' : 'persone'}. Quella che hanno adesso smetterà di
                                funzionare.
                            </>
                        )}
                    </p>
                    {quanti > 0 && (
                        <button
                            type="button"
                            onClick={rimanda}
                            disabled={inviando}
                            className="inline-flex items-center gap-2 rounded-xl bg-kidville-green px-4 py-2 text-white font-maven font-bold disabled:opacity-60"
                        >
                            {inviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                            {inviando ? 'Invio in corso…' : `Rimanda a ${quanti}`}
                        </button>
                    )}
                </div>
            )}

            {esito && (
                <div className="rounded-xl bg-kidville-cream px-4 py-3 space-y-2 text-sm font-maven text-kidville-ink">
                    <p><strong>{esito.rimandate}</strong> credenziali rimandate.</p>
                    {esito.entratiNelFrattempo > 0 && (
                        <p className="text-kidville-sub">
                            {esito.entratiNelFrattempo} {esito.entratiNelFrattempo === 1 ? 'persona è entrata' : 'persone sono entrate'}{' '}
                            mentre stavamo per rimandarle: non {esito.entratiNelFrattempo === 1 ? 'è stata toccata' : 'sono state toccate'}.
                        </p>
                    )}
                    {esito.falliti > 0 && (
                        <p className="text-red-700">{esito.falliti} non {esito.falliti === 1 ? 'è partita' : 'sono partite'}.</p>
                    )}
                    {esito.daConsegnareAMano.length > 0 && (
                        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 space-y-1">
                            {/*
                              * L'email non è partita, ma la password è già stata cambiata: quella
                              * vecchia non funziona più e la nuova non la sa nessuno. Sta qui, una
                              * volta sola, perché chi ha premuto ha la famiglia al telefono adesso.
                              */}
                            <p className="font-bold text-amber-900">
                                Queste vanno dette a voce: l’email non è partita, ma la password è già cambiata.
                            </p>
                            <ul className="space-y-1">
                                {esito.daConsegnareAMano.map((c) => (
                                    <li key={c.email} className="font-mono text-xs text-amber-900">
                                        {c.email} → {c.password}
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs text-amber-800">
                                Non restano scritte da nessuna parte: chiudendo questa pagina spariscono.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {!esito && quanti === null && (
                <button
                    type="button"
                    onClick={conta}
                    disabled={contando}
                    className="inline-flex items-center gap-2 rounded-xl border border-kidville-line px-4 py-2 font-maven font-bold text-kidville-ink disabled:opacity-60"
                >
                    {contando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />}
                    {contando ? 'Sto contando…' : 'Vedi a quanti servirebbe'}
                </button>
            )}
        </div>
    )
}
