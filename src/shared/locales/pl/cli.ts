// Polish translations: cli. Keys are the English source strings used with t() / tp().
import type { Dictionary } from '../../i18n'

const dict: Dictionary = {
  strings: {
    // the same in Polish
    'newsl.': 'newsl.',
    // ── help (octo help) ──
    'octo {version} — Octopus Mail from the command line (local times with UTC offset)':
      'octo {version} — Octopus Mail z wiersza poleceń (czasy lokalne z przesunięciem UTC)',
    [`Reading:
  octo accounts                              accounts, agent access levels
  octo folders [account]                     folders with counts
  octo emails [mailbox] [--filter q] [--page N] [--page-size N] [--unread]
       mailbox: Inbox|Sent|Archive|Trash|Spam|pinned|snoozed|aside|reminders|newsenders|
                people|notifications|newsletters|account@x.com|account@x.com:Folder|<smart folder>
  octo search ["topic"] [--filter q] [--in account|account:Folder] [--page N]   (all folders)
  octo thread <ID|tID> [--html]              whole thread with bodies and attachments
  octo attachment <ID> [--save file] [--stream]
  octo contacts [query]  ·  octo templates  ·  octo template <ID|name>`]: `Czytanie:
  octo accounts                              konta, poziomy dostępu agentów
  octo folders [konto]                       foldery z licznikami
  octo emails [skrzynka] [--filter q] [--page N] [--page-size N] [--unread]
       skrzynka: Inbox|Sent|Archive|Trash|Spam|pinned|snoozed|aside|reminders|newsenders|
                 people|notifications|newsletters|konto@x.pl|konto@x.pl:Folder|<inteligentny folder>
  octo search ["temat"] [--filter q] [--in konto|konto:Folder] [--page N]   (wszystkie foldery)
  octo thread <ID|tID> [--html]              cały wątek z treścią i załącznikami
  octo attachment <ID> [--save plik] [--stream]
  octo contacts [fraza]  ·  octo templates  ·  octo template <ID|nazwa>`,
    [`Writing and sending (draft IDs never change):
  octo draft --to a@b.com [--cc ..] [--bcc ..] --subject "…" --body "markdown…"
             [--reply-to ID [--reply-all]] [--forward ID] [--account account] [--attach file]
             [--template name --placeholder "Field=value"] [--no-signature] [--edit ID]
  octo draft --delete ID
  octo drafts  ·  octo scheduled
  octo send <ID> [--at "tomorrow 9:00"] [--remind "in 3 days"]   sends and waits for SMTP confirmation
  octo unschedule <ID>                       cancels a scheduled send (back to drafts)`]: `Pisanie i wysyłka (stałe ID wersji roboczych):
  octo draft --to a@b.pl [--cc ..] [--bcc ..] --subject "…" --body "markdown…"
             [--reply-to ID [--reply-all]] [--forward ID] [--account konto] [--attach plik]
             [--template nazwa --placeholder "Pole=wartość"] [--no-signature] [--edit ID]
  octo draft --delete ID
  octo drafts  ·  octo scheduled
  octo send <ID> [--at "jutro 9:00"] [--remind "za 3 dni"]   wysyła i czeka na potwierdzenie SMTP
  octo unschedule <ID>                       anuluje zaplanowaną wysyłkę (wraca do wersji roboczych)`,
    [`Organizing (message ID or t<thread ID>, several allowed):
  octo action archive|inbox|trash|delete-forever|spam|not-spam|read|unread|pin|unpin|
              mute|unmute|aside|unaside|priority|unpriority|unsubscribe <ID...>
  octo action snooze <ID...> --until "mon 8:00"   ·  octo action unsnooze <ID...>
  octo action remind <ID...> --at "in 3 days" [--if-no-reply]  ·  octo action unremind <ID...>
  octo action move <ID...> --folder "account@x.com:Folder"  ·  octo action label|unlabel <ID...> --label X
  octo sender accept|block|unblock|vip|unvip <email|@domain...>
  octo sender category <email...> people|notification|newsletter`]: `Porządkowanie (ID wiadomości albo t<ID wątku>, można kilka):
  octo action archive|inbox|trash|delete-forever|spam|not-spam|read|unread|pin|unpin|
              mute|unmute|aside|unaside|priority|unpriority|unsubscribe <ID...>
  octo action snooze <ID...> --until "pon 8:00"   ·  octo action unsnooze <ID...>
  octo action remind <ID...> --at "za 3 dni" [--if-no-reply]  ·  octo action unremind <ID...>
  octo action move <ID...> --folder "konto@x.pl:Folder"  ·  octo action label|unlabel <ID...> --label X
  octo sender accept|block|unblock|vip|unvip <email|@domena...>
  octo sender category <email...> people|notification|newsletter`,
    [`Calendar:
  octo events [--from "today"] [--to "in 7 days"]  ·  octo availability [--days 5] [--duration 30]
  octo event create --title "…" --start "tomorrow 10:00" [--end "tomorrow 11:00"] [--attendee a@b.com] [--location …]
  octo event delete <ID>  ·  octo invite <message ID>  ·  octo rsvp <message ID> accept|maybe|decline`]: `Kalendarz:
  octo events [--from "dziś"] [--to "za 7 dni"]  ·  octo availability [--days 5] [--duration 30]
  octo event create --title "…" --start "jutro 10:00" [--end "jutro 11:00"] [--attendee a@b.pl] [--location …]
  octo event delete <ID>  ·  octo invite <ID wiadomości>  ·  octo rsvp <ID wiadomości> accept|maybe|decline`,
    [`AI (Ollama or Claude, per settings):
  octo ai summarize <ID|tID>  ·  octo ai reply <ID|tID> [--instructions "…"]  ·  octo ai ask "question"`]: `AI (Ollama lub Claude wg ustawień):
  octo ai summarize <ID|tID>  ·  octo ai reply <ID|tID> [--instructions "…"]  ·  octo ai ask "pytanie"`,
    [`Other:
  octo status · octo sync [account] · octo history [--limit N] · octo daemon (sync without a window)
  octo serve [--port 8787]   home server (e.g. Raspberry Pi): 24/7 engine + API + web interface
  octo server pair | devices | revoke <ID>    pairing codes and paired devices
  octo mcp   (MCP server on stdio for Claude Code / Claude Desktop)
Global: --json (machine-readable data), --no-sync (don't fetch new mail first)`]: `Inne:
  octo status · octo sync [konto] · octo history [--limit N] · octo daemon (synchronizacja bez okna)
  octo serve [--port 8787]   serwer domowy (np. Raspberry Pi): silnik 24/7 + API + interfejs WWW
  octo server pair | devices | revoke <ID>    kody parowania i sparowane urządzenia
  octo mcp   (serwer MCP na stdio dla Claude Code / Claude Desktop)
Globalne: --json (dane maszynowe), --no-sync (bez dociągania poczty)`,

    // ── errors and messages ──
    'Could not understand the date for {label}: "{input}". Examples: "tomorrow 9:00", "fri 14:30", "in 2 hours", "2026-10-20 09:15".':
      'Nie rozumiem daty dla {label}: „{input}”. Przykłady: "jutro 9:00", "pt 14:30", "za 2 godziny", "2026-10-20 09:15".',
    'No message with ID {id} (give threads as t<ID>)': 'Nie ma wiadomości o ID {id} (wątki podawaj jako t<ID>)',
    'Invalid ID: {id}': 'Nieprawidłowe ID: {id}',
    'Give a message ID or a thread ID (t<ID>)': 'Podaj ID wiadomości lub wątku (t<ID>)',
    'No account {email}': 'Nie ma konta {email}',
    'Account {email} has no folder "{folder}" (see: octo folders {email})': 'Konto {email} nie ma folderu „{folder}” (zobacz: octo folders {email})',
    'Unknown mailbox "{name}". Use: Inbox, Sent, Archive, Trash, Spam, pinned, snoozed, aside, reminders, newsenders, account@x.com or account@x.com:Folder':
      'Nieznana skrzynka „{name}”. Użyj: Inbox, Sent, Archive, Trash, Spam, pinned, snoozed, aside, reminders, newsenders, konto@x.pl lub konto@x.pl:Folder',
    'The app is not running — fetching new mail…': 'Aplikacja nie działa — pobieram nowe wiadomości…',
    'Error: {message}': 'Błąd: {message}',
    'Unknown command "{cmd}". See: octo help': 'Nieznane polecenie „{cmd}”. Zobacz: octo help',

    // ── thread list (emails, search) ──
    Me: 'Ja',
    person: 'osoba',
    'notif.': 'powiad.',
    THREAD: 'WĄTEK',
    DATE: 'DATA',
    FROM: 'OD',
    SUBJECT: 'TEMAT',
    'CAT.': 'KAT.',
    FLAGS: 'FLAGI',
    ACCOUNT: 'KONTO',
    'New senders awaiting a decision: {n} (octo emails newsenders)': 'Nowi nadawcy czekający na decyzję: {n} (octo emails newsenders)',
    'Page {page}. Flags: U unread, P pinned, ! priority, A attachment, S snoozed, R reminder, N new sender, D draft, M muted, B set aside':
      'Strona {page}. Flagi: U nieprz., P przypięty, ! priorytet, A załącznik, S odłożony, R przypomnienie, N nowy nadawca, D wersja robocza, M wyciszony, B na boku',
    'Give a topic or --filter': 'Podaj temat albo --filter',
    'ID: {id} (thread t{thread}) · {date} · {account} · {folder}\nFrom: {from}\nSubject: {subject}':
      'ID: {id} (wątek t{thread}) · {date} · {account} · {folder}\nOd: {from}\nTemat: {subject}',
    'Nothing found.': 'Nic nie znaleziono.',
    'Threads found: {total} (page {page})': 'Znaleziono wątków: {total} (strona {page})',

    // ── thread ──
    'Give a message ID or t<thread ID>': 'Podaj ID wiadomości albo t<ID wątku>',
    'Thread does not exist': 'Wątek nie istnieje',
    'Warning: not all message bodies were downloaded ({error})': 'Uwaga: nie pobrano wszystkich treści ({error})',
    'Thread t{id}: {subject}': 'Wątek t{id}: {subject}',
    'Account: {account} · messages: {n} · category: {category}': 'Konto: {account} · wiadomości: {n} · kategoria: {category}',
    pinned: 'przypięty',
    'snoozed until {time}': 'odłożony do {time}',
    'reminder {time}': 'przypomnienie {time}',
    'labels: {labels}': 'etykiety: {labels}',
    UNREAD: 'NIEPRZECZYTANA',
    'From: {from}': 'Od: {from}',
    'To: {to}': 'Do: {to}',
    'Cc: {cc}': 'DW: {cc}',
    'Bcc: {bcc}': 'UDW: {bcc}',
    'Subject: {subject}': 'Temat: {subject}',
    '📅 Contains an invitation (octo invite {id})': '📅 Zawiera zaproszenie (octo invite {id})',
    '(no content)': '(brak treści)',
    'Attachments:': 'Załączniki:',
    '(not downloaded — octo attachment {id})': '(nie pobrany — octo attachment {id})',
    NAME: 'NAZWA',
    SIZE: 'ROZMIAR',
    TYPE: 'TYP',
    PATH: 'ŚCIEŻKA',
    'DRAFT ID: {id} · {status}': 'WERSJA ROBOCZA ID: {id} · {status}',
    'send at {time}': 'wysyłka {time}',

    // ── attachment ──
    'Give an attachment ID (the ID column in octo thread)': 'Podaj ID załącznika (kolumna ID w octo thread)',
    'ID: {id}\nName: {name}\nSize: {size}\nType: {type}\nPath: {path}\nMessage: {message}':
      'ID: {id}\nNazwa: {name}\nRozmiar: {size}\nTyp: {type}\nŚcieżka: {path}\nWiadomość: {message}',

    // ── accounts, folders, contacts, templates ──
    'no access': 'brak',
    read: 'odczyt',
    triage: 'porządkowanie',
    send: 'wysyłka',
    'AGENT ACCESS': 'DOSTĘP AGENTÓW',
    SYNC: 'SYNCHRONIZACJA',
    ERROR: 'BŁĄD',
    'FOLDER (identifier)': 'FOLDER (identyfikator)',
    ROLE: 'ROLA',
    TOTAL: 'WSZYSTKIE',
    'UNREAD THREADS': 'NIEPRZ. WĄTKI',
    EMAIL: 'E-MAIL',
    CATEGORY: 'KATEGORIA',
    SENT: 'WYSŁ.',
    RECEIVED: 'ODEBR.',
    LAST: 'OSTATNIO',
    FIELDS: 'POLA',
    MODIFIED: 'ZMIENIONY',
    'ID: {id}\nName: {name}\nSubject: {subject}\nTo: {to}': 'ID: {id}\nNazwa: {name}\nTemat: {subject}\nDo: {to}',
    'Fields:': 'Pola:',
    '(none)': '(brak)',

    // ── drafts, sending ──
    TO: 'DO',
    UPDATED: 'ZMIENIONA',
    'SEND AT': 'WYSYŁKA',
    'Cancel: octo unschedule <ID>': 'Anulowanie: octo unschedule <ID>',
    'Draft {id} deleted.': 'Usunięto wersję roboczą {id}.',
    'File not found: {path}': 'Nie ma pliku {path}',
    'File {path} is larger than 25 MB': 'Plik {path} ma ponad 25 MB',
    file: 'plik',
    'Status: draft (the ID will not change)': 'Status: wersja robocza (ID się nie zmieni)',
    'Attachments: {list}': 'Załączniki: {list}',
    'Send: octo send {id}  ·  Open: octopus-mail://draft/{id}': 'Wysyłka: octo send {id}  ·  Otwórz: octopus-mail://draft/{id}',
    'Give a draft ID': 'Podaj ID wersji roboczej',
    'Warning: the app is not running — the message will go out only when you start Octopus Mail or `octo daemon`.':
      'Uwaga: aplikacja nie działa — wiadomość wyjdzie dopiero, gdy uruchomisz Octopus Mail albo `octo daemon`.',
    'Scheduled: {subject}\nSend at: {time}\nCancel: octo unschedule {id}': 'Zaplanowano: {subject}\nWysyłka: {time}\nAnulowanie: octo unschedule {id}',
    'Sent: {subject} ({time})': 'Wysłano: {subject} ({time})',
    'Not sent (status: {status}): {error}': 'Nie wysłano (status: {status}): {error}',
    'Not sent (status: {status})': 'Nie wysłano (status: {status})',
    'Send cancelled. "{subject}" is a draft again (ID {id}).': 'Anulowano wysyłkę. „{subject}” jest znowu wersją roboczą (ID {id}).',

    // ── actions, senders ──
    'Give an action (octo help)': 'Podaj akcję (octo help)',
    '--folder must point to an account folder, e.g. account@x.com:Projects': '--folder musi wskazywać folder konta, np. konto@x.pl:Projekty',
    'Give --label': 'Podaj --label',
    'Unknown action "{action}"': 'Nieznana akcja „{action}”',
    'Action partly failed: {errors}': 'Akcja częściowo nieudana: {errors}',
    'OK: {result} (threads: {threads})': 'OK: {result} (wątki: {threads})',
    'Category: people|notification|newsletter': 'Kategoria: people|notification|newsletter',
    'Give address(es) or @domain': 'Podaj adres(y) lub @domenę',

    // ── calendar, AI ──
    '{date} (all day)': '{date} (cały dzień)',
    START: 'POCZĄTEK',
    END: 'KONIEC',
    EVENT: 'WYDARZENIE',
    CALENDAR: 'KALENDARZ',
    'MY RSVP': 'MOJA ODP.',
    MEETING: 'SPOTKANIE',
    'No free slots in this range.': 'Brak wolnych terminów w tym zakresie.',
    'Give --title and --start': 'Podaj --title i --start',
    'Created event {id}: {title} · {time}': 'Utworzono wydarzenie {id}: {title} · {time}',
    'Event deleted.': 'Usunięto wydarzenie.',
    'This message does not contain an invitation.': 'Ta wiadomość nie zawiera zaproszenia.',
    'octo rsvp <message ID> accept|maybe|decline': 'octo rsvp <ID wiadomości> accept|maybe|decline',
    'Invitation response sent.': 'Wysłano odpowiedź na zaproszenie.',
    'Sources: {list}': 'Źródła: {list}',

    // ── status, sync, daemon, history ──
    'Sync engine: running ({owner}, pid {pid})': 'Silnik synchronizacji: działa ({owner}, pid {pid})',
    'Sync engine: NOT running — start the app or `octo daemon`': 'Silnik synchronizacji: NIE działa — uruchom aplikację albo `octo daemon`',
    '{email}: last sync {time} — ERROR: {error}': '{email}: ostatnia synchronizacja {time} — BŁĄD: {error}',
    '{email}: last sync {time}': '{email}: ostatnia synchronizacja {time}',
    'Queued operations: {n}': 'Operacje w kolejce: {n}',
    'Syncing {email}…': 'Synchronizuję {email}…',
    'Done.': 'Gotowe.',
    'Sync is already running (the app or another daemon).': 'Synchronizacja już działa (aplikacja albo inny daemon).',
    'Octopus Mail daemon is running (Ctrl+C to stop).': 'Octopus Mail daemon działa (Ctrl+C kończy).',
    WHEN: 'KIEDY',
    WHO: 'KTO',
    ACTION: 'AKCJA',
    TARGET: 'CEL',
    RESULT: 'WYNIK',
    DETAILS: 'SZCZEGÓŁY',

    // ── home server (octo serve / octo server) ──
    'A sync engine is already running on this computer (the app or a daemon). Close it before starting the server.':
      'Na tym komputerze działa już silnik synchronizacji (aplikacja albo daemon). Zamknij go przed uruchomieniem serwera.',
    [`Octopus Mail — home server is running.

Address:  {addresses}
Pairing code (valid for 15 min): {code}

In the app: Settings → Home server → enter the address and code. In a browser or on a phone, open the address.
New code: octo server pair · Device list: octo server devices · Ctrl+C to stop.`]: `Octopus Mail — serwer domowy działa.

Adres:  {addresses}
Kod parowania (ważny 15 min): {code}

W aplikacji: Ustawienia → Serwer domowy → wpisz adres i kod. W przeglądarce/telefonie otwórz adres.
Nowy kod: octo server pair · Lista urządzeń: octo server devices · Ctrl+C kończy.`,
    'Pairing code: {code}\nValid until: {time} (single use)': 'Kod parowania: {code}\nWażny do: {time} (jednorazowy)',
    DEVICE: 'URZĄDZENIE',
    PAIRED: 'SPAROWANE',
    'LAST SEEN': 'OSTATNIO',
    'Give a device ID (octo server devices)': 'Podaj ID urządzenia (octo server devices)',
    'Access revoked.': 'Odebrano dostęp.',
    'No such device.': 'Nie ma takiego urządzenia.',
  },
  plurals: {},
}
export default dict
