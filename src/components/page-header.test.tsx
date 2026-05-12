import { describe, expect, it } from "vitest";
import { PageHeader } from "@/components/page-header";
import { collectClassNames } from "@/test-utils/page-tree";

describe("PageHeader", () => {
  it("stacks below sm: and switches to a horizontal layout at sm — keeps the title + toolbar from sharing one ~470px row on a 375px phone (#117, #260)", () => {
    const node = PageHeader({ title: "Overview", children: null });
    const classes = collectClassNames(node);
    const stacked = classes.find(
      (c) =>
        c.includes("flex-col") &&
        c.includes("sm:flex-row") &&
        c.includes("sm:justify-between")
    );
    expect(stacked).toBeTruthy();
  });

  it("renders the title as an h1.text-xl.font-bold so every dashboard page shares the same heading style", () => {
    const node = PageHeader({ title: "Models" }) as {
      props: { children: ReadonlyArray<{ type: string; props: unknown }> };
    };
    const h1 = node.props.children.find(
      (child) => child && typeof child === "object" && child.type === "h1"
    ) as { props: { className: string; children: string } } | undefined;
    expect(h1).toBeTruthy();
    expect(h1?.props.className).toContain("text-xl");
    expect(h1?.props.className).toContain("font-bold");
    expect(h1?.props.children).toBe("Models");
  });

  it("renders the toolbar children next to the title so each page can pass its own filter cluster", () => {
    const toolbar = <div data-marker="TOOLBAR_SENTINEL" />;
    const node = PageHeader({ title: "Repos", children: toolbar }) as {
      props: { children: ReadonlyArray<unknown> };
    };
    expect(node.props.children).toContain(toolbar);
  });
});
