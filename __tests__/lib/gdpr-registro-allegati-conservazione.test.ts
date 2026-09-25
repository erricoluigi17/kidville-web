import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRO_BUCKET_OBLIO } from '@/lib/gdpr/esegui'
import { JOB_CRON } from '@/lib/health/controlli'
import { GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO } from '@/lib/primaria/cestino-registro'
import { BUCKET_ALLEGATI_REGISTRO } from '@/lib/primaria/allegati-registro'

// =============================================================================
// `registro-allegati` NEL REGISTRO DELL'OBLIO: la lacuna chiusa il 2026-09-25.
//
// Fino a quel giorno la voce era `escluso` con un motivo che si dichiarava da solo
// «LACUNA APERTA»: nessun termine di conservazione, e l'unico meccanismo che
// svuotava il bucket era il cestino, solo per ciò che qualcuno aveva eliminato.
// Il titolare l'ha chiusa con un termine — 365 giorni dal CARICAMENTO, vivi e
// cestinati — e la voce è diventata `coperto-fuori-oblio`.
//
// Il registro dichiara chi svuota il magazzino, non verifica che lo svuoti (lo dice
// il tipo `CoperturaBucket`). Questo file tiene la dichiarazione AGGANCIATA al
// meccanismo: se la purga perde il contenitore, se il job non è più sorvegliato,
// se il termine cambia e la frase no, la dichiarazione diventa falsa e qui è rosso.
// La prova che il meccanismo svuoti davvero sta accanto al meccanismo:
// `__tests__/api/gdpr-retention-cestino-registro.test.ts`.
// =============================================================================

const RADICE = join(__dirname, '..', '..')
const ROUTE = 'src/app/api/gdpr/retention-cestino-registro/route.ts'
const leggi = (rel: string) => readFileSync(join(RADICE, rel), 'utf8')

describe('registro dell’oblio · `registro-allegati` è coperto dalla conservazione', () => {
  const voce = REGISTRO_BUCKET_OBLIO[BUCKET_ALLEGATI_REGISTRO]

  it('la voce esiste sotto il nome del bucket in cui si carica, ed è `coperto-fuori-oblio`', () => {
    expect(voce, `\`REGISTRO_BUCKET_OBLIO\` non nomina più \`${BUCKET_ALLEGATI_REGISTRO}\``).toBeDefined()
    expect(
      voce.stato,
      'dal 2026-09-25 il bucket ha un termine di conservazione deciso dal titolare: non è più una ' +
        'lacuna «esclusa», è un magazzino che svuota la conservazione',
    ).toBe('coperto-fuori-oblio')
  })

  it('la motivazione cita la decisione, la costante, il termine VERO e la route che lo applica', () => {
    if (voce.stato !== 'coperto-fuori-oblio') throw new Error('stato inatteso')
    expect(voce.come).toMatch(/TITOLARE DEL 2026-09-25/)
    expect(voce.come).toContain('GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO')
    expect(voce.come).toContain('POST /api/gdpr/retention-cestino-registro')
    // Il numero scritto in prosa deve essere quello che la purga applica: se la
    // costante cambia e la frase no, il registro dice il falso a chi lo legge.
    const inProsa = [...voce.come.matchAll(/(\d+)\s+giorni\s+(?:dopo il|dal)\s+caricamento/gi)].map((m) => Number(m[1]))
    expect(inProsa.length, 'la motivazione non dichiara più il termine «N giorni dal caricamento»').toBeGreaterThan(0)
    for (const n of inProsa) expect(n).toBe(GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO)
  })

  it('il job che la motivazione nomina è quello della route, ed è sorvegliato da /api/health', () => {
    if (voce.stato !== 'coperto-fuori-oblio') throw new Error('stato inatteso')
    const job = leggi(ROUTE).match(/const JOB = '([^']+)'/)?.[1]
    expect(job).toBeTruthy()
    expect(voce.come).toContain(`\`${job}\``)
    expect(
      JOB_CRON.some((j) => j.nome === job),
      `\`${job}\` non è in \`JOB_CRON\`: la motivazione dice «sorvegliato da /api/health» e non lo è più`,
    ).toBe(true)
  })

  it('la route ha davvero il contenitore `conservazione`, sul bucket degli allegati, col termine della costante', () => {
    const route = leggi(ROUTE)
    const blocco = route.slice(route.indexOf("chiave: 'conservazione'"))
    expect(route.indexOf("chiave: 'conservazione'"), 'la purga non ha più il contenitore della conservazione').toBeGreaterThan(0)
    const fine = blocco.indexOf("chiave: '", 1)
    const soloLui = fine === -1 ? blocco : blocco.slice(0, fine)
    expect(soloLui).toMatch(/bucket:\s*BUCKET_ALLEGATI_REGISTRO\b/)
    expect(soloLui).toMatch(/giorni:\s*GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO\b/)
    expect(soloLui).toMatch(/sogliaConservazioneAllegatiRegistro\(/)
    expect(soloLui).toMatch(/\.lt\(\s*'creato_il'\s*,\s*soglia\s*\)/)
  })
})
