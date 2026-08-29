import { test, expect, Page } from "@playwright/test";
import { signIn, USERS } from "../support/session";

/**
 * The route guard in `lib/rbac.ts` is a client-side allow-list, separate from the sidebar's nav
 * list. Adding a page to one without the other produces a visible link that lands on
 * "Dashboard Access Denied" — which is exactly what shipped with the Intelligence page.
 *
 * Every navigation is WARMED first. In `next dev` a route compiles on first visit (17-24s
 * measured), and an unwarmed assertion times out on the compiler rather than on the app — which
 * looks like an auth failure and is not one. Run with NEXT_MODE=production and the warm-up is
 * a no-op.
 */

const SETTLE = 60_000;

/** Navigate and wait for the guard to finish deciding: either the app shell or a denial. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page
    .locator('aside, text=Dashboard Access Denied, text=Verifying permissions')
    .first()
    .waitFor({ timeout: SETTLE })
    .catch(() => {});
  // AuthGuard renders "Verifying permissions…" until the session resolves; let it land.
  await page
    .getByText("Verifying permissions")
    .waitFor({ state: "hidden", timeout: SETTLE })
    .catch(() => {});
}

test.describe("dashboard route access", () => {
  test("an app admin can open Intelligence and is not denied", async ({ page, context, baseURL }) => {
    await signIn(context, USERS.appAdmin, baseURL!);
    await open(page, "/nexabank/intelligence");

    expect(page.url(), "app admin was redirected away from Intelligence").not.toMatch(/\/unauthorized/);
    await expect(page.getByText("Dashboard Access Denied")).toHaveCount(0);
    // Either a narrative or the honest empty state — both mean the page rendered.
    await expect(
      page.getByText(/Analyst enquiry/i).or(page.getByText(/Investigation Report/i)),
    ).toBeVisible({ timeout: SETTLE });
  });

  test("a super admin reaches Intelligence too (rbac.json maps the role to the cfo persona)", async ({
    page, context, baseURL,
  }) => {
    await signIn(context, USERS.superAdmin, baseURL!);
    await open(page, "/intelligence");
    expect(page.url(), "super admin was denied its own persona's page").not.toMatch(/\/unauthorized/);
    await expect(page.getByText("Dashboard Access Denied")).toHaveCount(0);
  });

  test("every sidebar link an app admin can see actually opens", async ({ page, context, baseURL }) => {
    test.setTimeout(600_000); // ~10 cold routes x dev compile
    await signIn(context, USERS.appAdmin, baseURL!);
    await open(page, "/nexabank/dashboard");
    // The layout renders a desktop sidebar and a mobile one; either satisfies "the shell is up".
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible({ timeout: SETTLE });

    const hrefs = await page.locator("aside a[href]").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href")!).filter((h) => h?.startsWith("/")),
    );
    expect(hrefs.length, "sidebar rendered no links").toBeGreaterThan(3);

    const denied: string[] = [];
    for (const href of [...new Set(hrefs)]) {
      await open(page, href);
      if (/\/unauthorized/.test(page.url())) denied.push(href);
    }
    expect(denied, "sidebar shows links that redirect to /unauthorized").toEqual([]);
  });

  test("someone outside rbac.json is denied rather than shown an empty dashboard", async ({
    page, context, baseURL,
  }) => {
    await signIn(context, USERS.normalUser, baseURL!);
    // Warm the route as an admin first so the redirect is not racing the compiler.
    await open(page, "/nexabank/dashboard");
    await page.waitForURL(/\/unauthorized/, { timeout: SETTLE });
    await expect(page.getByText("Dashboard Access Denied")).toBeVisible();
  });
});
