/** Client-side checks that mirror the backend's market validation (the backend re-checks everything). */
export interface MarketForm {
  question: string; description: string; category: string; yesDefinition: string; noDefinition: string;
  sourceName: string; sourceUrl: string; sourceDataset: string; criteria: string;
  measurement: string; unit: string; observationPeriod: string; revisionPolicy: string; missingDataPolicy: string;
  closeAt: string; deadlineAt: string; liquidity: string;
  useRule: boolean; location: string; latitude: string; longitude: string; ruleStart: string; ruleEnd: string; operator: string; threshold: string;
}

export const EMPTY_FORM: MarketForm = {
  question: "", description: "", category: "weather", yesDefinition: "", noDefinition: "", sourceName: "", sourceUrl: "", sourceDataset: "", criteria: "",
  measurement: "", unit: "", observationPeriod: "", revisionPolicy: "", missingDataPolicy: "", closeAt: "", deadlineAt: "", liquidity: "100",
  useRule: false, location: "", latitude: "", longitude: "", ruleStart: "", ruleEnd: "", operator: ">", threshold: "",
};

export type FormErrors = Partial<Record<keyof MarketForm, string>>;

const len = (s: string, min: number) => s.trim().length >= min;

export function validateMarketForm(f: MarketForm, now = Date.now()): FormErrors {
  const e: FormErrors = {};
  if (!len(f.question, 15) || !f.question.trim().endsWith("?")) e.question = "Write a clear YES/NO question of at least 15 characters ending with “?”.";
  if (!len(f.description, 20)) e.description = "Add a description (at least 20 characters).";
  if (!len(f.yesDefinition, 5)) e.yesDefinition = "Define exactly when the answer is YES.";
  if (!len(f.noDefinition, 5)) e.noDefinition = "Define exactly when the answer is NO.";
  if (len(f.yesDefinition, 5) && f.yesDefinition.trim().toLowerCase() === f.noDefinition.trim().toLowerCase()) e.noDefinition = "YES and NO must be defined differently.";
  if (!len(f.sourceName, 3)) e.sourceName = "Name the source that will decide the outcome.";
  if (!/^https:\/\/\S+$/.test(f.sourceUrl.trim()) && !/^http:\/\/\S+$/.test(f.sourceUrl.trim())) e.sourceUrl = "Enter the source's web address (https://…).";
  if (!len(f.sourceDataset, 3)) e.sourceDataset = "Say exactly which dataset, table or station is used.";
  if (!len(f.criteria, 30)) e.criteria = "Explain precisely how the outcome is computed (at least 30 characters).";
  if (!len(f.measurement, 5)) e.measurement = "What exactly is measured?";
  if (!len(f.unit, 1)) e.unit = "Give the unit (e.g. mm, %).";
  if (!len(f.observationPeriod, 5)) e.observationPeriod = "State the observation period.";
  if (!len(f.revisionPolicy, 10)) e.revisionPolicy = "Say whether the first publication or a later revision counts.";
  if (!len(f.missingDataPolicy, 10)) e.missingDataPolicy = "Say what happens if the data is missing.";

  const close = Date.parse(f.closeAt);
  const deadline = Date.parse(f.deadlineAt);
  if (Number.isNaN(close)) e.closeAt = "Choose when trading closes.";
  else if (close < now + 3600_000) e.closeAt = "Trading must close at least 1 hour from now.";
  if (Number.isNaN(deadline)) e.deadlineAt = "Choose the resolution deadline.";
  else if (!Number.isNaN(close) && deadline <= close) e.deadlineAt = "The deadline must be after trading closes.";

  const b = Number(f.liquidity);
  if (!Number.isInteger(b) || b < 10 || b > 100_000) e.liquidity = "Liquidity must be a whole number from 10 to 100,000 tokens.";

  if (f.useRule) {
    if (f.category !== "weather") e.useRule = "Automatic data rules exist only for weather markets.";
    if (!len(f.location, 2)) e.location = "Name the place.";
    const lat = Number(f.latitude), lon = Number(f.longitude);
    if (f.latitude.trim() === "" || !(lat >= -90 && lat <= 90)) e.latitude = "Latitude must be between −90 and 90.";
    if (f.longitude.trim() === "" || !(lon >= -180 && lon <= 180)) e.longitude = "Longitude must be between −180 and 180.";
    if (!f.ruleStart || !f.ruleEnd || f.ruleEnd < f.ruleStart) e.ruleEnd = "Choose a start date and an end date on or after it.";
    if (f.threshold.trim() === "" || !(Number(f.threshold) >= 0)) e.threshold = "Enter the threshold in mm (0 or more).";
    if (/\b(IMD|India Meteorological|station)\b/i.test(`${f.criteria} ${f.sourceName} ${f.sourceDataset} ${f.question}`)) {
      e.criteria = "The text mentions IMD/station data, but an automatic rule resolves from Open-Meteo reanalysis. Do not mix the two.";
    }
    if (!/open-meteo\.com/i.test(f.sourceUrl)) e.sourceUrl = "For an Open-Meteo rule the source must be an open-meteo.com page.";
  }
  return e;
}

/** The subsidy the creator must deposit, ≈ b·ln 2 (the contract adds a few wei of rounding margin). */
export const subsidyEstimate = (b: number) => b * Math.LN2;

export function toPayload(f: MarketForm) {
  return {
    question: f.question.trim(), description: f.description.trim(), category: f.category,
    yes_definition: f.yesDefinition.trim(), no_definition: f.noDefinition.trim(),
    resolution_source: { name: f.sourceName.trim(), url: f.sourceUrl.trim(), dataset: f.sourceDataset.trim() },
    resolution_criteria: f.criteria.trim(),
    resolution_spec: { measurement: f.measurement.trim(), unit: f.unit.trim(), observation_period: f.observationPeriod.trim(), revision_policy: f.revisionPolicy.trim(), missing_data_policy: f.missingDataPolicy.trim() },
    trading_close_time: new Date(f.closeAt).toISOString(), resolution_deadline: new Date(f.deadlineAt).toISOString(),
    liquidity_parameter: f.liquidity.trim(),
    ...(f.useRule ? { data_rule: { provider: "open-meteo", model: "era5", variable: "precipitation_sum", aggregation: "sum", location: f.location.trim(), latitude: f.latitude.trim(), longitude: f.longitude.trim(), start_date: f.ruleStart, end_date: f.ruleEnd, operator: f.operator, threshold: f.threshold.trim(), unit: "mm" } } : {}),
  };
}
