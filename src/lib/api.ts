export interface StoredFile {
  hash: string;
  name: string;
  size: number;
  expires_at: number;
  created_at: number;
}
export interface ShortCode {
  code: string;
  hash: string;
  expires_at: number;
}
export interface Config {
  upload_mode: "proxy" | "direct";
  download_mode: "proxy" | "direct";
  max_upload_bytes: number;
  inline_limit: number;
  unsafe_direct_expose_url: boolean;
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(
    path,
    body === undefined
      ? { signal }
      : {
          signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || `请求失败 (${r.status})`);
  return value as T;
}
export function upload(
  file: File,
  hash: string,
  expiry: number,
  progress: (n: number) => void,
  signal: AbortSignal,
): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams({
      size: String(file.size),
      name: file.name,
      expires_at: String(expiry),
    });
    xhr.open("PUT", `/api/files/${hash}?${params}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 24 * 60 * 60 * 1000;
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const done = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      done();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300)
          reject(new Error(data.error || "上传失败"));
        else resolve(data);
      } catch {
        reject(new Error("服务器返回了无效响应，请查询 hash 确认结果"));
      }
    };
    xhr.onerror = () => {
      done();
      reject(new Error("网络连接中断，请查询 hash 确认结果后重试"));
    };
    xhr.ontimeout = () => {
      done();
      reject(new Error("上传超时，请查询 hash 确认结果"));
    };
    xhr.onabort = () => {
      done();
      reject(new Error("已取消；如果文件已提交，请通过 hash 查询结果"));
    };
    if (signal.aborted) {
      done();
      reject(new Error("已取消"));
      return;
    }
    xhr.send(file);
  });
}
interface PreparedUpload {
  session_id: string;
  upload_url: string; // Empty when the blob already exists; completion still required.
  method: "PUT";
  expires_in: number;
}

export async function uploadDirect(
  file: File,
  hash: string,
  expiry: number,
  progress: (n: number) => void,
  signal: AbortSignal,
): Promise<StoredFile> {
  const prepared = await api<PreparedUpload>(
    "/api/uploads/prepare",
    { hash, name: file.name, size: file.size, expires_at: expiry },
    signal,
  );
  if (signal.aborted) throw new Error("已取消");
  if (!/^[a-f0-9]{48}$/.test(prepared.session_id) ||
      prepared.method !== "PUT" || typeof prepared.upload_url !== "string") {
    throw new Error("服务器返回了无效的直传会话");
  }
  if (prepared.upload_url) {
    await putDirect(file, prepared.upload_url, progress, signal);
  }
  // A completed PUT alone is not proof of a committed file. Reused blobs also
  // require completion so the backend verifies availability and merges expiry.
  if (signal.aborted) throw new Error("已取消");
  progress(100);
  try {
    return await api<StoredFile>(
      `/api/uploads/${prepared.session_id}/complete`,
      {},
      signal,
    );
  } catch (error) {
    if (signal.aborted) {
      throw new Error("已取消等待提交；服务端可能已保存文件，请通过 hash 查询结果");
    }
    throw error;
  }
}

function putDirect(
  file: File,
  rawURL: string,
  progress: (n: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(rawURL);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || url.origin === location.origin) {
    throw new Error("服务器返回了无效的直传地址");
  }
  // The backend validates the destination, and production CSP restricts all
  // destinations (including redirects) to the configured storage hosts.
  // Never send application/ModelScope auth headers or cross-origin cookies.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url.href);
    xhr.withCredentials = false;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 24 * 60 * 60 * 1000;
    const abort = () => xhr.abort();
    const done = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      done();
      if (xhr.responseURL !== url.href) {
        reject(new Error("直传发生重定向，未确认提交；请通过 hash 查询结果"));
      } else if (xhr.status < 200 || xhr.status >= 300) {
        // Do not echo upstream bodies or signed URLs into the UI.
        reject(new Error(`直传失败 (${xhr.status})，未提交文件`));
      } else resolve();
    };
    xhr.onerror = () => {
      done();
      reject(new Error("直传连接失败，请检查上游 CORS、上传授权或网络；未提交文件"));
    };
    xhr.ontimeout = () => {
      done();
      reject(new Error("直传超时，未提交文件"));
    };
    xhr.onabort = () => {
      done();
      reject(new Error("已取消直传，未提交文件"));
    };
    if (signal.aborted) {
      done();
      reject(new Error("已取消"));
      return;
    }
    xhr.send(file);
  });
}

export function hashFile(
  file: File,
  progress: (n: number) => void,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../hash.worker.ts", import.meta.url), {
      type: "module",
    });
    const done = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(new Error("已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.error) {
        done();
        reject(new Error(data.error));
      } else if (data.hash) {
        done();
        resolve(data.hash);
      } else progress(data.progress);
    };
    worker.onerror = () => {
      done();
      reject(new Error("文件指纹计算失败，请使用现代浏览器重试"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    worker.postMessage(file);
  });
}
