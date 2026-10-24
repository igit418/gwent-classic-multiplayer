<div align="center">

# ⚔️ Gwent Classic · Online

**Klasyczny Gwint z Wiedźmina 3 w przeglądarce — teraz także 1 na 1 przez internet.**<br>
Utwórz grę, wyślij znajomemu kod i siadajcie do stołu. Bez instalacji, bez kont, bez serwera.

<br>

[![Zagraj teraz](https://img.shields.io/badge/▶_ZAGRAJ_TERAZ-d4a017?style=for-the-badge&labelColor=1a1a1a)](https://igit418.github.io/gwent-classic-multiplayer/)
[![Multiplayer](https://img.shields.io/badge/Multiplayer-1v1_online-8b5a2b?style=for-the-badge&labelColor=1a1a1a)](#-gra-ze-znajomym)
[![Bez instalacji](https://img.shields.io/badge/Bez_instalacji-działa_w_przeglądarce-4a6b3a?style=for-the-badge&labelColor=1a1a1a)](#)

![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-f7df1e?style=flat-square&logo=javascript&logoColor=black)
![WebRTC](https://img.shields.io/badge/WebRTC-PeerJS-333?style=flat-square&logo=webrtc)
![Licencja](https://img.shields.io/badge/licencja-MIT_+_Commons_Clause-555?style=flat-square)

<br>

<img src="docs/board.jpg" alt="Rozgrywka online — plansza w trakcie partii" width="100%">

<sub><i>Partia online: na górze przeciwnik, na dole Ty. Napis „Ruch przeciwnika…” pokazuje, że gra czeka na jego decyzję.</i></sub>

</div>

<br>

## ✨ Co tu znajdziesz

<table>
<tr>
<td width="50%" valign="top">

### 🌐 Gra online 1 na 1
Graj ze znajomym przez internet. Jeden gracz tworzy grę i dostaje 5-znakowy kod, drugi go wpisuje. Połączenie idzie bezpośrednio między przeglądarkami.

</td>
<td width="50%" valign="top">

### 🃏 Wszystkie karty z gry
Komplet kart z podstawki, **Serc z kamienia**, **Krwi i wina** oraz aktualizacji next-gen, łącznie z Płotką i talią Skellige.

</td>
</tr>
<tr>
<td valign="top">

### 🤖 Przeciwnik komputerowy
Nie masz z kim zagrać? Zmierz się z AI, które ocenia rękę, stół i cmentarze, zanim wykona ruch.

</td>
<td valign="top">

### 🛠️ Własne talie
Buduj talie, zapisuj je do pliku i wczytuj ponownie. Ustawienia i talie zapamiętują się w przeglądarce.

</td>
</tr>
</table>

<br>

## 🎮 Gra ze znajomym

> [!TIP]
> Wystarczą **3 kroki**, a cała gra działa w przeglądarce, także na zwykłym laptopie.

| | Ty | Twój znajomy |
|:-:|---|---|
| **1** | Kliknij **Graj online** → **Utwórz grę** | Otwórz tę samą stronę i kliknij **Graj online** |
| **2** | Wyślij mu kod (np. `K7M2Q`) albo link z **Kopiuj link** | Wpisz kod i kliknij **Dołącz** |
| **3** | Wybierz talię i kliknij **Gotowy** | Wybierz talię i kliknij **Gotowy** |

Gra startuje, gdy obaj jesteście gotowi. Po partii możecie od razu zagrać **rewanż** albo wrócić do zmiany talii bez rozłączania.

<div align="center">
<img src="docs/lobby.jpg" alt="Okno tworzenia gry online z kodem" width="48%">
&nbsp;
<img src="docs/ready.jpg" alt="Ekran talii z panelem przeciwnika online" width="48%">
<br>
<sub><i>Po lewej: kod gry do wysłania znajomemu. Po prawej: wybór talii i status przeciwnika.</i></sub>
</div>

<br>

## 📜 Zasady w pigułce

Wygrywa ten, kto zwycięży w **dwóch z trzech rund**. Rundę wygrywa gracz z większą liczbą punktów na stole.

- **Tura** to zagranie jednej karty albo użycie zdolności dowódcy.
- **Pas** kończy Twój udział w rundzie, a przeciwnik może dalej dokładać karty.
- **Karty specjalne** zmieniają pogodę, wzmacniają rzędy albo palą najsilniejsze jednostki.
- **Frakcja** ogranicza dostępne karty i daje unikalny bonus (np. Nilfgaard wygrywa remisy).

<details>
<summary><b>Pełne zasady (rozwiń)</b></summary>

<br>

**Karty i punkty.** Punkty zdobywasz, wykładając karty jednostek. Niektóre jednostki mają zdolności specjalne, oznaczone symbolem po lewej stronie karty. Kartę lub cały rząd możesz kliknąć, żeby obejrzeć efekty. Karty specjalne nakładają np. złą pogodę albo wzmacniają punkty.

**Tury.** W swojej turze zagrywasz jedną kartę, potem kolej przeciwnika, aż jeden z was spasuje. Drugi gracz może wtedy dokładać karty, dopóki też nie spasuje. Gdy obaj spasują, runda się kończy. Zamiast karty możesz też użyć zdolności dowódcy, klikając go, jeśli jest dostępna.

**Frakcje.** Wybrana frakcja wpływa na grę na trzy sposoby: ogranicza karty jednostek do tej frakcji (plus neutralne i specjalne), wyznacza dostępnych dowódców i ich zdolności oraz daje pasywny bonus frakcji, opisany na ekranie budowania talii.

</details>

<br>

## 🔧 Jak działa tryb online

<details>
<summary><b>Dla ciekawych — technicznie (rozwiń)</b></summary>

<br>

- **Lockstep:** obie przeglądarki liczą tę samą symulację gry. Przez sieć lecą tylko decyzje graczy: jaka karta, do którego rzędu, pas, dowódca, wybory w okienkach.
- **Wspólna losowość:** tasowanie i losowe efekty korzystają z generatora z tym samym ziarnem, więc u obu graczy dzieje się dokładnie to samo.
- **Kontrola synchronizacji:** po każdej turze gry porównują skrót stanu. Gdyby kiedyś się rozjechały, pojawi się ostrzeżenie, a szczegóły trafią do konsoli (F12).
- **Peer-to-peer:** połączenie WebRTC przez [PeerJS](https://peerjs.com/). Publiczny serwer PeerJS tylko „przedstawia” sobie przeglądarki, a sama gra może leżeć na dowolnym hostingu statycznym, np. GitHub Pages.

Szczegóły, testowanie lokalne i hosting opisuje [ONLINE.md](ONLINE.md).

</details>

> [!NOTE]
> W bardzo restrykcyjnych sieciach (niektóre firmowe lub komórkowe) bezpośrednie połączenie może się nie udać. Pomaga wtedy serwer TURN, który przekazuje ruch między graczami.

### 🛰️ Serwer TURN

Ustawienia STUN/TURN są w pliku [`net-config.js`](net-config.js). Najprościej użyć darmowego [Metered Open Relay](https://www.metered.ca/tools/openrelay/) (20 GB miesięcznie, a partia Gwinta to kilkadziesiąt KB):

1. Załóż konto na [dashboard.metered.ca](https://dashboard.metered.ca/signup?tool=turnserver) i utwórz klucz API do poświadczeń (credential API key).
2. W `net-config.js` wpisz:
   ```js
   window.GWENT_NET_CONFIG = {
   	credentialsUrl: "https://<appname>.metered.live/api/v1/turn/credentials?apiKey=<klucz API>"
   };
   ```
3. Sprawdź, otwierając grę u obu graczy z dopiskiem `?relay` (połączenie tylko przez TURN).

Można też podać stały adres i hasło (`turnUrls`, `turnUsername`, `turnCredential`) albo ustawić wszystko zmiennymi repozytorium przez GitHub Actions. Szczegóły w [ONLINE.md](ONLINE.md#serwer-turn-połączenie-przez-trudne-sieci).

<br>

## 🚀 Uruchomienie u siebie

```bash
git clone https://github.com/igit418/gwent-classic-multiplayer.git
cd gwent-classic-multiplayer
python -m http.server 8000
```

Następnie otwórz `http://localhost:8000`. Do testów online na jednym komputerze dodaj do adresu `?net=local` i otwórz grę w dwóch kartach przeglądarki.

<br>

## 🙏 Podziękowania i licencja

- Oryginalna przeglądarkowa wersja gry: **[Arun Sundaram — gwent-classic](https://github.com/asundr/gwent-classic)**
- Efekty dźwiękowe: **[RandomPianist](https://github.com/RandomPianist/gwent-classic-v3.1)**
- Tryb online: rozwinięcie projektu w tym repozytorium

Kod udostępniany jest na licencji **MIT z warunkiem „Commons Clause”**, który zabrania sprzedaży oprogramowania. Pełny tekst jest w pliku [LICENSE](LICENSE).

<sub>Gwint, Wiedźmin oraz grafiki kart należą do CD PROJEKT RED. To niekomercyjny projekt fanowski, niezwiązany z CD PROJEKT RED.</sub>

<br>

<details>
<summary>🇬🇧 <b>English</b></summary>

<br>

A browser remake of the original Gwent minigame from *The Witcher 3: Wild Hunt*, including all DLC cards, **now with online 1v1 multiplayer**. Click **Graj online** (Play online) on the deck screen, create a game and share the 5-character code with a friend. Both browsers run the same deterministic simulation and exchange only player decisions over a peer-to-peer WebRTC connection, so no game server is needed.

**[▶ Play now](https://igit418.github.io/gwent-classic-multiplayer/)**. Based on [asundr/gwent-classic](https://github.com/asundr/gwent-classic) (MIT + Commons Clause).

</details>
