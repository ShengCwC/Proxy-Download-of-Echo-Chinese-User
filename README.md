# Echo 官方文件实时下载加速

入口：[dl.echo.screenshare.cn](https://dl.echo.screenshare.cn)。粘贴有效的 `https://builds.echo.ac/echo.exe?...` 完整地址，实时读取官方当前文件，通过腾讯云 EdgeOne 传输。页面沿用 Screenshare 主站的蓝黑、浅色风格与真实 Logo。

## 下载与版本保证

1. 保留签名地址的全部参数及原始编码。官方实测链接通常有效 120 秒，粘贴后立即开始下载。
2. EdgeOne 与私有云函数分别校验 HTTPS 主机、文件路径、签名格式、时间、文件名及分段范围。仅允许 `builds.echo.ac/echo.exe`；官方仍校验真正的签名及使用权限。
3. 每次先从官方读取 32 字节，取得强 ETag、长度和修改时间，并检查 Windows 文件头。
4. 同时读取最多 4 个 4 MiB 分段。每段携带同一 `If-Match`，逐一核对 ETag、Content-Range、总长度和实际字节数。更新、过期或中断时停止，绝不拼接不同版本。
5. 收齐全部内容后计算 SHA-256，保留官方地址给出的文件名，再让浏览器保存。页面计算的指纹用于识别此次文件，不是官方发布的哈希承诺。

所有下载接口均 `private, no-store`。没有固定镜像、定期同步、历史版本回退或过期签名复用。安装程序不落云端磁盘、不进入对象存储，只在本次请求中短暂缓冲有界分段。下次下载重新联系官方。

“当前版本”指本次开始下载时官方实际返回的对象；官方可能在下载完成后再次发布更新。

## 正式架构

- 中国大陆入口：现有 EdgeOne 免费站点的 `dl.echo.screenshare.cn`，发布 `dist/relay.js`。
- 回源应用：现有 Makers 免费服务中的 `echo-live-origin` 项目，中国香港 Cloud Functions；稳定域名 `echo-origin.screenshare.cn`。
- 公开页面与 API：`makers/edge-functions/` 使用与本地相同的 `src/handler.mjs`。
- 私有回源：`makers/cloud-functions/read.py` 使用锁定版本的 `curl_cffi` 提供浏览器兼容的 TLS/HTTP 请求。专用密钥只在 Makers 环境变量中；入口函数不含密钥。
- 私有接口通过 JSON/base64 返回一个分段，边缘函数校验后恢复二进制 206。这样避免 Makers 对原始 206 的改写，不会将平台错误页保存成 exe。

真实可视 Chromium 已验证能读取官方文件，但免费沙箱的中转链路无法稳定完成整包。正式实现使用上述已完成整包实测的轻量请求方式，不运行长期浏览器，不消耗模型额度。若官方未来修改防护规则，接口会明确报错，不拿旧文件替代。

平台默认 `edgeone.dev` 域名在中国大陆存在预览有效期限制，因此正式入口必须使用自有回源域名。

## 费用边界

本次仅使用 Makers 与 EdgeOne 已有免费服务。未购买套餐、未创建独立计费 SCF、未购买服务器、未开通付费模型或对象存储。免费服务受平台配额与后续产品政策约束，不代表无限容量。

参考：[Makers 定价](https://pages.edgeone.ai/zh/pricing)、[Cloud Functions 限制](https://pages.edgeone.ai/document/cloud-functions)、[默认域名限制](https://cloud.tencent.com/document/product/1552/127403)。

## 构建、测试与发布

```sh
npm ci
npm run check
python -m unittest discover -s test -p '*_test.py'
```

Node.js 22+；正式 Python 运行时 3.10。测试涵盖 URL 白名单、签名过期、范围限制、版本变化、错误正文、并行重组和私有接口隔离。

Makers 项目仅需生产环境变量 `ECHO_ORIGIN_KEY`，为 32 随机字节编码的 64 位十六进制专用密钥。不要提交密钥、签名地址或安装程序；本地测试产物放入已忽略的 `.local/`。

在仓库根目录安装依赖后，从 `makers/` 发布：

```sh
npx edgeone makers deploy -n echo-live-origin --area overseas --skip-ai-gateway-sync
```

`edgeone.json` 锁定香港地域。部署会打包 Python Linux 依赖，并从同一源代码生成页面与 API。不要启用 Agent 或模型密钥同步。

发布顺序：先部署 Makers，验证自有回源域名 `/health` 的 `mode=live-origin` 与 `configured=true`，使用新签名跑完整下载；再将 `npm run build` 生成的 `dist/relay.js` 发布到现有 EdgeOne 函数。验证正式域名后再将代码合并到主分支。

```sh
# BASE_URL 为待验证域名；ECHO_TEST_URL 为新取得的完整官方签名地址
npm run smoke
```

真实测试保存 `.local/verified-download.exe`，仅输出长度、版本、用时和 SHA-256，不打印签名地址。应另行校验 Authenticode，并在浏览器实际完成一次保存。不要执行下载的安装程序作为验收步骤。

`dist/edgeone.js` 是可直接配置私有回源 URL/密钥的替代构建，正式部署采用不含密钥的 `dist/relay.js`。`origin/` 中的 Chrome 容器保留为独立环境的参考实现，未部署为付费服务。

## 实测证据

2026-10-15，腾讯云 Makers 香港回源与完整网页传输模块实际取得 **88,946,336 字节**：私有线路验证约 **33.26 秒**；经公开页面 API 的完整链路验证约 **29.96 秒**。错误 ETag 返回 409。

SHA-256：`19c8b6a7dab8c58a599878faa551053508e74abd6714d624eaf178ce33dbe8d2`。与独立官方浏览器下载原件一致，Windows Authenticode 为 **Valid / Inspect Element Ltd**。此数值只作为本次验收记录，没有写进未来下载的固定清单。

以上耗时来自当前测试网络，不等于中国大陆各运营商速度保证。正式域名的最终验收数据在发布时补充。

早期真实 Chromium 全链路验证可见 [GitHub 测试记录](https://github.com/ShengCwC/Proxy-Download-of-Echo-Chinese-User/actions/runs/38710593725)。GitHub Actions 仅执行测试，不承担生产下载。旧固定镜像仅存在于 Git 历史，2.0 不再提供该下载路径。
