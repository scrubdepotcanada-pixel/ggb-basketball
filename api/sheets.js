// /api/sheets.js — Vercel serverless function
//
// Two modes:
//   GET /api/sheets           → returns list of all week tab names (auto-discovery)
//   GET /api/sheets?week=GBB Week 1... → proxies CSV data for that tab
//
// Discovery: Downloads published sheet as XLSX, parses workbook.xml for sheet names.
// CSV proxy: Fetches CSV by sheet name — no GID needed.
//
// Tab naming convention in the sheet:
//   "GBB Week 1 - Sat, March 14th 2026 Player Stats"
//   "GBB Week 2 - Sat, March 21st 2026 Player Stats"
//   etc.
// We match any tab containing "GBB" and "Week" (case-insensitive).

const PUB_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQxnfq6e_VLNn2t8SKm2CE8H-EIzLhstfs2fTPpcPZGkgMAc_5LvE2rV4R7hN5BybR42KvAu91o3Zx8';
const SHEET_ID = '1Gs9IzkezmssKoiCRNVbM78_xkIN5hXo8Fao3R3voJHo';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { week } = req.query;

  // ─── Mode 2: Proxy CSV for a specific week tab ───
  if (week) {
    try {
      // Try by sheet name first (works with the published 2PACX URL)
      const csvUrl = `${PUB_BASE}/pub?single=true&output=csv&sheet=${encodeURIComponent(week)}`;
      const csvResp = await fetch(csvUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
        redirect: 'follow',
      });

      if (!csvResp.ok) {
        return res.status(404).json({ success: false, error: `Tab "${week}" not found` });
      }

      const csvText = await csvResp.text();

      // Validate it's CSV, not an error page
      if (csvText.startsWith('<!DOCTYPE') || csvText.startsWith('<html')) {
        return res.status(404).json({ success: false, error: `Tab "${week}" returned HTML — may not be published` });
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

  // Strategy A: Download as XLSX and parse workbook.xml for sheet names
  try {
    const xlsxUrl = `${PUB_BASE}/pub?output=xlsx`;
    const xlsxResp = await fetch(xlsxUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
      redirect: 'follow',
    });

    if (xlsxResp.ok) {
      const buffer = await xlsxResp.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      // XLSX is a ZIP — workbook.xml contains <sheet name="..." .../>
      const sheetRegex = /<sheet\s[^>]*name="([^"]+)"/g;
      let match;
      while ((match = sheetRegex.exec(text)) !== null) {
        const name = match[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'");
        tabs.push(name);
      }

      if (tabs.length > 0) source = 'xlsx';
    }
  } catch (e) {
    console.error('XLSX discovery failed:', e.message);
  }

  // Strategy B: Try pubhtml parsing as fallback
  if (tabs.length === 0) {
    try {
      const pubUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/pubhtml`;
      const pubResp = await fetch(pubUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
        redirect: 'follow',
      });
      const html = await pubResp.text();

      const patterns = [
        /id="sheet-button-\d+"[\s\S]*?<a[^>]*>([^<]+)<\/a>/g,
        /data-name="([^"]+)"/g,
      ];

      for (const regex of patterns) {
        let m;
        while ((m = regex.exec(html)) !== null) {
          const name = (m[1] || '').trim();
          if (name && !tabs.includes(name)) tabs.push(name);
        }
        if (tabs.length > 0) break;
      }

      if (tabs.length > 0) source = 'pubhtml';
    } catch (e2) {
      console.error('pubhtml fallback failed:', e2.message);
    }
  }

  // Filter to week tabs: match anything with "GBB" + "Week" or just "Week \d"
  const weekTabs = tabs
    .filter(name => /week\s*\d+/i.test(name))
    .map(name => {
      const weekNum = parseInt(name.match(/week\s*(\d+)/i)?.[1] || '0');

      // Extract date from tab name like "GBB Week 1 - Sat, March 14th 2026 Player Stats"
      const dateMatch = name.match(/(\w+)\s+(\d+)(?:st|nd|rd|th)?\s+(\d{4})/i);
      let date = null;
      if (dateMatch) {
        date = {
          day: parseInt(dateMatch[2]),
          month: dateMatch[1].substring(0, 3),
        };
      }

      return { name, weekNumber: weekNum, date };
    })
    .sort((a, b) => a.weekNumber - b.weekNumber);

  // Deduplicate by week number
  const seen = new Set();
  const deduped = weekTabs.filter(t => {
    if (seen.has(t.weekNumber)) return false;
    seen.add(t.weekNumber);
    return true;
  });

  // Final fallback if nothing found
  if (deduped.length === 0) {
    source = 'fallback';
    return res.status(200).json({
      success: true,
      source,
      weeks: [
        { name: 'GBB Week 1 - Sat, March 14th 2026 Player Stats', weekNumber: 1, date: { day: 14, month: 'Mar' } },
        { name: 'GBB Week 2 - Sat, March 21st 2026 Player Stats', weekNumber: 2, date: { day: 21, month: 'Mar' } },
        { name: 'GBB Week 3 - Sat, March 28th 2026 Player Stats', weekNumber: 3, date: { day: 28, month: 'Mar' } },
        { name: 'GBB Week 4 - Sat, April 4th 2026 Player Stats',  weekNumber: 4, date: { day:  4, month: 'Apr' } },
      ],
      allSheets: [],
      count: 4,
      fetchedAt: new Date().toISOString(),
      note: 'Auto-discovery failed — using hardcoded fallback.',
    });
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json({
    success: true,
    source,
    weeks: deduped,
    allSheets: tabs,
    count: deduped.length,
    fetchedAt: new Date().toISOString(),
  });
}
