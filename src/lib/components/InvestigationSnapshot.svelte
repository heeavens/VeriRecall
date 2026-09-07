<script lang="ts">
  import type { CaseSnapshot } from '$lib/contracts/recall';
  let { snapshot, history, caseNumber }: {
    snapshot: CaseSnapshot;
    history: Array<{ caseVersion: number; materialRevision: number | null; createdAt: string; actorId: string }>;
    caseNumber: string;
  } = $props();

  const positions = $derived([
    { label: 'Affected received total', quantity: snapshot.exposure.received },
    { label: 'Warehouse', quantity: snapshot.exposure.warehouse },
    { label: 'In transit', quantity: snapshot.exposure.inTransit },
    { label: 'Retailer reported', quantity: snapshot.exposure.retailer },
    { label: 'Sold', quantity: snapshot.exposure.sold },
    { label: 'Unaccounted', quantity: snapshot.exposure.unaccounted }
  ]);

  function quantityLabel(quantity: typeof snapshot.exposure.received): string {
    return quantity.knowledgeStatus === 'KNOWN'
      ? `${quantity.value} ${quantity.unit}`
      : quantity.knowledgeStatus;
  }
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
    {#if snapshot.exposure.status === 'CALCULATED'}
      <p>Calculated from persisted source records for investigation revision {snapshot.exposure.basisMaterialRevision}.</p>
      <dl class="positions">
        {#each positions as position}
          <div>
            <dt>{position.label}</dt>
            <dd>{quantityLabel(position.quantity)}</dd>
            <small>{position.quantity.asOf ?? 'No reliable as-of time'} · {position.quantity.sources.length} source(s)</small>
          </div>
        {/each}
      </dl>
      <p><strong>Contained:</strong> {quantityLabel(snapshot.exposure.contained)}. Containment is a property of units and is not added to their location totals.</p>
      {#if snapshot.exposure.gaps.length}
        <h3>Traceability gaps</h3>
        <ul>{#each snapshot.exposure.gaps as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
      {/if}
      {#if snapshot.exposure.conflicts.length}
        <h3>Quantity conflicts</h3>
        <ul>{#each snapshot.exposure.conflicts as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
      {/if}
    {:else}
      <p>Unknown — not calculated. No affected quantity has been established.</p>
    {/if}
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
  h3 { font-size: 17px; margin: 20px 0 8px; }
  p, li { font-size: 16px; line-height: 1.6; }
  article { padding: 24px; margin: 20px 0; }
  ul, ol { padding-left: 24px; }
  .positions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
  .positions div { border: 1px solid #e8e3ef; border-radius: 10px; padding: 14px; }
  dt, small { color: #716b7b; }
  dd { margin: 6px 0; font-size: 20px; font-weight: 700; }
  a { text-decoration: underline; }
  @media (max-width: 680px) { .positions { grid-template-columns: 1fr; } }
</style>
