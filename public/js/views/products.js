import { api } from '../api.js';
import {
  abcBadge,
  closeModal,
  errorMessage,
  esc,
  formValues,
  loading,
  openModal,
  pageHead,
  setBusy,
  statusBadge,
  toast,
  velocityBadge,
} from '../ui.js';
import {
  coverDays,
  formatDate,
  formatDateTime,
  money,
  moneyCompact,
  number,
  pct,
  setCurrency,
  signedPct,
  titleCase,
} from '../format.js';
import { demandChart, stockProjectionChart } from '../charts.js';

const randToCents = (value) => Math.round(Number(value || 0) * 100);

export async function renderList(container, ctx) {
  container.innerHTML = pageHead({
    title: 'Products',
    subtitle: 'The full range with live stock levels and movement classification.',
  }) + loading();

  let products;
  let decisions;
  try {
    const [productList, reorderSet] = await Promise.all([
      api.products({ includeInactive: true }),
      api.reorder(ctx.windowDays),
    ]);
    products = productList;
    decisions = new Map(reorderSet.products.map((item) => [item.product.id, item]));
    ctx.settings = reorderSet.settings;
    setCurrency(reorderSet.settings.currency);
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Products' }) +
      `<div class="card">${esc(errorMessage(error))}</div>`;
    return;
  }

  const categories = [...new Set(products.map((product) => product.category))].sort();
  container.innerHTML = `
    ${pageHead({
      title: 'Products',
      subtitle: `${number(products.length)} products across ${number(categories.length)} categories.`,
      actions: `<button class="primary-button" id="new-product" type="button">+ New product</button>`,
    })}
    <div class="toolbar">
      <input type="search" id="product-search" placeholder="Search name or SKU…" aria-label="Search products" />
      <select id="category-filter" aria-label="Filter by category">
        <option value="">All categories</option>
        ${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}
      </select>
      <span class="muted small" id="result-count">${number(products.length)} shown</span>
    </div>
    <section class="card">
      <div class="table-wrap">
        <table id="product-table">
          <thead>
            <tr>
              <th>Product</th><th>Category</th><th class="numeric">On hand</th><th class="numeric">Cover</th>
              <th class="numeric">Sell price</th><th class="numeric">Margin</th>
              <th>ABC</th><th>Movement</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>`;

  const tbody = container.querySelector('#product-table tbody');
  const searchInput = container.querySelector('#product-search');
  const categoryFilter = container.querySelector('#category-filter');
  const resultCount = container.querySelector('#result-count');

  const paint = () => {
    const term = searchInput.value.trim().toLowerCase();
    const category = categoryFilter.value;
    const filtered = products.filter((product) => {
      const matchesTerm =
        !term ||
        product.name.toLowerCase().includes(term) ||
        product.sku.toLowerCase().includes(term);
      return matchesTerm && (!category || product.category === category);
    });
    resultCount.textContent = `${number(filtered.length)} shown`;
    tbody.innerHTML =
      filtered
        .map((product) => {
          const decision = decisions.get(product.id);
          return `
        <tr>
          <td>
            <div class="product-cell">
              <strong><a href="#/products/${product.id}">${esc(product.name)}</a></strong>
              <span>${esc(product.sku)} · ${esc(product.supplierName ?? 'no supplier')}</span>
            </div>
          </td>
          <td>${esc(product.category)}</td>
          <td class="numeric">${number(product.onHand)}</td>
          <td class="numeric nowrap">${decision ? coverDays(decision.position) : '—'}</td>
          <td class="numeric">${money(product.unitPriceCents)}</td>
          <td class="numeric">${pct(product.marginPct)}</td>
          <td>${decision ? abcBadge(decision.abcClass) : '—'}</td>
          <td>${decision ? velocityBadge(decision.velocityClass) : '—'}</td>
          <td>${decision ? statusBadge(decision.position.urgency) : '—'}</td>
          <td class="numeric"><a class="link-button" href="#/products/${product.id}">Open</a></td>
        </tr>`;
        })
        .join('') ||
      '<tr><td colspan="10" class="table-empty">No products match that filter.</td></tr>';
  };

  paint();
  searchInput.addEventListener('input', paint);
  categoryFilter.addEventListener('change', paint);

  container.querySelector('#new-product').addEventListener('click', async () => {
    const suppliers = await api.suppliers();
    openProductModal({ suppliers, categories, onSaved: () => ctx.refresh() });
  });
}

function openProductModal({ suppliers, categories, onSaved, product }) {
  const editing = Boolean(product);
  openModal({
    title: editing ? `Edit ${product.name}` : 'New product',
    subtitle: editing ? 'Changes apply immediately to sales and analysis.' : 'Add an item to the range.',
    body: `
      <form id="product-form">
        <div class="form-grid">
          <div class="field">
            <label for="sku">SKU</label>
            <input id="sku" name="sku" required maxlength="32" value="${esc(product?.sku ?? '')}" placeholder="e.g. VOLT-GAN-65" />
          </div>
          <div class="field">
            <label for="name">Name</label>
            <input id="name" name="name" required minlength="2" value="${esc(product?.name ?? '')}" />
          </div>
          <div class="field">
            <label for="category">Category</label>
            <input id="category" name="category" required list="category-options" value="${esc(product?.category ?? '')}" />
            <datalist id="category-options">
              ${categories.map((category) => `<option value="${esc(category)}"></option>`).join('')}
            </datalist>
          </div>
          <div class="field">
            <label for="supplierId">Supplier</label>
            <select id="supplierId" name="supplierId">
              <option value="">No supplier</option>
              ${suppliers
                .map(
                  (supplier) =>
                    `<option value="${supplier.id}" ${product?.supplierId === supplier.id ? 'selected' : ''}>${esc(supplier.name)} (${number(supplier.leadTimeDays)} d)</option>`,
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="unitCost">Unit cost (R)</label>
            <input id="unitCost" name="unitCost" type="number" step="0.01" min="0" required
              value="${product ? (product.unitCostCents / 100).toFixed(2) : ''}" />
            <span class="hint">What the supplier charges you.</span>
          </div>
          <div class="field">
            <label for="unitPrice">Selling price (R)</label>
            <input id="unitPrice" name="unitPrice" type="number" step="0.01" min="0" required
              value="${product ? (product.unitPriceCents / 100).toFixed(2) : ''}" />
          </div>
          <div class="field">
            <label for="packSize">Supplier pack size</label>
            <input id="packSize" name="packSize" type="number" min="1" max="100" value="${product?.packSize ?? 1}" />
            <span class="hint">Orders are rounded up to this multiple.</span>
          </div>
          ${
            editing
              ? `<div class="field">
                  <label for="isActive">Availability</label>
                  <select id="isActive" name="isActive">
                    <option value="true" ${product.isActive ? 'selected' : ''}>Active</option>
                    <option value="false" ${!product.isActive ? 'selected' : ''}>Inactive (cannot be sold)</option>
                  </select>
                </div>`
              : ''
          }
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">${editing ? 'Save changes' : 'Create product'}</button>
        </div>
      </form>`,
    onMount(panel, close) {
      panel.querySelector('[data-close]')?.addEventListener('click', close);
      const form = panel.querySelector('#product-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = formValues(form);
        const payload = {
          sku: values.sku,
          name: values.name,
          category: values.category,
          supplierId: values.supplierId ? Number(values.supplierId) : null,
          unitCostCents: randToCents(values.unitCost),
          unitPriceCents: randToCents(values.unitPrice),
          packSize: Number(values.packSize || 1),
        };
        if (editing) payload.isActive = values.isActive === 'true';
        const submit = form.querySelector('button[type="submit"]');
        setBusy(submit, true, 'Saving…');
        try {
          if (editing) await api.updateProduct(product.id, payload);
          else await api.createProduct(payload);
          toast(editing ? 'Product updated' : 'Product created', 'success');
          close();
          if (onSaved) onSaved();
        } catch (error) {
          toast(errorMessage(error), 'error');
          setBusy(submit, false);
        }
      });
    },
  });
}

export async function renderDetail(container, ctx, productId) {
  container.innerHTML = loading();
  let insight;
  try {
    insight = await api.productInsight(productId, ctx.windowDays);
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Product' }) +
      `<div class="card"><p>${esc(errorMessage(error))}</p><a class="link-button" href="#/products">← Back to products</a></div>`;
    return;
  }

  const { product, decision, chart } = insight;
  setCurrency(ctx.settings?.currency ?? 'R');
  const position = decision.position;
  const orderValue = decision.order.recommendedUnits * product.unitCostCents;
  const urgent = ['critical', 'reorder'].includes(position.urgency);

  let callout = '';
  if (urgent && decision.order.recommendedUnits > 0) {
    callout = `<div class="callout ${position.urgency === 'critical' ? 'critical' : ''}">
      <strong>Order ${number(decision.order.recommendedUnits)} units from ${esc(decision.supplierName ?? 'the supplier')} now.</strong>
      That is ${money(orderValue)} at cost and it covers the next ${number(decision.leadTimeDays + decision.reviewPeriodDays)} days of demand.
      ${decision.projectStockoutDate ? `Stock is expected to run out around ${esc(formatDate(decision.projectStockoutDate))}.` : ''}
    </div>`;
  } else if (position.urgency === 'overstocked') {
    callout = `<div class="callout warn"><strong>Do not reorder.</strong> ${esc(position.reason)} Consider a promotion or bundle to release the cash.</div>`;
  } else if (position.urgency === 'watch') {
    callout = `<div class="callout"><strong>Monitor closely.</strong> ${esc(position.reason)} Place the next order within ${number(Math.max(1, Math.floor(position.daysOfCover - decision.leadTimeDays)))} days.</div>`;
  } else {
    callout = `<div class="callout"><strong>No action needed.</strong> ${esc(position.reason)}</div>`;
  }

  const projectionBlock =
    decision.onHand > 0
      ? `
        <div class="card-head" style="margin-top:20px">
          <div>
            <h2>Projected stock if nothing is ordered</h2>
            <p>On hand today, drawn down by forecast demand. The gap between the reorder point and safety stock is the lead time.</p>
          </div>
        </div>
        ${stockProjectionChart({
          onHand: decision.onHand,
          forecast: decision.forecast.daily,
          reorderPoint: decision.reorderPointUnits,
          safety: decision.safetyStockUnits,
          leadTimeDays: decision.leadTimeDays,
        })}
        <div class="legend">
          <span><i style="background:#0d9488"></i> Projected stock</span>
          <span><i class="amber"></i> Reorder point</span>
          <span><i class="red"></i> Safety stock</span>
        </div>
        <p class="small muted" style="margin-top:8px">
          ${decision.projectStockoutDate ? `At this demand rate the shelf runs dry around ${esc(formatDate(decision.projectStockoutDate))}.` : 'Demand is too low to project a stockout in this horizon.'}
        </p>`
      : `<div class="callout critical" style="margin-top:16px">
          <strong>Already out of stock.</strong> There is no stock left to draw down — every day without a delivery is a lost sale.
        </div>`;

  container.innerHTML = `
    <div class="breadcrumb"><a href="#/products">Products</a> / ${esc(product.sku)}</div>
    <div class="detail-head">
      <div>
        <h1>${esc(product.name)}</h1>
        <p class="muted">
          ${esc(product.sku)} · ${esc(product.category)} ·
          ${product.supplierName ? `supplier <strong>${esc(product.supplierName)}</strong> (${number(decision.leadTimeDays)}-day lead time)` : 'no supplier assigned'}
        </p>
        <div class="chip-row" style="margin-top:10px">
          ${statusBadge(position.urgency)}
          ${abcBadge(decision.abcClass)}
          ${velocityBadge(decision.velocityClass)}
          ${product.isActive ? '' : '<span class="badge neutral">Inactive</span>'}
        </div>
      </div>
      <div class="actions">
        <button class="ghost-button" id="adjust-stock" type="button">Adjust stock</button>
        <button class="primary-button" id="receive-stock" type="button">Receive stock</button>
        <button class="ghost-button" id="edit-product" type="button">Edit</button>
      </div>
    </div>

    <div class="detail-stats">
      <div class="detail-stat"><div class="label">On hand</div><div class="value">${number(product.onHand)}</div></div>
      <div class="detail-stat"><div class="label">Days of cover</div><div class="value">${coverDays(position)}</div></div>
      <div class="detail-stat"><div class="label">Reorder point</div><div class="value">${number(decision.reorderPointUnits)}</div></div>
      <div class="detail-stat"><div class="label">Safety stock</div><div class="value">${number(decision.safetyStockUnits)}</div></div>
      <div class="detail-stat"><div class="label">Demand / day</div><div class="value">${number(decision.demandRatePerDay, 2)}</div></div>
      <div class="detail-stat"><div class="label">Suggested order</div><div class="value">${decision.order.recommendedUnits > 0 ? number(decision.order.recommendedUnits) : '—'}</div></div>
    </div>

    ${callout}

    <div class="grid-2 detail-top" style="margin-top:16px">
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Demand history &amp; forecast</h2>
            <p>Daily units for the last 90 days, then the model's next ${decision.forecast.horizonDays} days.</p>
          </div>
          <span class="badge ${esc(decision.forecast.confidence)}">${esc(decision.forecast.confidence)} confidence</span>
        </div>
        ${demandChart({ history: chart.history, forecast: chart.forecast })}
        <div class="legend">
          <span><i></i> Actual units per day</span>
          <span><i class="dashed"></i> Forecast units per day</span>
        </div>

        ${projectionBlock}
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Why this recommendation</h2><p>Every number the system used.</p></div></div>
        <ul class="rationale">
          ${decision.rationale.map((line) => `<li>${esc(line)}</li>`).join('')}
        </ul>
        <div class="table-wrap" style="margin-top:14px">
          <table>
            <tbody>
              <tr><td>Forecast method</td><td class="numeric small">${esc(decision.forecast.method)}</td></tr>
              <tr><td>Backtest error (MAPE)</td><td class="numeric">${decision.forecast.mape === null ? '—' : pct(decision.forecast.mape)}</td></tr>
              <tr><td>Weekly level</td><td class="numeric">${number(decision.forecast.levelPerWeek, 1)} units</td></tr>
              <tr><td>Weekly trend</td><td class="numeric">${number(decision.forecast.trendPerWeek, 1)} units ${decision.forecast.trendPerWeek >= 0 ? '▲' : '▼'}</td></tr>
              <tr><td>Peak weekday</td><td class="numeric">${decision.forecast.peakWeekday === null ? '—' : esc(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][decision.forecast.peakWeekday])}</td></tr>
              <tr><td>Demand during lead time</td><td class="numeric">${number(decision.expectedUnitsDuringLeadTime, 1)} units</td></tr>
              <tr><td>Order-up-to level</td><td class="numeric">${number(decision.orderUpToUnits)} units</td></tr>
              <tr><td>Units sold (${decision.windowDays} d)</td><td class="numeric">${number(decision.unitsSoldInWindow)}</td></tr>
              <tr><td>Last 4 weeks vs previous</td><td class="numeric">${decision.trendChangePct === null ? '—' : signedPct(decision.trendChangePct, 0)}</td></tr>
              <tr><td>Unit cost / price / margin</td><td class="numeric">${money(product.unitCostCents)} / ${money(product.unitPriceCents)} / ${pct(product.marginPct)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="grid-2-even">
      <section class="card">
        <div class="card-head"><div><h2>Stock ledger</h2><p>Every movement, newest first.</p></div></div>
        <div class="table-wrap scroll-y">
          <table>
            <thead><tr><th>When</th><th>Type</th><th class="numeric">Change</th><th>Reference</th><th>Note</th></tr></thead>
            <tbody>
              ${
                insight.movements
                  .map(
                    (movement) => `
                <tr>
                  <td class="nowrap small">${esc(formatDateTime(movement.occurredAt))}</td>
                  <td><span class="badge ${movement.kind === 'sale' ? 'neutral' : 'healthy'}">${esc(titleCase(movement.kind))}</span></td>
                  <td class="numeric ${movement.quantityDelta < 0 ? 'muted' : ''}">${movement.quantityDelta > 0 ? '+' : ''}${number(movement.quantityDelta)}</td>
                  <td class="small nowrap">${esc(movement.reference ?? '—')}</td>
                  <td class="small muted">${esc(movement.note ?? '')}</td>
                </tr>`,
                  )
                  .join('') || '<tr><td colspan="5" class="table-empty">No movements yet.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Recent sales of this item</h2><p>Last 8 invoices that included it.</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>When</th><th class="numeric">Qty</th><th class="numeric">Value</th></tr></thead>
            <tbody>
              ${
                insight.recentSales
                  .map(
                    (sale) => `
                <tr>
                  <td class="nowrap">${esc(sale.invoiceNo)}</td>
                  <td class="small nowrap">${esc(formatDateTime(sale.soldAt))}</td>
                  <td class="numeric">${number(sale.unitCount)}</td>
                  <td class="numeric">${money(sale.totalCents)}</td>
                </tr>`,
                  )
                  .join('') || '<tr><td colspan="4" class="table-empty">Not sold yet.</td></tr>'
              }
            </tbody>
          </table>
        </div>
        <div class="callout" style="margin-top:14px">
          Last 30 days: <strong>${number(insight.salesLast30Days.units)} units</strong>,
          <strong>${moneyCompact(insight.salesLast30Days.revenueCents)}</strong> revenue.
          Stock value on hand: <strong>${moneyCompact(decision.stockValueCents)}</strong>.
        </div>
      </section>
    </div>
  `;

  container.querySelector('#receive-stock').addEventListener('click', () => {
    openStockModal({
      product,
      mode: 'purchase',
      onSaved: () => ctx.refresh(),
    });
  });
  container.querySelector('#adjust-stock').addEventListener('click', () => {
    openStockModal({
      product,
      mode: 'adjustment',
      onSaved: () => ctx.refresh(),
    });
  });
  container.querySelector('#edit-product').addEventListener('click', async () => {
    const suppliers = await api.suppliers();
    openProductModal({
      suppliers,
      categories: insight.categories,
      product,
      onSaved: () => ctx.refresh(),
    });
  });
}

function openStockModal({ product, mode, onSaved }) {
  const isPurchase = mode === 'purchase';
  openModal({
    title: isPurchase ? 'Receive stock' : 'Adjust stock',
    subtitle: isPurchase
      ? `Record a supplier delivery for ${product.name}. On hand: ${number(product.onHand)}.`
      : `Correct the stock count for ${product.name}. On hand: ${number(product.onHand)}.`,
    body: `
      <form id="stock-form">
        <div class="form-grid">
          <div class="field">
            <label for="quantity">${isPurchase ? 'Units received' : 'Adjustment (+ / −)'}</label>
            <input id="quantity" name="quantity" type="number" step="1" ${isPurchase ? 'min="1"' : ''} required
              placeholder="${isPurchase ? '12' : '-2'}" />
            ${isPurchase ? '' : '<span class="hint">Use a negative number for shrinkage, damage or a stock-count correction.</span>'}
          </div>
          ${
            isPurchase
              ? `<div class="field">
                  <label for="unitCost">Unit cost (R)</label>
                  <input id="unitCost" name="unitCost" type="number" step="0.01" min="0" value="${(product.unitCostCents / 100).toFixed(2)}" />
                  <span class="hint">Updates the weighted average cost.</span>
                </div>
                <div class="field">
                  <label for="reference">Reference</label>
                  <input id="reference" name="reference" placeholder="PO or delivery note" />
                </div>`
              : ''
          }
          <div class="field">
            <label for="note">Note</label>
            <input id="note" name="note" placeholder="${isPurchase ? 'Delivery received' : 'Reason for adjustment'}" />
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">${isPurchase ? 'Add to stock' : 'Apply adjustment'}</button>
        </div>
      </form>`,
    onMount(panel, close) {
      panel.querySelector('[data-close]')?.addEventListener('click', close);
      const form = panel.querySelector('#stock-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = formValues(form);
        const quantity = Number(values.quantity);
        if (!Number.isInteger(quantity) || quantity === 0) {
          toast('Enter a whole number other than zero', 'error');
          return;
        }
        const payload = {
          kind: mode,
          quantity,
          note: values.note || null,
        };
        if (isPurchase) {
          payload.unitCostCents = randToCents(values.unitCost);
          payload.reference = values.reference || null;
        }
        const submit = form.querySelector('button[type="submit"]');
        setBusy(submit, true, 'Saving…');
        try {
          await api.stockMovement(product.id, payload);
          toast(isPurchase ? 'Stock received' : 'Stock adjusted', 'success');
          close();
          if (onSaved) onSaved();
        } catch (error) {
          toast(errorMessage(error), 'error');
          setBusy(submit, false);
        }
      });
    },
  });
}
