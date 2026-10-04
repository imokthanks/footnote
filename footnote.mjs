// Daily football match reminders: football-data.org -> ntfy.
//
// Runs once a day at ~07:00 IST. Looks at the 48h window starting today 07:00 IST,
// split into "Today" (next 24h) and "Tomorrow" (the 24h after), so every match
// gets exactly two reminders without storing any state.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// --- Config (football-data.org team IDs) ------------------------------------

const ANY_MATCH_TEAMS = { 81: "Barcelona" };
const COMB_OF_MATCH_TEAMS = [
  [[66, "Manchester United"], [65, "Manchester City"]],
  [[66, "Manchester United"], [64, "Liverpool"]],
];

const TZ_NAME = "Asia/Kolkata";
const TZ_OFFSET_MS = 5.5 * 3600 * 1000; // IST has no DST, so a fixed offset is safe
const WINDOW_ANCHOR_HOUR = 7; // windows start at 07:00 local, regardless of actual run time
const API_BASE = "https://api.football-data.org/v4";
const SKIP_STATUSES = new Set(["POSTPONED", "CANCELLED", "SUSPENDED", "AWARDED"]);
const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------

export function teamsToQuery() {
  // Smallest-ish set of team IDs whose matches cover every rule.
  const queried = new Set(Object.keys(ANY_MATCH_TEAMS).map(Number));
  const counts = {};
  for (const pair of COMB_OF_MATCH_TEAMS) for (const [id] of pair) counts[id] = (counts[id] ?? 0) + 1;
  for (const [[a], [b]] of COMB_OF_MATCH_TEAMS) {
    if (queried.has(a) || queried.has(b)) continue;
    queried.add(counts[a] >= counts[b] ? a : b);
  }
  return [...queried].sort((x, y) => x - y);
}

function isWanted(match) {
  const home = match.homeTeam.id;
  const away = match.awayTeam.id;
  if (home in ANY_MATCH_TEAMS || away in ANY_MATCH_TEAMS) return true;
  return COMB_OF_MATCH_TEAMS.some(([[a], [b]]) => (home === a && away === b) || (home === b && away === a));
}

// Local (IST) calendar date of an instant, as {y, m, d} with m 0-based.
function localDate(ms) {
  const shifted = new Date(ms + TZ_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function isoDate({ y, m, d }) {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

async function fetchMatches(apiKey, teamId, start, end) {
  if (process.env.FIXTURES_FILE) {
    // Debug: use a saved /teams/{id}/matches response instead of calling the API.
    const body = JSON.parse(await readFile(process.env.FIXTURES_FILE, "utf8"));
    return { matches: body.matches, remaining: "n/a (FIXTURES_FILE)" };
  }
  // Dates filter on the UTC date; IST dates today..today+2 cover the whole 07:00 IST-anchored window.
  const params = new URLSearchParams({ dateFrom: isoDate(start), dateTo: isoDate(end) });
  const resp = await fetch(`${API_BASE}/teams/${teamId}/matches?${params}`, {
    headers: { "X-Auth-Token": apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  const remaining = resp.headers.get("x-requests-available-minute");
  const body = await resp.json().catch(() => ({}));
  console.log(`  team ${teamId}: HTTP ${resp.status}, ${body.matches?.length ?? 0} matches, ${remaining} requests left this minute`);
  // Bad keys, restricted competitions and rate limits come back as 4xx with {message, errorCode}.
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for team ${teamId}: ${body.message ?? "no message"}`);
  return { matches: body.matches, remaining };
}

const kickoffFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ_NAME,
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatLine(match, label) {
  let when = kickoffFormat.format(Date.parse(match.utcDate)).replace(" at", ",");
  // TIMED = kick-off time confirmed; SCHEDULED = date known, time may still change.
  if (match.status === "SCHEDULED") when += " (time unconfirmed)";
  return `${label} ${when} - ${match.homeTeam.name} vs ${match.awayTeam.name} (${match.competition.name})`;
}

export function buildMessage(matches, nowMs) {
  const { y, m, d } = localDate(nowMs);
  const todayStart = Date.UTC(y, m, d, WINDOW_ANCHOR_HOUR) - TZ_OFFSET_MS;
  const tomorrowStart = todayStart + DAY_MS;
  const windowEnd = todayStart + 2 * DAY_MS;

  const lines = [];
  for (const match of [...matches].sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate))) {
    if (SKIP_STATUSES.has(match.status) || !isWanted(match)) continue;
    const kickoff = Date.parse(match.utcDate);
    if (kickoff >= todayStart && kickoff < tomorrowStart) lines.push(formatLine(match, "⚽ Today:"));
    else if (kickoff >= tomorrowStart && kickoff < windowEnd) lines.push(formatLine(match, "📅 Tomorrow:"));
  }
  return lines.join("\n");
}

async function notify(topic, message, title, priority = "default") {
  if (process.env.DRY_RUN) {
    console.log(`[dry run] ${title}\n${message}`);
    return;
  }
  const resp = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    body: message,
    headers: { Title: title, Priority: priority },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`ntfy HTTP ${resp.status}`);
}

async function main() {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error("NTFY_TOPIC is not set");
  try {
    const apiKey = process.env.FOOTBALL_DATA_KEY;
    if (!apiKey && !process.env.FIXTURES_FILE) throw new Error("FOOTBALL_DATA_KEY is not set");
    // Debug: NOW="2026-10-07T07:00:00+05:30" pretends the run happens at that time.
    const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
    if (Number.isNaN(now)) throw new Error(`Invalid NOW: ${process.env.NOW}`);
    const start = localDate(now);
    const end = addDays(start, 2);
    console.log(`footnote run at ${new Date(now).toISOString()} (${kickoffFormat.format(now)} IST)`);
    console.log(`Fetching ${isoDate(start)} to ${isoDate(end)} for teams ${teamsToQuery().join(", ")}`);

    const byId = new Map();
    let remaining = null;
    for (const teamId of teamsToQuery()) {
      const result = await fetchMatches(apiKey, teamId, start, end);
      remaining = result.remaining;
      for (const match of result.matches) byId.set(match.id, match); // dedupe e.g. Barcelona vs Man United
    }
    for (const match of byId.values()) {
      console.log(`  ${match.utcDate} ${match.status} ${match.homeTeam.name} vs ${match.awayTeam.name}`);
    }

    const message = buildMessage(byId.values(), now);
    if (message) {
      console.log(`Sending notification:\n${message}`);
      await notify(topic, message, "Upcoming matches");
      console.log("Notification sent");
    } else {
      console.log(`No matches in window. Requests left this minute: ${remaining}`);
    }
  } catch (e) {
    console.error(`footnote failed: ${e.stack}`);
    // No retries: a bad key or plan restriction won't fix itself.
    await notify(topic, `${e.name}: ${e.message}`, "footnote failed", "high");
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(1));
}
