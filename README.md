# RecallOps AI

RecallOps AI is a local SvelteKit dashboard for a catalogue-aware product recall workflow. Its deterministic demo covers high-confidence, uncertain and not-relevant alerts without requiring an OpenAI API key.

## Requirements

- Node.js 22
- npm 10 or newer
- Docker with Compose (optional)

## Local setup

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:5173/dashboard`.

An empty `OPENAI_API_KEY` automatically enables the deterministic fallback. To restore the seeded demo at any time, run:

```bash
npm run db:reset -- --confirm
```

The reset is development-only, requires explicit confirmation and restores all three scenarios without manual SQLite changes.

## Docker setup

```bash
docker compose up --build
```

Open `http://localhost:4173/dashboard`. The container migrates and idempotently seeds a named local volume before starting. Stop it with `docker compose down`; use `docker compose down --volumes` when a completely fresh Docker database is required.

## Three-minute demo

1. Open **Demo Setup**, choose **Use demo data**, then run monitoring from **Overview**.
2. Verify the feed shows **Confirmed**, **Needs Review** and **Not Relevant**.
3. Open **Review Queue**, request a barcode photo, then confirm the uncertain match.
4. Open the created case, approve one action simulation, and verify the human event in the timeline.
5. Export the case as CSV and PDF. No external message is sent.

## Final verification

```bash
npm run db:migrate
npm run db:seed
npm run check
npm run test
npm run build
docker compose up --build
```

The SQLite database, build output, dependencies and local environment files are ignored by Git.
