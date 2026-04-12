// /api/sheets.js — Vercel serverless function
//
// Two modes:
//   GET /api/sheets            → discover all week tabs (names + GIDs)
//   GET /api/sheets?gid=XXXXX  → proxy CSV for that GID (bypasses CORS)
//
// Discovery uses Google Sheets API v4 (free, no key needed for public sheets).
// The sheet must be shared as "Anyone with the link can view".

const SHEET_ID = '1Gs9IzkezmssKoiCRNVbM78_xkIN5hXo8Fao3R3voJHo';
const PUB_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQxnfq6e_VLNn2t8SKm2CE8H-EIzLhstfs2fTPpcPZGkgMAc_5LvE2rV4R7hN5BybR42KvAu91o3Zx8';

// Hardcoded fallback — site never breaks
const FALLBACK_WEEKS = [
  { name: 'Week 1', weekNumber: 1, gid: '1513965140', date: { day: 14, month: 'Mar' } },
  { name: 'Week 2', weekNumber: 2, gid: '40864786',   date: { day: 21, month: 'Mar' } },
  { name: 'Week 3', weekNumber: 3, gid: '587090763',  date: { day: 28, month: 'Mar' } },
  { name: 'Week 4', weekNumber: 4, gid: '1644843033', date: { day:  4, month: 'Apr' } },
  { name: 'Week 5', weekNumber: 5, gid: '1402349068', date: { day: 11, month: 'Apr' } },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { gid } = req.query;

  // ─── Mode 2: Proxy CSV for a specific GID ───
  if (gid) {
    try {
      const csvUrl = `${PUB_BASE}/pub?single=true&output=csv&gid=${gid}`;
      const csvResp = await fetch(csvUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
        redirect: 'follow',
      });

      if (!csvResp.ok) {
        return res.status(404).json({ success: false, error: `GID ${gid} fetch failed: ${csvResp.status}` });
      }

      const csvText = await csvResp.text();

      if (csvText.startsWith('<!DOCTYPE') || csvText.startsWith('<html')) {
        return res.status(404).json({ success: false, error: `GID ${gid} returned HTML` });
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=30');
      return res.status(200).send(csvText);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ─── Mode 1: Discover all week tabs ───
  let tabs = [];
  let source = 'unknown';

  // Strategy A: Google Sheets API v4
  try {
    const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets(properties(sheetId,title))`;
    const apiResp = await fetch(apiUrl);

    if (apiResp.ok) {
      const data = await apiResp.json();
      if (data.sheets && data.sheets.length > 0) {
        tabs = data.sheets.map(s => ({
          name: s.properties.title,
          gid: String(s.properties.sheetId),
        }));
        source = 'sheets-api';
      }
    }
  } catch (e) {
    console.error('Sheets API failed:', e.message);
  }

  // Strategy B: Try fetching the published HTML page for tab info
  if (tabs.length === 0) {
    try {
      const pubUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/pubhtml`;
      const pubResp = await fetch(pubUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
        redirect: 'follow',
      });
      const html = await pubResp.text();

      const patterns = [
        /id="sheet-button-(\d+)"[\s\S]*?<a[^>]*>([^<]+)<\/a>/g,
        /data-name="([^"]+)"[^>]*data-gid="(\d+)"/g,
      ];

      for (const regex of patterns) {
        let m;
        while ((m = regex.exec(html)) !== null) {
          const isNameFirst = regex.source.startsWith('data-name');
          const gid = isNameFirst ? m[2] : m[1];
          const name = (isNameFirst ? m[1] : m[2]).trim();
          if (name && !tabs.some(t => t.gid === gid)) {
            tabs.push({ name, gid });
          }
        }
        if (tabs.length > 0) { source = 'pubhtml'; break; }
      }
    } catch (e) {
      console.error('pubhtml failed:', e.message);
    }
  }

  // Filter to week tabs
  const weekTabs = tabs
    .filter(t => /week\s*\d+/i.test(t.name))
    .map(t => {
      const weekNum = parseInt(t.name.match(/week\s*(\d+)/i)?.[1] || '0');
      const dateMatch = t.name.match(/(\w+)\s+(\d+)(?:st|nd|rd|th)/i);
      return {
        name: t.name,
        weekNumber: weekNum,
        gid: t.gid,
        date: dateMatch ? { day: parseInt(dateMatch[2]), month: dateMatch[1].substring(0, 3) } : null,
      };
    })
    .sort((a, b) => a.weekNumber - b.weekNumber);

  const seen = new Set();
  const deduped = weekTabs.filter(t => {
    if (seen.has(t.weekNumber)) return false;
    seen.add(t.weekNumber);
    return true;
  });

  if (deduped.length > 0) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      success: true,
      source,
      weeks: deduped,
      allSheets: tabs.map(t => t.name),
      count: deduped.length,
      fetchedAt: new Date().toISOString(),
    });
  }

  // Fallback
  res.setHeader('Cache-Control', 's-maxage=60');
  return res.status(200).json({
    success: true,
    source: 'fallback',
    weeks: FALLBACK_WEEKS,
    allSheets: [],
    count: FALLBACK_WEEKS.length,
    fetchedAt: new Date().toISOString(),
    note: 'Auto-discovery failed — using hardcoded fallback.',
  });
}
