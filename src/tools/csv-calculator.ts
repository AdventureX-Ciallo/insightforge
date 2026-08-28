import { readFile } from "node:fs/promises";
import { parseCsv } from "./csv-parser.js";

interface MarketRow {
  rowNumber: number;
  year: number;
  nevSales: number;
  totalSales: number;
  chargers: number;
}

export async function calculateMarketMetrics(path: string) {
  const records = parseCsv(await readFile(path, "utf8"));
  const rows: MarketRow[] = records.slice(1).filter((record) => record.fields.some((item) => item.length > 0)).map((record) => {
    const values = record.fields.map((item) => Number(item.trim()));
    const [year, nevSales, totalSales, chargers] = values;
    if ([year, nevSales, totalSales, chargers].some((value) => value === undefined || !Number.isFinite(value))) {
      throw new Error(`Invalid market CSV row ${record.recordNumber}`);
    }
    return { rowNumber: record.recordNumber, year, nevSales, totalSales, chargers } as MarketRow;
  });
  const current = rows.find((row) => row.year === 2024);
  if (!current) throw new Error("Market CSV does not contain 2024 data");
  if (current.totalSales === 0) throw new Error("Market CSV 2024 total sales denominator must not be zero");
  const penetration = (current.nevSales / current.totalSales) * 100;
  const prior = rows.find((row) => row.year === 2023);
  if (!prior) throw new Error("Market CSV does not contain 2023 data");
  if (prior.chargers === 0) throw new Error("Market CSV 2023 charger denominator must not be zero");
  const chargerGrowth = ((current.chargers - prior.chargers) / prior.chargers) * 100;
  const estimatedAdequacy = current.chargers * (1 - 0.15);
  return {
    rows,
    penetration,
    chargerGrowth,
    estimatedAdequacy,
    formulas: {
      penetration: "nev_sales_million / total_auto_sales_million * 100",
      chargerGrowth: "(chargers_2024 - chargers_2023) / chargers_2023 * 100",
      estimatedAdequacy: "public_chargers_million * (1 - utilization_gap_assumption)",
    },
  };
}
