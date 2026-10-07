/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

'use client';

import { RefreshCw } from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';

// 客户端收藏 API
import {
  clearAllFavorites,
  getAllFavorites,
  getAllPlayRecords,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { SearchResult } from '@/lib/types';

import CapsuleSwitch from '@/components/CapsuleSwitch';
import ContinueWatching from '@/components/ContinueWatching';
import PageLayout from '@/components/PageLayout';
import ScrollableRow from '@/components/ScrollableRow';
import { useSite } from '@/components/SiteProvider';
import VideoCard from '@/components/VideoCard';

// 最新更新栏目区块：数据来自 /api/latest（资源站按更新时间倒序），卡片点击直达播放页
function LatestSection({
  title,
  items,
  loading,
  type,
}: {
  title: string;
  items: SearchResult[];
  loading: boolean;
  type: string;
}) {
  return (
    <section className='mb-8'>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
          {title}
        </h2>
      </div>
      <ScrollableRow>
        {loading
          ? Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
              >
                <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'>
                  <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                </div>
                <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
              </div>
            ))
          : items.map((item) => (
              <div
                key={`${item.source}-${item.id}`}
                className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
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
                  type={type}
                />
              </div>
            ))}
      </ScrollableRow>
    </section>
  );
}

function HomeClient() {
  const [activeTab, setActiveTab] = useState<'home' | 'favorites'>('home');
  const [hotMovies, setHotMovies] = useState<SearchResult[]>([]);
  const [hotTvShows, setHotTvShows] = useState<SearchResult[]>([]);
  const [hotVarietyShows, setHotVarietyShows] = useState<SearchResult[]>([]);
  const [hotAnime, setHotAnime] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { announcement } = useSite();

  const [showAnnouncement, setShowAnnouncement] = useState(false);

  // 检查公告弹窗状态
  useEffect(() => {
    if (typeof window !== 'undefined' && announcement) {
      const hasSeenAnnouncement = localStorage.getItem('hasSeenAnnouncement');
      if (hasSeenAnnouncement !== announcement) {
        setShowAnnouncement(true);
      } else {
        setShowAnnouncement(Boolean(!hasSeenAnnouncement && announcement));
      }
    }
  }, [announcement]);

  // 收藏夹数据
  type FavoriteItem = {
    id: string;
    source: string;
    title: string;
    poster: string;
    episodes: number;
    source_name: string;
    currentEpisode?: number;
    search_title?: string;
  };

  const [favoriteItems, setFavoriteItems] = useState<FavoriteItem[]>([]);

  // 获取最新更新栏目数据（资源站分类列表按更新时间倒序，最新季/最新集在前）
  const fetchLatestData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const fetchCategory = async (category: string) => {
        const res = await fetch(`/api/latest?category=${category}&limit=18`);
        if (!res.ok) throw new Error('栏目数据请求失败');
        const data = await res.json();
        return (data.results || []) as SearchResult[];
      };

      const results = await Promise.allSettled([
        fetchCategory('movie'),
        fetchCategory('tv'),
        fetchCategory('variety'),
        fetchCategory('anime'),
      ]);

      const [moviesRes, tvRes, varietyRes, animeRes] = results;

      let successCount = 0;

      if (moviesRes.status === 'fulfilled') {
        setHotMovies(moviesRes.value);
        successCount++;
      }

      if (tvRes.status === 'fulfilled') {
        setHotTvShows(tvRes.value);
        successCount++;
      }

      if (varietyRes.status === 'fulfilled') {
        setHotVarietyShows(varietyRes.value);
        successCount++;
      }

      if (animeRes.status === 'fulfilled') {
        setHotAnime(animeRes.value);
        successCount++;
      }

      // 如果全部请求失败，抛出错误提示
      if (successCount === 0) {
        setError('获取最新更新数据失败，请稍后重试');
      }
    } catch (err) {
      console.error('获取最新更新数据失败:', err);
      setError('网络连接异常或服务暂不可用');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLatestData();
  }, [fetchLatestData]);

  // 处理收藏数据更新的函数
  const updateFavoriteItems = async (allFavorites: Record<string, any>) => {
    const allPlayRecords = await getAllPlayRecords();

    // 根据保存时间排序（从近到远）
    const sorted = Object.entries(allFavorites)
      .sort(([, a], [, b]) => b.save_time - a.save_time)
      .map(([key, fav]) => {
        const plusIndex = key.indexOf('+');
        const source = key.slice(0, plusIndex);
        const id = key.slice(plusIndex + 1);

        // 查找对应的播放记录，获取当前集数
        const playRecord = allPlayRecords[key];
        const currentEpisode = playRecord?.index;

        return {
          id,
          source,
          title: fav.title,
          year: fav.year,
          poster: fav.cover,
          episodes: fav.total_episodes,
          source_name: fav.source_name,
          currentEpisode,
          search_title: fav?.search_title,
        } as FavoriteItem;
      });
    setFavoriteItems(sorted);
  };

  // 当切换到收藏夹时加载收藏数据
  useEffect(() => {
    if (activeTab !== 'favorites') return;

    const loadFavorites = async () => {
      const allFavorites = await getAllFavorites();
      await updateFavoriteItems(allFavorites);
    };

    loadFavorites();

    // 监听收藏更新事件
    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (newFavorites: Record<string, any>) => {
        updateFavoriteItems(newFavorites);
      }
    );

    return unsubscribe;
  }, [activeTab]);

  const handleCloseAnnouncement = (announcement: string) => {
    setShowAnnouncement(false);
    localStorage.setItem('hasSeenAnnouncement', announcement); // 记录已查看弹窗
  };

  return (
    <PageLayout>
      <div className='px-2 sm:px-10 py-4 sm:py-8 overflow-visible'>
        {/* 顶部 Tab 切换 */}
        <div className='mb-8 flex justify-center'>
          <CapsuleSwitch
            options={[
              { label: '首页', value: 'home' },
              { label: '收藏夹', value: 'favorites' },
            ]}
            active={activeTab}
            onChange={(value) => setActiveTab(value as 'home' | 'favorites')}
          />
        </div>

        <div className='max-w-[95%] mx-auto'>
          {activeTab === 'favorites' ? (
            // 收藏夹视图
            <section className='mb-8'>
              <div className='mb-4 flex items-center justify-between'>
                <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                  我的收藏
                </h2>
                {favoriteItems.length > 0 && (
                  <button
                    className='text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                    onClick={async () => {
                      await clearAllFavorites();
                      setFavoriteItems([]);
                    }}
                  >
                    清空
                  </button>
                )}
              </div>
              <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                {favoriteItems.map((item) => (
                  <div key={item.id + item.source} className='w-full'>
                    <VideoCard
                      query={item.search_title}
                      {...item}
                      from='favorite'
                      type={item.episodes > 1 ? 'tv' : ''}
                    />
                  </div>
                ))}
                {favoriteItems.length === 0 && (
                  <div className='col-span-full text-center text-gray-500 py-8 dark:text-gray-400'>
                    暂无收藏内容
                  </div>
                )}
              </div>
            </section>
          ) : (
            // 首页视图
            <>
              {/* 继续观看 */}
              <ContinueWatching />

              {/* 全局加载失败提示 */}
              {error && (
                <div className='mb-8 flex flex-col items-center justify-center rounded-xl bg-red-50 p-6 dark:bg-red-950/30 text-center'>
                  <p className='text-sm text-red-600 dark:text-red-400 mb-3'>{error}</p>
                  <button
                    onClick={fetchLatestData}
                    className='inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors'
                  >
                    <RefreshCw className='w-4 h-4 mr-2 animate-spin-hover' />
                    重新加载数据
                  </button>
                </div>
              )}

              <LatestSection
                title='最新电影'
                items={hotMovies}
                loading={loading}
                type='movie'
              />
              <LatestSection
                title='最新剧集'
                items={hotTvShows}
                loading={loading}
                type='tv'
              />
              <LatestSection
                title='最新综艺'
                items={hotVarietyShows}
                loading={loading}
                type='tv'
              />
              <LatestSection
                title='最新动漫'
                items={hotAnime}
                loading={loading}
                type='tv'
              />
            </>
          )}
        </div>
      </div>
      {announcement && showAnnouncement && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm dark:bg-black/70 p-4 transition-opacity duration-300 ${
            showAnnouncement ? '' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className='w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900 transform transition-all duration-300 hover:shadow-2xl'>
            <div className='flex justify-between items-start mb-4'>
              <h3 className='text-2xl font-bold tracking-tight text-gray-800 dark:text-white border-b border-green-500 pb-1'>
                提示
              </h3>
              <button
                onClick={() => handleCloseAnnouncement(announcement)}
                className='text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-white transition-colors'
                aria-label='关闭'
              ></button>
            </div>
            <div className='mb-6'>
              <div className='relative overflow-hidden rounded-lg mb-4 bg-green-50 dark:bg-green-900/20'>
                <div className='absolute inset-y-0 left-0 w-1.5 bg-green-500 dark:bg-green-400'></div>
                <p className='ml-4 text-gray-600 dark:text-gray-300 leading-relaxed'>
                  {announcement}
                </p>
              </div>
            </div>
            <button
              onClick={() => handleCloseAnnouncement(announcement)}
              className='w-full rounded-lg bg-gradient-to-r from-green-600 to-green-700 px-4 py-3 text-white font-medium shadow-md hover:shadow-lg hover:from-green-700 hover:to-green-800 dark:from-green-600 dark:to-green-700 dark:hover:from-green-700 dark:hover:to-green-800 transition-all duration-300 transform hover:-translate-y-0.5'
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </PageLayout>
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeClient />
    </Suspense>
  );
}
