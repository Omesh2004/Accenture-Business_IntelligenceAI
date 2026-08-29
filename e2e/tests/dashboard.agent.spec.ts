import { test, expect, Page } from "@playwright/test";
import { signIn, USERS } from "../support/session";

/**
 * The intelligence agent, driven through the real UI.
 *
 * What these assert is not "a response appeared" — a chatbot passes that. They assert the
 * properties that make the answer usable: the reasoning trail names the tools that ran, the
 * source chips name the tables those tools read, every figure is marked verified, and switching
 * persona changes what the server is asked and what comes back.
 *
 * Selectors are `data-testid`, not copy. A test that breaks when a heading is reworded teaches
 * everyone to ignore it.
 */

const SETTLE = 90_000;
const ANSWER = 60_000;

async function openIntelligence(page: Page): Promise<void> {
  await page.goto("/nexabank/intelligence", { waitUntil: "domcontentloaded" });
  await page
    .getByText("Verifying permissions")
    .waitFor({ state: "hidden", timeout: SETTLE })
    .catch(() => {});
  await expect(page.getByText("Analyst enquiry")).toBeVisible({ timeout: SETTLE });
  // The switcher is server-authored; wait for it so a persona click cannot race the fetch.
  await expect(page.getByTestId("answering-as")).toBeVisible({ timeout: SETTLE });
}

/**
 * Ask a question and return the newest reply card.
 *
 * Cards stack newest-first, so `.first()` is the answer to the question just asked. Waiting on the
 * COUNT to grow rather than on a spinner to disappear means a fast reply cannot be missed between
 * polls, and a second ask cannot read the first answer back.
 */
async function ask(page: Page, question: string) {
  const cards = page.getByTestId("agent-answer");
  const before = await cards.count();
  await page.getByPlaceholder(/What drove the change/i).fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(cards).toHaveCount(before + 1, { timeout: ANSWER });
  return cards.first();
}

test.describe("intelligence agent", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, USERS.appAdmin, baseURL!);
  });

  test("a greeting is answered, not refused", async ({ page }) => {
    await openIntelligence(page);
    const card = await ask(page, "hello");
    await expect(card.getByTestId("agent-answer-text")).toContainText(/Good to see you/i);
    // A greeting must not be answered with a variance report.
    await expect(card.getByTestId("agent-answer-text")).not.toContainText(/I cannot answer/i);
  });

  test("an analytical question shows the tools it ran and the tables they read", async ({
    page,
  }) => {
    await openIntelligence(page);
    const card = await ask(page, "Why did loan approval volume fall?");

    // The trail names real capabilities, not a generic "thinking" animation.
    await expect(card.getByText("tools.get_insight").first()).toBeVisible({ timeout: ANSWER });
    // Sources are the provenance of every figure above them.
    await expect(card.getByText("Sources").first()).toBeVisible({ timeout: ANSWER });
    await expect(card.getByTestId("agent-citation").first()).toBeVisible();
    await expect(card.getByText("Verified").first()).toBeVisible();
  });

  test("an analytical answer reads as a briefing, not as machine output", async ({ page }) => {
    await openIntelligence(page);
    const card = await ask(page, "Why did digital adoption rate move?");
    const body = card.getByTestId("agent-answer-text");

    // Several capabilities contributed, so the reply is split: what moved before why.
    await expect(card.getByText("Position", { exact: true })).toBeVisible({ timeout: ANSWER });
    await expect(card.getByText("Attribution", { exact: true })).toBeVisible();

    const text = await body.innerText();
    // Localisation cells are stored as {key: value}. None of that shape may reach a reader --
    // "txn_type=PAYMENT (85.2%)" is the raw row, not a finding.
    expect(text, text).not.toMatch(/\w+=\w+/);
    // A bare "97.00" against a metric named a rate read as a percentage. It is a daily count.
    expect(text, text).toMatch(/per day/);
  });

  test("the trail exposes the reason/act/validate phases", async ({ page }) => {
    await openIntelligence(page);
    const card = await ask(page, "Which metric moved most?");
    for (const phase of ["Reason", "Act", "Validate"]) {
      await expect(card.getByText(phase, { exact: true }).first()).toBeVisible({
        timeout: ANSWER,
      });
    }
  });

  test("a question outside the recorded evidence abstains instead of inventing", async ({
    page,
  }) => {
    await openIntelligence(page);
    const card = await ask(page, "What is the capital of France?");
    await expect(card.getByTestId("agent-answer-text")).toContainText(
      /cannot answer that from recorded evidence/i,
    );
    // An abstention still shows what it tried, so a dead end is auditable too.
    await expect(card.getByText("Reasoning trail")).toBeVisible();
  });

  test("the persona switcher is server-authored and offers only what the role may select", async ({
    page,
  }) => {
    await openIntelligence(page);
    // rbac.json: an app_admin resolves to ops_manager and may also select analyst — never cfo.
    await expect(page.getByTestId("answering-as")).toContainText("Operations Manager");
    await expect(page.getByTestId("persona-ops_manager")).toBeVisible();
    await expect(page.getByTestId("persona-analyst")).toBeVisible();
    await expect(page.getByTestId("persona-cfo")).toHaveCount(0);
  });

  test("the same question gets a materially different answer after switching persona", async ({
    page,
  }) => {
    await openIntelligence(page);

    // Runtime cost is an analyst section. An operations manager has no such intent, so the same
    // question must be refused for one persona and answered for the other — if a switch were
    // cosmetic, both replies would be identical.
    const asOps = await ask(page, "What did this analysis cost?");
    await expect(asOps.getByTestId("agent-answer-persona")).toHaveText("Operations Manager");
    const opsText = (await asOps.getByTestId("agent-answer-text").innerText()).trim();
    expect(opsText).toMatch(/cannot answer/i);

    await page.getByTestId("persona-analyst").click();
    await expect(page.getByTestId("answering-as")).toContainText("Analyst", { timeout: ANSWER });

    const asAnalyst = await ask(page, "What did this analysis cost?");
    await expect(asAnalyst.getByTestId("agent-answer-persona")).toHaveText("Analyst");
    const analystText = (await asAnalyst.getByTestId("agent-answer-text").innerText()).trim();
    expect(analystText).toMatch(/stage runs/i);
    expect(analystText).not.toEqual(opsText);
  });

  test("a persona switch reaches the server, not just the label", async ({ page }) => {
    await openIntelligence(page);
    const posted: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/intelligence/ask") && r.method() === "POST") {
        posted.push(r.postData() || "");
      }
    });

    await ask(page, "Why did loan approval volume fall?");
    await page.getByTestId("persona-analyst").click();
    await expect(page.getByTestId("answering-as")).toContainText("Analyst", { timeout: ANSWER });
    await ask(page, "Why did loan approval volume fall?");

    expect(posted.length).toBe(2);
    expect(posted[0]).toContain('"persona":"ops_manager"');
    expect(posted[1]).toContain('"persona":"analyst"');
  });

  test("switching persona re-reads the investigation report itself", async ({ page }) => {
    await openIntelligence(page);
    // The report above the panel is persona-scoped too; a switch that only changed the chat
    // would leave the page contradicting its own header.
    await expect(page.getByText(/Operations Manager view/i)).toBeVisible({ timeout: SETTLE });
    await page.getByTestId("persona-analyst").click();
    await expect(page.getByText(/Analyst view/i)).toBeVisible({ timeout: ANSWER });
  });

  test("the same question asked twice does not collide on a React key", async ({ page }) => {
    // `query_id` is derived from (tenant, persona, question), so it repeats by design.
    //
    // Counting cards does NOT test this: React renders both children on a duplicate key and only
    // logs. The console message is the observable symptom, so that is what this asserts.
    const duplicateKeyErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && /same key/i.test(m.text())) duplicateKeyErrors.push(m.text());
    });

    await openIntelligence(page);
    await ask(page, "Which metric moved most?");
    await ask(page, "Which metric moved most?");
    await expect(page.getByTestId("agent-answer")).toHaveCount(2);
    expect(duplicateKeyErrors, duplicateKeyErrors.join(" | ")).toEqual([]);
  });

  test("an answer card can be dismissed without disturbing the others", async ({ page }) => {
    await openIntelligence(page);
    await ask(page, "hello");
    const second = await ask(page, "Which metric moved most?");
    await expect(page.getByTestId("agent-answer")).toHaveCount(2);

    await second.getByTestId("dismiss-answer").click();
    await expect(page.getByTestId("agent-answer")).toHaveCount(1);
    // The one left is the other question, not a re-render of the dismissed one.
    await expect(page.getByTestId("agent-answer").first()).toContainText(/Good to see you/i);
  });

  test("suggestion chips are persona-specific and answerable", async ({ page }) => {
    await openIntelligence(page);
    const chip = page.getByRole("button", { name: /What action is recommended\?/i }).first();
    await expect(chip).toBeVisible({ timeout: SETTLE });
    await chip.click();
    await expect(page.getByTestId("agent-answer")).toHaveCount(1, { timeout: ANSWER });
    await expect(
      page.getByTestId("agent-answer").first().getByText("Reasoning trail"),
    ).toBeVisible();
  });
});
