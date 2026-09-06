import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";

/** Minimal shape of TipTap/ProseMirror JSON we care about. */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Converts the editor's JSON into a .docx. Basic fidelity by design: text,
 *  headings, bold/italic/underline/strike/code, links, lists, tables,
 *  blockquotes. Anything unknown degrades to a plain paragraph — never throws. */
export async function tiptapJsonToDocx(doc: PMNode): Promise<ArrayBuffer> {
  let listInstance = 0;
  const children: Array<Paragraph | Table> = [];

  const inline = (nodes: PMNode[] | undefined, extra: Partial<TextRunOpts> = {}): ParagraphChild[] => {
    const out: ParagraphChild[] = [];
    for (const n of nodes ?? []) {
      if (n.type === "hardBreak") {
        out.push(new TextRun({ break: 1 }));
        continue;
      }
      if (n.type !== "text") {
        // Inline node we don't model (mention, image…): keep any text inside it.
        out.push(...inline(n.content, extra));
        continue;
      }
      const marks = n.marks ?? [];
      const has = (t: string) => marks.some((m) => m.type === t);
      const link = marks.find((m) => m.type === "link");
      const opts: TextRunOpts = {
        text: n.text ?? "",
        bold: has("bold") || extra.bold,
        italics: has("italic") || extra.italics,
        underline: has("underline") ? {} : undefined,
        strike: has("strike"),
        font: has("code") ? "Consolas" : undefined,
        style: link ? "Hyperlink" : undefined,
      };
      const run = new TextRun(opts);
      if (link && typeof link.attrs?.href === "string") {
        out.push(new ExternalHyperlink({ children: [run], link: link.attrs.href }));
      } else {
        out.push(run);
      }
    }
    return out;
  };

  const paragraph = (node: PMNode, opts: Partial<IParagraphOptions> = {}, extra: Partial<TextRunOpts> = {}) =>
    new Paragraph({ ...opts, children: inline(node.content, extra) });

  const block = (node: PMNode, ctx: BlockCtx = {}): void => {
    switch (node.type) {
      case "paragraph":
        children.push(paragraph(node, ctx.paragraph, ctx.run));
        return;
      case "heading": {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
        children.push(paragraph(node, { heading: HEADINGS[level - 1] }));
        return;
      }
      case "bulletList":
      case "orderedList": {
        const reference = node.type === "bulletList" ? "bullets" : "numbers";
        const instance = ++listInstance;
        for (const item of node.content ?? []) {
          for (const child of item.content ?? []) {
            if (child.type === "paragraph") {
              children.push(
                paragraph(child, { numbering: { reference, level: 0, instance } })
              );
            } else {
              block(child, ctx);
            }
          }
        }
        return;
      }
      case "blockquote":
        for (const child of node.content ?? []) {
          block(child, {
            paragraph: { indent: { left: 720 }, alignment: AlignmentType.LEFT },
            run: { italics: true },
          });
        }
        return;
      case "codeBlock":
        children.push(
          new Paragraph({
            children: [new TextRun({ text: textOf(node), font: "Consolas" })],
            shading: { fill: "F3F4F6" },
          })
        );
        return;
      case "horizontalRule":
        children.push(
          new Paragraph({ border: { bottom: { style: "single", size: 6, color: "CCCCCC" } } })
        );
        return;
      case "table": {
        const rows = (node.content ?? [])
          .filter((r) => r.type === "tableRow")
          .map(
            (r) =>
              new TableRow({
                children: (r.content ?? []).map(
                  (cell) =>
                    new TableCell({
                      children: (cell.content ?? []).map((p) =>
                        p.type === "paragraph"
                          ? paragraph(p, {}, cell.type === "tableHeader" ? { bold: true } : {})
                          : new Paragraph({ text: textOf(p) })
                      ),
                    })
                ),
              })
          );
        if (rows.length > 0) {
          children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
          children.push(new Paragraph({}));
        }
        return;
      }
      default:
        if (node.content?.some((c) => c.type === "text")) {
          children.push(paragraph(node));
        } else {
          for (const child of node.content ?? []) block(child, ctx);
        }
    }
  };

  for (const node of doc.content ?? []) block(node);
  if (children.length === 0) children.push(new Paragraph({}));

  const document = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: "bullet",
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "numbers",
          levels: [
            {
              level: 0,
              format: "decimal",
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(document);
  return blob.arrayBuffer();
}

type TextRunOpts = ConstructorParameters<typeof TextRun>[0] extends infer T
  ? T extends string
    ? never
    : T
  : never;

interface BlockCtx {
  paragraph?: Partial<IParagraphOptions>;
  run?: Partial<TextRunOpts>;
}

function textOf(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(textOf).join("");
}
