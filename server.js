'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
const NodeCache = require('node-cache');

const app = express();
const PROJECT_ID = process.env.BQ_PROJECT_ID || 'project-aa7ee149-5e29-4eb4-8bc';
const bq = new BigQuery({ projectId: PROJECT_ID });
const cache = new NodeCache({ stdTTL: 600 });

const PORT = process.env.PORT || 8080;
const USERS = { brad: 'brand', fixmart: 'fixmart' };

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fixmart-procurement-pl-2026',
  resave: true,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, secure: false, sameSite: 'lax' }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'session_expired' });
  res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login.html', (req, res) => res.redirect('/login'));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    req.session.regenerate(err => {
      if (err) return res.redirect('/login?error=1');
      req.session.user = username;
      req.session.save(err2 => { if (err2) return res.redirect('/login?error=1'); res.redirect('/'); });
    });
  } else { res.redirect('/login?error=1'); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

const DS  = `\`${PROJECT_ID}.fixmart_bi.vw_procurement_pl\``;
const RDS = `\`${PROJECT_ID}.fixmart_bi.vw_procurement_reforecast_actual\``;

app.get('/api/summary', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'missing dates' });
  const cacheKey = `s_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, fromCache: true });
  try {
    const [rows] = await bq.query({
      query: `SELECT period_date, ROUND(SUM(net_amount),2) AS total_cost FROM ${DS} WHERE period_date BETWEEN @startDate AND @endDate GROUP BY 1 ORDER BY 1`,
      params: { startDate, endDate }, location: 'europe-west2'
    });
    const data = rows.map(r => ({ period_date: r.period_date ? r.period_date.value || String(r.period_date) : '', total_cost: r.total_cost }));
    cache.set(cacheKey, data);
    res.json({ success: true, data, fromCache: false });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/lines', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'missing dates' });
  const cacheKey = `l_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, fromCache: true });
  try {
    const [rows] = await bq.query({
      query: `SELECT period_date, section, line_label, ROUND(SUM(net_amount),2) AS total FROM ${DS} WHERE period_date BETWEEN @startDate AND @endDate GROUP BY 1,2,3 ORDER BY 1,2,3`,
      params: { startDate, endDate }, location: 'europe-west2'
    });
    const data = rows.map(r => ({ period_date: r.period_date ? r.period_date.value || String(r.period_date) : '', section: r.section, line_label: r.line_label, total: r.total }));
    cache.set(cacheKey, data);
    res.json({ success: true, data, fromCache: false });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/reforecast', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'missing dates' });
  const cacheKey = `rf_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, fromCache: true });
  try {
    const [rows] = await bq.query({
      query: `SELECT period_date, cost_group, line_label, ROUND(actual_amount,2) AS actual, ROUND(reforecast_amount,2) AS reforecast, ROUND(variance_amount,2) AS variance, variance_pct FROM ${RDS} WHERE period_date BETWEEN @startDate AND @endDate AND supplier IS NULL ORDER BY period_date, cost_group, line_label`,
      params: { startDate, endDate }, location: 'europe-west2'
    });
    const data = rows.map(r => ({
      period_date: r.period_date ? r.period_date.value || String(r.period_date) : '',
      cost_group: r.cost_group, line_label: r.line_label,
      actual: r.actual, reforecast: r.reforecast,
      variance: r.variance, variance_pct: r.variance_pct
    }));
    cache.set(cacheKey, data);
    res.json({ success: true, data, fromCache: false });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/suppliers', requireAuth, async (req, res) => {
  const { startDate, endDate, lineLabel } = req.query;
  if (!startDate || !endDate || !lineLabel) return res.status(400).json({ success: false, error: 'missing params' });
  const cacheKey = `sup_${startDate}_${endDate}_${lineLabel}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, fromCache: true });
  try {
    const [actRows] = await bq.query({
      query: `SELECT period_date, source AS supplier, ROUND(SUM(net_amount),2) AS actual FROM ${DS} WHERE period_date BETWEEN @startDate AND @endDate AND line_label=@lineLabel GROUP BY 1,2 ORDER BY 1, SUM(net_amount)`,
      params: { startDate, endDate, lineLabel }, location: 'europe-west2'
    });
    const [rfRows] = await bq.query({
      query: `SELECT period_date, supplier, ROUND(actual_amount,2) AS actual, ROUND(reforecast_amount,2) AS reforecast, ROUND(variance_amount,2) AS variance FROM ${RDS} WHERE period_date BETWEEN @startDate AND @endDate AND line_label=@lineLabel AND supplier IS NOT NULL ORDER BY period_date, supplier`,
      params: { startDate, endDate, lineLabel }, location: 'europe-west2'
    });
    const rfMap = {};
    rfRows.forEach(r => {
      const key = (r.period_date ? r.period_date.value || String(r.period_date) : '') + '|' + r.supplier;
      rfMap[key] = { reforecast: r.reforecast, variance: r.variance };
    });
    const data = actRows.map(r => {
      const pd = r.period_date ? r.period_date.value || String(r.period_date) : '';
      const rf = rfMap[pd + '|' + (r.supplier || '')] || { reforecast: 0, variance: null };
      return { period_date: pd, supplier: r.supplier || 'Unknown', actual: r.actual, reforecast: rf.reforecast, variance: rf.variance };
    });
    rfRows.forEach(r => {
      const pd = r.period_date ? r.period_date.value || String(r.period_date) : '';
      const hasActual = data.some(d => d.period_date === pd && d.supplier === r.supplier);
      if (!hasActual && r.reforecast !== 0) {
        data.push({ period_date: pd, supplier: r.supplier, actual: 0, reforecast: r.reforecast, variance: r.variance });
      }
    });
    cache.set(cacheKey, data);
    res.json({ success: true, data, fromCache: false });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/detail', requireAuth, async (req, res) => {
  const { startDate, endDate, lineLabel, supplier } = req.query;
  if (!startDate || !endDate || !lineLabel) return res.status(400).json({ success: false, error: 'missing params' });
  const cacheKey = `d_${startDate}_${endDate}_${lineLabel}_${supplier || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, fromCache: true });
  try {
    const supplierFilter = supplier ? 'AND source=@supplier' : '';
    const params = supplier ? { startDate, endDate, lineLabel, supplier } : { startDate, endDate, lineLabel };
    const [rows] = await bq.query({
      query: `SELECT transaction_date, reference, description, nominal, source, ROUND(net_amount,2) AS net_amount FROM ${DS} WHERE period_date BETWEEN @startDate AND @endDate AND line_label=@lineLabel ${supplierFilter} ORDER BY transaction_date, net_amount`,
      params, location: 'europe-west2'
    });
    const data = rows.map(r => ({
      transaction_date: r.transaction_date ? r.transaction_date.value || String(r.transaction_date) : '',
      reference: r.reference || '', description: r.description || '',
      nominal: r.nominal, source: r.source, net_amount: r.net_amount
    }));
    cache.set(cacheKey, data);
    res.json({ success: true, data, fromCache: false });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/trend', requireAuth, async (req, res) => {
  const cacheKey = 'trend_full';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, fromCache: true });
  try {
    const [rows] = await bq.query({
      query: `SELECT period_date, section, ROUND(SUM(net_amount), 2) AS total FROM ${DS} WHERE period_date >= '2025-01-01' GROUP BY 1, 2 ORDER BY 1, 2`,
      location: 'europe-west2'
    });
    const data = rows.map(r => ({
      period_date: r.period_date ? r.period_date.value || String(r.period_date) : '',
      section: r.section, total: r.total
    }));
    cache.set(cacheKey, data);
    res.json({ success: true, data, fromCache: false });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/trends', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'trends.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Procurement P&L running on port ${PORT}`));
