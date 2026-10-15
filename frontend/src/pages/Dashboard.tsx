/**
 * @fileoverview Dashboard page — 30-day summary with stats, charts, and exports.
 */

import { useCallback, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
} from "recharts";
import { getSummary, exportSummary } from "../api/client";
import { Heading } from "../components/ui/Heading";
import { Button } from "../components/ui/Button";
import { Text } from "../components/ui/Text";
import { useTheme } from "../context/ThemeContext";
import { useToastContext } from "../context/ToastContext";
import { useApi } from "../hooks/useApi";
import { Skeleton } from "../components/Skeleton";
import { ErrorState } from "../components/Feedback";
import { formatMoney, formatPercent01 } from "../utils/format";
import styles from "./Dashboard.module.scss";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLORS_LIGHT = [
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
];

const COLORS_DARK = [
  "#22d3ee",
  "#34d399",
  "#fcd34d",
  "#a78bfa",
  "#f9a8d4",
  "#67e8f9",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format raw type slug for chart labels.
 * @param v - Raw document type value
 * @returns Human-readable label
 * @example formatType("settlement_slip") // "settlement slip"
 */
function formatType(v: string) {
  return v.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Analytics dashboard displaying aggregated document insights.
 * @returns Dashboard page element
 * @example <Dashboard />
 */
export default function Dashboard() {
  const fetchSummary = useCallback(() => getSummary(), []);
  const { data, error, loading, run: reload } = useApi(fetchSummary);
  const { theme } = useTheme();
  const { show } = useToastContext();
  const [exporting, setExporting] = useState<null | "pdf" | "csv">(null);
  const COLORS = theme === "dark" ? COLORS_DARK : COLORS_LIGHT;

  const download = useCallback(
    async (fmt: "pdf" | "csv") => {
      if (exporting) return;
      setExporting(fmt);
      const url = { current: "" };
      try {
        const blob = await exportSummary(fmt);
        url.current = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url.current;
        a.download = `claritydocs-summary.${fmt}`;
        a.click();
        show("success", `Summary exported as ${fmt.toUpperCase()}`);
      } catch (e) {
        show("error", (e as Error).message || "Export failed");
      } finally {
        if (url.current) URL.revokeObjectURL(url.current);
        setExporting(null);
      }
    },
    [exporting, show],
  );

  const handleDownloadCsv = useCallback(() => download("csv"), [download]);

  const handleDownloadPdf = useCallback(() => download("pdf"), [download]);

  if (error && !data)
    return (
      <div className="page">
        <ErrorState message={error} onRetry={() => reload()} />
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <div className={styles["dashboard-header"]}>
          <Heading level={1}>30-Day Summary</Heading>
        </div>
        <div className={styles["dashboard-stats"]} aria-busy="true">
          <Skeleton lines={3} />
          <Skeleton lines={3} />
        </div>
        <div className={styles["dashboard-grid2"]}>
          <div className={styles["dashboard-card"]}>
            <Skeleton lines={4} />
          </div>
          <div className={styles["dashboard-card"]}>
            <Skeleton lines={4} />
          </div>
        </div>
      </div>
    );
  return (
    <div className="page">
      <div className={styles["dashboard-header"]}>
        <Heading level={1}>30-Day Summary</Heading>
        <div className={styles["dashboard-actions"]}>
          <Button
            variant="secondary"
            size="md"
            onClick={handleDownloadCsv}
            disabled={exporting !== null || loading}
          >
            <i className="bi bi-filetype-csv" aria-hidden />{" "}
            {exporting === "csv" ? "Exporting…" : "Download CSV"}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleDownloadPdf}
            disabled={exporting !== null || loading}
          >
            <i className="bi bi-filetype-pdf" aria-hidden />{" "}
            {exporting === "pdf" ? "Exporting…" : "Download PDF"}
          </Button>
        </div>
      </div>

      <div className={styles["dashboard-stats"]}>
        <div className={styles["dashboard-stat"]}>
          <span className={styles["dashboard-stat-label"]}>Total Docs</span>
          <span className={styles["dashboard-stat-value"]}>
            {data.totalDocs}
          </span>
          <span className={styles["dashboard-stat-sub"]}>last 30 days</span>
        </div>
        <div className={styles["dashboard-stat"]}>
          <span className={styles["dashboard-stat-label"]}>Sum Total</span>
          <span className={styles["dashboard-stat-value"]}>
            {formatMoney(data.sumTotal)}
          </span>
          <span className={styles["dashboard-stat-sub"]}>
            all currencies combined
          </span>
        </div>
        <div className={styles["dashboard-stat"]}>
          <span className={styles["dashboard-stat-label"]}>Avg Usage</span>
          <span className={styles["dashboard-stat-value"]}>
            {formatMoney(data.avgUsage)}
          </span>
          <span className={styles["dashboard-stat-sub"]}>per document</span>
        </div>
        <div className={styles["dashboard-stat"]}>
          <span className={styles["dashboard-stat-label"]}>Authenticity</span>
          <span className={styles["dashboard-stat-value"]}>
            {formatPercent01(data.avgConfidence)}
          </span>
          <span className={styles["dashboard-stat-sub"]}>avg confidence</span>
        </div>
      </div>

      <div className={styles["dashboard-grid2"]}>
        <div className={styles["dashboard-card"]}>
          <div className={styles["dashboard-card-title"]}>By Type — Count</div>
          {data.byType.length === 0 ? (
            <Text variant="muted">No data</Text>
          ) : (
            <div className={styles["dashboard-chart"]}>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart
                  data={data.byType}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  barCategoryGap="28%"
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke={theme === "dark" ? "#334155" : "#e5e7eb"}
                  />
                  <XAxis
                    dataKey="document_type"
                    tick={{
                      fontSize: 11,
                      fill: theme === "dark" ? "#94a3b8" : "#6b7280",
                    }}
                    interval={0}
                    tickFormatter={
                      ((value: string) =>
                        value === "settlement_slip"
                          ? "settle."
                          : formatType(value)) as unknown as (
                        v: string,
                      ) => string
                    }
                    angle={0}
                    dy={8}
                    height={30}
                  />
                  <YAxis
                    width={36}
                    tick={{
                      fontSize: 11,
                      fill: theme === "dark" ? "#94a3b8" : "#6b7280",
                    }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(v: unknown) =>
                      [v as number, "count"] as unknown as string
                    }
                    labelFormatter={(v) => formatType(String(v))}
                  />
                  <Bar
                    dataKey="cnt"
                    fill={COLORS[0]}
                    radius={[6, 6, 0, 0]}
                    maxBarSize={44}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        <div className={styles["dashboard-card"]}>
          <div className={styles["dashboard-card-title"]}>By Type — Sum</div>
          {data.byType.length === 0 ? (
            <Text variant="muted">No data</Text>
          ) : (
            <div className={styles["dashboard-chart"]}>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <Pie
                    data={data.byType.map((d) => ({
                      ...d,
                      name: formatType(d.document_type),
                    }))}
                    dataKey="sum"
                    nameKey="name"
                    cx="50%"
                    cy="46%"
                    outerRadius={78}
                    labelLine={false}
                    label={false}
                  >
                    {data.byType.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: unknown) =>
                      [
                        Number(v as number).toFixed(2),
                        "sum",
                      ] as unknown as string
                    }
                  />
                  <Legend
                    formatter={(v: unknown) => formatType(String(v))}
                    wrapperStyle={
                      {
                        fontSize: 12,
                        color: theme === "dark" ? "#f1f5f9" : "#111827",
                      } as unknown as Record<string, unknown>
                    }
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className={styles["dashboard-card"]}>
        <div className={styles["dashboard-card-title"]}>
          Daily Trend (30 days)
        </div>
        {data.trend.length === 0 ? (
          <Text variant="muted">No data</Text>
        ) : (
          <div className={styles["dashboard-chart"]}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart
                data={data.trend}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke={theme === "dark" ? "#334155" : "#e5e7eb"}
                />
                <XAxis
                  dataKey="date"
                  tick={{
                    fontSize: 10,
                    fill: theme === "dark" ? "#94a3b8" : "#6b7280",
                  }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  height={26}
                />
                <YAxis
                  width={38}
                  tick={{
                    fontSize: 11,
                    fill: theme === "dark" ? "#94a3b8" : "#6b7280",
                  }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="cnt"
                  name="Documents"
                  stroke={COLORS[0]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="sum"
                  name="Total amount"
                  stroke={COLORS[1]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className={styles["dashboard-card"]}>
        <div className={styles["dashboard-card-title"]}>Top Vendors</div>
        {data.topVendors.length === 0 ? (
          <Text variant="muted">No data</Text>
        ) : (
          <table className={styles["dashboard-table"]}>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Count</th>
                <th>Sum</th>
              </tr>
            </thead>
            <tbody>
              {data.topVendors.map((v) => (
                <tr key={v.vendor}>
                  <td>{v.vendor}</td>
                  <td>{v.cnt}</td>
                  <td>{formatMoney(v.sum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
