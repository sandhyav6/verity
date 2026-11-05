import { describe, expect, it } from "vitest";
import { EMPTY_FORM, subsidyEstimate, toPayload, validateMarketForm, type MarketForm } from "./marketForm";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const good: MarketForm = {
  ...EMPTY_FORM,
  question: "Will Chennai receive more than 100 mm of rain in October 2026?", description: "Chennai rainfall for October 2026, a test market.",
  yesDefinition: "Total above 100 mm.", noDefinition: "Total 100 mm or less.", sourceName: "Open-Meteo Historical Weather API",
  sourceUrl: "https://open-meteo.com/en/docs/historical-weather-api", sourceDataset: "daily precipitation_sum, ERA5",
  criteria: "Sum the daily precipitation_sum for 1-31 October; YES if above 100 mm.", measurement: "Total of daily precipitation_sum", unit: "mm",
  observationPeriod: "1 to 31 October 2026", revisionPolicy: "First published value counts.", missingDataPolicy: "Void and refund if data is missing.",
  closeAt: "2026-11-05T12:00", deadlineAt: "2026-11-09T12:00", liquidity: "100",
};

describe("market creation form validation", () => {
  it("accepts a complete, well-specified market", () => {
    expect(validateMarketForm(good, NOW)).toEqual({});
  });

  it.each([
    ["question", { question: "Rain in Chennai next month" }],
    ["question", { question: "Rain?" }],
    ["description", { description: "short" }],
    ["noDefinition", { noDefinition: "Total above 100 mm." }],
    ["sourceUrl", { sourceUrl: "open-meteo" }],
    ["sourceDataset", { sourceDataset: "" }],
    ["criteria", { criteria: "see source" }],
    ["revisionPolicy", { revisionPolicy: "" }],
    ["missingDataPolicy", { missingDataPolicy: "" }],
    ["closeAt", { closeAt: "" }],
    ["closeAt", { closeAt: "2026-11-03T10:30" }],
    ["deadlineAt", { deadlineAt: "2026-11-05T11:00" }],
    ["liquidity", { liquidity: "5" }],
    ["liquidity", { liquidity: "100001" }],
    ["liquidity", { liquidity: "12.5" }],
    ["liquidity", { liquidity: "lots" }],
  ] as const)("rejects an invalid %s", (field, over) => {
    expect(validateMarketForm({ ...good, ...over }, NOW)[field]).toBeTruthy();
  });

  it("validates the automatic weather data rule and refuses to mix in IMD/station promises", () => {
    const rule = { ...good, useRule: true, location: "Chennai", latitude: "13.08", longitude: "80.27", ruleStart: "2026-10-01", ruleEnd: "2026-10-31", operator: ">", threshold: "100" };
    expect(validateMarketForm(rule, NOW)).toEqual({});
    expect(validateMarketForm({ ...rule, latitude: "95" }, NOW).latitude).toBeTruthy();
    expect(validateMarketForm({ ...rule, ruleEnd: "2026-09-01" }, NOW).ruleEnd).toBeTruthy();
    expect(validateMarketForm({ ...rule, threshold: "" }, NOW).threshold).toBeTruthy();
    expect(validateMarketForm({ ...rule, category: "economy" }, NOW).useRule).toBeTruthy();
    expect(validateMarketForm({ ...rule, criteria: good.criteria + " Use the IMD station at Nungambakkam." }, NOW).criteria).toMatch(/IMD/);
    expect(validateMarketForm({ ...rule, sourceUrl: "https://example.org/rain" }, NOW).sourceUrl).toMatch(/open-meteo/);
  });

  it("builds exactly the payload the API expects (UTC timestamps, whole-token liquidity)", () => {
    const p = toPayload(good);
    expect(p.liquidity_parameter).toBe("100");
    expect(p.trading_close_time).toMatch(/Z$/);
    expect(p.resolution_source).toEqual({ name: good.sourceName, url: good.sourceUrl, dataset: good.sourceDataset });
    expect("data_rule" in p).toBe(false);
    expect(toPayload({ ...good, useRule: true, location: "Chennai", latitude: "13.08", longitude: "80.27", ruleStart: "2026-10-01", ruleEnd: "2026-10-31", threshold: "100" }).data_rule).toMatchObject({ provider: "open-meteo", model: "era5", unit: "mm", operator: ">" });
  });

  it("estimates the creator's funding as b·ln 2", () => {
    expect(subsidyEstimate(100)).toBeCloseTo(69.3147, 4);
  });
});
