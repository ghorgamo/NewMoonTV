import type { Dispatch, SetStateAction } from 'react';

import type { SearchResult } from './types';
import { normalizeTitleForMatch } from './utils';

interface ScorePatch {
  douban_score?: string;
  imdb_score?: string;
}

// 卡片先渲染、评分异步补：列表数据由 /api/latest 快速返回（不含评分），
// 本函数把已渲染条目分批（每批 8 条）发给 /api/scores 补查豆瓣/IMDb 分，
// 拿到后按归一化标题回填对应 state。评分是锦上添花：失败全程静默。
export function enrichScores(
  items: SearchResult[],
  category: string,
  setItems: Dispatch<SetStateAction<SearchResult[]>>
): void {
  if (!items.length) return;
  const BATCH = 8;
  void (async () => {
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category,
            items: batch.map((it) => ({
              title: it.title,
              year: it.year,
              douban_id: it.douban_id,
            })),
          }),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          scores?: Record<string, ScorePatch>;
        };
        const scores = data.scores || {};
        if (Object.keys(scores).length === 0) continue;
        setItems((prev) =>
          prev.map((p) => {
            const s = scores[normalizeTitleForMatch(p.title)];
            return s
              ? {
                  ...p,
                  douban_score: s.douban_score ?? p.douban_score,
                  imdb_score: s.imdb_score ?? p.imdb_score,
                }
              : p;
          })
        );
      } catch {
        // 静默：评分补查失败不影响看片
      }
    }
  })();
}
