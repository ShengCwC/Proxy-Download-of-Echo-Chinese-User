# Echo 官方文件实时下载加速

目标域名：[dl.echo.screenshare.cn](https://dl.echo.screenshare.cn)。输入有效的 `https://builds.echo.ac/echo.exe?...` 完整地址，实时取得该地址对应的官方文件，通过腾讯云 EdgeOne 转发给用户。页面使用 Screenshare 主站的浅色、蓝黑风格和真实 Logo。

**本分支为 2.0 实时下载版本；正式域名尚未切换。** 部署前仍需在腾讯云开通浏览器回源所需的 SCF 容器读取权限、确认服务协议和费用，并验证该地域实际回源成功。现网 1.3 的固定镜像不能作为本版本的验收结果。

## 下载逻辑与版本保证

1. 用户在官方页面取得带 AWS SigV4 参数的 builds 文件地址，粘贴后立即下载。实测链接有效期约 120 秒，必须保留原始查询参数编码。
2. EdgeOne 校验主机、路径、参数、文件名和有效期，再通过经过鉴权的 HTTPS 接口请求云端 Chrome。云端服务再次校验；只允许访问 `builds.echo.ac/echo.exe`。
3. Chrome 先请求官方文件的 32 字节，核对 Windows 文件头、文件长度和强 ETag。每次提交都请求官方源站，不能从本地清单推断“最新”。
4. 浏览器同时请求最多 4 个 4 MiB 分段。每个分段都携带相同的 `If-Match`，服务端和客户端再次比对 ETag、总长度和 Content-Range；官方更新时停止，不拼接不同版本。
5. 所有分段收齐后才保存，并保留官方签名地址指定的文件名。页面计算本次文件 SHA-256 供识别；它不是官方发布的哈希校验承诺。

所有 API 响应均 `private, no-store`。没有固定镜像、后台同步、历史版本回退或过期签名复用。代码不记录签名 URL、PIN、账号或 Cookie，不长期保存安装程序。官方仍负责校验签名和程序使用权限。

“当前版本”指本次开始下载时官方实际返回的对象，并不保证下载完成后官方不会再次发布新版本。下载过程中检测到版本变化会要求用户重新获取链接。

## 已完成的实际验证

- 2026-10-15 08:44 UTC：普通云端 Chrome 用新生成的签名 URL 完整读取 **88,946,336 字节**，约 **7.48 秒**。同机 Node 普通请求被 Cloudflare 挑战拦截。
- 2026-10-15 09:07 UTC：浏览器回源 HTTP 服务、EdgeOne 同一份处理代码、网页同一份并行下载模块完成整文件传输，约 **10.98 秒**；故意传入错误 ETag 时返回 409，阻止混合版本。
- 两次 SHA-256 均为 `19c8b6a7dab8c58a599878faa551053508e74abd6714d624eaf178ce33dbe8d2`，与此前独立从官方浏览器下载的原件一致。这是验收证据，**没有被写成未来下载的固定清单**。
- Linux amd64 部署容器完成构建，Chrome 与 HTTP 服务启动、鉴权健康检查通过。
- [实际验证运行记录](https://github.com/ShengCwC/Proxy-Download-of-Echo-Chinese-User/actions/runs/38710593725)。测试用临时签名只通过短期 CI Secret 输入，用后已删除。

上述时间来自 GitHub 托管测试机，不是中国大陆速度承诺，也不能替代腾讯云与正式 EdgeOne 节点的部署验收。GitHub Actions 仅执行测试，不承担生产下载。

## 运行与构建

```sh
npm ci
npm test
npm run build
```

输出 `dist/edgeone.js`。开发预览使用 `npm run dev`。Node.js 22 或更高版本。

浏览器回源镜像：

```sh
docker build --platform linux/amd64 -f origin/Dockerfile -t echo-live-origin:2.0.0 .
```

镜像监听 `0.0.0.0:9000`，启动普通可视 Chrome + Xvfb。使用 Node 非 root 用户；容器中 Chrome 使用 `--no-sandbox` 以适配 SCF 的限制，因此必须放在平台隔离的函数实例内，不能作为通用浏览器接口。网络拦截器仅允许指定 Echo 文件路径，无 CDP 公网端口。

运行镜像需设置 `ECHO_ORIGIN_KEY`：32 随机字节的 64 位十六进制字符串。不要提交密钥、将其写入 Docker 镜像，或向前端暴露。`GET /health` 与 `POST /read` 都需 `Authorization: Bearer <key>`。每次仅传输最多 4 MiB，避免让大文件占用单次函数响应；每个浏览器上下文在请求结束时关闭。

## 腾讯云部署清单（尚待开通）

- SCF：建议先测试中国香港 Web 容器函数，内存 2048 MiB、初始化 120 秒、执行 60 秒、临时磁盘 512 MiB，不配置预置实例，不启用日志正文收集。仅使用公网出站，不需要 CFS、COS、VPC 或业务资源角色。
- 服务角色：腾讯云容器部署要求 `SCF_QcsRole` 的 `QcloudAccessForSCFRoleInPullImage`。该授权用于拉取容器部署镜像，**不是存储 Echo 程序的镜像站**。
- 镜像仓库：将构建的服务容器推入腾讯云支持的仓库，使用不可变版本标签或 digest。不要购买企业版仓库作为默认步骤；先检查现有个人版仓库和账号权限。
- Function URL：公网 HTTPS 入口，服务仍验证上述专用鉴权密钥。冷启动和并发容量需要实测；费用预算确认后再确定并发上限。
- EdgeOne 函数配置 `ECHO_ORIGIN_URL`（String，函数 URL 原点）与 `ECHO_ORIGIN_KEY`（Secret），再发布 `dist/edgeone.js`。本地开发使用相同环境变量。
- 所需协议：[腾讯云云函数网络服务协议](https://cloud.tencent.com/document/product/583/59194)。[官方计费](https://cloud.tencent.com/document/product/583/17299)包括计算、调用和响应流量，免费额度不包含 Web 函数响应流量。预算确认不等同于平台硬性停费，需要部署时另行配置可用的额度/告警机制。
- 若腾讯云地域仍触发 CF，不能把固定快照作为替代验收。应继续验证获准的其他地域或停止发布，并如实记录结果。

正式验收：设置 `BASE_URL` 和新生成的 `ECHO_TEST_URL` 后运行 `npm run smoke`。它会从正式域名完整下载到被忽略的 `.local/verified-download.exe`，输出长度、版本和本次哈希，但不输出签名地址。之后独立验证 Authenticode、浏览器实际保存结果和中国大陆线路；通过后才合并和发布 2.0。

旧镜像的实现和验收记录可在 Git 历史 `0de29ce` 中查看，当前版本不再提供旧下载路由。
