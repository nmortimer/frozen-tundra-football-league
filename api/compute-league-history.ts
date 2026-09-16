import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setJSON } from './_lib/store.js';
import { teams } from '../src/data/teams.js';
import type { LeagueHistory, TeamHistory, PostseasonFinish, HeadToHead } from '../src/lib/leagueHistory';

const START_SEASON = 2018; // confirmed: the league's real first season on Fleaflicker
const HISTORY_KEY = 'ftfl:league-history';

/**
 * ONE-TIME (well, "run occasionally") heavy computation — builds full
 * league history (all-time record, head-to-head vs every team,
 * championship/placement history, last-place finishes) from Fleaflicker's
 * own data across every season 2018-present, and caches the result in
 * Redis. The team pages just read the cached result (api/league-history.ts)
 * — this endpoint is only ever run manually, by visiting it (GET), same
 * pattern as the other one-time endpoints in this project.
 *
 * CONFIRMED against a real response before being built: FetchLeagueScoreboard
 * games carry real `isChampionshipGame` / `isThirdPlaceGame` booleans (not
 * inferred) — verified against 2018's actual championship (Grand Rapids
 * Growlers over Standale Stampede) and third-place game (Jenison
 * Juggernauts over Boulder Bandits). Franchise identity is tracked by
 * `fleaflickerId`, never by name — team names change across seasons
 * (Growlers -> Denver Diamondbacks, Juggernauts -> Olde Town Osos, etc.)
 * but the id is permanent, exactly like the rest of this project treats it.
 *
 * "Last place" per season is NOT taken from any consolation-bracket flag
 * (no such field has been confirmed) — it's simply whichever team had the
 * worst regular-season record that year (tiebreak: lowest points for),
 * read directly from standings. Reliable and needs no untested field.
 *
 * Fetches one season at a time (parallel across that season's weeks, but
 * seasons themselves run sequentially) rather than firing every request
 * for every season at once — this is ~150+ external requests in total;
 * capping concurrency to one season's worth at a time is a deliberate
 * safety margin against rate limits and serverless timeouts, at some
 * cost to total wall-clock time. This endpoint can take a while to run.
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
  const idToSlug = new Map(teams.map((t) => [t.fleaflickerId, t.slug]));

  const allTime = new Map(teams.map((t) => [t.fleaflickerId, { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]));
  const h2h = new Map(teams.map((t) => [t.fleaflickerId, new Map<number, { wins: number; losses: number; ties: number }>()]));
  const postseasonByTeam = new Map(teams.map((t) => [t.fleaflickerId, [] as PostseasonFinish[]]));
  const lastPlaceByTeam = new Map(teams.map((t) => [t.fleaflickerId, [] as { season: number; teamNameThatYear: string }[]]));
  const incompleteSeasons: number[] = [];

  function h2hFor(id: number, opponentId: number) {
    const m = h2h.get(id)!;
    if (!m.has(opponentId)) m.set(opponentId, { wins: 0, losses: 0, ties: 0 });
    return m.get(opponentId)!;
  }

  try {
    for (const season of seasons) {
      const standingsRes = await fetch(`https://www.fleaflicker.com/api/FetchLeagueStandings?sport=NFL&league_id=${leagueId}&season=${season}`);
      if (!standingsRes.ok) throw new Error(`Standings failed for season ${season} (HTTP ${standingsRes.status})`);
      const standingsData: any = await standingsRes.json();
      const seasonTeams: any[] = (standingsData?.divisions ?? []).flatMap((d: any) => d?.teams ?? []);

      // per-season snapshot, used later to determine that season's last place —
      // only once we know (below) whether the season actually finished
      const seasonSnapshot: { id: number; wins: number; pointsFor: number; name: string }[] = [];

      for (const t of seasonTeams) {
        if (!knownIds.has(t.id)) continue; // defensive — shouldn't happen for a stable 10-team league
        const rec = t.recordOverall ?? {};
        const agg = allTime.get(t.id)!;
        agg.wins += rec.wins ?? 0;
        agg.losses += rec.losses ?? 0;
        agg.ties += rec.ties ?? 0;
        agg.pointsFor += t.pointsFor?.value ?? 0;
        agg.pointsAgainst += t.pointsAgainst?.value ?? 0;
        seasonSnapshot.push({ id: t.id, wins: rec.wins ?? 0, pointsFor: t.pointsFor?.value ?? 0, name: t.name });
      }

      // discover this season's real week range from the scoreboard's own eligibleSchedulePeriods
      const firstWeekRes = await fetch(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=1`);
      if (!firstWeekRes.ok) throw new Error(`Scoreboard discovery failed for season ${season} (HTTP ${firstWeekRes.status})`);
      const firstWeekData: any = await firstWeekRes.json();
      const eligiblePeriods: number[] = (firstWeekData?.eligibleSchedulePeriods ?? []).map((p: any) => p.ordinal).filter((n: any) => typeof n === 'number');
      const maxWeek = eligiblePeriods.length > 0 ? Math.max(...eligiblePeriods) : 1;

      const weekResults = await Promise.all(
        Array.from({ length: maxWeek }, (_, i) => i + 1).map(async (week) => {
          if (week === 1) return firstWeekData; // already fetched above, don't re-fetch
          const r = await fetch(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=${week}`);
          if (!r.ok) throw new Error(`Scoreboard failed for season ${season} week ${week} (HTTP ${r.status})`);
          return r.json();
        })
      );

      let foundChampionship = false;

      for (const weekData of weekResults) {
        const games: any[] = weekData?.games ?? [];
        for (const g of games) {
          const awayId = g?.away?.id;
          const homeId = g?.home?.id;
          if (!knownIds.has(awayId) || !knownIds.has(homeId)) continue;

          if (g?.isFinalScore) {
            const awayResult = g?.awayResult;
            const homeResult = g?.homeResult;
            const awayRec = h2hFor(awayId, homeId);
            const homeRec = h2hFor(homeId, awayId);
            if (awayResult === 'WIN') {
              awayRec.wins += 1;
              homeRec.losses += 1;
            } else if (awayResult === 'LOSE') {
              awayRec.losses += 1;
              homeRec.wins += 1;
            } else if (awayResult === 'TIE') {
              awayRec.ties += 1;
              homeRec.ties += 1;
            }
          }

          if (g?.isChampionshipGame) {
            foundChampionship = true;
            const winnerId = g.awayResult === 'WIN' ? awayId : homeId;
            const loserId = g.awayResult === 'WIN' ? homeId : awayId;
            const winnerName = g.awayResult === 'WIN' ? g.away.name : g.home.name;
            const loserName = g.awayResult === 'WIN' ? g.home.name : g.away.name;
            postseasonByTeam.get(winnerId)!.push({ season, place: 1, teamNameThatYear: winnerName });
            postseasonByTeam.get(loserId)!.push({ season, place: 2, teamNameThatYear: loserName });
          }

          if (g?.isThirdPlaceGame) {
            const winnerId = g.awayResult === 'WIN' ? awayId : homeId;
            const loserId = g.awayResult === 'WIN' ? homeId : awayId;
            const winnerName = g.awayResult === 'WIN' ? g.away.name : g.home.name;
            const loserName = g.awayResult === 'WIN' ? g.home.name : g.away.name;
            postseasonByTeam.get(winnerId)!.push({ season, place: 3, teamNameThatYear: winnerName });
            postseasonByTeam.get(loserId)!.push({ season, place: 4, teamNameThatYear: loserName });
          }
        }
      }

      if (foundChampionship) {
        let worst: { id: number; wins: number; pointsFor: number; name: string } | null = null;
        for (const s of seasonSnapshot) {
          if (!worst || s.wins < worst.wins || (s.wins === worst.wins && s.pointsFor < worst.pointsFor)) {
            worst = s;
          }
        }
        if (worst) {
          lastPlaceByTeam.get(worst.id)!.push({ season, teamNameThatYear: worst.name });
        }
      } else {
        incompleteSeasons.push(season);
      }
    }

    const teamHistories: TeamHistory[] = teams.map((t) => {
      const headToHead: HeadToHead[] = teams
        .filter((other) => other.slug !== t.slug)
        .map((other) => {
          const rec = h2h.get(t.fleaflickerId)!.get(other.fleaflickerId) ?? { wins: 0, losses: 0, ties: 0 };
          return { opponentSlug: other.slug, ...rec };
        });

      return {
        teamSlug: t.slug,
        fleaflickerId: t.fleaflickerId,
        allTime: allTime.get(t.fleaflickerId)!,
        headToHead,
        postseasonFinishes: postseasonByTeam.get(t.fleaflickerId)!.sort((a, b) => a.season - b.season),
        lastPlaceFinishes: lastPlaceByTeam.get(t.fleaflickerId)!.sort((a, b) => a.season - b.season),
      };
    });

    const history: LeagueHistory = {
      computedAtEpochMilli: Date.now(),
      seasonsCovered: { from: START_SEASON, to: throughSeason },
      incompleteSeasons,
      teams: teamHistories,
    };

    await setJSON(HISTORY_KEY, history);

    return res.status(200).json({
      ok: true,
      message: `Computed history for ${seasons.length} seasons (${START_SEASON}-${throughSeason}).`,
      incompleteSeasons,
      teamCount: teamHistories.length,
    });
  } catch (err: any) {
    return res.status(502).json({ error: `League history computation failed partway through: ${err?.message}. Nothing was saved — the old cached history (if any) is untouched.` });
  }
}
