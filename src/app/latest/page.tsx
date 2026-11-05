/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { enrichScores } from '@/lib/scores.client';
import { SearchResult } from '@/lib/types';
import { normalizeTitleForMatch } from '@/lib/utils';

import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

// type 参数与 /douban 保持一致的习惯（movie/tv/show），数据走 /api/latest 的资源站最新更新
const TABS = [
  { label: '电影', type: 'movie', category: 'movie', cardType: 'movie' },
  { label: '剧集', type: 'tv', category: 'tv', cardType: 'tv' },
  { label: '综艺', type: 'show', category: 'variety', cardType: 'tv' },
  { label: '动漫', type: 'anime', category: 'anime', cardType: 'tv' },
] as const;

// 类型筛选排（与豆瓣剧集页的分类习惯对齐），value 传给 /api/latest 的 genre 参数
const GENRES = [
  { label: '全部', value: 'all' },
  { label: '国产', value: 'guochan' },
  { label: '欧美', value: 'oumei' },
  { label: '日本', value: 'riben' },
  { label: '韩国', value: 'hanguo' },
  { label: '动漫', value: 'dongman' },
  { label: '纪录片', value: 'jilupian' },
] as const;

const PAGE_LIMIT = 24;

// 瀑布流列数随视口宽度变化，断点与原 columns 类保持一致（手机 3 列、大屏最多 7 列）
function useColumnCount() {
  const [count, setCount] = useState(3);
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      setCount(w >= 1536 ? 8 : w >= 1024 ? 6 : w >= 640 ? 4 : 3);
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, []);
  return count;
}

function LatestPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get('type') || 'tv';
  const tab = TABS.find((t) => t.type === typeParam) || TABS[1];

  const [genre, setGenre] = useState<string>('all');
  // 排序键（与 kubb 一致）：add=添加时间（默认）、update=更新时间
  const [sort, setSort] = useState<'add' | 'update'>('add');
  // 年份筛选：all=全部、this=今年、last=去年、older=更早（按作品首播年份计）
  const [year, setYear] = useState<'all' | 'this' | 'last' | 'older'>('all');
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef(1);
  const seenRef = useRef<Set<string>>(new Set());

  const fetchPage = useCallback(
    async (pg: number) => {
      const res = await fetch(
        `/api/latest?category=${tab.category}&genre=${genre}&limit=${PAGE_LIMIT}&pg=${pg}&sort=${sort}&year=${year}`
      );
      if (!res.ok) throw new Error('栏目数据请求失败');
      const data = await res.json();
      return (data.results || []) as SearchResult[];
    },
    [tab.category, genre, sort, year]
  );

  // 跨页去重：同一作品只留一条（接口内已按页去重，这里防跨页重复）。
  // 最新更新用哪些源由管理后台源列表的勾选决定（/admin），这里不再硬过滤任何源。
  const takeFresh = useCallback((results: SearchResult[]) => {
    return results.filter((r) => {
      const key = normalizeTitleForMatch(r.title);
      if (seenRef.current.has(key)) return false;
      seenRef.current.add(key);
      return true;
    });
  }, []);

  // 切换栏目时重置并加载第一页
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setHasMore(true);
    pageRef.current = 1;
    seenRef.current = new Set();

    fetchPage(1)
      .then((results) => {
        if (cancelled) return;
        const fresh = takeFresh(results);
        setItems(fresh);
        // 年份筛选时一批可能很 sparse（符合年份的少），短批不代表到底，翻到第 5 页再停
        setHasMore(year !== 'all' ? true : results.length >= PAGE_LIMIT);
        // 评分异步补（豆瓣/IMDb），不阻塞卡片渲染
        enrichScores(fresh, tab.category, setItems);
      })
      .catch(() => {
        if (!cancelled) setError('获取最新更新数据失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchPage, takeFresh, year]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    const next = pageRef.current + 1;
    // 接口 pg 上限为 5，超出即到底
    if (next > 5) {
      setHasMore(false);
      return;
    }
    setLoadingMore(true);
    try {
      const results = await fetchPage(next);
      pageRef.current = next;
      const fresh = takeFresh(results);
      // 只在末尾追加，绝不整体重排：已展示的卡片位置保持不动，新内容不插到前面
      setItems((prev) => [...prev, ...fresh]);
      // 新一批的评分同样异步补
      enrichScores(fresh, tab.category, setItems);
      // 整页都是已见过的重复条目时同样视为到底，避免无限空转；
      // 年份筛选时短批不代表到底，翻到第 5 页再停
      setHasMore(
        year !== 'all' ? next < 5 : results.length >= PAGE_LIMIT && fresh.length > 0
      );
    } catch {
      // 加载失败保持现状，继续滚动可再次触发
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, loading, fetchPage, takeFresh, year]);

  // 追加式瀑布流分列：columns 存的是 items 的下标。
  // 已排入的卡片永不换列、不移动；新一批只按当前各列高度往最矮的列底部追加。
  // 仅在列表重置（切栏目/筛选）或列数变化（跨断点）时才整体重排。
  const colCount = useColumnCount();
  const [columns, setColumns] = useState<number[][]>([]);
  const placedRef = useRef<{ count: number; heights: number[] }>({
    count: 0,
    heights: [],
  });
  const gridRef = useRef<HTMLDivElement>(null);
  const colElsRef = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (items.length === 0) {
      placedRef.current = { count: 0, heights: [] };
      setColumns([]);
      return;
    }
    const placed = placedRef.current;
    const needRebuild =
      placed.count > items.length || placed.heights.length !== colCount;
    if (needRebuild) {
      placed.count = 0;
      placed.heights = new Array(colCount).fill(0);
    }
    if (placed.count === items.length && !needRebuild) return;
    // 用上一批渲染出的真实列高做校准，保证追加时各列高度判断准确
    if (!needRebuild) {
      const measured = colElsRef.current.map((el) => el?.offsetHeight || 0);
      if (measured.some((h) => h > 0)) {
        placed.heights = placed.heights.map((h, i) => measured[i] || h);
      }
    }
    const gridW = gridRef.current?.offsetWidth || 1200;
    const gapX = 10;
    const colW = (gridW - gapX * (colCount - 1)) / colCount;
    // 单卡估算高度：海报 2:3 + 两行说明区（标题 + 来源/更新状态）；下一批追加前会被真实高度校准
    const estCardH = colW * 1.5 + 60;
    setColumns((prev) => {
      const cols: number[][] = needRebuild
        ? Array.from({ length: colCount }, () => [])
        : prev.map((c) => [...c]);
      const heights = [...placed.heights];
      for (let i = placed.count; i < items.length; i++) {
        let target = 0;
        for (let c = 1; c < colCount; c++) {
          if (heights[c] < heights[target]) target = c;
        }
        cols[target].push(i);
        heights[target] += estCardH;
      }
      placed.count = items.length;
      placed.heights = heights;
      return cols;
    });
  }, [items, colCount]);

  // 无限滚动：哨兵进入视口（提前 600px）自动加载下一页，取代“加载更多”按钮
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '600px 0px' }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [loadMore]);

  return (
    <PageLayout>
      <div className='px-2 sm:px-10 py-4 sm:py-8'>
        <div className='max-w-[95%] mx-auto'>
          <div className='mb-6 flex flex-wrap items-center justify-between gap-4'>
            <h1 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
              最新更新
            </h1>
            {/* 栏目切换 */}
            <div className='flex gap-1 rounded-full bg-gray-100 p-1 dark:bg-gray-800'>
              {TABS.map((t) => (
                <button
                  key={t.type}
                  onClick={() => {
                    setGenre('all');
                    router.push(`/latest?type=${t.type}`);
                  }}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    t.type === tab.type
                      ? 'bg-green-600 text-white'
                      : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* 类型筛选 */}
          <div className='mb-4 flex flex-wrap gap-2'>
            {GENRES.map((g) => (
              <button
                key={g.value}
                onClick={() => setGenre(g.value)}
                className={`rounded-full border px-3.5 py-1 text-[13px] font-medium transition-colors ${
                  genre === g.value
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-300 text-gray-600 hover:border-green-600 hover:text-green-600 dark:border-gray-600 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>

          {/* 排序切换（与 kubb 一致）：添加时间默认，更新时间可选 */}
          <div className='mb-4 flex flex-wrap items-center gap-2'>
            <span className='text-[13px] text-gray-500 dark:text-gray-400'>
              排序：
            </span>
            {(
              [
                { label: '添加时间', value: 'add' },
                { label: '更新时间', value: 'update' },
              ] as const
            ).map((s) => (
              <button
                key={s.value}
                onClick={() => setSort(s.value)}
                className={`rounded-full border px-3.5 py-1 text-[13px] font-medium transition-colors ${
                  sort === s.value
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-300 text-gray-600 hover:border-green-600 hover:text-green-600 dark:border-gray-600 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 年份筛选：按作品首播年份计，今年/去年/更早 */}
          <div className='mb-4 flex flex-wrap items-center gap-2'>
            <span className='text-[13px] text-gray-500 dark:text-gray-400'>
              年份：
            </span>
            {(
              [
                { label: '全部', value: 'all' },
                { label: '今年', value: 'this' },
                { label: '去年', value: 'last' },
                { label: '更早', value: 'older' },
              ] as const
            ).map((y) => (
              <button
                key={y.value}
                onClick={() => setYear(y.value)}
                className={`rounded-full border px-3.5 py-1 text-[13px] font-medium transition-colors ${
                  year === y.value
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-300 text-gray-600 hover:border-green-600 hover:text-green-600 dark:border-gray-600 dark:text-gray-300 dark:hover:border-green-500 dark:hover:text-green-400'
                }`}
              >
                {y.label}
              </button>
            ))}
          </div>

          <p className='mb-6 text-sm text-gray-500 dark:text-gray-400'>
            {sort === 'add'
              ? '按资源添加时间排序：最近新入库的排在最前面。'
              : '按资源更新时间排序：最新季、最新集排在最前面。'}
            {year === 'this' && '年份：只显示今年首播的作品。'}
            {year === 'last' && '年份：只显示去年首播的作品。'}
            {year === 'older' && '年份：只显示更早年份首播的作品。'}
          </p>

          {error ? (
            <div className='py-16 text-center text-red-500 dark:text-red-400'>
              {error}
            </div>
          ) : loading ? (
            <div className='flex items-start gap-2.5 px-0 sm:px-2'>
              {Array.from({ length: colCount }).map((_, ci) => (
                <div
                  key={ci}
                  className='flex min-w-0 flex-1 flex-col gap-10'
                >
                  {Array.from({ length: 2 }).map((_, index) => (
                    <div key={index} className='w-full'>
                      <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'></div>
                      <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                      <div className='mt-1 h-3 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className='py-16 text-center text-gray-500 dark:text-gray-400'>
              暂无数据
            </div>
          ) : (
            <>
              <div
                ref={gridRef}
                className='flex items-start gap-2.5 px-0 sm:px-2'
              >
                {columns.map((col, ci) => (
                  <div
                    key={ci}
                    ref={(el) => {
                      colElsRef.current[ci] = el;
                    }}
                    className='flex min-w-0 flex-1 flex-col gap-10'
                  >
                    {col.map((idx) => {
                      const item = items[idx];
                      if (!item) return null;
                      return (
                        <div key={`${item.source}-${item.id}`} className='w-full'>
                          <VideoCard
                            from='search'
                            id={item.id}
                            source={item.source}
                            title={item.title}
                            poster={item.poster}
                            episodes={item.episodes.length}
                            source_name={item.source_name}
                            year={item.year}
                            type={tab.cardType}
                            remarks={item.remarks}
                            doubanScore={item.douban_score}
                            imdbScore={item.imdb_score}
                            prefer
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* 无限滚动哨兵 + 状态提示（不再需要点击加载更多） */}
              <div ref={sentinelRef} className='h-2' />
              <div className='mt-6 flex justify-center pb-4'>
                {loadingMore ? (
                  <span className='text-sm text-gray-400'>加载中…</span>
                ) : !hasMore ? (
                  <span className='text-sm text-gray-400'>没有更多了</span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function LatestPage() {
  return (
    <Suspense>
      <LatestPageClient />
    </Suspense>
  );
}
