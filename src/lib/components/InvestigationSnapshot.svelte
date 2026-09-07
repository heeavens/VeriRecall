<script lang="ts">
  import type { CaseSnapshot } from '$lib/contracts/recall';
  let { snapshot, history, caseNumber }: {
    snapshot: CaseSnapshot;
    history: Array<{ caseVersion: number; materialRevision: number | null; createdAt: string; actorId: string }>;
    caseNumber: string;
  } = $props();
</script>

<section class="investigation">
  <a href="/cases">← Cases</a>
  <h1>{caseNumber}</h1>
  <p><span class="badge badge-orange">{snapshot.stage}</span> <span class="badge badge-gray">DEMO ONLY</span></p>
  <p>Case version {snapshot.caseVersion} · Investigation revision {snapshot.materialRevision ?? 'Not received'} · Updated {snapshot.updatedAt}</p>
  <article class="card">
    <h2>Investigation</h2>
    <p>Identity: {snapshot.investigation?.identity.conclusion ?? 'UNRESOLVED'} · {snapshot.investigation?.identity.knowledgeStatus ?? 'UNKNOWN'}</p>
    <p>Scope: {snapshot.investigation?.scope.kind ?? 'UNRESOLVED'} · {snapshot.investigation?.scope.knowledgeStatus ?? 'UNKNOWN'}</p>
    {#if snapshot.investigation?.scope.kind === 'BATCH_LOT'}
      <p>Reported lots: {snapshot.investigation.scope.lots.join(', ')}</p>
    {/if}
    <p>Identity and scope decisions have not been verified. This record does not authorize containment actions.</p>
  </article>
  <article class="card">
    <h2>Exposure</h2>
    <p>Unknown — not calculated. No affected quantity has been established.</p>
    <p>Task assessment is pending. An empty task list does not mean the case is ready to close.</p>
  </article>
  <article class="card">
    <h2>Requires review</h2>
    <p>Closure: {snapshot.closure.status}</p>
    <ul>{#each snapshot.attentionItems as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
  </article>
  <article class="card">
    <h2>Saved history</h2>
    <ol>{#each history as revision}<li>Case v{revision.caseVersion} · Investigation {revision.materialRevision ?? 'not received'} · {revision.createdAt} · {revision.actorId}</li>{/each}</ol>
  </article>
  <a href={`/api/cases/${snapshot.caseId}/snapshot`}>View snapshot JSON</a>
</section>

<style>
  .investigation { max-width: 1000px; margin: 0 auto; padding: 16px; overflow-wrap: anywhere; }
  h1 { font-size: 28px; margin: 16px 0; }
  h2 { font-size: 20px; margin-bottom: 12px; }
  p, li { font-size: 16px; line-height: 1.6; }
  article { padding: 24px; margin: 20px 0; }
  ul, ol { padding-left: 24px; }
  a { text-decoration: underline; }
</style>
