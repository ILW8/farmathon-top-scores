/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.json`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import {
  BeatmapCompact,
  BeatmapsetCompact,
  ISOTimestamp,
  Rank,
  ScoreStatistics,
  UserBestScore,
  UserCompact
} from 'osu-web.js';

interface Env {
  OSU_API_V2_CLIENT_ID: string;
  OSU_API_V2_CLIENT_SECRET: string;
  DISCORD_WEBHOOK_URL: string;
  FARMATHON_TIMER_LINKSHARE: string;
  LATEST_SCORE: KVNamespace;  // handles latest score, but also caches access token for osu api v2
}

/**
 * @deprecated kept solely for compat reasons
 */
interface ScuffedScore {
  score: number,
  mod_acronyms: string[],
  created_at: string,
  rank: string,
  id: number;
  pp: number;
  beatmap_id: number;
  beatmapset_id: number;
  diff_name: string;
  artist: string;
  set_mapper: string;
  title: string;
}

interface NewMod {
  acronym: string;
  // ??
}

interface NewScore {
  classic_total_score: number;
  preserve: boolean;
  processed: boolean;
  ranked: boolean;
  maximum_statistics: ScoreStatistics;
  mods: NewMod[];
  statistics: ScoreStatistics;
  total_score_without_mods: number;
  beatmap_id: number;
  best_id: number | null;
  id: number;
  rank: Rank;
  type: string;
  user_id: number;
  accuracy: number;
  build_id: number | null;
  ended_at: ISOTimestamp;
  has_replay: boolean;
  is_perfect_combo: boolean;
  legacy_perfect: boolean;
  legacy_score_id: number | null;
  legacy_total_score: number;
  max_combo: number;
  passed: boolean;
  pp: number;
  ruleset_id: number;
  started_at: ISOTimestamp | null;
  total_score: number;
  replay: boolean;
  // current_user_attributes: object ??;
}

interface NewUserScore extends NewScore {
  beatmap: BeatmapCompact & {
    checksum: string | null;
  };
  beatmapset: BeatmapsetCompact;
  user: UserCompact;
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
}

async function get_osu_v2_token(env: Env, renew: boolean = false) {
  if (!renew) {
    const cached_token = await env.LATEST_SCORE.get('osu_v2_token');

    if (cached_token != null) {
      return cached_token;
    }
  }

  console.log('renewing osu! api v2 token');

  // renew token
  const token_url = 'https://osu.ppy.sh/oauth/token';
  const options = {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: env.OSU_API_V2_CLIENT_ID,
      client_secret: env.OSU_API_V2_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'public'
    })
  };

  const resp = await fetch(token_url, options);
  const token_resp: TokenResponse = await resp.json();
  if (!resp.ok) {
    console.error(`Failed to get osu v2 token: ${resp.status} ${JSON.stringify(token_resp)}`);
    return null;
  }

  await env.LATEST_SCORE.put('osu_v2_token', token_resp.access_token, { expirationTtl: token_resp.expires_in });

  return token_resp.access_token;
}

function score_from_api(api_score: NewUserScore): ScuffedScore {
  return {
    score: api_score.classic_total_score,
    mod_acronyms: api_score.mods.map(mod => mod.acronym),
    created_at: api_score.ended_at,
    rank: api_score.rank,
    id: api_score.id,
    pp: api_score.pp,
    beatmap_id: api_score.beatmap.id,
    beatmapset_id: api_score.beatmap.beatmapset_id,
    diff_name: api_score.beatmap.version,
    artist: api_score.beatmapset.artist,
    set_mapper: api_score.beatmapset.creator,
    title: api_score.beatmapset.title
  };
}

// const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatSecondsToHMS(seconds: number) {
  const fmt_hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const fmt_mins = Math.floor(seconds % 3600 / 60).toString().padStart(2, '0');
  const fmt_secs = Math.floor(seconds % 60).toString().padStart(2, '0');

  return `${fmt_hours}:${fmt_mins}:${fmt_secs}`;
}

// noinspection JSUnusedGlobalSymbols
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const osu_v2_token = await get_osu_v2_token(env);
    if (osu_v2_token == null) {
      return;
    }

    const last_seen_score_str = await env.LATEST_SCORE.get('last_seen');
    let last_seen_score: ScuffedScore | null = null;
    try {
      if (last_seen_score_str != null)
        last_seen_score = JSON.parse(last_seen_score_str);
    } catch (e) {
      console.warn(`Failed to parse last_seen_score: ${e}, resetting to empty`);
    }

    console.info(`last seen score: ${last_seen_score?.created_at} ${last_seen_score?.title}`);

    const options = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${osu_v2_token}`,
        'x-api-version': '20240529'
      }
    };

    const fetch_promises: Promise<Response>[] = [];
    fetch_promises.push(fetch('https://osu.ppy.sh/api/v2/users/3171691/scores/recent?legacy_only=1&mode=osu&limit=50', options));
    fetch_promises.push(fetch('https://osu.ppy.sh/api/v2/users/3171691/scores/best?legacy_only=1&mode=osu&limit=100', options));

    // default timer value to -1, proceed invoking webhook regardless of timer success
    let timer_value = -1;
    if (env.FARMATHON_TIMER_LINKSHARE != null) {
      // add nocache query param with random value to bypass caching
      const timer_url = new URL(env.FARMATHON_TIMER_LINKSHARE);
      timer_url.searchParams.set('nocache', Math.random().toString().slice(2));

      // Not sure if strictly necessary when cache-busting query param is used as well
      fetch_promises.push(fetch(timer_url.toString(), { method: 'GET', headers: { 'Cache-Control': 'no-cache' } }));
    }

    // perform all network requests in parallel
    const [recentScoresResponse, bestScoresResponse, timerValueResponse] = await Promise.all(fetch_promises);

    if (!recentScoresResponse.ok) {
      console.error(`Failed to fetch recent scores: ${recentScoresResponse.status}`); // ${await recentScoresResponse.text()}`);
      return;
    }

    if (!bestScoresResponse.ok) {
      console.error(`Failed to fetch best scores: ${bestScoresResponse.status}`); //  ${await bestScoresResponse.text()}`);
      return;
    }

    if (!timerValueResponse.ok) {
      console.warn(`Failed to fetch timer value: ${timerValueResponse.status} ${await timerValueResponse.text()}`);
    } else {
      try {
        timer_value = parseInt(await timerValueResponse.text());
      } catch (e) {
        console.error(`Failed to parse timer value: ${e}`);
      }
    }

    const recent_scores = (await recentScoresResponse.json()) as NewUserScore[];
    const best_scores = (await bestScoresResponse.json()) as UserBestScore[];

    const top_100_pp_values = best_scores.map(score => score.pp).sort((a, b) => b - a);
    const top_100_pp = top_100_pp_values[top_100_pp_values.length - 1];

    let new_scores: NewUserScore[] = [];

    let last_seen_index = -1;
    if (last_seen_score?.created_at != null)
      last_seen_index = recent_scores.findIndex(score => score.ended_at == last_seen_score?.created_at);

    if (last_seen_index !== 0) {
      const start_index = last_seen_index === -1 ? recent_scores.length - 1 : last_seen_index;

      for (let i = start_index; i >= 0; i--) {
        const score = recent_scores[i];

        if (score.pp && score.pp >= top_100_pp)
          new_scores.push(score);
      }
    }

    if (recent_scores.length > 0) {
      const latest_score = recent_scores[0];
      if (latest_score.ended_at != last_seen_score?.created_at) {
        console.log(`updating last_seen_score to ${latest_score.beatmapset.title}, created_at=${latest_score.ended_at}`);
        await env.LATEST_SCORE.put('last_seen', JSON.stringify(score_from_api(latest_score)));
      }
    }

    ctx.waitUntil((async () => {
      for (const api_score of new_scores) {
        // console.log(JSON.stringify(api_score));

        const score: ScuffedScore = score_from_api(api_score);
        const score_time_set = new Date(score.created_at);
        let score_rank = top_100_pp_values.indexOf(score.pp) + 1;

        // if score is not in top 100 (did not overwrite), then skip the score
        if (score_rank == 0)
          continue;

        const modAcronyms = score.mod_acronyms.length > 0 ? `+${score.mod_acronyms.join('')}` : '';
        let content = `\`${('#' + score_rank.toString()).padStart(4)}\`: **${score.rank.toUpperCase()}** rank `;
        content += `**${score.pp}**pp ${modAcronyms} `;
        content += `<t:${score_time_set.getTime() / 1000}:f> [${score.title} [${score.diff_name}]](https://osu.ppy.sh/b/${score.beatmap_id})`;
        content += ` | [__**Score link**__](https://osu.ppy.sh/scores/${score.id})`;

        // only add timer calculation if timer value was correctly fetched
        if (timer_value != -1) {
          /**
           * Taken from !farmathon spreadsheet
           * @note Only doing weeks 3 and 4 since I'm writing this on week 3 lol
           * @description Tier 0 (index 0 in array) is rank #100-51,
           *  Tier 1 is rank #50-26,
           *  Tier 2 is rank #25-6,
           *  Tier 3 is rank #5-2,
           *  Tier 4 is rank #1
           */
          const timer_reduction_pcts = {
            3: [15, 20, 35, 90, 99],
            4: [20, 25, 40, 95, 100]
          };
          const reduced_timer_values: { [key: number]: number } = {};
          const ranges = [
            { min: 1, max: 1, tier: 4 },
            { min: 2, max: 5, tier: 3 },
            { min: 6, max: 25, tier: 2 },
            { min: 26, max: 50, tier: 1 },
            { min: 51, max: 100, tier: 0 }
          ];

          let reduction_tier = 0;

          // // hard-coding thresholds here, I don't really care
          // if (score_rank == 1) {
          //   reduced_timer_values[week_num] = Math.round(timer_value * (timer_reduction_pcts[4] / 100));
          // } else if (score_rank >= 2 && score_rank <= 5) {
          //   reduced_timer_values[week_num] = Math.round(timer_value * (timer_reduction_pcts[3] / 100));
          // } else if (score_rank >= 6 && score_rank <= 25) {
          //   reduced_timer_values[week_num] = Math.round(timer_value * (timer_reduction_pcts[2] / 100));
          // } else if (score_rank >= 26 && score_rank <= 50) {
          //   reduced_timer_values[week_num] = Math.round(timer_value * (timer_reduction_pcts[1] / 100));
          // } else if (score_rank >= 51 && score_rank <= 100) {
          //   reduced_timer_values[week_num] = Math.round(timer_value * (timer_reduction_pcts[0] / 100));
          // }

          for (const range of ranges) {
            if (score_rank >= range.min && score_rank <= range.max) {
              reduction_tier = range.tier;
              break;
            }
          }

          for (const week_num of Object.keys(timer_reduction_pcts)) {
            reduced_timer_values[parseInt(week_num)] = Math.round(timer_value * (1 - timer_reduction_pcts[week_num][reduction_tier] / 100));
          }

          content += `\n`;
          content += `- Timer at time of score fetch: ${formatSecondsToHMS(timer_value)}\n`;
          for (const key of Object.keys(reduced_timer_values)) {
            content += ` - Reduction for week **${key}**: ${formatSecondsToHMS(reduced_timer_values[parseInt(key)])} (${timer_reduction_pcts[key][reduction_tier]}%)\n`;
          }
        }

        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ content: content })
        };

        const resp = await fetch(env.DISCORD_WEBHOOK_URL, options);

        if (!resp.ok) {
          console.error(`Failed to send webhook: ${resp.status} ${await resp.text()}`);
        }

        /**
         * !! IMPORTANT !!
         * ONLY PROCESS ONE SCORE PER SCHEDULED RUN
         * THIS IS TO FACILITATE TIMER CALCULATIONS
         */
        break;
      }
    })());
  },

  async fetch() {
    return new Response('', { status: 404 });
  }
};
