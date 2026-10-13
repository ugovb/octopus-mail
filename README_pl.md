<div align="center">

[English](README.md) · **Polski**

<img src="resources/brand/icon.svg" width="96" alt="Logo Octopus Mail" />

# Octopus Mail

### Darmowy klient poczty z Smart Inbox, AI i własnym serwerem domowym zamiast cudzej chmury.

[![Licencja MIT](https://img.shields.io/badge/licencja-MIT-f4c430?style=flat-square)](LICENSE)
[![Windows · Linux](https://img.shields.io/badge/system-Windows%20%C2%B7%20Linux-5b4cf0?style=flat-square)](#instalacja)

<img src="docs/screenshots/desktop.png" alt="Octopus Mail: Smart Inbox i rozmowa" width="1100" />

</div>

---

Octopus Mail daje zwykłym kontom IMAP/SMTP to, co najwygodniejsze w nowoczesnych programach pocztowych:
Smart Inbox, sprawdzanie nowych nadawców, odkładanie, wysyłkę zaplanowaną, przypomnienia o braku
odpowiedzi, szablony, pomoc AI i kalendarz. **Bez wysyłania skrzynki do chmury producenta.** Poczta,
hasła i dane AI zostają na Twoim komputerze albo na małym serwerze w Twoim domu.

## Skąd ten projekt

Spark to świetny program, ale trzyma konta i zaplanowane wysyłki w swojej chmurze, a jego CLI dla agentów
działa tylko przy włączonej aplikacji. Octopus Mail powstał jako eksperyment po filmie *„Every app on
Earth is now open source… whether it likes it or not”* o [REA](https://github.com/morluto/rea): czy jedna
osoba z agentem AI ([Claude Code](https://claude.com/claude-code)) odtworzy funkcje, których używa na co
dzień, jako otwarty program działający lokalnie? Wyszedł działający klient w jeden dzień. Kod, grafika
i nazwa są własne; publiczna lista funkcji Sparka posłużyła tylko jako lista zadań.

## Co działa

**Poczta**
- Wiele kont IMAP/SMTP w jednej skrzynce: Gmail (hasło do aplikacji lub OAuth), Outlook/Microsoft 365
  (OAuth), iCloud, Yahoo, home.pl (wykrywane po rekordzie MX domeny), mail.com, GMX, WP/o2/Onet/Interia,
  Fastmail, Zoho, Proton Bridge i dowolny serwer IMAP. Ustawienia serwera wykrywane automatycznie.
- Synchronizacja przyrostowa, natychmiastowe powiadomienia przez IMAP IDLE, wątki (także wątki Gmaila),
  etykiety Gmaila, starsza poczta doczytywana przy przewijaniu.
- **Smart Inbox**: Ludzie / Powiadomienia / Newslettery, zwijane karty grup, sekcja Priorytet i przypięte.
- **GateKeeper**: nowi nadawcy czekają na akceptację; akceptacja/blokada adresu albo całej domeny.
- **Zrobione**, przypinanie, **odłóż** z językiem naturalnym („jutro 9”, „pt 14:30”, „za 3 dni”),
  **na bok**, **przypomnij, jeśli nikt nie odpowie**, wyciszanie wątków, priorytety, **wypisywanie
  z newsletterów** jednym kliknięciem (RFC 8058).
- **Cofnij** każdą akcję (Ctrl+Z) i **cofnij wysłanie** (0–30 s).
- Edytor z formatowaniem, **szablony z polami** (`{{imię odbiorcy}}`), podpisy per konto, aliasy,
  **wyślij później**, wersje robocze synchronizowane z serwerem.
- Wyszukiwanie pełnotekstowe z operatorami Gmaila (`from: has:attachment newer_than:7d in: filename:` …),
  bez polskich znaków („zolta” znajdzie „żółta”), **inteligentne foldery**.
- Bezpieczny podgląd HTML: blokada zdalnych obrazów i **pikseli śledzących**, zwijane cytaty.
- **Reguły** z testem na istniejącej poczcie, paleta poleceń **Ctrl+K**, skróty klawiszowe, tryb
  jasny/ciemny, ikona w zasobniku z licznikiem.

**AI** (lokalnie przez [Ollamę](https://ollama.com) albo Claude z Twoim kluczem)
- Podsumowanie wątku, odpowiedź w Twoim stylu, poprawianie i zmiana tonu, tłumaczenie, szybkie
  odpowiedzi, „napisz z polecenia”, **pytania do całej poczty** ze źródłami.

**Kalendarz i kontakty**
- Kalendarz Google, CalDAV (iCloud, Fastmail, Nextcloud), subskrypcje ICS, kalendarz lokalny; widoki
  dzień/tydzień/miesiąc/agenda, wydarzenia cykliczne, zaproszenia Tak/Może/Nie, **wolne terminy**.
- Książka adresowa budowana z korespondencji + kontakty Google.

**Serwer domowy (zamiast chmury)**
- `octo serve` na stale włączonym komputerze (Raspberry Pi, NAS, stary laptop) wysyła zaplanowane
  wiadomości, budzi odłożone i przypomnienia, kiedy Twoje komputery są wyłączone.
- Wszystkie komputery widzą te same konta, odłożone i wersje robocze. Telefon i przeglądarka dostają
  interfejs WWW z układem na telefon (można go dodać do ekranu głównego).
- Urządzenia łączysz jednorazowym kodem; każde dostaje własny klucz, który możesz odebrać.

**Agenci AI (CLI i MCP)**
- `octo`: CLI i serwer **MCP** dla Claude Code / Claude Desktop z poziomami dostępu per konto (odczyt /
  porządkowanie / wysyłka). Działa **przy zamkniętej aplikacji**, podaje czas lokalny z przesunięciem,
  ma stałe ID wersji roboczych, **anulowanie zaplanowanej wysyłki** (`octo unschedule`) i dziennik działań.

<div align="center">
<img src="docs/screenshots/phone-inbox.png" alt="Telefon: skrzynka" width="260" />
&nbsp;
<img src="docs/screenshots/phone-thread.png" alt="Telefon: rozmowa" width="260" />
&nbsp;
<img src="docs/screenshots/phone-menu.png" alt="Telefon: menu" width="260" />
</div>

## Instalacja

**Windows:** pobierz `Octopus-Mail-Setup-<wersja>.exe` z
[Releases](https://github.com/CFGPeter/octopus-mail/releases). Instalator nie jest jeszcze podpisany,
więc Windows pokaże „Nieznany wydawca”: wybierz *Więcej informacji → Uruchom mimo to*.

**Linux (aplikacja):** zbuduj AppImage / .deb ze źródeł (niżej). Każda zmiana jest testowana na Ubuntu.

**Serwer domowy (Raspberry Pi 3/4/5/Zero 2 W z 64-bitowym Raspberry Pi OS, Debian, Ubuntu):** pobierz
`octopus-mail-server-<wersja>.tar.gz` z Releases i na serwerze:

```bash
tar xzf octopus-mail-server-*.tar.gz && cd octopus-mail-server
sudo bash install.sh
```

Instalator pobiera Node.js 24 do `/opt/octopus-mail` (systemowego Node nie rusza), instaluje usługę
systemd `octopus-mail` (startuje z systemem, wstaje po awarii) i polecenie `octo`, a na końcu wypisuje
adres serwera i kod parowania. Aktualizacja: to samo z nowym archiwum. Odinstalowanie:
`sudo bash install.sh --uninstall` (konta i poczta zostają).

**Docker** (Synology, QNAP, Unraid…):

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec octopus octo server pair
```

**Podłączanie urządzeń**
- Komputer: Ustawienia → **Serwer domowy** → adres serwera + kod. Aplikacja uruchamia się ponownie
  i korzysta z kont na serwerze.
- Telefon / przeglądarka: otwórz adres serwera i wpisz kod.
- Kolejny kod: `octo server pair` na serwerze albo Ustawienia → Serwer domowy → **Dodaj urządzenie**.
- Serwer trzymaj w sieci domowej, a spoza domu łącz się przez VPN (np. Tailscale, WireGuard), nie przez
  przekierowanie portu w routerze. Szczegóły: [SECURITY.md](SECURITY.md).

## Budowanie ze źródeł

Wymaga Node.js 24.

```bash
npm install
npm run dev           # tryb deweloperski z przeładowaniem
npm run dist          # instalator Windows → dist/
npm run dist:linux    # AppImage + .deb (budować na Linuksie)
npm run dist:server   # archiwum serwera domowego → dist/
npm run icon          # ikony z resources/brand/*.svg (pip install -r scripts/requirements-brand.txt)
```

Dane programu: Windows `%APPDATA%\Octopus Mail`, Linux `~/.config/Octopus Mail`. Hasła i tokeny trafiają
do systemowego magazynu haseł (Menedżer poświadczeń Windows, GNOME Keyring / KWallet), nigdy do bazy.

Antywirusy przechwytujące pocztę (np. Kaspersky) podmieniają certyfikaty serwerów — Octopus Mail ufa
certyfikatom systemu, więc działa z nimi tak jak Outlook.

## CLI i MCP

```bash
octo emails                                   # Smart Inbox
octo search --filter "from:anna newer_than:7d"
octo draft --reply-to 123 --body "Dzięki, pasuje mi piątek."
octo send 45 --at "jutro 9:00"                # wysyłka zaplanowana
octo unschedule 45                            # anulowanie
octo action snooze t12 --until "pon 8:00"
```

Gotowe polecenie `claude mcp add …` do Claude Code jest w aplikacji: Ustawienia → Agenci AI i CLI.
Przy serwerze domowym agent łączy się przez SSH:
`claude mcp add octopus-mail --scope user -- ssh pi@raspberrypi.local octo mcp`.

Domyślnie każde konto ma dla agentów poziom **Odczyt**. Zmienisz go tylko w aplikacji.

## Testy

```bash
npm run greenmail     # lokalny serwer testowy poczty (Java 17+), w osobnym oknie
npm test              # silnik poczty, serwer domowy i kalendarz
```

Testy i profil demonstracyjny (`npm run demo:seed && npm run demo`) nigdy nie dotykają prawdziwych kont.

## Czego (jeszcze) nie ma

| Funkcja | Status |
|---|---|
| Zespoły: udostępnione wątki, komentarze, wspólne skrzynki | etap 2 |
| Notatki ze spotkań (nagrywanie + transkrypcja) | etap 2 (lokalny Whisper) |
| Reguły w języku naturalnym z warunkami AI, automatyczne odpowiedzi | etap 2 |
| Integracje (Todoist, Notion, Trello…) | etap 2 |
| Ekran główny i gesty przesuwania | etap 2 |
| Tworzenie wydarzeń cyklicznych (edycja istniejących działa) | etap 2 |
| Natywna aplikacja na telefon z powiadomieniami push | jest interfejs WWW z serwera domowego |
| Angielska wersja interfejsu | następna w kolejce |
| Potwierdzenia przeczytania (śledzenie otwarć) | świadomie pominięte (prywatność) |

## Licencja i znaki towarowe

[MIT](LICENSE). Octopus Mail to niezależny projekt, niezwiązany z Readdle ani przez nią niepopierany.
Spark i inne nazwy produktów są znakami towarowymi ich właścicieli. Program nie zawiera kodu, grafik
ani tekstów ze Sparka.
