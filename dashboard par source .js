const express = require('express');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── FIREBASE ─────────────────────────────────────────────────────────────────
const cred = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(cred) });
const db = admin.firestore();

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
const SHEET_ID = process.env.SHEET_ID;
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'alxagency2026';

// ─── SOURCE MAPPING ───────────────────────────────────────────────────────────
function normalizeSource(source) {
  if (!source) return 'inconnu';
  const s = source.toLowerCase().trim();
  if (s === 'tiktok ads' || s === 'tiktok-ads') return 'TikTok Ads';
  if (s === 'insta ads' || s === 'insta-ads' || s === 'instagram ads') return 'Insta Ads';
  if (s.startsWith('tiktok')) return 'TikTok';
  if (s.startsWith('insta')) return 'Instagram';
  if (s.startsWith('twitter')) return 'Twitter';
  if (s.startsWith('thread')) return 'Threads';
  return 'Autre';
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function checkAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token === PASSWORD) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// ─── API : DONNÉES ────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.json({ success: true, token: PASSWORD });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});

app.get('/api/data', checkAuth, async (req, res) => {
  try {
    const { month } = req.query;

    // ── Subs depuis Firebase ──
    const subsSnap = await db.collection('subscribers').get();
    const subs = subsSnap.docs.map(d => d.data());

    // ── Spenders depuis Google Sheets ──
    const sheets = google.sheets({ version: 'v4', auth: await sheetsAuth.getClient() });
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Feuille 1!A:I'
    });
    const rows = sheetRes.data.values || [];
    const spenders = rows.slice(1).filter(r => r[4] && r[4] !== 'inconnu' && r[5]);

    // ── Filtrage par mois ──
    const filterByMonth = (dateStr) => {
      if (!month || month === 'all') return true;
      return dateStr && dateStr.startsWith(month);
    };

    // ── Stats par source ──
    const sources = ['Instagram', 'TikTok', 'Twitter', 'Threads', 'TikTok Ads', 'Insta Ads', 'Autre'];
    const stats = {};
    sources.forEach(s => {
      stats[s] = { revenue: 0, spenders: new Set(), subs: 0 };
    });

    subs.forEach(sub => {
      if (!filterByMonth(sub.joined_at)) return;
      const src = normalizeSource(sub.source);
      if (stats[src]) stats[src].subs++;
    });

    spenders.forEach(row => {
      const date = row[0] || '';
      if (!filterByMonth(date)) return;
      const src = normalizeSource(row[3]);
      if (!stats[src]) return;
      const montantStr = (row[5] || '').replace(' EUR', '').replace(',', '.');
      const montant = parseFloat(montantStr) || 0;
      const totalStr = (row[8] || '').replace(',', '.');
      const total = parseFloat(totalStr) || montant;
      stats[src].revenue += montant;
      stats[src].spenders.add(row[4]);
    });

    const result = sources.map(src => {
      const s = stats[src];
      const spenderCount = s.spenders.size;
      const ltv = spenderCount > 0 ? (s.revenue / spenderCount).toFixed(2) : 0;
      const conversion = s.subs > 0 ? ((spenderCount / s.subs) * 100).toFixed(1) : 0;
      return {
        source: src,
        revenue: s.revenue.toFixed(2),
        spenders: spenderCount,
        subs: s.subs,
        ltv,
        conversion
      };
    }).filter(s => s.subs > 0 || s.spenders > 0 || s.revenue > 0);

    const totalRevenue = result.reduce((acc, s) => acc + parseFloat(s.revenue), 0).toFixed(2);
    const totalSpenders = result.reduce((acc, s) => acc + s.spenders, 0);
    const totalSubs = result.reduce((acc, s) => acc + s.subs, 0);

    res.json({ sources: result, totalRevenue, totalSpenders, totalSubs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── MOIS DISPONIBLES ─────────────────────────────────────────────────────────
app.get('/api/months', checkAuth, async (req, res) => {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await sheetsAuth.getClient() });
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Feuille 1!A:A'
    });
    const rows = sheetRes.data.values || [];
    const months = new Set();
    rows.slice(1).forEach(r => {
      if (r[0]) {
        const m = r[0].substring(0, 7);
        if (m) months.add(m);
      }
    });
    res.json({ months: Array.from(months).sort().reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Dashboard sur port ${PORT}`));
