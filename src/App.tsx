import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  ArrowDownToLine,
  Check,
  Copy,
  File,
  FileUp,
  FolderClosed,
  Hash,
  Layers,
  Link2,
  ListPlus,
  LoaderCircle,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import {
  api,
  createList,
  downloadList,
  hashFile,
  upload,
  uploadDirect,
  type Config,
  type ListEntry,
  type Lookup,
  type ShortCode,
  type StoredFile,
} from "./lib/api";
import { expiryLabel, expiryValue, sizeLabel } from "./lib/utils";
type Tab = "upload" | "download" | "code" | "list";
const message = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请稍后重试";
function CopyButton({
  value,
  label = "复制",
}: {
  value: string;
  label?: string;
}) {
  const [state, setState] = useState("");
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("已复制");
          } catch {
            setState("复制失败，请手动选中复制");
          }
        }}
      >
        {state === "已复制" ? <Check /> : <Copy />}
        {label}
      </Button>
      <span className="copy-note" role="status">
        {state}
      </span>
    </>
  );
}
function CodeResult({ code }: { code: ShortCode }) {
  return (
    <div className="code-result">
      <div>
        <span className="field-note">分享短码</span>
        <strong>{code.code}</strong>
        <small>有效至 {expiryLabel(code.expires_at)}</small>
      </div>
      <CopyButton value={code.code} label="复制短码" />
    </div>
  );
}
function FileResult({ file }: { file: StoredFile }) {
  return (
    <div className="file-result">
      <div className="result-heading">
        <Check size={18} />
        <strong>文件已归档</strong>
        <span>{sizeLabel(file.size)}</span>
      </div>
      <p className="file-name">{file.name}</p>
      <label>SHA-256 内容指纹</label>
      <code>{file.hash}</code>
      <div className="result-actions">
        <CopyButton value={file.hash} label="复制 hash" />
        <Button asChild variant="ghost" size="sm">
          <a href={`/api/download/${file.hash}`}>
            <ArrowDownToLine />
            下载文件
          </a>
        </Button>
      </div>
      <small>文件有效期：{expiryLabel(file.expires_at)}</small>
    </div>
  );
}
function UploadPanel({ config }: { config: Config | null }) {
  const [file, setFile] = useState<File | null>(null),
    [preset, setPreset] = useState("forever"),
    [custom, setCustom] = useState(""),
    [withCode, setWithCode] = useState(true),
    [codePreset, setCodePreset] = useState("default"),
    [codeCustom, setCodeCustom] = useState("");
  const [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [hash, setHash] = useState(""),
    [saved, setSaved] = useState<StoredFile | null>(null),
    [code, setCode] = useState<ShortCode | null>(null),
    [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const choose = (f?: File) => {
    if (busy || !f) return;
    setFile(f);
    setError("");
    setSaved(null);
    setCode(null);
    setHash("");
    setStage("");
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !config || busy) return;
    setError("");
    setSaved(null);
    setCode(null);
    setHash("");
    let expiry: number,
      codeExpiry = 0;
    try {
      if (file.size > config.max_upload_bytes)
        throw new Error(
          `文件超过大小限制 ${sizeLabel(config.max_upload_bytes)}`,
        );
      expiry = expiryValue(preset, custom);
      if (withCode && codePreset === "custom") {
        codeExpiry = expiryValue("custom", codeCustom);
        // The final file expiry may be extended by an existing copy of this hash.
        // Let the code API validate its upper bound against the saved metadata.
      }
    } catch (e) {
      setError(message(e));
      return;
    }
    setBusy(true);
    const control = new AbortController();
    abort.current = control;
    try {
      setStage("正在计算文件指纹");
      setProgress(0);
      const h = await hashFile(file, setProgress, control.signal);
      setHash(h);
      setStage("正在上传文件");
      setProgress(0);
      const send = config.upload_mode === "direct" && file.size > config.inline_limit
        ? uploadDirect
        : upload;
      const f = await send(
        file,
        h,
        expiry,
        (n) => {
          setProgress(n);
          if (n >= 100) setStage("正在校验并提交，请稍候");
        },
        control.signal,
      );
      setSaved(f);
      setStage("归档完成");
      if (withCode) {
        try {
          setStage("正在生成短码");
          setCode(
            await api<ShortCode>(
              "/api/codes",
              { hash: h, expires_at: codeExpiry },
              control.signal,
            ),
          );
        } catch (e) {
          setError(
            control.signal.aborted
              ? "文件已保存，已取消等待短码；服务端可能已生成短码。可在「生成短码」中重新生成。"
              : `文件已保存，但短码未生成：${message(e)}。可在「生成短码」中重试。`,
          );
        } finally {
          setStage("归档完成");
        }
      }
    } catch (e) {
      setError(message(e));
      setStage("本次操作未确认完成");
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>把文件放进柜子</h2>
          <p>按内容归档，不必记住它被放在哪里。</p>
        </div>
        <FileUp aria-hidden="true" />
      </div>
      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${busy ? "disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        <input
          ref={input}
          type="file"
          className="sr-only"
          id="file-picker"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0])}
        />
        <div className="file-pocket">
          {file ? <File size={30} /> : <FolderClosed size={34} />}
        </div>
        <strong>{file ? file.name : "选择文件，或拖放到这里"}</strong>
        <p>
          {file
            ? `${sizeLabel(file.size)} · 单文件归档`
            : `支持任意文件格式${config ? `，最大 ${sizeLabel(config.max_upload_bytes)}` : ""}`}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {file ? "重新选择" : "选择文件"}
        </Button>
      </div>
      <fieldset disabled={busy} className="settings">
        <legend>保存设置</legend>
        <label htmlFor="file-expiry">文件有效期</label>
        <div className="expiry-options" id="file-expiry">
          {[
            ["forever", "永久"],
            ["3600", "1 小时"],
            ["86400", "1 天"],
            ["604800", "7 天"],
            ["custom", "自定义"],
          ].map(([value, text]) => (
            <label className={preset === value ? "selected" : ""} key={value}>
              <input
                type="radio"
                name="expiry"
                value={value}
                checked={preset === value}
                onChange={() => setPreset(value)}
              />
              {text}
            </label>
          ))}
        </div>
        {preset === "custom" && (
          <label className="custom-date">
            文件到期时间
            <input
              aria-label="文件到期时间"
              type="datetime-local"
              required
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
        )}
        <div className="code-setting">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={withCode}
              onChange={(e) => setWithCode(e.target.checked)}
            />
            <span>
              同时生成分享短码<small>最长 7 天，不超过文件有效期</small>
            </span>
          </label>
          {withCode && (
            <select
              aria-label="短码有效期"
              value={codePreset}
              onChange={(e) => setCodePreset(e.target.value)}
            >
              <option value="default">默认有效期</option>
              <option value="custom">自定义时间</option>
            </select>
          )}
        </div>
        {withCode && codePreset === "custom" && (
          <label className="custom-date">
            短码到期时间
            <input
              type="datetime-local"
              required
              value={codeCustom}
              onChange={(e) => setCodeCustom(e.target.value)}
            />
          </label>
        )}
      </fieldset>
      {config?.upload_mode === "direct" && (
        <p className="notice">
          当前为 direct 模式（实验）：大文件将尝试浏览器直传，需要上游允许 CORS。{config.unsafe_direct_expose_url ? "危险实验开关已开启：服务端会把上游上传地址返回浏览器，但不会返回 token；测试完成后请立即关闭 UNSAFE_DIRECT_EXPOSE_URL。" : "当前 ModelScope LFS 需要服务端认证，申请新大文件地址可能返回 422。"} ≤ {sizeLabel(config.inline_limit)} 的文件仍经后端上传。
        </p>
      )}
      <div className="submit-row">
        <span>
          <ShieldCheck size={16} />
          凭证仅保留在服务端
        </span>
        <Button disabled={!file || busy || !config} type="submit">
          {busy ? <LoaderCircle className="spin" /> : <FileUp />}
          {busy ? "处理中" : "上传并归档"}
        </Button>
        {busy && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => abort.current?.abort()}
          >
            <X />
            取消
          </Button>
        )}
      </div>
      {stage && (
        <div className="progress-area" role="status">
          <div>
            <span>{stage}</span>
            {busy && <span>{Math.round(progress)}%</span>}
          </div>
          {busy && <progress max="100" value={progress} />}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {hash && !saved && (
        <div className="pending-hash">
          <label>本次文件 hash（可用于确认上传结果）</label>
          <code>{hash}</code>
          <CopyButton value={hash} />
        </div>
      )}
      {saved && <FileResult file={saved} />}
      {code && <CodeResult code={code} />}
    </form>
  );
}
function DownloadPanel() {
  const [key, setKey] = useState(""),
    [result, setResult] = useState<Lookup | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setProgress("");
    setBusy(true);
    try {
      setResult(await api<Lookup>(`/api/files/${encodeURIComponent(key.trim())}`));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function grabAll(entries: ListEntry[]) {
    setError("");
    try {
      // Entries download one at a time; the browser throttles bursts of saves.
      await downloadList(entries, (done, total) =>
        setProgress(`已发起 ${done}/${total}`),
      );
      setProgress(`已发起全部 ${entries.length} 个下载`);
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>找到你的文件</h2>
          <p>一枚内容指纹，或一个六位短码。</p>
        </div>
        <Search />
      </div>
      <label htmlFor="lookup">文件 hash / 分享短码</label>
      <input
        id="lookup"
        disabled={busy}
        required
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        value={key}
        onChange={(e) => {
          setKey(e.target.value);
          setResult(null);
        }}
        placeholder="输入 64 位 SHA-256 或 6 位短码"
      />
      <p className="field-note">短码区分大小写。已过期的文件无法下载。</p>
      <Button type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" /> : <Search />}查找文件
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result ? (
        result.list ? (
          <div className="download-result" role="status">
            <div className="file-result">
              <div className="result-heading">
                <Layers size={18} />
                <strong>文件列表</strong>
                <span>
                  {result.list.length} 项 · {sizeLabel(result.file.size)}
                </span>
              </div>
              <p className="file-name">{result.file.name}</p>
              <label>列表指纹</label>
              <code>{result.file.hash}</code>
              <div className="result-actions">
                <CopyButton value={result.file.hash} label="复制 hash" />
                <Button
                  type="button"
                  onClick={() => grabAll(result.list)}
                >
                  <ArrowDownToLine />
                  下载列表
                </Button>
              </div>
              {progress && <small>{progress}</small>}
              <ul className="list-entries">
                {result.list.map((entry, i) => (
                  <li key={entry.hash}>
                    <span className="entry-index">{i + 1}</span>
                    <span className="entry-name" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="entry-size">{sizeLabel(entry.size)}</span>
                    <Button asChild variant="ghost" size="sm">
                      <a href={`/api/download/${entry.hash}`} download={entry.name}>
                        <ArrowDownToLine />
                        下载
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="field-note">
                逐项下载受浏览器限制，请允许本页面的「多个文件下载」提示。
              </p>
            </div>
          </div>
        ) : (
          <div className="download-result" role="status">
            <FileResult file={result.file} />
            <div className="result-actions">
              <Button asChild>
                <a href={result.download_url}>
                  <ArrowDownToLine />
                  下载文件
                </a>
              </Button>
              <CopyButton
                value={new URL(result.download_url, window.location.origin).href}
                label="复制下载链接"
              />
            </div>
            <p className="field-note">链接通过本服务下载；文件过期后即失效。</p>
          </div>
        )
      ) : (
        <div className="empty-drawer">
          <Archive size={40} />
          <p>文件不会列在这里</p>
          <span>持有 hash 或短码，才能打开对应的抽屉。</span>
        </div>
      )}
    </form>
  );
}
function ListPanel() {
  const [name, setName] = useState(""),
    [raw, setRaw] = useState(""),
    [result, setResult] = useState<StoredFile | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const hashes = Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const invalid = hashes.filter((h) => !/^[a-f0-9]{64}$/.test(h));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    if (invalid.length) {
      setError(`有 ${invalid.length} 项不是合法的 64 位 SHA-256`);
      return;
    }
    setBusy(true);
    try {
      setResult(await createList(name, hashes));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>把文件编成一组</h2>
          <p>按顺序引用已有文件，得到一个可分发的列表指纹。</p>
        </div>
        <ListPlus aria-hidden="true" />
      </div>
      <label htmlFor="list-name">列表名称</label>
      <input
        id="list-name"
        disabled={busy}
        required
        maxLength={255}
        autoComplete="off"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setResult(null);
        }}
        placeholder="例如：各版本高等数学备份"
      />
      <label htmlFor="list-hashes">文件 hash（每行一个）</label>
      <textarea
        id="list-hashes"
        disabled={busy}
        required
        rows={8}
        spellCheck={false}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          setResult(null);
        }}
        placeholder={"每行一个 64 位 SHA-256\n也支持用空格或逗号分隔"}
      />
      <p className="field-note">
        {hashes.length} 项{invalid.length ? `，其中 ${invalid.length} 项格式不正确` : ""}
        。列表只能引用已存在的文件，不能嵌套列表，最多 1000 项。
      </p>
      <Button type="submit" disabled={busy || !hashes.length}>
        {busy ? <LoaderCircle className="spin" /> : <ListPlus />}
        创建文件列表
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="download-result" role="status">
          <div className="file-result">
            <div className="result-heading">
              <Check size={18} />
              <strong>列表已创建</strong>
              <span>
                {hashes.length} 项 · {sizeLabel(result.size)}
              </span>
            </div>
            <p className="file-name">{result.name}</p>
            <label>列表指纹（可分享）</label>
            <code>{result.hash}</code>
            <div className="result-actions">
              <CopyButton value={result.hash} label="复制 hash" />
            </div>
            <small>在「提取文件」中输入该指纹即可查看并下载全部文件。</small>
          </div>
        </div>
      )}
    </form>
  );
}
function CodePanel() {
  const [hash, setHash] = useState(""),
    [custom, setCustom] = useState(""),
    [mode, setMode] = useState("default"),
    [result, setResult] = useState<ShortCode | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setBusy(true);
    try {
      setResult(
        await api("/api/codes", {
          hash: hash.trim(),
          expires_at: mode === "custom" ? expiryValue("custom", custom) : 0,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>分享，简短一点</h2>
          <p>为已经归档的文件生成六位短码。</p>
        </div>
        <Link2 />
      </div>
      <label htmlFor="code-hash">文件 SHA-256</label>
      <input
        id="code-hash"
        disabled={busy}
        required
        pattern="[a-f0-9]{64}"
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        value={hash}
        onChange={(e) => {
          setHash(e.target.value);
          setResult(null);
        }}
        placeholder="输入文件的 64 位 hash"
      />
      <label htmlFor="code-expiry">短码有效期</label>
      <select
        id="code-expiry"
        disabled={busy}
        value={mode}
        onChange={(e) => setMode(e.target.value)}
      >
        <option value="default">默认：7 天或文件到期，以较早为准</option>
        <option value="custom">自定义到期时间</option>
      </select>
      {mode === "custom" && (
        <label className="custom-date">
          到期时间
          <input
            type="datetime-local"
            required
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
      )}
      <p className="field-note">
        自定义时间必须晚于现在，且严格早于默认到期时间。生成新短码不会延长文件有效期。
      </p>
      <Button type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" /> : <Link2 />}生成短码
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && <CodeResult code={result} />}
      <div className="note-sheet">
        <h3>小小短码，临时通行证</h3>
        <p>
          复制给收件人，在「提取文件」输入即可获取下载链接。短码失效后，仍可用有效文件的
          hash 生成新短码。
        </p>
      </div>
    </form>
  );
}
export default function App() {
  const [tab, setTab] = useState<Tab>("upload"),
    [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState("");
  function load() {
    setError("");
    api<Config>("/api/config")
      .then(setConfig)
      .catch(() => setError("无法连接文件服务，请检查后端配置后重试。"));
  }
  useEffect(load, []);
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/" aria-label="文件柜首页">
          <span className="brand-icon">
            <Archive size={23} />
          </span>
          <span>
            FileCabinet<small>文件柜</small>
          </span>
        </a>
        <span className="header-note">存一份文件，留一枚指纹。</span>
      </header>
      <main>
        <aside className="intro">
          <div className="cabinet-illustration" aria-hidden="true">
            <div className="cabinet-top" />
            <div className="cabinet-drawer">
              <span />
              <i />
            </div>
            <div className="cabinet-drawer open">
              <span />
              <i />
            </div>
            <div className="cabinet-drawer">
              <span />
              <i />
            </div>
          </div>
          <h1>
            文件入柜。
            <br />
            随取，随分享。
          </h1>
          <p>
            不靠文件名寻找。
            <br />
            用内容指纹保存，用短码传递。
          </p>
          <div className="intro-detail">
            <Hash size={18} />
            <span>相同内容，只存一份</span>
          </div>
          <div className="intro-detail">
            <ShieldCheck size={18} />
            <span>有效期由你决定</span>
          </div>
          <div className="storage-note">
            存储托管于阿里云
            <br />
            <span>上传：{config?.upload_mode === "direct" ? "浏览器直传" : "后端中转"}</span>
            <br />
            <span>下载：{config?.download_mode === "direct" ? "直链跳转" : "后端中转"}</span>
          </div>
        </aside>
        <section className="workspace" aria-label="文件操作">
          <nav aria-label="功能选择">
            {(
              [
                { key: "upload", label: "上传文件", icon: FileUp },
                { key: "download", label: "提取文件", icon: ArrowDownToLine },
                { key: "list", label: "创建列表", icon: ListPlus },
                { key: "code", label: "生成短码", icon: Link2 },
              ] as const
            ).map((item) => (
              <button
                type="button"
                aria-current={tab === item.key ? "page" : undefined}
                key={item.key}
                onClick={() => setTab(item.key)}
                className={tab === item.key ? "active" : ""}
              >
                <item.icon size={18} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="workspace-body">
            {error && (
              <div className="error" role="alert">
                {error}
                <Button variant="ghost" size="sm" onClick={load}>
                  重试
                </Button>
              </div>
            )}
            <div hidden={tab !== "upload"}>
              <UploadPanel config={config} />
            </div>
            <div hidden={tab !== "list"}>
              <ListPanel />
            </div>
            <div hidden={tab !== "download"}>
              <DownloadPanel />
            </div>
            <div hidden={tab !== "code"}>
              <CodePanel />
            </div>
          </div>
        </section>
      </main>
      <footer>
        <span>FileCabinet / 内容寻址文件存储</span>
        <span>请妥善保管 hash 与短码，持有者可访问文件。</span>
      </footer>
    </div>
  );
}
