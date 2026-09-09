import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
const sample = Buffer.from("文件柜 browser smoke");
const hash = createHash("sha256").update(sample).digest("hex");
const file = {
  hash,
  name: "hello.txt",
  size: sample.length,
  expires_at: 0,
  created_at: 1800000000,
};
const csp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
test("worker hash, upload, code and download lookup under production CSP", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let uploaded = false;
  await page.route("**/", async (route) => {
    const r = await route.fetch();
    await route.fulfill({
      response: r,
      headers: { ...r.headers(), "Content-Security-Policy": csp },
    });
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        upload_mode: "proxy",
        max_upload_bytes: 10000000,
        inline_limit: 5242880,
      },
    }),
  );
  await page.route("**/api/files/**", async (route) => {
    if (route.request().method() === "PUT") {
      expect(route.request().url()).toContain(hash);
      expect(route.request().postDataBuffer()).toEqual(sample);
      uploaded = true;
      await route.fulfill({ status: 201, json: file });
    } else
      await route.fulfill({
        json: { file, download_url: `/api/download/${hash}` },
      });
  });
  await page.route("**/api/codes", (route) =>
    route.fulfill({
      status: 201,
      json: {
        code: "123456",
        hash,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  );
  await page.goto("/");
  await page.screenshot({
    path: "test-results/filecabinet-desktop.png",
    fullPage: true,
  });
  await page.locator("#file-picker").setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: sample,
  });
  await page.getByRole("button", { name: "上传并归档" }).click();
  await expect(page.getByText("文件已归档")).toBeVisible();
  await expect(page.getByText("123456", { exact: true })).toBeVisible();
  expect(uploaded).toBe(true);
  await page.getByRole("button", { name: "提取文件", exact: true }).click();
  await page.getByLabel("文件 hash / 分享短码").fill("123456");
  await page.getByRole("button", { name: "查找文件", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "下载文件", exact: true }).last(),
  ).toHaveAttribute("href", `/api/download/${hash}`);
  await page
    .getByRole("button", { name: "生成短码", exact: true })
    .first()
    .click();
  await page.getByLabel("文件 SHA-256", { exact: true }).fill(hash);
  await page
    .getByRole("button", { name: "生成短码", exact: true })
    .last()
    .click();
  await expect(page.getByText("123456", { exact: true }).last()).toBeVisible();
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/filecabinet-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("direct-mode browser large upload is rejected clearly", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        upload_mode: "direct",
        max_upload_bytes: 10000000,
        inline_limit: 5,
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("当前为 direct 模式", { exact: false }),
  ).toBeVisible();
  await page.locator("#file-picker").setInputFiles({
    name: "large.txt",
    mimeType: "text/plain",
    buffer: sample,
  });
  await page.getByRole("button", { name: "上传并归档" }).click();
  await expect(page.getByRole("alert")).toContainText("浏览器无法上传大文件");
});
test("API failure and optional code failure are distinguishable", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        upload_mode: "proxy",
        max_upload_bytes: 10000000,
        inline_limit: 5242880,
      },
    }),
  );
  await page.route("**/api/files/**", (route) =>
    route.fulfill({ status: 201, json: file }),
  );
  await page.route("**/api/codes", (route) =>
    route.fulfill({ status: 503, json: { error: "服务暂不可用" } }),
  );
  await page.goto("/");
  await page.locator("#file-picker").setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: sample,
  });
  await page.getByRole("button", { name: "上传并归档" }).click();
  await expect(page.getByText("文件已归档")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "文件已保存，但短码未生成",
  );
});

test("duplicate permanent file permits tomorrow code despite requested one-hour expiry", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { upload_mode: "proxy", max_upload_bytes: 10000000, inline_limit: 5242880 } }));
  let requestedExpiry = 0;
  let codeExpiry = 0;
  await page.route("**/api/files/**", route => {
    requestedExpiry = Number(new URL(route.request().url()).searchParams.get("expires_at"));
    // The same hash is already permanent: backend returns the max-merged expiry.
    return route.fulfill({ status: 201, json: file });
  });
  await page.route("**/api/codes", route => {
    codeExpiry = route.request().postDataJSON().expires_at;
    return route.fulfill({ status: 201, json: { code: "654321", hash, expires_at: codeExpiry } });
  });
  await page.goto("/");
  await page.locator("#file-picker").setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: sample });
  await page.getByRole("radio", { name: "1 小时", exact: true }).check();
  await page.getByRole("group", { name: "保存设置" }).getByLabel("短码有效期", { exact: true }).selectOption("custom");
  const tomorrow = await page.evaluate(() => {
    const d = new Date(Date.now() + 86400000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.getByRole("group", { name: "保存设置" }).getByLabel("短码到期时间", { exact: true }).fill(tomorrow);
  await page.getByRole("button", { name: "上传并归档" }).click();
  await expect(page.getByText("文件已归档")).toBeVisible();
  await expect(page.getByText("654321", { exact: true })).toBeVisible();
  expect(requestedExpiry).toBeGreaterThan(Math.floor(Date.now()/1000));
  expect(codeExpiry).toBeGreaterThan(requestedExpiry + 3600);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("cancel while generating code aborts waiting but retains saved file", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { upload_mode: "proxy", max_upload_bytes: 10000000, inline_limit: 5242880 } }));
  await page.route("**/api/files/**", route => route.fulfill({ status: 201, json: file }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  let responded!: () => void;
  const responseDone = new Promise<void>(resolve => { responded = resolve; });
  await page.route("**/api/codes", async route => {
    entered();
    await gate;
    try {
      await route.fulfill({ status: 201, json: { code: "987654", hash, expires_at: Math.floor(Date.now()/1000)+3600 } });
    } finally { responded(); }
  });
  await page.goto("/");
  await page.locator("#file-picker").setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: sample });
  await page.getByRole("button", { name: "上传并归档" }).click();
  await requested;
  await expect(page.getByText("文件已归档")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  try {
    // The endpoint is still blocked: only wiring AbortSignal can unblock the UI.
    await expect(page.getByRole("button", { name: "上传并归档" })).toBeEnabled();
    await expect(page.getByRole("alert")).toContainText("已取消等待短码；服务端可能已生成短码");
    await expect(page.getByText("文件已归档")).toBeVisible();
  } finally { release(); }
  await responseDone;
  await expect(page.getByText("987654", { exact: true })).toHaveCount(0);
});

test("code expiry select has sufficient text height on desktop and mobile", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { upload_mode: "proxy", max_upload_bytes: 10000000, inline_limit: 5242880 } }));
  await page.goto("/");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const select = page.getByRole("group", { name: "保存设置" }).getByLabel("短码有效期", { exact: true });
    await expect(select).toBeVisible();
    const metrics = await select.evaluate(el => {
      const s = getComputedStyle(el);
      return { available: el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom), line: s.lineHeight === "normal" ? parseFloat(s.fontSize) * 1.2 : parseFloat(s.lineHeight) };
    });
    expect(metrics.available).toBeGreaterThanOrEqual(metrics.line);
    await page.screenshot({ path: `test-results/upload-select-${width}.png`, fullPage: true });
  }
});
