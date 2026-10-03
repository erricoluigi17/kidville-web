// FIXTURE ROSSA del lock `caricamenti-nativi-agganciati` (regola 2, Android): `creaElementoDiProva` FUORI da `BuildConfig.DEBUG`.
// Un `@PluginMethod` si scopre per annotazione, non per elenco: se il corpo non esce subito nelle build di rilascio, il JavaScript di
// un'app pubblicata potrebbe creare un video di byte casuali. Qui il corpo fa il suo lavoro senza chiedere niente a `BuildConfig`.
package it.kidville.app.fixture;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KidvilleCaricamenti")
public class KidvilleCaricamentiPlugin extends Plugin {

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

    @PluginMethod
    public void creaElementoDiProva(PluginCall call) {
        call.resolve();
    }
}
