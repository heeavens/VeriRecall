# VeriRecall project instructions

These instructions apply to the entire repository.

## Working scope

- Implement only the stage that Herman explicitly requests in the current chat. Do not continue into a later stage without a separate instruction.
- Preserve the existing stack, conventions, working features, and previously applied migrations. Do not introduce a new transport, service, framework, or large abstraction without a concrete need.
- Keep Herman's implementation work on the `herman_dev` branch and commit completed stage changes there. Never merge or push to `main` unless Herman explicitly requests it.
- Never discard another developer's changes with destructive Git commands or broad `ours`/`theirs` conflict resolution.
- Update `docs/MVP_STATUS.md` with the verified state after each stage. Update `docs/HANDOFF_TO_FRIEND.md` whenever the completed work or integration instructions for the next developer change.

## Domain invariants

- Keep UNKNOWN distinct from numeric zero and from a confirmed fact.
- Confirming a precautionary action does not resolve evidence gaps or conflicts.
- AI may propose analysis or drafts, but it must not approve scope, make human decisions, or perform significant actions.
- The server must check authorization, ownership, current versions, and the freshness of approvals for significant mutations.
- External actions used for a demo must be explicitly marked as demo results. Test fixtures must never appear as an implicit production fallback.
- Do not read, print, commit, or expose secret values.

## Required completion gate for every requested stage

After implementing a stage and before reporting it as complete or making its final stage commit, apply all three installed skills below to the complete stage diff. A passing test command alone is not sufficient.

Read each skill's current `SKILL.md` when applying it. If a required skill is unavailable, report the missing skill and treat the completion gate as blocked instead of claiming that it ran. For stages that add behavior, use `testing-strategy` once while planning the checks and again against the finished diff.

1. Apply `testing-strategy`.
   - Derive the test plan from the user's stage requirements and domain invariants, independently of the implementation.
   - Map each material acceptance criterion to a unit, integration, contract, migration, HTTP, or UI check as appropriate.
   - Include negative cases, error handling, data integrity, idempotency, and security boundaries where relevant.
   - Prefer meaningful checks over increasing the test count. Do not add tests for trivial framework behavior or tests that merely repeat the implementation.
   - For new behavior, demonstrate that the check can fail before the fix when practical. Keep expected results independent from the production function being tested.
   - Run the relevant focused checks and the repository's required regression checks. Record commands, results, and remaining coverage gaps.

2. Apply `architecture`.
   - Evaluate the finished stage against the current monolith, ownership boundaries, shared contracts, persistence model, migrations, and future integration with the other developer.
   - Check that the change is the smallest coherent extension of the current architecture and does not silently create a second contract or source of truth.
   - Record material decisions and trade-offs in the appropriate project documentation. Create an ADR only for a significant decision that needs a durable alternatives-and-consequences record.
   - Treat unresolved architectural risk as unfinished work or document it explicitly when it is outside the requested stage.

3. Apply `code-review`.
   - Review the actual final diff for correctness, security, authorization, concurrency, error handling, performance, maintainability, migrations, and test quality.
   - Inspect both production code and tests for circular assertions, mocks that bypass the real path, unsafe defaults, missing negative cases, and accidental fixture fallback.
   - Fix all critical and high-severity findings within the requested stage before completion. Report lower-severity findings or explicit limitations instead of hiding them.
   - Re-run affected checks after review fixes. Review the resulting diff again before committing.

The final stage report must state what each of the three skill passes examined, what was fixed or accepted, which checks actually ran, and what remains unverified. Do not claim that a green suite proves the absence of defects.
