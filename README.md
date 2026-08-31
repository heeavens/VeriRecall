# RecallOps AI

RecallOps AI is a local SvelteKit dashboard for a catalogue-aware product recall workflow. Its deterministic demo covers high-confidence, uncertain and not-relevant alerts without requiring an OpenAI API key.

The monitoring button reads archived Safety Gate/RASFF fixtures; it is a prototype cycle, not a live regulatory feed. Deterministic local code calculates every identity score, ranks work by official-alert harm and confidence, selects the next safe step and records the audit trail. Every proposed product identity—including a high-confidence candidate—requires human confirmation before a case opens. Customer and supplier messages remain drafts until a person approves a simulated send.

## Agent and AI boundary

The product is agent-shaped because one workflow monitors alerts, resolves and ranks catalogue candidates, routes uncertainty to review or evidence collection, opens containment tasks after human confirmation, tracks stock and customers, and maintains an exportable incident record.

OpenAI is an optional, server-side language adapter. When both `OPENAI_API_KEY` and `OPENAI_MODEL` are configured, it extracts structured alert fields and explains deterministic match signals in plain language. The adapter also implements constrained action drafting for future workflow use, while the current case drafts are deterministic templates. OpenAI cannot change scores or harm priority, confirm identity, write directly to SQLite, approve actions, send messages or close cases. Invalid output, timeouts and missing credentials use the validated local fallback.

The hackathon challenge needs the controlled agent workflow, but it does not require a generative model to make legal or identity decisions. The prototype therefore remains fully demonstrable without an API key; optional OpenAI output improves extraction and explanation only.

The dashboard reports measured monitoring duration and precision/recall on the three labeled archived fixtures in `data/evaluation/expected-matches.json`. These demo metrics are explicitly not production performance claims. Match confidence and official-alert harm are separate: confidence estimates product identity, while harm describes the source warning if that identity is confirmed.

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

1. Open **Demo Setup**, choose **Use demo data**, then inspect the archived results on **Overview**.
2. Verify the feed shows **High-confidence candidate**, **Needs review** and **Not relevant**, with separate harm and confidence signals.
3. Open **Review**, confirm that even the high-confidence candidate needs a person, then request evidence or confirm one identity.
4. Open the created case, approve the simulated actions and complete every available containment task.
5. Close the case with a reviewer note and evidence reference, then export CSV and PDF. No external message is sent.

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
