import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Post, Query } from "@nestjs/common";
import { labelAgreement, LABELS, parseLabelInput, type Label } from "@drishti/shared";
import { Db } from "./db";

const LABELER = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * The labelling page's routes (research/sentiment/LABELLING.md). The page shows a headline and its outlet only: no date, no price, no model score, so a label
 * is what the headline implies for crude and nothing else.
 *   GET    /labels/next?labeler=owner&skip=1,2   the next unlabeled headline for that labeler (a fixed pseudo-random order per labeler) and the progress
 *   POST   /labels                               {sampleId, labeler, label, afterMove?, note?}  one label per labeler and headline (a repeat replaces it)
 *   DELETE /labels/last?labeler=owner            takes the labeler's newest label back and returns that headline so it can be labeled again
 *   GET    /labels/stats                         counts per labeler and label, and how each pair of labelers agrees (accuracy, Cohen's kappa)
 */
@Controller("labels")
export class LabelsController {
  constructor(private readonly db: Db) {}

  private labeler(v: string | undefined) {
    if (!v || !LABELER.test(v)) throw new BadRequestException("labeler must be 1 to 40 letters, digits, dots, dashes or underscores");
    return v;
  }

  private async progress(labeler: string) {
    const [r] = (await this.db.sql`SELECT (SELECT count(*)::int FROM gold_sample) AS total, (SELECT count(*)::int FROM headline_labels WHERE labeler = ${labeler}) AS done`) as { total: number; done: number }[];
    return r;
  }

  @Get("next")
  async next(@Query("labeler") labelerParam?: string, @Query("skip") skipParam?: string) {
    const labeler = this.labeler(labelerParam);
    const skip = (skipParam ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    const rows = (await this.db.sql`
      SELECT s.id, s.title, s.outlet FROM gold_sample s
      WHERE NOT EXISTS (SELECT 1 FROM headline_labels l WHERE l.sample_id = s.id AND l.labeler = ${labeler}) AND NOT (s.id = ANY(${`{${skip.join(",")}}`}::int[]))
      ORDER BY md5(s.id::text || ${labeler}) LIMIT 1`) as { id: number; title: string; outlet: string }[];
    return { item: rows[0] ?? null, ...(await this.progress(labeler)) };
  }

  @Post()
  async label(@Body() body: unknown) {
    const input = parseLabelInput(body);
    if ("error" in input) throw new BadRequestException(input.error);
    const exists = (await this.db.sql`SELECT 1 FROM gold_sample WHERE id = ${input.sampleId}`) as unknown[];
    if (exists.length === 0) throw new NotFoundException("no such headline in the sample");
    await this.db.sql`
      INSERT INTO headline_labels (sample_id, labeler, label, after_move, note) VALUES (${input.sampleId}, ${input.labeler}, ${input.label}, ${input.afterMove}, ${input.note ?? null})
      ON CONFLICT (sample_id, labeler) DO UPDATE SET label = EXCLUDED.label, after_move = EXCLUDED.after_move, note = EXCLUDED.note, at = now()`;
    return { ok: true, ...(await this.progress(input.labeler)) };
  }

  @Delete("last")
  async undo(@Query("labeler") labelerParam?: string) {
    const labeler = this.labeler(labelerParam);
    const rows = (await this.db.sql`
      DELETE FROM headline_labels WHERE (sample_id, labeler) = (SELECT sample_id, labeler FROM headline_labels WHERE labeler = ${labeler} ORDER BY at DESC LIMIT 1)
      RETURNING sample_id`) as { sample_id: number }[];
    if (rows.length === 0) throw new NotFoundException("nothing to take back");
    const item = (await this.db.sql`SELECT id, title, outlet FROM gold_sample WHERE id = ${rows[0].sample_id}`) as { id: number; title: string; outlet: string }[];
    return { item: item[0] ?? null, ...(await this.progress(labeler)) };
  }

  @Get("stats")
  async stats() {
    const rows = (await this.db.sql`SELECT sample_id, labeler, label, after_move FROM headline_labels`) as { sample_id: number; labeler: string; label: Label; after_move: boolean }[];
    const byLabeler = new Map<string, Map<string, Label>>();
    const counts: Record<string, Record<string, number>> = {};
    const moves: Record<string, number> = {};
    for (const r of rows) {
      if (!byLabeler.has(r.labeler)) byLabeler.set(r.labeler, new Map());
      byLabeler.get(r.labeler)!.set(String(r.sample_id), r.label);
      counts[r.labeler] ??= Object.fromEntries(LABELS.map((l) => [l, 0]));
      counts[r.labeler][r.label]++;
      if (r.after_move) moves[r.labeler] = (moves[r.labeler] ?? 0) + 1;
    }
    const names = [...byLabeler.keys()].sort();
    const pairs = names.flatMap((a, i) => names.slice(i + 1).flatMap((b) => {
      const g = labelAgreement(byLabeler.get(a)!, byLabeler.get(b)!);
      return g ? [{ a, b, ...g }] : [];
    }));
    const [{ total }] = (await this.db.sql`SELECT count(*)::int AS total FROM gold_sample`) as { total: number }[];
    return { total, labelers: names.map((n) => ({ labeler: n, labeled: byLabeler.get(n)!.size, counts: counts[n], reportsMove: moves[n] ?? 0 })), pairs };
  }
}
