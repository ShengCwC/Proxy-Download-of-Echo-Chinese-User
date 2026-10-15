# Echo 中国大陆下载加速

正式入口：https://dl.echo.screenshare.cn

通过真实浏览器取得 Echo 官方 Windows 程序，校验数字签名后发布固定版本镜像，交给腾讯云 EdgeOne 缓存和流式分发。无需独立服务器。页面复用 www.screenshare.cn 的浅色、蓝黑视觉和真实 Logo。

## 实际验收

2026-10-15 已通过正式域名完整下载 88,946,336 字节，SHA-256 与独立通过官方浏览器取得的原件完全一致，下载后的 Authenticode 签名有效。单连接首次冷回源耗时 157.05 秒，缓存命中下载耗时 156.19 秒；使用页面相同的 6 路下载模块测得完整下载及哈希校验 6.30 秒（22 个分段请求中 5 次命中缓存、17 次回源）。这是当前电脑和所命中节点的观察，不是中国大陆速度承诺。

真实 Edge 浏览器已验证：粘贴旧的 builds 地址、读取官方专属文件名、并行下载、完整哈希校验、保存文件，以及取消下载。保存后的文件再次独立核对哈希和 Authenticode 签名。页面、两份脚本、样式、Logo 和 favicon 的线上原始字节与本地构建一致。

## 下载方式

- **直接下载镜像**：首页点击“下载镜像文件”，得到通用文件名 `echo.exe`。
- **保留官方专属文件名**：粘贴 `https://dl.echo.ac/<标识>`。如果入口要求浏览器验证，在官方页面完成验证，再复制 `click here` 的链接到本站。首页输入框和辅助输入框都接受 `builds.echo.ac/echo.exe?...`。
- **旧的 builds 地址也可使用**：镜像模式只读取文件名，不再尝试使用过期签名向 Echo 下载文件。文件内容来自页面明确标注的镜像版本。
- 页面提供取链书签：用户在官方页面主动点击书签，带回可见的下载链接，不读取 Cookie，不自动处理验证码。
- 现代浏览器默认使用 6 路并行下载，显示进度、支持取消，全部收齐并通过完整 SHA-256 校验后才保存文件。网络异常时提供普通浏览器下载入口；哈希不符会阻止保存。并行模式在用户浏览器内占用约两份文件大小的内存，关闭页面会中断下载。

镜像不生成或验证 Echo PIN，也不保证 PIN 仍然有效。程序运行时的使用权限由 Echo 判定。通用文件名不承诺自动关联工单；需要专属关联时应使用官方给出的完整文件名。

## 已验证的下载逻辑

1. Echo 原始下载页面返回 HTML，其中 `#dlURL` 是临时文件链接，并通过 JavaScript 自动开始下载。
2. 链接指向 `builds.echo.ac/echo.exe`，使用 AWS SigV4 查询签名。实测有效期为 120 秒；`response-content-disposition` 指定专属文件名。
3. 官方入口与文件站都可能要求 Cloudflare 浏览器验证。EdgeOne 普通回源、Cloudflare Worker 回源及 Cloudflare Browser Run 的云端 Chromium 实测均不能稳定通过；复制签名地址并不能解决文件站验证。
4. 本项目使用真实用户浏览器下载一次官方文件，再分发明确标注日期的快照。云端不依赖共享 Cookie、伪装浏览器或验证码代答。

2026-10-15 获取的文件为 **88,946,336 字节**。Windows Authenticode 验证为 **Valid / Inspect Element Ltd**。SHA-256：

```
19c8b6a7dab8c58a599878faa551053508e74abd6714d624eaf178ce33dbe8d2
```

镜像是当次从 `builds.echo.ac/echo.exe` 获取的文件，并不保证所有产品或未来版本均相同。**官方发布新版本后，需要重新下载、校验并发布；当前没有无人值守通过 CF 的自动同步承诺。** 页面显示镜像同步日期，用户可以选择官方直连获取最新文件。

## 分发架构

```
官方网页 → 真实浏览器下载 → Authenticode / SHA-256 校验
                              ↓
                  GitHub Release 固定哈希版本
                              ↓
                   EdgeOne 固定版本缓存
                              ↓
                dl.echo.screenshare.cn → 用户
```

- 二进制文件以通用名称 `echo.exe` 放在本仓库 Releases，文件不进入 Git 历史；不上传真实 PIN、专属文件名、签名 URL、Cookie 或账号凭据。
- `src/mirror-manifest.json` 固定完整文件 SHA-256、长度、同步日期和源文件地址。
- 冷缓存时 EdgeOne 请求固定 Release，检查状态、类型、长度及 Content-Range；完整 GET 的原生响应流同时写入 Cache API。冷缓存 Range 直接转发且不缓存 206；完整缓存可直接提供 Range。
- 缓存键使用含内容哈希的固定 Release 地址，不含 PIN 或用户文件名；不同用户共用二进制。不能用本函数触发域名做 Cache API 的缓存键，否则 EdgeOne 会返回 `forbidden cdn cache`。最终用户响应带独立 Content-Disposition，保持 private/no-store，避免串文件名。
- 边缘函数直接使用平台原生响应流，不在边缘 JavaScript 中加载或计算整个约 85 MiB 文件。适配 EdgeOne 的 200 ms CPU 限制及没有 Request.signal 的请求。最终的完整哈希校验由用户浏览器完成；普通浏览器下载入口不执行这一步。
- 发布前验证完整哈希、官方数字签名和 GitHub 资产摘要，部署后再次完整下载核对哈希；并非每次下载都在边缘函数计算哈希。信任已校验且不覆盖的 Release 资产，生产更新必须重新走发布校验流程。
- 支持 HEAD、单段 Range、后缀 Range、If-Range、206、416；版本路径固定，续传不会静默拼接不同版本。
- `X-Echo-Mirror-Cache` 表示该次文件请求的缓存状态，不表示所有地区均已预热。缓存仅在当前 EdgeOne 节点有效。
- 禁止公共上传、任意回源或用户提供镜像源。旧的 `/api/resolve`、`/api/import` 与 `/download/*` 保留为实时代理接口，仍由 Echo 验证签名，可能被 CF 阻止；它们与公开镜像的语义独立。

实际速度取决于用户所在节点、缓存状态、套餐和网络。海外单机的验证结果不等于中国大陆全网测速。

## 本地开发和验证

需要 Node.js 22+。

```sh
npm ci
npm run check
npm run dev
```

打开 `http://127.0.0.1:4173`。修改代码后重启开发服务器并刷新浏览器。

```sh
npm run smoke -- --mirror
npm run smoke -- --parallel
```

这两个命令分别使用普通单连接和页面相同的并行模块，从正式域名下载完整镜像到 Git 忽略的 `.local/verified-download.exe`，比对清单中的大小和 SHA-256，输出时长和缓存状态。`BASE_URL` 可用于其他环境。设置 `ECHO_TEST_ENTRY` 后可测试专属入口或 builds 地址；脚本不输出这些地址。

自动测试覆盖原代理的上游限制与签名语义，以及镜像的续传、缓存复用、字节一致性、错误响应拦截、取消、旧地址读取文件名、EdgeOne 兼容性和并行下载的重组与哈希校验。

## 同步新官方版本

在已登录 GitHub CLI 的 Windows 电脑上，需要 PowerShell 7 (`pwsh.exe`)：

1. 使用真实浏览器从官方页面下载新文件，勿运行或修改安装程序。
2. 执行以下命令。脚本要求有效的 Inspect Element Ltd 数字签名，检查 PE 文件前缀和大小，以完整文件哈希前缀创建新的 Release，并核对 GitHub 返回的资产摘要。

```powershell
node scripts/prepare-mirror.mjs 'D:\Downloads\官方下载的文件.exe' --publish
npm run check
```

3. 检查 `src/mirror-manifest.json`，提交源代码后部署 `dist/edgeone.js`。
4. 执行 `npm run smoke -- --mirror`，并核对下载文件的数字签名。

不带 `--publish` 只生成本地清单和 `.local/publish` 发布材料，**不能**把尚未上传的清单部署到生产。相同哈希的 Release 已存在时脚本会停止，不覆盖已有资产。不要用旧文件重新生成日期以声称已同步新版。

回滚时恢复上一份清单和函数代码即可。旧哈希缓存不会污染新版本。删除旧 Release 前应确认已无部署依赖它。

## EdgeOne 部署

`npm run build` 输出 `dist/edgeone.js`（原生函数）、`dist/worker.mjs`（模块适配器）、`dist/handler.mjs`（本地运行时）。运行时没有第三方依赖；构建依赖固定版本 esbuild。

现有站点：`zone-3v9z946rdfuy`；函数：`ef-bunm52g3`；触发规则只匹配 **HOST 等于 `dl.echo.screenshare.cn`**。不要绑定整个主域。独立 HTTPS 证书覆盖该确切域名。

在函数管理中粘贴完整 `dist/edgeone.js` 并保存部署。确认 `/health` 的版本、镜像哈希、正式页面和完整下载。原有 `dl.echo.ac` 源站配置只是平台配置兜底；镜像实际由函数按清单获取。

保持页面、API、用户下载响应遵守 private/no-store；不要在规则引擎强制缓存它们。文件缓存由函数内部 Cache API 管理。发布和更新需关注 EdgeOne 套餐请求及流量用量。

## 接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /`、`GET /<标识>` | 下载页面 |
| `POST /api/mirror` | JSON `{ "url": "<官方入口或 builds 文件地址>" }`；返回镜像版本和专属文件名 |
| `GET/HEAD /mirror/<sha256>/<filename>` | 下载固定快照，公开可访问，不将签名格式当授权 |
| `GET /health` | 代码版本和镜像元数据；不代表所有回源/缓存节点均可用 |
| `POST /api/resolve`、`POST /api/import` | 兼容旧的官方实时代理流程 |
| `GET/HEAD /download/<ticket>` | 实时回源，每次仍由 Echo 校验签名 |

`/api/mirror` 导入的签名 URL 仅是文件名来源，不能验证其真伪或当前授权；不会把它的内容当成新镜像。公开镜像与官方签名时效无关，因此它的 `expiresAt` 为 `null`。需要最新官方程序时应使用官方入口。

所有输入均限定主机、路径、长度及参数，文件名限定安全 ASCII `.exe`。同源 POST 拒绝跨站提交。代码不记录完整链接；云平台访问日志仍可能包含带专属文件名的路径，应按业务要求设置留存。

参考：[EdgeOne Cache API](https://cloud.tencent.com/document/product/1552/81893)、[EdgeOne 流](https://cloud.tencent.com/document/product/1552/81914)、[Cloudflare Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/)、[GitHub Release 资产](https://docs.github.com/en/rest/releases/assets)、[AWS 签名地址](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)。
