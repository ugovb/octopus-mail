# Octopus Mail — instrukcje dla agentów (Codex / Astra)

Darmowy, lokalny klient poczty dla Windows i Linuksa (Electron 44 + React 19 + TypeScript + Tailwind v4). Funkcje
w stylu Spark Mail, ale cały kod, grafika i teksty są własne — nie kopiujemy niczego z Readdle/Spark.
Interfejs jest dwujęzyczny: teksty w kodzie po angielsku przez `t()` / `tp()` z `src/shared/i18n.ts`, polskie tłumaczenia
w `src/shared/locales/pl/*.ts` (sprawdzenie: `npm run i18n:check`).

Najpierw przeczytaj `README_pl.md` (albo `README.md`) i `CONTRIBUTING.md`.

## Podział ról
- Claude prowadzi projekt, logikę, testy i review. Astra dostaje konkretne zadania (np. grafika, ikony) i ich nie rozszerza.
- Nie rób commitów ani pushy, dopóki właściciel o to nie poprosi.

## Struktura
- `src/core/` — silnik (IMAP/SMTP, SQLite `node:sqlite`, AI, kalendarz), `src/main/` — proces główny Electron,
  `src/preload/`, `src/renderer/src/` — interfejs React (`components/`, `views/`, `lib/`, `index.css` z tokenami motywu),
  `src/cli/` — CLI `octo` i serwer MCP, `resources/` — ikony i zasoby pakowane do instalatora, `scripts/` — narzędzia budowania.
- Serwer domowy: `src/server/` (HTTP API + parowanie urządzeń; `octo serve`), `src/main/backend.ts` (aplikacja lokalnie albo
  przez serwer), `src/renderer/src/lib/web-bridge.ts` (interfejs w przeglądarce/telefonie), `deploy/` (instalator systemd, Docker).
- Układ na telefon: poniżej 768 px (`useNarrow()` z `lib/narrow.ts`, klasy `max-md:`) — lista albo wątek, menu jako szuflada.
- Motyw: kolory wyłącznie przez tokeny CSS z `src/renderer/src/index.css` (`--accent`, `--surface`, …; klasy Tailwind
  `bg-surface`, `text-muted`, `text-accent` itd.). Interfejs ma motyw jasny i ciemny (`data-theme` na `<html>`).

## Komendy (PowerShell lub bash w katalogu projektu)
- Sprawdzenie typów: `npx tsc --noEmit -p tsconfig.node.json` oraz `npx tsc --noEmit -p tsconfig.web.json`
- Budowa aplikacji: `npx electron-vite build` (offline), CLI: `node scripts/build-cli.mjs`
- Testy silnika wymagają serwera GreenMail (`npm run greenmail` w osobnym oknie) — nie są potrzebne przy zmianach graficznych.

## Zasady
- Nie zmieniaj logiki aplikacji, danych ani testów, jeśli zadanie tego nie wymaga.
- Nowe zależności npm tylko gdy są konieczne (devDependencies), z dokładną wersją.
- Nigdy nie dotykaj `%APPDATA%\Octopus Mail` / `~/.config/Octopus Mail` (prawdziwe dane użytkownika) ani systemowego
  magazynu haseł. Testy i demo: zawsze `OCTO_HOME` w katalogu tymczasowym i `OCTO_SECRETS=memory|file`.
- Logi i błędy w raporcie ucinaj do ostatnich 30 linii.
