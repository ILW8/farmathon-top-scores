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

import { Client } from 'osu-web.js';

interface Env {
	OSU_API_KEY: string;
  OSU_API_V2_CLIENT_ID: string;
  OSU_API_V2_CLIENT_SECRET: string;
  DISCORD_WEBHOOK_URL: string;
	LATEST_SCORE: KVNamespace;  // handles latest score, but also caches access token for osu api v2
	// ... other binding types
}

interface Score {
  beatmap_id: string,
  score: string,
  mods: string,
  date: string,
  rank: string,
  score_id: string | null
}

interface LastSeen extends Score {
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

export default {
	async scheduled(event, env: Env, ctx) {
		const osu_v1_api_key = env.OSU_API_KEY;
		if (!osu_v1_api_key)
			return;

    const last_seen_score_str = await env.LATEST_SCORE.get('last_seen');
    let last_seen_score: LastSeen | null = null;
    try {
      if (last_seen_score_str != null)
        last_seen_score = JSON.parse(last_seen_score_str);
    } catch (e) {
      console.warn(`Failed to parse last_seen_score: ${e}, resetting to empty`);
    }

		const options = {
			method: 'GET'
		};

		let resp = await fetch('https://osu.ppy.sh/api/get_user_recent?u=BTMC' +
			'&type=string' +
			`&k=${osu_v1_api_key}` +
			'&m=0' +
			'&limit=100', options)
			.then(response => response.json());

    // const client = new Client(env.OSU_API_KEY_V2)
    //
    // const recent_scores = await

    let new_scores: Score[] = [];
    let hex_digest: string = "";

		for (let score_index in resp) {
			// log the sha256sum  of score
      const reverse_index = resp.length - score_index - 1;
			const digest = await crypto.subtle.digest(
        { name: 'SHA-256' },
        new TextEncoder().encode(JSON.stringify(resp[reverse_index]))
      );
			hex_digest = Array.from(new Uint8Array(digest))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');

			// console.log(`${score_index}: ${hex_digest}`);

      // if (hex_digest == last_seen_score?.hash) {
      //   // clear new_scores
      //   new_scores = [];
      //   continue;
      // }

      new_scores.push(resp[reverse_index]);
		}

    // keep at most one element in new_scores
    new_scores = new_scores.slice(0, 1);

    // update last_seen_score using last element of new_scores
    if (new_scores.length > 0) {
      console.log(`updating last_seen_score to ${hex_digest}`);
      await env.LATEST_SCORE.put('last_seen', JSON.stringify({
        hash: hex_digest,
        beatmap_id: new_scores[0].beatmap_id,
        score: new_scores[0].score,
        mods: new_scores[0].mods,
        date: new_scores[0].date,
        rank: new_scores[0].rank,
        score_id: new_scores[0].score_id
      }));
    }

		ctx.waitUntil((async () => {
      for (const score of new_scores) {
        console.log(JSON.stringify(score));
        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ content:
          `[${score.beatmap_id}](https://osu.ppy.sh/b/${score.beatmap_id})
          :regional_indicator_${score.rank.toLowerCase()}:
          `
          })
        };

        const resp = await fetch(env.DISCORD_WEBHOOK_URL, options);

        if (!resp.ok) {
          console.error(`Failed to send webhook: ${resp.status} ${await resp.text()}`);
        }
      }
    })());
	},

	async fetch(event, env: Env, ctx) {
		console.log(await get_osu_v2_token(env));
		return new Response('', { status: 404 });
	}
};
