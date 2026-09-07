"use client";

import * as React from "react";
import * as XLSX from "xlsx";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { arrayBufferToDataUrl, dataUrlToArrayBuffer, extensionOf, MIME } from "@/lib/documents";
import { cn } from "@/lib/utils";
import type { DocumentEditorHandle, DocumentEditorProps } from "./types";

const MIN_ROWS = 20;
const MIN_COLS = 8;
const MAX_ROWS = 500;
const MAX_COLS = 52;

/** Editable grid over a SheetJS workbook. Values and sheet names round-trip;
 *  untouched formulas are kept, edited cells lose theirs (basic fidelity). */
export const SpreadsheetEditor = React.forwardRef<DocumentEditorHandle, DocumentEditorProps>(
  function SpreadsheetEditor({ attachment, readOnly, onDirty }, ref) {
    const wbRef = React.useRef<XLSX.WorkBook | null>(null);
    if (!wbRef.current) {
      wbRef.current = XLSX.read(dataUrlToArrayBuffer(attachment.dataUrl), {
        type: "array",
        cellStyles: false,
      });
    }
    const wb = wbRef.current;
    const [sheet, setSheet] = React.useState(wb.SheetNames[0] ?? "Sheet1");
    const [tick, setTick] = React.useState(0);
    const bump = () => setTick((t) => t + 1);

    React.useImperativeHandle(ref, () => ({
      async getDataUrl() {
        const isCsv = extensionOf(attachment.name) === "csv";
        // Ask Excel to recalculate formulas we couldn't evaluate here.
        // CalcPr isn't in SheetJS's typings but is honoured on write.
        wb.Workbook = {
          ...(wb.Workbook ?? {}),
          CalcPr: { fullCalcOnLoad: true },
        } as unknown as XLSX.WorkBook["Workbook"];
        const out = XLSX.write(wb, { bookType: isCsv ? "csv" : "xlsx", type: "array" }) as ArrayBuffer;
        return arrayBufferToDataUrl(out, isCsv ? MIME.csv : MIME.xlsx);
      },
    }));

    const ws = wb.Sheets[sheet] ?? (wb.Sheets[sheet] = XLSX.utils.aoa_to_sheet([[""]]));
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
    const rows = Math.min(Math.max(range.e.r + 1, MIN_ROWS), MAX_ROWS);
    const cols = Math.min(Math.max(range.e.c + 1, MIN_COLS), MAX_COLS);
    const truncated = range.e.r + 1 > MAX_ROWS || range.e.c + 1 > MAX_COLS;

    const grow = (r: number, c: number) => {
      const cur = XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
      cur.e.r = Math.max(cur.e.r, r);
      cur.e.c = Math.max(cur.e.c, c);
      ws["!ref"] = XLSX.utils.encode_range(cur);
    };

    const commit = (r: number, c: number, raw: string) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const existing = ws[addr] as XLSX.CellObject | undefined;
      const current = existing ? (existing.f ? `=${existing.f}` : String(existing.v ?? "")) : "";
      if (raw === current) return;
      const val = raw.trim();
      if (val === "") {
        delete ws[addr];
      } else if (val.startsWith("=")) {
        ws[addr] = { t: "n", f: val.slice(1), v: 0 } as XLSX.CellObject;
      } else if (/^-?\d+(\.\d+)?$/.test(val)) {
        ws[addr] = { t: "n", v: Number(val) } as XLSX.CellObject;
      } else {
        ws[addr] = { t: "s", v: raw } as XLSX.CellObject;
      }
      grow(r, c);
      onDirty();
      bump();
    };

    const addRow = () => {
      grow(Math.max(range.e.r + 1, rows), range.e.c);
      onDirty();
      bump();
    };
    const addCol = () => {
      grow(range.e.r, Math.max(range.e.c + 1, cols));
      onDirty();
      bump();
    };

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-1 overflow-x-auto border-b px-3 py-1.5">
          {wb.SheetNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setSheet(name)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                name === sheet
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {name}
            </button>
          ))}
          {!readOnly && (
            <div className="ml-auto flex items-center gap-1">
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={addRow}>
                <Plus className="size-3.5" /> Row
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={addCol}>
                <Plus className="size-3.5" /> Column
              </Button>
            </div>
          )}
        </div>
        {truncated && (
          <p className="border-b bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Showing the first {MAX_ROWS} rows × {MAX_COLS} columns. The rest is kept on save.
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-collapse text-[12px]" key={`${sheet}-${tick}`}>
            <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
              <tr>
                <th className="sticky left-0 z-20 w-10 border bg-muted/80 px-1 text-center font-medium text-muted-foreground" />
                {Array.from({ length: cols }, (_, c) => (
                  <th
                    key={c}
                    className="min-w-24 border px-1 py-1 text-center font-medium text-muted-foreground"
                  >
                    {XLSX.utils.encode_col(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, r) => (
                <tr key={r}>
                  <td className="sticky left-0 z-10 border bg-muted/80 px-1 text-center text-[11px] text-muted-foreground">
                    {r + 1}
                  </td>
                  {Array.from({ length: cols }, (_, c) => {
                    const addr = XLSX.utils.encode_cell({ r, c });
                    const cell = ws[addr] as XLSX.CellObject | undefined;
                    const display = cell ? (cell.w ?? String(cell.v ?? "")) : "";
                    const editValue = cell ? (cell.f ? `=${cell.f}` : String(cell.v ?? "")) : "";
                    const input = (
                      <input
                        defaultValue={editValue}
                        readOnly={readOnly}
                        aria-label={addr}
                        className={cn(
                          "h-7 w-full min-w-24 bg-transparent px-1.5 outline-none focus:bg-primary/5 focus:ring-1 focus:ring-primary/40",
                          cell?.t === "n" && "text-right tabular-nums",
                          cell?.f && "text-primary"
                        )}
                        onBlur={(e) => {
                          // Enter already committed this value and marked the
                          // input before blurring itself — skip the re-commit
                          // so values that don't round-trip byte-for-byte
                          // through the cell model (e.g. "5.0", "007", " 42 ")
                          // don't fire onDirty()/bump() a second time.
                          if (e.target.dataset.committed) {
                            delete e.target.dataset.committed;
                            return;
                          }
                          commit(r, c, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commit(r, c, e.currentTarget.value);
                            e.currentTarget.dataset.committed = "1";
                            e.currentTarget.blur();
                          }
                        }}
                        title={cell?.f ? `=${cell.f} → ${display}` : undefined}
                      />
                    );
                    return (
                      <td key={c} className="border p-0">
                        {cell?.f ? (
                          <Tooltip>
                            <TooltipTrigger asChild>{input}</TooltipTrigger>
                            <TooltipContent className="font-mono">
                              ={cell.f} → {display}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          input
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
);
