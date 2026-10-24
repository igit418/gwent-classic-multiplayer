# Gra online (dwóch graczy)

Ta wersja Gwent Classic pozwala zagrać ze znajomym przez internet. Nie potrzeba serwera:
przeglądarki łączą się bezpośrednio (WebRTC przez bibliotekę PeerJS), więc całą grę można
hostować za darmo na GitHub Pages.

## Jak zagrać

1. Obaj gracze otwierają stronę gry.
2. Pierwszy gracz klika **Graj online** (obok „Download Deck”), wpisuje swoje imię i klika
   **Utwórz grę**. Dostaje 5-znakowy kod, np. `K7M2Q`. Przycisk **Kopiuj link** kopiuje link,
   który od razu wypełnia kod u znajomego.
3. Drugi gracz klika **Graj online**, wpisuje kod i klika **Dołącz**.
4. Każdy wybiera swoją talię i klika **Gotowy** (w miejscu „Start game”). Gra startuje, gdy
   obaj są gotowi. Zmiana talii po kliknięciu „Gotowy” anuluje gotowość.
5. Po partii:
   - **Rematch** – rewanż tymi samymi taliami (obaj muszą kliknąć),
   - **Customize** – powrót do wyboru talii (połączenie zostaje),
   - **New Game** – rozłącza i zaczyna grę z komputerem.

Gra z komputerem działa jak dawniej.

## Odświeżenie strony i zerwane połączenie

Partia nie kończy się po odświeżeniu karty ani po chwilowej utracie połączenia:

- Po odświeżeniu (F5) gra sama odtwarza partię z zapisanych ruchów (napis „Wznawianie
  partii…” trwa zwykle sekundę lub dwie) i łączy się ponownie z przeciwnikiem.
- Drugi gracz widzi w tym czasie pasek „Przeciwnik stracił połączenie. Czekam na jego
  powrót…” z licznikiem. Może dalej grać swoją turę – ruchy dotrą do przeciwnika po
  ponownym połączeniu.
- Jeśli nikt nie wróci w ciągu 3 minut, partia zostaje przerwana. Przycisk **Zakończ partię**
  na pasku przerywa ją od razu.

## Jak to działa

Obie przeglądarki liczą tę samą symulację gry. Przez sieć wysyłane są tylko decyzje graczy
(która karta do którego rzędu, wybory w okienkach, pas, dowódca). Tasowanie i inne losowania
korzystają z generatora z tym samym ziarnem, więc wynik jest identyczny u obu graczy.

Każdy ruch ma numer i jest zapisywany w `sessionStorage` karty, zanim zostanie wysłany. Po
odświeżeniu strony gra startuje od nowa z tym samym ziarnem i taliami, a zapisane ruchy obu
graczy są odtwarzane na przyspieszonym, wirtualnym zegarze (animacje i dźwięki są pomijane).
Po ponownym połączeniu obie strony wymieniają liczbę otrzymanych ruchów (`resume`) i
dosyłają brakujące; powtórzone ruchy są pomijane. Host przyjmuje powracającego gracza tylko
z kluczem partii ustalonym na jej starcie.

Po każdej turze gry porównują skrót (hash) stanu. Jeśli kiedykolwiek się rozjadą, pojawi się
komunikat, a szczegóły trafią do konsoli przeglądarki (F12). Adres z dopiskiem `?debug`
wypisuje w konsoli wszystkie ruchy, co pomaga przy zgłaszaniu błędów.

Pliki związane z trybem online:
- `net-config.js` – ustawienia serwerów STUN/TURN,
- `net.js` – połączenie, lobby, kolejka ruchów, kontrola synchronizacji, `ControllerRemote`,
- zmiany w `gwent.js`, `abilities.js`, `factions.js`, `common.js` (generator `SeededRNG`),
- panel lobby w `index.html` i style na końcu `style.css`.

## Testowanie na jednym komputerze

Dodaj do adresu `?net=local`, np. `index.html?net=local`, i otwórz grę w dwóch kartach tej
samej przeglądarki. Karty łączą się wtedy lokalnie (BroadcastChannel), bez internetu.
Grę trzeba uruchomić przez serwer HTTP, np. `python -m http.server`, a nie z pliku.

## Hosting na GitHub Pages

1. Zrób fork repozytorium (albo nowe repozytorium) i wgraj do niego wszystkie pliki gry.
2. W repozytorium: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   wybierz gałąź (np. `main`) i folder `/ (root)`, zapisz.
3. Po minucie gra będzie pod adresem `https://<twoja-nazwa>.github.io/<nazwa-repozytorium>/`.

## Serwer TURN (połączenie przez trudne sieci)

Przeglądarki najpierw próbują połączyć się bezpośrednio (pomaga w tym serwer STUN). Gdy obaj
gracze siedzą za restrykcyjnym NAT-em (sieci firmowe, część sieci komórkowych, niektóre
akademiki), połączenie bezpośrednie się nie uda i ruch trzeba przepuścić przez **serwer TURN**,
który przekazuje dane między graczami.

Bez konfiguracji gra używa domyślnych serwerów PeerJS (STUN Google i darmowy, „best effort”
TURN PeerJS). Bywają przeciążone, więc warto ustawić własny TURN. Gwint przesyła tylko ruchy
graczy, czyli kilka–kilkadziesiąt KB na partię, więc darmowe limity wystarczą na tysiące gier.

### Polecana usługa: Metered.ca (Open Relay)

[Metered Open Relay](https://www.metered.ca/tools/openrelay/) daje **20 GB ruchu TURN miesięcznie
za darmo** i ma API, które wydaje dane logowania prosto do przeglądarki.

1. Załóż darmowe konto: <https://dashboard.metered.ca/signup?tool=turnserver>.
2. W panelu zapisz nazwę aplikacji (`<appname>`) i utwórz **klucz API do poświadczeń**
   (credential API key). Nie używaj klucza `secretKey`: ten nie może trafić do przeglądarki.
3. Ustaw adres w `net-config.js` (patrz niżej):
   ```js
   window.GWENT_NET_CONFIG = {
   	credentialsUrl: "https://<appname>.metered.live/api/v1/turn/credentials?apiKey=<klucz API>"
   };
   ```
   Gra pobiera listę serwerów STUN/TURN przy tworzeniu i dołączaniu do gry.

Alternatywy: [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) (duży
darmowy limit, ale dane logowania trzeba generować po stronie serwera, np. w Cloudflare Worker,
którego adres wpisujesz jako `credentialsUrl`) albo własny serwer
[coturn](https://github.com/coturn/coturn) na tanim VPS-ie.

### Konfiguracja przez plik `net-config.js`

Plik `net-config.js` w katalogu gry ustawia obiekt `window.GWENT_NET_CONFIG`. Wszystkie pola są
opcjonalne:

| Pole | Znaczenie |
|------|-----------|
| `credentialsUrl` | Adres zwracający JSON z listą serwerów ICE (np. API Metered). |
| `turnUrls` | Adres TURN albo lista, np. `["turn:serwer:3478", "turns:serwer:443?transport=tcp"]`. |
| `turnUsername`, `turnCredential` | Login i hasło do `turnUrls`. |
| `iceServers` | Pełna lista obiektów `RTCIceServer`, użyta bez zmian. |
| `relayOnly` | `true` wymusza ruch przez TURN (tylko do testów). |

Gdy ustawisz cokolwiek, domyślne serwery PeerJS są pomijane; jeśli w liście nie ma STUN, gra
dodaje `stun:stun.l.google.com:19302`, żeby połączenia bezpośrednie nadal działały.

Przykład ze stałym loginem (np. własny coturn):
```js
window.GWENT_NET_CONFIG = {
	turnUrls: ["turn:turn.example.com:3478", "turns:turn.example.com:443?transport=tcp"],
	turnUsername: "gwent",
	turnCredential: "haslo"
};
```

> **Uwaga:** zawartość `net-config.js` trafia do każdego gracza, więc jest publiczna. Wpisuj tam
> tylko dane przeznaczone dla przeglądarki (klucz API Metered do poświadczeń, a nie `secretKey`).

### Konfiguracja przez zmienne (GitHub Actions)

Jeśli nie chcesz trzymać ustawień w repozytorium, workflow `.github/workflows/pages.yml` może
publikować grę na GitHub Pages i generować `net-config.js` ze zmiennych repozytorium:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables** i dodaj:
   - `PAGES_FROM_ACTIONS` = `true` (włącza workflow),
   - `TURN_CREDENTIALS_URL` (np. adres API Metered) **albo** `TURN_URLS` (adresy rozdzielone
     przecinkami), `TURN_USERNAME`, `TURN_CREDENTIAL`,
   - opcjonalnie `TURN_RELAY_ONLY` = `true`.
3. Zrób push na `main` albo uruchom workflow ręcznie (**Actions → Deploy to GitHub Pages → Run
   workflow**).

Te same zmienne środowiskowe obsługuje skrypt `node tools/write-net-config.js`, przydatny przy
innym hostingu (np. Netlify, Vercel) jako krok budowania.

### Jak sprawdzić, że TURN działa

Otwórz grę z dopiskiem `?relay` (np. `index.html?relay`) u **obu** graczy. Wtedy WebRTC może
użyć tylko serwera TURN, więc jeśli połączenie się uda, TURN jest ustawiony poprawnie. Dopisek
`?debug` wypisuje w konsoli (F12) użyte serwery ICE. W `chrome://webrtc-internals` widać, czy
wybrana para kandydatów ma typ `relay`.

## Ograniczenia

- Połączenie bezpośrednie czasem nie działa w bardzo restrykcyjnych sieciach (niektóre sieci
  firmowe lub komórkowe). Pomaga wtedy serwer TURN (patrz wyżej) albo zmiana sieci.
- Gra ufa obu klientom: osoba znająca JavaScript mogłaby w konsoli podejrzeć karty rywala.
  Przy grze ze znajomymi nie ma to znaczenia.
- Partię da się wznowić tylko w tej samej karcie przeglądarki (zapis jest w `sessionStorage`)
  i najpóźniej 15 minut po ostatnim ruchu. Zamknięcie karty i otwarcie gry w nowej oznacza
  rozłączenie – przeciwnik czeka wtedy 3 minuty albo kończy partię przyciskiem.
- Przycisk **Rozłącz** i **New Game** kończą partię od razu u obu graczy.
