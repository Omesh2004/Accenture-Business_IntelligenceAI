import { prisma } from "../prisma";
async function main() {
  const g = await prisma.account.groupBy({ by: ["lifecycleStatus"], _count: { _all: true } });
  console.log("PG accounts by lifecycleStatus:", JSON.stringify(g));
  const wm = new Date("2026-08-28T10:22:37Z");   // accounts watermark (createdOn cursor)
  console.log("accounts an incremental /extract/accounts?since=wm returns:",
    await prisma.account.count({ where: { createdOn: { gt: wm } } }));
  console.log("accounts whose lifecycleStatus != ACTIVE but createdOn <= wm:",
    await prisma.account.count({ where: { createdOn: { lte: wm }, NOT: { lifecycleStatus: "ACTIVE" } } }));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
