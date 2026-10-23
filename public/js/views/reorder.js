import { api } from '../api.js';
import {
  downloadCsv,
  errorMessage,
  esc,
  formValues,
  loading,
  openModal,
  pageHead,
  setBusy,
  statusBadge,
  toast,
} from '../ui.js';
import { coverDays, formatDate, money, moneyCompact, number, setCurrency } from '../format.js';

const SERVICE_LEVELS = [
  { z: 1.28, label: '90% — lean stock, more stockouts' },
  { z: 1.65, label: '95% — balanced (default)' },
  { z: 1.88, label: '97% — safer' },
  { z: 2.05, label: '98% — high service' },
  { z: 2.33, label: '99% — very high service, more capital tied up' },
];

export async function render(container, ctx) {
  container.innerHTML = pageHead({
    title: 'Reorder',
    subtitle: 'What to order, from whom, and how much — calculated from demand, variability and lead time.',
  }) + loading();

  let data;
  try {
    data = await api.reorder(ctx.windowDays);
    setCurrency(data.settings.currency);
    ctx.settings = data.settings;
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Reorder' }) + `<div class="card">${esc(errorMessage(error))}</div>`;
    return;
  }

  const { totals, products, purchasePlan, settings } = data;
  const actionable = products.filter((item) =>
    ['critical', 'reorder', 'watch'].includes(item.position.urgency),
  );

  const planCards = purchasePlan.length
    ? purchasePlan
        .map(
          (group) => `
      <section class="card">
        <div class="card-head">
          <div>
            <h2>${esc(group.supplierName)}</h2>
            <p>${number(group.leadTimeDays)}-day lead time · ${group.items.length} line${group.items.length === 1 ? '' : 's'} · ${money(group.totalCostCents)}</p>
          </div>
          <button class="ghost-button" type="button" data-copy="${group.supplierId}">Copy order</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th class="numeric">Order</th><th class="numeric">Unit cost</th><th class="numeric">Line cost</th><th></th></tr></thead>
            <tbody>
              ${group.items
                .map(
                  (item) => `
                <tr>
                  <td><a href="#/products/${item.productId}">${esc(item.name)}</a><div class="tiny muted">${esc(item.sku)}</div></td>
                  <td class="numeric"><strong>${number(item.quantity)}</strong></td>
                  <td class="numeric">${money(item.unitCostCents)}</td>
                  <td class="numeric">${money(item.lineCostCents)}</td>
                  <td class="numeric">${statusBadge(item.urgency)}</td>
                </tr>`,
                )
                .join('')}
              <tr>
                <td colspan="3"><strong>Subtotal</strong></td>
                <td class="numeric"><strong>${money(group.totalCostCents)}</strong></td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>`,
        )
        .join('')
    : '<div class="callout">Nothing needs ordering right now. Every product covers demand through its lead time plus the review period.</div>';

  const planText = (group) =>
    [
      `Purchase order — ${group.supplierName}`,
      `Lead time: ${group.leadTimeDays} days`,
      '',
      ...group.items.map((item) => `${item.quantity} x ${item.sku} (${item.name}) @ ${money(item.unitCostCents)}`),
      '',
      `Estimated total: ${money(group.totalCostCents)}`,
    ].join('\n');

  container.innerHTML = `
    ${pageHead({
      title: 'Reorder plan',
      subtitle: `Policy: ${number(settings.reviewPeriodDays)}-day review, service level z=${settings.serviceLevelZ}, ${money(settings.orderCostCents)} cost per order, ${settings.holdingRatePct}% holding cost.`,
      actions: `
        <button class="ghost-button" id="policy-settings" type="button">⚙ Policy settings</button>
        <button class="ghost-button" id="export-csv" type="button">⭳ Export CSV</button>
      `,
    })}

    <div class="chip-row">
      <span class="chip critical">Critical <strong>${number(totals.criticalCount)}</strong></span>
      <span class="chip">Reorder now <strong>${number(totals.reorderCount)}</strong></span>
      <span class="chip">Watch <strong>${number(products.filter((p) => p.position.urgency === 'watch').length)}</strong></span>
      <span class="chip">Overstocked <strong>${number(totals.overstockedCount)}</strong></span>
      <span class="chip">Suggested spend <strong>${moneyCompact(totals.suggestedOrderValueCents)}</strong></span>
    </div>

    <div class="page-head" style="margin-bottom:12px">
      <div><h2 style="font-size:1.1rem">Purchase plan by supplier</h2>
      <p class="muted small">Quantities already account for stock on hand, demand during the lead time and pack sizes.</p></div>
    </div>
    <div class="grid-2-even">${planCards}</div>

    <section class="card" style="margin:16px 0">
      <div class="card-head">
        <div>
          <h2>All products: decision inputs and outputs</h2>
          <p>${number(actionable.length)} of ${number(products.length)} products need action or watching.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th>Product</th><th>Status</th>
              <th class="numeric">On hand</th><th class="numeric">Demand / day</th>
              <th class="numeric">Safety</th><th class="numeric">Reorder at</th><th class="numeric">Cover</th>
              <th class="numeric">Order now</th><th class="numeric">Order value</th><th>Why</th>
            </tr>
          </thead>
          <tbody>
            ${products
              .map(
                (item) => `
              <tr>
                <td>
                  <div class="product-cell">
                    <strong><a href="#/products/${item.product.id}">${esc(item.product.name)}</a></strong>
                    <span>${esc(item.product.sku)} · ${esc(item.supplierName ?? 'no supplier')} · ${number(item.leadTimeDays)} d lead</span>
                  </div>
                </td>
                <td>${statusBadge(item.position.urgency)}</td>
                <td class="numeric">${number(item.onHand)}</td>
                <td class="numeric">${number(item.demandRatePerDay, 2)}</td>
                <td class="numeric">${number(item.safetyStockUnits)}</td>
                <td class="numeric">${number(item.reorderPointUnits)}</td>
                <td class="numeric nowrap">${coverDays(item.position)}</td>
                <td class="numeric">${item.order.recommendedUnits > 0 ? `<strong>${number(item.order.recommendedUnits)}</strong>` : '—'}</td>
                <td class="numeric">${item.order.recommendedUnits > 0 ? money(item.order.recommendedUnits * item.product.unitCostCents) : '—'}</td>
                <td class="small muted" style="max-width:260px">${esc(item.position.reason)}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div><h2>How the numbers are calculated</h2><p>Transparent policy — no black box.</p></div>
      </div>
      <div class="grid-2-even">
        <div>
          <ul class="rationale">
            <li><strong>Safety stock</strong> = z × σ<sub>daily</sub> × √lead time, with z = ${settings.serviceLevelZ} for the ${settings.serviceLevelZ >= 2.33 ? '99' : settings.serviceLevelZ >= 2.05 ? '98' : settings.serviceLevelZ >= 1.88 ? '97' : settings.serviceLevelZ >= 1.65 ? '95' : '90'}% service level.</li>
            <li><strong>Reorder point</strong> = forecast demand per day × lead time + safety stock.</li>
            <li><strong>Order-up-to level</strong> = demand per day × (lead time + ${settings.reviewPeriodDays}-day review period) + safety stock.</li>
            <li><strong>Order quantity</strong> = the larger of the deficit to that level, and the economic order quantity √(2 × annual demand × ${money(settings.orderCostCents)} ÷ holding cost), rounded up to the pack size.</li>
            <li><strong>Holding cost</strong> = ${settings.holdingRatePct}% of unit cost per year (capital, storage, obsolescence).</li>
          </ul>
        </div>
        <div>
          <div class="callout">
            <strong>Forecast:</strong> weekly demand is smoothed (exponential smoothing with the α that
            minimises error), extended with a damped linear trend, then split across weekdays using
            day-of-week factors learned from ${formatDate(data.endDate)} backwards.
            Accuracy is reported as MAPE on the last four weeks, which were held out of the fit.
          </div>
          <div class="callout" style="margin-top:10px">
            <strong>Assumptions:</strong> demand is independent day to day, supplier lead times are
            reliable except where noted, and there are no minimum order quantities beyond the pack size.
            The system is decision <em>support</em> — the owner still approves every order.
          </div>
        </div>
      </div>
    </section>
  `;

  container.querySelector('#policy-settings').addEventListener('click', () => openPolicyModal(settings, ctx));
  container.querySelector('#export-csv').addEventListener('click', () => {
    const rows = [
      ['SKU', 'Product', 'Supplier', 'Status', 'On hand', 'Demand per day', 'Safety stock', 'Reorder point', 'Days cover', 'Order quantity', 'Order value (cents)'],
      ...products.map((item) => [
        item.product.sku,
        item.product.name,
        item.supplierName ?? '',
        item.position.urgency,
        item.onHand,
        item.demandRatePerDay,
        item.safetyStockUnits,
        item.reorderPointUnits,
        Number.isFinite(item.position.daysOfCover) ? item.position.daysOfCover.toFixed(1) : 'no demand',
        item.order.recommendedUnits,
        item.order.recommendedUnits * item.product.unitCostCents,
      ]),
    ];
    downloadCsv(`reorder-plan-${data.endDate}.csv`, rows);
    toast('Reorder plan exported', 'success');
  });

  container.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const group = purchasePlan.find((entry) => String(entry.supplierId) === button.dataset.copy);
      if (!group) return;
      try {
        await navigator.clipboard.writeText(planText(group));
        toast(`Order for ${group.supplierName} copied to clipboard`, 'success');
      } catch {
        toast('Clipboard is not available in this browser', 'error');
      }
    });
  });
}

function openPolicyModal(settings, ctx) {
  openModal({
    title: 'Inventory policy settings',
    subtitle: 'Changing these values immediately recalculates every reorder recommendation.',
    body: `
      <form id="policy-form">
        <div class="form-grid">
          <div class="field">
            <label for="serviceLevelZ">Service level</label>
            <select id="serviceLevelZ" name="serviceLevelZ">
              ${SERVICE_LEVELS.map(
                (level) =>
                  `<option value="${level.z}" ${Math.abs(settings.serviceLevelZ - level.z) < 0.01 ? 'selected' : ''}>${level.label}</option>`,
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label for="reviewPeriodDays">Review period (days)</label>
            <input id="reviewPeriodDays" name="reviewPeriodDays" type="number" min="1" max="60" value="${settings.reviewPeriodDays}" />
            <span class="hint">How often you place orders.</span>
          </div>
          <div class="field">
            <label for="orderCost">Cost per order (${settings.currency})</label>
            <input id="orderCost" name="orderCost" type="number" min="0" step="0.01" value="${(settings.orderCostCents / 100).toFixed(2)}" />
            <span class="hint">Admin, transport, handling.</span>
          </div>
          <div class="field">
            <label for="holdingRatePct">Holding cost (% of unit cost / year)</label>
            <input id="holdingRatePct" name="holdingRatePct" type="number" min="0" max="100" step="0.5" value="${settings.holdingRatePct}" />
          </div>
          <div class="field">
            <label for="defaultLeadTimeDays">Default lead time (days)</label>
            <input id="defaultLeadTimeDays" name="defaultLeadTimeDays" type="number" min="0" max="180" value="${settings.defaultLeadTimeDays}" />
            <span class="hint">Used only when a product has no supplier.</span>
          </div>
          <div class="field">
            <label for="currency">Currency symbol</label>
            <input id="currency" name="currency" maxlength="4" value="${esc(settings.currency)}" />
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">Recalculate</button>
        </div>
      </form>`,
    onMount(panel, close) {
      panel.querySelector('[data-close]')?.addEventListener('click', close);
      const form = panel.querySelector('#policy-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = formValues(form);
        const payload = {
          serviceLevelZ: Number(values.serviceLevelZ),
          reviewPeriodDays: Number(values.reviewPeriodDays),
          orderCostCents: Math.round(Number(values.orderCost) * 100),
          holdingRatePct: Number(values.holdingRatePct),
          defaultLeadTimeDays: Number(values.defaultLeadTimeDays),
          currency: values.currency,
        };
        const submit = form.querySelector('button[type="submit"]');
        setBusy(submit, true, 'Recalculating…');
        try {
          await api.updateSettings(payload);
          toast('Policy updated — recommendations recalculated', 'success');
          close();
          ctx.refresh();
        } catch (error) {
          toast(errorMessage(error), 'error');
          setBusy(submit, false);
        }
      });
    },
  });
}
