import { readFile } from "node:fs/promises";

interface MarketRow {
  rowNumber: number;
  year: number;
  nevSales: number;
  totalSales: number;
  chargers: number;
}

export async function calculateMarketMetrics(path: string) {
  const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
  const rows: MarketRow[] = lines.slice(1).map((line, index) => {
    const values = line.split(",").map(Number);
    const [year, nevSales, totalSales, chargers] = values;
    if ([year, nevSales, totalSales, chargers].some((value) => value === undefined || !Number.isFinite(value))) {
      throw new Error(`Invalid market CSV row ${index + 2}`);
    }
    return { rowNumber: index + 2, year, nevSales, totalSales, chargers } as MarketRow;
  });
  const current = rows.find((row) => row.year === 2024);
  if (!current) throw new Error("Market CSV does not contain 2024 data");
  const penetration = (current.nevSales / current.totalSales) * 100;
  const prior = rows.find((row) => row.year === 2023);
  if (!prior) throw new Error("Market CSV does not contain 2023 data");
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
