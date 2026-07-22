# 拼好歌 后端服务框架(Cloudflare Workers)

这是一个用 Cloudflare Workers + QuickJS（quickjs-ng.wasm）构建的拼好歌后端服务框架，支持动态执行用户导入的音源脚本插件。本项目不提供音乐数据，数据全部由用户自行导入的脚本返回。此项目参考洛雪音乐源码编写，兼容洛雪音乐第三方音源脚本生态（小部分不兼容）。本项目代码开源且免费，如付费使用，建议申请退款。

**当前版本：v1.0.10 (versionCode: 10010)**

## 关联项目

- **拼好歌小程序端** - [phg-music](https://github.com/erikjamesgz/phg-music)
- **Deno Deploy 平台后端服务器** - [dn-phg-music-server](https://github.com/erikjamesgz/dn-phg-music-server)

## 部署指南

### GitHub Fork + Cloudflare 一键连接部署

> 如果部署不明白，可以参考这个 [视频教程](https://www.youtube.com/watch?v=vf6U46f--6w\&t=681s)（步骤和原理类似，参数需改成拼好歌对应的值）

#### 第 1 步：Fork 本项目

1. GitHub 打开 <https://github.com/erikjamesgz/cf_phg_music_server>
2. 点击右上角 **Fork** 按钮 → 确认创建

#### 第 2 步：登录 Cloudflare 并授权 GitHub

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 登录
2. 左侧菜单 → **Workers 和 Pages**
3. 页面右上角点击 **创建应用程序**
4. 选择 "Connect GitHub"（不是"创建Worker"！）
5. 首次使用会提示授权 GitHub 账号 → 点击 **Connect GitHub** → 授权 Cloudflare 访问你的 GitHub
6. 授权后，选择 "Continue with GitHub"
7. 在仓库列表中选择你刚 **Fork** 的 `cf_phg_music_server` 仓库
8. 然后下一步 ，项目名字填"`cf-phg-music-server`"（不能有下划线）
9. 然后点击 **"部署"**

#### 第 3 步：创建 D1 数据库

1. Cloudflare 左侧菜单 → **存储和数据库** → **D1 SQL 数据库**
2. 页面右上角点击 **创建数据库**
3. 名称填：`cf-phg-music-db` → **创建**

#### 第 4 步：绑定 D1 数据库到 Worker

1. 进入你刚部署的 Worker 项目（Cloudflare 左侧菜单→计算→**Workers 和 Pages** → 点击项目`cf-phg-music-server`）
2. 页面左上角的菜单栏点击"绑定"
3. 找到 **绑定** 区域 →弹窗中选择 **D1 数据库** → **添加**
4. 变量名称填：`DB (要大写)`
5. 数据库选择：`cf-phg-music-db`
6. 点击"添加绑定"

#### 第 5 步：修改 API Key 和 PUBLIC_KEY

默认 API Key 是 `c5cb88052fcfc21ee4a48ab7e3d3d964`

1. 进入你刚部署的 Worker 项目（Cloudflare 左侧菜单 → 计算 → **Workers 和 Pages** → 点击项目`cf-phg-music-server`）
2. 页面左上角的菜单栏点击"设置"→ **变量和机密**
3. 编辑 `API_KEY` 变量为你想要的值，这是接口访问的秘钥非常重要,一定要修改！！
4. 添加 `PUBLIC_KEY` 变量（32位hex字符串，用于公共分享路由，如 `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6`）

> **关于 PUBLIC_KEY**：这是 v1.0.10 新增的独立公开密钥，用于"分享计划"公共路由（`/{publicKey}/share/...`），与 `API_KEY` 分离。`API_KEY` 兼作 Owner Key，用于管理路由。如果不设置 `PUBLIC_KEY`，分享计划功能不可用。

#### 第 6 步：获取项目访问链接

1. 进入你刚部署的 Worker 项目（Cloudflare 左侧菜单 → 计算 → **Workers 和 Pages** → 点击项目`cf-phg-music-server`）
2. 页面左上角的菜单栏点击"设置"→**域和路由**
3. 复制你**workers.dev 对应的值（值的格式为："xxxx.workers.dev"）**
4. 复制第五步的`API_KEY 的值`**（值的格式为"`c5cb88052fcfc21ee4a48ab7e3d3dxxxx`"）**
5. 组成访问地址格式：

```
https://xxxx.workers.dev/你的API_KEY
```

#### 第 7 步：注册域名（如需国内访问）

Workers 默认域名（`*.workers.dev`）在中国大陆**无法访问**，需要绑定自定义域名才能正常使用。

**推荐免费域名注册平台：**

| 平台        | 特点                     | 链接                                          |
| --------- | ---------------------- | ------------------------------------------- |
| INDEVS.in | 免费域名，单用户限5个，1年有效期      | [注册入口](https://domain.stackryze.com/)       |
| 其他免费域名    | 需选择支持 Cloudflare 托管的平台 | [整理列表](https://blog.zrf.me/p/Free-Domains/) |

**INDEVS.in 注册教程**：[视频教程](https://www.youtube.com/watch?v=7cZC4G7je1U)

#### 第 8 步：绑定自定义域名到 Worker

1. 进入你刚部署的 Worker 项目（Cloudflare 左侧菜单 → 计算 → **Workers 和 Pages** → 点击项目`cf-phg-music-server`）
2. 页面左上角的菜单栏点击"设置"→**域和路由**
3. 点击 **添加** → 选择 **自定义域**
4. 输入你注册的域名（如 `phg-music.indevs.in`）→ 点击 **添加域**

**绑定完成后访问地址：**

```
https://你的域名/你的API_KEY
```

完成了🎉🎉🎉，复制这个链接，然后到APP的设置页设置该链接为服务器地址即可使用

## 费用说明

> 以下为 Cloudflare 官方政策，请以 [Cloudflare Workers 定价页面](https://developers.cloudflare.com/workers/platform/pricing) 为准

### 套餐对比

| 资源     | 免费版     | 付费版                         |
| ------ | ------- | --------------------------- |
| 请求次数   | 10万次/天  | 1000万次/月（≈33万次/天）           |
| CPU 时间 | 10ms/次  | 3000万ms/月                   |
| D1 读取  | 500万次/天 | 1亿次/月                       |
| D1 写入  | 10万次/天  | 1000万次/月                    |
| D1 存储  | 5GB     | 无限制                         |
| 超出费用   | -       | 请求 $0.30/百万次，CPU $0.02/百万ms |

**按每人每天3小时听歌估算（≈45次请求/天）：**

| 套餐  | 可支持人数         |
| --- | ------------- |
| 免费版 | **~2000人/天** |
| 付费版 | **~7000人/天** |

**结论**：免费版完全够用，即使几百人同时使用也绰绰有余。

***

## 存储架构

### AppDataStore（统一存储）

v1.0.10 引入了统一的 `AppDataStore`（`src/app_data.ts`），所有数据读写都经过这个入口：

- **串行化写入**：通过写队列（`_writeQueue`）排队执行，避免并发写入竞态
- **JSON 损坏保护**：如果检测到 JSON 解析失败，设置 `_corrupted` 标志，拒绝后续写入（防止用默认值覆盖损坏的数据）
- **数据迁移**：自动从旧格式（驼峰命名）迁移到新格式（下划线命名）
- **缓存失效**：每个请求开始时调用 `invalidateCache()`，确保跨 Isolate 读到最新 DB 数据

### 数据结构

```
app_data (D1 storage key)
├── share_config: { status, node_id, daily_limit, reserved_limit, contributor_name, shared_since }
├── usage: { daily: { "2026-07-20": { share, api } }, share_total, api_total }
├── scripts: ScriptInfo[]
├── script_stats: { [id]: { script: ScriptStats, sources: { [source]: SourceStats } } }
├── circuit_breakers: { [id]: CircuitBreakerState }
└── default_source_id: string | null
```

### ScriptStorage 改造

`ScriptStorage` 不再直接读写 DB，而是委托给 `AppDataStore`：
- 所有写操作通过 `store.update(callback)` 串行化执行
- `flush()` 现在是 no-op（写操作已即时落盘）
- `ScriptStorage` 和 `index.ts` 共享同一个 `AppDataStore` 实例

***

## API 文档

### 统一响应格式

所有接口返回统一的 JSON 格式：

```json
{
  "code": 200,
  "msg": "success",
  "data": { ... }
}
```

| 字段   | 类型          | 说明                                            |
| ---- | ----------- | --------------------------------------------- |
| code | number      | 状态码：200=成功，400=参数错误，403=无权限，410=未导入脚本，411=无支持源，412=换源失败，429=限额满，500=服务器错误 |
| msg  | string      | 响应消息                                          |
| data | object/null | 响应数据，失败时可能为 null                              |

***

## 一、脚本管理接口

### 1.1 获取服务信息

```http
GET /{apiKey}/status
```

返回服务版本、分享状态、用量统计等信息。客户端可据此检查连通性和版本兼容性。

**响应示例：**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "status": "ok",
    "serverVersion": "1.0.10",
    "serverVersionCode": 10010,
    "platform": "cloudflare",
    "minClientVersion": "1.0.01",
    "minClientVersionCode": 1001,
    "public_key": "a1b2c3d4...",
    "share_status": 1,
    "node_id": "phg-xxxx-xxxx",
    "daily_limit": 50000,
    "reserved_limit": 20000,
    "current_usage": 123,
    "contributor_name": "我的节点",
    "remaining": 49877,
    "api_call_stats": [{ "date": "2026-07-20", "count": 45 }],
    "api_call_total": 1234,
    "shared_since": 1737000000000
  }
}
```

### 1.2 获取已加载音源列表

```http
GET /{apiKey}/api/scripts/loaded
```

**响应示例：**

```json
{
  "code": 200,
  "msg": "success",
  "data": [
    {
      "id": "user_api_abc123",
      "name": "六音音源",
      "description": "多平台音乐源",
      "author": "作者名",
      "homepage": "https://example.com",
      "version": "1.0.0",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "supportedSources": ["kw", "kg", "tx", "wy", "mg"],
      "isDefault": true,
      "successRate": 0.92,
      "successCount": 100,
      "failCount": 8,
      "totalRequests": 108,
      "isCircuitBroken": false
    }
  ]
}
```

### 1.3 从 URL 导入脚本

```http
POST /{apiKey}/api/scripts/import/url
Content-Type: application/json

{
  "url": "https://example.com/source.js"
}
```

### 1.4 从原始内容导入脚本

```http
POST /{apiKey}/api/scripts/import/raw
Content-Type: application/json

{
  "name": "音源名称",
  "content": "base64编码的脚本内容"
}
```

### 1.5 设置默认音源

```http
POST /{apiKey}/api/scripts/default
Content-Type: application/json

{
  "id": "user_api_abc123"
}
```

### 1.6 删除脚本

```http
POST /{apiKey}/api/scripts/delete
Content-Type: application/json

{
  "id": "user_api_abc123"
}
```

**注意**：如果删除的是默认音源，系统会自动将剩余的第一个音源设为默认。

***

## 二、音乐播放接口

### 2.1 获取音乐播放URL

```http
POST /{apiKey}/api/music/url
Content-Type: application/json
```

**请求参数：**

| 字段                | 类型        | 必填 | 说明                                          |
| ----------------- | --------- | -- | ------------------------------------------- |
| source            | string    | 是  | 音乐平台代码：kw=酷我, kg=酷狗, tx=QQ音乐, wy=网易云, mg=咪咕 |
| quality           | string    | 是  | 音质：128k, 320k, flac, flac24bit              |
| songmid           | string    | 否  | 歌曲ID（通用字段）                                  |
| id                | string    | 否  | 歌曲ID（songmid的别名）                            |
| name              | string    | 否  | 歌曲名称（用于换源匹配）                                |
| singer            | string    | 否  | 歌手名称（用于换源匹配）                                |
| hash              | string    | 否  | 酷狗专用：歌曲hash                                 |
| songId            | string    | 否  | 酷狗/QQ/网易云专用：歌曲ID                            |
| copyrightId       | string    | 否  | 咪咕专用：版权ID                                   |
| interval          | string    | 否  | 歌曲时长（格式：mm:ss，用于换源匹配）                       |
| musicInfo         | object    | 否  | 完整歌曲信息对象（可替代上述字段）                           |
| allowToggleSource | boolean   | 否  | 是否允许换源，默认true                               |
| excludeSources    | string\[] | 否  | 换源时排除的平台列表                                  |

**请求示例：**

```json
{
  "source": "kw",
  "songmid": "MUSIC_12345678",
  "quality": "320k",
  "name": "演员",
  "singer": "薛之谦"
}
```

**响应示例：**

```json
{
  "code": 200,
  "msg": "获取成功",
  "data": {
    "url": "https://example.com/music.mp3",
    "type": "320k",
    "source": "kw",
    "quality": "320k",
    "lyric": "[00:00.00]歌词内容...",
    "tlyric": "[00:00.00]翻译歌词...",
    "rlyric": "[00:00.00]罗马音歌词...",
    "lxlyric": "[00:00.00]逐字歌词...",
    "cached": false,
    "fallback": {
      "toggled": false,
      "originalSource": "kw"
    },
    "scriptId": "user_api_abc123",
    "scriptName": "六音音源",
    "triedScripts": []
  }
}
```

**换源响应示例**（当原始源获取失败，自动切换到其他平台）：

```json
{
  "code": 200,
  "msg": "获取成功（换源）",
  "data": {
    "url": "https://example.com/music.mp3",
    "source": "wy",
    "fallback": {
      "toggled": true,
      "originalSource": "kw",
      "newSource": "wy",
      "matchedSong": {
        "id": "123456",
        "songmid": "123456",
        "name": "演员",
        "singer": "薛之谦",
        "source": "wy"
      }
    }
  }
}
```

### 2.2 获取歌词

```http
POST /{apiKey}/api/music/lyric
Content-Type: application/json
```

**请求参数：**

| 字段     | 类型     | 必填 | 说明            |
| ------ | ------ | -- | ------------- |
| source | string | 是  | 音乐平台代码        |
| songId | string | 是  | 歌曲ID          |
| name   | string | 否  | 歌曲名称（咪咕、酷狗需要） |
| singer | string | 否  | 歌手名称（咪咕需要）    |

***

## 三、搜索接口

### 3.1 搜索歌曲

```http
GET /{apiKey}/api/search?keyword=演员&source=kw&page=1&limit=20
```

| 字段      | 类型     | 必填 | 说明             |
| ------- | ------ | -- | -------------- |
| keyword | string | 是  | 搜索关键词          |
| source  | string | 否  | 指定平台，不传则搜索所有平台 |
| page    | number | 否  | 页码，默认1         |
| limit   | number | 否  | 每页数量，默认20      |

***

## 四、歌单接口

### 4.1 获取歌单详情

```http
POST /{apiKey}/api/songlist/detail
Content-Type: application/json

{
  "source": "wy",
  "id": "123456789"
}
```

### 4.2 通过短链接获取歌单详情

```http
POST /{apiKey}/api/songlist/detail/by-link
Content-Type: application/json

{
  "link": "https://music.163.com/#/playlist?id=123456789"
}
```

***

## 五、分享计划接口（v1.0.10 新增）

分享计划允许服务器所有者将自己的音源脚本共享给"公共服务器模式"的用户。通过 `PUBLIC_KEY` 暴露公共路由，与 `API_KEY` 管理路由分离。

### 5.1 公共状态查询

```http
GET /{publicKey}/status
```

无需鉴权，返回服务版本和分享状态。

**响应示例：**

```json
{
  "code": 200,
  "data": {
    "status": "ok",
    "serverVersion": "1.0.10",
    "serverVersionCode": 10010,
    "share_status": 1,
    "node_id": "phg-xxxx-xxxx",
    "daily_limit": 50000,
    "current_usage": 123,
    "remaining": 49877,
    "service": "cf-phg-music-server"
  }
}
```

### 5.2 共享获取播放URL

```http
POST /{publicKey}/share/music-url
Content-Type: application/json
```

客户端传入自己的音源脚本（inline 模式），服务器执行脚本获取播放链接。

**请求参数：**

| 字段                | 类型       | 必填 | 说明                              |
| ----------------- | -------- | -- | ------------------------------- |
| source            | string   | 是  | 音乐平台代码                          |
| quality           | string   | 是  | 音质                              |
| scriptContent     | string   | 否  | Base64 编码的脚本内容（单脚本模式，向后兼容）      |
| scriptName        | string   | 否  | 脚本名称                            |
| scripts           | array   | 否  | 多脚本数组（`[{content, name, isDefault}]`） |
| musicInfo         | object   | 否  | 歌曲信息                            |
| allowToggleSource | boolean  | 否  | 是否允许换源，默认 true                  |
| excludeSources    | string[] | 否  | 换源时排除的平台                        |

**响应示例：**

```json
{
  "code": 200,
  "data": {
    "url": "https://example.com/music.mp3",
    "source": "kw",
    "quality": "320k",
    "lyric": "...",
    "share_info": {
      "daily_limit": 50000,
      "current_usage": 124,
      "remaining": 49876,
      "reserved_limit": 20000,
      "contributor_name": "我的节点"
    }
  }
}
```

### 5.3 共享歌单详情

```http
POST /{publicKey}/share/songlist-detail
Content-Type: application/json
```

供免费模式客户端获取QQ音乐歌单（小程序无法设置正确的 Referer）。

### 5.4 管理分享配置

```http
POST /owner/{apiKey}/share/config
Content-Type: application/json

{
  "status": 1,
  "daily_limit": 50000,
  "reserved_limit": 20000,
  "contributor_name": "我的节点"
}
```

| 字段               | 类型     | 说明                                    |
| ---------------- | ------ | ------------------------------------- |
| status           | number | 0=关闭分享, 1=开启分享, 2=被注册中心踢下线           |
| daily_limit      | number | 每日分享限额                                |
| reserved_limit   | number | 保留限额（达到后停止服务外部用户，保留给自用）               |
| contributor_name | string | 节点名称（显示在客户端节点列表）                      |

> 每次开启分享（status→1）时自动重新生成 `node_id`。

### 5.5 注册中心踢下线

```http
POST /{publicKey}/share/config
Content-Type: application/json

{
  "status": 2
}
```

注册中心可调用此接口将异常节点踢下线（仅允许设置 status=2）。

***

## 六、音质代码对照表

| 代码        | 音质     | 说明          |
| --------- | ------ | ----------- |
| 128k      | 标准音质   | 128kbps MP3 |
| 320k      | 高品质    | 320kbps MP3 |
| flac      | 无损音质   | FLAC        |
| flac24bit | Hi-Res | 24bit FLAC  |

**注意**：实际可用音质取决于各平台和歌曲本身的支持情况。

***

## 七、换源机制

当原始源获取失败时，服务器会自动搜索其他平台，按歌名+歌手匹配最佳结果并重试。

### 换源流程

```
原始源获取失败
  ↓
performToggleSearch() — 并行搜索所有候选源（含原始源，修正错误ID）
  ↓
findBestMatch() — 按歌名+歌手+时长+专辑精确匹配
  ↓
tryToggleSourceInternal() — 按匹配度+成功率排序，依次尝试
  ↓
成功 → 返回 URL + matchedSong（含新源的正确ID）+ 歌词
失败 → 继续尝试下一个匹配结果
全部失败 → 返回错误
```

### 关键特性

- **搜索缓存**：一次请求只搜索一次，后续换源复用结果（避免重复搜索）
- **含原始源搜索**：换源时也搜索原始源（修正过期的 songId）
- **黑名单URL检测**：返回已知无效URL时跳过，记录失败
- **歌词获取**：换源成功后，根据 matchedSong 的新源信息获取对应歌词
- **用量计数**：换源成功也计入 share usage

***

## 八、curl 测试命令

### 获取服务信息

```bash
curl https://cf-phg-music-server.你的账户.workers.dev/你的API_KEY/status
```

### 获取已加载音源

```bash
curl https://cf-phg-music-server.你的账户.workers.dev/你的API_KEY/api/scripts/loaded
```

### 从URL导入音源脚本

```bash
curl -X POST https://cf-phg-music-server.你的账户.workers.dev/你的API_KEY/api/scripts/import/url \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://ghproxy.net/https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js"}'
```

### 搜索歌曲

```bash
curl "https://cf-phg-music-server.你的账户.workers.dev/你的API_KEY/api/search?keyword=演员&source=kw&limit=10"
```

### 获取播放URL

```bash
curl -X POST https://cf-phg-music-server.你的账户.workers.dev/你的API_KEY/api/music/url \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "kw",
    "songmid": "MUSIC_12345678",
    "name": "演员",
    "singer": "薛之谦",
    "quality": "320k"
  }'
```

### 获取歌词

```bash
curl -X POST https://cf-phg-music-server.你的账户.workers.dev/你的API_KEY/api/music/lyric \
  -H 'Content-Type: application/json' \
  -d '{"source": "kw", "songId": "MUSIC_12345678"}'
```

### 公共分享接口测试

```bash
# 查询公共状态
curl https://cf-phg-music-server.你的账户.workers.dev/你的PUBLIC_KEY/status

# 共享获取播放URL
curl -X POST https://cf-phg-music-server.你的账户.workers.dev/你的PUBLIC_KEY/share/music-url \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "kw",
    "quality": "320k",
    "musicInfo": {"songmid": "MUSIC_12345678", "name": "演员", "singer": "薛之谦"},
    "scriptContent": "base64编码的脚本内容"
  }'
```

***

## 九、脚本开发指南

建议参考洛雪音乐的指引：<https://lxmusic.toside.cn/desktop/custom-source>

### 基本结构

```javascript
/**
 * @name 音源名称
 * @description 音源描述
 * @author 作者
 * @version 1.0.0
 */

lx.send('inited', {
  sources: {
    kw: {
      type: 'music',
      actions: ['musicUrl', 'lyric', 'pic'],
      qualitys: ['128k', '320k', 'flac'],
    },
  },
}).then(() => {
  console.log('初始化成功');
}).catch(err => {
  console.error('初始化失败:', err.message);
});

lx.on('request', async(data) => {
  const { source, action, info } = data;
  switch (action) {
    case 'musicUrl':
      return await getMusicUrl(info);
    case 'lyric':
      return await getLyric(info);
    case 'pic':
      return await getPic(info);
  }
});
```

### API 参考

#### lx.request(url, options, callback)

发送 HTTP 请求：

```javascript
lx.request('https://api.example.com/music', {
  method: 'GET',
  timeout: 10000,
  headers: {
    'User-Agent': 'LXMusic',
  },
}, (err, resp, body) => {
  if (err) {
    console.error('请求失败:', err.message);
    return;
  }
  console.log('响应:', body);
});
```

#### lx.utils.crypto

加密工具：

```javascript
const aesBuffer = lx.utils.crypto.aesEncrypt(buffer, 'aes-128-cbc', key, iv);
const rsaBuffer = lx.utils.crypto.rsaEncrypt(buffer, publicKey);
const randomBytes = lx.utils.crypto.randomBytes(16);
const md5Hash = lx.utils.crypto.md5('string');
```

***

## 十、环境变量

| 变量名        | 说明                                                                 |
| ---------- | ------------------------------------------------------------------ |
| API_KEY    | API密钥（兼作 Owner Key），不设置则使用默认值 `c5cb88052fcfc21ee4a48ab7e3d3d964`，**一定要修改** |
| PUBLIC_KEY | 公开密钥（v1.0.10新增），32位hex字符串，用于分享计划公共路由，与 API_KEY 分离                  |
| AI_MODEL   | AI 模型名称，默认 `@cf/qwen/qwen3-30b-a3b-fp8`                            |
| DB         | D1 数据库绑定（变量名必须大写）                                                  |
| AI         | Cloudflare AI 绑定                                                    |

### API Key 使用说明

- **管理路由**：`/{apiKey}/api/...`、`/owner/{apiKey}/...` — 需要 API_KEY
- **公共路由**：`/{publicKey}/share/...`、`/{publicKey}/status` — 需要 PUBLIC_KEY

***

## 十一、错误码

| 状态码 | 说明                          |
| --- | --------------------------- |
| 200 | 成功                          |
| 400 | 参数错误                        |
| 403 | 无权限（分享未开启 / Owner Key 错误）   |
| 410 | 尚未导入任何音源脚本                  |
| 411 | 没有支持该源的脚本                   |
| 412 | 换源失败（所有源都试过了）               |
| 429 | 每日分享限额已达上限                  |
| 500 | 服务器内部错误                     |

***

## 十二、用户协议与免责声明

本项目基于 Apache License 2.0 许可证发行，以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。

### 词语约定

本协议中的"本项目"指拼好歌后端服务框架项目；"开发者"指本项目的代码贡献者和发布者；"部署者/分享者"指自行部署本服务器代码并自愿将计算资源共享给其他用户的运营者；"使用者"指连接到服务器并使用其服务的任何人；"音源脚本"指由使用者自行导入的第三方 JavaScript 插件脚本；"官方音乐平台"指各音乐源的官方平台统称；"版权数据"指包括但不限于图像、音频、名字等在内的他人拥有所属版权的数据。

### 一、开发者角色声明

1.1 **开源代码发布者**：本项目为开源软件，开发者仅以个人名义在 GitHub 等平台发布源代码。开发者**不运营任何在线服务**，不控制、不监督任何部署者自行部署的服务器实例，不提供、不存储、不传输任何音乐内容或音源脚本。

1.2 **技术中立框架**：本项目仅提供通用的 JavaScript 沙箱执行框架和服务代理功能，**不内置任何音源脚本**，不包含任何特定平台的对接逻辑。本项目本身不知道、不关心、不控制使用者可能导入什么样的脚本，也不对脚本的行为负责。

1.3 **部署者独立责任**：部署者自行部署本服务器代码，独立决策如何使用、配置和运营其服务器实例。开发者不对任何部署者的运营行为、分享行为或其服务器的使用方式承担责任。

### 二、数据来源

2.1 **数据来源说明**：本服务器返回的在线数据（如搜索结果、歌单信息、音乐URL等）全部由使用者自行导入的音源脚本提供。本服务器仅提供沙箱执行环境和网络代理通道，不对脚本返回的数据的合法性、准确性负责。

2.2 **音源脚本说明**：本服务器**不内置任何音源脚本**。所有音源脚本由使用者自行搜索、评估、导入和使用。音源脚本的作者、来源、行为均与本服务器代码开发者无关。本服务器不对脚本的行为负责。

2.3 **数据准确性**：由于本服务器不对脚本返回的数据进行合法性校验，使用过程中可能会出现希望播放的音频与实际播放的音频不对应或无法播放的问题，本服务器开发者及部署者不对此负责。

### 三、版权数据

3.1 **数据不存储**：本服务器**不存储、不缓存任何版权数据**。所有数据通过音源脚本实时获取并直接返回给使用者，不在服务器端持久化。

3.2 **清除责任**：为避免侵权，建议使用者在 24 小时内清除使用本项目的过程中所产生的版权数据。此原则不作为合法使用的依据，仅作为最低限度的保护措施。

3.3 **避风港机制**：如任何权利人认为通过本服务器获取的内容侵犯了其版权，部署者有义务在收到合法的版权投诉或侵权通知后，立即停止相关服务并关闭服务器实例。此行为不构成对侵权行为的承认，仅是为了规避风险和配合法律要求。

### 四、资源使用

4.1 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。

### 五、免责声明

5.1 **开发者免责**：开发者不对部署者、分享者或使用者使用本项目代码的方式、目的和后果承担任何责任。开发者不保证本项目代码符合任何特定国家或地区的法律法规，部署者和使用者有义务在使用前确认其所在地的法律要求。

5.2 **部署者/分享者免责**：部署者自愿部署本服务器代码，分享者自愿将服务器计算资源共享给社区，此行为完全基于自愿且非商业性质。部署者/分享者仅提供算力（CPU、网络带宽等基础设施）和 JavaScript 沙箱执行环境，**不提供、不存储、不缓存、不传输任何音乐内容**。部署者/分享者服务器执行的音源脚本由使用者自行提供，部署者/分享者不知道、无法预知也无法控制脚本的具体行为，不对脚本可能产生的任何后果负责。

5.3 **损害责任**：由于使用本服务器代码或无法使用本服务器代码而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）均由使用者自行承担。

5.4 **数据责任**：本服务器代码开发者、部署者、分享者不对通过本服务器获取的任何数据的合法性、准确性、完整性负责。使用者应自行判断数据来源的合法性和适用性。

5.5 **第三方内容**：本服务器可能通过音源脚本访问或展示第三方网站或服务的内容，开发者、部署者、分享者不对这些第三方内容的合法性、准确性或可用性负责。

### 六、使用限制

6.1 **技术学习用途**：本项目代码完全免费且开源，面向全世界人用作技术学习和交流。开发者不对项目内的技术可能存在违反当地法律法规的行为作保证。

6.2 **遵守法律法规**：禁止在违反当地法律法规的情况下部署或使用本服务器代码。对于部署者、分享者或使用者在明知或不知当地法律法规不允许的情况下使用本服务器代码所造成的任何违法违规行为，由行为人自行承担全部责任。

6.3 **分享者义务**：分享者在开启分享功能前，应充分了解并接受本协议的所有条款。分享者有义务在收到任何合法的版权投诉或侵权通知时，立即停止分享功能并关闭相关服务。开发者不对分享者的分享行为承担任何责任。

6.4 **禁止商业用途**：任何人、机构不得拿本服务器代码进行任何商业化活动，包括但不限于广告、付费服务、商业合作、捐赠等。分享者分享算力给社区使用必须完全自愿且非商业性质，不得通过分享获取任何形式的利益。

6.5 **禁止批量传播**：禁止使用本服务器代码进行批量下载、缓存、传播版权数据的行为。

6.6 **部署者责任**：部署者有义务在服务器首页显著位置展示本协议的完整内容或链接，确保使用者和分享者在使用前能够完整阅读并理解本协议。

### 七、版权保护

7.1 **尊重版权**：音乐平台和内容创作者不易，请尊重版权，支持正版。鼓励使用者在经济条件允许的情况下购买正版音乐服务。

### 八、非商业性质

8.1 本项目代码仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。任何人、机构不得拿此项目进行商业化活动。

### 九、接受协议与风险提示

9.1 **协议接受**：若你部署或使用了本服务器代码，即代表你完全理解并接受本协议的所有条款。

9.2 **使用前必读**：部署或使用本服务器代码前，请务必完整阅读本协议。如果你不同意本协议的任何条款，请不要部署或使用本服务器代码。

9.3 **最终解释权**：本协议的最终解释权归本项目代码开发者所有。开发者保留在必要时修改本协议的权利，修改后的协议将在 GitHub 公开并立即生效。

9.4 **高风险提示**：
   - 本服务器代码仅作为技术学习和研究工具，**不保证在任何国家或地区的法律框架下合法使用**。
   - 部署者部署本服务器代码、分享者开启分享功能、使用者使用本服务器代码的行为可能面临法律风险。
   - 部署者和分享者应充分评估风险并自行决定是否部署和开启分享功能。开发者不对任何部署者、分享者、使用者的行为承担责任。

9.5 **独立责任声明**：开发者、部署者、分享者、使用者、音源脚本提供者均为独立的法律主体。任一主体的行为不应被视为其他主体的授权、同意或共同侵权。

9.6 **投诉响应**：如任何权利人认为通过本服务器获取的内容侵犯了其版权，可以通过以下方式联系：
    - 开发者 GitHub Issues：[https://github.com/erikjamesgz/cf_phg_music_server/issues](https://github.com/erikjamesgz/cf_phg_music_server/issues)
    - 部署者应在收到任何合法的版权投诉或侵权通知时，立即停止相关服务并关闭服务器实例。

***

**参考项目**：[LX Music（洛雪音乐助手）](https://github.com/lyswhut/lx-music-desktop)
