import { api } from '../api.js';
import { pageHead, loading, statusBadge, esc, errorMessage, toast } from '../ui.js';
import {
  coverDays,
  formatDate,
  formatDateTime,
  formatDateShort,
  money,
  moneyCompact,
  number,
  pct,
  percentChangeClass,
  setCurrency,
  signedPct,
} from '../format.js';
import { barChart } from '../charts.js';

function kpi({ label, value, sub = '', subClass = '', extraClass = '' }) {
  return `
    <div class="kpi ${extraClass}">
      <div class="label">${esc(label)}</div>
      <div class="value">${value}</div>
      ${sub ? `<div class="sub ${subClass}">${sub}</div>` : ''}
    </div>`;
}

export async function render(container, ctx) {
  container.innerHTML = pageHead({
    title: 'Dashboard',
    subtitle: 'How the shop is trading, and what needs a decision this week.',
  }) + loading();

  let data;
  try {
    data = await api.dashboard(ctx.windowDays);
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Dashboard' }) +
      `<div class="card"><p>${esc(errorMessage(error))}</p></div>`;
    toast(errorMessage(error), 'error');
    return;
  }

  ctx.settings = data.settings;
  setCurrency(data.settings.currency);
  const through = document.getElementById('data-through');
  if (through) through.textContent = `Trading data to ${formatDate(data.endDate)}`;
  const k = data.kpis;
  const alertCount = data.alertTotals?.total ?? data.alerts.length;
  const watchCount = data.alertTotals?.watch ?? 0;
  const hiddenAlerts = Math.max(0, alertCount - data.alerts.length);

  const alertRows = data.alerts.length
    ? data.alerts
        .map(
          (item) => `
        <a class="alert-row" href="#/products/${item.product.id}">
          <div>
            <div class="title">${esc(item.product.name)}</div>
            <div class="meta">${esc(item.product.sku)} · ${number(item.onHand)} on hand · reorder at ${number(item.reorderPointUnits)} · ${esc(item.position.reason)}</div>
          </div>
          <div class="right">
            ${statusBadge(item.position.urgency)}
            <span class="qty">${item.order.recommendedUnits > 0 ? `order ${number(item.order.recommendedUnits)}` : 'check'}</span>
          </div>
        </a>`,
        )
        .join('')
    : '<div class="callout">No stock alerts. Every product is above its reorder point.</div>';

  const fastRow = (item) => `
    <tr>
      <td>
        <div class="product-cell">
          <strong><a href="#/products/${item.product.id}">${esc(item.product.name)}</a></strong>
          <span>${esc(item.product.sku)}</span>
        </div>
      </td>
      <td class="numeric">${number(item.demandRatePerDay, 1)}</td>
      <td class="numeric">${number(item.unitsSoldInWindow)}</td>
      <td class="numeric nowrap">${statusBadge(item.position.urgency)}</td>
    </tr>`;

  const slowRow = (item) => `
    <tr>
      <td>
        <div class="product-cell">
          <strong><a href="#/products/${item.product.id}">${esc(item.product.name)}</a></strong>
          <span>${esc(item.product.sku)} · ${esc(item.velocityClass)}</span>
        </div>
      </td>
      <td class="numeric">${number(item.unitsSoldInWindow)}</td>
      <td class="numeric nowrap">${moneyCompact(item.stockValueCents)}</td>
      <td class="numeric nowrap">${coverDays(item.position)}</td>
    </tr>`;

  container.innerHTML = `
    ${pageHead({
      title: 'Dashboard',
      subtitle: `Trading data through ${esc(formatDate(data.endDate))} · analysis window ${data.windowDays} days.`,
      actions: `<a class="primary-button" href="#/reorder">View reorder plan</a>`,
    })}
    <section class="kpis" aria-label="Key figures">
      ${kpi({
        label: 'Stock on hand',
        value: moneyCompact(k.stockValueCents),
        sub: `${number(k.stockUnits)} units across ${number(k.activeProducts)} SKUs`,
      })}
      ${kpi({
        label: 'Revenue (30 days)',
        value: moneyCompact(k.revenue30dCents),
        sub: `${signedPct(k.revenue30dChangePct)} vs previous 30 days`,
        subClass: percentChangeClass(k.revenue30dChangePct),
      })}
      ${kpi({
        label: 'Gross margin (30 days)',
        value: `${pct(k.grossMarginPct)}`,
        sub: `${moneyCompact(k.grossProfit30dCents)} gross profit`,
      })}
      ${kpi({
        label: 'Stock alerts',
        value: `${number(alertCount)}`,
        sub: `${number(k.criticalCount)} critical · ${number(k.reorderCount)} reorder · ${number(watchCount)} to watch`,
        extraClass: alertCount > 0 ? 'alert-kpi' : '',
      })}
      ${kpi({
        label: 'Suggested order value',
        value: moneyCompact(k.suggestedOrderValueCents),
        sub: 'Across all suppliers, this week',
      })}
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Revenue, last 12 weeks</h2>
            <p>Weekly takings. Averages ${moneyCompact(k.revenuePerDay90dCents)} per trading day over the window.</p>
          </div>
        </div>
        ${barChart({
          data: data.revenueTrend.map((week) => ({
            label: formatDateShort(week.weekStart),
            value: week.revenueCents,
            tooltip: `Week of ${formatDate(week.weekStart)}: ${money(week.revenueCents)} from ${number(week.units)} units`,
          })),
          height: 240,
          ariaLabel: 'Weekly revenue for the last twelve weeks',
        })}
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <h2>Needs attention <span class="count">${number(alertCount)}</span></h2>
            <p>Ordered by urgency, then days of cover.</p>
          </div>
          <a class="link-button" href="#/reorder">Reorder →</a>
        </div>
        <div class="alert-list">${alertRows}</div>
        ${
          hiddenAlerts > 0
            ? `<p class="small muted" style="margin-top:8px">Showing ${number(data.alerts.length)} of ${number(alertCount)} alerts · <a class="link-button" href="#/reorder">view all</a></p>`
            : ''
        }
      </section>
    </div>

    <div class="grid-3">
      <section class="card">
        <div class="card-head"><div><h2>Fast movers</h2><p>Highest unit velocity in the window.</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th class="numeric">Per day</th><th class="numeric">Sold</th><th class="numeric">Status</th></tr></thead>
            <tbody>
              ${data.fastMovers.map((item) => fastRow(item)).join('') ||
                '<tr><td colspan="4" class="table-empty">No sales in this window.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Slow &amp; dead stock</h2><p>Cash sitting on the shelf.</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th class="numeric">Sold</th><th class="numeric">Value</th><th class="numeric">Cover</th></tr></thead>
            <tbody>
              ${data.slowMovers.map((item) => slowRow(item)).join('') ||
                '<tr><td colspan="4" class="table-empty">No stock on hand.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Revenue by category</h2><p>Last ${data.windowDays} days.</p></div></div>
        ${data.categories
          .map(
            (category) => `
          <div class="bar-row">
            <span title="${esc(category.category)}">${esc(category.category)}</span>
            <div class="track"><div class="fill" style="width:${Math.max(2, category.sharePct)}%"></div></div>
            <span class="val">${pct(category.sharePct, 0)}</span>
          </div>`,
          )
          .join('')}
        <div class="callout" style="margin-top:14px">
          <strong>ABC:</strong> ${number(data.abc.abcCounts.A)} A-items generate
          ${pct(data.abc.revenueConcentrationPct, 0)} of revenue. Dead stock value:
          ${moneyCompact(k.deadStockValueCents)}.
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <div><h2>Recent sales</h2><p>Newest invoices recorded at the counter.</p></div>
        <a class="link-button" href="#/sales">All sales →</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Invoice</th><th>When</th><th>Customer</th><th>Payment</th><th class="numeric">Items</th><th class="numeric">Total</th></tr>
          </thead>
          <tbody>
            ${
              data.recentSales
                .map(
                  (sale) => `
              <tr>
                <td><strong>${esc(sale.invoiceNo)}</strong></td>
                <td class="nowrap">${esc(formatDateTime(sale.soldAt))}</td>
                <td>${sale.customerName ? esc(sale.customerName) : '<span class="muted">Walk-in</span>'}</td>
                <td class="muted">${esc(sale.paymentMethod)}</td>
                <td class="numeric">${number(sale.unitCount)}</td>
                <td class="numeric">${money(sale.totalCents)}</td>
              </tr>`,
                )
                .join('') || '<tr><td colspan="6" class="table-empty">No sales recorded yet.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}
