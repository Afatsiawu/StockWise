# 2. Programming Challenge — Language and Paradigm Justification

> **The challenge.** One system must do two very different jobs at once: record money and stock
> **transactionally**, and *reason* about demand **analytically**. A language or paradigm that is
> good at one is often mediocre at the other. This chapter explains the choice of TypeScript on
> Node.js with SQLite, and why the architecture is deliberately a hybrid of two paradigms rather
> than a purist application of one.

---

## 2.1 The two jobs are not the same job

| | Transactional side (OLTP) | Decision-support side (analytics) |
| --- | --- | --- |
| Unit of work | One sale, one delivery, one adjustment | A whole product range over 90–540 days |
| Correctness means | Nothing is lost, nothing half-written, stock never negative | The model is defensible, reproducible and explained |
| Typical operation | Insert header + lines + movements atomically | Aggregate, smooth, regress, classify, forecast |
| Failure cost | Corrupt books, wrong shelf count, angry customer | A bad order, tied-up cash, a stockout |
| Latency | Milliseconds at the counter | Can take hundreds of milliseconds on demand |
| Changes | Often, by non-developers through the UI | Rarely, by the developer, with tests |
| Testing | Integration tests against a real database | Unit tests on pure functions with known answers |

A single-language, single-paradigm system has to serve both. That is the programming challenge.

## 2.2 Selection criteria

Derived from the investigation (see [01](01-real-world-investigation.md)):

1. **Transactional safety is non-negotiable.** The whole point is that the books and the shelf
   agree. The language must make it hard to write a half-finished transaction, and the database
   must enforce it.
2. **Numeric honesty.** Money cannot be a `double`; stock counts cannot be fractional by accident.
3. **Analytics must be expressible.** Grouping, windowing and date arithmetic should be natural,
   not a fight against the language.
4. **The model must be explainable and testable.** The owner must be able to see the formula and
   the developer must be able to pin it down with tests.
5. **Deployable on a shop laptop.** One command to install, one to run, no server room, no cloud
   account, no Docker.
6. **One language for API and UI**, because the same student maintains both.

## 2.3 The choice

**TypeScript (strict) on Node.js 24, with SQLite via the built-in `node:sqlite` module, and a
dependency-free browser front end.**

```jsonc
// package.json — there are no runtime dependencies at all
"devDependencies": { "@types/node": "^24.7.0", "typescript": "^5.9.3" }
```

Why each piece:

### TypeScript

- **The type system can carry domain meaning.** `Cents` is not just `number` in the signatures:
  every money value is an integer number of cents, and conversion happens only at the edge
  (`fromMajorUnits`, `formatMoney`). Quantities are validated as integers before they reach SQL.
- **Exhaustive states beat booleans.** Urgency is a closed union, which makes the UI and the
  decision logic handle every case or fail to compile:

  ```ts
  export type Urgency = 'critical' | 'reorder' | 'watch' | 'healthy' | 'overstocked';
  ```

  The same pattern is used for `AbcClass`, `VelocityClass`, `MovementKind`, `ForecastConfidence`
  and the four payment methods — the database `CHECK` constraints mirror the unions exactly.
- **`strict` + `noUncheckedIndexedAccess`** means an array index is `T | undefined`. That is
  annoying for about ten minutes and then it catches the real bug: an empty history producing
  `NaN` in a forecast.
- **Errors are typed and mapped once.** Services throw `ApiError` with a status and a machine
  code; the HTTP layer converts it to JSON without every handler repeating try/catch.
- **One language across the stack.** The browser code reuses the same mental model of the JSON
  shapes. No context switch between Python server and JavaScript client.

### Node.js 24

- **Ships SQLite.** `node:sqlite` is a synchronous, native-binding-free API in the runtime, so the
  project has zero runtime dependencies. For a marker or a shop laptop this matters: no
  `node-gyp`, no Python build toolchain, no native module that breaks on the next Node upgrade.
- **Synchronous database calls are an advantage here.** The shop has one counter, one process and
  one writer. Synchronous SQL plus `BEGIN IMMEDIATE` removes a whole class of interleaving bugs
  that async database drivers introduce. Concurrency is handled by SQLite's locking, not by
  application-level coordination.
- **`node:test`** gives unit, integration and HTTP tests with no framework.
- **Standard library covers the rest**: `node:http` for the API, `node:fs` for static files,
  `node:path` for safe resolution.

### SQLite

- **Real transactions, real constraints.** `BEGIN IMMEDIATE`, foreign keys, `CHECK` constraints
  and WAL mode are exactly the transactional features the problem needs, in a single file that can
  be copied to a USB stick.
- **SQL is the right language for the aggregation.** ABC analysis, daily demand series, revenue by
  category and gross margin are set-based questions. `GROUP BY` answers them in one statement
  instead of a loop in application code.
- **The database is the source of truth, not the ORM's cache.** There is no ORM. Every query is
  visible, parameterised and reviewable — which is also how SQL injection is avoided.

### Why not a framework for the UI?

The UI is six views of tables, forms and three chart types. A build step (React/Vite) would add
hundreds of dependencies and a second toolchain to a system whose value is in its data model. The
front end is ES modules, template literals and hand-written SVG, served as static files by the
same Node process. It is a deliberate trade: fewer dependencies, more explicit code.

## 2.4 The paradigm: functional core, imperative shell

No single paradigm handles both jobs well. The project uses a **layered architecture with a
functional core and an imperative shell** (also known as "functional core, imperative shell" or
hexagonal architecture with a pure domain):

```
┌─────────────────────────────────────────────────────────────┐
│ Imperative shell (I/O, state, time, transactions)           │
│  HTTP handlers → services → SQLite                          │
│  - reads the clock                                          │
│  - opens transactions                                       │
│  - throws ApiError                                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ passes plain values and arrays
┌───────────────────────────▼─────────────────────────────────┐
│ Functional core (pure, deterministic, testable)             │
│  domain/stock.ts · domain/classification.ts                 │
│  analytics/forecast.ts · analytics/decision.ts              │
│  - numbers in, numbers out                                  │
│  - no database, no HTTP, no Date.now()                      │
└─────────────────────────────────────────────────────────────┘
```

This is the key architectural decision, and it maps directly onto the two jobs:

### The transactional core is object-like and imperative — on purpose

Services encapsulate invariants and own the transaction boundary. `recordSale` is a procedure with
a clear contract: validate, lock, re-check stock from the ledger, write everything, or write
nothing.

```ts
export function recordSale(db: Db, input: SaleInput): Sale {
  const parsed = parseSale(db, input);               // validation, no writes
  const saleId = transaction(db, () => {             // BEGIN IMMEDIATE … COMMIT
    // availability is re-read inside the lock
    for (const line of parsed.lines) {
      const available = ledgerBalance(db, line.productId);
      if (line.quantity > available) throw conflict('Not enough stock', { shortages });
    }
    // header + lines + stock movements, all in the same unit of work
    …
  });
  return getSale(db, saleId);
}
```

Why not pure functions here? Because the work *is* side effects. Hiding them behind a functional
facade would add ceremony without adding safety. The safety comes from one transaction boundary,
enforced database constraints, and a test that proves a partially short sale leaves no trace.

### The decision-support core is pure and functional

Every formula the owner relies on is a pure function with a documented contract:

```ts
export function safetyStock(z: number, dailyStdDev: number, leadTimeDays: number): number {
  return z * dailyStdDev * Math.sqrt(leadTimeDays);
}

export function recommendOrderQuantity(input: OrderQuantityInput): OrderQuantityResult
export function forecastDemand(dailyHistory: readonly number[], endDate: Date,
                               options?: ForecastOptions): ForecastResult
export function classifyProducts(products: readonly MovementInput[]): MovementRow[]
```

Why pure?

- **Testability.** The forecast can be tested against a known series without a database, a clock or
  an HTTP request. The tests read like the maths.
- **Explainability.** A pure function can be printed in the report and shown in the UI. There is no
  hidden model state, no training step, no random seed.
- **Composability.** `buildDecision` combines `forecastDemand`, `demandStats`, `safetyStock`,
  `reorderPoint`, `classifyPosition` and `recommendOrderQuantity` for one product; the same code
  runs for all 28 products without change.
- **Determinism.** Given the same ledger, the same recommendation. That is a requirement in a
  business context: the owner must be able to re-run yesterday's advice and get yesterday's answer.

The boundary is explicit: services turn rows into arrays of numbers and dates, call the core, and
persist or return the result. The core never touches `Date.now()`; the date is passed in (which is
also why the tests can simulate any date).

### SQL is a third paradigm, used where it wins

The aggregation layer is set-based, not object-oriented:

```sql
SELECT p.category,
       SUM(si.line_total_cents) AS revenue,
       SUM(si.quantity)         AS units
  FROM sale_items si
  JOIN sales s    ON s.id = si.sale_id
  JOIN products p ON p.id = si.product_id
 WHERE substr(s.sold_at, 1, 10) BETWEEN ? AND ?
 GROUP BY p.category
 ORDER BY revenue DESC;
```

Trying to express that as a JavaScript reduce over 6 600 invoices would be slower, longer and
easier to get wrong. The project uses each paradigm where it is strongest: **SQL for sets, pure
functions for mathematics, services for invariants, the browser for presentation.**

## 2.5 How the transactional guarantees are actually built

Five mechanisms, each with a matching test:

1. **Integer money.** `unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0)`. No `REAL`
   column exists anywhere in the schema. Multiplication is `Math.round(cents * quantity)` with an
   integer-quantity guard.
2. **Append-only stock ledger.** Stock is `SUM(quantity_delta)`, never an `UPDATE products SET
   stock = …`. Corrections are new rows. This makes the shelf count auditable and the "stock never
   negative" check a single query.
3. **One transaction per sale.** `BEGIN IMMEDIATE` takes the write lock up front, so the
   availability check cannot be invalidated between reading and writing. Any thrown error triggers
   `ROLLBACK`.
4. **Validation before mutation.** `parseSale` resolves products, prices, payment method and date
   before the transaction opens, so a bad request never holds a write lock.
5. **Database constraints as a second line of defence.** `CHECK (quantity_delta <> 0)`,
   `CHECK (quantity > 0)`, foreign keys with `ON DELETE CASCADE`, unique invoice numbers and unique
   SKUs. Application bugs still have to get past the schema.

The test that matters most:

```ts
test('a partially short sale rolls back completely', () => {
  // Product B only has 2 units; asking for 3 must not leave product A's stock reduced.
  assert.throws(() => recordSale(db, { items: [A×2, B×3] }), ApiError);
  assert.equal(getProduct(db, productA).onHand, 10);  // unchanged
  assert.equal(listSales(db).length, 0);              // no invoice
});
```

## 2.6 How the decision support is actually built

1. **Demand history as a dense daily series.** Sparse sales rows are folded into a zero-filled
   array, because "no sale on Tuesday" is information, not a missing value.
2. **Weekly aggregation to remove day-of-week noise**, then simple exponential smoothing with the
   smoothing constant chosen by grid search (no library, no black box), plus an OLS trend that is
   capped and damped so a single good week cannot project to infinity.
3. **Weekday factors learned from the data**, shrunk toward "no effect" when a weekday has few
   observations, and normalised to sum to 7 so redistributing weekly demand conserves it.
4. **Uncertainty carried forward.** Residual standard deviation becomes safety stock, so the
   recommendation widens automatically for erratic products — a crucial property that a single
   average would hide.
5. **A backtest with a holdout.** The last four weeks are removed, forecast, and compared with
   actuals (MAPE). That number is shown in the UI and reported per product, so the owner knows how
   much to trust the forecast.
6. **A decision layer that explains itself.** `buildDecision` returns the numbers *and* a list of
   sentences: demand rate, trend, peak weekday, days of cover, safety stock, order rationale,
   backtest error.

## 2.7 Alternatives considered

| Option | Strengths | Why not chosen here |
| --- | --- | --- |
| **Python + pandas/Flask** | Excellent analytics, familiar to students, rich statistics | Money/transaction safety is weaker without extra discipline; two languages for UI + API; pandas is heavy for 28 products; type errors appear at runtime, not compile time |
| **Java + Spring + PostgreSQL** | Industrial-strength transactions, mature ORM, strong typing | Far too heavy for a shop laptop: JVM, server, migrations, build tool; over-engineered for one counter and one writer |
| **PHP + MySQL** | Every shared host supports it; classic LAMP stack | Weak typing (pre-8.0), awkward for the forecasting code; harder to test the pure maths in isolation |
| **C# / .NET WinForms** | Great desktop UI, strong typing, good SQL Server tooling | Windows-only deployment, harder to expose a browser UI, heavier toolchain |
| **Excel + VBA macros** | The shop already uses it; zero learning curve | No transactional integrity, no audit trail, formula errors silent, impossible to test, cannot support concurrent entry or a real API |
| **React + Node + PostgreSQL** | Modern, scalable, familiar to employers | Adds a build pipeline, hundreds of dependencies and a database server for a single-user system; the complexity buys nothing the brief asks for |
| **TypeScript + Node + SQLite (chosen)** | Type safety, one language, real transactions, zero runtime dependencies, trivial deployment, pure functions are easy to test | Single-writer concurrency, no built-in auth, no horizontal scaling (see §2.9) |

## 2.8 Evidence that the choice works

- **Type checking:** `tsc --strict --noUncheckedIndexedAccess` passes with no `any` escape hatches
  in the domain or analytics layers.
- **47 automated tests pass** in under a second (see [04-report.md](04-report.md#7-testing)):
  formulas, classification, forecasting edge cases, transaction rollback, HTTP API, static-file
  security.
- **Zero runtime dependencies**, so `npm install && npm start` works on a clean Node 24 machine.
- **The forecast is accurate enough to be useful:** mean backtest MAPE of **27%** across the 26
  sellable products on weekly demand, with flat, high-volume products around 12–16%.
- **The transactional guarantees are tested, not assumed:** oversell, partial-short rollback,
  negative adjustment, duplicate lines, invalid prices, future-dated sales and bad payment methods
  all have explicit tests.

## 2.9 Honest weaknesses of this choice

- **One writer.** SQLite serialises writes. This is correct for one shop; a chain with 20 tills
  would need PostgreSQL (the service layer would change, the domain and analytics would not).
- **No built-in authentication or multi-user roles.** The app is a local tool; exposing it on a
  network requires a reverse proxy with auth.
- **Node is single-threaded.** A very large forecast batch would block the event loop. At 28
  products it takes a few milliseconds; at 100 000 SKUs this would move to a worker or a batch job.
- **The forecasting model is intentionally simple.** It ignores promotions, holidays, competitor
  pricing and cannibalisation. For a small range with 1–2 years of history, that trade buys
  explainability; for a chain it would not be enough.
- **Synchronous SQL calls** are a deliberate simplification. They are safe and fast for one
  process; a high-throughput API would prefer async drivers and connection pooling.

## 2.10 Conclusion

The language and paradigm were chosen for the **shape of the problem**, not for fashion:

- **TypeScript** makes the domain vocabulary (cents, quantities, urgency) explicit and lets
  invalid states fail at compile time.
- **Node + SQLite** gives genuine ACID transactions with a deployment story a small business can
  actually operate.
- **The hybrid paradigm** — imperative services around a pure functional core — is what lets one
  codebase be trustworthy at the till and defensible at the whiteboard:
  - the *shell* owns the transaction, the clock and the errors;
  - the *core* owns the mathematics, remains deterministic, and is tested in isolation;
  - **SQL** does the set-based aggregation that neither of the other two does well.

This directly answers the programming challenge: a single-paradigm design would either wrap the
transactional work in unnecessary purity or bury the decision logic inside database calls where it
cannot be tested or explained. Splitting the two, with an explicit boundary, is what makes the
system both **safe to sell from** and **useful to decide with**.
