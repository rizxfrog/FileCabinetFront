import { expect, test, type Page } from "@playwright/test";
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
const session = "a".repeat(48);
const storageURL = "https://upload.example.com/blob?signature=test";
const directCSP = csp.replace("connect-src 'self'", "connect-src 'self' https://example.com https://*.example.com");
async function directPage(page: Page, inlineLimit = 5) {
  await page.route("**/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "Content-Security-Policy": directCSP } });
  });
  await page.route("**/api/config", route => route.fulfill({ json: {
    upload_mode: "direct", max_upload_bytes: 10000000, inline_limit: inlineLimit,
  } }));
  await page.goto("/");
  await expect(page.getByText("当前为 direct 模式", { exact: false })).toBeVisible();
  await page.locator("#file-picker").setInputFiles({ name: file.name, mimeType: "text/plain", buffer: sample });
  await page.getByLabel("同时生成分享短码").uncheck();
}
for (const reused of [false, true]) {
  test(`browser direct ${reused ? "reused blob" : "signed PUT"} completes under CSP`, async ({ page, context }) => {
    const steps: string[] = [];
    await context.addCookies([{ name: "must-not-send", value: "secret", domain: "upload.example.com", path: "/", secure: true, sameSite: "None" }]);
    await page.route("**/api/uploads/prepare", route => {
      steps.push("prepare");
      expect(route.request().postDataJSON()).toEqual({ hash, name: file.name, size: sample.length, expires_at: 0 });
      return route.fulfill({ status: 201, json: { session_id: session, upload_url: reused ? "" : storageURL, method: "PUT", expires_in: 3600 } });
    });
    await page.route(storageURL, async route => {
      steps.push("put");
      expect(route.request().method()).toBe("PUT");
      expect(route.request().postDataBuffer()).toEqual(sample);
      const headers = await route.request().allHeaders();
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      await route.fulfill({ status: 200, body: "", headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await page.route("**/api/uploads/*/complete", route => {
      steps.push("complete");
      expect(route.request().url()).toContain(session);
      return route.fulfill({ json: file });
    });
    await directPage(page);
    await page.getByRole("button", { name: "上传并归档" }).click();
    await expect(page.getByText("文件已归档")).toBeVisible();
    expect(steps).toEqual(reused ? ["prepare", "complete"] : ["prepare", "put", "complete"]);
  });
}
for (const failure of ["prepare", "put"]) {
  test(`browser direct ${failure} failure never completes`, async ({ page }) => {
    let completed = false;
    let put = false;
    await page.route("**/api/uploads/prepare", route => route.fulfill(failure === "prepare"
      ? { status: 422, json: { error: "LFS 需要服务端认证，请使用 proxy" } }
      : { json: { session_id: session, upload_url: storageURL, method: "PUT", expires_in: 3600 } }));
    await page.route(storageURL, route => {
      put = true;
      return route.fulfill({ status: 403, body: "private upstream detail", headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await page.route("**/api/uploads/*/complete", route => { completed = true; return route.fulfill({ json: file }); });
    await directPage(page);
    await page.getByRole("button", { name: "上传并归档" }).click();
    await expect(page.getByRole("alert")).toContainText(failure === "prepare" ? "LFS 需要服务端认证" : "直传失败 (403)");
    await expect(page.getByRole("button", { name: "上传并归档" })).toBeEnabled();
    expect(completed).toBe(false);
    expect(put).toBe(failure === "put");
    await expect(page.getByText("文件已归档")).toHaveCount(0);
  });
}
for (const phase of ["prepare", "put", "complete"]) {
  test(`cancel during direct ${phase} stops waiting and further requests`, async ({ page }) => {
    const steps: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    async function waitAt(name: string) {
      steps.push(name);
      if (phase === name) { entered(); await gate; }
    }
    await page.route("**/api/uploads/prepare", async route => {
      await waitAt("prepare");
      try { await route.fulfill({ json: { session_id: session, upload_url: storageURL, method: "PUT", expires_in: 3600 } }); }
      finally { if (phase === "prepare") finished(); }
    });
    await page.route(storageURL, async route => {
      await waitAt("put");
      try { await route.fulfill({ status: 200, body: "", headers: { "Access-Control-Allow-Origin": "*" } }); }
      finally { if (phase === "put") finished(); }
    });
    await page.route("**/api/uploads/*/complete", async route => {
      await waitAt("complete");
      try { await route.fulfill({ json: file }); }
      finally { if (phase === "complete") finished(); }
    });
    await directPage(page);
    await page.getByRole("button", { name: "上传并归档" }).click();
    await requested;
    await page.getByRole("button", { name: "取消", exact: true }).click();
    try {
      await expect(page.getByRole("button", { name: "上传并归档" })).toBeEnabled();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByText("文件已归档")).toHaveCount(0);
    } finally { release(); }
    await done;
    expect(steps).toEqual(["prepare", "put", "complete"].slice(0, ["prepare", "put", "complete"].indexOf(phase) + 1));
  });
}
test("direct CSP blocks an untrusted storage origin", async ({ page }) => {
  let contacted = false;
  let completed = false;
  const untrusted = "https://untrusted.invalid/blob?signature=test";
  await page.route("**/api/uploads/prepare", route => route.fulfill({ json: { session_id: session, upload_url: untrusted, method: "PUT", expires_in: 3600 } }));
  await page.route(untrusted, route => { contacted = true; return route.fulfill({ body: "", headers: { "Access-Control-Allow-Origin": "*" } }); });
  await page.route("**/api/uploads/*/complete", route => { completed = true; return route.fulfill({ json: file }); });
  await directPage(page);
  await page.getByRole("button", { name: "上传并归档" }).click();
  await expect(page.getByRole("alert")).toContainText("直传连接失败");
  expect(contacted).toBe(false);
  expect(completed).toBe(false);
});

test("direct redirected PUT never completes", async ({ page }) => {
  let completed = false;
  const redirected = "https://upload.example.com/redirected";
  await page.route("**/api/uploads/prepare", route => route.fulfill({ json: { session_id: session, upload_url: storageURL, method: "PUT", expires_in: 3600 } }));
  await page.route(storageURL, route => route.fulfill({ status: 307, headers: { Location: redirected, "Access-Control-Allow-Origin": "*" } }));
  await page.route(redirected, async route => {
    const headers = await route.request().allHeaders();
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    await route.fulfill({ status: 200, body: "", headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.route("**/api/uploads/*/complete", route => { completed = true; return route.fulfill({ json: file }); });
  await directPage(page);
  await page.getByRole("button", { name: "上传并归档" }).click();
  // Chrome may reject a cross-origin preflighted redirect before exposing its
  // final URL to XHR. Either failure must stop before backend completion.
  await expect(page.getByRole("alert")).toContainText(/直传发生重定向|直传连接失败/);
  expect(completed).toBe(false);
});

test("direct small file still uses inline endpoint", async ({ page }) => {
  let uploaded = false;
  await page.route("**/api/files/**", route => { uploaded = true; return route.fulfill({ json: file }); });
  await directPage(page, 5242880);
  await page.getByRole("button", { name: "上传并归档" }).click();
  await expect(page.getByText("文件已归档")).toBeVisible();
  expect(uploaded).toBe(true);
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
