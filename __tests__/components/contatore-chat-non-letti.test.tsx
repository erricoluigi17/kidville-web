import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

/**
 * LO STORE DEL CONTATORE DEI MESSAGGI DI CHAT NON LETTI (2026-09-29).
 *
 * Il numero che la barra in basso mostra su «Messaggi» (maestre) e «Chat» (genitori) non è uno
 * stato di React: lo scrive la campanella (che vive nell'AppBar), lo mostrano le barre e lo
 * correggono le letture registrate della pagina chat, cioè tre punti che non si vedono fra loro.
 * Sta quindi in un modulo, come le bozze della chat (`bozze-chat.ts`).
 *
 * Ogni test ricarica il modulo (`vi.resetModules`): lo stato è di MODULO, e due test che se lo
 * passassero si spiegherebbero a vicenda i propri difetti.
 */

type Store = typeof import('@/components/features/chat/contatore-non-letti');

async function storeFresco(): Promise<Store> {
    vi.resetModules();
    return await import('@/components/features/chat/contatore-non-letti');
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('contatore-non-letti — `null` è «non lo so», non zero', () => {
    it('parte da `null`: prima di sapere qualcosa nessun badge', async () => {
        const s = await storeFresco();
        expect(s.chatNonLetti()).toBeNull();
    });

    it('lo snapshot del SERVER è `null`: il rendering server non mostra il badge nemmeno con un valore in mano', async () => {
        const s = await storeFresco();
        // Il valore c'è, ed è lo stato del modulo — che sul server NON può appartenere a nessuno:
        // il prerender è condiviso, e un numero preso da lì finirebbe nell'HTML servito a chiunque.
        s.impostaChatNonLettiDalServer(7, s.sequenzaChatNonLetti());

        const Sonda = () => {
            const n = s.useChatNonLetti();
            return <span>{typeof n === 'number' && n > 0 ? `badge:${n}` : 'senza-badge'}</span>;
        };
        const html = renderToString(<Sonda />);

        expect(
            html,
            "Il terzo argomento di `useSyncExternalStore` non è il valore `null` del prerender: il " +
                'badge entra nell\'HTML del server, e all\'idratazione React segnala un mismatch che ' +
                'NON ripara — il difetto già costato una correzione sulla barra docente.',
        ).toContain('senza-badge');
        expect(html).not.toContain('badge:7');
        // ...e il valore per il client resta quello vero: non si è «risolto» azzerando lo store.
        expect(s.chatNonLetti()).toBe(7);
    });

    it("un'impostazione dal server porta il numero, una variazione lo muove", async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());
        expect(s.chatNonLetti()).toBe(5);
        s.variaChatNonLetti(-2);
        expect(s.chatNonLetti()).toBe(3);
        s.variaChatNonLetti(1);
        expect(s.chatNonLetti()).toBe(4);
    });

    it('una variazione su `null` resta `null`: senza la base non si inventa un totale', async () => {
        const s = await storeFresco();
        s.variaChatNonLetti(-2);
        expect(s.chatNonLetti()).toBeNull();
        s.variaChatNonLetti(1);
        expect(s.chatNonLetti()).toBeNull();
    });

    /**
     * ⚠️ LO ZERO DAL SERVER DEVE ENTRARE, e questo test esiste perché lo sbaglio è il più naturale
     * che si possa fare in JavaScript: `if (!prossimo)` o `if (prossimo > 0)` invece di un controllo
     * di TIPO. Lo 0 è falsy, quindi non entrerebbe mai — e il badge resterebbe bloccato sull'ultimo
     * numero positivo. È il caso di ogni giorno: la maestra legge gli ultimi messaggi da un altro
     * dispositivo (o la segreteria apre quella conversazione), il server dice 0, e sul suo telefono
     * il badge continua a dire «3» per sempre. `null` («non lo so») e `0` («hai letto tutto») sono
     * due cose diverse, e questo è il posto in cui la differenza si vede.
     */
    it('lo ZERO dal server entra e spegne il badge (0 non è «non lo so»)', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());
        expect(s.chatNonLetti()).toBe(5);

        s.impostaChatNonLettiDalServer(0, s.sequenzaChatNonLetti());

        expect(
            s.chatNonLetti(),
            'Lo 0 del server è stato scartato: il badge resta bloccato sull\'ultimo numero positivo, ' +
                'e chi ha letto altrove continua a vedere messaggi che non ci sono.',
        ).toBe(0);
    });

    it('il valore non scende sotto zero', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(1, s.sequenzaChatNonLetti());
        s.variaChatNonLetti(-5);
        expect(s.chatNonLetti()).toBe(0);
    });

    it('un numero che non è un conteggio non entra (NaN, negativo, decimale)', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(Number.NaN, s.sequenzaChatNonLetti());
        expect(s.chatNonLetti()).toBeNull();
        s.impostaChatNonLettiDalServer(-3, s.sequenzaChatNonLetti());
        expect(s.chatNonLetti()).toBe(0);
        s.impostaChatNonLettiDalServer(2.7, s.sequenzaChatNonLetti());
        expect(s.chatNonLetti()).toBe(2);
    });
});

describe('contatore-non-letti — la guardia a sequenza', () => {
    it('un totale dal server PARTITO prima di una lettura viene scartato al ritorno', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());

        // Il poll parte: la sequenza di ADESSO è quella che si porta dietro.
        const allaPartenza = s.sequenzaChatNonLetti();
        // Mentre la richiesta è in volo si legge una conversazione di due messaggi.
        s.variaChatNonLetti(-2);
        expect(s.chatNonLetti()).toBe(3);
        // La risposta arriva e porta il numero di PRIMA della lettura.
        s.impostaChatNonLettiDalServer(5, allaPartenza);

        expect(
            s.chatNonLetti(),
            'Il poll in volo ha cancellato una lettura appena fatta: è la bugia «hai ancora ' +
                'messaggi da leggere» rimessa in piedi da una risposta vecchia.',
        ).toBe(3);
    });

    it('un totale dal server partito DOPO l\'ultima variazione entra', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());
        s.variaChatNonLetti(-2);
        // Il poll parte adesso, cioè dopo la lettura: il suo numero è quello buono.
        const allaPartenza = s.sequenzaChatNonLetti();
        s.impostaChatNonLettiDalServer(9, allaPartenza);
        expect(s.chatNonLetti()).toBe(9);
    });

    it('una variazione di zero non consuma la sequenza (non invalida nessun poll)', async () => {
        const s = await storeFresco();
        const allaPartenza = s.sequenzaChatNonLetti();
        s.variaChatNonLetti(0);
        s.impostaChatNonLettiDalServer(4, allaPartenza);
        expect(s.chatNonLetti()).toBe(4);
    });

    /**
     * ⚠️ LA SEQUENZA AVANZA ANCHE QUANDO IL VALORE È `null`, e l'ordine delle due righe dentro
     * `variaChatNonLetti` è tutta la differenza: con l'uscita anticipata PRIMA dell'incremento, una
     * lettura avvenuta mentre non si conosceva ancora il totale non invaliderebbe niente, e la
     * risposta in volo — partita PRIMA di quella lettura — entrerebbe come se nulla fosse.
     *
     * È il caso della prima apertura dell'app: la campanella parte, la maestra apre subito una
     * conversazione e legge, e la prima risposta arriva dopo. Quel numero conta i messaggi che ha
     * appena letto.
     */
    it('la sequenza avanza anche su `null`: un poll partito prima della lettura resta fuori', async () => {
        const s = await storeFresco();
        expect(s.chatNonLetti()).toBeNull();
        // La campanella parte quando ancora non si sa niente.
        const allaPartenza = s.sequenzaChatNonLetti();
        // Poi si legge una conversazione di due messaggi: su `null` il valore non cambia...
        s.variaChatNonLetti(-2);
        expect(s.chatNonLetti()).toBeNull();
        // ...ma la sequenza sì, quindi la risposta vecchia non entra.
        s.impostaChatNonLettiDalServer(5, allaPartenza);

        expect(
            s.chatNonLetti(),
            'Il primo totale è entrato pur essendo partito prima di una lettura: comprende i due ' +
                'messaggi appena letti, e il badge nasce già gonfio.',
        ).toBeNull();
    });
});

describe('contatore-non-letti — cambia la persona, il numero non resta', () => {
    it('`azzeraChatNonLetti` riporta a «non lo so»', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());
        const avviso = vi.fn();
        const smetti = s.ascoltaChatNonLetti(avviso);

        s.azzeraChatNonLetti();

        expect(s.chatNonLetti(), 'il numero della persona di prima è ancora sulla barra').toBeNull();
        expect(avviso, 'chi mostra il badge non è stato avvisato').toHaveBeenCalledTimes(1);
        smetti();
    });

    it('e invalida le richieste partite con l\'identità di prima', async () => {
        const s = await storeFresco();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());
        // Una richiesta parte con l'identità vecchia...
        const allaPartenza = s.sequenzaChatNonLetti();
        s.azzeraChatNonLetti();
        // ...e torna quando davanti allo schermo c'è un'altra persona.
        s.impostaChatNonLettiDalServer(5, allaPartenza);

        expect(
            s.chatNonLetti(),
            'Il totale della persona di prima è rientrato dalla finestra: dice a una famiglia quante ' +
                "conversazioni in sospeso ha un'altra.",
        ).toBeNull();
    });
});

describe('contatore-non-letti — chi mostra il numero lo ascolta', () => {
    it('`useChatNonLetti` parte da `null` e segue le scritture', async () => {
        const s = await storeFresco();
        const { result } = renderHook(() => s.useChatNonLetti());
        expect(result.current).toBeNull();

        act(() => s.impostaChatNonLettiDalServer(3, s.sequenzaChatNonLetti()));
        expect(result.current).toBe(3);

        act(() => s.variaChatNonLetti(-1));
        expect(result.current).toBe(2);
    });

    it('una scrittura che non cambia niente non avvisa nessuno', async () => {
        const s = await storeFresco();
        const avviso = vi.fn();
        const smetti = s.ascoltaChatNonLetti(avviso);
        s.impostaChatNonLettiDalServer(3, s.sequenzaChatNonLetti());
        expect(avviso).toHaveBeenCalledTimes(1);
        s.impostaChatNonLettiDalServer(3, s.sequenzaChatNonLetti());
        expect(avviso).toHaveBeenCalledTimes(1);
        smetti();
        s.impostaChatNonLettiDalServer(4, s.sequenzaChatNonLetti());
        expect(avviso).toHaveBeenCalledTimes(1);
    });
});

describe('contatore-non-letti — l\'evento «una conversazione è stata letta»', () => {
    it('`segnalaChatLetta` arriva a chi ascolta, e la disiscrizione lo stacca', async () => {
        const s = await storeFresco();
        const gestore = vi.fn();
        const smetti = s.ascoltaChatLetta(gestore);

        s.segnalaChatLetta();
        expect(gestore).toHaveBeenCalledTimes(1);

        smetti();
        s.segnalaChatLetta();
        expect(gestore).toHaveBeenCalledTimes(1);
    });

    it('due ascoltatori ricevono entrambi lo stesso segnale', async () => {
        const s = await storeFresco();
        const uno = vi.fn();
        const due = vi.fn();
        const a = s.ascoltaChatLetta(uno);
        const b = s.ascoltaChatLetta(due);
        s.segnalaChatLetta();
        a();
        b();
        expect(uno).toHaveBeenCalledTimes(1);
        expect(due).toHaveBeenCalledTimes(1);
    });
});
