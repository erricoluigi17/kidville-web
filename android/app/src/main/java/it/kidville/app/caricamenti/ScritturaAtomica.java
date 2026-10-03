package it.kidville.app.caricamenti;

import androidx.core.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;

/**
 * LA SCRITTURA ATOMICA CHE SI VERIFICA: una funzione sola per la coda, il registro e i segreti.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.6; secondario n. 45 della PR 3, compito A2)
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────────────────────
 * `androidx.core.util.AtomicFile.finishWrite` SUL TELEFONO NON LANCIA MAI: se la sincronizzazione o la rinomina falliscono scrive
 * una riga con `Log.e` e ritorna come se niente fosse. Chi scriveva `finishWrite(uscita); return true;` dichiarava «scritto» un file
 * che sul disco poteva essere ancora quello di prima: la coda diceva `accodato` a un video che alla riapertura non c'era, e un
 * segreto «salvato» spariva. Nei test sulla JVM invece `Log.e` LANCIA («not mocked»), e il test vedeva il fallimento: il
 * comportamento del test e quello del telefono divergevano proprio sul ramo d'errore, che è l'unico che interessa.
 *
 * ─── COME ────────────────────────────────────────────────────────────────────────────────────
 * Si scrive come sempre (`startWrite` → `write` → `finishWrite`) e poi SI RILEGGE il file dal disco: se non contiene esattamente i
 * byte appena scritti, la scrittura è fallita e lo dice il valore restituito. Il costo è una lettura di poche decine di KB (la
 * coda, il registro, un segreto), per ogni scrittura: niente rispetto a ciò che costa un video «accodato» che non c'è.
 * La verifica NON conta sui nomi interni di `AtomicFile` (`.new`, `.bak`): guarda solo il risultato.
 *
 * Il fallimento è il VALORE restituito (l'eccezione che l'ha causato, o una sintetica «non verificata»), mai un `catch` muto: i
 * chiamanti lo portano nel loro esito (`persistita`, l'`IOException` di `aggiungi`, il guasto interno del registro).
 */
final class ScritturaAtomica {

    private ScritturaAtomica() {
    }

    /**
     * Scrive `dati` in `atomico` e verifica che siano arrivati su disco.
     *
     * @return `null` se la scrittura è riuscita E verificata; altrimenti l'eccezione che la spiega. Non lancia mai
     */
    static IOException scrivi(AtomicFile atomico, byte[] dati) {
        FileOutputStream uscita = null;
        try {
            File cartella = atomico.getBaseFile().getParentFile();
            if (cartella != null) cartella.mkdirs();
            uscita = atomico.startWrite();
            uscita.write(dati);
        } catch (IOException | RuntimeException prima) {
            if (uscita != null) scartaLaScrittura(atomico, uscita, prima);
            return comeIoException(prima);
        }
        try {
            atomico.finishWrite(uscita);
        } catch (RuntimeException durante) {
            // Nella JVM di JUnit `Log.e` lancia dentro `finishWrite`; sul telefono non succede mai (testata). Il file nuovo può
            // essere rimasto a metà strada: la prossima `startWrite` lo ricrea, e `openRead` lo butta se c'è il file base.
            return comeIoException(durante);
        }
        return verifica(atomico, dati);
    }

    /** Rilegge il file base e lo confronta con ciò che si voleva scrivere. `null` se coincide. */
    static IOException verifica(AtomicFile atomico, byte[] attesi) {
        try {
            byte[] sulDisco = atomico.readFully();
            if (Arrays.equals(sulDisco, attesi)) return null;
            return new IOException("scrittura non verificata: il file sul disco non è quello scritto");
        } catch (IOException | RuntimeException nonLeggibile) {
            return comeIoException(nonLeggibile);
        }
    }

    /**
     * La scrittura è fallita PRIMA di `finishWrite`: si scarta il file nuovo, il vecchio è ancora intero. Se anche lo scarto cade
     * (nella JVM di JUnit `failWrite` può lanciare per lo stesso `Log.e`), l'errore che si restituisce resta quello PRIMARIO e lo
     * scarto mancato gli si AGGANCIA come soppresso (`addSuppressed`): non si perde, e non lo si nasconde con uno secondario. Al più
     * resta un `.new`, che la prossima scrittura rimpiazza.
     */
    private static void scartaLaScrittura(AtomicFile atomico, FileOutputStream uscita, Throwable primaria) {
        try {
            atomico.failWrite(uscita);
        } catch (RuntimeException scartoNonRiuscito) {
            primaria.addSuppressed(scartoNonRiuscito);
        }
    }

    private static IOException comeIoException(Throwable causa) {
        return causa instanceof IOException ? (IOException) causa : new IOException(causa);
    }
}
