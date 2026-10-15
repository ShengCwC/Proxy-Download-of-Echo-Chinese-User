# Echo 中国大陆下载加速

为 `https://dl.echo.screenshare.cn` 编写的 EdgeOne 下载网关。接收 Echo 原始下载链接，解析官方短期签名地址，通过边缘函数流式转发原始安装程序。

## 使用

- 打开首页，粘贴 `https://dl.echo.ac/<链接标识>`。
- 也可直接将原始链接的域名改为 `dl.echo.screenshare.cn`，保留路径。
- 获取地址后点击下载。完整保留 Echo 指定的文件名。
- 如果入口要求 Cloudflare 验证，打开 Echo 官方页面完成验证，复制 `click here` 按钮的链接，粘贴到“临时文件地址”。也可使用页面提供的取链书签。
- 如果**文件服务**同样要求浏览器验证，网关明确提示并提供官方直连，不把验证页保存成 `.exe`。

这是独立下载加速服务，与 Echo 无隶属关系。只支持已验证的 `dl.echo.ac → builds.echo.ac/echo.exe` 链路，不替用户生成 PIN，也不访问 Echo 账户 API。

## 本地开发

需要 Node.js 22 或更新版本。

```sh
npm ci
npm test
npm run dev
```

浏览器打开 `http://127.0.0.1:4173`。默认只监听本机。

```sh
npm run build
```

输出：

| 文件 | 用途 |
| --- | --- |
| `dist/edgeone.js` | EdgeOne 原生边缘函数，直接粘贴部署 |
| `dist/worker.mjs` | 标准模块 Worker 适配器，供其他兼容环境使用 |
| `dist/handler.mjs` | 本地 Web Request / Response 处理器 |

运行时无第三方依赖；构建使用固定版本的 esbuild。源代码、构建锁文件和测试保存在本仓库；第三方安装程序不入库。

## EdgeOne 部署

1. 在已备案域名 `screenshare.cn` 的 EdgeOne 站点中添加 `dl.echo.screenshare.cn`，加速区域包含中国大陆。为该确切域名配置 HTTPS 证书；`*.screenshare.cn` 证书不覆盖 `dl.echo.screenshare.cn`。
2. 源站设置为 `dl.echo.ac`，HTTPS 回源，回源 Host 使用 `dl.echo.ac`。源站仅作为配置要求的兜底；正常请求由函数处理。
3. 新建独立边缘函数，将 `dist/edgeone.js` 的完整内容粘贴并部署。
4. 新建触发规则：**HOST 等于 `dl.echo.screenshare.cn`，所有路径**。不要将函数绑定到整个 `screenshare.cn` 站点。
5. 对此 HOST 关闭强制节点缓存、状态码缓存和离线缓存，遵守函数返回的 `private, no-store`。不要忽略签名参数后缓存整个下载响应。
6. 配置 DNS 为 EdgeOne 控制台分配的 CNAME。不要在另一层 CDN 再启用代理。
7. 在此域名范围配置平台请求频率及流量告警，避免影响站点其他业务。上线前验证 HTTPS、`/health`、获取链接、完整下载与失败恢复。

部署不需要 Echo API Key、浏览器 Cookie或网关签名密钥。函数默认访问域名同样执行严格上游限制与官方鉴权。

## Cloudflare 验证与设计边界

1. **自动模式**：函数获取官方入口 HTML，读取 `#dlURL` 或 JSON 字符串形式的下载地址，再请求文件。
2. **浏览器辅助模式**：用户在 Echo 官方页面完成验证后，将该页面已经提供的短期文件地址交给网关。书签仅读取 `#dlURL`，使用 URL fragment 带回本站；页面立即移除 fragment，再以同源 POST 提交。书签不读取 Cookie，不解决验证码，不改变 Echo 的权限。
3. **文件服务验证**：如果 `builds.echo.ac` 对边缘出口也返回验证页，浏览器辅助取链不能解决文件回源。需要 Echo 提供受信任回源接口，或用户使用官方直连。产品不会显示虚假的“加速成功”。

本地浏览器可以访问，不代表任意服务端出口都能访问；必须测试部署地区的实际请求。即使回源成功，未缓存转发的速度仍受回源链路限制，不承诺固定倍数提速。

## 安全与正确性

- 仅允许固定 HTTPS 上游主机和文件路径；拒绝用户信息、非标准端口、额外入口参数、重复签名参数和跨域跳转。不是通用 URL 代理。
- 客户端 Cookie、Authorization、Referer 等不会发送给 Echo。代码不记录完整下载链接或查询字符串。
- `/download/<ticket>` 的 ticket 是地址编码，**不是签名，也不是独立授权凭据**。签名格式及时间检查只用于提前报错；每次下载始终回到 Echo，由 Echo 验证真正的签名。
- 所有响应禁止共享缓存。过期或伪造的签名不能命中本地缓存取得文件。云平台访问日志仍可能包含下载路径，生产环境应按敏感凭据设置脱敏及留存。
- 不执行上游网页脚本；不转发上游 HTML、Cookie 或跳转。对文件响应检查状态、类型、分段字段和从零开始的 `MZ` 文件前缀。前缀检查不等同于病毒检测或数字签名验证。
- 支持单段 Range、If-Range、206 和 416。HEAD 以 GET `bytes=0-0` 向源站查询，避免将 GET 签名误用于 HEAD。
- 未开始输出的完整下载遇到过期/拒绝时，可以重新解析原入口一次。分段下载不自动换新文件，避免不同版本拼接。
- 采用背压流式传输；用户取消时取消上游读取。25 秒响应头超时、120 秒读取空闲超时；不将整个安装包读入内存。
- 原始下载文件名必须保留；不改写安装包字节，不提供未经更新校验的长期镜像。

未来若增加跨用户文件缓存，需要先落实可验证的授权入口、版本键、逐请求文件名、过期语义及缓存前鉴权，不能只删除 `X-Amz-*` 参数合并缓存。

## 接口

| 方法与路径 | 含义 |
| --- | --- |
| `GET /` | 下载页 |
| `GET /<链接标识>` | 自动解析该 Echo 入口的下载页 |
| `POST /api/resolve` | JSON `{ "url": "https://dl.echo.ac/<标识>" }` |
| `POST /api/import` | JSON `{ "url": "<完整官方签名地址>", "entry": "<可选原入口>" }` |
| `GET /download/<ticket>` | 流式转发；官方验证签名 |
| `HEAD /download/<ticket>` | 查询文件元信息 |
| `GET /health` | 版本和运行状态；不承诺上游可用 |

解析接口返回 `filename`、`expiresAt`、`download` 和可用时的 `entry`。错误响应包含稳定的 `code`、用户可读 `message` 和出错阶段 `stage`。文件下载错误返回明确的恢复页面，绝不使用附件响应头。

## 验证依据

2026-10-15 的分析观察到：入口返回 HTML，并通过 JavaScript 导航到 `builds.echo.ac/echo.exe`；示例文件地址有效期为 120 秒。同一入口两次下载的文件均为 88,946,336 字节，SHA-256 一致，Windows 验证显示 Inspect Element Ltd 签名有效。该结果不等同于所有 PIN、产品和未来版本都共享相同文件。

测试采用人工构造的非敏感链接，不包含用户的真实 PIN 或签名。运行 `npm test` 验证解析、上游边界、挑战识别、过期恢复、分段语义、流式取消及端到端路由。

`npm run smoke` 检查生产健康端点。设置环境变量 `ECHO_TEST_ENTRY` 后还会实际下载文件到被 Git 忽略的 `.local/verified-download.exe`，输出长度和 SHA-256；可用 `EXPECTED_SHA256` 指定独立取得的官方文件哈希。`BASE_URL` 可覆盖测试站点。脚本不会输出原始链接、文件名或临时签名。

参考：[EdgeOne Fetch](https://cloud.tencent.com/document/product/1552/81897)、[EdgeOne Range GETs](https://edgeone.ai/document/46966)、[AWS 签名地址](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)、[Echo API](https://developer.echo.ac/register/)。
