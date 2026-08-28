# RecallOps AI

RecallOps AI is a local SvelteKit dashboard for a catalogue-aware product recall workflow. The current demo database includes deterministic high-confidence, uncertain, and not-relevant recall scenarios.

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

The SQLite database is local-only and ignored by Git. Seeding is idempotent, so `npm run db:seed` can be run more than once without creating duplicates.

To restore the deterministic fixtures in development, explicitly confirm the reset:

```bash
npm run db:reset -- --confirm
```

The reset utility refuses to run when `NODE_ENV=production`.
