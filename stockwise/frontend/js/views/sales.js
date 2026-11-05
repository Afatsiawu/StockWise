import { api } from '../api.js';
import {
  errorMessage,
  esc,
  loading,
  openModal,
  pageHead,
  setBusy,
  toast,
} from '../ui.js';
import { formatDateTime, money, number, setCurrency } from '../format.js';

const PAYMENT_METHODS = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'mobile', label: 'Mobile payment' },
  { value: 'eft', label: 'EFT' },
];

export async function render(container, ctx) {
  container.innerHTML = pageHead({
    title: 'Sales',
    subtitle: 'Record a sale at the counter. Stock and the ledger update in the same transaction.',
  }) + loading();

  let products;
  let sales;
  try {
    const [productList, saleList] = await Promise.all([
      api.products(),
      api.sales({ limit: 60 }),
    ]);
    products = productList.filter((product) => product.isActive);
    sales = saleList;
    if (ctx.settings) setCurrency(ctx.settings.currency);
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Sales' }) + `<div class="card">${esc(errorMessage(error))}</div>`;
    return;
  }

  const productById = new Map(products.map((product) => [product.id, product]));
  let lines = [{ productId: products[0]?.id ?? 0, quantity: 1, unitPriceCents: products[0]?.unitPriceCents ?? 0 }];

  container.innerHTML = `
    ${pageHead({
      title: 'Sales',
      subtitle: 'Every invoice writes its line items and stock movements atomically — the shelf and the books cannot disagree.',
    })}
    <div class="sale-layout">
      <section class="card">
        <div class="card-head"><div><h2>New sale</h2><p>Prices default to the shelf price and can be overridden for a discount.</p></div></div>
        <form id="sale-form">
          <div class="line-items" id="line-items"></div>
          <button type="button" class="ghost-button" id="add-line">+ Add line</button>
          <div class="sale-total"><span>Total</span><span id="sale-total">GH₵ 0.00</span></div>
          <div class="form-grid">
            <div class="field">
              <label for="customerName">Customer (optional)</label>
              <input id="customerName" name="customerName" placeholder="Walk-in" />
            </div>
            <div class="field">
              <label for="paymentMethod">Payment</label>
              <select id="paymentMethod" name="paymentMethod">
                ${PAYMENT_METHODS.map((method) => `<option value="${method.value}">${method.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="notes">Note (optional)</label>
            <input id="notes" name="notes" placeholder="e.g. warranty extension" />
          </div>
          <div class="form-actions">
            <button type="reset" class="ghost-button">Clear</button>
            <button type="submit" class="primary-button">Record sale</button>
          </div>
        </form>
      </section>

      <section class="card">
        <div class="card-head">
          <div><h2>Recent invoices</h2><p>Newest first.</p></div>
          <input type="search" id="sale-search" placeholder="Invoice or customer…" style="max-width:190px" aria-label="Search sales" />
        </div>
        <div class="table-wrap" style="max-height:560px; overflow-y:auto">
          <table id="sales-table">
            <thead><tr><th>Invoice</th><th>When</th><th class="numeric">Units</th><th class="numeric">Total</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
    </div>`;

  const lineItems = container.querySelector('#line-items');
  const totalLabel = container.querySelector('#sale-total');

  const computeTotal = () =>
    lines.reduce((sum, line) => sum + (line.unitPriceCents || 0) * (line.quantity || 0), 0);

  const paintLines = () => {
    lineItems.innerHTML = lines
      .map((line, index) => {
        const product = productById.get(line.productId);
        return `
        <div class="line-item" data-line="${index}">
          <select data-field="productId" aria-label="Product">
            ${products
              .map(
                (option) =>
                  `<option value="${option.id}" ${option.id === line.productId ? 'selected' : ''}>${esc(option.name)} — ${money(option.unitPriceCents)} (${number(option.onHand)} in stock)</option>`,
              )
              .join('')}
          </select>
          <input data-field="quantity" type="number" min="1" step="1" value="${line.quantity}" aria-label="Quantity" />
          <input data-field="price" type="number" min="0" step="0.01" value="${((line.unitPriceCents || 0) / 100).toFixed(2)}" aria-label="Unit price (R)" />
          <button type="button" class="remove" data-remove="${index}" aria-label="Remove line">✕</button>
        </div>`;
      })
      .join('');
    totalLabel.textContent = money(computeTotal());
    if (products.length === 0) {
      lineItems.innerHTML = '<p class="muted small">No active products available.</p>';
    }
  };

  lineItems.addEventListener('change', (event) => {
    const row = event.target.closest('.line-item');
    if (!row) return;
    const index = Number(row.dataset.line);
    const field = event.target.dataset.field;
    const line = lines[index];
    if (!line) return;
    if (field === 'productId') {
      const product = productById.get(Number(event.target.value));
      line.productId = Number(event.target.value);
      if (product) line.unitPriceCents = product.unitPriceCents;
      paintLines();
    } else if (field === 'quantity') {
      line.quantity = Math.max(1, Math.floor(Number(event.target.value) || 1));
      paintLines();
    } else if (field === 'price') {
      line.unitPriceCents = Math.round(Number(event.target.value || 0) * 100);
      totalLabel.textContent = money(computeTotal());
    }
  });

  lineItems.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    if (lines.length === 1) {
      toast('A sale needs at least one line', 'error');
      return;
    }
    lines.splice(Number(button.dataset.remove), 1);
    paintLines();
  });

  container.querySelector('#add-line').addEventListener('click', () => {
    const first = products[0];
    if (!first) return;
    lines.push({ productId: first.id, quantity: 1, unitPriceCents: first.unitPriceCents });
    paintLines();
  });

  const paintSales = (filter = '') => {
    const term = filter.trim().toLowerCase();
    const filtered = sales.filter(
      (sale) =>
        !term ||
        sale.invoiceNo.toLowerCase().includes(term) ||
        (sale.customerName ?? '').toLowerCase().includes(term),
    );
    const tbody = container.querySelector('#sales-table tbody');
    tbody.innerHTML =
      filtered
        .map(
          (sale) => `
        <tr>
          <td class="nowrap"><strong>${esc(sale.invoiceNo)}</strong><div class="tiny muted">${esc(sale.customerName ?? 'Walk-in')}</div></td>
          <td class="small nowrap">${esc(formatDateTime(sale.soldAt))}</td>
          <td class="numeric">${number(sale.unitCount)}</td>
          <td class="numeric">${money(sale.totalCents)}</td>
          <td class="numeric"><button class="link-button" data-sale="${sale.id}" type="button">View</button></td>
        </tr>`,
        )
        .join('') || '<tr><td colspan="5" class="table-empty">No invoices match.</td></tr>';
  };

  paintSales();
  container.querySelector('#sale-search').addEventListener('input', (event) => paintSales(event.target.value));

  container.querySelector('#sales-table').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-sale]');
    if (!button) return;
    try {
      const sale = await api.sale(Number(button.dataset.sale));
      openSaleDetail(sale);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  });

  const form = container.querySelector('#sale-form');
  form.addEventListener('reset', () => {
    setTimeout(() => {
      const first = products[0];
      lines = first ? [{ productId: first.id, quantity: 1, unitPriceCents: first.unitPriceCents }] : [];
      paintLines();
    }, 0);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const payload = {
      items: lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
      })),
      customerName: form.querySelector('#customerName').value || null,
      paymentMethod: form.querySelector('#paymentMethod').value,
      notes: form.querySelector('#notes').value || null,
    };
    setBusy(submit, true, 'Recording…');
    try {
      const sale = await api.recordSale(payload);
      toast(`Sale ${sale.invoiceNo} recorded — ${money(sale.totalCents)}`, 'success');
      ctx.refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
      setBusy(submit, false);
    }
  });

  paintLines();
}

function openSaleDetail(sale) {
  const profit = sale.items.reduce(
    (sum, item) => sum + (item.unitPriceCents - item.unitCostCents) * item.quantity,
    0,
  );
  openModal({
    title: sale.invoiceNo,
    subtitle: `${formatDateTime(sale.soldAt)} · ${sale.paymentMethod} · ${sale.customerName ?? 'Walk-in customer'}`,
    body: `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Item</th><th class="numeric">Qty</th><th class="numeric">Unit price</th><th class="numeric">Line total</th></tr></thead>
          <tbody>
            ${sale.items
              .map(
                (item) => `
              <tr>
                <td><strong>${esc(item.productName)}</strong><div class="tiny muted">${esc(item.sku)}</div></td>
                <td class="numeric">${number(item.quantity)}</td>
                <td class="numeric">${money(item.unitPriceCents)}</td>
                <td class="numeric">${money(item.lineTotalCents)}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="sale-total"><span>Total</span><span>${money(sale.totalCents)}</span></div>
      <p class="small muted">Gross profit on this sale: <strong>${money(profit)}</strong>${sale.notes ? ` · Note: ${esc(sale.notes)}` : ''}</p>`,
    wide: false,
  });
}
