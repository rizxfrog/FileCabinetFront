# FileCabinetFront

React + TypeScript + Vite + shadcn 风格 Button（Radix Slot/CVA）+ TailwindCSS，Bun 管理依赖。中文文件归档/提取/短码工作台。

```sh
bun install --frozen-lockfile
bun run dev       # http://127.0.0.1:5173，API 代理到 localhost:8080
bun run build     # dist/
bun test
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome bun run test:e2e
```

生产嵌入构建请从兄弟目录 FileCabinet 运行 `./scripts/build.sh`，自动复制 dist 到后端 public 再编译。Docker 也会构建两个仓库。后端 `.env`、API、单实例恢复与安全要求见 `../FileCabinet/README.md`。

前端不接收任何 ModelScope token；文件采用 4 MiB 分块 Web Worker + hash-wasm 计算 SHA-256，XHR 原始 body 上传，显示哈希/传输/提交阶段。hash-wasm 需要 CSP `script-src 'self' 'wasm-unsafe-eval'`，并非允许 JavaScript eval。生产 Go 已设置该策略。

`UPLOAD_MODE=direct` 时浏览器只能上传小文件，大文件界面拒绝并解释 CORS 原因。原生客户端仍受认证要求约束：当前 ModelScope LFS 不是预签名地址，需要后端 Bearer/Cookie，故新 blob 的 direct 申请返回 422，应使用 proxy；仅真正免 token 签名 URL 或已存在 blob 可走原生接口。CLI 未实现。自动短码阶段可以取消等待，但文件仍已保存、服务端可能已生成短码。重复上传的短码上限按后端最终合并的文件有效期计算。服务没有用户鉴权，上公网前必须在反向代理增加认证/限流；hash 和短码并非隐私授权系统。
