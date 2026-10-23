# Echo 官方文件实时下载加速

入口：[dl.echo.screenshare.cn](https://dl.echo.screenshare.cn)。推荐粘贴自己的 `https://dl.echo.ac/<token>` 官方原始下载入口；也兼容有效的 `https://builds.echo.ac/echo.exe?...` 完整地址。实时读取官方当前文件，通过腾讯云 EdgeOne 传输。页面沿用 Screenshare 主站的蓝黑、浅色风格与真实 Logo。

## 下载与版本保证

1. 使用原始入口时，通过 Echo 官方页面使用的 JSON 接口取得 Windows 文件签名，不接受用户账号或 Cookie。直接提交文件地址时保留全部参数与原始编码。官方签名通常有效 120 秒。
2. EdgeOne 与私有云函数分别校验 HTTPS 主机、文件路径、签名格式、时间、文件名及分段范围。入口仅允许 `dl.echo.ac/<token>`，文件仅允许 `builds.echo.ac/echo.exe`；不跟随任意跳转，官方仍校验真正的签名及使用权限。
3. 每次先从官方读取 32 字节，取得强 ETag、长度和修改时间，并检查 Windows 文件头。
4. 同时读取最多 4 个分段，默认每段 4 MiB，以减少短期签名有效期内的请求往返。每段携带同一 `If-Match`，逐一核对 ETag、Content-Range、总长度和实际字节数。临时断流、超时、429 或网关错误最多重试 3 次，并将失败的大段拆小至 512 KiB；本次已完成的分段保留在浏览器内存中。只有完整通过校验的分段计入进度。
5. 收齐全部内容后计算 SHA-256，保留官方地址给出的文件名，再让浏览器保存。页面计算的指纹用于识别此次文件，不是官方发布的哈希承诺。

版本变化、官方拒绝或要求额外验证时立即停止，不自动重试。失效的签名不再发起请求。若用户提供原始入口，签名到期后通过该入口重新从官方取得签名，确认仍是同一对象后自动接续，最多自动更新三次；不从文件名推算或保存用户入口。只提供临时文件地址时，需要手动粘贴新地址接续。每个分段的连接和正文读取共用 55 秒时限，取消与最终失败会终止所有并行请求。

临时故障重试耗尽或链接到期时，保留本次已校验的内容。保持页面打开、粘贴新签名地址后点击“继续下载”，系统重新从官方确认 ETag 与长度：同一对象只补取缺失分段；新版本则清空旧进度重下。保存时使用新链接的官方文件名。刷新页面、点击“放弃”或取消会失去进度；文件不上传到云存储。

所有下载接口均 `private, no-store`。没有固定镜像、定期同步、历史版本回退或过期签名复用。安装程序不落云端磁盘、不进入对象存储，只在本次请求中短暂缓冲有界分段。入口与签名仅保留在当前页面/请求的内存中。下次下载重新联系官方。

“当前版本”指本次开始下载时官方实际返回的对象；官方可能在下载完成后再次发布更新。

## 正式架构

- 中国大陆入口：现有 EdgeOne 免费站点的 `dl.echo.screenshare.cn`，发布 `dist/relay.js`。
- 回源应用：现有 Makers 免费服务中的 `echo-live-origin` 项目，中国香港 Cloud Functions；稳定域名 `echo-origin.screenshare.cn`。
- 公开页面与 API：`makers/edge-functions/` 使用与本地相同的 `src/handler.mjs`。
- 私有回源：`makers/cloud-functions/read.py` 使用锁定版本的 `curl_cffi` 提供浏览器兼容的 TLS/HTTP 请求。专用密钥只在 Makers 环境变量中；入口函数不含密钥。
- 回源使用同步、有界写入回调，不创建逐请求流式后台线程；连接/传输超时为 8/20 秒。Python 云函数执行上限显式设为 60 秒，预留冷启动、编码与平台适配时间。
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

Node.js 22+；正式 Python 运行时 3.10。测试涵盖 URL 白名单、签名过期、范围限制、版本变化、错误正文、并行重组、网络/正文超时、分段补取与缩小、取消及私有接口隔离。

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

### 2.1.0 中断修复验收（2026-10-24，Pacific/Auckland）

- 故障证据：用户截图对应的云函数日志存在 `30000ms` 调用超时；旧下载器实测在约 90% 时收到 `ORIGIN_UNREACHABLE / 502`，83.69 秒后整次失败。原来的 4 MiB 并行下载没有分段重试，临时签名又通常只有 120 秒，长尾请求会将下载拖入过期。
- 修复：明确配置 60 秒云函数执行上限；以同步有界回调代替逐请求流式后台线程；增加正文超时、有限重试、失败分段缩小、准确进度和同版本接续；支持用户提供的原始入口重新获取官方签名。
- 正常整包实测：91,497,632 字节，90.53 秒，三次真实连接错误均自动恢复。默认保留 4 MiB，以减少往返；2 MiB 的浏览器实测因请求更多而在 85% 遇到签名过期，因此只在故障时拆小分段。
- 真实 Edge 验收：粘贴原始入口；在已完成一个分段后向下一请求注入一次 `LINK_EXPIRED / 410`。页面自动重新取链、保持已完成进度，最终完成 100% 校验，文件于 `2026-10-23T13:16:57Z` 实际保存到系统下载目录。
- 浏览器保存文件、加速整包与独立官方直连文件均为上述长度，SHA-256 均为 `b2d6e3234fdbf73e1da6ff1dad7173f386721230592e24de4abc2af359ce760f`；Windows Authenticode 为 `Valid / Inspect Element Ltd`。未运行安装程序。
- 40 项 Node 测试、6 项 Python 3.10 测试通过。正式页面、脚本、样式、Logo 与构建字节一致；私有接口未鉴权访问、旧接口与非白名单地址均被拒绝。故障注入已清除。

本节哈希只记录本次实际取得的版本，没有写入未来下载的固定清单。执行时限配置参考 [Makers 官方说明](https://pages.edgeone.ai/document/cloud-functions)，当前 CLI 使用 `cloudFunctions.maxDuration` 与 `cloudFunctions.regions.overseas` 字段。

2026-10-15，腾讯云 Makers 香港回源与完整网页传输模块实际取得 **88,946,336 字节**：私有线路验证约 **33.26 秒**；经公开页面 API 的完整链路验证约 **29.96 秒**。错误 ETag 返回 409。

SHA-256：`19c8b6a7dab8c58a599878faa551053508e74abd6714d624eaf178ce33dbe8d2`。与独立官方浏览器下载原件一致，Windows Authenticode 为 **Valid / Inspect Element Ltd**。此数值只作为本次验收记录，没有写进未来下载的固定清单。

正式域名已部署 2.0.0。2026-10-15 11:04:55 UTC 开始的完整下载验收用时 **40.44 秒**，字节数与 SHA-256 同上，Authenticode 有效。在线页面、脚本、Logo、favicon 的原始字节哈希与构建源码一致；私有接口、旧镜像路径及非白名单地址均已验证拒绝。

同日 11:08 UTC 在真实 Edge 浏览器中粘贴新链接并点击下载，页面完成 100% 校验，文件实际保存到系统下载目录；重新读取磁盘文件所得长度、SHA-256 与上述原件一致，Authenticode 为 Valid。没有运行安装程序。最终验证包含 29 项 Node 测试及 2 组 Python 协议测试。

以上耗时来自当前测试网络，不等于中国大陆各运营商速度保证。

早期真实 Chromium 全链路验证可见 [GitHub 测试记录](https://github.com/ShengCwC/Proxy-Download-of-Echo-Chinese-User/actions/runs/38710593725)。GitHub Actions 仅执行测试，不承担生产下载。旧固定镜像仅存在于 Git 历史，2.0 不再提供该下载路径。
