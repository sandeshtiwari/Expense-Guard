import { expect, test } from "@playwright/test";

test("Synapsor DBMS demo shell shows agent-native primitives", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Synapsor Agent-Native DBMS", exact: true })).toBeVisible();
  await expect(page.getByText("Synapsor DBMS execution spine", { exact: true })).toBeVisible();
  await expect(page.getByText("Workload rows: expenses table", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent Capability Invocation", { exact: true })).toBeVisible();
  await expect(page.getByText("Background agent using Synapsor", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Run same agent through both data layers/i })).toBeVisible();

  await expect(page.getByText("General-purpose DBMS path", { exact: true })).toBeVisible();
  await expect(page.getByText("Synapsor agent-native DBMS path", { exact: true })).toBeVisible();
  await expect(page.getByText("No agent recommendation yet")).toHaveCount(2, { timeout: 15_000 });
});
