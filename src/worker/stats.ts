import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql, resolveRange, tzOffset, type Range } from './lib/time';
import { currencyDecimals } from './payments';

/** Filters that live on the session row (clicking a row in the dashboard adds one of these). */
const SESSION_FILTERS = [
  'channel',
  'source',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'entry_page',
  'exit_page',
  'hostname',
] as const;

export type Filters = Partial<Record<(typeof SESSION_FILTERS)[number] | 'page' | 'goal' | 'product', string>>;

export function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Filters = {};
    for (const k of [...SESSION_FILTERS, 'page', 'goal', 'product'] as const) {
      if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    }
    return out;
  } catch {
    return {};
  }
}

/** SQL + params restricting sessions `s` by the dashboard filters (not by time). */
function filterSql(f: Filters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of SESSION_FILTERS) {
    const v = f[k];
    if (v === undefined) continue;
    if (v === '') parts.push(`s.${k} IS NULL`);
    else {
      parts.push(`s.${k} = ?`);
      params.push(v);
    }
  }
  if (f.page) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'pageview' AND fe.path = ?)`);
    params.push(f.page);
  }
  if (f.goal) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'goal' AND fe.name = ?)`);
    params.push(f.goal);
  }
  if (f.product !== undefined) {
    if (f.product === '') {
      parts.push(`EXISTS (SELECT 1 FROM payments fp WHERE fp.site_id = s.site_id AND fp.session_id = s.id AND fp.product_id IS NULL)`);
    } else {
      parts.push(`EXISTS (SELECT 1 FROM payments fp WHERE fp.site_id = s.site_id AND fp.session_id = s.id AND fp.product_id = ?)`);
      params.push(f.product);
    }
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

const hasFilters = (f: Filters) => Object.keys(f).length > 0;

interface Ctx {
  db: D1Database;
  site: Site;
  range: Range;
  filters: Filters;
  offset: number;
}

export function makeCtxFrom(db: D1Database, site: Site, q: Record<string, string | undefined>): Ctx {
  const range = resolveRange(q, site.timezone, site.created_at);
  return { db, site, range, filters: parseFilters(q.filters), offset: tzOffset(site.timezone, range.to) };
}

export function makeCtx(c: Context<AppEnv>): Ctx {
  return makeCtxFrom(c.env.DB, c.get('site'), c.req.query());
}

function sessionsWhere(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const f = filterSql(ctx.filters);
  return {
    sql: `s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

/** Extra payment-column filters (product lives on payments, not sessions). */
function paymentFilterSql(f: Filters): { sql: string; params: unknown[] } {
  if (f.product === undefined) return { sql: '', params: [] };
  if (f.product === '') return { sql: ' AND p.product_id IS NULL', params: [] };
  return { sql: ' AND p.product_id = ?', params: [f.product] };
}

/** Session-side filters only (product lives on payments). */
function sessionFiltersOnly(f: Filters): Filters {
  const { product: _p, ...rest } = f;
  return rest;
}

/** Payments in the period; with session filters, only those credited to a matching visit. */
function paymentsFrom(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const pf = paymentFilterSql(ctx.filters);
  const sf = sessionFiltersOnly(ctx.filters);
  if (!hasFilters(sf)) {
    return { sql: `payments p WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${pf.sql}`, params: [ctx.site.id, from, to, ...pf.params] };
  }
  const f = filterSql(sf);
  return {
    sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
          WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}${pf.sql}`,
    params: [ctx.site.id, from, to, ...f.params, ...pf.params],
  };
}

const KPI_SQL = (where: string) => `
  SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
         COALESCE(SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END), 0) AS bounces,
         COALESCE(AVG(s.duration), 0) AS avg_duration
  FROM sessions s WHERE ${where}`;

const REVENUE_SQL = (from: string) => `
  SELECT COALESCE(SUM(p.amount), 0) AS revenue,
         COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.id) END) AS customers,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END), 0) AS payments
  FROM ${from}`;

interface KpiRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  avg_duration: number;
}
interface RevRow {
  revenue: number;
  customers: number;
  payments: number;
}

function kpis(k: KpiRow, r: RevRow, retention?: { newVisitors: number; returningVisitors: number }) {
  return {
    visitors: k.visitors,
    sessions: k.sessions,
    pageviews: k.pageviews,
    bounceRate: k.sessions ? k.bounces / k.sessions : 0,
    avgDuration: Math.round(k.avg_duration),
    revenue: r.revenue,
    payments: r.payments,
    customers: r.customers,
    conversionRate: k.visitors ? r.customers / k.visitors : 0,
    revenuePerVisitor: k.visitors ? r.revenue / k.visitors : 0,
    newVisitors: retention?.newVisitors ?? 0,
    returningVisitors: retention?.returningVisitors ?? 0,
  };
}

/** Top numbers + chart (includes previous-period overlay series and new/returning split). */
export async function overview(ctx: Ctx) {
  const { db, range, site } = ctx;
  const span = range.to - range.from;
  const prevFrom = range.from - span;
  const cur = sessionsWhere(ctx);
  const prev = sessionsWhere(ctx, prevFrom, range.from);
  const curPay = paymentsFrom(ctx);
  const prevPay = paymentsFrom(ctx, prevFrom, range.from);
  const sb = bucketSql('s.started_at', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  const now = Date.now();
  const prevRange: Range = { from: prevFrom, to: range.from, granularity: range.granularity };

  const [k1, k0, r1, r0, online, ts, tr, pts, ptr, ret1, ret0] = await db.batch([
    db.prepare(KPI_SQL(cur.sql)).bind(...cur.params),
    db.prepare(KPI_SQL(prev.sql)).bind(...prev.params),
    db.prepare(REVENUE_SQL(curPay.sql)).bind(...curPay.params),
    db.prepare(REVENUE_SQL(prevPay.sql)).bind(...prevPay.params),
    db
      .prepare('SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?')
      .bind(site.id, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM sessions s WHERE ${cur.sql} GROUP BY b`,
      )
      .bind(...cur.params),
    db
      .prepare(
        `SELECT ${pb} AS b, SUM(p.amount) AS revenue, SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments
         FROM ${curPay.sql} GROUP BY b`,
      )
      .bind(...curPay.params),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors
         FROM sessions s WHERE ${prev.sql} GROUP BY b`,
      )
      .bind(...prev.params),
    db
      .prepare(
        `SELECT ${pb} AS b, SUM(p.amount) AS revenue
         FROM ${prevPay.sql} GROUP BY b`,
      )
      .bind(...prevPay.params),
    db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN v.first_seen >= ? AND v.first_seen < ? THEN s.visitor_id END) AS new_visitors,
                COUNT(DISTINCT CASE WHEN v.first_seen < ? THEN s.visitor_id END) AS returning_visitors
         FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE ${cur.sql}`,
      )
      .bind(range.from, range.to, range.from, ...cur.params),
    db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN v.first_seen >= ? AND v.first_seen < ? THEN s.visitor_id END) AS new_visitors,
                COUNT(DISTINCT CASE WHEN v.first_seen < ? THEN s.visitor_id END) AS returning_visitors
         FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE ${prev.sql}`,
      )
      .bind(prevFrom, range.from, prevFrom, ...prev.params),
  ]);

  const visitorsBy = new Map((ts.results as any[]).map((r) => [r.b, r]));
  const revenueBy = new Map((tr.results as any[]).map((r) => [r.b, r]));
  const prevVisitorsBy = new Map((pts.results as any[]).map((r) => [r.b, r.visitors as number]));
  const prevRevenueBy = new Map((ptr.results as any[]).map((r) => [r.b, r.revenue as number]));
  const labels = bucketLabels(range, ctx.offset);
  const prevLabels = bucketLabels(prevRange, ctx.offset);
  const series = labels.map((b, i) => ({
    bucket: b,
    visitors: visitorsBy.get(b)?.visitors ?? 0,
    pageviews: visitorsBy.get(b)?.pageviews ?? 0,
    revenue: revenueBy.get(b)?.revenue ?? 0,
    payments: revenueBy.get(b)?.payments ?? 0,
    visitors_prev: prevVisitorsBy.get(prevLabels[i] ?? '') ?? 0,
    revenue_prev: prevRevenueBy.get(prevLabels[i] ?? '') ?? 0,
  }));

  const curRet = (ret1.results[0] as { new_visitors: number; returning_visitors: number }) ?? { new_visitors: 0, returning_visitors: 0 };
  const prevRet = (ret0.results[0] as { new_visitors: number; returning_visitors: number }) ?? { new_visitors: 0, returning_visitors: 0 };

  return {
    range,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    current: kpis(k1.results[0] as KpiRow, r1.results[0] as RevRow, {
      newVisitors: curRet.new_visitors,
      returningVisitors: curRet.returning_visitors,
    }),
    previous: kpis(k0.results[0] as KpiRow, r0.results[0] as RevRow, {
      newVisitors: prevRet.new_visitors,
      returningVisitors: prevRet.returning_visitors,
    }),
    online: (online.results[0] as { n: number }).n,
    series,
  };
}

/** Session dimensions, keyed by the name the dashboard asks for. */
const SESSION_DIMS: Record<string, string> = {
  channel: 's.channel',
  source: 's.source',
  campaign: 's.utm_campaign',
  keyword: 's.utm_term',
  utm_source: 's.utm_source',
  utm_medium: 's.utm_medium',
  utm_content: 's.utm_content',
  ref: 's.ref',
  country: 's.country',
  region: 's.region',
  city: 's.city',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  entry_page: 's.entry_page',
  exit_page: 's.exit_page',
  hostname: 's.hostname',
  referrer: 's.referrer',
};

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  icon?: string | null;
  extra?: string | null;
}

export async function breakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const { db } = ctx;
  const lim = Math.max(1, Math.min(500, limit));

  if (SESSION_DIMS[dim]) {
    const col = SESSION_DIMS[dim];
    const w = sessionsWhere(ctx);
    // Revenue always joins sessions so we can group by session dimensions; product filter stays on payments.
    const sf = filterSql(sessionFiltersOnly(ctx.filters));
    const pf = paymentFilterSql(ctx.filters);
    const payParams = [ctx.site.id, ctx.range.from, ctx.range.to, ...sf.params, ...pf.params];
    const payJoin = `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
                     WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${sf.sql}${pf.sql}`;
    const extraCol =
      dim === 'source' ? 'MAX(s.referrer_domain)' : dim === 'region' || dim === 'city' ? 'MAX(s.country)' : 'NULL';
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT ${col} AS label, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews, ${extraCol} AS extra
           FROM sessions s WHERE ${w.sql} GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...w.params),
      db
        .prepare(
          `SELECT ${col} AS label, SUM(p.amount) AS revenue,
                  COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.visitor_id, p.id) END) AS customers
           FROM ${payJoin} GROUP BY label`,
        )
        .bind(...payParams),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'page') {
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      // Revenue from customers who viewed the page during the period.
      db
        .prepare(
          `SELECT pv.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
           FROM (SELECT DISTINCT e.path AS label, e.visitor_id ${base}) pv
           JOIN payments p ON p.site_id = ? AND p.visitor_id = pv.visitor_id AND p.ts >= ? AND p.ts < ?
           GROUP BY pv.label`,
        )
        .bind(...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'exit_link' || dim === 'goal') {
    const type = dim === 'goal' ? 'goal' : 'outbound';
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, type, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.name AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      db
        .prepare(
          `SELECT g.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
           FROM (SELECT DISTINCT e.name AS label, e.visitor_id ${base}) g
           JOIN payments p ON p.site_id = ? AND p.visitor_id = g.visitor_id AND p.ts >= ? AND p.ts < ?
           GROUP BY g.label`,
        )
        .bind(...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return merge(v.results as any[], r.results as any[]);
  }

  if (dim === 'product') {
    const pay = paymentsFrom(ctx);
    const r = await db
      .prepare(
        `SELECT p.product_id AS label, SUM(p.amount) AS revenue,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.visitor_id, p.id) END) AS customers,
                COUNT(DISTINCT p.visitor_id) AS visitors
         FROM ${pay.sql}
         GROUP BY p.product_id
         ORDER BY revenue DESC LIMIT ${lim}`,
      )
      .bind(...pay.params)
      .all();
    return (r.results as any[]).map((row) => ({
      label: row.label,
      visitors: row.visitors ?? 0,
      revenue: row.revenue ?? 0,
      customers: row.customers ?? 0,
    }));
  }

  throw new Error(`unknown dimension ${dim}`);
}

function merge(visits: any[], revenue: any[]): BreakdownRow[] {
  const rev = new Map(revenue.map((r) => [r.label, r]));
  const rows: BreakdownRow[] = visits.map((v) => ({
    label: v.label,
    visitors: v.visitors,
    pageviews: v.pageviews ?? undefined,
    revenue: rev.get(v.label)?.revenue ?? 0,
    customers: rev.get(v.label)?.customers ?? 0,
    extra: v.extra ?? null,
  }));
  // Sources that made money but had no visits in this period (paid later) still show up.
  const seen = new Set(visits.map((v) => v.label));
  for (const r of revenue) if (!seen.has(r.label)) rows.push({ label: r.label, visitors: 0, revenue: r.revenue, customers: r.customers });
  return rows;
}

/** Customers in the period, with where they came from (the "Journey" tab). */
export async function customers(ctx: Ctx) {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
  const res = await db
    .prepare(
      `SELECT p.id, p.ts, p.amount, p.currency, p.renewal, p.matched_by, p.email AS pay_email, p.name AS pay_name, p.visitor_id, p.session_id,
              v.first_seen, v.name, v.email, v.user_id,
              s.source, s.channel, s.referrer_domain, s.utm_campaign, s.ref, s.country, s.city, s.device, s.os, s.browser, s.entry_page,
              (SELECT COUNT(*) FROM sessions s2 WHERE s2.site_id = p.site_id AND s2.visitor_id = p.visitor_id AND s2.started_at <= p.ts) AS visits
       FROM payments p
       LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
       ${join} sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id = ? AND p.kind = 'payment' AND p.ts >= ? AND p.ts < ?${f.sql}
       ORDER BY p.ts DESC LIMIT 200`,
    )
    .bind(site.id, range.from, range.to, ...f.params)
    .all();
  return res.results;
}

/** Recent visitors in the period (the "Users" tab). */
export async function visitors(ctx: Ctx) {
  const w = sessionsWhere(ctx);
  const res = await ctx.db
    .prepare(
      `SELECT t.*, v.name, v.email, v.user_id, v.first_seen,
              (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = t.site_id AND p.visitor_id = t.visitor_id) AS spent
       FROM (
         SELECT s.site_id, s.visitor_id, MAX(s.last_seen_at) AS last_seen, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
                SUM(s.duration) AS duration, s.source, s.referrer_domain, s.country, s.city, s.device, s.os, s.browser
         FROM sessions s WHERE ${w.sql} GROUP BY s.visitor_id ORDER BY last_seen DESC LIMIT 200
       ) t LEFT JOIN visitors v ON v.site_id = t.site_id AND v.id = t.visitor_id
       ORDER BY t.last_seen DESC`,
    )
    .bind(...w.params)
    .all();
  return res.results;
}

/** Everything one visitor did: visits, pages, clicks, payments. */
export async function visitorProfile(db: D1Database, site: Site, vid: string) {
  const [v, s, e, p] = await db.batch([
    db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    db.prepare('SELECT * FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 100').bind(site.id, vid),
    db
      .prepare('SELECT session_id, ts, type, name, path, props FROM events WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC LIMIT 1000')
      .bind(site.id, vid),
    db.prepare('SELECT * FROM payments WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC').bind(site.id, vid),
  ]);
  return {
    visitor: v.results[0] ?? null,
    sessions: s.results,
    events: e.results,
    payments: p.results,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
  };
}

export interface FunnelStep {
  type: 'page' | 'goal';
  value: string; // page paths support * wildcards, e.g. /blog/*
  label?: string;
}

/** Visitors who completed each step, in order, within the period. */
export async function funnel(ctx: Ctx, steps: FunnelStep[]) {
  if (!steps.length) return [];
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const st of steps) {
    if (st.type === 'goal') {
      conds.push(`(e.type = 'goal' AND e.name = ?)`);
      params.push(st.value);
    } else {
      conds.push(`(e.type = 'pageview' AND e.path GLOB ?)`);
      params.push(st.value);
    }
  }
  const rows = (
    await ctx.db
      .prepare(
        `SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}
         WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (${conds.join(' OR ')})${f.sql}
         ORDER BY e.ts LIMIT 100000`,
      )
      .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...params, ...f.params)
      .all<{ v: string; ts: number; type: string; name: string | null; path: string }>()
  ).results;

  const matchers = steps.map((st) => {
    if (st.type === 'goal') return (r: (typeof rows)[0]) => r.type === 'goal' && r.name === st.value;
    const re = new RegExp('^' + st.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return (r: (typeof rows)[0]) => r.type === 'pageview' && re.test(r.path);
  });
  const progress = new Map<string, number>();
  for (const r of rows) {
    const at = progress.get(r.v) ?? 0;
    if (at < steps.length && matchers[at](r)) progress.set(r.v, at + 1);
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  return steps.map((st, i) => ({ ...st, visitors: counts[i] }));
}

/** Everything the live globe needs: who is on the site right now, and what happened in the last 30 minutes. */
export async function realtime(db: D1Database, site: Site, now = Date.now()) {
  const ACTIVE_MS = 5 * 60_000;
  const FEED_MS = 30 * 60_000;
  const [visitors, events, payments] = await db.batch([
    db
      .prepare(
        `SELECT s.visitor_id, s.id AS session_id, s.lat, s.lon, s.country, s.region, s.city, s.device, s.browser, s.os,
                s.source, s.referrer_domain, s.exit_page AS page, s.started_at, s.last_seen_at, s.pageviews,
                v.name, v.email,
                (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = s.site_id AND p.visitor_id = s.visitor_id) AS spent
         FROM sessions s LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ? AND s.started_at > ? AND s.last_seen_at > ?
         ORDER BY s.last_seen_at DESC LIMIT 500`,
      )
      .bind(site.id, now - 6 * 3_600_000, now - ACTIVE_MS),
    db
      .prepare(
        `SELECT e.id, e.ts, e.type, e.name, e.path, e.visitor_id, s.country, s.lat, s.lon, v.name AS vname, v.email AS vemail
         FROM events e
         LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         LEFT JOIN visitors v ON v.site_id = e.site_id AND v.id = e.visitor_id
         WHERE e.site_id = ? AND e.ts > ? AND e.type IN ('pageview', 'goal')
         ORDER BY e.ts DESC LIMIT 100`,
      )
      .bind(site.id, now - FEED_MS),
    db
      .prepare(
        `SELECT p.id, p.ts, p.amount, p.kind, p.visitor_id, p.name, p.email, s.country, s.lat, s.lon
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id = ? AND p.ts > ?
         ORDER BY p.ts DESC LIMIT 50`,
      )
      .bind(site.id, now - FEED_MS),
  ]);

  // One marker per visitor (their most recent visit).
  const seen = new Set<string>();
  const active = (visitors.results as any[]).filter((v) => !seen.has(v.visitor_id) && seen.add(v.visitor_id));

  const feed = [
    ...(events.results as any[]).map((e) => ({
      id: `e${e.id}`,
      ts: e.ts,
      type: e.type as 'pageview' | 'goal',
      label: e.type === 'goal' ? e.name : e.path,
      visitor_id: e.visitor_id,
      name: e.vname ?? e.vemail ?? null,
      country: e.country,
      lat: e.lat,
      lon: e.lon,
    })),
    ...(payments.results as any[]).map((p) => ({
      id: `p${p.id}`,
      ts: p.ts,
      type: (p.kind === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
      amount: p.amount,
      visitor_id: p.visitor_id,
      name: p.name ?? p.email ?? null,
      country: p.country,
      lat: p.lat,
      lon: p.lon,
    })),
  ].sort((a, b) => b.ts - a.ts);

  return { now, currency: site.currency, decimals: currencyDecimals(site.currency), domain: site.domain, visitors: active, feed };
}

/** Sparkline sizes for the all-websites view: [range, bucket count]. Rolling windows, so no timezone maths. */
const SPARK_PERIODS: Record<string, [number, number]> = {
  '24h': [86_400_000, 24],
  '7d': [7 * 86_400_000, 28],
  '30d': [30 * 86_400_000, 30],
  '90d': [90 * 86_400_000, 45],
};

export interface SiteSpark {
  id: string;
  visitors: number;
  revenue: number;
  online: number;
  series: { visitors: number; revenue: number }[];
}

/** Totals and a small visitors/revenue series for every site the user can see, in one round trip. */
export async function sparklines(db: D1Database, siteIds: string[], period: string, now = Date.now()): Promise<SiteSpark[]> {
  if (!siteIds.length) return [];
  // D1 allows 100 bound parameters per statement.
  if (siteIds.length > 90) {
    const chunks = [];
    for (let i = 0; i < siteIds.length; i += 90) chunks.push(sparklines(db, siteIds.slice(i, i + 90), period, now));
    return (await Promise.all(chunks)).flat();
  }
  const [span, n] = SPARK_PERIODS[period] ?? SPARK_PERIODS['30d'];
  const width = span / n;
  const from = now - span;
  const ids = siteIds.map(() => '?').join(', ');
  const bucket = (col: string) => `MIN(${n - 1}, CAST((${col} - ${from}) / ${width} AS INTEGER))`;

  const [totals, pay, online, vs, rs] = await db.batch([
    db
      .prepare(`SELECT site_id, COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id IN (${ids}) AND started_at >= ? GROUP BY site_id`)
      .bind(...siteIds, from),
    db.prepare(`SELECT site_id, SUM(amount) AS r FROM payments WHERE site_id IN (${ids}) AND ts >= ? GROUP BY site_id`).bind(...siteIds, from),
    db
      .prepare(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS n FROM sessions
         WHERE site_id IN (${ids}) AND started_at > ? AND last_seen_at > ? GROUP BY site_id`,
      )
      .bind(...siteIds, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT site_id, ${bucket('started_at')} AS b, COUNT(DISTINCT visitor_id) AS v FROM sessions
         WHERE site_id IN (${ids}) AND started_at >= ? GROUP BY site_id, b`,
      )
      .bind(...siteIds, from),
    db
      .prepare(`SELECT site_id, ${bucket('ts')} AS b, SUM(amount) AS r FROM payments WHERE site_id IN (${ids}) AND ts >= ? GROUP BY site_id, b`)
      .bind(...siteIds, from),
  ]);

  const byId = (rows: unknown[], field: string) => new Map((rows as any[]).map((r) => [r.site_id, r[field] as number]));
  const v = byId(totals.results, 'v');
  const r = byId(pay.results, 'r');
  const o = byId(online.results, 'n');
  const out = new Map(
    siteIds.map((id) => [
      id,
      { id, visitors: v.get(id) ?? 0, revenue: r.get(id) ?? 0, online: o.get(id) ?? 0, series: Array.from({ length: n }, () => ({ visitors: 0, revenue: 0 })) },
    ]),
  );
  for (const row of vs.results as any[]) out.get(row.site_id)!.series[row.b].visitors = row.v;
  for (const row of rs.results as any[]) out.get(row.site_id)!.series[row.b].revenue = row.r;
  return [...out.values()];
}

export interface Insight {
  id: string;
  kind: 'kpi' | 'share' | 'mover';
  title: string;
  detail: string;
  sentiment: 'up' | 'down' | 'neutral';
  filter?: { key: string; value: string };
  score: number;
}

function pctChange(cur: number, prev: number): number | null {
  if (!prev) return cur ? 1 : null;
  return (cur - prev) / prev;
}

function fmtSignedPct(n: number): string {
  const pct = Math.round(Math.abs(n) * 100);
  return `${n >= 0 ? '+' : '−'}${pct}%`;
}

const INSIGHT_DIMS: { dim: string; filter: string; noun: string }[] = [
  { dim: 'source', filter: 'source', noun: 'referrer' },
  { dim: 'channel', filter: 'channel', noun: 'channel' },
  { dim: 'campaign', filter: 'utm_campaign', noun: 'campaign' },
  { dim: 'country', filter: 'country', noun: 'country' },
  { dim: 'product', filter: 'product', noun: 'product' },
];

/** Pure ranking helper — exported for unit tests. */
export function rankInsights(input: {
  current: ReturnType<typeof kpis>;
  previous: ReturnType<typeof kpis>;
  movers: { dim: string; filter: string; noun: string; label: string | null; revenue: number; prevRevenue: number; visitors: number }[];
}): Insight[] {
  const cards: Insight[] = [];
  const { current: c, previous: p } = input;

  const revPct = pctChange(c.revenue, p.revenue);
  if (revPct !== null && (Math.abs(revPct) >= 0.05 || c.revenue > 0)) {
    cards.push({
      id: 'kpi-revenue',
      kind: 'kpi',
      title: `Revenue ${fmtSignedPct(revPct)} vs prior period`,
      detail: p.revenue ? `Compared with the previous window of the same length.` : `No revenue in the prior period.`,
      sentiment: revPct >= 0 ? 'up' : 'down',
      score: Math.abs(revPct) * 100 + (c.revenue > 0 ? 10 : 0),
    });
  }

  const visPct = pctChange(c.visitors, p.visitors);
  if (visPct !== null && Math.abs(visPct) >= 0.08) {
    cards.push({
      id: 'kpi-visitors',
      kind: 'kpi',
      title: `Visitors ${fmtSignedPct(visPct)}`,
      detail: `${c.newVisitors} new · ${c.returningVisitors} returning`,
      sentiment: visPct >= 0 ? 'up' : 'down',
      score: Math.abs(visPct) * 80,
    });
  }

  const convDelta = c.conversionRate - p.conversionRate;
  if (p.visitors >= 20 && Math.abs(convDelta) >= 0.005) {
    const pp = (convDelta * 100).toFixed(1);
    cards.push({
      id: 'kpi-conversion',
      kind: 'kpi',
      title: `Conversion ${convDelta >= 0 ? '+' : ''}${pp}pp`,
      detail: `${(c.conversionRate * 100).toFixed(1)}% of visitors became customers`,
      sentiment: convDelta >= 0 ? 'up' : 'down',
      score: Math.abs(convDelta) * 2000,
    });
  }

  for (const m of input.movers) {
    const label = m.label || (m.dim === 'product' ? 'Unknown product' : 'Direct/None');
    if (c.revenue > 0 && m.revenue > 0) {
      const share = m.revenue / c.revenue;
      if (share >= 0.2) {
        cards.push({
          id: `share-${m.dim}-${label}`,
          kind: 'share',
          title: `${label} drove ${Math.round(share * 100)}% of revenue`,
          detail: `Top ${m.noun} this period`,
          sentiment: 'neutral',
          filter: { key: m.filter, value: m.label ?? '' },
          score: share * 90,
        });
      }
    }
    const move = pctChange(m.revenue, m.prevRevenue);
    if (move !== null && Math.abs(move) >= 0.25 && (m.revenue > 0 || m.prevRevenue > 0)) {
      cards.push({
        id: `mover-${m.dim}-${label}`,
        kind: 'mover',
        title: `${label} revenue ${fmtSignedPct(move)}`,
        detail: `Biggest ${m.noun} mover vs prior period`,
        sentiment: move >= 0 ? 'up' : 'down',
        filter: { key: m.filter, value: m.label ?? '' },
        score: Math.abs(move) * 70 + (m.revenue / Math.max(c.revenue, 1)) * 40,
      });
    }
  }

  cards.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const card of cards) {
    const key = card.filter ? `${card.filter.key}:${card.filter.value}` : card.id;
    if (seen.has(key) && card.kind !== 'kpi') continue;
    seen.add(key);
    out.push(card);
    if (out.length >= 5) break;
  }
  return out;
}

/** Rule-based insight cards for the selected range/filters. */
export async function insights(ctx: Ctx): Promise<Insight[]> {
  const ov = await overview(ctx);
  const movers: { dim: string; filter: string; noun: string; label: string | null; revenue: number; prevRevenue: number; visitors: number }[] = [];
  const span = ctx.range.to - ctx.range.from;
  const prevFrom = ctx.range.from - span;

  for (const d of INSIGHT_DIMS) {
    const [curRows, prevRows] = await Promise.all([
      breakdown(ctx, d.dim, 8),
      breakdown({ ...ctx, range: { ...ctx.range, from: prevFrom, to: ctx.range.from } }, d.dim, 8),
    ]);
    const prevMap = new Map(prevRows.map((r) => [r.label, r.revenue]));
    for (const row of curRows.slice(0, 5)) {
      movers.push({
        dim: d.dim,
        filter: d.filter,
        noun: d.noun,
        label: row.label,
        revenue: row.revenue,
        prevRevenue: prevMap.get(row.label) ?? 0,
        visitors: row.visitors,
      });
    }
    // Also catch big drop-offs that disappeared from the top.
    for (const row of prevRows.slice(0, 3)) {
      if (curRows.some((r) => r.label === row.label)) continue;
      movers.push({
        dim: d.dim,
        filter: d.filter,
        noun: d.noun,
        label: row.label,
        revenue: 0,
        prevRevenue: row.revenue,
        visitors: 0,
      });
    }
  }

  return rankInsights({ current: ov.current, previous: ov.previous, movers });
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

/** CSV export for overview series, a breakdown dimension, or customers. */
export async function exportCsv(ctx: Ctx, kind: string, dim = 'source'): Promise<{ filename: string; body: string }> {
  const site = ctx.site.domain.replace(/[^a-z0-9.-]+/gi, '_');
  const day = new Date(ctx.range.to).toISOString().slice(0, 10);
  if (kind === 'overview') {
    const ov = await overview(ctx);
    return {
      filename: `${site}-overview-${day}.csv`,
      body: toCsv(
        ['bucket', 'visitors', 'visitors_prev', 'pageviews', 'revenue', 'revenue_prev', 'payments'],
        ov.series.map((r) => [r.bucket, r.visitors, r.visitors_prev, r.pageviews, r.revenue, r.revenue_prev, r.payments]),
      ),
    };
  }
  if (kind === 'breakdown') {
    const rows = await breakdown(ctx, dim, 500);
    return {
      filename: `${site}-${dim}-${day}.csv`,
      body: toCsv(
        ['label', 'visitors', 'pageviews', 'revenue', 'customers'],
        rows.map((r) => [r.label ?? '', r.visitors, r.pageviews ?? '', r.revenue, r.customers]),
      ),
    };
  }
  if (kind === 'customers') {
    const rows = (await customers(ctx)) as any[];
    return {
      filename: `${site}-customers-${day}.csv`,
      body: toCsv(
        ['ts', 'amount', 'currency', 'email', 'name', 'source', 'channel', 'campaign', 'country', 'matched_by', 'visitor_id'],
        rows.map((r) => [
          r.ts,
          r.amount,
          r.currency,
          r.pay_email ?? r.email ?? '',
          r.pay_name ?? r.name ?? '',
          r.source ?? '',
          r.channel ?? '',
          r.utm_campaign ?? '',
          r.country ?? '',
          r.matched_by ?? '',
          r.visitor_id ?? '',
        ]),
      ),
    };
  }
  throw new Error('kind must be overview, breakdown, or customers');
}

/** Plain-text period summary for clipboard copy. */
export function formatPeriodSummary(input: {
  siteName: string;
  periodLabel: string;
  currency: string;
  decimals: number;
  current: ReturnType<typeof kpis>;
  previous: ReturnType<typeof kpis>;
  insights: Insight[];
  money: (minor: number) => string;
}): string {
  const { current: c, previous: p, insights: cards, money } = input;
  const lines = [
    `${input.siteName} · ${input.periodLabel}`,
    `Visitors: ${c.visitors} (${c.newVisitors} new / ${c.returningVisitors} returning)`,
    `Revenue: ${money(c.revenue)} · Conversion: ${(c.conversionRate * 100).toFixed(1)}%`,
  ];
  const revPct = pctChange(c.revenue, p.revenue);
  if (revPct !== null) lines.push(`Revenue vs prior: ${fmtSignedPct(revPct)}`);
  if (cards.length) {
    lines.push('', 'Insights:');
    for (const card of cards.slice(0, 5)) lines.push(`• ${card.title}${card.detail ? ` — ${card.detail}` : ''}`);
  }
  return lines.join('\n');
}
