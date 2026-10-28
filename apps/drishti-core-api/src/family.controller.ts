import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Filter, Segment } from "@drishti/shared";
import { Db } from "./db";
import { FamilyService } from "./family.service";
import { PgFamilyStore } from "./family.store";

const SEGMENTS: Segment[] = ["fno", "equity", "currency", "commodity"];
const int = (v: string | undefined, name: string) => {
  if (v === undefined || v === "") return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new BadRequestException(`${name} must be a whole number`);
  return Number(v);
};

/**
 * The household's broker statements (docs/redesign/FAMILY_ACCOUNTS.md), a record-keeper for the owner's own family. The upload is the raw bytes of an .xlsx file
 * (main.ts reads that route's body raw); the file is parsed in memory and not kept.
 *   GET    /family                                  members, accounts and the list of imports (without their content)
 *   POST   /family/members      {nickname, relation?, note?}      PATCH /family/members/:id {nickname?, relation?, note?, hidden?}      DELETE /family/members/:id
 *   POST   /family/accounts     {memberId, broker, label, clientCode?}   PATCH /family/accounts/:id {label?, memberId?}   DELETE /family/accounts/:id
 *   POST   /family/import?name=FILE[&account=ID][&dry=1][&accept=1]   body: the .xlsx bytes; the file finds its account by client id (one is created, under an
 *          "Unassigned" member, when none exists); dry=1 only reads and reports
 *   DELETE /family/imports/:id
 *   GET    /family/summary?member=&account=&segment=&period=        totals and cuts by period, member, account, segment, underlying, plus the monthly view
 */
@Controller("family")
export class FamilyController {
  private readonly service: FamilyService;
  constructor(db: Db) {
    this.service = new FamilyService(new PgFamilyStore(db));
  }

  @Get() overview() {
    return this.service.overview();
  }
  @Post("members") addMember(@Body() body: unknown) {
    return this.service.addMember(body);
  }
  @Patch("members/:id") updateMember(@Param("id", ParseIntPipe) id: number, @Body() body: unknown) {
    return this.service.updateMember(id, body);
  }
  @Delete("members/:id") deleteMember(@Param("id", ParseIntPipe) id: number) {
    return this.service.deleteMember(id);
  }
  @Post("accounts") addAccount(@Body() body: unknown) {
    return this.service.addAccount(body);
  }
  @Patch("accounts/:id") updateAccount(@Param("id", ParseIntPipe) id: number, @Body() body: unknown) {
    return this.service.updateAccount(id, body);
  }
  @Delete("accounts/:id") deleteAccount(@Param("id", ParseIntPipe) id: number) {
    return this.service.deleteAccount(id);
  }
  @Delete("imports/:id") deleteImport(@Param("id", ParseIntPipe) id: number) {
    return this.service.deleteImport(id);
  }

  @Post("import")
  importFile(@Req() req: Request, @Query("account") account?: string, @Query("name") name?: string, @Query("dry") dry?: string, @Query("accept") accept?: string) {
    const id = int(account, "account");
    const body = req.body as unknown;
    if (!(body instanceof Uint8Array)) throw new BadRequestException("send the .xlsx file's bytes as the request body");
    return this.service.importFile(id, name ?? "", body, { dry: dry === "1", accept: accept === "1" });
  }

  @Get("summary")
  summary(@Query("member") member?: string, @Query("account") account?: string, @Query("segment") segment?: string, @Query("period") period?: string) {
    if (segment !== undefined && segment !== "" && !SEGMENTS.includes(segment as Segment)) throw new BadRequestException(`segment must be one of ${SEGMENTS.join(", ")}`);
    if (period !== undefined && period !== "" && !/^\d{4}-\d{2}$|^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/.test(period)) throw new BadRequestException("period must look like 2024-25");
    const filter: Filter = { memberId: int(member, "member"), accountId: int(account, "account"), segment: (segment || undefined) as Segment | undefined, period: period || undefined };
    return this.service.summary(filter);
  }
}
