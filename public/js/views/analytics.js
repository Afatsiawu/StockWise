import { api } from '../api.js';
import { abcBadge, errorMessage, esc, loading, pageHead, toast, velocityBadge } from '../ui.js';
import {
  coverDays,
  formatDate,
  money,
  moneyCompact,
  number,
  pct,
  setCurrency,
  signedPct,
} from '../format.js';
import { paretoChart } from '../charts.js';

export async function render(container, ctx) {
  container.innerHTML = pageHead({
    title: 'Analytics',
    subtitle: 'Where the money comes from, what moves, and how accurate the forecasts are.',
  }) + loading();

  let data;
  try {
    data = await api.reorder(ctx.windowDays);
    setCurrency(data.settings.currency);
    ctx.settings = data.settings;
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Analytics' }) + `<div class="card">${esc(errorMessage(error))}</div>`;
    toast(errorMessage(error), 'error');
    return;
  }

  const summary = data.summary;
  const rows = summary.rows;
  const products = data.products;
  const abc = summary.abcCounts;
  const deadCount = summary.dead.length;
  const forecasted = products
    .filter((item) => item.forecast.mape !== null && item.unitsSoldInWindow > 0)
    .sort((a, b) => (a.forecast.mape ?? 999) - (b.forecast.mape ?? 999));
  const averageMape =
    forecasted.length === 0
      ? null
      : forecasted.reduce((sum, item) => sum + (item.forecast.mape ?? 0), 0) / forecasted.length;

  const deadValue = rows
    .filter((row) => row.velocityClass === 'dead' && row.onHand > 0)
    .reduce((sum, row) => sum + row.stockValueCents, 0);

  const interpretation = `
    <strong>${number(abc.A)} A-items (${pct(summary.skuShareFor80PctRevenue, 0)} of the range) produce
    ${pct(summary.revenueConcentrationPct, 0)} of revenue.</strong>
    They deserve the shelf space and the tightest stock control. ${number(abc.C)} C-items generate the
    long tail of the range, and ${number(deadCount)} product${deadCount === 1 ? '' : 's'} sold nothing at all in
    the last ${data.windowDays} days, tying up ${moneyCompact(deadValue)} in stock.
    ${
      averageMape === null
        ? ''
        : `Forecasts for products with steady demand are within ${pct(averageMape, 0)} of actual weekly demand on holdout data.`
    }`;

  container.innerHTML = `
    ${pageHead({
      title: 'Analytics',
      subtitle: `Unit sales from the last ${data.windowDays} days (through ${esc(formatDate(data.endDate))}).`,
      actions: `<a class="ghost-button" href="#/reorder">Reorder plan</a>`,
    })}

    <div class="kpis">
      <div class="kpi">
        <div class="label">Revenue in window</div>
        <div class="value">${moneyCompact(summary.totalRevenueCents)}</div>
        <div class="sub">${number(summary.totalUnits)} units sold</div>
      </div>
      <div class="kpi">
        <div class="label">A-items</div>
        <div class="value">${number(abc.A)}</div>
        <div class="sub">${pct(summary.revenueConcentrationPct, 0)} of revenue</div>
      </div>
      <div class="kpi">
        <div class="label">B / C items</div>
        <div class="value">${number(abc.B)} / ${number(abc.C)}</div>
        <div class="sub">Long tail of the range</div>
      </div>
      <div class="kpi">
        <div class="label">Dead stock</div>
        <div class="value">${moneyCompact(deadValue)}</div>
        <div class="sub">${number(deadCount)} products with no sales</div>
      </div>
      <div class="kpi">
        <div class="label">Forecast error (MAPE)</div>
        <div class="value">${averageMape === null ? '—' : pct(averageMape, 0)}</div>
        <div class="sub">Average backtest error, ${number(forecasted.length)} products</div>
      </div>
    </div>

    <div class="callout" style="margin-bottom:16px">${interpretation}</div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <h2>Pareto analysis of revenue</h2>
          <p>Bars: revenue per product. Line: cumulative share of revenue. The A/B/C boundaries follow the 80% rule.</p>
        </div>
      </div>
      ${paretoChart({ rows })}
      <div class="legend">
        <span><i style="background:#818cf8;height:8px;width:8px;border-radius:2px"></i> Revenue per product</span>
        <span><i style="background:#0f172a"></i> Cumulative share</span>
        <span><i style="background:#0d9488"></i> 80% of revenue</span>
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div><h2>Product performance</h2><p>Sorted by revenue contribution. "Revenue per stock unit" shows which products earn their shelf space.</p></div>
      </div>
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th>Product</th><th>ABC</th><th>Movement</th>
              <th class="numeric">Units sold</th><th class="numeric">Units / day</th>
              <th class="numeric">Revenue</th><th class="numeric">Share</th><th class="numeric">Cumulative</th>
              <th class="numeric">On hand</th><th class="numeric">Stock value</th>
              <th class="numeric">Revenue / stock unit</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr>
                <td>
                  <div class="product-cell">
                    <strong><a href="#/products/${row.productId}">${esc(row.name)}</a></strong>
                    <span>${esc(row.sku)} · ${esc(row.category)}</span>
                  </div>
                </td>
                <td>${abcBadge(row.abcClass)}</td>
                <td>${velocityBadge(row.velocityClass)}</td>
                <td class="numeric">${number(row.unitsSold)}</td>
                <td class="numeric">${number(row.unitsPerDay, 2)}</td>
                <td class="numeric">${moneyCompact(row.revenueCents)}</td>
                <td class="numeric">${pct(row.revenueSharePct, 1)}</td>
                <td class="numeric muted">${pct(row.cumulativeRevenuePct, 1)}</td>
                <td class="numeric">${number(row.onHand)}</td>
                <td class="numeric">${moneyCompact(row.stockValueCents)}</td>
                <td class="numeric">${row.revenuePerStockUnit === null ? '—' : number(row.revenuePerStockUnit, 1)}x</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>

    <div class="grid-2-even">
      <section class="card">
        <div class="card-head"><div><h2>Fast movers</h2><p>Highest units per day — protect these from stockouts.</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th class="numeric">Units / day</th><th class="numeric">Sold</th><th class="numeric">Cover</th></tr></thead>
            <tbody>
              ${
                summary.fast
                  .slice(0, 6)
                  .map((row) => {
                    const decision = products.find((item) => item.product.id === row.productId);
                    return `<tr>
                      <td><strong>${esc(row.name)}</strong><div class="tiny muted">${esc(row.sku)}</div></td>
                      <td class="numeric">${number(row.unitsPerDay, 2)}</td>
                      <td class="numeric">${number(row.unitsSold)}</td>
                      <td class="numeric">${decision ? coverDays(decision.position) : '—'}</td>
                    </tr>`;
                  })
                  .join('') || '<tr><td colspan="4" class="table-empty">No fast movers in this window.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Slow movers &amp; dead stock</h2><p>Lowest velocity — candidates for promotion or delisting.</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th>Movement</th><th class="numeric">Sold</th><th class="numeric">Stock value</th></tr></thead>
            <tbody>
              ${
                summary.slow
                  .slice(0, 6)
                  .map(
                    (row) => `<tr>
                      <td><strong>${esc(row.name)}</strong><div class="tiny muted">${esc(row.sku)}</div></td>
                      <td>${velocityBadge(row.velocityClass)}</td>
                      <td class="numeric">${number(row.unitsSold)}</td>
                      <td class="numeric">${moneyCompact(row.stockValueCents)}</td>
                    </tr>`,
                  )
                  .join('') || '<tr><td colspan="4" class="table-empty">No slow movers.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Forecast accuracy &amp; next week</h2>
          <p>Each model is fitted on all data except the last four weeks, then scored on those four weeks (MAPE).</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th><th class="numeric">Forecast next 7 days</th><th class="numeric">Weekly trend</th>
              <th class="numeric">Backtest MAPE</th><th>Confidence</th><th class="numeric">Reorder point</th><th class="numeric">Status</th>
            </tr>
          </thead>
          <tbody>
            ${
              products
                .filter((item) => item.unitsSoldInWindow >= 5)
                .sort((a, b) => (b.forecast.weekly[0] ?? 0) - (a.forecast.weekly[0] ?? 0))
                .map(
                  (item) => `
              <tr>
                <td><strong>${esc(item.product.name)}</strong><div class="tiny muted">${esc(item.product.sku)}</div></td>
                <td class="numeric">${number(item.forecast.weekly[0] ?? 0, 1)} units</td>
                <td class="numeric">${signedPct(item.forecast.trendPctPerWeek, 1)}</td>
                <td class="numeric">${item.forecast.mape === null ? '—' : pct(item.forecast.mape, 0)}</td>
                <td><span class="badge ${esc(item.forecast.confidence)}">${esc(item.forecast.confidence)}</span></td>
                <td class="numeric">${number(item.reorderPointUnits)}</td>
                <td class="numeric">${esc(item.position.urgency)}</td>
              </tr>`,
                )
                .join('') || '<tr><td colspan="7" class="table-empty">No demand to forecast.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}
