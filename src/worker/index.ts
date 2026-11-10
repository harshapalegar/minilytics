import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { handleEvent } from './collect';
import { forgetSite, type AppEnv, type Site } from './env';
import { clearSession, currentUser, googleCallback, googleStart, isHosted, requireUser, setSession, siteAccessSql } from './auth';
import { billingWebhook, checkout, planInfo } from './billing';
import { passwordsMatch, randomId } from './lib/crypto';
import { handleDodoWebhook, handleGoalApi, handlePaymentApi, handleStripeWebhook, learnDodoProducts, rematchPayments } from './payments';
import { rememberOwnerDevice } from './owner';
import {
  breakdown,
  customers,
  exportCsv,
  funnel,
  insights,
  makeCtx,
  makeCtxFrom,
  overview,
  realtime,
  sparklines,
  visitorProfile,
  visitors,
  type FunnelStep,
} from './stats';

const app = new Hono<AppEnv>();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

// Basic hardening for everything the Worker answers (API and app pages). Static files get the same
// headers from public/_headers. The tracking script and endpoint stay embeddable on customers' sites.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (c.req.path.startsWith('/api/')) {
    // Stats, settings and secrets must never sit in a shared or browser cache.
    if (c.req.path !== '/api/event' && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  } else {
    // The dashboard can't be framed by another site (clickjacking).
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  }
});

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.post('/api/event', handleEvent);
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/webhooks/stripe/:siteId', handleStripeWebhook);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);

// ---------- login

app.post('/api/auth/login', async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }
  // Lock an IP out after too many wrong passwords, so a public dashboard can't be brute-forced.
  // The attempt is recorded and counted in one atomic batch BEFORE the password is checked: checking first
  // and recording afterwards would let a burst of parallel guesses all slip under the limit.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const [, , attempts] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    c.env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(ip, now),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?').bind(ip, now - LOCKOUT_MS),
  ]);
  if (((attempts.results[0] as { n: number } | undefined)?.n ?? 0) > MAX_FAILURES) {
    return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  }
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || !passwordsMatch(password, c.env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  await setSession(c, 'admin');
  return c.json({ ok: true });
});

app.get('/api/auth/google', googleStart);
app.get('/api/auth/google/callback', googleCallback);

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c);
  if (user) c.executionCtx.waitUntil(rememberOwnerDevice(c, user).catch(() => {}));
  return c.json({ loggedIn: !!user, hosted: isHosted(c.env), user });
});

// ---------- billing (hosted mode)

app.get('/api/public/plan', async (c) => c.json(await planInfo(c.env)));
app.post('/api/billing/webhook', billingWebhook);
app.get('/api/billing/checkout', requireUser, checkout);

// ---------- public read-only share links

async function loadShare(c: Context<AppEnv>): Promise<{ site: Site; token: string } | Response> {
  const token = c.req.param('token');
  if (!token || token.length < 16) return c.json({ error: 'not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT s.*, sl.token, sl.expires_at, sl.label AS share_label
     FROM share_links sl JOIN sites s ON s.id = sl.site_id
     WHERE sl.token = ?`,
  )
    .bind(token)
    .first<Site & { token: string; expires_at: number | null; share_label: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.expires_at != null && row.expires_at < Date.now()) return c.json({ error: 'This share link has expired' }, 410);
  const { token: _t, expires_at: _e, share_label: _l, ...site } = row;
  return { site: site as Site, token };
}

app.get('/api/share/:token', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json({
    site: {
      id: loaded.site.id,
      name: loaded.site.name,
      domain: loaded.site.domain,
      timezone: loaded.site.timezone,
      currency: loaded.site.currency,
      created_at: loaded.site.created_at,
    },
    readOnly: true,
  });
});

app.get('/api/share/:token/overview', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json(await overview(makeCtxFrom(c.env.DB, loaded.site, c.req.query())));
});

app.get('/api/share/:token/insights', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json(await insights(makeCtxFrom(c.env.DB, loaded.site, c.req.query())));
});

app.get('/api/share/:token/breakdown', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  try {
    return c.json(
      await breakdown(makeCtxFrom(c.env.DB, loaded.site, c.req.query()), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100),
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get('/api/share/:token/customers', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json(await customers(makeCtxFrom(c.env.DB, loaded.site, c.req.query())));
});

app.get('/api/share/:token/visitors', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json(await visitors(makeCtxFrom(c.env.DB, loaded.site, c.req.query())));
});

app.get('/api/share/:token/visitors/:vid', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json(await visitorProfile(c.env.DB, loaded.site, c.req.param('vid')));
});

app.get('/api/share/:token/realtime', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  return c.json(await realtime(c.env.DB, loaded.site));
});

app.get('/api/share/:token/funnels', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(loaded.site.id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
});

app.get('/api/share/:token/funnels/:fid/stats', async (c) => {
  const loaded = await loadShare(c);
  if (loaded instanceof Response) return loaded;
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), loaded.site.id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtxFrom(c.env.DB, loaded.site, c.req.query()), JSON.parse(f.steps)));
});

// ---------- dashboard API (login required)

app.use('/api/sites', requireUser);
app.use('/api/sites/*', requireUser);

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`)
    .bind(c.req.param('id'), ...access.params)
    .first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mask = (secret: string | null | undefined) => (secret ? '••••••••' : null);
const publicSite = (s: Site) => ({ ...s, dodo_webhook_secret: mask(s.dodo_webhook_secret), stripe_webhook_secret: mask(s.stripe_webhook_secret) });

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const access = siteAccessSql(c.env, c.get('user'));
  const [sites, stats] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(...access.params),
    c.env.DB.prepare(
      `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online
       FROM sessions WHERE started_at > ? GROUP BY site_id`,
    ).bind(now - 5 * 60_000, now - 86_400_000),
  ]);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  return c.json(
    (sites.results as unknown as Site[]).map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: by.get(s.id)?.online ?? 0,
    })),
  );
});

// Every site's totals and sparkline for the all-websites view.
app.use('/api/sites-overview', requireUser);
app.get('/api/sites-overview', async (c) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const rows = await c.env.DB.prepare(`SELECT s.id FROM sites s WHERE ${access.sql}`).bind(...access.params).all<{ id: string }>();
  const sites = await sparklines(
    c.env.DB,
    rows.results.map((r) => r.id),
    c.req.query('period') ?? '30d',
  );
  const totals = {
    visitors: sites.reduce((a, s) => a + s.visitors, 0),
    revenue: sites.reduce((a, s) => a + s.revenue, 0),
    online: sites.reduce((a, s) => a + s.online, 0),
  };
  return c.json({ sites, totals });
});

app.post('/api/sites', async (c) => {
  const user = c.get('user');
  if (isHosted(c.env) && !user.paid) return c.json({ error: 'Choose a plan to add websites.' }, 402);
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: 'Enter a domain like example.com' }, 400);
  if (b.timezone && !validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
  const tz = b.timezone || 'UTC';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'ml_' + randomId(16),
    dodo_webhook_secret: null,
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, site.created_at, isHosted(c.env) ? user.id : null)
    .run();
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', (c) => c.json(publicSite(c.get('site'))));

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim() || null;
  }
  if (typeof b.stripe_webhook_secret === 'string' && !b.stripe_webhook_secret.includes('•')) {
    next.stripe_webhook_secret = b.stripe_webhook_secret.trim() || null;
  }
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]+$/.test(x));
    next.dodo_product_ids = ids.join(',') || null;
  }
  await c.env.DB.prepare(
    'UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, dodo_product_ids = ?, stripe_webhook_secret = ? WHERE id = ?',
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.dodo_product_ids ?? null,
      next.stripe_webhook_secret ?? null,
      site.id,
    )
    .run();
  forgetSite(site.id);
  return c.json(publicSite(next));
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'ml_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await c.env.DB.batch(
    // Everything stored for the site, so deleting it really removes its visitors' data.
    ['events', 'sessions', 'visitors', 'payments', 'funnels', 'payment_claims', 'pending_payments', 'dodo_products', 'share_links']
      .map((t) => c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id))
      .concat(c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  forgetSite(id);
  return c.json({ ok: true });
});

// ---------- stats

app.get('/api/sites/:id/overview', async (c) => c.json(await overview(makeCtx(c))));
app.get('/api/sites/:id/insights', async (c) => c.json(await insights(makeCtx(c))));

app.get('/api/sites/:id/breakdown', async (c) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get('/api/sites/:id/export.csv', async (c) => {
  try {
    const kind = c.req.query('kind') ?? 'overview';
    const { filename, body } = await exportCsv(makeCtx(c), kind, c.req.query('dim') ?? 'source');
    return new Response(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get('/api/sites/:id/share-links', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT token, label, created_at, expires_at FROM share_links WHERE site_id = ? ORDER BY created_at DESC',
  )
    .bind(c.get('site').id)
    .all();
  return c.json(rows.results);
});

app.post('/api/sites/:id/share-links', async (c) => {
  const b = await c.req.json<{ label?: string; days?: number }>().catch(() => ({}) as { label?: string; days?: number });
  const token = randomId(24);
  const now = Date.now();
  const days = Number.isFinite(b.days) ? Math.max(1, Math.min(365, Number(b.days))) : 30;
  const expires_at = now + days * 86_400_000;
  const label = (b.label ?? 'Read-only link').trim().slice(0, 80) || 'Read-only link';
  await c.env.DB.prepare('INSERT INTO share_links (token, site_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(token, c.get('site').id, label, now, expires_at)
    .run();
  return c.json({ token, label, created_at: now, expires_at });
});

app.delete('/api/sites/:id/share-links/:token', async (c) => {
  await c.env.DB.prepare('DELETE FROM share_links WHERE token = ? AND site_id = ?')
    .bind(c.req.param('token'), c.get('site').id)
    .run();
  return c.json({ ok: true });
});

// Dodo payments that couldn't be placed on a site yet, grouped by product.
app.get('/api/sites/:id/pending-payments', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT product_id, COUNT(*) AS count, SUM(json_extract(payload, '$.amount')) AS amount, MAX(json_extract(payload, '$.currency')) AS currency
     FROM pending_payments WHERE site_id = ? GROUP BY product_id ORDER BY MAX(ts) DESC`,
  )
    .bind(c.get('site').id)
    .all();
  return c.json(r.results);
});
app.post('/api/sites/:id/pending-payments', async (c) => {
  const b = await c.req.json<{ product_id?: string }>().catch(() => ({}) as { product_id?: string });
  if (!b.product_id || !/^pdt_[\w-]+$/.test(b.product_id)) return c.json({ error: 'product_id is required' }, 400);
  await learnDodoProducts(c.env.DB, c.get('site'), [b.product_id]);
  return c.json({ ok: true });
});
app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

app.get('/api/sites/:id/funnels', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
});

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal') && typeof s.value === 'string' && s.value.trim())
    .slice(0, 10)
    .map((s) => ({ type: s.type, value: s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', async (c) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
});

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Static files are served before the Worker runs. What reaches here is a client-side route, or a page that doesn't exist.
const PUBLIC_PAGES = /^\/(terms|privacy|refund)\/?$/;
const APP_PAGES = /^\/(billing(\/.*)?|site\/[\w-]+(\/settings)?\/?|share\/[\w-]+\/?)$/;

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const index = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const headers = new Headers(index.headers);
  // Signed-in pages are private and unknown paths shouldn't rank: keep both out of search results.
  if (!PUBLIC_PAGES.test(path)) headers.set('X-Robots-Tag', 'noindex');
  const status = PUBLIC_PAGES.test(path) || APP_PAGES.test(path) ? 200 : 404;
  return new Response(index.body, { status, headers });
});

export default app;
