# RecallOps AI

RecallOps AI is a local SvelteKit dashboard skeleton for a catalogue-aware product recall workflow. Stage 0 provides the application shell and local SQLite infrastructure only; workflow features are intentionally not implemented yet.

## Requirements

- Node.js 22
- npm 10 or newer

## Local setup

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:5173/dashboard`.

## Validation

```bash
npm run check
npm run test
npm run build
```

The SQLite database is local-only and ignored by Git. `db:seed` is intentionally a no-op until the demo fixtures are introduced in a later stage.
