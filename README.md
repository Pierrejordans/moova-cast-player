# @moova/cast-player

Plugin [Capacitor](https://capacitorjs.com/) + composant [Angular](https://angular.dev/) : un lecteur vidéo **iOS, Android et Web** avec une peau HTML unique, lecture **HLS** et **fichiers statiques** (MP4, locaux ou distants), et **Chromecast natif** intégré.

Dépôt : [Pierrejordans/moova-cast-player](https://github.com/Pierrejordans/moova-cast-player)

Ce dépôt est **public**. Chaque application consommatrice fournit **son propre** identifiant de receiver Google Cast. N’y commitez jamais l’App ID, l’URL de receiver ou les secrets d’une appli.

---

## Ce que fait le package

### Lecture

- Une seule balise `<moova-cast-player>` pour iOS, Android et le navigateur.
- **HLS** (`.m3u8`) : `hls.js` sur Android / Web, lecteur HLS natif sur iOS.
- **MP4** (HTTP, `file://`, `_capacitor_file_`) : `src` direct, sans Mux ni CDN imposé.
- Poster plein cadre (`object-fit: cover`, jamais de bandes noires). La vidéo peut rester en `contain` ou `cover`.
- Autoplay, mute, loop, seek initial (`startPosition`), changement de `src` à chaud.
- Montage / démontage contrôlé (`isVisible`) pour les listes et la navigation.

### Peau (skin)

Même interface sur iOS et Android (pas les contrôles Safari / Chrome) :

- bouton lecture central et overlay pause (même taille) ;
- barre : lecture / pause, buffered, progression, plein écran ;
- icône Cast en haut à droite **uniquement** si un appareil est détecté sur le réseau ;
- thème par variables CSS (`--cast-player-accent`, etc.).

Le package **ne collecte aucune statistique**. Play, pause, `timeupdate`, fin de lecture, Cast : ce sont des **événements**. L’app métier (tracking, auth, reprise) s’en sert si besoin.

### Plein écran et orientation

- Bouton plein écran (Fullscreen API + `webkitEnterFullscreen` iOS).
- Option **`rotationFullscreen`** : sur téléphone, basculer en paysage entre en plein écran, revenir en portrait en sort. **À activer seulement sur smartphone** (`[rotationFullscreen]="isPhone"`). Tablette / desktop : laisser `false`.
- L’app reste maître des autres locks (portrait hors vidéo, espace métier) via `(fullscreenChange)`.

### Chromecast

Le sender Cast (Android Java + iOS Swift) est **embarqué** : pas de plugin Cast tiers à installer.

- Découverte large des dongles, session vers **votre** receiver.
- `loadMedia` : HLS ou MP4, poster, titre, position, `customData` opaque pour votre receiver.
- Une session à la fois ; seul le player qui a demandé le Cast envoie le média.
- Un **receiver CAF marque blanche** est fourni dans `examples/chromecast-receiver/` (à héberger chez vous).
- **Pas de Cast web** (Chrome desktop) dans cette version.
- Sans `plugins.CastPlayer.receiverAppId` dans `capacitor.config.ts`, le bouton Cast n’apparaît pas.

---

## Prérequis

| | Version |
|---|---|
| Angular | ≥ 19 |
| Capacitor | ≥ 8 |
| Ionic (optionnel) | ≥ 8 |
| `hls.js` | ≥ 1 |
| `@capacitor/screen-orientation` | ≥ 8 |

Receiver Cast : une appli [Google Cast Developer Console](https://cast.google.com/publish/) **à vous**. Le Default Media Receiver Google (`CC1AD845`) convient pour un MP4 public de test, pas pour un flux HLS custom.

---

## Installation

```bash
npm install github:Pierrejordans/moova-cast-player
# ou, en SSH :
# npm install git+ssh://git@github.com/Pierrejordans/moova-cast-player.git
npx cap sync
```

Le composant Angular est livré en **sources**. Le champ `module` du package pointe vers `src/lib/public-api.ts` (pas vers le plugin Capacitor). Dans le `tsconfig.json` de l’app, forcez aussi ce fichier — sinon un `ng build` production peut résoudre `CastPlayerModule` à `undefined` (`forRoot` plante) :

```json
{
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "@moova/cast-player": [
        "node_modules/@moova/cast-player/src/lib/public-api.ts"
      ]
    }
  }
}
```

Ajoutez `"preserveSymlinks": true` aux options de build Angular si besoin.

### Développement local (sans npm GitHub)

```json
"@moova/cast-player": "file:../moova-cast-player"
```

```json
"paths": {
  "@moova/cast-player": ["../moova-cast-player/src/lib/public-api.ts"]
}
```

---

## Usage Angular

L’App ID Cast se déclare dans **`capacitor.config.ts`** (config native Capacitor), pas dans les `environment` Angular :

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  plugins: {
    CastPlayer: {
      receiverAppId: 'YOUR_RECEIVER_APP_ID',
    },
  },
};

export default config;
```

Puis un `npx cap sync` pour copier la config dans les projets iOS/Android.

```ts
import { NgModule } from '@angular/core';
import { CastPlayerModule } from '@moova/cast-player';

@NgModule({
  imports: [CastPlayerModule],
})
export class AppModule {}
```

Sans Chromecast (lecture seule) : omettez `plugins.CastPlayer.receiverAppId` (ou le bloc entier). `CastPlayerModule` reste importable.

```html
<moova-cast-player
  [src]="videoUrl"
  [poster]="posterUrl"
  [title]="title"
  [autoplay]="false"
  [muted]="false"
  [loop]="false"
  [startPosition]="0"
  [isVisible]="true"
  [rotationFullscreen]="isPhone"
  [objectFit]="'cover'"
  [enableCast]="true"
  [customData]="castPayload"
  [contentType]="'application/x-mpegURL'"
  (play)="onPlay()"
  (pause)="onPause()"
  (timeupdate)="onTime($event)"
  (ended)="onEnded()"
  (error)="onError($event)"
  (ready)="onReady()"
  (playingStarted)="onMetrics($event)"
  (fullscreenChange)="onFullscreen($event)"
  (castStart)="onCastStart()"
  (castEnd)="onCastEnd()"
></moova-cast-player>
```

`customData` est transmis tel quel au receiver (`loadMedia`). Placez-y uniquement ce que **votre** receiver attend (auth, tracking, etc.).

---

## API du composant

### Inputs

| Input | Défaut | Rôle |
|---|---|---|
| `src` | `''` | URL HLS, MP4 distant, ou fichier local WebView |
| `poster` | `''` | Image avant lecture (`cover`) |
| `title` | `''` | Métadonnées Cast |
| `autoplay` | `false` | Lecture auto (souvent avec `muted`) |
| `muted` | `false` | Muet |
| `loop` | `false` | Boucle |
| `startPosition` | `0` | Seek initial, en secondes |
| `isVisible` | `true` | `false` : pause + teardown (listes / navigation) |
| `rotationFullscreen` | `false` | Rotation téléphone → plein écran |
| `enableCast` | `true` | `false` : pas d’init Cast (permission réseau refusée, etc.) |
| `objectFit` | `'contain'` | `'contain'` \| `'cover'` pour la **vidéo** (le poster est toujours `cover`) |
| `customData` | `null` | Payload JSON pour le receiver |
| `contentType` | auto | Ex. `application/x-mpegURL`, `video/mp4` |

### Outputs

| Output | Payload |
|---|---|
| `play` / `pause` / `ended` / `ready` | — |
| `error` | erreur native ou HLS |
| `timeupdate` | `{ currentTime, duration, progress }` |
| `playingStarted` | `{ videoWidth, videoHeight }` (layout hôte) |
| `fullscreenChange` | `{ fullscreen }` |
| `castStart` / `castEnd` | — |

### Méthodes (`ViewChild`)

`playMedia()`, `pauseMedia()`, `seek(seconds)`, `enterFullscreen()`, `exitFullscreen()`, `getCurrentTime()`, `getDuration()`.

---

## Chromecast côté natif

Le SDK Google Cast **doit démarrer au lancement de l’app**, avant Angular. Une seule source : `plugins.CastPlayer.receiverAppId` dans `capacitor.config.ts` (copié en `capacitor.config.json` au `cap sync`).

### iOS — `AppDelegate.swift`

```swift
import UIKit
import GoogleCast
import MoovaCastPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    CastPlayerBootstrap.configure()
    return true
  }
}
```

Sans `CastPlayerBootstrap.configure()`, `initialize()` iOS échoue. Le bootstrap lit l’App ID dans `capacitor.config.json` du bundle.

### Android

Le plugin déclare un `CastOptionsProvider` qui lit le même `capacitor.config.json` (assets). Fallback : Default Media Receiver Google, ou `cast_player_receiver_app_id` dans les strings de l’app si vous tenez à une surcharge XML.

Ne laissez **qu’un** `OPTIONS_PROVIDER_CLASS_NAME` dans le manifeste fusionné (retirez l’ancien provider de l’app s’il existe).

`MainActivity` peut toujours appeler `CastContext.getSharedInstance(this)` au `onCreate`.

---

## Receiver Chromecast (exemple marque blanche)

Le Default Media Receiver Google (`CC1AD845`) n’a pas d’UI à vous et gère mal le HLS custom. Pour une TV à vos couleurs, il faut un **Custom Web Receiver** : une page HTML servie en HTTPS que le dongle charge au Cast.

L’exemple ultra-minimal est un **seul fichier** :

`examples/chromecast-receiver/index.html`

Il lance le player CAF v3, lit HLS / MP4 envoyés par ce plugin, et laisse `customData` opaque. Aucun logo, aucune couleur de marque, aucun App ID.

### 1. Personnaliser

Dans le bloc CSS en tête du fichier :

| Variable | Rôle |
|---|---|
| `--playback-logo-image` | Petit logo pendant la lecture (`body` uniquement) |
| `--logo-image` / `--splash-image` | Image plein écran au lancement / à l’idle |
| `--background-color` / `--splash-color` | Fond |
| `--progress-color` | Barre de progression |
| `--watermark-image` | Filigrane coin bas-droit |

Exemple :

```css
body {
  --playback-logo-image: url("https://cdn.example.com/logo.png");
}
cast-media-player {
  --background-color: #0b0b0b;
  --splash-image: url("https://cdn.example.com/splash.png");
  --progress-color: #21a0aa;
}
```

Le **nom affiché à l’idle** (si vous n’avez pas de splash) n’est pas dans le HTML : c’est le nom de l’application dans la Cast Developer Console.

`customData` arrive tel quel. L’exemple accepte en plus `customData.mediaUrl` pour forcer l’URL lue ; le reste (auth, tracking) est à brancher dans l’interceptor `LOAD` si votre métier l’exige.

### 2. Héberger en HTTPS

Le Chromecast charge cette page depuis Internet. HTTP local ne marche pas.

- GitHub Pages, Netlify, Cloudflare Pages, S3+CloudFront, n’importe quel static HTTPS
- URL finale du type `https://cast.example.com/` (ou `.../index.html`)
- Les **médias** (HLS / MP4 / posters) doivent aussi être joignables en HTTPS depuis la TV (pas `localhost`, pas de fichier app)

Ne publiez **pas** un receiver partagé pour toutes les apps : copiez le dossier chez vous, changez les visuels, déployez **votre** origine.

### 3. Enregistrer l’app Cast

1. Compte [Google Cast Developer Console](https://cast.google.com/publish/) (frais d’inscription Google, une fois).
2. **Add New Application** → **Custom Receiver**.
3. **Name** : le nom de votre produit (vu sur la TV).
4. **Receiver Application URL** : l’URL HTTPS de l’étape 2.
5. Créez l’app, copiez l’**Application ID** (format `XXXXXXXX`).
6. Tant que l’app n’est pas publiée : **Add new device** (numéro de série du Chromecast, au dos / dans l’app Google Home). Sans ça, le dongle ignore votre receiver.
7. Attendez quelques minutes (parfois jusqu’à ~15 min) après un changement d’URL ou d’ID.

Cet Application ID va **uniquement** dans **votre** `capacitor.config.ts` (`plugins.CastPlayer.receiverAppId`). Jamais dans ce dépôt.

### 4. Brancher le sender

```ts
plugins: {
  CastPlayer: { receiverAppId: 'YOUR_RECEIVER_APP_ID' },
}
```

```ts
imports: [CastPlayerModule]
```

`npx cap sync`, puis redémarrez l’app native (le SDK Cast lit l’ID au lancement). Cast depuis `<moova-cast-player>` : le dongle ouvre votre HTML, le plugin envoie `url` + métadonnées + `customData`.

### Dépannage rapide

| Symptôme | Piste |
|---|---|
| Icône Cast absente | Pas de `receiverAppId` dans `capacitor.config.ts`, ou pas de dongle sur le même Wi‑Fi |
| Session OK, écran noir / nom Google | Mauvais App ID, ou URL receiver injoignable |
| « App not found » / idle sans votre UI | Device non enregistré, ou propagation Cast pas finie |
| HLS OK téléphone, KO TV | L’URL média n’est pas publique HTTPS, ou CORS / token côté CDN |
| Ancienne splash | Cache receiver : relancez le Cast, ou incrémenter l’URL (`?v=2`) |

---

## Thème

```css
.cast-player-host {
  --cast-player-accent: #21a0aa;
  --cast-player-primary: #fff;
  --cast-player-center-btn: 56px;
  --cast-player-center-icon: 32px;
}
```

---

## Ce que le package ne fait pas

- Pas de stats, auth, ni CDN (Mux, S3, fichiers offline) : à l’app.
- Pas de sous-titres, PiP, DRM, vitesse de lecture (hors `HTMLVideoElement` via `ViewChild`).
- Pas de sender Cast pour le navigateur desktop.
- Pas de marqueurs / évaluation métier.

---

## Licence

MIT
