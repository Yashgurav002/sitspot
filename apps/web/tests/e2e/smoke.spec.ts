import { expect, test } from "@playwright/test";

const API = "http://localhost:3100/api"; // same-origin proxy (next.config.ts rewrites)

test("sign in → add spot → see it listed", async ({ page }) => {
  let authed = false;
  const spots: Record<string, unknown>[] = [];

  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, "");
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body });
    if (path === "/auth/login") {
      authed = req.postDataJSON().passcode === "letmein";
      return authed ? json(200, { ok: true }) : json(401, { error: "Wrong passcode" });
    }
    if (!authed) return json(401, { error: "unauthorized" });
    if (path === "/v1/spots" && req.method() === "POST") {
      const spot = { ...req.postDataJSON(), id: crypto.randomUUID(), user_id: "u", created_at: new Date().toISOString() };
      spots.push(spot);
      return json(201, spot);
    }
    if (path === "/v1/spots") return json(200, spots);
    if (path === "/v1/invitations") return json(200, []);
    if (path.endsWith("/conditions")) return json(200, { conditions: [], forecasts: [] });
    return json(404, { error: "not mocked" });
  });

  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Passcode").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong passcode")).toBeVisible();
  await page.getByLabel("Passcode").fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("No spots yet.")).toBeVisible();

  await page.getByRole("link", { name: "Spots" }).click();
  await page.getByRole("button", { name: "Add a spot" }).click();
  await page.getByRole("application").click({ position: { x: 120, y: 100 } });
  await page.getByLabel("Name").fill("Creek edge");
  await page.getByLabel("Kind").selectOption("coastal");
  await page.getByLabel("Travel (min)").fill("15");
  await page.getByRole("button", { name: "Save spot" }).click();

  const list = page.getByRole("list", { name: "Your spots" });
  await expect(list.getByText("Creek edge")).toBeVisible();
  await expect(list.getByText("coastal · 15 min away")).toBeVisible();
  expect(spots[0]).toMatchObject({ name: "Creek edge", kind: "coastal", travel_min: 15 });
});
