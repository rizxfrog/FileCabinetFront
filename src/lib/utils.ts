import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function sizeLabel(n: number) {
  if (n < 1024) return `${n} B`;
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** i).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][i]}`;
}
export function expiryLabel(n: number) {
  return n ? new Date(n * 1000).toLocaleString("zh-CN") : "永久保存";
}
export function expiryValue(preset: string, custom: string, now = Date.now()) {
  if (preset === "forever") return 0;
  if (preset === "custom") {
    const n = Math.floor(new Date(custom).getTime() / 1000);
    if (!Number.isFinite(n) || n <= Math.floor(now / 1000))
      throw new Error("请选择未来的到期时间");
    return n;
  }
  return Math.floor(now / 1000) + Number(preset);
}
