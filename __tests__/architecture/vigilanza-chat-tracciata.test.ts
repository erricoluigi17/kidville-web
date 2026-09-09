import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente } from '../fixtures/sorgente'

// ═════════════════════════════════════════════════════════════════════════════
// LOCK — la vigilanza sulle chat non può leggere di nascosto
// ═════════════════════════════════════════════════════════════════════════════
//
// Le conversazioni fra un genitore e un'insegnante sono private fra i due. La
// segreteria e la Direzione possono aprirle — è una scelta del titolare — e la
// vigilanza è SILENZIOSA: i due interlocutori non vedono nulla, nessun avviso in
// chat. L'unico contrappeso è che ogni lettura lasci una riga nel registro
// `chat_vigilanza_accessi`, che nessuno può cancellare.
//
// Questo lock vieta la forma di codice che ha reso possibile il difetto:
// una route sotto `admin/chat/**` che legge il contenuto dei messaggi senza
// registrarlo. Fino al 2026-09-09 era così `admin/chat/messages:GET`, e in
// trenta giorni ha potuto servire 1.577 messaggi senza lasciare traccia.
//
// ⚠️ SI LEGGE IL CODICE, NON LA PROSA. In questo repo i commenti citano
// abbondantemente il codice che vietano — questa testata ne è un esempio: nomina
// `registraAccessoVigilanza` quattro volte. Un lock che cercasse la stringa nel
// file intero sarebbe verde per colpa dei propri commenti. Da qui
// `mascheraSorgente`, che spegne i commenti senza spostare gli indici.
//
// ⚠️ E IL LOCK COLLAUDA SÉ STESSO. In fondo c'è una FIXTURE NEGATIVA: due
// sorgenti finti, uno conforme e uno no, sui quali la stessa funzione di
// controllo deve dare verdetti opposti. Un lock che non ha mai visto un rosso
// non è un lock: in questo repo è già successo due volte.

const API = path.join(process.cwd(), 'src/app/api')
const DIR_VIGILANZA = path.join(API, 'admin/chat')

/** Legge il CONTENUTO dei messaggi: la tabella, o la funzione di ricerca. */
const LEGGE_MESSAGGI = /\.from\(\s*['"]chat_messages['"]|\.rpc\(\s*['"]chat_vigilanza_ricerca['"]/

/**
 * ⚠️ NON basta che `registraAccessoVigilanza` compaia da qualche parte, e la
 * differenza è costata una contro-prova andata storta: `admin/chat/messages:GET`
 * la chiama DUE volte — una sul ramo «fuori-scope», dentro un `if` che nega e
 * torna indietro, e una sulla strada principale. Cancellando la seconda, la
 * prima restava, la stringa c'era ancora e il lock passava. Una chiamata dentro
 * un ramo non copre l'altro.
 *
 * Quel che conta è la registrazione BLOCCANTE: quella di cui si guarda l'esito.
 * La sua forma è `const { tracciato } = await registraAccessoVigilanza(`, e il
 * ramo «fuori-scope» — che è a perdere, perché si sta già negando — non ce l'ha.
 *
 * ⚠️ E i limiti vanno detti: questo resta un lock di FORMA. Prova che nel file
 * esiste una registrazione bloccante, non che ogni singolo ramo ci passi. Che
 * la riga venga scritta davvero, e che senza di lei il contenuto non esca, lo
 * provano i test di comportamento in
 * `__tests__/api/admin-chat-vigilanza-registro.test.ts`.
 */
const REGISTRA = /const\s*\{\s*tracciato\s*\}\s*=\s*await\s+registraAccessoVigilanza\s*\(/
/** La presenza in qualunque forma: serve alla prova 4, sulla chat del partecipante. */
const REGISTRA_COMUNQUE = /registraAccessoVigilanza\s*\(/
const RIFIUTA = /['"]VIGILANZA_NON_TRACCIABILE['"]/

/** Il verdetto su un sorgente, calcolato sul codice mascherato dai commenti. */
export function violaLaTracciabilita(src: string): { legge: boolean; registra: boolean; rifiuta: boolean; viola: boolean } {
  const { senzaCommenti } = mascheraSorgente(src)
  const legge = LEGGE_MESSAGGI.test(senzaCommenti)
  const registra = REGISTRA.test(senzaCommenti)
  const rifiuta = RIFIUTA.test(senzaCommenti)
  return { legge, registra, rifiuta, viola: legge && !(registra && rifiuta) }
}

const routeDi = (dir: string) => fileSorgente(dir).filter((f) => f.endsWith(path.sep + 'route.ts'))

describe('lock · la vigilanza sulle chat lascia sempre traccia', () => {
  // ── 1. Sanità: se questi numeri vanno a zero, tutto il resto è verde a vuoto.
  it('trova le route della vigilanza dove le cerca', () => {
    const route = routeDi(DIR_VIGILANZA)
    expect(route.length, `nessuna route sotto ${DIR_VIGILANZA}`).toBeGreaterThanOrEqual(4)
    expect(routeDi(API).length, 'albero delle route non trovato').toBeGreaterThan(200)
    // La strada del partecipante deve esistere: la prova 4 si appoggia a lei.
    expect(fs.existsSync(path.join(API, 'chat/messages/route.ts'))).toBe(true)
  })

  // ── 2. Il cuore: chi legge, registra — e se non ci riesce, rifiuta.
  it('ogni route di admin/chat che legge i messaggi registra la lettura e sa negarla', () => {
    const scoperte = routeDi(DIR_VIGILANZA)
      .map((f) => ({ f, v: violaLaTracciabilita(fs.readFileSync(f, 'utf8')) }))
      .filter((x) => x.v.viola)
      .map((x) => {
        const rel = path.relative(process.cwd(), x.f)
        const manca = [!x.v.registra && 'una registrazione BLOCCANTE (`const { tracciato } = await registraAccessoVigilanza(`)', !x.v.rifiuta && 'VIGILANZA_NON_TRACCIABILE']
          .filter(Boolean)
          .join(' + ')
        return `${rel} — legge il contenuto dei messaggi ma manca: ${manca}`
      })
    expect(
      scoperte,
      'Una route di vigilanza che legge il contenuto delle conversazioni DEVE scrivere ' +
        'la riga di registro (`registraAccessoVigilanza`) e DEVE saper rifiutare la ' +
        'lettura quando non ci riesce (`VIGILANZA_NON_TRACCIABILE`). La supervisione è ' +
        'silenziosa per scelta: quella riga è il solo contrappeso. Nessuna allowlist — ' +
        'una voce qui vorrebbe dire «questa route può leggere di nascosto».',
    ).toEqual([])
  })

  // ── 3. Il registro lo legge SOLO la Direzione.
  it('la route del registro chiede un gate che esclude la segreteria', () => {
    const f = path.join(API, 'admin/chat/vigilanza/route.ts')
    expect(fs.existsSync(f), 'manca la route del registro').toBe(true)
    const { senzaCommenti } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
    // `requireStaff` senza secondo argomento ammette anche `segreteria`.
    expect(
      /requireStaff\(\s*request\s*,\s*RUOLI_DIREZIONE\s*\)/.test(senzaCommenti),
      'la route del registro deve chiamare `requireStaff(request, RUOLI_DIREZIONE)`: ' +
        'con la lista predefinita la segreteria leggerebbe il registro delle proprie letture.',
    ).toBe(true)
    expect(
      /['"]segreteria['"]/.test(senzaCommenti),
      'nessun letterale «segreteria» nella route del registro: il perimetro è `RUOLI_DIREZIONE`.',
    ).toBe(false)
  })

  // ── 4. La strada del PARTECIPANTE non si registra.
  it('la chat vera (genitore e insegnante) NON scrive nel registro di vigilanza', () => {
    const sporche = routeDi(path.join(API, 'chat'))
      .filter((f) => REGISTRA_COMUNQUE.test(mascheraSorgente(fs.readFileSync(f, 'utf8')).senzaCommenti))
      .map((f) => path.relative(process.cwd(), f))
    expect(
      sporche,
      'Leggere la PROPRIA conversazione non è vigilanza. Registrarla riempirebbe il ' +
        'registro di migliaia di righe al mese, e la lettura di vigilanza non si ' +
        'troverebbe più: il registro smetterebbe di funzionare restando verde.',
    ).toEqual([])
  })

  // ── 5. Il codice d'errore esiste ed è tradotto (se no il rifiuto è muto).
  it('VIGILANZA_NON_TRACCIABILE è dichiarato e tradotto nelle due lingue', () => {
    const codici = fs.readFileSync(path.join(process.cwd(), 'src/lib/ui/esito-fetch.ts'), 'utf8')
    expect(/VIGILANZA_NON_TRACCIABILE:\s*'erroreVigilanzaNonTracciabile'/.test(codici)).toBe(true)
    for (const lingua of ['it', 'en']) {
      const cat = JSON.parse(fs.readFileSync(path.join(process.cwd(), `messages/${lingua}/shared.json`), 'utf8'))
      expect(cat.erroreVigilanzaNonTracciabile, `traduzione mancante in ${lingua}`).toBeTruthy()
    }
  })

  // ── 6. LA CONTRO-PROVA: il lock deve saper dire di no.
  //
  // Senza questa, «verde» significherebbe soltanto che la funzione non ha mai
  // trovato niente — che è indistinguibile dal non aver guardato.
  describe('la funzione di controllo dà verdetti opposti su due sorgenti finti', () => {
    const CONFORME = `
      import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit';
      export const GET = withRoute('x:GET', async (request) => {
        const { data } = await supabase.from('chat_messages').select('content');
        const { tracciato } = await registraAccessoVigilanza(supabase, { azione: 'lettura' });
        if (!tracciato) return NextResponse.json({ codice: 'VIGILANZA_NON_TRACCIABILE' }, { status: 503 });
        return NextResponse.json({ data });
      });
    `
    const NUDA = `
      export const GET = withRoute('x:GET', async (request) => {
        const { data } = await supabase.from('chat_messages').select('content');
        return NextResponse.json({ data });
      });
    `
    // Il caso che una `grep` ingenua non distingue dal conforme.
    const SOLO_COMMENTATA = `
      export const GET = withRoute('x:GET', async (request) => {
        // qui andrebbe registraAccessoVigilanza(...) e il rifiuto
        // VIGILANZA_NON_TRACCIABILE, ma per ora leggiamo e basta
        const { data } = await supabase.from('chat_messages').select('content');
        return NextResponse.json({ data });
      });
    `
    // Registra ma non sa rifiutare: traccia «quasi sempre», che è il difetto sottile.
    const SENZA_RIFIUTO = `
      export const GET = withRoute('x:GET', async (request) => {
        const { data } = await supabase.from('chat_messages').select('content');
        await registraAccessoVigilanza(supabase, { azione: 'lettura' });
        return NextResponse.json({ data });
      });
    `
    // Il caso che ha bucato la prima versione di questo lock: la chiamata c'e,
    // ma solo nel ramo che NEGA. La strada che serve il contenuto non registra.
    const SOLO_NEL_RAMO_CHE_NEGA = `
      import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit';
      export const GET = withRoute('x:GET', async (request) => {
        if (fuoriScope) {
          await registraAccessoVigilanza(supabase, { azione: 'lettura', esito: 'fuori-scope' });
          return fuoriScope;
        }
        const { data } = await supabase.from('chat_messages').select('content');
        return NextResponse.json({ data, codice: 'VIGILANZA_NON_TRACCIABILE' });
      });
    `
    const NON_LEGGE = `
      export const GET = withRoute('x:GET', async () => {
        const { data } = await supabase.from('chat_threads').select('id');
        return NextResponse.json({ data });
      });
    `

    it('promuove il sorgente conforme', () => {
      expect(violaLaTracciabilita(CONFORME).viola).toBe(false)
    })
    it('boccia la lettura nuda', () => {
      expect(violaLaTracciabilita(NUDA).viola).toBe(true)
    })
    it('boccia il presidio che vive solo nei commenti', () => {
      const v = violaLaTracciabilita(SOLO_COMMENTATA)
      expect(v.registra, 'una menzione nei commenti non è una chiamata').toBe(false)
      expect(v.viola).toBe(true)
    })
    it('boccia chi registra ma non sa rifiutare', () => {
      expect(violaLaTracciabilita(SENZA_RIFIUTO).viola).toBe(true)
    })
    it('boccia chi registra SOLO nel ramo che nega', () => {
      // Una chiamata dentro un `if` non copre l'`else`: e il buco vero che questa
      // fixture ha scoperto, e che ha fatto stringere `REGISTRA`.
      expect(violaLaTracciabilita(SOLO_NEL_RAMO_CHE_NEGA).viola).toBe(true)
    })
    it('lascia stare chi non legge il contenuto dei messaggi', () => {
      expect(violaLaTracciabilita(NON_LEGGE).viola).toBe(false)
    })
  })
})
