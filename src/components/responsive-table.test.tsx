import { describe, expect, it } from "vitest";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/responsive-table";
import { collectClassNames, extractText } from "@/test-utils/page-tree";

type Row = { id: number; name: string; cost: number };

const ROWS: Row[] = [
  { id: 1, name: "alpha", cost: 100 },
  { id: 2, name: "beta", cost: 250 },
];

const COLUMNS: ResponsiveColumn<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name },
  {
    key: "cost",
    header: "Cost",
    align: "right",
    cellClassName: "tabular-nums",
    render: (r) => r.cost,
  },
];

describe("ResponsiveTable", () => {
  it("owns the desktop/mobile split — emits a sm: table and a sm:hidden card list so a 390px viewport gets the stacked layout (#270 gap 2)", () => {
    const tree = ResponsiveTable({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      mobileCard: (r) => r.name,
    });
    const classes = collectClassNames(tree).join(" ");
    // Desktop: table hidden below sm, appears at sm+.
    expect(classes).toContain("hidden w-full text-sm sm:table");
    // Mobile: ul visible below sm, hidden at sm+.
    expect(classes).toContain("divide-y divide-white/5 text-sm sm:hidden");
  });

  it("defaults the outer wrapper to `min-w-0 sm:overflow-x-auto` so the next call site can't reintroduce the desktop overflow from #257 (#270 gap 3)", () => {
    const tree = ResponsiveTable({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      mobileCard: (r) => r.name,
    }) as { props: { className: string } };
    expect(tree.props.className).toContain("min-w-0");
    expect(tree.props.className).toContain("sm:overflow-x-auto");
  });

  it("lets a call site replace the wrapper class when the surrounding layout already guarantees overflow", () => {
    const tree = ResponsiveTable({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      mobileCard: (r) => r.name,
      className: "relative",
    }) as { props: { className: string } };
    expect(tree.props.className).toBe("relative");
  });

  it("renders both desktop cells and mobile cards from the same rows so the two views can't diverge silently", () => {
    const tree = ResponsiveTable({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      mobileCard: (r) => `${r.name}-card`,
    });
    const text = extractText(tree);
    // Desktop cell renders.
    expect(text).toContain("alpha");
    expect(text).toContain("250");
    // Mobile card renders the dedicated card body.
    expect(text).toContain("alpha-card");
    expect(text).toContain("beta-card");
  });

  it("forwards `align: right` to both the header and the cell so numeric columns line up consistently", () => {
    const tree = ResponsiveTable({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      mobileCard: (r) => r.name,
    });
    const classes = collectClassNames(tree);
    // Both the Cost <th> and its <td>s should pick up text-right.
    const rightAligned = classes.filter((c) => c.includes("text-right"));
    // 1 header + 2 cells = 3 occurrences.
    expect(rightAligned.length).toBeGreaterThanOrEqual(3);
  });
});
