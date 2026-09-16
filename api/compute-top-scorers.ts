import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setJSON } from './_lib/store.js';
import { teams } from '../src/data/teams.js';

const START_SEASON = 2018;
const TOP_SCORERS_KEY = 'ftfl:top-scorers';
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

export interface TopScorer {
  position: string;
  playerName: string;
  totalPoints: number;
}

export interface TeamTopScorers {
  teamSlug: string;
  scorers: TopScorer[]; // one entry per position, the career-total leader for that team
}

export interface TopScorersResult {
  computedAtEpochMilli: number;
  seasonsCovered: { from: number; to: number };
  teams: TeamTopScorers[];
}

/**
 * ONE-TIME, HEAVY — top scorer at each position (QB/RB/WR/TE), by career
 * total points while rostered on that specific team, across every season
 * 2018-present. This is the piece deliberately deferred when league
 * history first shipped, because it needs a fundamentally bigger pull:
 * every game's boxscore, every week, every season (~700+ requests), not
 * just standings/scoreboard.
 *
 * CONFIRMED against a real boxscore response before being built: same
 * `groups`/`slots`/`leaguePlayer.proPlayer` shape already confirmed for
 * FetchRoster (same underlying RosterSlot type, reused here) — both
 * starting lineup AND bench groups are present, which matters, since a
 * career total needs every point scored regardless of whether that
 * player started that particular week.
 *
 * Attribution is per-week, not per-current-roster: a player traded
 * mid-season only contributes to the team that rostered them the week
 * they scored those points, using whichever side (away/home) of that
 * specific boxscore they appeared on.
 *
 * Independently re-fetches every season's scoreboard to find real game
 * ids (same discovery method as compute-league-history.ts) — it does
 * NOT depend on league history having been computed first, and doesn't
 * read anything from that cache. Separate endpoint, separate cache key,
 * runs entirely on its own.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) {
    return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  }

  const throughSeason = Number(req.query.through) || new Date().getFullYear();
  const seasons: number[] = [];
  for (let y = START_SEASON; y <= throughSeason; y++) seasons.push(y);

  const knownIds = new Set(teams.map((t) => t.fleaflickerId));

  // teamId -> position -> playerName -> total points
  const totals = new Map(teams.map((t) => [t.fleaflickerId, new Map(POSITIONS.map((p) => [p, new Map<string, number>()]))]));

  function addPoints(teamId: number, position: string, playerName: string, points: number) {
    if (!knownIds.has(teamId) || !POSITIONS.includes(position) || !points) return;
    const byPos = totals.get(teamId)!;
    const byName = byPos.get(position)!;
    byName.set(playerName, (byName.get(playerName) ?? 0) + points);
  }

  function processSide(teamId: number, side: any) {
    const groups: any[] = side?.groups ?? [];
    for (const g of groups) {
      const slots: any[] = g?.slots ?? [];
      for (const slot of slots) {
        const player = slot?.leaguePlayer?.proPlayer;
        if (!player?.nameFull) continue;
        const position: string = player.position ?? slot?.position?.label ?? '';
        const points: number = slot?.leaguePlayer?.viewingActualPoints?.value ?? slot?.leaguePlayer?.points?.value ?? 0;
        addPoints(teamId, position, player.nameFull, points);
      }
    }
  }

  try {
    for (const season of seasons) {
      // discover this season's real week range the same way compute-league-history.ts does
      const firstWeekRes = await fetch(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=1`);
      if (!firstWeekRes.ok) throw new Error(`Scoreboard discovery failed for season ${season} (HTTP ${firstWeekRes.status})`);
      const firstWeekData: any = await firstWeekRes.json();
      const eligiblePeriods: number[] = (firstWeekData?.eligibleSchedulePeriods ?? []).map((p: any) => p.ordinal).filter((n: any) => typeof n === 'number');
      const maxWeek = eligiblePeriods.length > 0 ? Math.max(...eligiblePeriods) : 1;

      const weekResults = await Promise.all(
        Array.from({ length: maxWeek }, (_, i) => i + 1).map(async (week) => {
          if (week === 1) return firstWeekData;
          const r = await fetch(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=${week}`);
          if (!r.ok) throw new Error(`Scoreboard failed for season ${season} week ${week} (HTTP ${r.status})`);
          return r.json();
        })
      );

      // collect every real game id + week for this season, then fetch every boxscore
      // (parallel within the season, same concurrency posture as compute-league-history.ts)
      const gameRefs: { gameId: string; week: number }[] = [];
      for (let i = 0; i < weekResults.length; i++) {
        const games: any[] = weekResults[i]?.games ?? [];
        for (const g of games) {
          if (g?.id && knownIds.has(g?.away?.id) && knownIds.has(g?.home?.id)) {
            gameRefs.push({ gameId: String(g.id), week: i + 1 });
          }
        }
      }

      const boxscores = await Promise.all(
        gameRefs.map(async ({ gameId, week }) => {
          const r = await fetch(`https://www.fleaflicker.com/api/FetchLeagueBoxscore?sport=NFL&league_id=${leagueId}&fantasy_game_id=${gameId}&scoring_period=${week}`);
          if (!r.ok) throw new Error(`Boxscore failed for game ${gameId} (season ${season}, week ${week}, HTTP ${r.status})`);
          return r.json();
        })
      );

      for (const box of boxscores) {
        // CONFIRMED against a real response: team identity lives at
        // box.game.away.id / box.game.home.id — the SAME naming
        // convention already confirmed on FetchLeagueScoreboard's game
        // objects (away/home, not awayTeam/homeTeam or a nested .team.id,
        // which is what an earlier version of this code wrongly guessed,
        // and why every boxscore silently produced zero points).
        const awayId = box?.game?.away?.id;
        const homeId = box?.game?.home?.id;
        if (awayId) processSide(awayId, box?.away);
        if (homeId) processSide(homeId, box?.home);
      }
    }

    const teamTopScorers: TeamTopScorers[] = teams.map((t) => {
      const byPos = totals.get(t.fleaflickerId)!;
      const scorers: TopScorer[] = POSITIONS.map((position) => {
        const byName = byPos.get(position)!;
        let best: { playerName: string; totalPoints: number } | null = null;
        for (const [playerName, totalPoints] of byName) {
          if (!best || totalPoints > best.totalPoints) best = { playerName, totalPoints };
        }
        return { position, playerName: best?.playerName ?? '—', totalPoints: best?.totalPoints ?? 0 };
      });
      return { teamSlug: t.slug, scorers };
    });

    const result: TopScorersResult = {
      computedAtEpochMilli: Date.now(),
      seasonsCovered: { from: START_SEASON, to: throughSeason },
      teams: teamTopScorers,
    };

    await setJSON(TOP_SCORERS_KEY, result);

    return res.status(200).json({ ok: true, message: `Computed top scorers for ${seasons.length} seasons.`, teamCount: teamTopScorers.length });
  } catch (err: any) {
    return res.status(502).json({ error: `Top scorers computation failed partway through: ${err?.message}. Nothing was saved — the old cached result (if any) is untouched.` });
  }
}
