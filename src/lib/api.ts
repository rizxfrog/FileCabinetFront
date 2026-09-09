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
  max_upload_bytes: number;
  inline_limit: number;
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
