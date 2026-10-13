# Contributing

Thanks for helping! Octopus Mail is a hobby project, so small, focused pull requests work best.

## Getting started

```bash
npm install
npm run dev          # app with hot reload
npm run typecheck
npm run greenmail    # local test mail server (needs Java 17+), keep it running
npm test             # mail engine, home server and calendar tests
npm run demo:seed && npm run demo   # demo profile with sample mail
```

Tests and the demo never touch your real profile: they run with `OCTO_HOME` pointing to a
temporary folder and `OCTO_SECRETS=memory|file`. Please keep it that way in new tests.

## Guidelines

- The UI is in Polish for now. Keep new texts in Polish; an English translation is planned.
- Colours come only from the theme tokens in `src/renderer/src/index.css` (light and dark).
- Engine changes need a test in `tests/` (GreenMail covers IMAP/SMTP).
- Octopus Mail is an independent project. Do not contribute code, images or text taken from
  Spark or any other proprietary app.
