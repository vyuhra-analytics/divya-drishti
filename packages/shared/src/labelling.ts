// The hand-labelled gold set of crude headlines (research/sentiment/LABELLING.md): the four labels, a strict check of a label request, and how well two
// labelers agree (accuracy, a confusion matrix, Cohen's kappa). Labels are about the price implication of a headline and never use prices.

export const LABELS = ["bullish", "bearish", "neutral", "not_crude"] as const;
export type Label = (typeof LABELS)[number];

/** Keyboard keys of the labelling page: 1 to 4 in the order of LABELS. */
export const LABEL_KEYS: Record<string, Label> = { "1": "bullish", "2": "bearish", "3": "neutral", "4": "not_crude" };

export interface LabelInput {
  sampleId: number;
  labeler: string;
  label: Label;
  afterMove: boolean;
  note?: string;
}

/** A label request from a body, strictly checked: a positive whole sample id, a plain labeler name, one of the four labels, a boolean flag, a short note. */
export function parseLabelInput(body: unknown): LabelInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(b.sampleId) || (b.sampleId as number) < 1) return { error: "sampleId must be a positive whole number" };
  if (typeof b.labeler !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(b.labeler)) return { error: "labeler must be 1 to 40 letters, digits, dots, dashes or underscores" };
  if (!(LABELS as readonly unknown[]).includes(b.label)) return { error: `label must be one of ${LABELS.join(", ")}` };
  if (b.afterMove !== undefined && typeof b.afterMove !== "boolean") return { error: "afterMove must be true or false" };
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 300)) return { error: "note must be text of at most 300 characters" };
  return { sampleId: b.sampleId as number, labeler: b.labeler, label: b.label as Label, afterMove: b.afterMove === true, note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : undefined };
}

export interface LabelAgreement {
  /** items both labeled */
  n: number;
  accuracy: number;
  /** Cohen's kappa: agreement beyond chance, 1 = perfect, 0 = chance, negative = worse than chance */
  kappa: number;
  /** confusion[a][b] = items labeled a by the first labeler and b by the second */
  confusion: Record<Label, Record<Label, number>>;
}

/** How two labelers agree on the items both labeled (matched by key). Undefined when they share no item. */
export function labelAgreement(a: Map<string, Label>, b: Map<string, Label>): LabelAgreement | undefined {
  const confusion = Object.fromEntries(LABELS.map((x) => [x, Object.fromEntries(LABELS.map((y) => [y, 0]))])) as LabelAgreement["confusion"];
  let n = 0;
  let same = 0;
  for (const [k, la] of a) {
    const lb = b.get(k);
    if (lb === undefined) continue;
    n++;
    confusion[la][lb]++;
    if (la === lb) same++;
  }
  if (n === 0) return undefined;
  const po = same / n;
  let pe = 0;
  for (const l of LABELS) {
    const rowTotal = LABELS.reduce((s, y) => s + confusion[l][y], 0);
    const colTotal = LABELS.reduce((s, x) => s + confusion[x][l], 0);
    pe += (rowTotal / n) * (colTotal / n);
  }
  return { n, accuracy: po, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe), confusion };
}
