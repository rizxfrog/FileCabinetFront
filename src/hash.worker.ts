import { createSHA256 } from "hash-wasm";
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const hash = await createSHA256();
    hash.init();
    const chunk = 4 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunk) {
      hash.update(
        new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer()),
      );
      self.postMessage({
        progress: Math.min(100, ((offset + chunk) / file.size) * 100),
      });
    }
    self.postMessage({ hash: hash.digest("hex") });
  } catch {
    self.postMessage({ error: "无法读取文件，请重新选择文件" });
  }
};
