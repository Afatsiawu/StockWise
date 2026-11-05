/**
 * Dependency-free SVG charts.
 *
 * Hand-rolled because the whole project intentionally has no runtime dependencies and
 * because the three charts needed (demand history + forecast, weekly revenue, Pareto)
 * are simple. viewBox keeps them responsive without a resize listener.
 */

import { esc } from './ui.js';
import { formatDateShort, moneyCompact, number } from './format.js';

/**
 * Round an axis maximum up to a readable value using roughly four intervals,
 * so bars fill the plot instead of the axis towering over the data.
 */
function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
  return Math.ceil(value / step) * step;
}

function gradientId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Demand history with the forecast continuing from the last actual point.
 * Also draws the reorder point and safety stock as reference lines, which is how the
 * owner sees *why* the system says "order now".
 */
export function demandChart({ history, forecast, height = 260 }) {
  const width = 940;
  const pad = { top: 16, right: 20, bottom: 30, left: 48 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const points = [...history, ...forecast];
  if (points.length < 2) {
    return '<p class="muted small">Not enough history to draw a chart.</p>';
  }

  const maxValue = Math.max(...points.map((point) => point.units), 1);
  const yMax = niceMax(maxValue * 1.15);
  const total = points.length;
  const x = (index) => pad.left + (index / (total - 1)) * innerWidth;
  const y = (value) => pad.top + innerHeight - (value / yMax) * innerHeight;
  const fillId = gradientId('history');

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const value = yMax * fraction;
      const yPos = y(value);
      return `<line class="grid-line" x1="${pad.left}" y1="${yPos}" x2="${width - pad.right}" y2="${yPos}" />
        <text x="${pad.left - 8}" y="${yPos + 3}" text-anchor="end">${number(value, value < 10 ? 1 : 0)}</text>`;
    })
    .join('');

  const historyPath = history
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.units).toFixed(1)}`)
    .join(' ');
  const areaPath = `${historyPath} L${x(history.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  const boundary = history.length - 1;
  const forecastPath = [
    `M${x(boundary).toFixed(1)},${y(history.at(-1)?.units ?? 0).toFixed(1)}`,
    ...forecast.map(
      (point, index) =>
        `L${x(boundary + 1 + index).toFixed(1)},${y(point.units).toFixed(1)}`,
    ),
  ].join(' ');

  const labelIndices = [...new Set([0, Math.max(0, boundary), total - 1])];
  const xLabels = labelIndices
    .map(
      (index) =>
        `<text x="${x(index)}" y="${height - 10}" text-anchor="${index === 0 ? 'start' : index === total - 1 ? 'end' : 'middle'}">${esc(formatDateShort(points[index]?.date))}</text>`,
    )
    .join('');

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily units sold with demand forecast">
      <title>Daily demand history and forecast</title>
      <defs>
        <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6366f1" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridLines}
      <line class="axis-line" x1="${pad.left}" y1="${y(0)}" x2="${width - pad.right}" y2="${y(0)}" />
      <path class="history-area" d="${areaPath}" fill="url(#${fillId})" />
      <path class="history-line" d="${historyPath}" />
      <line x1="${x(boundary)}" y1="${pad.top}" x2="${x(boundary)}" y2="${y(0)}" stroke="#cbd5e1" stroke-dasharray="3 3" />
      <text x="${x(boundary) + 4}" y="${pad.top + 10}" fill="#94a3b8">forecast →</text>
      <path class="forecast-line" d="${forecastPath}" />
      ${xLabels}
    </svg>`;
}

/** Simple vertical bars with native tooltips. */
export function barChart({ data, height = 220, valueFormat = moneyCompact, ariaLabel = 'Bar chart' }) {
  const width = 940;
  const pad = { top: 14, right: 12, bottom: 30, left: 54 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  if (!data.length) return '<p class="muted small">No data for this period.</p>';

  const max = niceMax(Math.max(...data.map((entry) => entry.value), 1) * 1.1);
  const slot = innerWidth / data.length;
  const barWidth = Math.max(3, slot * 0.62);
  const y = (value) => pad.top + innerHeight - (value / max) * innerHeight;
  const labelEvery = Math.ceil(data.length / 8);

  const gridLines = [0, 0.5, 1]
    .map((fraction) => {
      const value = max * fraction;
      const yPos = y(value);
      return `<line class="grid-line" x1="${pad.left}" y1="${yPos}" x2="${width - pad.right}" y2="${yPos}" />
        <text x="${pad.left - 8}" y="${yPos + 3}" text-anchor="end">${esc(valueFormat(value))}</text>`;
    })
    .join('');

  const bars = data
    .map((entry, index) => {
      const barHeight = Math.max(1, y(0) - y(entry.value));
      const xPos = pad.left + index * slot + (slot - barWidth) / 2;
      const label =
        index % labelEvery === 0
          ? `<text x="${xPos + barWidth / 2}" y="${height - 10}" text-anchor="middle">${esc(entry.label)}</text>`
          : '';
      return `<rect class="bar" x="${xPos.toFixed(1)}" y="${y(entry.value).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3">
          <title>${esc(entry.tooltip ?? `${entry.label}: ${valueFormat(entry.value)}`)}</title>
        </rect>${label}`;
    })
    .join('');

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel)}">
      <title>${esc(ariaLabel)}</title>
      ${gridLines}
      <line class="axis-line" x1="${pad.left}" y1="${y(0)}" x2="${width - pad.right}" y2="${y(0)}" />
      ${bars}
    </svg>`;
}

/**
 * Pareto chart: revenue bars (left axis) with the cumulative share line (right axis).
 * The 80% line is the classic ABC cut-off, so the chart literally shows where "A" ends.
 */
export function paretoChart({ rows, height = 280 }) {
  const width = 940;
  const pad = { top: 18, right: 46, bottom: 54, left: 58 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  if (!rows.length) return '<p class="muted small">No sales in this window.</p>';

  const totalRevenue = rows.reduce((sum, row) => sum + Math.max(0, row.revenueCents), 0);
  const maxRevenue = niceMax(Math.max(...rows.map((row) => row.revenueCents), 1) * 1.1);
  const slot = innerWidth / rows.length;
  const barWidth = Math.max(2, slot * 0.66);

  const yRevenue = (value) => pad.top + innerHeight - (value / maxRevenue) * innerHeight;
  const yShare = (pctValue) => pad.top + innerHeight - (pctValue / 100) * innerHeight;

  let cumulative = 0;
  const cumulativePoints = rows.map((row, index) => {
    cumulative += Math.max(0, row.revenueCents);
    const share = totalRevenue === 0 ? 0 : (cumulative / totalRevenue) * 100;
    return { x: pad.left + index * slot + slot / 2, y: yShare(share), share, row };
  });

  const bars = rows
    .map((row, index) => {
      const barHeight = Math.max(1, yRevenue(0) - yRevenue(row.revenueCents));
      const xPos = pad.left + index * slot + (slot - barWidth) / 2;
      return `<rect class="bar" x="${xPos.toFixed(1)}" y="${yRevenue(row.revenueCents).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2">
          <title>${esc(`${row.sku} · ${moneyCompact(row.revenueCents)} · cumulative ${cumulativePoints[index]?.share.toFixed(1)}%`)}</title>
        </rect>
        ${
          index % 3 === 0
            ? `<text x="${xPos + barWidth / 2}" y="${height - 34}" text-anchor="middle">${esc(row.sku.length > 11 ? `${row.sku.slice(0, 10)}…` : row.sku)}</text>`
            : ''
        }`;
    })
    .join('');

  const linePath = cumulativePoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');

  const gridLines = [0, 25, 50, 75, 100]
    .map((share) => {
      const yPos = yShare(share);
      return `<line class="grid-line" x1="${pad.left}" y1="${yPos}" x2="${width - pad.right}" y2="${yPos}" />
        <text x="${width - pad.right + 6}" y="${yPos + 3}">${share}%</text>
        <text x="${pad.left - 8}" y="${yPos + 3}" text-anchor="end">${esc(moneyCompact((maxRevenue * share) / 100))}</text>`;
    })
    .join('');

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Revenue by product and cumulative share">
      <title>Pareto analysis of revenue by product</title>
      ${gridLines}
      <line class="ref-line" x1="${pad.left}" y1="${yShare(80)}" x2="${width - pad.right}" y2="${yShare(80)}" stroke="#0d9488" />
      <text x="${pad.left + 4}" y="${yShare(80) - 5}" fill="#0d9488">80% of revenue</text>
      ${bars}
      <path class="cum-line" d="${linePath}" />
      <line class="axis-line" x1="${pad.left}" y1="${yRevenue(0)}" x2="${width - pad.right}" y2="${yRevenue(0)}" />
    </svg>`;
}

/**
 * Projected stock for the next few weeks if nothing is ordered.
 * This is the picture that makes the reorder point concrete: the line falls, and it
 * crosses the reorder point before it crosses safety stock - that gap is the lead time.
 */
export function stockProjectionChart({
  onHand,
  forecast,
  reorderPoint = 0,
  safety = 0,
  leadTimeDays = 0,
  height = 190,
}) {
  const width = 940;
  const pad = { top: 18, right: 22, bottom: 30, left: 48 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const days = Math.max(1, Math.min(45, forecast.length));
  if (days < 2) return '';

  const points = [{ day: 0, units: Math.max(0, onHand) }];
  let stock = Math.max(0, onHand);
  for (let index = 0; index < days; index += 1) {
    stock = Math.max(0, stock - (forecast[index] ?? 0));
    points.push({ day: index + 1, units: stock });
  }

  const max = niceMax(Math.max(onHand, reorderPoint, safety, 1) * 1.1);
  const x = (day) => pad.left + (day / days) * innerWidth;
  const y = (units) => pad.top + innerHeight - (units / max) * innerHeight;
  const fillId = gradientId('stock');

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.day).toFixed(1)},${y(point.units).toFixed(1)}`)
    .join(' ');
  const area = `${path} L${x(days).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  const gridLines = [0, 0.5, 1]
    .map((fraction) => {
      const value = max * fraction;
      const yPos = y(value);
      return `<line class="grid-line" x1="${pad.left}" y1="${yPos}" x2="${width - pad.right}" y2="${yPos}" />
        <text x="${pad.left - 8}" y="${yPos + 3}" text-anchor="end">${number(value)}</text>`;
    })
    .join('');

  const referenceLine = (value, colour, label) => {
    if (!value || value <= 0) return '';
    const yPos = y(value);
    if (yPos < pad.top) return '';
    return `<line class="ref-line" x1="${pad.left}" y1="${yPos}" x2="${width - pad.right}" y2="${yPos}" stroke="${colour}" />
      <text x="${width - pad.right - 2}" y="${yPos - 4}" text-anchor="end" fill="${colour}">${esc(label)} ${number(value)}</text>`;
  };

  const leadX = x(Math.min(days, Math.max(1, leadTimeDays)));
  const leadLine =
    leadTimeDays > 0 && leadTimeDays <= days
      ? `<line x1="${leadX}" y1="${pad.top}" x2="${leadX}" y2="${y(0)}" stroke="#94a3b8" stroke-dasharray="3 3" />
         <text x="${leadX + 4}" y="${pad.top + 10}" fill="#94a3b8">order arrives</text>`
      : '';

  const labels = [0, Math.round(days / 3), Math.round((days * 2) / 3), days]
    .filter((value, index, all) => all.indexOf(value) === index)
    .map(
      (day) =>
        `<text x="${x(day)}" y="${height - 10}" text-anchor="${day === 0 ? 'start' : day === days ? 'end' : 'middle'}">${day === 0 ? 'today' : `+${day}d`}</text>`,
    )
    .join('');

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected stock level over the next ${days} days">
      <title>Projected stock if no order is placed</title>
      <defs>
        <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0d9488" stop-opacity="0.16" />
          <stop offset="100%" stop-color="#0d9488" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridLines}
      ${referenceLine(reorderPoint, '#f59e0b', 'Reorder point')}
      ${referenceLine(safety, '#ef4444', 'Safety stock')}
      ${leadLine}
      <path d="${area}" fill="url(#${fillId})" />
      <path class="projection-line" d="${path}" />
      ${labels}
      <line class="axis-line" x1="${pad.left}" y1="${y(0)}" x2="${width - pad.right}" y2="${y(0)}" />
    </svg>`;
}
