// /api/sheets.js — Vercel serverless function
//
// Three modes:
//   GET /api/sheets                → discover all week tabs (names + GIDs)
//   GET /api/sheets?gid=XXXXX     → proxy CSV for that GID
//   GET /api/sheets?players=XXXXX → fetch player data WITH background colors for team detection
//
// The key insight: team assignment is determined by row background color in the sheet.
// CSV export loses colors, so we use the Sheets API v4 to read them.
// Public sheets don't need an API key.

const SHEET_ID = '1Gs9IzkezmssKoiCRNVbM78_xkIN5hXo8Fao3R3voJHo';
const PUB_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQxnfq6e_VLNn2t8SKm2CE8H-EIzLhstfs2fTPpcPZGkgMAc_5LvE2rV4R7hN5BybR42KvAu91o3Zx8';

// Team color mapping — background colors used in the sheet
// These map RGB values from the Sheets API to team names
// Red = Hognation, Blue = Fili Hustlers, Black/dark = Valley Vipers, Yellow = Torngat
const TEAM_COLORS = [
  { team: 'Hognation',     match: (r, g, b) => r > 0.6 && g < 0.4 && b < 0.4 },           // Red
  { team: 'Fili Hustlers', match: (r, g, b) => b > 0.6 && r < 0.4 && g < 0.5 },           // Blue
  { team: 'Torngat',       match: (r, g, b) => r > 0.6 && g > 0.6 && b < 0.4 },           // Yellow
  { team: 'Valley Vipers', match: (r, g, b) => r < 0.3 && g < 0.3 && b < 0.3 },           // Black/dark
];

function detectTeam(bgColor) {
  if (!bgColor) return 'Unknown';
  const r = bgColor.red   || 0;
  const g = bgColor.green || 0;
  const b = bgColor.blue  || 0;

  for (const tc of TEAM_COLORS) {
    if (tc.match(r, g, b)) return tc.team;
  }
  return 'Unknown';
}

// Hardcoded fallback
const FALLBACK_WEEKS = [
  { name: 'GBB Week 1 - Sat, March 14th 2026 Player Stats', weekNumber: 1, gid: '1513965140', date: { day: 14, month: 'Mar' } },
  { name: 'GBB Week 2 - Sat, March 21st 2026 Player Stats', weekNumber: 2, gid: '40864786',   date: { day: 21, month: 'Mar' } },
  { name: 'GBB Week 3 - Sat, March 28th 2026 Player Stats', weekNumber: 3, gid: '587090763',  date: { day: 28, month: 'Mar' } },
  { name: 'GBB Week 4 - Sat, April 4th 2026 Player Stats',  weekNumber: 4, gid: '1644843033', date: { day:  4, month: 'Apr' } },
  { name: 'GBB Week 5 - Sat, April 11th 2026 Player Stats', weekNumber: 5, gid: '1402349068', date: { day: 11, month: 'Apr' } },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { gid, players } = req.query;

  // ─── Mode 3: Fetch player data with team colors ───
  if (players) {
    try {
      // First, find the sheet name for this GID
      const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets(properties(sheetId,title))`;
      const metaResp = await fetch(metaUrl);
      let sheetName = null;

      if (metaResp.ok) {
        const metaData = await metaResp.json();
        const sheet = metaData.sheets?.find(s => String(s.properties.sheetId) === players);
        if (sheet) sheetName = sheet.properties.title;
      }

      if (!sheetName) {
        return res.status(404).json({ success: false, error: `Sheet with GID ${players} not found` });
      }

      // Fetch cell data + formatting for columns A-G (player name, PTS, Fouls, FTA, _, _, Played)
      // Using includeGridData to get background colors
      const encodedName = encodeURIComponent(sheetName);
      const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?ranges='${encodedName}'!A1:G70&fields=sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor)))))`;
      const dataResp = await fetch(dataUrl);

      if (!dataResp.ok) {
        const errText = await dataResp.text();
        return res.status(500).json({ success: false, error: `Sheets API error: ${dataResp.status}`, detail: errText });
      }

      const data = await dataResp.json();
      const rowData = data.sheets?.[0]?.data?.[0]?.rowData || [];

      // Parse the headline row (contains game scores)
      let headline = '';
      const parsedPlayers = [];

      for (let i = 0; i < rowData.length; i++) {
        const row = rowData[i];
        if (!row.values || !row.values[0]) continue;

        const cellA = row.values[0].formattedValue || '';
        const bgColor = row.values[0].effectiveFormat?.backgroundColor;

        // Check if this is the game headline row
        if (/week\s*\d/i.test(cellA) && /\bvs\b/i.test(cellA)) {
          headline = cellA;
          continue;
        }

        // Skip non-player rows (headers, team labels, title, blanks)
        if (!cellA.trim()) continue;
        if (/^players?\s*stats?$/i.test(cellA)) continue;
        if (/^(black|red|blue|yellow)\s*-/i.test(cellA)) continue;
        if (/goose\s*bay\s*basketball/i.test(cellA)) continue;
        if (/^(PTS|Fouls|FTA|Played)$/i.test(cellA)) continue;

        // Detect team from background color
        const team = detectTeam(bgColor);
        if (team === 'Unknown') continue; // Skip rows without team coloring

        // Parse player name and jersey number
        const cleanCell = cellA.replace(/^#N\/A\s*/i, '');
        const numMatch = cleanCell.match(/^#?(\d+)\s+(.+)/);
        const num = numMatch ? numMatch[1] : '';
        const name = (numMatch ? numMatch[2] : cleanCell.replace(/^#/, '')).trim();

        if (!name) continue;

        // Parse stats from other columns
        const pts   = row.values[1]?.formattedValue || '';
        const fouls = row.values[2]?.formattedValue || '';
        const gp    = row.values[6]?.formattedValue || '';  // Column G = "Played"

        const isDNP = /dnp/i.test(gp) || /dnp/i.test(pts);

        parsedPlayers.push({
          name,
          num,
          team,
          pts:   parseInt(pts) || 0,
          fouls: parseInt(fouls) || 0,
          gp:    isDNP ? 0 : (parseInt(gp) || 0),
          dnp:   isDNP,
        });
      }

      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=30');
      return res.status(200).json({
        success: true,
        headline,
        players: parsedPlayers,
        count: parsedPlayers.length,
      });
    } catch (e) {
      console.error('Player fetch error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

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

  // Deduplicate
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
