<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';

  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let search = $state('');
  let missingOnly = $state(false);

  const normalizedSearch = $derived(search.trim().toLocaleLowerCase('en'));
  const filteredProducts = $derived.by(() =>
    data.catalogue.products.filter((item) => {
      const { product } = item;
      const matchesSearch =
        normalizedSearch.length === 0 ||
        [product.name, product.sku, product.brand, product.ean ?? ''].some((value) =>
          value.toLocaleLowerCase('en').includes(normalizedSearch)
        );
      const hasMissingData = !product.ean?.trim() || !product.batch?.trim();
      return matchesSearch && (!missingOnly || hasMissingData);
    })
  );

  function clearFilters(): void {
    search = '';
    missingOnly = false;
  }

  function caseStatusLabel(status: string): string {
    if (status === 'closed') return 'Closed case';
    if (status === 'contained') return 'Contained case';
    return 'Open case';
  }

  function caseStatusClass(status: string): string {
    if (status === 'closed') return 'badge-green';
    if (status === 'contained') return 'badge-purple';
    return 'badge-orange';
  }

  function alertStatusLabel(alertStatus: string, matchStatus: string): string {
    if (alertStatus === 'not_relevant' || matchStatus === 'rejected') return 'Not relevant';
    if (matchStatus === 'confirmed') return 'Confirmed match';
    if (matchStatus === 'awaiting_evidence') return 'Evidence requested';
    return 'Needs review';
  }

  function alertStatusClass(alertStatus: string, matchStatus: string): string {
    if (alertStatus === 'not_relevant' || matchStatus === 'rejected') return 'badge-gray';
    if (matchStatus === 'confirmed') return 'badge-green';
    if (matchStatus === 'awaiting_evidence') return 'badge-yellow';
    return 'badge-orange';
  }

  function sourceLabel(source: string): string {
    return source === 'safety_gate' ? 'Safety Gate' : 'RASFF';
  }
</script>

<svelte:head>
  <title>Product Catalogue | Recall Agent</title>
  <meta
    name="description"
    content="Review the company catalogue and the identifiers used to match official recall alerts."
  />
</svelte:head>

<section aria-labelledby="catalogue-title">
  <WorkflowBreadcrumbs items={[{ label: 'Overview', href: '/dashboard' }, { label: 'Catalogue' }]} />
  <header class="catalogue-heading">
    <div>
      <h1 id="catalogue-title">Product Catalogue</h1>
      <p>Review the company records and identifiers used to match official safety alerts.</p>
    </div>
    <div class="catalogue-heading__actions">
      <a class="btn btn-secondary" href="/onboarding">
        <Icon name="upload" size={16} />
        Manage Import
      </a>
      {#if data.catalogue.summary.totalProducts > 0}
        <a class="btn btn-primary" href="/dashboard#archive-check">
          Check Alerts <Icon name="arrow-right" size={14} />
        </a>
      {/if}
    </div>
  </header>

  {#if data.catalogue.summary.totalProducts === 0}
    <article class="card catalogue-empty">
      <span class="catalogue-empty__icon"><Icon name="package" size={23} /></span>
      <h2>No catalogue uploaded</h2>
      <p>
        Upload a CSV or XLSX catalogue before running monitoring. The agent needs your product
        identifiers to compare official alerts with company stock.
      </p>
      <a class="btn btn-primary" href="/onboarding">
        <Icon name="upload" size={16} />
        Upload catalogue
      </a>
    </article>
  {:else}
    <div class="catalogue-summary" aria-label="Catalogue data quality">
      <article class="card catalogue-stat">
        <span>Total products</span>
        <strong>{data.catalogue.summary.totalProducts.toLocaleString('en')}</strong>
        <p>Available for alert matching</p>
      </article>
      <article class="card catalogue-stat">
        <span>Missing EAN / GTIN</span>
        <strong class:catalogue-stat__warning={data.catalogue.summary.missingEan > 0}>
          {data.catalogue.summary.missingEan.toLocaleString('en')}
        </strong>
        <p>Barcode identity is unavailable</p>
      </article>
      <article class="card catalogue-stat">
        <span>Missing batch</span>
        <strong class:catalogue-stat__warning={data.catalogue.summary.missingBatch > 0}>
          {data.catalogue.summary.missingBatch.toLocaleString('en')}
        </strong>
        <p>Batch-level matching is weaker</p>
      </article>
    </div>

    <div class="catalogue-context" role="note">
      <span class="catalogue-context__icon"><Icon name="scan-barcode" size={18} /></span>
      <p>
        <strong>How matching uses this data:</strong> EAN/GTIN is the strongest identity signal.
        Product name, brand and batch add supporting evidence; missing identifiers may send a
        candidate to human review.
      </p>
    </div>

    <div class="catalogue-toolbar">
      <label class="catalogue-search">
        <span class="sr-only">Search the product catalogue</span>
        <Icon name="search" size={17} />
        <input
          type="search"
          bind:value={search}
          placeholder="Search product, SKU, brand or EAN"
          autocomplete="off"
        />
      </label>
      <button
        class="filter-chip"
        class:active={missingOnly}
        type="button"
        aria-pressed={missingOnly}
        onclick={() => (missingOnly = !missingOnly)}
      >
        <Icon name="triangle-alert" size={15} />
        Missing data
        <span>{data.catalogue.summary.missingAnyIdentifier}</span>
      </button>
      <p class="catalogue-result-count" aria-live="polite">
        {filteredProducts.length} of {data.catalogue.summary.totalProducts} products
      </p>
    </div>

    <div class="table-wrap catalogue-table-wrap">
      {#if filteredProducts.length === 0}
        <div class="catalogue-no-results">
          <span><Icon name="search" size={20} /></span>
          <h2>No products found</h2>
          <p>Try another product name or clear the missing-data filter.</p>
          <button class="btn btn-secondary" type="button" onclick={clearFilters}>Clear filters</button>
        </div>
      {:else}
        <div class="table-scroll">
          <table class="data-table catalogue-table">
            <thead>
              <tr>
                <th class="catalogue-table__product">Product</th>
                <th>Internal SKU</th>
                <th>Brand</th>
                <th>EAN / GTIN</th>
                <th>Batch</th>
                <th>Supplier</th>
                <th class="catalogue-table__stock">Stock</th>
                <th class="catalogue-table__workflow">Related workflow</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredProducts as item (item.product.id)}
                <tr>
                  <td>
                    <strong class="catalogue-product-name">{item.product.name}</strong>
                    <span class="catalogue-product-category">{item.product.category ?? 'Uncategorised'}</span>
                  </td>
                  <td><code>{item.product.sku}</code></td>
                  <td>{item.product.brand}</td>
                  <td>
                    {#if item.product.ean}
                      <code>{item.product.ean}</code>
                    {:else}
                      <span class="missing-value"><Icon name="triangle-alert" size={13} /> Missing EAN</span>
                    {/if}
                  </td>
                  <td>
                    {#if item.product.batch}
                      <code>{item.product.batch}</code>
                    {:else}
                      <span class="missing-value"><Icon name="triangle-alert" size={13} /> Missing batch</span>
                    {/if}
                  </td>
                  <td>{item.product.supplierName ?? 'Not provided'}</td>
                  <td class="catalogue-stock">
                    <strong>{item.product.stockQuantity.toLocaleString('en')}</strong>
                    <span>units</span>
                  </td>
                  <td>
                    {#if item.cases[0]}
                      <div class="catalogue-workflow">
                        <a href={`/cases/${item.cases[0].caseId}`}>{item.cases[0].caseNumber}</a>
                        <span class={`badge ${caseStatusClass(item.cases[0].status)}`}>
                          {caseStatusLabel(item.cases[0].status)}
                        </span>
                        <small>{item.cases[0].sourceReference}</small>
                      </div>
                    {:else if item.alerts[0]}
                      <div class="catalogue-workflow">
                        <a href={`/alerts/${item.alerts[0].alertId}`}>
                          {item.alerts[0].sourceReference}
                        </a>
                        <span
                          class={`badge ${alertStatusClass(item.alerts[0].alertStatus, item.alerts[0].matchStatus)}`}
                        >
                          {alertStatusLabel(item.alerts[0].alertStatus, item.alerts[0].matchStatus)}
                        </span>
                        <small>
                          {sourceLabel(item.alerts[0].source)} · {item.alerts[0].totalScore}% confidence
                        </small>
                      </div>
                    {:else}
                      <span class="catalogue-unlinked">No related alerts</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .catalogue-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 20px;
  }

  .catalogue-heading h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.035em;
  }

  .catalogue-heading p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .catalogue-heading__actions {
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
  }

  .catalogue-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }

  .catalogue-stat {
    padding: 17px 18px;
  }

  .catalogue-stat > span {
    display: block;
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .catalogue-stat strong {
    display: block;
    margin-top: 7px;
    font-size: 27px;
    letter-spacing: -0.035em;
    line-height: 1;
  }

  .catalogue-stat strong.catalogue-stat__warning {
    color: #a56c16;
  }

  .catalogue-stat p {
    margin: 7px 0 0;
    color: var(--muted);
    font-size: 11px;
  }

  .catalogue-context {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 12px;
    border: 1px solid #e6ddf4;
    border-radius: 10px;
    background: #faf8fd;
    padding: 12px 14px;
    color: #5f5869;
  }

  .catalogue-context__icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--violet-600);
  }

  .catalogue-context p {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
  }

  .catalogue-context strong {
    color: var(--ink);
  }

  .catalogue-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .catalogue-search {
    display: flex;
    width: min(420px, 100%);
    height: 38px;
    align-items: center;
    gap: 9px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    padding: 0 12px;
    color: var(--muted);
  }

  .catalogue-search:focus-within {
    border-color: #b89dea;
    box-shadow: 0 0 0 3px rgba(132, 82, 231, 0.1);
  }

  .catalogue-search input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 12px;
  }

  .catalogue-search input::placeholder {
    color: #96909d;
  }

  .catalogue-toolbar .filter-chip {
    height: 38px;
    font-size: 11px;
  }

  .catalogue-toolbar .filter-chip span {
    display: grid;
    min-width: 19px;
    height: 19px;
    place-items: center;
    border-radius: 999px;
    background: #f1edf5;
    padding: 0 5px;
    font-size: 9px;
  }

  .catalogue-toolbar .filter-chip.active span {
    background: #fff;
  }

  .catalogue-result-count {
    margin: 0 0 0 auto;
    color: var(--muted);
    font-size: 11px;
  }

  .catalogue-table-wrap {
    min-height: 220px;
  }

  .catalogue-table {
    min-width: 1080px;
    table-layout: auto;
  }

  .catalogue-table th,
  .catalogue-table td {
    padding-right: 14px;
    padding-left: 14px;
  }

  .catalogue-table th {
    font-size: 10px;
  }

  .catalogue-table td {
    height: 70px;
    font-size: 12px;
    line-height: 1.4;
    vertical-align: middle;
  }

  .catalogue-table__product {
    width: 220px;
  }

  .catalogue-table__stock {
    width: 78px;
  }

  .catalogue-table__workflow {
    width: 190px;
  }

  .catalogue-table code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    white-space: nowrap;
  }

  .catalogue-product-name {
    display: block;
    max-width: 230px;
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .catalogue-product-category,
  .catalogue-stock span,
  .catalogue-workflow small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 10px;
  }

  .catalogue-stock strong {
    font-size: 13px;
  }

  .missing-value {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border-radius: 6px;
    background: #fff7e8;
    padding: 5px 7px;
    color: #9a661c;
    font-size: 10px;
    font-weight: 650;
    white-space: nowrap;
  }

  .catalogue-workflow a {
    display: block;
    width: max-content;
    max-width: 170px;
    overflow: hidden;
    color: var(--violet-700);
    font-size: 11px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .catalogue-workflow a:hover {
    text-decoration: underline;
  }

  .catalogue-workflow .badge {
    margin-top: 5px;
  }

  .catalogue-unlinked {
    color: var(--muted);
    font-size: 11px;
  }

  .catalogue-empty,
  .catalogue-no-results {
    display: grid;
    min-height: 390px;
    place-items: center;
    align-content: center;
    padding: 36px;
    text-align: center;
  }

  .catalogue-empty__icon,
  .catalogue-no-results > span {
    display: grid;
    width: 50px;
    height: 50px;
    place-items: center;
    border-radius: 999px;
    background: var(--violet-50);
    color: var(--violet-600);
  }

  .catalogue-empty h2,
  .catalogue-no-results h2 {
    margin: 14px 0 0;
    font-size: 17px;
  }

  .catalogue-empty p,
  .catalogue-no-results p {
    max-width: 480px;
    margin: 7px 0 17px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }

  @media (max-width: 760px) {
    .catalogue-heading,
    .catalogue-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .catalogue-summary {
      grid-template-columns: 1fr;
    }

    .catalogue-search {
      width: 100%;
    }

    .catalogue-result-count {
      margin-left: 0;
    }

    .catalogue-heading__actions,
    .catalogue-heading__actions .btn {
      width: 100%;
    }

    .catalogue-heading__actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    }
  }
</style>
