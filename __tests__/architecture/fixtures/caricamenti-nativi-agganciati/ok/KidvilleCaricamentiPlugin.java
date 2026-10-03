// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regole 1 e 2, Android).
// La forma MINIMA di un plugin Java agganciato come vuole la spec (§4.1, §4.3, §6.5): nome, nove `@PluginMethod`, la prova dietro `BuildConfig.DEBUG`.
// Non è codice dell'app: sta in `__tests__/architecture/fixtures/` e Gradle non la compila.
package it.kidville.app.fixture;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import it.kidville.app.BuildConfig;

/**
 * Nel commento di classe compaiono di proposito cose che il lock cerca nel codice: `@CapacitorPlugin(name = "Altro")`,
 * `@PluginMethod public void fintoMetodo(PluginCall call)`, `BuildConfig.DEBUG`, `READ_MEDIA_IMAGES`, `getMessage()`.
 * Sono un commento: un lock che legge il file come testo se ne farebbe ingannare.
 */
@CapacitorPlugin(name = "KidvilleCaricamenti")
public class KidvilleCaricamentiPlugin extends Plugin {

    static final String EVENTO_PREPARAZIONE = "preparazione";
    static final String EVENTO_CARICAMENTO = "caricamento";

    @PluginMethod
    public void info(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void scegliMedia(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void annullaScelta(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void leggiFoto(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void scartaScelti(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void accodaVideo(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void elenco(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void annulla(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void dimentica(PluginCall call) {
        call.resolve();
    }

    /** SOLO Debug: nelle build di rilascio risponde «non implementato» e non fa altro. */
    @PluginMethod
    public void creaElementoDiProva(PluginCall call) {
        if (!BuildConfig.DEBUG) {
            call.unimplemented("creaElementoDiProva esiste solo nelle build Debug");
            return;
        }
        call.resolve();
    }

    private void inoltra() {
        notifyListeners(EVENTO_CARICAMENTO, null);
        notifyListeners(EVENTO_PREPARAZIONE, null);
    }
}
