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

## Jak to działa

Obie przeglądarki liczą tę samą symulację gry. Przez sieć wysyłane są tylko decyzje graczy
(która karta do którego rzędu, wybory w okienkach, pas, dowódca). Tasowanie i inne losowania
korzystają z generatora z tym samym ziarnem, więc wynik jest identyczny u obu graczy.

Po każdej turze gry porównują skrót (hash) stanu. Jeśli kiedykolwiek się rozjadą, pojawi się
komunikat, a szczegóły trafią do konsoli przeglądarki (F12). Adres z dopiskiem `?debug`
wypisuje w konsoli wszystkie ruchy, co pomaga przy zgłaszaniu błędów.

Pliki związane z trybem online:
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

## Ograniczenia

- Połączenie bezpośrednie czasem nie działa w bardzo restrykcyjnych sieciach (niektóre sieci
  firmowe lub komórkowe). Wtedy pomaga zmiana sieci, np. na domowe Wi-Fi.
- Gra ufa obu klientom: osoba znająca JavaScript mogłaby w konsoli podejrzeć karty rywala.
  Przy grze ze znajomymi nie ma to znaczenia.
- Zamknięcie lub odświeżenie karty kończy partię u obu graczy.
