import { normalizeTitleForMatch } from './utils';

// 评分回填（服务端专用）：豆瓣分经站点代理按豆瓣 ID 查 rexxar；IMDb 分走
// TMDB（按中文标题查 imdb_id）→ OMDb（按 ID 查 imdbRating）链路。
//
// 为什么独立成 /api/scores 而不塞在 /api/latest 里：Cloudflare 免费版单次函数
// 调用有子请求数量上限，/api/latest 光是拉源站列表+豆瓣回填就能耗尽额度，
// 排在最后的 IMDb 回填会被整批掐断（实测表现为每次 fetch 都失败）。拆开后
// 每次 /api/scores 调用只处理 ≤8 条、自带完整额度，两边互不挤占。
// 两层进程内缓存（标题→imdb_id、id→评分）让常访标题在热 isolate 里近乎零成本。

export interface ScoreTarget {
  title: string;
  year?: string;
  douban_id?: number;
  douban_score?: string;
  imdb_score?: string;
}

// ---------------- 豆瓣 ----------------

const doubanScoreCache = new Map<
  number,
  { score: string | null; ts: number }
>();
const DOUBAN_TTL_MS = 7 * 24 * 3600 * 1000;
const DOUBAN_MISS_TTL_MS = 24 * 3600 * 1000;

// 经豆瓣代理按 ID 查 rexxar 详情拿评分（单条，带超时；失败/无分返回 null）
async function fetchDoubanScore(
  proxy: string,
  doubanId: number,
  kind: 'movie' | 'tv'
): Promise<string | null> {
  const now = Date.now();
  const hit = doubanScoreCache.get(doubanId);
  if (
    hit &&
    now - hit.ts < (hit.score ? DOUBAN_TTL_MS : DOUBAN_MISS_TTL_MS)
  ) {
    return hit.score;
  }
  const target = `https://m.douban.com/rexxar/api/v2/${kind}/${doubanId}`;
  let score: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${proxy}${encodeURIComponent(target)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Referer: 'https://movie.douban.com/',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        rating?: { value?: number };
      } | null;
      const value = data?.rating?.value;
      score = typeof value === 'number' && value > 0 ? value.toFixed(1) : null;
    }
  } catch {
    score = null;
  }
  doubanScoreCache.set(doubanId, { score, ts: now });
  return score;
}

// 给一批结果回填豆瓣评分：先按栏目类型查，无分再换另一类型试；分批并发，查不到留空
async function fillDoubanScores(
  results: ScoreTarget[],
  category: string,
  proxy: string
): Promise<void> {
  const primary: 'movie' | 'tv' = category === 'movie' ? 'movie' : 'tv';
  const targets = results.filter((r) => r.douban_id);
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    await Promise.allSettled(
      targets.slice(i, i + BATCH).map(async (item) => {
        const id = item.douban_id as number;
        let score = await fetchDoubanScore(proxy, id, primary);
        if (!score) {
          score = await fetchDoubanScore(
            proxy,
            id,
            primary === 'movie' ? 'tv' : 'movie'
          );
        }
        if (score) item.douban_score = score;
      })
    );
  }
}

// ---------------- IMDb（TMDB 查 imdb_id → OMDb 按 ID 查分） ----------------
// TMDB 本身不提供 IMDb 评分（vote_average 是 TMDB 用户分，不能冒充 IMDb 分），
// 它只负责按中文标题找到 imdb_id；真分由 OMDb 按 ID 返回。
// 两个 key 都配了才启用：Cloudflare 机密变量 TMDB_API_KEY / OMDB_API_KEY（服务端读取，不下发前端）。
// OMDb 免费档 1000 次/天，靠缓存控额度：标题→imdb_id（命中长期、未命中 10 分钟）、
// imdb_id→评分（命中 7 天、未命中 1 天）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJsonTimeout(url: string, ms = 5000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const imdbIdCache = new Map<string, { id: string | null; ts: number }>();
// 查无此片的负缓存只留 10 分钟：避免某次超时/限流把标题永久毒化
const IMDB_ID_NEG_TTL_MS = 10 * 60 * 1000;
const imdbRatingCache = new Map<
  string,
  { score: string | null; ts: number }
>();
const RATING_TTL_MS = 7 * 24 * 3600 * 1000;
const RATING_MISS_TTL_MS = 24 * 3600 * 1000;

// 检索用基础标题：去掉「第X季/部/篇」「Season N」「S01」类后缀
function baseTitleForSearch(title: string): string {
  return title
    .replace(/第[一二三四五六七八九十百零\d]+[季部篇]/g, '')
    .replace(/\s*Season\s*\d+\s*$/i, '')
    .replace(/\s*S\d{1,2}\s*$/i, '')
    .trim();
}

function titleLooseMatch(candidate: string, target: string): boolean {
  const a = normalizeTitleForMatch(baseTitleForSearch(candidate));
  const b = normalizeTitleForMatch(baseTitleForSearch(target));
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

async function tmdbSearchOnce(
  apiKey: string,
  title: string,
  year: string,
  kind: 'movie' | 'tv'
): Promise<{ imdbId: string | null; answered: boolean }> {
  let answered = false;
  const queries = Array.from(
    new Set([baseTitleForSearch(title), title].filter(Boolean))
  );
  for (const q of queries) {
    const params = new URLSearchParams({
      api_key: apiKey,
      query: q,
      language: 'zh-CN',
    });
    if (year) params.set(kind === 'movie' ? 'year' : 'first_air_date_year', year);
    const data = await fetchJsonTimeout(
      `https://api.themoviedb.org/3/search/${kind}?${params.toString()}`
    );
    if (data === null) continue; // 网络/超时失败，不算「查过」
    answered = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    for (const r of results.slice(0, 5)) {
      const cand =
        kind === 'movie' ? r.title || r.original_title : r.name || r.original_name;
      if (!cand || !titleLooseMatch(cand, title)) continue;
      // 搜索结果不带 imdb_id：电影取详情、剧集取 external_ids
      const detail =
        kind === 'movie'
          ? await fetchJsonTimeout(
              `https://api.themoviedb.org/3/movie/${r.id}?api_key=${apiKey}`
            )
          : await fetchJsonTimeout(
              `https://api.themoviedb.org/3/tv/${r.id}/external_ids?api_key=${apiKey}`
            );
      const idVal = detail?.imdb_id;
      if (typeof idVal === 'string' && idVal.startsWith('tt')) {
        return { imdbId: idVal, answered };
      }
    }
  }
  return { imdbId: null, answered };
}

async function tmdbFindImdbId(
  apiKey: string,
  title: string,
  year: string,
  kind: 'movie' | 'tv'
): Promise<string | null> {
  const cacheKey = `${kind}:${normalizeTitleForMatch(
    baseTitleForSearch(title)
  )}:${year}`;
  const hit = imdbIdCache.get(cacheKey);
  if (hit && (hit.id !== null || Date.now() - hit.ts < IMDB_ID_NEG_TTL_MS)) {
    return hit.id;
  }
  // 先带年份查（消歧）；查不到再放宽到无年份——源站年份常与 TMDB 首播年对不上
  let res = await tmdbSearchOnce(apiKey, title, year, kind);
  if (!res.imdbId && year) {
    res = await tmdbSearchOnce(apiKey, title, '', kind);
  }
  // 只有 TMDB 真的应答过才缓存结果，纯失败不落缓存
  if (res.imdbId || res.answered) {
    imdbIdCache.set(cacheKey, { id: res.imdbId, ts: Date.now() });
  }
  return res.imdbId;
}

async function omdbFetchRating(
  apiKey: string,
  imdbId: string
): Promise<string | null> {
  const now = Date.now();
  const hit = imdbRatingCache.get(imdbId);
  if (hit && now - hit.ts < (hit.score ? RATING_TTL_MS : RATING_MISS_TTL_MS)) {
    return hit.score;
  }
  const data = await fetchJsonTimeout(
    `https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`
  );
  const raw = data?.imdbRating;
  const score =
    typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) ? raw : null;
  imdbRatingCache.set(imdbId, { score, ts: now });
  return score;
}

async function fillImdbScores(
  results: ScoreTarget[],
  category: string,
  tmdbKey: string,
  omdbKey: string
): Promise<void> {
  const primary: 'movie' | 'tv' = category === 'movie' ? 'movie' : 'tv';
  const BATCH = 4;
  for (let i = 0; i < results.length; i += BATCH) {
    await Promise.allSettled(
      results.slice(i, i + BATCH).map(async (item) => {
        const year = item.year && item.year !== 'unknown' ? item.year : '';
        let imdbId = await tmdbFindImdbId(tmdbKey, item.title, year, primary);
        if (!imdbId) {
          imdbId = await tmdbFindImdbId(
            tmdbKey,
            item.title,
            year,
            primary === 'movie' ? 'tv' : 'movie'
          );
        }
        if (!imdbId) return;
        const score = await omdbFetchRating(omdbKey, imdbId);
        if (score) item.imdb_score = score;
      })
    );
  }
}

// ---------------- 入口 ----------------

// 给一批条目回填豆瓣 + IMDb 评分（原地写入 douban_score / imdb_score）。
// doubanProxy 为空跳过豆瓣；TMDB/OMDB 任一 key 未配则跳过 IMDb。
export async function fillAllScores(
  targets: ScoreTarget[],
  category: string,
  doubanProxy: string
): Promise<void> {
  if (doubanProxy) {
    await fillDoubanScores(targets, category, doubanProxy);
  }
  const tmdbKey = (process.env.TMDB_API_KEY || '').trim();
  const omdbKey = (process.env.OMDB_API_KEY || '').trim();
  if (tmdbKey && omdbKey) {
    await fillImdbScores(targets, category, tmdbKey, omdbKey);
  }
}
