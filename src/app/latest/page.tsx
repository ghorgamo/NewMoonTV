/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

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

function LatestPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get('type') || 'tv';
  const tab = TABS.find((t) => t.type === typeParam) || TABS[1];

  const [genre, setGenre] = useState<string>('all');
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
        `/api/latest?category=${tab.category}&genre=${genre}&limit=${PAGE_LIMIT}&pg=${pg}`
      );
      if (!res.ok) throw new Error('栏目数据请求失败');
      const data = await res.json();
      return (data.results || []) as SearchResult[];
    },
    [tab.category, genre]
  );

  // 跨页去重：同一作品只留一条（接口内已按页去重，这里防跨页重复）
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
        setItems(takeFresh(results));
        setHasMore(results.length >= PAGE_LIMIT);
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
  }, [fetchPage, takeFresh]);

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
      // 合并后整体仍按更新时间倒序
      setItems((prev) =>
        [...prev, ...fresh].sort((a, b) =>
          (b.update_time || '').localeCompare(a.update_time || '')
        )
      );
      // 整页都是已见过的重复条目时同样视为到底，避免无限空转
      setHasMore(results.length >= PAGE_LIMIT && fresh.length > 0);
    } catch {
      // 加载失败保持现状，继续滚动可再次触发
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, loading, fetchPage, takeFresh]);

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

          <p className='mb-6 text-sm text-gray-500 dark:text-gray-400'>
            按资源更新时间排序：最新季、最新集排在最前面。
          </p>

          {error ? (
            <div className='py-16 text-center text-red-500 dark:text-red-400'>
              {error}
            </div>
          ) : loading ? (
            <div className='columns-3 gap-2 px-0 sm:px-2 sm:columns-4 sm:gap-8 lg:columns-5 xl:columns-6 2xl:columns-7'>
              {Array.from({ length: 12 }).map((_, index) => (
                <div key={index} className='mb-12 w-full break-inside-avoid sm:mb-20'>
                  <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'></div>
                  <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className='py-16 text-center text-gray-500 dark:text-gray-400'>
              暂无数据
            </div>
          ) : (
            <>
              <div className='columns-3 gap-2 px-0 sm:px-2 sm:columns-4 sm:gap-8 lg:columns-5 xl:columns-6 2xl:columns-7'>
                {items.map((item) => (
                  <div
                    key={`${item.source}-${item.id}`}
                    className='mb-12 w-full break-inside-avoid sm:mb-20'
                  >
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
                    />
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
