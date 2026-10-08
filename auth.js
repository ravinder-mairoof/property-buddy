import express from 'express';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import Stripe from 'stripe';

const SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const PROD = process.env.NODE_ENV === 'production';
if (PROD && SECRET === 'dev-only-change-me') throw new Error('Set SESSION_SECRET in production');
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const db = new Database(process.env.DB_PATH || 'propertybuddy.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'basic', stripe_customer TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

// ---- passwords (scrypt) and signed session cookie (HMAC) ----
const hashPw = (p) => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const checkPw = (p, stored) => {
  const [s, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(p, Buffer.from(s, 'hex'), 64));
};
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const setSession = (res, id) => {
  const v = `${id}.${Date.now() + 14 * 864e5}`;
  res.cookie('pb_session', `${v}.${sign(v)}`, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 14 * 864e5 });
};
const readCookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
export function getUser(req) {
  const raw = readCookie(req, 'pb_session'); if (!raw) return null;
  const [id, exp, sig] = raw.split('.');
  const good = sig && crypto.timingSafeEqual(Buffer.from(sign(`${id}.${exp}`)), Buffer.from(sig.padEnd(43, ' ').slice(0, 43)));
  if (!good || Number(exp) < Date.now()) return null;
  return db.prepare('SELECT id, email, name, tier, stripe_customer FROM users WHERE id = ?').get(Number(id)) || null;
}
export const userTier = (req) => getUser(req)?.tier || 'basic';
const pub = (u) => u && { name: u.name, email: u.email, tier: u.tier };
const setTier = (where, val, tier, cust) =>
  db.prepare(`UPDATE users SET tier = ?, stripe_customer = COALESCE(?, stripe_customer) WHERE ${where} = ?`).run(tier, cust || null, val);

export const authRouter = express.Router();

// Stripe webhook: needs the raw body, so it is mounted before express.json()
authRouter.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.sendStatus(404);
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.sendStatus(400); }
  const o = ev.data.object;
  if (ev.type === 'checkout.session.completed' && o.client_reference_id) setTier('id', Number(o.client_reference_id), 'subscribed', o.customer);
  if (ev.type === 'customer.subscription.updated') setTier('stripe_customer', o.customer, ['active', 'trialing'].includes(o.status) ? 'subscribed' : 'basic');
  if (ev.type === 'customer.subscription.deleted') setTier('stripe_customer', o.customer, 'basic');
  res.sendStatus(200);
});

authRouter.use(express.json());
const need = (req, res) => { const u = getUser(req); if (!u) res.status(401).json({ error: 'Sign in first.' }); return u; };

authRouter.get('/api/me', (req, res) => res.json({ user: pub(getUser(req)), billing: !!stripe }));

authRouter.post('/api/auth/register', (req, res) => {
  const { name = '', email = '', password = '' } = req.body || {};
  const e = email.trim().toLowerCase();
  if (!name.trim() || !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Enter your name and a valid email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, pw) VALUES (?, ?, ?)').run(e, name.trim(), hashPw(password));
    setSession(res, lastInsertRowid);
    res.json({ user: pub(getUser({ headers: { cookie: '' } }) || { name: name.trim(), email: e, tier: 'basic' }) });
  } catch { res.status(409).json({ error: 'An account with that email already exists.' }); }
});

authRouter.post('/api/auth/login', (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!u || !checkPw(password, u.pw)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  setSession(res, u.id);
  res.json({ user: pub(u) });
});

authRouter.post('/api/auth/logout', (req, res) => { res.clearCookie('pb_session'); res.json({ ok: true }); });

authRouter.post('/api/billing/checkout', async (req, res) => {
  const u = need(req, res); if (!u) return;
  if (!stripe) return res.status(501).json({ error: 'Billing is not configured on this server.' });
  try {
    const s = await stripe.checkout.sessions.create({
      mode: 'subscription', line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: String(u.id), ...(u.stripe_customer ? { customer: u.stripe_customer } : { customer_email: u.email }),
      success_url: `${APP_URL}/?upgraded=1`, cancel_url: APP_URL,
    });
    res.json({ url: s.url });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

authRouter.post('/api/billing/portal', async (req, res) => {
  const u = need(req, res); if (!u) return;
  if (!stripe || !u.stripe_customer) return res.status(400).json({ error: 'No active subscription to manage.' });
  try { res.json({ url: (await stripe.billingPortal.sessions.create({ customer: u.stripe_customer, return_url: APP_URL })).url }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Local testing only: flip tier without Stripe. Disabled in production or when Stripe is configured.
authRouter.post('/api/dev/tier', (req, res) => {
  const u = need(req, res); if (!u) return;
  if (PROD || stripe) return res.sendStatus(404);
  setTier('id', u.id, req.body?.tier === 'subscribed' ? 'subscribed' : 'basic');
  res.json({ ok: true });
});
