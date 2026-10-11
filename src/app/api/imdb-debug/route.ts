import { NextResponse } from 'next/server';

export const runtime = 'edge';

// 临时诊断接口（定位 IMDb 回填断点用，诊断完成即删）：
// 依次报告——两个机密变量在运行时读没读到、从机房调 TMDB 详情/搜索/external_ids 通不通、
// OMDb 按 ID 查分通不通。只报存在性与长度，绝不返回 key 本身。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function probe(url: string): Promise<{ status: number; json: any }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { fetchError: String(e).slice(0, 200) } };
  }
}

export async function GET() {
  const tmdbKey = (process.env.TMDB_API_KEY || '').trim();
  const omdbKey = (process.env.OMDB_API_KEY || '').trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {
    env: {
      TMDB_API_KEY: { present: tmdbKey.length > 0, length: tmdbKey.length },
      OMDB_API_KEY: { present: omdbKey.length > 0, length: omdbKey.length },
    },
  };

  if (tmdbKey) {
    const detail = await probe(
      `https://api.themoviedb.org/3/movie/550?api_key=${tmdbKey}`
    );
    out.tmdbMovie550 = {
      status: detail.status,
      imdb_id: detail.json?.imdb_id ?? null,
      error: detail.json?.status_message ?? detail.json?.fetchError ?? null,
    };

    const search = await probe(
      `https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(
        '丰臣兄弟'
      )}&language=zh-CN`
    );
    const results = Array.isArray(search.json?.results)
      ? search.json.results
      : [];
    out.tmdbSearchToyotomi = {
      status: search.status,
      count: results.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      names: results.slice(0, 3).map((r: any) => r.name || r.original_name),
    };
    if (results[0]?.id) {
      const ext = await probe(
        `https://api.themoviedb.org/3/tv/${results[0].id}/external_ids?api_key=${tmdbKey}`
      );
      out.tmdbExternalIds = {
        status: ext.status,
        imdb_id: ext.json?.imdb_id ?? null,
      };
    }

    // 复刻生产代码的查法：带完整标题（含标点）+ 年份过滤，看年份是否把结果滤光
    const sim = async (year: string) => {
      const p = new URLSearchParams({
        api_key: tmdbKey,
        query: '丰臣兄弟！',
        language: 'zh-CN',
      });
      if (year) p.set('first_air_date_year', year);
      const s = await probe(
        `https://api.themoviedb.org/3/search/tv?${p.toString()}`
      );
      return {
        status: s.status,
        count: Array.isArray(s.json?.results) ? s.json.results.length : -1,
      };
    };
    out.prodSim = {
      withYear2026: await sim('2026'),
      withYear2025: await sim('2025'),
      noYear: await sim(''),
    };
  }

  if (omdbKey) {
    const omdb = await probe(
      `https://www.omdbapi.com/?i=tt0137523&apikey=${omdbKey}`
    );
    out.omdbFightClub = {
      status: omdb.status,
      imdbRating: omdb.json?.imdbRating ?? null,
      error: omdb.json?.Error ?? omdb.json?.fetchError ?? null,
    };
  }

  return NextResponse.json(out);
}
