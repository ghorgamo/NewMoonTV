# MoonTV 代码优化说明

本次优化覆盖安全、性能、工程质量三方面，共 15 项。已通过 `pnpm typecheck`、`pnpm lint`（0 warning）与 `pnpm build` 验证。

> 升级注意：旧版登录 cookie（含明文密码 / 旧签名格式）会失效，用户需重新登录一次。

## P0 · 安全修复

1. **登录 cookie 去明文密码**（`src/app/api/login/route.ts`、`src/middleware.ts`）
   - 原来 localStorage 模式把用户输入的明文密码直接写进 `auth` cookie（且 `httpOnly: false`），XSS 即可窃取站长密码。
   - 现改为只签发 HMAC-SHA256 签名（签名绑定 `标识:时间戳`），middleware 改验签；新增 7 天签发过期校验。
2. **`/api/image-proxy` 防 SSRF**（`src/app/api/image-proxy/route.ts`）
   - 原来 `?url=` 任意地址直接 fetch，可被用作内网探测跳板。
   - 现仅允许 `http/https`、无 userinfo、非 IP 字面量、域名白名单（默认 `*.doubanio.com`，可用环境变量 `IMAGE_PROXY_ALLOWLIST` 追加）；重定向手动跟随且每跳重新校验；仅代理 `image/*` 内容。
3. **`/api/cron` 加鉴权**（`src/app/api/cron/route.ts`）
   - 原来无鉴权且被 middleware 放行，任意调用触发全用户数据刷新。
   - 现配置 `CRON_SECRET` 环境变量后，要求 `Authorization: Bearer <CRON_SECRET>`；未配置时放行但打印警告。

## P1 · 性能优化

4. **播放页大库懒加载**（`src/app/play/page.tsx`、`src/lib/utils.ts`）
   - `artplayer` + `hls.js`（合计约 200KB+）由静态导入改为 `import()` 懒加载，不再进入 `/play` 首屏 bundle；`utils.ts` 的 `getVideoResolutionFromM3u8` 同理。
   - 构建产物确认：`/play` 首屏 JS 13.3 kB，播放器库拆分为独立 chunk 按需加载。
5. **播放器实例泄漏修复**（`src/app/play/page.tsx`）
   - 新增组件卸载时清理 effect：销毁 Artplayer 实例与 HLS 实例（`video.hls.destroy()`），防止离开页面后后台继续拉流/占用内存。
6. **admin 页 DraggableRow 提升到模块顶层**（`src/app/admin/page.tsx`）
   - 原来两个 `DraggableRow` 定义在组件函数内部，每次渲染生成新组件类型导致整表卸载重挂（输入失焦、拖拽抖动）。
   - 现为模块级 `memo` 组件（`SourceDraggableRow` / `CategoryDraggableRow`），回调经 props 传入，相关 handler 用 `useCallback` 包裹。
7. **图片加载优化**（`src/components/VideoCard.tsx`）
   - `next/image` 补 `sizes="(max-width: 640px) 33vw, (max-width: 1280px) 20vw, 180px"` 与显式 `loading="lazy"`。
   - 注：`next.config.js` 仍保留 `images.unoptimized: true`（兼顾 Docker / Cloudflare 等部署目标），开启优化器后 `sizes` 即可生效。
8. **播放页拆分**（`src/app/play/page.tsx` 1987 行 → 1742 行 + 3 个模块）
   - `src/app/play/lib/adBlock.ts`：`filterAdsFromM3U8` + `createAdBlockHlsLoader`
   - `src/app/play/lib/sourcePrefer.ts`：`preferBestSource` + `calculateSourceScore`（纯函数，可单测）
   - `src/app/play/lib/videoSource.ts`：`ensureVideoSource` + `formatTime`

## P2 · 工程质量

9. **删除 9 个零引用依赖**（`package.json`）：`framer-motion`、`swiper`、`@vidstack/react`、`vidstack`、`media-icons`、`react-icons`、`@heroicons/react`、`@headlessui/react`、`zod`。部署后执行一次 `pnpm install` 即可同步清理 `pnpm-lock.yaml`。
10. **console 清理**：删除 `console.log(videoUrl)`（播放地址含时效签名，不应出现在浏览器控制台）与 `/api/server-config` 的请求日志；`next.config.js` 新增 `compiler.removeConsole`（生产构建剥离 `log/info/debug`，保留 `error/warn`）。
11. **搜索接口加固**（`src/app/api/search/route.ts`）：`q` 参数限长 50 字符并 trim，防止超长 query 扇出到全部上游源。
12. **黄暴词过滤去重**（`src/app/search/page.tsx`）：删除客户端重复过滤，以服务端 `/api/search` 的过滤为准，避免两份逻辑分叉。
13. **`db.client.ts` 按域拆分**（1599 行上帝模块 → `src/lib/db/`）
    - `shared.ts`（类型/常量/缓存管理器/请求辅助）、`records.ts`（播放记录）、`history.ts`（搜索历史）、`favorites.ts`（收藏）、`cache.ts`（缓存辅助）、`skip.ts`（跳过配置）。
    - `src/lib/db.client.ts` 保留为 barrel（`export *`），现有 `from '@/lib/db.client'` 引用无需改动。

## 未动项（有意保留）

- `reactStrictMode: false`、`images.unoptimized: true`：涉及部署行为，未改。
- 各文件头的 `eslint-disable`：未动未改动的文件，避免引入噪音。
- `pnpm-lock.yaml`：需在你的环境执行 `pnpm install` 后自动更新（已从 `package.json` 移除的 9 个包会被 pruning）。
