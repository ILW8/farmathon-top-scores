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

import { UserBestScore, UserScore } from 'osu-web.js';

interface Env {
  OSU_API_V2_CLIENT_ID: string;
  OSU_API_V2_CLIENT_SECRET: string;
  DISCORD_WEBHOOK_URL: string;
	LATEST_SCORE: KVNamespace;  // handles latest score, but also caches access token for osu api v2
}

interface ScuffedScore {
  score: number,
  mods: string[],
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

interface LastSeenScore extends ScuffedScore {
  hash: string
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
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.OSU_API_V2_CLIENT_ID,
      client_secret: env.OSU_API_V2_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'public'
    }),
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

function score_from_api(api_score: UserScore): ScuffedScore {
  return {
    score: api_score.score,
    mods: api_score.mods,
    created_at: api_score.created_at,
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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// noinspection JSUnusedGlobalSymbols
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const osu_v2_token = await get_osu_v2_token(env);
    if (osu_v2_token == null) {
      return;
    }

    const last_seen_score_str = await env.LATEST_SCORE.get('last_seen');
    let last_seen_score: LastSeenScore | null = null;
    try {
      if (last_seen_score_str != null)
        last_seen_score = JSON.parse(last_seen_score_str);
    } catch (e) {
      console.warn(`Failed to parse last_seen_score: ${e}, resetting to empty`);
    }

    const options = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${osu_v2_token}`
      }
    };

    let r = await fetch('https://osu.ppy.sh/api/v2/users/3171691/scores/recent?legacy_only=1&mode=osu&limit=50', options);
    if (!r.ok) {
      console.error(`Failed to fetch recent scores: ${r.status} ${await r.text()}`);
      return;
    }
    const recent_scores = (await r.json()) as UserScore[];

    r = await fetch('https://osu.ppy.sh/api/v2/users/3171691/scores/best?legacy_only=1&mode=osu&limit=100', options);
    if (!r.ok) {
      console.error(`Failed to fetch best scores: ${r.status} ${await r.text()}`);
      return;
    }
    const best_scores = (await r.json()) as UserBestScore[];


    // const top_100_pp = best_scores.reduce((min, score) => {
    //   return score.pp < min ? score.pp : min;
    // }, Infinity);

    const top_100_pp_values = best_scores.map(score => score.pp);
    top_100_pp_values.sort((a, b) => a - b).reverse();

    const top_100_pp = top_100_pp_values[top_100_pp_values.length - 1];

    let new_scores: UserScore[] = [];
    let hex_digest: string = "";

		for (let score_index in recent_scores) {
      const reverse_index = recent_scores.length - score_index - 1;

      // filter to only include top 100 scores
      if (recent_scores[reverse_index].pp == null || recent_scores[reverse_index].pp < top_100_pp) {
        // console.log(`skipping score ${reverse_index} with pp ${recent_scores[reverse_index].pp}`);
        continue;
      }

      // log the sha256sum  of score
			const digest = await crypto.subtle.digest(
        { name: 'SHA-256' },
        new TextEncoder().encode(JSON.stringify(recent_scores[reverse_index]))
      );
			hex_digest = Array.from(new Uint8Array(digest))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');

			// console.log(`${score_index}: ${hex_digest}`);

      if (hex_digest == last_seen_score?.hash) {
        // clear new_scores
        new_scores = [];
        continue;
      }

      new_scores.push(recent_scores[reverse_index]);
		}

    // update last_seen_score using last element of new_scores
    if (new_scores.length > 0) {
      const latest_score = new_scores[0]
      console.log(`updating last_seen_score to ${hex_digest}`);
      await env.LATEST_SCORE.put('last_seen', JSON.stringify({
        hash: hex_digest,
        ...score_from_api(latest_score)
      }));
    }

		ctx.waitUntil((async () => {
      for (const api_score of new_scores) {
        // console.log(JSON.stringify(api_score));
        const start_time = Date.now();

        const score: ScuffedScore = score_from_api(api_score);
        const score_time_set = new Date(score.created_at);

        // for (let i = 0; i < top_100_pp_values.length; i++) {
        //   if (top_100_pp_values[i] < score.pp ) {
        //     score_rank = i + 1;
        //     break;
        //   }
        // }

        let score_rank = top_100_pp_values.indexOf(score.pp) + 1;

        // if score is not in top 100 (did not overwrite), then skip the score
        if (score_rank == 0)
          continue;

        let content = `\`${('#' + score_rank.toString()).padStart(4)}\`: **${score.rank.toUpperCase()}** rank `;
        content += `**${score.pp}**pp ${score.mods.join('')}`;
        content += `<t:${score_time_set.getTime()/1000}:f> [${score.title} [${score.diff_name}]](https://osu.ppy.sh/b/${score.beatmap_id}) `;

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

        // wait 1 second per request, adjust for `fetch` latency if applicable.
        const elapsed_time = Date.now() - start_time;
        const remaining_time = Math.max(1000 - elapsed_time, 0);

        await delay(remaining_time);
      }
    })());
	},

	async fetch() {
		return new Response('', { status: 404 });
	}
};
