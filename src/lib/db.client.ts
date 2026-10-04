/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function */
'use client';

/**
 * 客户端数据库统一出口（barrel）。
 *
 * 原 1599 行上帝模块已按域拆分为 src/lib/db/ 下的子模块，
 * 此处全部重新导出，现有 `from '@/lib/db.client'` 的引用无需改动。
 */
export * from './db/cache';
export * from './db/favorites';
export * from './db/history';
export * from './db/records';
export * from './db/shared';
export * from './db/skip';
